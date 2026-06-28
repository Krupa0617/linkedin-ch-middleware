import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const {
  FIGMA_ACCESS_TOKEN,
  CONTENT_HUB_URL,
  CONTENT_HUB_USERNAME,
  CONTENT_HUB_PASSWORD,
  API_SECRET_KEY,
} = process.env;

const FIGMA_API_URL = 'https://api.figma.com/v1';
const MAX_RETRIES = 8;

// ─────────────────────────────────────────────
// Helpers: sleep + retry with exponential backoff
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-memory cache for Figma API responses.
 * Keyed by the full URL (including query params).
 * Avoids hitting the Figma API at all for files already fetched recently.
 *
 * Figma file data (structure, names, IDs) changes infrequently, so a 5-minute
 * cache is safe and dramatically reduces rate-limit pressure.
 */
const figmaCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = figmaCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    figmaCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  // Evict oldest entries if cache grows beyond 50 items
  if (figmaCache.size >= 50) {
    const oldest = [...figmaCache.entries()]
      .sort(([, a], [, b]) => a.ts - b.ts)[0];
    if (oldest) figmaCache.delete(oldest[0]);
  }
  figmaCache.set(key, { data, ts: Date.now() });
}

/**
 * Tracks Figma rate-limit headers across all calls so we can throttle
 * pre-emptively instead of waiting for a 429.
 *
 * Figma uses a sliding 60 s window.  After each response we record:
 *  - `resetAt`  — epoch-ms when the window resets
 *  - `remaining` — requests left in this window
 */
const figmaRateLimit = { resetAt: 0, remaining: 999 };

function trackFigmaRateLimit(response) {
  const headers = response.headers || {};
  const remaining = headers['x-ratelimit-remaining'];
  const resetEpoch = headers['x-ratelimit-reset'];
  const limit = headers['x-ratelimit-limit'];

  if (remaining != null) figmaRateLimit.remaining = Number(remaining);
  if (resetEpoch)        figmaRateLimit.resetAt = Number(resetEpoch) * 1000;

  if (limit != null) {
    console.log(
      `📊 Figma rate-limit state: ${figmaRateLimit.remaining}/${limit} remaining` +
      (figmaRateLimit.resetAt > Date.now()
        ? `, resets in ${Math.round((figmaRateLimit.resetAt - Date.now()) / 1000)}s`
        : '')
    );
  }

  // If we are down to the last request, proactively pause until the reset.
  if (figmaRateLimit.remaining <= 1 && figmaRateLimit.resetAt > Date.now()) {
    const wait = figmaRateLimit.resetAt - Date.now() + 200;
    console.warn(
      `⚠️  Figma rate limit nearly exhausted (${figmaRateLimit.remaining} remaining) — ` +
      `pausing ${(wait / 1000).toFixed(1)}s until window resets`
    );
    return sleep(wait);
  }
}

/**
 * Dumps all response headers from an axios error to help diagnose rate-limit
 * issues.  Figma does NOT always include the standard rate-limit headers on
 * 429 responses — this lets us see exactly what it sent back.
 */
function logFigmaErrorDiagnostics(err, url) {
  const status = err.response?.status;
  const headers = err.response?.headers || {};
  const body = err.response?.data;

  console.error(`\n🔥 ─── FIGMA API ERROR DIAGNOSTICS ───`);
  console.error(`   URL:     ${url}`);
  console.error(`   Status:  ${status}`);

  // Dump ALL response headers — this is key for rate-limit debugging
  const relevantHeaders = [
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'retry-after',
  ];
  console.error(`   ── Rate-limit headers ──`);
  for (const h of relevantHeaders) {
    console.error(`   ${h}: ${headers[h] || '(not sent by Figma)'}`);
  }
  // Dump any other x-ratelimit-* headers Figma may use
  for (const [key, val] of Object.entries(headers)) {
    if (key.startsWith('x-ratelimit-') && !relevantHeaders.includes(key)) {
      console.error(`   ${key}: ${val}`);
    }
  }

  console.error(`   ── Response body ──`);
  console.error(`   ${JSON.stringify(body)}`);

  console.error(`   ── Possible causes ──`);
  console.error(`   1. Your Figma token is on a Free / Starter plan (≈60 req/min)`);
  console.error(`   2. Multiple services/instances share the same FIGMA_ACCESS_TOKEN`);
  console.error(`   3. Daily API quota may be exhausted on your Figma plan`);
  console.error(`   4. Another service is calling Figma with the same token between our retries`);
  console.error(`   ───────────────────────────────\n`);
}

