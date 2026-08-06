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
// Webhook Deduplication - Prevent duplicate webhook processing
// (Catches near-simultaneous/rapid duplicate calls for the SAME entityId)
// ─────────────────────────────────────────────
const webhookCache = new Map();
const WEBHOOK_DEDUP_TTL = 5000; // 5 seconds

function isWebhookProcessing(entityId) {
  const key = `webhook-${entityId}`;

  if (webhookCache.has(key)) {
    const cached = webhookCache.get(key);
    const age = Date.now() - cached.timestamp;

    if (age < WEBHOOK_DEDUP_TTL) {
      console.warn(`⚠️  Webhook for entity ${entityId} already processing (${age}ms ago)`);
      return true;
    }
  }

  // Mark as processing
  webhookCache.set(key, { timestamp: Date.now(), processed: false });
  return false;
}

function markWebhookProcessed(entityId) {
  const key = `webhook-${entityId}`;
  if (webhookCache.has(key)) {
    webhookCache.get(key).processed = true;
  }
}

// Clean up old cache entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of webhookCache.entries()) {
    if (now - value.timestamp > WEBHOOK_DEDUP_TTL * 2) {
      webhookCache.delete(key);
    }
  }
}, 60000);

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ Shopify Content Hub Middleware is running',
    endpoints: { publish: 'POST /shopify/publish' }
  });
});

app.get('/shopify/publish', (req, res) => {
  res.json({ status: '✅ Shopify publish endpoint is ready. Use POST to publish.' });
});

// ─────────────────────────────────────────────
// Helper: Authenticate with Content Hub
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

    const token = response.data.token || response.data.access_token || response.data;
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
// Helper: Call Shopify REST API
// ─────────────────────────────────────────────
async function shopifyREST(method, path, data = null) {
  const token = await getShopifyAccessToken();

  const config = {
    method,
    url: `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_VERSION}${path}`,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    }
  };

  if (data) config.data = data;

  const response = await axios(config);
  return response.data;
}

