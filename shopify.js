import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const {
  CONTENT_HUB_URL,
  CONTENT_HUB_USERNAME,
  CONTENT_HUB_PASSWORD,
  API_SECRET_KEY,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION
} = process.env;

const SHOPIFY_VERSION = SHOPIFY_API_VERSION || '2026-07';

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ Shopify Content Hub Middleware is running',
    endpoints: {
      publish: 'POST /shopify/publish'
    }
  });
});

app.get('/shopify/publish', (req, res) => {
  res.json({ status: '✅ Shopify publish endpoint is ready. Use POST to publish.' });
});

// ─────────────────────────────────────────────
// Helper: Authenticate with Content Hub
// (identical pattern to LinkedIn middleware)
// ─────────────────────────────────────────────
async function getContentHubToken(contentHubBaseUrl) {

  try {

    console.log("");
    console.log("========================================");
    console.log("🔐 Authenticating with Content Hub");
    console.log("URL:", `${contentHubBaseUrl}/api/authenticate`);
    console.log("User:", CONTENT_HUB_USERNAME);
    console.log("========================================");

    const response = await axios.post(
      `${contentHubBaseUrl}/api/authenticate`,
      {
        user_name: CONTENT_HUB_USERNAME,
        password: CONTENT_HUB_PASSWORD
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Authentication Status:", response.status);

    const token =
      response.data.token ||
      response.data.access_token ||
      response.data;

    console.log("Token received:", !!token);

    if (!token) {

      console.error("Authentication Response:");
      console.error(JSON.stringify(response.data, null, 2));

      return null;
    }

    console.log("Token Length:", token.length);

    return token;

  } catch (err) {

    console.error("Authentication Failed");

    console.error("Status:", err.response?.status);

    console.error(JSON.stringify(err.response?.data, null, 2));

    return null;
  }
}

// ─────────────────────────────────────────────
// Helper: Get Shopify Admin API access token
// Uses Client Credentials Grant, cached in memory,
// auto-refreshed before the ~24h expiry.
// ─────────────────────────────────────────────
let cachedShopifyToken = null;
let shopifyTokenExpiry = 0;

async function getShopifyAccessToken() {
  const now = Date.now();

  if (cachedShopifyToken && now < shopifyTokenExpiry - 60000) {
    return cachedShopifyToken;
  }

  console.log('🔐 Requesting new Shopify access token...');
  const response = await axios.post(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  cachedShopifyToken = response.data.access_token;
  shopifyTokenExpiry = now + response.data.expires_in * 1000;

  console.log('✅ Shopify token obtained, expires in', response.data.expires_in, 'seconds');
  return cachedShopifyToken;
}

// ─────────────────────────────────────────────
// Helper: Call Shopify GraphQL Admin API
// ─────────────────────────────────────────────
async function shopifyGraphQL(query, variables) {
  const token = await getShopifyAccessToken();

  const response = await axios.post(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_VERSION}/graphql.json`,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      }
    }
  );

  if (response.data.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(response.data.errors)}`);
  }

  return response.data.data;
}

// ─────────────────────────────────────────────
// Helper: Fetch a Content Hub entity (generic)
// ─────────────────────────────────────────────
async function getEntity(entityId, contentHubBaseUrl, token) {
  try {
    console.log("========================================");
    console.log("📥 Fetching Content Hub Entity");
    console.log("Entity ID:", entityId);
    console.log("URL:", `${contentHubBaseUrl}/api/entities/${entityId}`);
    console.log("========================================");

    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/${entityId}`,
      {
        headers: {
          "X-Auth-Token": token,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Entity fetched successfully");
    console.log("Status:", response.status);

    console.log("============ ENTITY RESPONSE ============");
    console.log(JSON.stringify(response.data, null, 2));
    console.log("=========================================");

    return response.data;

  } catch (err) {
    console.log("========================================");
    console.error("❌ Error fetching entity");
    console.error("Status:", err.response?.status);
    console.error("Status Text:", err.response?.statusText);

    console.error("Response:");
    console.error(JSON.stringify(err.response?.data, null, 2));

    console.error("Headers:");
    console.error(JSON.stringify(err.response?.headers, null, 2));

    console.error("Message:", err.message);
    console.log("========================================");

    throw err;
  }
}

// ─────────────────────────────────────────────
// Helper: Get image URL + title from an Asset entity
// (same rendition logic as LinkedIn middleware)
// ─────────────────────────────────────────────
function extractAssetImage(entity) {
  const props = entity?.properties || {};
  const title = props.Title || props.FileName || entity?.identifier || null;

  let imageUrl = null;
  const renditions = entity?.renditions;
  if (renditions && typeof renditions === 'object') {
    imageUrl = renditions.downloadOriginal?.[0]?.href
      || renditions.downloadOriginal?.[0]?.url
      || null;
  }

  return { title, imageUrl };
}

// ─────────────────────────────────────────────
// Helper: Get related Asset entities for a Product
// via the M.Asset <-> M.PCM.Product relation
// ─────────────────────────────────────────────
async function getRelatedAssets(productId, contentHubBaseUrl, token) {
  try {
    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/${productId}/relations/M.Asset-M.PCM.Product/parents`,
      { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
    );

    const assetSummaries = response.data?.items || [];
    const assets = [];

    for (const summary of assetSummaries) {
      const assetEntity = await getEntity(summary.id, contentHubBaseUrl, token);
      const { title, imageUrl } = extractAssetImage(assetEntity);
      if (imageUrl) {
        assets.push({ id: summary.id, title, imageUrl });
      }
    }

    return assets;
  } catch (err) {
    console.error('⚠️ Failed to fetch related assets:', err.response?.status, err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// Helper: Download image from Content Hub (auth'd)
// and re-host it so Shopify's originalSource can fetch it.
// Shopify's productCreateMedia requires a publicly
// reachable URL, so we pass through the Content Hub
// public rendition URL directly (must be unauthenticated /
// public rendition) — adjust if your instance requires signed URLs.
// ─────────────────────────────────────────────
function buildMediaInput(assets) {
  return assets.map((a) => ({
    originalSource: a.imageUrl,
    alt: a.title || 'Product image',
    mediaContentType: 'IMAGE'
  }));
}

// ─────────────────────────────────────────────
// Shopify mutations
// ─────────────────────────────────────────────
const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE_MEDIA_MUTATION = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { alt mediaContentType }
      mediaUserErrors { field message }
    }
  }
`;

// ─────────────────────────────────────────────
// Flow A: PRODUCT entity was triggered
// Creates/updates a Shopify product with all
// related asset images attached.
// ─────────────────────────────────────────────
async function handleProductPush(productId, contentHubBaseUrl, chToken) {
  const productEntity = await getEntity(productId, contentHubBaseUrl, chToken);
  const props = productEntity?.properties || {};

  const title = props.ProductName || props.Title || productEntity?.identifier || 'Untitled Product';
  const description = props.Description || '';
  const vendor = props.Brand || 'Himalaya Wellness';
  const productType = props.Category || '';
  const sku = productEntity?.identifier || productId;
  const price = props.Price || '0.00';
  const existingShopifyId = props.ShopifyProductId || null;

  const relatedAssets = await getRelatedAssets(productId, contentHubBaseUrl, chToken);

  const input = {
    title,
    descriptionHtml: description,
    vendor,
    productType,
    status: 'DRAFT',
    variants: [{ sku, price: String(price) }]
  };

  let shopifyProduct;
  if (existingShopifyId) {
    const data = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, {
      input: { id: existingShopifyId, ...input }
    });
    if (data.productUpdate.userErrors.length) {
      throw new Error(JSON.stringify(data.productUpdate.userErrors));
    }
    shopifyProduct = data.productUpdate.product;
  } else {
    const data = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { input });
    if (data.productCreate.userErrors.length) {
      throw new Error(JSON.stringify(data.productCreate.userErrors));
    }
    shopifyProduct = data.productCreate.product;
  }

  if (relatedAssets.length > 0) {
    const mediaInput = buildMediaInput(relatedAssets);
    const mediaData = await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
      productId: shopifyProduct.id,
      media: mediaInput
    });
    if (mediaData.productCreateMedia.mediaUserErrors.length) {
      console.warn('⚠️ Media upload warnings:', mediaData.productCreateMedia.mediaUserErrors);
    }
  }

  // Write sync status back to Content Hub
  await axios.put(
    `${contentHubBaseUrl}/api/entities/${productId}`,
    {
      properties: {
        ShopifyProductId: shopifyProduct.id,
        ShopifySyncStatus: 'Synced',
        ShopifyLastSyncedOn: new Date().toISOString()
      }
    },
    { headers: { 'X-Auth-Token': chToken, 'Content-Type': 'application/json' } }
  );

  return {
    entityType: 'Product',
    shopifyProductId: shopifyProduct.id,
    title: shopifyProduct.title,
    imagesAttached: relatedAssets.length
  };
}

// ─────────────────────────────────────────────
// Flow B: ASSET entity was triggered
// Finds the parent product this asset belongs to
// and attaches just this one image to it.
// If the asset has no linked product, it's uploaded
// to Shopify Files instead (standalone).
// ─────────────────────────────────────────────
const FILE_CREATE_MUTATION = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id alt fileStatus }
      userErrors { field message }
    }
  }
`;

async function handleAssetPush(assetId, contentHubBaseUrl, chToken) {
  const assetEntity = await getEntity(assetId, contentHubBaseUrl, chToken);
  const { title, imageUrl } = extractAssetImage(assetEntity);

  if (!imageUrl) {
    throw new Error('Asset has no usable image rendition');
  }

  // Find parent product via the same relation, reversed
  const relResponse = await axios.get(
    `${contentHubBaseUrl}/api/entities/${assetId}/relations/M.Asset-M.PCM.Product/children`,
    { headers: { 'X-Auth-Token': chToken, 'Content-Type': 'application/json' } }
  ).catch(() => ({ data: { items: [] } }));

  const linkedProducts = relResponse.data?.items || [];

  if (linkedProducts.length > 0) {
    // Attach to the first linked product's Shopify record
    const productId = linkedProducts[0].id;
    const productEntity = await getEntity(productId, contentHubBaseUrl, chToken);
    const shopifyProductId = productEntity?.properties?.ShopifyProductId;

    if (!shopifyProductId) {
      throw new Error(`Linked product ${productId} has not been synced to Shopify yet — push the product first`);
    }

    const mediaData = await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
      productId: shopifyProductId,
      media: buildMediaInput([{ title, imageUrl }])
    });

    if (mediaData.productCreateMedia.mediaUserErrors.length) {
      throw new Error(JSON.stringify(mediaData.productCreateMedia.mediaUserErrors));
    }

    return {
      entityType: 'Asset',
      attachedToProductId: shopifyProductId,
      title
    };
  }

  // No linked product — upload as a standalone Shopify File
  const fileData = await shopifyGraphQL(FILE_CREATE_MUTATION, {
    files: [{ originalSource: imageUrl, alt: title, contentType: 'IMAGE' }]
  });

  if (fileData.fileCreate.userErrors.length) {
    throw new Error(JSON.stringify(fileData.fileCreate.userErrors));
  }

  return {
    entityType: 'Asset',
    shopifyFileId: fileData.fileCreate.files[0]?.id,
    title,
    note: 'Uploaded as standalone Shopify file — no linked product found'
  };
}