/**
 * Wraps an axios GET call with:
 *  - In-memory caching (5 min TTL) — avoids hitting Figma for repeated requests.
 *  - Exponential backoff on 429 / 5xx with detailed diagnostics.
 *
 * Retry strategy:
 *  1st retry — wait  8s   (long cool-down so any competing consumers settle)
 *  2nd retry — wait 15s
 *  3rd retry — wait 30s
 *  4th retry — wait 60s   (full minute window)
 *  5th+     — wait 60s each (keep trying once per minute)
 *
 * On every 429 we log ALL response headers so you can see
 * whether Figma sent rate-limit metadata (it often doesn't on 429).
 *
 * @param {string}  url
 * @param {object}  [config]
 * @param {number}  [maxRetries]
 */
async function axiosGetWithRetry(url, config = {}, maxRetries = MAX_RETRIES) {
  // ── Check cache first ──────────────────────────────────
  const cacheKey = `${config.method || 'GET'}|${url}|${JSON.stringify(config.params || {})}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`📦 Cache HIT for ${url}`);
    return cached;
  }

  // ── Retry loop ─────────────────────────────────────────
  // Retry delays: 8s, 15s, 30s, then 60s for each subsequent attempt
  const RETRY_DELAYS = [8_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, config);
      // Track remaining quota and proactively pause if nearly empty
      await trackFigmaRateLimit(response);
      // Cache the successful response
      setCache(cacheKey, response);
      return response;
    } catch (err) {
      const status = err.response?.status;

      // Only retry on 429 (rate limit) and 5xx (server) errors
      if (status !== 429 && (status < 500 || status >= 600)) {
        throw err;
      }

      // ── Log detailed diagnostics on every 429 ──────────
      if (status === 429) {
        logFigmaErrorDiagnostics(err, url);
      }

      if (attempt === maxRetries) {
        console.error(
          `❌ Rate-limit retries exhausted after ${maxRetries} attempts for ${url}\n` +
          `   💡 Action needed: See diagnostics above.  Most likely your Figma token is\n` +
          `      shared by multiple services or is on a Free plan with very low limits.`
        );
        throw err;
      }

      // Pick delay for this attempt (last delay repeats for extra retries)
      const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
      const jitter = Math.round(Math.random() * 1000) - 500;
      const finalDelay = delay + jitter;

      console.warn(
        `⏳ Retry ${attempt + 1}/${maxRetries} in ${(finalDelay / 1000).toFixed(1)}s...`
      );

      await sleep(finalDelay);
    }
  }
}

// ─────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ Figma → Content Hub Middleware is running',
    endpoints: {
      import: 'POST /api/figma/import',
      health: 'GET  /api/figma/health',
    }
  });
});

// ─────────────────────────────────────────────
// Get Content Hub Token
// ─────────────────────────────────────────────
async function getContentHubToken(contentHubBaseUrl) {
  try {
    console.log('🔐 Authenticating with Content Hub...');
    const response = await axios.post(
      `${contentHubBaseUrl}/api/authenticate`,
      {
        user_name: CONTENT_HUB_USERNAME,
        password: CONTENT_HUB_PASSWORD,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const token = response.data.token || response.data.access_token;
    if (!token) {
      console.error('❌ Token extraction failed:', JSON.stringify(response.data));
      return null;
    }

    console.log('✅ Content Hub token obtained');
    return token;
  } catch (err) {
    console.error('❌ Content Hub auth failed:', err.response?.status, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Fetch Figma file + export images
// ─────────────────────────────────────────────
async function getFigmaExports(fileId, nodeId = null) {
  try {
    console.log(`🎨 Fetching Figma file: ${fileId}`);
    
    const fileResponse = await axiosGetWithRetry(
      `${FIGMA_API_URL}/files/${fileId}`,
      {
        headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN }
      }
    );

    const { name: fileName, lastModified, document } = fileResponse.data;
    console.log('✅ File fetched:', fileName);
    
    let nodesToExport = [];

    if (nodeId) {
      // If specific node ID provided, use it
      nodesToExport = [nodeId];
      console.log('✅ Using specific node ID:', nodeId);
    } else {
      // Strategy 1: Look for FRAME, COMPONENT, BOARD at top level
      nodesToExport = document.children
        .filter(n => ['FRAME', 'COMPONENT', 'BOARD', 'SECTION'].includes(n.type))
        .map(n => n.id);

      console.log('✅ Top-level exportable nodes found:', nodesToExport.length);

      // Strategy 2: If no frames, look inside CANVAS/SECTION/GROUP nodes
      if (nodesToExport.length === 0) {
        console.log('⚠️ No top-level frames found, looking inside CANVAS/SECTION nodes...');
        
        document.children.forEach(parent => {
          console.log(`  📂 Checking "${parent.name}" (type: ${parent.type})`);
          
          if (parent.children && Array.isArray(parent.children)) {
            console.log(`    - Has ${parent.children.length} children`);
            
            // Get all children from CANVAS/SECTION, not just frames
            const childNodes = parent.children
              .filter(n => {
                // Export frames, components, groups, boards - basically anything visual
                const exportableTypes = ['FRAME', 'COMPONENT', 'GROUP', 'BOARD', 'RECTANGLE', 'TEXT', 'IMAGE'];
                return exportableTypes.includes(n.type);
              })
              .map(n => {
                console.log(`      ✓ Found "${n.name}" (${n.type})`);
                return n.id;
              });
            
            nodesToExport.push(...childNodes);
          }
        });
      }

      // Strategy 3: Last resort - export all top-level nodes
      if (nodesToExport.length === 0) {
        console.log('⚠️ No exportable children found, exporting all top-level nodes...');
        nodesToExport = document.children.map(n => n.id);
      }
    }

    console.log('✅ Total nodes to export:', nodesToExport.length);

    if (nodesToExport.length === 0) {
      console.warn('⚠️ No nodes found to export');
      return { fileName, lastModified, exports: {} };
    }

    // Get export URLs
    console.log('📤 Requesting exports for nodes:', nodesToExport);
    const exportResponse = await axiosGetWithRetry(
      `${FIGMA_API_URL}/files/${fileId}/images`,
      {
        params: {
          ids: nodesToExport.join(','),
          format: 'png',
          scale: 2,
        },
        headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN }
      }
    );

   console.log('✅ Export response received');
    
    // IMPORTANT: Figma API returns images under .meta.images, not directly under .images
    const images = exportResponse.data.meta?.images || exportResponse.data.images;
    
    console.log('📊 Images in response:', images ? Object.keys(images).length : 'undefined');
    
    if (!images || Object.keys(images).length === 0) {
      console.error('❌ No images in Figma response:', JSON.stringify(exportResponse.data, null, 2));
      return { fileName, lastModified, exports: {} };
    }

    return {
      fileName,
      lastModified,
      exports: images,  // ← Changed from exportResponse.data.images
    };

  } catch (err) {
    console.error('❌ Figma fetch failed:', err.response?.status, err.message);
    if (err.response?.data) {
      console.error('   Response:', JSON.stringify(err.response.data, null, 2));
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// Upload image buffer to Content Hub
// ─────────────────────────────────────────────
async function uploadToContentHub(
  imageBuffer,
  fileName,
  contentHubBaseUrl,
  token
) {
  try {
    console.log(`📤 Uploading: ${fileName}`);

    // STEP 1 — Request Upload URL
    const createUploadResponse = await axios.post(
      `${contentHubBaseUrl}/api/v2.0/upload`,
      {
        file_name: fileName,
        file_size: imageBuffer.length,
        upload_configuration: {
          name: "AssetUploadConfiguration"
        },
        action: {
          name: "NewAsset"
        }
      },
      {
        headers: {
          'X-Auth-Token': token,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Upload session created");

    const uploadUrl =
      createUploadResponse.headers.location;

    if (!uploadUrl) {
      throw new Error("No upload URL returned");
    }

    // STEP 2 — Upload File
    const FormData = require("form-data");

    const formData = new FormData();

    formData.append("file", imageBuffer, fileName);

    await axios.post(
      `${contentHubBaseUrl}${uploadUrl}`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity
      }
    );

    console.log("✅ Binary uploaded");

    // STEP 3 — Finalize Upload
    const finalizeResponse = await axios.post(
      `${contentHubBaseUrl}/api/v2.0/upload/finalize`,
      createUploadResponse.data,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Upload finalized");

    return finalizeResponse.data.asset_id;

  } catch (err) {
    console.error(
      "❌ Upload failed:",
      err.response?.status,
      err.response?.data || err.message
    );

    console.error("URL:", err.config?.url);

    throw err;
  }
}

// ─────────────────────────────────────────────
// GET — test connection
// ─────────────────────────────────────────────
app.get('/api/figma/import', (req, res) => {
  res.json({ status: '✅ Figma import endpoint is ready. Use POST to import.' });
});

// ─────────────────────────────────────────────
// MAIN ROUTE: Import Figma file to Content Hub
// POST /api/figma/import
// ─────────────────────────────────────────────
app.post('/api/figma/import', async (req, res) => {
  console.log('📥 Incoming Figma import request');
  console.log('Body:', JSON.stringify(req.body));

  // Security check
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!FIGMA_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'FIGMA_ACCESS_TOKEN not configured' });
  }

  const { figmaFileId, figmaNodeId } = req.body;

  if (!figmaFileId) {
    return res.status(400).json({ 
      error: 'figmaFileId required in body',
      hint: 'Send { "figmaFileId": "your-file-id" } in request body'
    });
  }

  console.log('✅ File ID:', figmaFileId);
  console.log('✅ Node ID:', figmaNodeId || '(all frames)');

  try {
    // Step 1: Get Figma exports
    const figmaData = await getFigmaExports(figmaFileId, figmaNodeId);

    if (Object.keys(figmaData.exports).length === 0) {
      return res.status(400).json({
        error: 'No exportable frames or components found in Figma file',
        hint: 'Ensure your Figma file has FRAME or COMPONENT elements at the top level'
      });
    }

    // Step 2: Authenticate with Content Hub
    const chToken = await getContentHubToken(CONTENT_HUB_URL);
    if (!chToken) {
      return res.status(500).json({ error: 'Content Hub authentication failed' });
    }

    // Step 3: For each exported image, download + upload to CH
    const uploadedAssets = [];
    const failedAssets = [];

    for (const [nodeId, exportUrl] of Object.entries(figmaData.exports)) {
      try {
        console.log(`📥 Downloading Figma export: ${exportUrl}`);

        const imageResponse = await axios.get(exportUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });

        const imageBuffer = Buffer.from(imageResponse.data);
        const fileName = `${figmaData.fileName}_${nodeId}.png`;

        const assetId = await uploadToContentHub(
          imageBuffer,
          fileName,
          CONTENT_HUB_URL,
          chToken
        );

        uploadedAssets.push({ nodeId, assetId, fileName });
        console.log(`✅ Successfully uploaded: ${fileName}`);

      } catch (err) {
        console.error(`⚠️ Failed to upload ${nodeId}:`, err.message);
        failedAssets.push({ nodeId, error: err.message });
      }
    }

    res.json({
      success: true,
      fileName: figmaData.fileName,
      uploadedCount: uploadedAssets.length,
      failedCount: failedAssets.length,
      assets: uploadedAssets,
      failed: failedAssets.length > 0 ? failedAssets : undefined,
      message: `Successfully imported ${uploadedAssets.length} assets from Figma${failedAssets.length > 0 ? ` (${failedAssets.length} failed)` : ''}`,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    const status = err.response?.status;
    console.error('❌ Figma import failed:', err.message);

    if (status === 429) {
      return res.status(429).json({
        error: 'Figma API rate limit exceeded',
        details: [
          'Your Figma access token has been rate-limited. This typically means:',
          '  1. The token is on a Free/Starter plan (~60 requests/minute)',
          '  2. Multiple services/instances are sharing the same FIGMA_ACCESS_TOKEN',
          '  3. A daily API quota has been reached',
          '',
          'Solutions:',
          '  • Create a dedicated Figma token used ONLY by this service',
          '  • Add a delay between import requests (at least 2-3 seconds)',
          '  • Upgrade your Figma plan for higher rate limits',
          '  • Check if another service is consuming the same token\'s quota',
        ].join('\n'),
      });
    }

    res.status(status || 500).json({
      error: 'Failed to import from Figma',
      details: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/api/figma/health', (req, res) => {
  console.log('✅ Figma health check');
  res.json({
    status: '✅ healthy',
    service: 'Figma → Content Hub Middleware',
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

export default app;