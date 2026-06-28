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
async function uploadToContentHub(imageBuffer, fileName, contentHubBaseUrl, token) {
  try {
    console.log(`📤 Uploading to Content Hub: ${fileName}`);

  const createUrl = `${contentHubBaseUrl}/api/entities`;

console.log("Create URL:", createUrl);

const entityResponse = await axios.post(
  createUrl,
  {
   entitydefinition: "M.Asset",
    properties: {
      Title: { values: [{ value: fileName, culture: 'en-US' }] },
    },
  },
  {
    headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' }
  }
);
  console.log("Entity Response");
console.log(JSON.stringify(entityResponse.data, null, 2));

  const assetId =
entityResponse.data.id ??
entityResponse.data.identifier ??
entityResponse.data.entity?.id ??
entityResponse.data.asset?.id;

console.log("Asset Id:", assetId);
    
    if (!assetId) {
      console.error('❌ No asset ID in response:', JSON.stringify(entityResponse.data));
      throw new Error('Entity creation failed - no ID returned');
    }

    console.log('✅ Entity created:', assetId);

    // Step 2: Upload binary file using FormData
    console.log('  Step 2: Uploading file...');
    
    const formData = new FormData();
    formData.append('file', imageBuffer, { filename: fileName });

    const uploadUrl =
`${contentHubBaseUrl}/api/assets/${assetId}/versions/1/renditions/original/file`;

console.log("Upload URL:", uploadUrl);

    const uploadResponse = await axios.post(
      uploadUrl,
      formData,
      {
        headers: {
          'X-Auth-Token': token,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    console.log('✅ File uploaded:', assetId);
    return assetId;

  } catch(err){

    console.error("Status:",
        err.response?.status);

    console.error("URL:",
        err.config?.url);

    console.error("Response:",
        JSON.stringify(err.response?.data,null,2));

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
        const safeNodeId =
nodeId.replace(/[:\/\\]/g,"_");

const fileName =
`${figmaData.fileName}_${safeNodeId}.png`;

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
