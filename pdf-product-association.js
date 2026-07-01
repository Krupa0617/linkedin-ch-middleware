import { createRequire } from 'module';
import axios from 'axios';
import express from 'express';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json());

// ═══════════════════════════════════════════════════
// PDF → Related Assets Association
// When a PDF is uploaded to Content Hub as an Asset,
// this handler extracts its text and links it to other
// related assets / products based on the content.
// ═══════════════════════════════════════════════════

const INSTANCE = process.env.CONTENT_HUB_INSTANCE || 'btr-q-001.sitecorecontenthub.cloud';
const API_SECRET = process.env.CH_API_SECRET || process.env.API_SECRET_KEY || 'ch_secret_2027';
const CONFIDENCE_MIN = parseFloat(process.env.ASSOCIATION_CONFIDENCE_THRESHOLD || '0.5');
const RELATION_TYPE = process.env.PDF_RELATION_TYPE || 'RelatedAsset';

// Auth cache
let authToken = null;
let authTime = 0;
let authType = null; // 'bearer' (OAuth) or 'token' (username/password)
const AUTH_TTL = 55 * 60 * 1000; // 55 min

// ── Common stop words ──
const STOP_WORDS = new Set([
  'this','that','with','from','have','been','will','their','what','when',
  'which','about','also','into','than','then','them','only','other','more',
  'such','each','would','could','should','after','before','between','where',
  'there','these','those','upon','while','until','because','without','just',
  'like','some','they','very','over','your','most','every',
]);

// ==================== AUTH ====================

async function getAuthToken(instance) {
  const now = Date.now();
  if (authToken && (now - authTime) < AUTH_TTL) return authToken;

  try {
    const response = await axios.post(
      `https://${instance}/oauth/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CH_CLIENT_ID,
        client_secret: process.env.CH_CLIENT_SECRET
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );
    console.log('[Auth] Got OAuth token');
    authToken = response.data.access_token;
    authTime = now;
    authType = 'bearer';
    return authToken;
  } catch (oauthError) {
    console.warn('[Auth] OAuth failed, trying username/password:', oauthError.message);

    const response = await axios.post(
      `https://${instance}/api/authenticate`,
      {
        user_name: process.env.CH_USERNAME || process.env.CONTENT_HUB_USERNAME,
        password: process.env.CH_PASSWORD || process.env.CONTENT_HUB_PASSWORD,
      },
      { timeout: 10000 }
    );
    console.log('[Auth] Got username/password token');
    authToken = response.data.token;
    authTime = now;
    authType = 'token';
    return authToken;
  }
}

/** Auth headers for Content Hub API calls */
function chHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (authType === 'bearer') {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    headers['X-Auth-Token'] = token;
  }
  return headers;
}

// ==================== ASSET ID EXTRACTION ====================
/**
 * Extract Asset ID from various sources in the request.
 * Handles:
 * 1. Entity save webhook: saveEntityMessage.TargetId
 * 2. Flow action with properly bound ID: parameters.assetId (numeric)
 * 3. Flow action with template variable string: parameters.assetId = " \"{[Entity.Id]}\""
 * 4. Fallback: Search Content Hub for recently uploaded asset by filename
 */
