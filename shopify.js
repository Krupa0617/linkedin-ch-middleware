import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

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
  SHOPIFY_API_VERSION,
  DATA_DIR
} = process.env;

const SHOPIFY_VERSION = SHOPIFY_API_VERSION || '2026-07';

// ─────────────────────────────────────────────
// FIX: Persistent Content Hub entity → Shopify product mapping
// ─────────────────────────────────────────────
const DATA_DIRECTORY = DATA_DIR || path.join(process.cwd(), 'data');
const MAP_FILE = path.join(DATA_DIRECTORY, 'entity-product-map.json');

function loadEntityProductMap() {
  try {
    if (fs.existsSync(MAP_FILE)) {
      const raw = fs.readFileSync(MAP_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('⚠️  Could not load entity-product map, starting fresh:', err.message);
  }
  return {};
}

function saveEntityProductMap(map) {
  try {
    if (!fs.existsSync(DATA_DIRECTORY)) {
      try {
        fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
      } catch (mkdirErr) {
        console.warn('⚠️  Could not create data directory, mapping will not persist:', mkdirErr.message);
        // Don't fail, just continue without persistence
        return;
      }
    }
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
    console.log(`✅ Entity-product map persisted to ${MAP_FILE}`);
  } catch (err) {
    console.warn('⚠️  Could not persist entity-product map:', err.message);
  }
}

let entityProductMap = loadEntityProductMap();

function getMappedProductGid(mapKey) {
  return entityProductMap[String(mapKey)] || null;
}

function setMappedProductGid(mapKey, productGid) {
  entityProductMap[String(mapKey)] = productGid;
  saveEntityProductMap(entityProductMap);
}

function clearMappedProductGid(mapKey) {
  delete entityProductMap[String(mapKey)];
  saveEntityProductMap(entityProductMap);
}

// ─────────────────────────────────────────────
// Webhook Deduplication
// ─────────────────────────────────────────────
const webhookCache = new Map();
const WEBHOOK_DEDUP_TTL = 5000;

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

  webhookCache.set(key, { timestamp: Date.now(), processed: false });
  return false;
}

function markWebhookProcessed(entityId) {
  const key = `webhook-${entityId}`;
  if (webhookCache.has(key)) {
    webhookCache.get(key).processed = true;
  }
}

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
// Direct product lookup by GID (no search-index lag)
// ─────────────────────────────────────────────
const PRODUCT_BY_ID_QUERY = `
  query getProductById($id: ID!) {
    product(id: $id) {
      id
      title
    }
  }
`;

async function getShopifyProductById(productGid) {
  try {
    const data = await shopifyGraphQL(PRODUCT_BY_ID_QUERY, { id: productGid });
    return data?.product || null;
  } catch (err) {
    console.warn('⚠️  Direct product lookup failed:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// SKU search — fallback only
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
    console.log(`🔍 [fallback] Searching Shopify for product with SKU: "${sku}"`);

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

    console.log(`✅ Found existing product via SKU search: ${productRestId} (${edge.node.product.title})`);
    return { id: productRestId, gid: productGid, title: edge.node.product.title };
  } catch (err) {
    console.warn('⚠️ SKU search failed:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Combined lookup: local map → SKU search
// ─────────────────────────────────────────────
async function findExistingShopifyProduct(mapKey, sku) {
  const mappedGid = getMappedProductGid(mapKey);

  if (mappedGid) {
    console.log(`🗺️  Found local mapping for "${mapKey}" -> ${mappedGid}, verifying it still exists...`);
    const product = await getShopifyProductById(mappedGid);

    if (product) {
      const productRestId = product.id.split('/').pop();
      console.log(`✅ Confirmed existing product: ${productRestId} (${product.title})`);
      return { id: productRestId, gid: product.id, title: product.title };
    }

    console.warn(`⚠️  Mapped product ${mappedGid} no longer exists in Shopify (deleted?) — clearing stale mapping`);
    clearMappedProductGid(mapKey);
  }

  return findShopifyProductBySku(sku);
}

// ─────────────────────────────────────────────
// Fetch related assets
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
// Helper: Set product metafields using REST API
// Updates Content Hub ID metafields for tracking
// ─────────────────────────────────────────────
async function setProductMetafields(productGid, namespace, key, value) {
  try {
    console.log(`📝 Setting metafield: ${key} = ${value}`);
    
    if (!productGid) {
      console.warn(`⚠️  Cannot set metafield: productGid is missing`);
      return false;
    }
    
    // Extract product ID from GID (gid://shopify/Product/123456 -> 123456)
    const productId = productGid.split('/').pop();
    
    if (!productId) {
      console.warn(`⚠️  Cannot set metafield: could not extract product ID from GID: ${productGid}`);
      return false;
    }
    
    console.log(`   → Product ID: ${productId}, Namespace: ${namespace}, Key: ${key}`);
    
    // Use REST API to set metafield
    // FIX: Use number_integer type since the metafields in Shopify are defined as numbers
    const metafieldData = {
      metafield: {
        namespace: namespace,
        key: key,
        value: String(value),  // Convert to string for API, but type tells Shopify to store as integer
        type: 'number_integer'  // ✅ FIXED: Changed from 'single_line_text_field' to 'number_integer'
      }
    };
    
    const response = await shopifyREST('POST', `/products/${productId}/metafields.json`, metafieldData);
    
    if (response?.metafield?.id) {
      console.log(`✅ Metafield set successfully: ${key} (ID: ${response.metafield.id}, Value: ${response.metafield.value})`);
      return true;
    } else {
      console.warn(`⚠️  Metafield response unexpected:`, JSON.stringify(response));
      return false;
    }
  } catch (err) {
    console.error(`❌ Metafield update failed for ${key}:`, err.message);
    if (err.response?.data) {
      console.error(`   Error details:`, JSON.stringify(err.response.data));
    }
    return false;
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
// FIX #10: Improved description handling and no duplicate images on update
// ─────────────────────────────────────────────
async function handleProductPush(productId, contentHubBaseUrl, chToken) {
  const productEntity = await getEntity(productId, contentHubBaseUrl, chToken);
  const props = productEntity?.properties || {};

  const title = props.ProductName || props.Title || productEntity?.identifier || 'Untitled Product';
  const sku = productEntity?.identifier || String(productId);
  const price = props.Price || '0.00';
  const mapKey = `product-${productId}`;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎯 Product: ${title}`);
  console.log(`📌 SKU: "${sku}"`);
  console.log(`📌 Entity ID: ${productId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const existingProduct = await findExistingShopifyProduct(mapKey, sku);
  const relatedAssets = await getRelatedAssets(productId, contentHubBaseUrl, chToken);

  // FIX #10: Improved description extraction - check multiple fields
  let description = '';
  
  // Priority 1: ProductShortDescription (if localized)
  if (props.ProductShortDescription) {
    if (typeof props.ProductShortDescription === 'string') {
      description = props.ProductShortDescription;
    } else if (typeof props.ProductShortDescription === 'object' && props.ProductShortDescription['en-US']) {
      description = props.ProductShortDescription['en-US'];
    }
  }
  // Priority 2: Description field
  else if (props.Description) {
    if (typeof props.Description === 'string') {
      description = props.Description;
    } else if (typeof props.Description === 'object' && props.Description['en-US']) {
      description = props.Description['en-US'];
    }
  }
  
  console.log(`   📝 Description: ${description.slice(0, 60)}${description.length > 60 ? '...' : ''}`);

  const input = {
    title,
    descriptionHtml: description,
    vendor: props.Brand || 'Himalaya Wellness',
    productType: props.Category || '',
    status: 'DRAFT'
  };

  let shopifyProduct;
  let isNewProduct = false;
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
      console.log(`✅ Product updated (description and details synced)`);
    } else {
      console.log(`✨ CREATE mode - No existing product found`);
      const data = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { input });

      if (data.productCreate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.productCreate.userErrors));
      }
      shopifyProduct = data.productCreate.product;
      isNewProduct = true;
      console.log(`✅ Product created`);
    }

    // Persist the mapping immediately
    if (shopifyProduct?.id) {
      setMappedProductGid(mapKey, shopifyProduct.id);
    }

    // Set SKU and price on variant
    if (shopifyProduct?.id) {
      try {
        const productRestId = shopifyProduct.id.split('/').pop();
        const variantResult = await shopifyREST('GET', `/products/${productRestId}/variants.json`);

        if (variantResult.variants && variantResult.variants.length > 0) {
          const defaultVariant = variantResult.variants[0];
          await shopifyREST('PUT', `/variants/${defaultVariant.id}.json`, {
            variant: { sku, price: String(price) }
          });
          console.log(`✅ SKU: "${sku}", Price: ${price}`);
        }
      } catch (variantErr) {
        console.warn('⚠️  Variant update warning:', variantErr.message);
      }
    }

    // FIX #10: Only attach images on NEW products to prevent duplicates
    if (isNewProduct && relatedAssets.length > 0) {
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
    } else if (!isNewProduct && relatedAssets.length > 0) {
      console.log(`ℹ️  Skipping image attachment on update (prevents duplicate images)`);
    }

    // Set Content Hub Product ID metafield
    try {
      await setProductMetafields(
        shopifyProduct.id,
        'custom',
        'content_hub_product_id',
        String(productId)
      );
    } catch (metafieldErr) {
      console.warn('⚠️  Could not set Content Hub Product ID metafield:', metafieldErr.message);
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
      imagesAttached: isNewProduct ? relatedAssets.length : 0,
      isUpdate: !!existingProduct,
      descriptionUpdated: true
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
  const mapKey = `asset-${assetId}`;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🖼️  Asset: ${title}`);
  console.log(`📌 SKU: "${sku}"`);
  console.log(`📌 Asset ID: ${assetId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (!imageUrl) {
    throw new Error('Asset has no usable image rendition');
  }

  const existingProduct = await findExistingShopifyProduct(mapKey, sku);

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
  let isNewProduct = false;
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
      console.log(`✅ Product updated (description synced)`);
    } else {
      console.log(`✨ CREATE mode - No existing product found`);
      const data = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { input });

      if (data.productCreate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.productCreate.userErrors));
      }
      shopifyProduct = data.productCreate.product;
      isNewProduct = true;
      console.log(`✅ Product created`);
    }

    // Persist the mapping immediately
    if (shopifyProduct?.id) {
      setMappedProductGid(mapKey, shopifyProduct.id);
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
          console.log(`✅ SKU: "${sku}"`);
        }
      } catch (variantErr) {
        console.warn('⚠️  Variant update warning:', variantErr.message);
      }
    }

    // FIX #10: Only attach image on NEW products to prevent duplicates
    if (isNewProduct && imageUrl) {
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
    } else if (!isNewProduct && imageUrl) {
      console.log(`ℹ️  Skipping image attachment on update (prevents duplicate images)`);
    }

    // Set Content Hub Asset ID metafield
    try {
      await setProductMetafields(
        shopifyProduct.id,
        'custom',
        'sitecore_content_hub_asset_id',
        String(assetId)
      );
    } catch (metafieldErr) {
      console.warn('⚠️  Could not set Content Hub Asset ID metafield:', metafieldErr.message);
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
      imagesAttached: isNewProduct ? 1 : 0,
      isUpdate: !!existingProduct,
      descriptionUpdated: true
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