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
    
    const fileResponse = await axios.get(
      `${FIGMA_API_URL}/files/${fileId}`,
      {
        headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN }
      }
    );

    const { name: fileName, lastModified, document } = fileResponse.data;
    console.log('✅ File fetched:', fileName);

    const nodesToExport = nodeId 
      ? [nodeId] 
      : document.children
          .filter(n => n.type === 'FRAME' || n.type === 'COMPONENT')
          .map(n => n.id);

    console.log('✅ Nodes to export:', nodesToExport.length);

    if (nodesToExport.length === 0) {
      console.warn('⚠️ No frames/components found in file');
      return { fileName, lastModified, exports: {} };
    }

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

    return {
      fileName,
      lastModified,
      exports: exportResponse.data.images,
    };

  } catch (err) {
    console.error('❌ Figma fetch failed:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// Upload image buffer to Content Hub
// ─────────────────────────────────────────────
async function uploadToContentHub(imageBuffer, fileName, contentHubBaseUrl, token) {
  try {
    console.log(`📤 Uploading to Content Hub: ${fileName}`);

    const entityResponse = await axios.post(
      `${contentHubBaseUrl}/api/v2/entities`,
      {
        entityType: 'M.Asset',
        properties: {
          Title: { 'en-US': fileName },
          FileName: fileName,
          Source: 'Figma',
          FigmaMetadata: {
            'en-US': `Imported from Figma at ${new Date().toISOString()}`
          },
        },
      },
      {
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' }
      }
    );

    const assetId = entityResponse.data.id;
    console.log('✅ Entity created:', assetId);

    const formData = new FormData();
    formData.append('file', new Blob([imageBuffer]), fileName);

    await axios.post(
      `${contentHubBaseUrl}/api/v2/assets/${assetId}/versions/1/renditions/original/file`,
      formData,
      {
        headers: { 'X-Auth-Token': token }
      }
    );

    console.log('✅ File uploaded:', assetId);
    return assetId;

  } catch (err) {
    console.error('❌ Content Hub upload failed:', err.message);
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