function extractAssetId(body) {
  console.log('[AssetId] Extracting from request body...');
  
  // Strategy 1: Entity save webhook
  const saveMsg = body?.saveEntityMessage;
  if (saveMsg?.TargetId) {
    const id = String(saveMsg.TargetId).trim();
    console.log('[AssetId] ✅ Found in saveEntityMessage.TargetId:', id);
    return id;
  }

  // Strategy 2: Direct parameter (properly bound)
  const params = body?.parameters || {};
  let rawAssetId = params.assetId;
  
  if (rawAssetId) {
    // Handle quoted/escaped template variable: " \"{[Entity.Id]}\""
    rawAssetId = String(rawAssetId).trim();
    
    // Remove quotes, escapes, and template syntax
    let cleaned = rawAssetId
      .replace(/^["']|["']$/g, '')           // Remove leading/trailing quotes
      .replace(/^\{|\}$/g, '')               // Remove leading/trailing braces
      .replace(/\\\"/g, '"')                 // Unescape quotes
      .replace(/^\[|]$/g, '')                // Remove brackets
      .replace(/^Entity\.|Entity\./g, '')    // Remove Entity. prefix
      .trim();
    
    console.log('[AssetId] Raw params.assetId:', JSON.stringify(rawAssetId));
    console.log('[AssetId] Cleaned:', cleaned);
    
    // If still has template syntax, it wasn't evaluated
    if (cleaned.includes('[') || cleaned.includes('{') || cleaned.includes('Entity')) {
      console.warn('[AssetId] ⚠️ Template variable NOT evaluated by Content Hub:', cleaned);
      console.warn('[AssetId] Will fallback to searching by filename...');
      // Return null to trigger fallback strategies
      return null;
    }
    
    // Ensure it's numeric
    if (/^\d+$/.test(cleaned)) {
      console.log('[AssetId] ✅ Found in parameters.assetId (cleaned):', cleaned);
      return cleaned;
    }
  }

  // Strategy 3: Check if callback URL contains entity context
  const callback = body?.callback;
  if (callback && typeof callback === 'string') {
    // Try to extract entity ID from callback parameters
    const match = callback.match(/[?&](?:entityId|id|eid)=(\d+)/i);
    if (match) {
      console.log('[AssetId] ✅ Found in callback URL:', match[1]);
      return match[1];
    }
  }

  // Strategy 4: Try sources metadata (blob URL might have ID)
  const sources = body?.sources || [];
  if (Array.isArray(sources) && sources.length > 0) {
    const sourceUrl = sources[0];
    const match = sourceUrl.match(/(?:asset|entity)?[_-]?(\d{8,})/i);
    if (match) {
      console.log('[AssetId] ⚠️ Extracting ID from source URL (unreliable):', match[1]);
      return match[1];
    }
  }

  // Return null to signal we need to search by filename
  console.error('[AssetId] ❌ Could not extract Asset ID directly');
  console.error('[AssetId] Will attempt to find asset by searching Content Hub...');
  
  return null;
}

/**
 * FALLBACK: Search Content Hub for the uploaded PDF by filename
 * Extracts filename from blob storage URL and searches for recently created matching asset
 */
async function findAssetIdByFilename(body, token, instance) {
  const sources = body?.sources || [];
  if (!Array.isArray(sources) || sources.length === 0) {
    console.log('[FindByFilename] No sources in request, cannot search');
    return null;
  }

  // Extract filename from blob URL
  // URL format: https://btrq001sstorsea.blob.core.windows.net/files/a49e84c95233442cb4c9da23c68df34a?sv=2019-07-07...
  const sourceUrl = sources[0];
  const urlParts = sourceUrl.split('/');
  const fileHash = urlParts[urlParts.length - 1]?.split('?')[0];

  if (!fileHash) {
    console.log('[FindByFilename] Could not extract filename from source URL:', sourceUrl);
    return null;
  }

  console.log('[FindByFilename] Searching Content Hub for recently uploaded asset with hash:', fileHash);

  try {
    // Search for assets created in the last 5 minutes (in case of clock skew)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    
    // Try multiple search strategies
    const searchQueries = [
      { fulltext: fileHash, entitydefinition: 'M.Asset', take: 50 },
      { q: fileHash, entitydefinition: 'M.Asset', take: 50 },
      { fulltext: 'pdf', entitydefinition: 'M.Asset', take: 100 }, // Fallback: get all recent PDFs
    ];

    for (let i = 0; i < searchQueries.length; i++) {
      const query = searchQueries[i];
      try {
        console.log(`[FindByFilename] Attempt ${i + 1} - searching with:`, query);
        
        const resp = await axios.get(
          `https://${instance}/api/search`,
          {
            params: query,
            headers: chHeaders(token),
            timeout: 10000,
          }
        );

        const items = resp.data?.items || resp.data?.results || resp.data?.data || [];
        console.log(`[FindByFilename] Got ${items.length} results`);

        if (items.length > 0) {
          // Sort by creation date (most recent first) and take the first one
          const sorted = items.sort((a, b) => {
            const dateA = new Date(a.modified || a.created || 0);
            const dateB = new Date(b.modified || b.created || 0);
            return dateB - dateA;
          });

          const found = sorted[0];
          const id = String(found.id || found.Id);
          const name = found.properties?.Title || found.properties?.Name || found.name || 'Unknown';
          
          console.log(`[FindByFilename] ✅ Found asset #${id} (${name})`);
          return id;
        }
      } catch (err) {
        console.log(`[FindByFilename] Attempt ${i + 1} failed: ${err.message}`);
      }
    }

    console.log('[FindByFilename] ❌ No matching asset found after all search attempts');
    return null;
  } catch (err) {
    console.error('[FindByFilename] Error:', err.message);
    return null;
  }
}

// ==================== PDF DOWNLOAD ====================

async function downloadPDF(assetId, token, instance) {
  const assetRes = await axios.get(
    `https://${instance}/api/entities/${assetId}`,
    {
      headers: chHeaders(token),
      timeout: 10000
    }
  );

  const asset = assetRes.data;

  // Debug: log entity structure
  console.log('[Download] Entity keys:', Object.keys(asset));
  console.log('[Download] Entity properties:', JSON.stringify(asset.properties || asset.property || 'none').substring(0, 500));

  // Collect all possible download URLs
  const urlsToTry = [];

  // Strategy 1 — renditions from entity response (top-level or nested)
  const renditions = asset?.renditions || asset?.Renditions;
  if (renditions?.download?.[0]?.href) urlsToTry.push(renditions.download[0].href);
  if (renditions?.original?.[0]?.href) urlsToTry.push(renditions.original[0].href);
  if (renditions?.items) {
    for (const item of renditions.items) {
      if (item.href) urlsToTry.push(item.href);
    }
  }

  // Strategy 2 — look for resource/blob links in entity body
  const resourceLink = asset?.Resource || asset?.resource;
  if (typeof resourceLink === 'string') urlsToTry.push(resourceLink);

  // Strategy 3 — find delivery URL from entity properties
  const props = asset?.properties || asset?.Properties || {};
  const propArray = Array.isArray(props) ? props : Object.entries(props).map(([k, v]) => ({ name: k, value: v }));
  for (const p of propArray) {
    const val = p.value || p.Value;
    if (typeof val === 'string' && val.includes('/api/delivery/')) {
      urlsToTry.push(val);
    }
  }

  // Strategy 4 — try renditions API to get download URLs, then fetch the file
  urlsToTry.push(`https://${instance}/api/entities/${assetId}/renditions`);
  urlsToTry.push(`https://${instance}/api/entities/${assetId}/file`);
  urlsToTry.push(`https://${instance}/api/entities/${assetId}/download`);

  console.log('[Download] Trying URLs:', urlsToTry);

  for (const downloadUrl of urlsToTry) {
    try {
      const fileRes = await axios.get(downloadUrl, {
        responseType: downloadUrl.includes('/renditions') ? 'json' : 'arraybuffer',
        headers: chHeaders(token),
        timeout: 30000,
        validateStatus: s => (s >= 200 && s < 300) || s === 404,
      });

      if (fileRes.status === 200) {
        // If this was the renditions endpoint, parse the response for actual download URLs
        if (downloadUrl.includes('/renditions')) {
          console.log('[Download] Renditions response received, parsing for download URLs...');
          const renditionUrls = extractDownloadUrlsFromRenditions(fileRes.data, instance, assetId, token);
          if (renditionUrls.length > 0) {
            for (const renditionUrl of renditionUrls) {
              console.log('[Download] Trying rendition download URL:', renditionUrl);
              try {
                const pdfRes = await axios.get(renditionUrl, {
                  responseType: 'arraybuffer',
                  headers: chHeaders(token),
                  timeout: 60000,
                });
                console.log('[Download] Success from rendition:', renditionUrl);
                return Buffer.from(pdfRes.data);
              } catch (rendErr) {
                console.log(`[Download] Rendition URL failed: ${renditionUrl} — ${rendErr.message}`);
              }
            }
          }
        } else {
          console.log('[Download] Success from:', downloadUrl);
          return Buffer.from(fileRes.data);
        }
      }
    } catch (err) {
      console.log(`[Download] Failed: ${downloadUrl} — ${err.message}`);
    }
  }

  throw new Error(`File not found for asset #${assetId} — all download URLs exhausted`);
}

// ==================== RENDITIONS PARSING ====================

/** Parse Content Hub renditions API response and extract downloadable file URLs */
function extractDownloadUrlsFromRenditions(renditionsData, instance, assetId) {
  const urls = [];

  // Renditions can come in different shapes depending on CH version
  const data = renditionsData?.data || renditionsData || {};
  const items = data.items || data.results || data.renditions || data;

  const list = Array.isArray(items) ? items : Object.values(items);

  for (const item of list) {
    if (!item) continue;

    // Direct href
    if (typeof item.href === 'string' && item.href.startsWith('http')) {
      urls.push(item.href);
    }
    // Nested download link
    if (item.download?.href) {
      urls.push(item.download.href);
    }
    // FileUrl or Url property
    if (typeof item.FileUrl === 'string') urls.push(item.FileUrl);
    if (typeof item.Url === 'string' && item.Url.startsWith('http')) urls.push(item.Url);
  }

  // If we got nothing structured, check for a delivery-style URL in the raw response
  if (urls.length === 0) {
    const raw = JSON.stringify(renditionsData);
    const match = raw.match(/"https?:[^"]*\/api\/delivery\/[^"]+"/);
    if (match) {
      urls.push(JSON.parse(match[0]));
    }
  }

  // Prefer downloadOriginal or largest rendition first
  urls.sort((a, b) => {
    const aScore = a.includes('downloadOriginal') ? 2 : a.includes('download') ? 1 : 0;
    const bScore = b.includes('downloadOriginal') ? 2 : b.includes('download') ? 1 : 0;
    return bScore - aScore;
  });

  console.log('[Renditions] Extracted URLs:', urls);
  return urls;
}

// ==================== PDF PARSING (pdf-parse - pure JS, no system deps) ====================

async function extractPDFContent(pdfBuffer) {
  try {
    const data = await pdfParse(pdfBuffer);
    const text = (data.text || '').substring(0, 3000).trim();
    const pageCount = data.numpages || 1;

    // Extract product numbers (HIM-XXXX format)
    const productNumberRegex = /[A-Z]{2,4}-\d{3,6}/g;
    const foundProductNumbers = text.match(productNumberRegex) || [];

    // Extract keywords by frequency
    const rawWords = text
      .toLowerCase()
      .split(/[\s\n\r,\.\;:!?()"'\-\–—/\\|@#$%^&*+=<>[\]{}~`]+/)
      .filter(w => w.length >= 4 && w.length <= 50)
      .filter(w => !/^\d[\d\-_\s]*$/.test(w))
      .filter(w => !STOP_WORDS.has(w));

    const freq = {};
    rawWords.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
    const keywords = [...new Set(rawWords)]
      .sort((a, b) => (freq[b] - freq[a]) || a.localeCompare(b))
      .slice(0, 25);

    console.log(`[PDF] Extracted ${text.length} chars, ${keywords.length} keywords from ${pageCount} pages`);

    return {
      text,
      pages: pageCount,
      productNumbers: [...new Set(foundProductNumbers)],
      keywords,
      metadata: {
        title: data.info?.Title || '',
        author: data.info?.Author || '',
        subject: '',
      },
    };
  } catch (err) {
    console.error('[PDF] Error:', err.message);
    throw new Error(`PDF extraction failed: ${err.message}`);
  }
}

// ==================== SEARCH RELATED ASSETS ====================

async function searchRelatedAssets(pdfContent, token, excludeId, instance, pdfFilename) {
  const { keywords, productNumbers } = pdfContent;
  if ((!keywords || keywords.length === 0) && (!productNumbers || productNumbers.length === 0)) return [];

  const matched = [];
  const seen = new Set();

  // Extract PDF base name (e.g. "Bresol" from "Bresol.pdf" or "Bresol (1).pdf")
  const pdfBaseName = (pdfFilename || '')
    .replace(/\.pdf$/i, '')
    .replace(/\s*\(.*?\)\s*/g, '')  // strip (1), (2), etc.
    .replace(/[\s_\-]+/g, ' ')
    .trim()
    .toLowerCase();

  // Also keep the full name without extension for searching
  const pdfFullName = (pdfFilename || '')
    .replace(/\.pdf$/i, '')
    .replace(/[\s_\-]+/g, ' ')
    .trim()
    .toLowerCase();

  // Build search terms: filename variants first, then product numbers, then keywords
  const searchTerms = [];
  if (pdfBaseName) searchTerms.push(pdfBaseName);
  if (pdfFullName && pdfFullName !== pdfBaseName) searchTerms.push(pdfFullName);
  searchTerms.push(...productNumbers.slice(0, 5));
  // Add keywords that are most likely to be product names (short, capitalized-looking)
  for (const kw of keywords) {
    if (kw.length >= 3 && kw.length <= 30 && !searchTerms.includes(kw)) {
      searchTerms.push(kw);
    }
    if (searchTerms.length >= 10) break;
  }

  for (const searchTerm of searchTerms) {
    const sanitized = searchTerm.replace(/[\\"'*()]/g, '');
    let found = false;

    // Strategy 1 — GET /api/search with fulltext parameter
    if (!found) {
      try {
        const resp = await axios.get(
          `https://${instance}/api/search`,
          { params: { fulltext: sanitized, entitydefinition: 'M.Asset', take: 500 }, headers: chHeaders(token), timeout: 10000 },
        );
        const items = resp.data?.items || resp.data?.results || resp.data?.data || [];
        console.log(`[Search] fulltext="${sanitized}" -> ${items.length} items of ${resp.data?.totalItemCount || 0} total`);
        for (const item of items) {
          const id = String(item.id || item.Id);
          const name = item.properties?.Title || item.properties?.Name || item.name || item.Name || '';
          if (id === String(excludeId) || seen.has(id)) continue;
          seen.add(id);
          const confidence = scoreMatch(searchTerm, item);
          if (confidence >= CONFIDENCE_MIN) matched.push({ id, name, confidence, matchedKeyword: searchTerm });
        }
        found = true;
      } catch (err) {
        console.log(`[Search] fulltext="${sanitized}": ${err.message}`);
      }
    }

    // Strategy 2 — GET /api/search with q parameter (fallback)
    if (!found) {
      try {
        const resp = await axios.get(
          `https://${instance}/api/search`,
          { params: { q: sanitized, entitydefinition: 'M.Asset', take: 500 }, headers: chHeaders(token), timeout: 10000 },
        );
        const items = resp.data?.items || resp.data?.results || resp.data?.data || [];
        for (const item of items) {
          const id = String(item.id || item.Id);
          const name = item.properties?.Title || item.properties?.Name || item.name || item.Name || '';
          if (id === String(excludeId) || seen.has(id)) continue;
          seen.add(id);
          const confidence = scoreMatch(searchTerm, item);
          if (confidence >= CONFIDENCE_MIN) matched.push({ id, name, confidence, matchedKeyword: searchTerm });
        }
        found = true;
      } catch (err) {
        console.log(`[Search] q="${sanitized}": ${err.message}`);
      }
    }
  }

  // Deduplicate by id, keep highest confidence
  const best = new Map();
  for (const m of matched) {
    const prev = best.get(m.id);
    if (!prev || m.confidence > prev.confidence) best.set(m.id, m);
  }

  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);
}

function scoreMatch(keyword, item) {
  const props = item.properties || {};
  const name = (props.Name || props.Title || '').toLowerCase();
  const desc = (props.Description || '').toLowerCase();
  const tags = Array.isArray(props.Tags) ? props.Tags.map(t => String(t).toLowerCase()) : [];

  let score = 0;
  if (name === keyword) score = 0.95;
  else if (name.startsWith(keyword)) score = 0.80;
  else if (name.includes(keyword)) score = 0.65;

  if (desc.includes(keyword)) score = Math.max(score, score > 0 ? 0.50 : 0.50);
  if (tags.some(t => t.includes(keyword))) score = Math.max(score, score > 0 ? 0.45 : 0.45);

  const hits = name.split(/[\s_-]+/).filter(w => keyword.includes(w) && w.length > 2).length;
  if (hits >= 2 && score > 0) score += 0.05;

  return Math.min(score, 0.99);
}

// ==================== RELATIONS ====================

async function createRelatedAssetRelations(pdfAssetId, matches, token, instance) {
  try {
    console.log(`[Relation] Linking PDF #${pdfAssetId} to ${matches.length} product(s)...`);

    // GET the PDF entity once (needed for all entity-PUT strategies)
    const getRes = await axios.get(
      `https://${instance}/api/entities/${pdfAssetId}`,
      { headers: chHeaders(token), timeout: 10000 }
    );
    const pdfEntity = getRes.data;
    const entityDef = pdfEntity.entitydefinition || 'M.Asset';
    const productIds = matches.map(m => Number(m.id));

    // ── Strategy 1: Entity PUT with relations → "add" + "id" format ──
    console.log(`[Relation] Strategy 1 — PUT entity with relations.add.id ...`);
    const s1Body = {
      entitydefinition: entityDef,
      properties: pdfEntity.properties || {},
      relations: {
        [RELATION_TYPE]: { add: productIds.map(id => ({ id })) }
      },
    };
    try {
      const s1Res = await axios.put(
        `https://${instance}/api/entities/${pdfAssetId}`,
        s1Body,
        { headers: chHeaders(token), timeout: 15000, validateStatus: s => true }
      );
      console.log(`[Relation] S1 status=${s1Res.status}, data=${JSON.stringify(s1Res.data || '').substring(0, 500)}`);
      if (s1Res.status === 200) { console.log(`[Relation] ✅ via S1`); return; }
    } catch (e) { console.log(`[Relation] S1 error: ${e.message}`); }

    // ── Strategy 2: Entity PUT with @odata.bind on the PRODUCT entities ──
    console.log(`[Relation] Strategy 2 — PUT each product entity with @odata.bind to PDF...`);
    const odataRelName = `${RELATION_TYPE}@odata.bind`;
    const pdfEntityUrl = `https://${instance}/api/entities/${pdfAssetId}`;
    for (const asset of matches) {
      try {
        const prodRes = await axios.get(
          `https://${instance}/api/entities/${asset.id}`,
          { headers: chHeaders(token), timeout: 10000 }
        );
        const prodEntity = prodRes.data;
        const prodEntityDef = prodEntity.entitydefinition || 'M.Asset';
        const s2Res = await axios.put(
          `https://${instance}/api/entities/${asset.id}`,
          {
            entitydefinition: prodEntityDef,
            properties: prodEntity.properties || {},
            [odataRelName]: [pdfEntityUrl],
          },
          { headers: chHeaders(token), timeout: 15000, validateStatus: s => true }
        );
        console.log(`[Relation] S2 product #${asset.id}: status=${s2Res.status}, data=${JSON.stringify(s2Res.data || '').substring(0, 300)}`);
      } catch (e2) { console.log(`[Relation] S2 product #${asset.id} error: ${e2.message}`); }
    }

    // ── Strategy 3: PUT entity with direct navigation property array (no wrapper) ──
    console.log(`[Relation] Strategy 3 — PUT entity with direct nav property array...`);
    const s3Body = {
      entitydefinition: entityDef,
      properties: pdfEntity.properties || {},
      [RELATION_TYPE]: productIds.map(id => ({ id })),
    };
    try {
      const s3Res = await axios.put(
        `https://${instance}/api/entities/${pdfAssetId}`,
        s3Body,
        { headers: chHeaders(token), timeout: 15000, validateStatus: s => true }
      );
      console.log(`[Relation] S3 status=${s3Res.status}, data=${JSON.stringify(s3Res.data || '').substring(0, 500)}`);
      if (s3Res.status === 200) {
        // Verify: re-fetch the entity and check the relations
        console.log(`[Relation] S3 returned 200 — verifying by re-fetching entity...`);
        const vRes = await axios.get(
          `https://${instance}/api/entities/${pdfAssetId}`,
          { headers: chHeaders(token), timeout: 10000 }
        );
        const vRel = vRes.data?.relations?.[RELATION_TYPE] || {};
        console.log(`[Relation] Verify: ${RELATION_TYPE} = ${JSON.stringify(vRel).substring(0, 400)}`);
        // Also try to read the relation endpoint to check if children were added
        const relHref = vRel?.href;
        if (relHref) {
          const relRes = await axios.get(relHref, { headers: chHeaders(token), timeout: 10000, validateStatus: s => true });
          console.log(`[Relation] Verify endpoint: status=${relRes.status}, data=${JSON.stringify(relRes.data || '').substring(0, 500)}`);
          const children = relRes.data?.children || relRes.data?.items || [];
          if (Array.isArray(children) && children.some(c => productIds.includes(Number(c.id)))) {
            console.log(`[Relation] ✅ S3 confirmed — relations persisted!`);
            return;
          }
          console.log(`[Relation] ⚠️ S3 returned 200 but children NOT found in relation endpoint — continuing...`);
        }
      }
    } catch (e3) { console.log(`[Relation] S3 error: ${e3.message}`); }

    // ── Strategy 4: POST as M.Relation entity creation ──
    console.log(`[Relation] Strategy 4 — POST new M.Relation entity for each product...`);
    const relEntityDef = { href: `https://${instance}/api/entitydefinitions/M.Relation`, title: 'Relation' };
    for (const pid of productIds) {
      try {
        const s4Res = await axios.post(
          `https://${instance}/api/entities`,
          {
            entitydefinition: relEntityDef,
            properties: {
              Source: pdfAssetId,
              Target: pid,
              RelationType: RELATION_TYPE,
            },
          },
          { headers: chHeaders(token), timeout: 15000, validateStatus: s => true }
        );
        console.log(`[Relation] S4 POST M.Relation source=${pdfAssetId} target=${pid}: status=${s4Res.status}, data=${JSON.stringify(s4Res.data || '').substring(0, 300)}`);
      } catch (e4) { console.log(`[Relation] S4 error: ${e4.message}`); }
    }

    // ── Strategy 5: POST to /api/relations endpoint ──
    console.log(`[Relation] Strategy 5 — POST to /api/relations...`);
    try {
      const s5Res = await axios.post(
        `https://${instance}/api/relations`,
        { sources: [pdfAssetId], targets: productIds, relationType: RELATION_TYPE },
        { headers: chHeaders(token), timeout: 15000, validateStatus: s => true }
      );
      console.log(`[Relation] S5 status=${s5Res.status}, data=${JSON.stringify(s5Res.data || '').substring(0, 500)}`);
      if (s5Res.status === 200 || s5Res.status === 201) { console.log(`[Relation] ✅ via S5`); return; }
    } catch (e5) { console.log(`[Relation] S5 error: ${e5.message}`); }

    // ── Strategy 6: PUT to product relations endpoint with parents format ──
    console.log(`[Relation] Strategy 6 — PUT product relation with parents (href)...`);
    const pdfHref = `https://${instance}/api/entities/${pdfAssetId}`;
    for (const asset of matches) {
      try {
        const s6Res = await axios.put(
          `https://${instance}/api/entities/${asset.id}/relations/${RELATION_TYPE}`,
          { parents: [{ href: pdfHref }] },
          { headers: chHeaders(token), timeout: 15000, validateStatus: s => true }
        );
        console.log(`[Relation] S6 product #${asset.id}: status=${s6Res.status}, data=${JSON.stringify(s6Res.data || '').substring(0, 300)}`);
        if (s6Res.status === 200) {
          const vRes = await axios.get(
            `https://${instance}/api/entities/${asset.id}/relations/${RELATION_TYPE}`,
            { headers: chHeaders(token), timeout: 10000, validateStatus: s => true }
          );
          console.log(`[Relation] S6 verify #${asset.id}: ${JSON.stringify(vRes.data || '').substring(0, 400)}`);
          const parents = vRes.data?.parents || [];
          if (Array.isArray(parents) && parents.some(p => Number(p.id) === Number(pdfAssetId) || p.href?.includes(String(pdfAssetId)))) {
            console.log(`[Relation] ✅ S6 confirmed — product #${asset.id} now has PDF as parent`);
          }
        }
      } catch (e6) { console.log(`[Relation] S6 error: ${e6.message}`); }
    }

    console.log(`[Relation] ⚠️ All strategies attempted — see logs above`);
  } catch (err) {
    console.log(`[Relation] ❌ Error: ${err.message}`);
    if (err.response) {
      console.log(`[Relation] Error details: status=${err.response.status}, data=${JSON.stringify(err.response.data || '').substring(0, 500)}`);
    }
  }
}

// ==================== METADATA ====================

async function updateAssetMetadata(assetId, metadata, token, instance) {
  const logPrefix = `[Metadata #${assetId}]`;
  try {
    // Strategy 1 — PUT full entity with merged properties
    const entityRes = await axios.get(
      `https://${instance}/api/entities/${assetId}`,
      { headers: chHeaders(token), timeout: 8000 }
    );

    const current = entityRes.data.properties || {};
    Object.entries(metadata).forEach(([key, value]) => {
      current[key] = value;
    });

    const entityDef = entityRes.data.entitydefinition || 'M.Asset';

    await axios.put(
      `https://${instance}/api/entities/${assetId}`,
      { entitydefinition: entityDef, properties: current },
      { headers: chHeaders(token), timeout: 8000 }
    );
    console.log(`${logPrefix} Updated via PUT`);
  } catch (putErr) {
    // Strategy 2 — Try PATCH instead
    try {
      await axios.patch(
        `https://${instance}/api/entities/${assetId}`,
        { entitydefinition: 'M.Asset', properties: metadata },
        { headers: chHeaders(token), timeout: 8000 }
      );
      console.log(`${logPrefix} Updated via PATCH`);
      return;
    } catch { /* ignore */ }

    // Just warn — metadata update is non-critical
    console.warn(`${logPrefix} Failed to update metadata: ${putErr.message}`);
  }
}

// ==================== MAIN HANDLER ====================

app.post('/api/pdf/associate', async (req, res) => {
  const start = Date.now();
  console.log('══════════════════════════════════════════════');
  console.log('[Handler] POST /api/pdf/associate called');

  // Debug: inspect request headers
  console.log("[Handler] Headers:", JSON.stringify(req.headers));
  console.log("[Handler] API KEY:", req.headers["x-api-key"]);

  // Security check
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_SECRET) {
    console.warn('[Handler] Unauthorized — invalid x-api-key');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    console.log('[Handler] Body:', JSON.stringify(req.body));

    // Get instance first
    const instance = req.body?.instanceUrl || INSTANCE;

    // Step 1: Auth (do this early so we can use token for fallbacks)
    const token = await getAuthToken(instance);

    // Step 2: Extract Asset ID
    let pdfAssetId = extractAssetId(req.body);
    
    // Step 2b: If extraction failed, try to find asset by searching for recently uploaded file
    if (!pdfAssetId) {
      console.log('[Handler] Direct extraction failed, attempting fallback: search by filename...');
      pdfAssetId = await findAssetIdByFilename(req.body, token, instance);
    }
    
    if (!pdfAssetId) {
      console.error('[Handler] ❌ Could not extract or find Asset ID');
      return res.status(400).json({ 
        success: false, 
        error: 'No valid assetId in request and could not find asset by filename search',
        hint: 'Ensure PDF was uploaded to Content Hub and the flow parameters contain either entity ID or valid blob storage source URL'
      });
    }

    // Get other metadata
    const saveMsg = req.body?.saveEntityMessage;
    const fileNameChange = saveMsg?.ChangeSet?.PropertyChanges?.find(p => p.Property === 'FileName');
    const pdfFilename = fileNameChange?.NewValue
      || (req.body?.sources?.[0]?.split('/')?.pop()?.split('?')?.[0])
      || 'unknown.pdf';

    console.log(`[Handler] Asset #${pdfAssetId}, File: ${pdfFilename}, Instance: ${instance}`);

    // Step 3: Download PDF
    const pdfBuffer = await downloadPDF(pdfAssetId, token, instance);

    // Step 4: Extract text
    const pdfContent = await extractPDFContent(pdfBuffer);

    if (!pdfContent.text || pdfContent.text.length < 15) {
      console.log('[Handler] Insufficient text, skipping');
      await updateAssetMetadata(pdfAssetId, {
        'PDF Association Status': 'Skipped — insufficient text',
        'PDF Association Date': new Date().toISOString(),
      }, token, instance);

      return res.json({
        success: true,
        assetId: pdfAssetId,
        message: 'Insufficient text in PDF',
        matches: 0,
      });
    }

    // Step 5: Search for related assets
    const matches = await searchRelatedAssets(pdfContent, token, pdfAssetId, instance, pdfFilename);
    console.log(`[Handler] Found ${matches.length} related assets`);

    // Step 6: Create relations
    if (matches.length > 0) {
      await createRelatedAssetRelations(pdfAssetId, matches, token, instance);
    }

    // Step 7: Update metadata
    const meta = {
      'PDF Association Status': matches.length > 0 ? 'Completed' : 'No Matches Found',
      'PDF Association Count': String(matches.length),
      'PDF Association Date': new Date().toISOString(),
    };
    if (matches.length > 0) {
      meta['PDF Top Match'] = matches[0].name;
      meta['PDF Top Confidence'] = String(matches[0].confidence.toFixed(2));
    }
    await updateAssetMetadata(pdfAssetId, meta, token, instance);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[Handler] Done in ${elapsed}s — ${matches.length} matches`);
    console.log('══════════════════════════════════════════════');

    return res.json({
      success: true,
      assetId: pdfAssetId,
      fileName: pdfFilename,
      matchesFound: matches.length,
      matches: matches.map(m => ({
        assetId: m.id,
        assetName: m.name,
        confidence: +m.confidence.toFixed(2),
      })),
    });

  } catch (error) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`[Handler] Error after ${elapsed}s:`, error.message);
    console.error('[Handler] Stack:', error.stack);

    return res.status(500).json({
      success: false,
      error: error.message,
      fallbackAction: 'manual_review_required',
    });
  }
});

// ==================== VERCEL HANDLER ====================
// Wrap Express app for Vercel serverless function
export default async (req, res) => {
  try {
    return await new Promise((resolve) => {
      app(req, res);
      res.on('finish', () => resolve());
    });
  } catch (err) {
    console.error('[Vercel Handler] Critical error:', err.message);
    res.status(500).json({
      success: false,
      error: 'Serverless function error',
      details: err.message,
    });
  }
};