// ─────────────────────────────────────────────
// Main route — Content Hub trigger hits this
// for BOTH Product and Asset actions.
// Auto-detects entity type from the Content Hub
// entity's DefinitionName.
// ─────────────────────────────────────────────
app.post('/shopify/publish', async (req, res) => {

  console.log("");
  console.log("========================================");
  console.log("🚀 NEW SHOPIFY PUBLISH REQUEST");
  console.log("========================================");

  console.log("Headers:");
  console.log(JSON.stringify(req.headers, null, 2));

  console.log("");

  console.log("Body:");
  console.log(JSON.stringify(req.body, null, 2));

  console.log("");

  const apiKey = req.headers["x-api-key"];

  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error("❌ Invalid API Key");
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  const entityId =
      req.body.TargetId ||
      req.body.targetId ||
      req.body.saveEntityMessage?.TargetId ||
      req.headers["target_id"];

  const sourceSystem =
      req.headers["source_system"] ||
      CONTENT_HUB_URL;

  console.log("Entity ID:", entityId);
  console.log("Source System:", sourceSystem);

  if (!entityId) {
    console.error("❌ Entity ID not found");
    return res.status(400).json({
      error: "Entity ID not found"
    });
  }

  try {

    const chToken = await getContentHubToken(sourceSystem);

    if (!chToken) {
      return res.status(500).json({
        error: "Unable to authenticate with Content Hub"
      });
    }

    console.log("");
    console.log("Token Length:", chToken.length);

    const entity = await getEntity(
      entityId,
      sourceSystem,
      chToken
    );

    console.log("");
    console.log("========== ENTITY INSPECTION ==========");

    console.log("definitionName:", entity?.definitionName);

    console.log("DefinitionName:", entity?.DefinitionName);

    console.log("definition:", JSON.stringify(entity?.definition, null, 2));

    console.log("Definition:", JSON.stringify(entity?.Definition, null, 2));

    console.log("systemProperties:", JSON.stringify(entity?.systemProperties, null, 2));

    console.log("properties:", JSON.stringify(entity?.properties, null, 2));

    console.log("=======================================");

    const definitionName =
      entity?.definitionName ||
      entity?.DefinitionName ||
      entity?.definition?.name ||
      entity?.Definition?.Name ||
      entity?.systemProperties?.definitionName ||
      entity?.systemProperties?.DefinitionName;

    console.log("");
    console.log("✅ Final Definition Name:", definitionName);

    let result;

    if (definitionName === "M.PCM.Product") {

      console.log("➡️ Product detected");

      result = await handleProductPush(
        entityId,
        sourceSystem,
        chToken
      );

    } else if (definitionName === "M.Asset") {

      console.log("➡️ Asset detected");

      result = await handleAssetPush(
        entityId,
        sourceSystem,
        chToken
      );

    } else {

      console.error("❌ Unsupported entity type");

      return res.status(400).json({
        error: "Unsupported entity",
        definitionName,
        entity
      });

    }

    console.log("");
    console.log("========== SUCCESS ==========");
    console.log(JSON.stringify(result, null, 2));

    return res.json({
      success: true,
      result
    });

  } catch (err) {

    console.log("");
    console.log("=========== ERROR ===========");

    console.error("Message:", err.message);

    if (err.response) {
      console.error("Status:", err.response.status);

      console.error("Status Text:", err.response.statusText);

      console.error("Headers:");
      console.error(JSON.stringify(err.response.headers, null, 2));

      console.error("Response:");
      console.error(JSON.stringify(err.response.data, null, 2));
    }

    console.error(err.stack);

    console.log("=============================");

    return res.status(500).json({
      success: false,
      error: err.message,
      details: err.response?.data
    });

  }

});

  try {
    const chToken = await getContentHubToken(sourceSystem);
    if (!chToken) {
      return res.status(500).json({ error: 'Content Hub auth failed' });
    }

    // Determine entity type by fetching it and reading DefinitionName
    const entity = await getEntity(entityId, sourceSystem, chToken);
    const definitionName = entity?.definitionName || entity?.DefinitionName;

    console.log('✅ Definition name:', definitionName);

    let result;
    if (definitionName === 'M.PCM.Product') {
      result = await handleProductPush(entityId, sourceSystem, chToken);
    } else if (definitionName === 'M.Asset') {
      result = await handleAssetPush(entityId, sourceSystem, chToken);
    } else {
      return res.status(400).json({
        error: `Unsupported entity type: ${definitionName}. Expected M.PCM.Product or M.Asset.`
      });
    }

    console.log('✅ Shopify push complete:', result);
    res.json({ success: true, ...result });

  } catch (err) {
    console.error('❌ Shopify publish failed:', err.response?.data || err.message);

    // Best-effort: write failure status back to Content Hub
    try {
      const chToken = await getContentHubToken(sourceSystem);
      if (chToken) {
        await axios.put(
          `${sourceSystem}/api/entities/${entityId}`,
          {
            properties: {
              ShopifySyncStatus: 'Failed',
              ShopifySyncError: (err.message || 'Unknown error').slice(0, 500)
            }
          },
          { headers: { 'X-Auth-Token': chToken, 'Content-Type': 'application/json' } }
        );
      }
    } catch (writeBackErr) {
      console.error('❌ Failed to write back error status:', writeBackErr.message);
    }

    res.status(500).json({
      error: 'Shopify publish failed',
      details: err.response?.data || err.message
    });
  }


// ✅ No app.listen() - Vercel serverless handles this via wrapper,
// matching the LinkedIn middleware pattern.
export default app;