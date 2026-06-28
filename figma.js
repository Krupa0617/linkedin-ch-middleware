import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const {
  FIGMA_ACCESS_TOKEN,
  CONTENT_HUB_URL,
  CONTENT_HUB_USERNAME,
  CONTENT_HUB_PASSWORD,
  API_SECRET_KEY,
} = process.env;

const FIGMA_API_URL = 'https://api.figma.com/v1';

// ─────────────────────────────────────────────
// Get Content Hub Token (reuse from Instagram code)
// ─────────────────────────────────────────────
async function getContentHubToken(contentHubBaseUrl) {
  const response = await axios.post(
    `${contentHubBaseUrl}/api/authenticate`,
    {
      user_name: CONTENT_HUB_USERNAME,
      password: CONTENT_HUB_PASSWORD,
    }
  );
  return response.data.token;
}

// ─────────────────────────────────────────────
// Fetch Figma file + export images
// ─────────────────────────────────────────────
async function getFigmaExports(fileId, nodeId = null) {
  try {
    console.log(`🎨 Fetching Figma file: ${fileId}`);
    
    // Get file metadata
    const fileResponse = await axios.get(
      `${FIGMA_API_URL}/files/${fileId}`,
      {
        headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN }
      }
    );

    const { name: fileName, lastModified, document } = fileResponse.data;
    console.log('✅ File fetched:', fileName);

    // Export nodes (all or specific node)
    // Default: export all top-level frames/components
    const nodesToExport = nodeId 
      ? [nodeId] 
      : document.children
          .filter(n => n.type === 'FRAME' || n.type === 'COMPONENT')
          .map(n => n.id);

    console.log('✅ Nodes to export:', nodesToExport.length);

    // Get export URLs
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
      exports: exportResponse.data.images, // { nodeId: url, ... }
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

    // Step 1: Create asset entity
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

    // Step 2: Upload binary file
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
// MAIN ROUTE: Import Figma file to Content Hub
// POST /api/figma/import
// ─────────────────────────────────────────────
app.post('/api/figma/import', async (req, res) => {
  console.log('📥 Incoming Figma import request');

  // Security
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { figmaFileId, figmaNodeId } = req.body;

  if (!figmaFileId) {
    return res.status(400).json({ error: 'figmaFileId required in body' });
  }

  try {
    // Step 1: Get Figma exports
    const figmaData = await getFigmaExports(figmaFileId, figmaNodeId);

    // Step 2: Authenticate with Content Hub
    const chToken = await getContentHubToken(CONTENT_HUB_URL);

    // Step 3: For each exported image, download + upload to CH
    const uploadedAssets = [];

    for (const [nodeId, exportUrl] of Object.entries(figmaData.exports)) {
      try {
        console.log(`📥 Downloading Figma export: ${exportUrl}`);

        // Download image from Figma's temporary URL (valid for 2 hours)
        const imageResponse = await axios.get(exportUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });

        const imageBuffer = Buffer.from(imageResponse.data);
        const fileName = `${figmaData.fileName}_${nodeId}.png`;

        // Upload to Content Hub
        const assetId = await uploadToContentHub(
          imageBuffer,
          fileName,
          CONTENT_HUB_URL,
          chToken
        );

        uploadedAssets.push({ nodeId, assetId, fileName });

      } catch (err) {
        console.error(`⚠️ Failed to upload ${nodeId}:`, err.message);
      }
    }

    res.json({
      success: true,
      fileName: figmaData.fileName,
      uploadedCount: uploadedAssets.length,
      assets: uploadedAssets,
      message: `Successfully imported ${uploadedAssets.length} assets from Figma`,
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

// Health check
app.get('/api/figma/health', (req, res) => {
  res.json({ status: '✅ healthy', service: 'Figma → Content Hub Middleware' });
});

export default app;