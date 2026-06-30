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
const RELATION_TYPE = process.env.PDF_RELATION_TYPE || 'RelatedAssets';

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

async function searchRelatedAssets(pdfContent, token, excludeId, instance) {
  const { keywords, productNumbers } = pdfContent;
  if ((!keywords || keywords.length === 0) && (!productNumbers || productNumbers.length === 0)) return [];

  const matched = [];
  const seen = new Set();
  const topKw = [...new Set([...keywords.slice(0, 12), ...productNumbers.slice(0, 5)])];

  for (const searchTerm of topKw) {
    const sanitized = searchTerm.replace(/[\\"'*()]/g, '');
    let found = false;

    // Strategy 1 — GET /api/entities with no filter (probe endpoint)
    // then manually filter by keyword in name
    if (!found) {
      try {
        const resp = await axios.get(
          `https://${instance}/api/entities`,
          { params: { limit: 20, select: 'id,name,description' }, headers: chHeaders(token), timeout: 10000 },
        );
        console.log(`[Search] GET /api/entities (no filter) works! Items:`, resp.data?.items?.length);
        for (const item of resp.data?.items || []) {
          const name = (item.properties?.Name || item.properties?.Title || item.name || '').toLowerCase();
          if (!name.includes(sanitized.toLowerCase())) continue;
          const id = String(item.id);
          if (id === String(excludeId) || seen.has(id)) continue;
          seen.add(id);
          const confidence = scoreMatch(searchTerm, item);
          if (confidence >= CONFIDENCE_MIN) matched.push({ id, name: item.properties?.Name || item.name, confidence, matchedKeyword: searchTerm });
        }
        found = true;
      } catch (err) {
        console.log(`[Search] GET /api/entities (no filter): ${err.message}`);
      }
    }

    // Strategy 2 — GET /api/search
    if (!found) {
      try {
        const resp = await axios.get(
          `https://${instance}/api/search`,
          { params: { q: sanitized, entitydefinition: 'M.Asset', limit: 10 }, headers: chHeaders(token), timeout: 10000 },
        );
        console.log(`[Search] GET /api/search "${sanitized}" -> Status: ${resp.status}, keys:`, Object.keys(resp.data || {}).join(', '));
        // Log a snippet of the response to understand structure
        const snippet = JSON.stringify(resp.data).substring(0, 400);
        console.log(`[Search] Response snippet: ${snippet}`);
        for (const item of resp.data?.items || resp.data?.results || resp.data?.data || resp.data?.hits || []) {
          const id = String(item.id || item.Id);
          const name = item.properties?.Name || item.properties?.Title || item.name || item.Name || '';
          if (id === String(excludeId) || seen.has(id)) continue;
          seen.add(id);
          const confidence = scoreMatch(searchTerm, item);
          if (confidence >= CONFIDENCE_MIN) matched.push({ id, name, confidence, matchedKeyword: searchTerm });
        }
        found = true;
      } catch (err) {
        console.log(`[Search] GET /api/search "${sanitized}": ${err.message}`);
      }
    }

    // Strategy 3 — GET /api/entities?query=
    if (!found) {
      try {
        const resp = await axios.get(
          `https://${instance}/api/entities`,
          { params: { query: `name contains '${sanitized}'`, limit: 5 }, headers: chHeaders(token), timeout: 10000 },
        );
        for (const item of resp.data?.items || []) {
          const id = String(item.id);
          const name = item.properties?.Name || item.properties?.Title || item.name || '';
          if (id === String(excludeId) || seen.has(id)) continue;
          seen.add(id);
          const confidence = scoreMatch(searchTerm, item);
          if (confidence >= CONFIDENCE_MIN) matched.push({ id, name, confidence, matchedKeyword: searchTerm });
        }
        found = true;
      } catch (err) {
        console.log(`[Search] GET /api/entities?query= "${sanitized}": ${err.message}`);
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

async function createRelatedAssetRelations(assetId, matches, token, instance) {
  for (const asset of matches) {
    let ok = false;

    // Strategy 1 — v2 relations endpoint
    try {
      await axios.post(
        `https://${instance}/api/relations`,
        { relationType: RELATION_TYPE, source: String(assetId), target: String(asset.id), sourceType: 'M.Asset', targetType: 'M.Asset' },
        { headers: chHeaders(token), timeout: 10000 },
      );
      ok = true;
    } catch { /* fall through */ }

    // Strategy 2 — entity relations endpoint
    if (!ok) {
      try {
        await axios.post(
          `https://${instance}/api/entities/${assetId}/relations`,
          { relationType: RELATION_TYPE, relatedEntityId: String(asset.id), targetEntityType: 'M.Asset' },
          { headers: chHeaders(token), timeout: 10000 },
        );
        ok = true;
      } catch { /* fall through */ }
    }

    // Strategy 3 — legacy
    if (!ok) {
      try {
        await axios.post(
          `https://${instance}/api/entities/${assetId}/relations/${RELATION_TYPE}`,
          { id: String(asset.id) },
          { headers: chHeaders(token), timeout: 10000 },
        );
        ok = true;
      } catch { /* fall through */ }
    }

    console.log(ok
      ? `[Relation] ✅ #${assetId} → #${asset.id} (${asset.name})`
      : `[Relation] ⚠️ Failed: #${assetId} → #${asset.id}`);
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

    await axios.put(
      `https://${instance}/api/entities/${assetId}`,
      { properties: current },
      { headers: chHeaders(token), timeout: 8000 }
    );
    console.log(`${logPrefix} Updated via PUT`);
  } catch (putErr) {
    // Strategy 2 — Try PATCH instead
    try {
      await axios.patch(
        `https://${instance}/api/entities/${assetId}`,
        { properties: metadata },
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

  // Security check
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_SECRET) {
    console.warn('[Handler] Unauthorized — invalid x-api-key');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    console.log('[Handler] Body:', JSON.stringify(req.body));

    // const { entityId, fileName, instanceUrl, entity } = req.body || {};
    const saveMsg = req.body?.saveEntityMessage;
    const pdfAssetId = saveMsg?.TargetId;
    const fileNameChange = saveMsg?.ChangeSet?.PropertyChanges?.find(p => p.Property === 'FileName');
    const pdfFilename = fileNameChange?.NewValue || 'unknown.pdf'; 
    const instance = req.body?.instanceUrl || INSTANCE;

    if (!pdfAssetId) {
      return res.status(200).json({ success: false, error: 'No entityId provided' });
    }

    console.log(`[Handler] Asset #${pdfAssetId}, File: ${pdfFilename}, Instance: ${instance}`);

    // Step 1: Auth
    const token = await getAuthToken(instance);

    // Step 2: Download PDF
    const pdfBuffer = await downloadPDF(pdfAssetId, token, instance);

    // Step 3: Extract text
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

    // Step 4: Search for related assets
    const matches = await searchRelatedAssets(pdfContent, token, pdfAssetId, instance);
    console.log(`[Handler] Found ${matches.length} related assets`);

    // Step 5: Create relations
    if (matches.length > 0) {
      await createRelatedAssetRelations(pdfAssetId, matches, token, instance);
    }

    // Step 6: Update metadata
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