// ─────────────────────────────────────────────
// Helper: Fetch a Content Hub entity
// ─────────────────────────────────────────────
async function getEntity(entityId, contentHubBaseUrl, token) {
  const response = await axios.get(
    `${contentHubBaseUrl}/api/entities/${entityId}`,
    { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

// ─────────────────────────────────────────────
// Helper: Extract definition name from entity
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
// Helper: Get image URL + title from an Asset
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
// FIX: Search Shopify for existing product by SKU
//
// Previously this used REST `/products.json?status=any&limit=250`
// and scanned the first page of products client-side. That has two
// problems that both cause duplicate products on re-trigger:
//   1. It only ever looks at the first 250 products (no pagination),
//      so once the store has more than that, or the matching product
//      isn't on the first page (sort order), the search misses it.
//   2. It's an unindexed, expensive client-side scan.
//
// Fix: use Shopify's GraphQL search index directly via
// `productVariants(query: "sku:...")`, which does an exact,
// indexed lookup regardless of how many products/variants exist,
// so re-triggering the same Content Hub entity reliably finds the
// product created last time and updates it instead of creating a
// new one.
// ─────────────────────────────────────────────
const PRODUCT_BY_SKU_QUERY = `
  query findProductBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          id
          sku
          product {
            id
            title
          }
        }
      }
    }
  }
`;

async function findShopifyProductBySku(sku) {
  try {
    console.log(`🔍 Searching Shopify for product with SKU: "${sku}"`);

    // Escape double quotes so the search query string stays valid
    const escapedSku = String(sku).replace(/"/g, '\\"');
    const data = await shopifyGraphQL(PRODUCT_BY_SKU_QUERY, {
      query: `sku:"${escapedSku}"`
    });

    const edge = data?.productVariants?.edges?.[0];
    if (!edge) {
      console.log(`⚠️ No existing product found for SKU: "${sku}"`);
      return null;
    }

    const productGid = edge.node.product.id;
    const productRestId = productGid.split('/').pop();

    console.log(`✅ Found existing product: ${productRestId} (${edge.node.product.title})`);
    return { id: productRestId, gid: productGid, title: edge.node.product.title };
  } catch (err) {
    console.warn('⚠️ Search failed:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Fetch related assets using Content Hub Query API
// ─────────────────────────────────────────────
async function getRelatedAssets(productId, contentHubBaseUrl, token) {
  try {
    console.log(`📸 Fetching related assets for product ${productId}`);

    const query = `Definition.Name=='M.Asset' AND Parent('PCMProductToAsset').id==${productId}`;

    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/query`,
      {
        params: { query },
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    const assetEntities = response.data?.items || [];
    console.log(`   ✅ Query returned ${assetEntities.length} assets`);

    const imageAssets = [];
    for (let i = 0; i < assetEntities.length; i++) {
      try {
        const asset = assetEntities[i];
        const { title, imageUrl } = extractAssetImage(asset);

        if (imageUrl) {
          imageAssets.push({ id: asset.id, title, imageUrl });
        }
      } catch (err) {
        console.warn(`⚠️ Asset #${i}: Error processing -`, err.message.slice(0, 80));
      }
    }

    console.log(`✅ Retrieved ${imageAssets.length} asset image(s)`);
    return imageAssets;
  } catch (err) {
    console.error('❌ Asset query error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// Helper: Build Shopify media input
// ─────────────────────────────────────────────
function buildMediaInput(assets) {
  return assets.map((a) => ({
    originalSource: a.imageUrl,
    alt: a.title || 'Product image',
    mediaContentType: 'IMAGE'
  }));
}

// ─────────────────────────────────────────────
// Shopify Mutations
// ─────────────────────────────────────────────
const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
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

// ─────────────────────────────────────────────
// Handle product creation/update
// ─────────────────────────────────────────────
async function handleProductPush(productId, contentHubBaseUrl, chToken) {
  const productEntity = await getEntity(productId, contentHubBaseUrl, chToken);
  const props = productEntity?.properties || {};

  const title = props.ProductName || props.Title || productEntity?.identifier || 'Untitled Product';
  const sku = productEntity?.identifier || String(productId);
  const price = props.Price || '0.00';

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎯 Product: ${title}`);
  console.log(`📌 SKU: "${sku}"`);
  console.log(`📌 Entity ID: ${productId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const existingProduct = await findShopifyProductBySku(sku);
  const relatedAssets = await getRelatedAssets(productId, contentHubBaseUrl, chToken);

  const input = {
    title,
    descriptionHtml: props.Description || '',
    vendor: props.Brand || 'Himalaya Wellness',
    productType: props.Category || '',
    status: 'DRAFT'
  };

  let shopifyProduct;
  try {
    if (existingProduct) {
      console.log(`♻️  UPDATE mode - Product ${existingProduct.id} already exists`);
      const data = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, {
        input: { id: existingProduct.gid, ...input }
      });

      if (data.productUpdate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.productUpdate.userErrors));
      }
      shopifyProduct = data.productUpdate.product;
      console.log(`✅ Product updated`);
    } else {
      console.log(`✨ CREATE mode - No existing product found`);
      const data = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { input });

      if (data.productCreate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.productCreate.userErrors));
      }
      shopifyProduct = data.productCreate.product;
      console.log(`✅ Product created`);
    }

    // Set SKU on variant
    if (shopifyProduct?.id) {
      try {
        const productRestId = shopifyProduct.id.split('/').pop();
        const variantResult = await shopifyREST('GET', `/products/${productRestId}/variants.json`);

        if (variantResult.variants && variantResult.variants.length > 0) {
          const defaultVariant = variantResult.variants[0];
          await shopifyREST('PUT', `/variants/${defaultVariant.id}.json`, {
            variant: { sku }
          });
          console.log(`✅ SKU set: "${sku}"`);
        }
      } catch (variantErr) {
        console.warn('⚠️  Variant update warning:', variantErr.message);
      }
    }

    // Attach images
    if (relatedAssets.length > 0) {
      try {
        const mediaInput = buildMediaInput(relatedAssets);
        const mediaData = await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
          productId: shopifyProduct.id,
          media: mediaInput
        });
        console.log(`✅ ${relatedAssets.length} image(s) attached`);
      } catch (mediaErr) {
        console.warn('⚠️  Image attachment failed:', mediaErr.message);
      }
    }

    // Write sync status back to Content Hub
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
        { headers: { 'X-Auth-Token': chToken, 'Content-Type': 'application/json' }, timeout: 5000 }
      );
      console.log('✅ Sync status written to Content Hub');
    } catch (writeErr) {
      console.warn('⚠️  Could not write status to Content Hub:', writeErr.message);
    }

    return {
      entityType: 'Product',
      shopifyProductId: shopifyProduct.id,
      title: shopifyProduct.title,
      sku,
      imagesAttached: relatedAssets.length,
      isUpdate: !!existingProduct
    };
  } catch (err) {
    console.error('❌ Product sync failed:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// Handle asset creation/update
// ─────────────────────────────────────────────
async function handleAssetPush(assetId, contentHubBaseUrl, chToken) {
  const assetEntity = await getEntity(assetId, contentHubBaseUrl, chToken);
  const { title, imageUrl } = extractAssetImage(assetEntity);

  const sku = `hima${assetId}`;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🖼️  Asset: ${title}`);
  console.log(`📌 SKU: "${sku}"`);
  console.log(`📌 Asset ID: ${assetId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (!imageUrl) {
    throw new Error('Asset has no usable image rendition');
  }

  const existingProduct = await findShopifyProductBySku(sku);

  let description = '';
  const descriptionProp = assetEntity?.properties?.Description;
  if (descriptionProp) {
    if (typeof descriptionProp === 'string') {
      description = descriptionProp.trim();
    } else if (typeof descriptionProp === 'object' && Object.keys(descriptionProp).length > 0) {
      if (descriptionProp['en-US']) {
        description = descriptionProp['en-US'];
      } else {
        const firstValue = Object.values(descriptionProp)[0];
        if (firstValue && typeof firstValue === 'string') {
          description = firstValue;
        }
      }
    }
  }

  const input = {
    title: title || 'Asset Product',
    descriptionHtml: description,
    vendor: 'Himalaya Wellness',
    status: 'DRAFT'
  };

  let shopifyProduct;
  try {
    if (existingProduct) {
      console.log(`♻️  UPDATE mode - Product ${existingProduct.id} already exists`);
      const data = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, {
        input: { id: existingProduct.gid, ...input }
      });

      if (data.productUpdate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.productUpdate.userErrors));
      }
      shopifyProduct = data.productUpdate.product;
      console.log(`✅ Product updated`);
    } else {
      console.log(`✨ CREATE mode - No existing product found`);
      const data = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { input });

      if (data.productCreate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.productCreate.userErrors));
      }
      shopifyProduct = data.productCreate.product;
      console.log(`✅ Product created`);
    }

    // Set SKU on variant
    if (shopifyProduct?.id) {
      try {
        const productRestId = shopifyProduct.id.split('/').pop();
        const variantResult = await shopifyREST('GET', `/products/${productRestId}/variants.json`);

        if (variantResult.variants && variantResult.variants.length > 0) {
          const defaultVariant = variantResult.variants[0];
          await shopifyREST('PUT', `/variants/${defaultVariant.id}.json`, {
            variant: { sku }
          });
          console.log(`✅ SKU set: "${sku}"`);
        }
      } catch (variantErr) {
        console.warn('⚠️  Variant update warning:', variantErr.message);
      }
    }

    // Attach image
    if (imageUrl) {
      try {
        const mediaData = await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
          productId: shopifyProduct.id,
          media: [{
            originalSource: imageUrl,
            alt: title || 'Product image',
            mediaContentType: 'IMAGE'
          }]
        });
        console.log(`✅ Image attached`);
      } catch (mediaErr) {
        console.warn('⚠️  Image attachment failed:', mediaErr.message);
      }
    }

    // Write sync status back to Content Hub
    try {
      await axios.put(
        `${contentHubBaseUrl}/api/entities/${assetId}`,
        {
          properties: {
            ShopifyProductId: shopifyProduct.id,
            ShopifySyncStatus: 'Synced',
            ShopifyLastSyncedOn: new Date().toISOString()
          }
        },
        { headers: { 'X-Auth-Token': chToken, 'Content-Type': 'application/json' }, timeout: 5000 }
      );
      console.log('✅ Sync status written to Content Hub');
    } catch (writeErr) {
      console.warn('⚠️  Could not write status to Content Hub:', writeErr.message);
    }

    return {
      entityType: 'Asset',
      shopifyProductId: shopifyProduct.id,
      title: shopifyProduct.title,
      sku,
      imagesAttached: imageUrl ? 1 : 0,
      isUpdate: !!existingProduct
    };
  } catch (err) {
    console.error('❌ Asset sync failed:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// Main route
// ─────────────────────────────────────────────
app.post('/shopify/publish', async (req, res) => {
  const webhookId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`\n🔔 WEBHOOK RECEIVED [${webhookId}]`);

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const entityId = req.headers['target_id'] || req.body.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  console.log(`✅ Entity ID: ${entityId}`);
  console.log(`✅ Webhook ID: ${webhookId}`);

  if (!entityId) {
    return res.status(400).json({ error: 'No entity ID provided' });
  }

  // ─────────────────────────────────────────────
  // Check if webhook already processing (near-simultaneous duplicates)
  // ─────────────────────────────────────────────
  if (isWebhookProcessing(entityId)) {
    console.warn(`⚠️  Duplicate webhook ignored - already processing`);
    return res.status(202).json({
      error: 'Webhook already processing',
      message: 'Duplicate webhook call ignored to prevent duplicate products'
    });
  }

  try {
    const chToken = await getContentHubToken(sourceSystem);
    if (!chToken) {
      return res.status(500).json({ error: 'Content Hub auth failed' });
    }

    const entity = await getEntity(entityId, sourceSystem, chToken);
    const definitionName = extractDefinitionName(entity);

    console.log(`✅ Definition: ${definitionName}`);

    if (!definitionName) {
      return res.status(400).json({ error: 'Could not extract definition name from entity' });
    }

    let result;
    if (definitionName === 'M.PCM.Product') {
      result = await handleProductPush(entityId, sourceSystem, chToken);
    } else if (definitionName === 'M.Asset') {
      result = await handleAssetPush(entityId, sourceSystem, chToken);
    } else {
      return res.status(400).json({
        error: `Unsupported entity type: ${definitionName}`
      });
    }

    markWebhookProcessed(entityId);
    console.log(`\n✅ SUCCESS [${webhookId}]`);
    res.json({ success: true, webhookId, ...result });

  } catch (err) {
    console.error(`\n❌ FAILED [${webhookId}]:`, err.message);
    res.status(500).json({
      error: 'Shopify publish failed',
      webhookId,
      details: err.message
    });
  }
});

export default app;