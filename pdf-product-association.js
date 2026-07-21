import { createRequire } from 'module';
import axios from 'axios';
import express from 'express';
import { injectSpeedInsights } from '@vercel/speed-insights';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json());

// Initialize Vercel Speed Insights
if (process.env.NODE_ENV === 'production') {
  injectSpeedInsights();
}

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
  // Product description boilerplate
  'contains','contained','including','include','care','consult','physician',
  'advised','advisable','special','conditions','symptoms','persist','directions',
  'instructions','recommend','recommended','suggest','suggested',
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

// ==================== FETCH PRODUCTS DYNAMICALLY ====================

// ─────────────────────────────────────────────────────────────────────
// FIX 1: Stop filtering out image-extension assets (e.g. .jpg files
//         that are product images stored as assets in Content Hub).
//         Also stop stripping dimension suffixes before matching —
//         instead keep the raw name AND a cleaned "matchName" so we
//         can try both during scoring.
// ─────────────────────────────────────────────────────────────────────
async function getProductList(token, instance) {
  try {
    console.log('[Products] Fetching product list from Content Hub...');

    const resp = await axios.get(
      `https://${instance}/api/search`,
      {
        params: {
          entitydefinition: 'M.Asset',   // FIX: search M.Asset not just M.Product
                                          // so image assets are included
          take: 500,
        },
        headers: chHeaders(token),
        timeout: 10000,
      }
    );

    const items = resp.data?.items || resp.data?.results || resp.data?.data || [];

    const products = items.map(item => {
      const rawName = (
        item.properties?.Name ||
        item.properties?.Title ||
        item.name ||
        item.Name ||
        ''
      ).trim();

      const sku = (
        item.properties?.SkuCode ||
        item.properties?.ProductCode ||
        ''
      ).toLowerCase().trim();

      // ── Build a "clean" match name by stripping only decorative suffixes ──
      // Keep the product word(s) intact:
      //   "Guduchi-2000_1800x1800.jpg"  → matchName = "guduchi-2000"
      //   "Ashwagandha_abc123hash.jpg"  → matchName = "ashwagandha"
      //   "Triphala Churna"             → matchName = "triphala churna"
      const matchName = rawName
        .toLowerCase()
        .replace(/\.(jpg|jpeg|png|gif|webp|svg|pdf)$/i, '') // strip extension
        .replace(/_\d{3,5}x\d{3,5}$/i, '')                 // strip _1800x1800
        .replace(/_[a-f0-9]{32,}$/i, '')                    // strip long hash suffix
        .replace(/-[a-f0-9]{8,}$/i, '')                     // strip short hash suffix
        .trim();

      // FIX 2: Only skip entries that are PURELY a UUID/hash with NO readable
      //         product word at the start.
      const isBarePureUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(matchName);
      const isBarePureHash = /^[a-f0-9]{32,}$/.test(matchName);

      if (isBarePureUUID || isBarePureHash || matchName.length === 0) {
        return null; // will be filtered below
      }

      // Extract individual words for keyword matching
      const nameWords = matchName.split(/[\s\-_]+/).filter(w => w.length > 2);

      return {
        id: String(item.id || item.Id),
        rawName,                         // original, unmodified
        name: matchName,                 // cleaned, lowercase
        title: item.properties?.Title || item.properties?.Name || rawName,
        mainName: matchName,
        keywords: [
          matchName,
          sku,
          ...nameWords,
        ].filter(Boolean),
        searchTerms: nameWords,
      };
    }).filter(Boolean); // remove nulls

    console.log(`[Products] ✓ Fetched ${products.length} assets (filtered)`);
    if (products.length > 0) {
      console.log(`[Products] Sample: ${products.slice(0, 5).map(p => p.rawName).join(', ')}`);
    }

    return products;
  } catch (err) {
    console.warn(`[Products] Failed to fetch products: ${err.message}`);
    return [];
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

// ==================== PDF PARSING ====================

// ─────────────────────────────────────────────────────────────────────
// FIX 3: extractPDFContent now matches against the CLEANED matchName
//         (which strips image extensions and dimension suffixes before
//         comparing), so "Guduchi-2000_1800x1800.jpg" → matchName
//         "guduchi-2000" → first word "guduchi" → matched in PDF text.
// ─────────────────────────────────────────────────────────────────────
async function extractPDFContent(pdfBuffer, knownProducts = []) {
  try {
    const data = await pdfParse(pdfBuffer);
    const text = (data.text || '').substring(0, 3000).trim();
    const pageCount = data.numpages || 1;
    const textLower = text.toLowerCase();

    // Strategy 1: Extract product codes (HIM-XXXX format)
    const productNumberRegex = /[A-Z]{2,4}-\d{3,6}/g;
    const foundProductNumbers = text.match(productNumberRegex) || [];

    // Strategy 2: Match against known products from Content Hub
    const foundProductNames = [];
    const matchedProductIds = new Set();

    for (const product of knownProducts) {
      // Use the cleaned matchName (e.g. "guduchi-2000") for matching,
      // NOT the raw name which may include ".jpg" or "_1800x1800".
      const cleanName = product.mainName; // already cleaned in getProductList

      if (cleanName && cleanName.length > 2) {

        // Strategy 2a: Try the FIRST WORD of the cleaned product name
        // "guduchi-2000" → firstWord = "guduchi"
        const firstWord = cleanName.split(/[\s\-_]+/)[0];

        if (firstWord && firstWord.length > 2) {
          const firstWordRegex = new RegExp(
            `\\b${firstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'i'
          );
          if (firstWordRegex.test(text) && !matchedProductIds.has(product.id)) {
            foundProductNames.push({
              name: cleanName,
              title: product.title,
              id: product.id,
              source: 'dynamic_match',
              confidence: 0.92,
            });
            matchedProductIds.add(product.id);
            continue;
          }
        }

        // Strategy 2b: Try matching the full cleaned name (handles multi-word products)
        if (!matchedProductIds.has(product.id)) {
          const fullNameRegex = new RegExp(
            `\\b${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'i'
          );
          if (fullNameRegex.test(text)) {
            foundProductNames.push({
              name: cleanName,
              title: product.title,
              id: product.id,
              source: 'full_name_match',
              confidence: 0.95,
            });
            matchedProductIds.add(product.id);
            continue;
          }
        }
      }

      // Strategy 2c: Match on SKU if name didn't match
      if (!matchedProductIds.has(product.id)) {
        const skuKeywords = product.keywords.filter(kw => kw.includes('-') && kw.length > 5);
        for (const skuKeyword of skuKeywords) {
          if (textLower.includes(skuKeyword)) {
            foundProductNames.push({
              name: product.mainName || product.name,
              title: product.title,
              id: product.id,
              source: 'sku_match',
              confidence: 0.90,
            });
            matchedProductIds.add(product.id);
            break;
          }
        }
      }
    }

    // Strategy 3: Extract keywords from content (excluding boilerplate sections)
    const boilerplatePatterns = [
      /special instructions/i,
      /directions for use/i,
      /good to know/i,
      /how to use/i,
      /dosage/i,
    ];

    let boilerplateStart = text.length;
    for (const pattern of boilerplatePatterns) {
      const match = text.toLowerCase().search(pattern);
      if (match > 0 && match < boilerplateStart) {
        boilerplateStart = match;
      }
    }

    const mainContent = boilerplateStart < text.length
      ? text.substring(0, boilerplateStart)
      : text;

    // Extract keywords
    const rawWords = mainContent
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

    console.log(`[PDF] Extracted ${text.length} chars from ${pageCount} pages`);
    if (foundProductNames.length > 0) {
      console.log(`[PDF] ✓ Dynamic product matches: ${foundProductNames.length}`);
      foundProductNames.forEach(p => {
        console.log(`       - ${p.title} (${p.source}, confidence=${p.confidence})`);
      });
    } else {
      console.log(`[PDF] No direct product matches found`);
    }
    console.log(`[PDF] Product codes found: ${foundProductNumbers.length > 0 ? foundProductNumbers.join(', ') : 'none'}`);
    console.log(`[PDF] Keywords (${keywords.length}): ${keywords.join(', ')}`);

    return {
      text,
      pages: pageCount,
      productNumbers: [...new Set(foundProductNumbers)],
      productNames: foundProductNames,
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

// ─────────────────────────────────────────────────────────────────────
// FIX 4: scoreMatch now uses the asset's CLEANED name for comparison,
//         not the raw name, so ".jpg" / "_1800x1800" don't block hits.
// ─────────────────────────────────────────────────────────────────────
async function searchRelatedAssets(pdfContent, token, excludeId, instance, pdfFilename, knownProducts = []) {
  const { keywords, productNumbers, productNames } = pdfContent;

  const matched = [];
  const seen = new Set();

  // TIER 1: Direct product name matches (highest confidence)
  console.log(`[Search] Tier 1: Direct product name matches...`);
  for (const product of productNames) {
    if (String(product.id) !== String(excludeId) && !seen.has(String(product.id))) {
      seen.add(String(product.id));
      matched.push({
        id: product.id,
        name: product.title || product.name,
        confidence: product.confidence || 0.95,
        matchedKeyword: product.name,
        source: 'direct_product_match',
      });
      console.log(`[Search] ✓ Matched: ${product.title} (confidence=${product.confidence})`);
    }
  }

  // TIER 2: Search for product codes
  console.log(`[Search] Tier 2: Product codes search...`);
  for (const code of productNumbers) {
    try {
      const resp = await axios.get(
        `https://${instance}/api/search`,
        {
          params: {
            fulltext: code,
            entitydefinition: 'M.Asset',  // FIX: search M.Asset
            take: 50,
          },
          headers: chHeaders(token),
          timeout: 10000,
        }
      );

      const items = resp.data?.items || resp.data?.results || resp.data?.data || [];
      console.log(`[Search] Code "${code}" -> ${items.length} results`);

      for (const item of items) {
        const id = String(item.id || item.Id);
        if (id === String(excludeId) || seen.has(id)) continue;

        seen.add(id);
        matched.push({
          id,
          name: item.properties?.Title || item.properties?.Name || item.name || '',
          confidence: 0.88,
          matchedKeyword: code,
          source: 'product_code_match',
        });
      }
    } catch (err) {
      console.log(`[Search] Code "${code}" search failed: ${err.message}`);
    }
  }

  // TIER 3: Keyword-based search (only if tiers 1 & 2 didn't find much)
  if (matched.length < 3) {
    console.log(`[Search] Tier 3: Keyword search (${matched.length} found so far)...`);

    const searchTerms = [...keywords.slice(0, 10)];

    for (const searchTerm of searchTerms) {
      const sanitized = searchTerm.replace(/[\\"'*()]/g, '');

      try {
        const resp = await axios.get(
          `https://${instance}/api/search`,
          {
            params: {
              fulltext: sanitized,
              entitydefinition: 'M.Asset',  // FIX: search M.Asset
              take: 100,
            },
            headers: chHeaders(token),
            timeout: 10000,
          }
        );

        const items = resp.data?.items || resp.data?.results || resp.data?.data || [];
        console.log(`[Search] Keyword "${sanitized}" -> ${items.length} results`);

        for (const item of items) {
          const id = String(item.id || item.Id);
          if (id === String(excludeId) || seen.has(id)) continue;

          seen.add(id);
          const confidence = scoreMatch(searchTerm, item);

          if (confidence >= 0.35) {
            matched.push({
              id,
              name: item.properties?.Title || item.properties?.Name || '',
              confidence,
              matchedKeyword: searchTerm,
              source: 'keyword_match',
            });
            console.log(`[Search]   ✓ "${item.properties?.Title || item.name}" matched with keyword "${sanitized}" (confidence=${confidence.toFixed(2)})`);
          }
        }
      } catch (err) {
        console.log(`[Search] Keyword "${sanitized}" failed: ${err.message}`);
      }
    }
  }

  // Deduplicate, sort by confidence, limit results
  const best = new Map();
  for (const m of matched) {
    const prev = best.get(m.id);
    if (!prev || m.confidence > prev.confidence) {
      best.set(m.id, m);
    }
  }

  const results = [...best.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);

  console.log(`[Search] Final results: ${results.length} matches`);
  results.forEach(r => {
    console.log(`  - ${r.name} (${r.source}, confidence=${r.confidence.toFixed(2)})`);
  });

  return results;
}

function scoreMatch(keyword, item) {
  const props = item.properties || {};

  // ── FIX 5: Clean the asset name the same way getProductList does,
  //           so "Guduchi-2000_1800x1800.jpg" scores correctly against
  //           the keyword "guduchi". ──
  const rawName = (props.Name || props.Title || '').toLowerCase();
  const name = rawName
    .replace(/\.(jpg|jpeg|png|gif|webp|svg|pdf)$/i, '')
    .replace(/_\d{3,5}x\d{3,5}$/i, '')
    .replace(/_[a-f0-9]{32,}$/i, '')
    .replace(/-[a-f0-9]{8,}$/i, '')
    .trim();

  const desc = (props.Description || '').toLowerCase();
  const tags = Array.isArray(props.Tags) ? props.Tags.map(t => String(t).toLowerCase()) : [];

  let score = 0;

  // Exact cleaned name match
  if (name === keyword) {
    score = 0.95;
  } else if (name.startsWith(keyword) || keyword.startsWith(name)) {
    score = 0.85;
  } else if (name.includes(keyword)) {
    score = 0.72;
  } else {
    // Check if keyword matches the first word of the cleaned product name
    const nameWords = name.split(/[\s\-_]+/);
    const firstWord = nameWords[0];

    if (firstWord === keyword) {
      score = 0.78; // First word exact match
    } else if (firstWord && firstWord.startsWith(keyword) && keyword.length > 3) {
      score = 0.68; // First word partial match
    } else if (keyword.length > 6 && name.includes(keyword.substring(0, 6))) {
      score = 0.60; // Substring match
    }
  }

  // Description match (lower weight)
  if (desc.includes(keyword) && score < 0.50) {
    score = Math.max(score, 0.45);
  }

  // Tags match (lower weight)
  if (tags.some(t => t.includes(keyword)) && score < 0.50) {
    score = Math.max(score, 0.40);
  }

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
        console.log(`[Relation] S3 returned 200 — verifying by re-fetching entity...`);
        const vRes = await axios.get(
          `https://${instance}/api/entities/${pdfAssetId}`,
          { headers: chHeaders(token), timeout: 10000 }
        );
        const vRel = vRes.data?.relations?.[RELATION_TYPE] || {};
        console.log(`[Relation] Verify: ${RELATION_TYPE} = ${JSON.stringify(vRel).substring(0, 400)}`);
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

    // Step 2: Fetch asset list dynamically (includes image assets like .jpg)
    const knownProducts = await getProductList(token, instance);

    // Step 3: Download PDF
    const pdfBuffer = await downloadPDF(pdfAssetId, token, instance);

    // Step 4: Extract text WITH product matching
    const pdfContent = await extractPDFContent(pdfBuffer, knownProducts);

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

    // Step 5: Search for related assets with three-tier strategy
    const matches = await searchRelatedAssets(pdfContent, token, pdfAssetId, instance, pdfFilename, knownProducts);
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
        source: m.source,
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
