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
    console.log('🔐 Authenticating with Content Hub...');
    const response = await axios.post(
      `${contentHubBaseUrl}/api/authenticate`,
      {
        user_name: CONTENT_HUB_USERNAME,
        password: CONTENT_HUB_PASSWORD
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const token = response.data.token
      || response.data.access_token
      || response.data;

    if (typeof token !== 'string' || token.trim().length === 0) {
      console.error('❌ Token extraction failed:', JSON.stringify(response.data));
      return null;
    }

    console.log('✅ Content Hub token obtained, length:', token.length);
    return token;

  } catch (err) {
    console.error('❌ Content Hub auth failed:', err.response?.status, err.message);
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
  const response = await axios.get(
    `${contentHubBaseUrl}/api/entities/${entityId}`,
    { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
  );
  console.log("Get entity", contentHubBaseUrl);
  console.log("Get entity", JSON.stringify(response.data));
  return response.data;
}

// ─────────────────────────────────────────────
// Helper: Extract definition name from entity
// Parses from entitydefinition.href like:
// https://btr-q-001.sitecorecontenthub.cloud/api/entitydefinitions/M.PCM.Product
// ─────────────────────────────────────────────
function extractDefinitionName(entity) {
  if (!entity?.entitydefinition?.href) {
    return null;
  }
  
  const href = entity.entitydefinition.href;
  const match = href.match(/\/entitydefinitions\/(.+?)($|\/)/);
  return match ? match[1] : null;
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
// FIX #1: Corrected the relation path and added error handling
// ─────────────────────────────────────────────
async function getRelatedAssets(productId, contentHubBaseUrl, token) {
  try {
    // Try the standard relation endpoint first
    // The relation path format should be verified against your Content Hub schema
    const relationPaths = [
      `${contentHubBaseUrl}/api/entities/${productId}/relations/PCMProductToMasterAsset`,
      `${contentHubBaseUrl}/api/entities/${productId}/relations/M.Asset-M.PCM.Product/parents`
    ];

    let response;
    for (const path of relationPaths) {
      try {
        response = await axios.get(
          path,
          { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
        );
        if (response.data) break;
      } catch (e) {
        console.warn(`⚠️ Relation path failed: ${path}`);
        continue;
      }
    }

    if (!response?.data) {
      console.warn('⚠️ No related assets found for product', productId);
      return [];
    }

    const assetSummaries = response.data?.items || [];
    const assets = [];

    for (const summary of assetSummaries) {
      try {
        const assetEntity = await getEntity(summary.id, contentHubBaseUrl, token);
        const { title, imageUrl } = extractAssetImage(assetEntity);
        if (imageUrl) {
          assets.push({ id: summary.id, title, imageUrl });
        }
      } catch (assetErr) {
        console.warn(`⚠️ Failed to fetch asset ${summary.id}:`, assetErr.message);
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
// FIX #2: Removed 'variants' from ProductInput - handle separately
// ─────────────────────────────────────────────
const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product { 
        id 
        title 
        handle
      }
      userErrors { 
        field 
        message 
      }
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { 
        id 
        title 
      }
      userErrors { 
        field 
        message 
      }
    }
  }
`;

const PRODUCT_CREATE_MEDIA_MUTATION = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { 
        id
        alt 
        mediaContentType 
      }
      mediaUserErrors { 
        field 
        message 
      }
    }
  }
`;

// Create or update variant separately
const VARIANT_CREATE_MUTATION = `
  mutation productVariantCreate($productId: ID!, $input: ProductVariantInput!) {
    productVariantCreate(productId: $productId, input: $input) {
      productVariant { 
        id 
        sku 
        price 
      }
      userErrors { 
        field 
        message 
      }
    }
  }
`;

const VARIANT_UPDATE_MUTATION = `
  mutation productVariantUpdate($productId: ID!, $input: ProductVariantInput!) {
    productVariantUpdate(productId: $productId, input: $input) {
      productVariant { 
        id 
        sku 
        price 
      }
      userErrors { 
        field 
        message 
      }
    }
  }
`;

// ─────────────────────────────────────────────
// Flow A: PRODUCT entity was triggered
// Creates/updates a Shopify product with all
// related asset images attached.
// FIX #2: Variants handled in separate mutation
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

  // FIX #2: Remove variants from ProductInput
  const input = {
    title,
    descriptionHtml: description,
    vendor,
    productType,
    status: 'DRAFT'
  };

  let shopifyProduct;
  try {
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

    // Handle variant separately after product creation
    const variantInput = {
      sku,
      price: String(price)
    };

    if (existingShopifyId) {
      const variantData = await shopifyGraphQL(VARIANT_UPDATE_MUTATION, {
        productId: shopifyProduct.id,
        input: variantInput
      });
      if (variantData.productVariantUpdate.userErrors.length) {
        console.warn('⚠️ Variant update warnings:', variantData.productVariantUpdate.userErrors);
      }
    } else {
      const variantData = await shopifyGraphQL(VARIANT_CREATE_MUTATION, {
        productId: shopifyProduct.id,
        input: variantInput
      });
      if (variantData.productVariantCreate.userErrors.length) {
        console.warn('⚠️ Variant creation warnings:', variantData.productVariantCreate.userErrors);
      }
    }

    // Attach related media
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
    // FIX #3: Added try-catch and better error handling
    try {
      await axios.put(
        `${contentHubBaseUrl}/api/entities/${productId}`,
        {
          properties: {
            ShopifyProductId: shopifyProduct.id,
            ShopifySyncStatus: 'Synced',
            ShopifyLastSyncedOn: new Date().toISOString()
          }
        },
        { 
          headers: { 
            'X-Auth-Token': chToken, 
            'Content-Type': 'application/json' 
          },
          timeout: 5000
        }
      );
      console.log('✅ Status written back to Content Hub');
    } catch (writeErr) {
      console.warn('⚠️ Could not write status back to Content Hub:', writeErr.message);
      // Don't throw - the sync was successful even if we can't write back
    }

    return {
      entityType: 'Product',
      shopifyProductId: shopifyProduct.id,
      title: shopifyProduct.title,
      imagesAttached: relatedAssets.length
    };
  } catch (err) {
    // Try to write error status back with better error handling
    try {
      await axios.put(
        `${contentHubBaseUrl}/api/entities/${productId}`,
        {
          properties: {
            ShopifySyncStatus: 'Failed',
            ShopifySyncError: (err.message || 'Unknown error').slice(0, 500)
          }
        },
        { 
          headers: { 
            'X-Auth-Token': chToken, 
            'Content-Type': 'application/json' 
          },
          timeout: 5000
        }
      );
    } catch (writeBackErr) {
      console.warn('⚠️ Failed to write error status:', writeBackErr.message);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// Flow B: ASSET entity was triggered
// Finds the parent product this asset belongs to
// and attaches just this one image to it.
// ─────────────────────────────────────────────
const FILE_CREATE_MUTATION = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { 
        id 
        alt 
        fileStatus 
      }
      userErrors { 
        field 
        message 
      }
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
    `${contentHubBaseUrl}/api/entities/${assetId}/relations/PCMProductToMasterAsset/parents`,
    { headers: { 'X-Auth-Token': chToken, 'Content-Type': 'application/json' } }
  ).catch((err) => {
    console.warn('⚠️ Could not find related products:', err.message);
    return { data: { items: [] } };
  });

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
  console.log('📢 Incoming publish request from Content Hub');
  console.log('Body:', JSON.stringify(req.body));

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const saveMsg = req.body.saveEntityMessage || {};
  const entityId = req.headers['target_id'] || req.body.TargetId || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  console.log('✅ Entity ID:', entityId);
  console.log('✅ Source System:', sourceSystem);

  if (!entityId) {
    return res.status(400).json({ error: 'No entity ID provided' });
  }

  try {
    const chToken = await getContentHubToken(sourceSystem);
    if (!chToken) {
      return res.status(500).json({ error: 'Content Hub auth failed' });
    }

    // Fetch entity and extract definition name from its entitydefinition.href
    const entity = await getEntity(entityId, sourceSystem, chToken);
    const definitionName = extractDefinitionName(entity);

    console.log('✅ Definition name:', definitionName);

    if (!definitionName) {
      return res.status(400).json({
        error: 'Could not extract definition name from entity'
      });
    }

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
    res.status(500).json({
      error: 'Shopify publish failed',
      details: err.response?.data || err.message
    });
  }
});

// ✅ No app.listen() - Vercel serverless handles this via wrapper,
// matching the LinkedIn middleware pattern.
export default app;