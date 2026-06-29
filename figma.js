import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import FormData from "form-data";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const {
  FIGMA_ACCESS_TOKEN,
  CONTENT_HUB_URL,
  API_SECRET_KEY,
} = process.env;

const FIGMA_API_URL = 'https://api.figma.com/v1';

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
        user_name: "dipak.b@biztechnosys.com",
        password: "Dipak@123",
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

    const fileResponse = await axios.get(
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

            const childNodes = parent.children
              .filter(n => {
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
    const exportResponse = await axios.get(
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
      exports: images,
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
// Uses the upload-session flow (v2.0/upload) which
// is the proven working approach for this CH instance.
// ─────────────────────────────────────────────
async function uploadToContentHub(imageBuffer, fileName, contentHubBaseUrl, token) {
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

    const uploadUrl = createUploadResponse.headers.location;
    if (!uploadUrl) {
      throw new Error("No upload URL returned");
    }

    // STEP 2 — Upload File
    const formData = new FormData();
    formData.append("file", imageBuffer, fileName);

    // The location header may be absolute or relative depending on the CH version
    const binaryUploadUrl = uploadUrl.startsWith('http')
      ? uploadUrl
      : `${contentHubBaseUrl}${uploadUrl}`;

    await axios.post(
      binaryUploadUrl,
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
          'X-Auth-Token': token,
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
// Extract file ID (and optional node ID) from a Figma URL
//
// Handles formats like:
//   https://www.figma.com/design/{fileId}/{slug}
//   https://www.figma.com/file/{fileId}/{slug}?node-id=1-2
//   https://www.figma.com/proto/{fileId}/{slug}?node-id=1%3A2
// ─────────────────────────────────────────────
function parseFigmaUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const typeIndex = segments.findIndex(s => ['design', 'file', 'proto'].includes(s));
    if (typeIndex === -1 || typeIndex + 1 >= segments.length) {
      return null;
    }
    const fileId = segments[typeIndex + 1];
    if (!fileId || fileId.length < 10) return null;

    const nodeId = parsed.searchParams.get('node-id') || null;

    return { fileId, nodeId };
  } catch {
    return null;
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

  // ─────────────────────────────────────────────
  // Content Hub triggers wrap "Values" inside a
  // `context` object alongside `saveEntityMessage`.
  // Fall back to context if top-level fields are absent.
  // ─────────────────────────────────────────────
  let { figmaFileId, figmaNodeId, figmaUrl } = req.body;

  if (!figmaUrl)    figmaUrl    = req.body.context?.figmaUrl;
  if (!figmaFileId) figmaFileId = req.body.context?.figmaFileId;
  if (!figmaNodeId) figmaNodeId = req.body.context?.figmaNodeId;

  console.log('🔍 Resolved figmaUrl:', figmaUrl || '(none)');
  console.log('🔍 Resolved figmaFileId:', figmaFileId || '(none)');

  // Accept either a raw file ID or a full Figma URL
  if (!figmaFileId && figmaUrl) {
    const parsed = parseFigmaUrl(figmaUrl);
    if (!parsed) {
      return res.status(400).json({
        error: 'Invalid Figma URL',
        hint: 'Provide a valid Figma URL like https://www.figma.com/design/{fileId}/{slug}'
      });
    }
    figmaFileId = parsed.fileId;
    if (parsed.nodeId && !figmaNodeId) {
      figmaNodeId = parsed.nodeId;
    }
    console.log('🔗 Parsed Figma URL → fileId:', figmaFileId, 'nodeId:', figmaNodeId || '(none)');
  }

  if (!figmaFileId) {
    return res.status(400).json({
      error: 'figmaFileId or figmaUrl required in body',
      hint: 'Send { "figmaFileId": "your-file-id" } or { "figmaUrl": "https://www.figma.com/design/..." }'
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
        const fileName = `${figmaData.fileName}.png`;

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
    console.error('❌ Figma import failed:', err.message);
    res.status(500).json({
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
