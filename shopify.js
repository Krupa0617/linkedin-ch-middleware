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
// FIX #1: Search Shopify for existing product by SKU
// Prevents duplicate product creation
// ─────────────────────────────────────────────
async function findShopifyProductBySku(sku) {
  try {
    console.log(`🔍 Searching Shopify for product with SKU: ${sku}`);
    const result = await shopifyREST('GET', `/products.json?status=any`);
    
    const products = result.products || [];
    for (const product of products) {
      for (const variant of product.variants || []) {
        if (variant.sku === sku) {
          console.log(`✅ Found existing product: ${product.id} (SKU: ${sku})`);
          return product;
        }
      }
    }
    
    console.log(`⚠️ No existing product found for SKU: ${sku}`);
    return null;
  } catch (err) {
    console.warn('⚠️ Search failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// FIX #2: Fetch related assets using Content Hub Query API
// Simple and efficient - gets all M.Asset entities linked to the product
// ─────────────────────────────────────────────
async function getRelatedAssets(productId, contentHubBaseUrl, token) {
  try {
    console.log(`📸 Fetching related assets for product ${productId}`);
    
    // Use Content Hub Query API to find all assets linked to this product
    // Query: Definition.Name=='M.Asset' AND Parent('PCMProductToAsset').id==productId
    const query = `Definition.Name=='M.Asset' AND Parent('PCMProductToAsset').id==${productId}`;
    console.log(`   📋 Query: ${query}`);
    
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
    
    if (assetEntities.length === 0) {
      console.log(`   ⚠️  No assets found for product ${productId}`);
      return [];
    }
    
    // Extract image URLs directly from the asset entities (no extra fetches needed)
    const imageAssets = [];
    for (let i = 0; i < assetEntities.length; i++) {
      try {
        const asset = assetEntities[i];
        const { title, imageUrl } = extractAssetImage(asset);
        
        if (imageUrl) {
          console.log(`   Asset #${i}: ${asset.identifier} ✅`);
          imageAssets.push({ id: asset.id, title, imageUrl });
        } else {
          console.log(`   Asset #${i}: ${asset.identifier} (no image rendition) ⚠️`);
        }
      } catch (err) {
        console.warn(`   Asset #${i}: Error processing -`, err.message.slice(0, 80));
      }
    }
    
    if (imageAssets.length === 0) {
      console.log(`   ⚠️  No usable image URLs found in ${assetEntities.length} asset(s)`);
    } else {
      console.log(`   ✅ Successfully retrieved ${imageAssets.length} asset image(s)`);
    }
    
    return imageAssets;
  } catch (err) {
    console.error('❌ Asset query error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// Helper: Build Shopify media input from assets
// ─────────────────────────────────────────────
function buildMediaInput(assets) {
  return assets.map((a) => ({
    originalSource: a.imageUrl,
    alt: a.title || 'Product image',
    mediaContentType: 'IMAGE'
  }));
}

// ─────────────────────────────────────────────
// Shopify Mutations & Queries
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
// FIX #3: Handle product creation/update
// Creates or updates a single product with all
// related assets as images
//
// FIX #4: Use Content Hub product number as SKU
// Prioritizes the product Number field from Content Hub
// ─────────────────────────────────────────────
async function handleProductPush(productId, contentHubBaseUrl, chToken) {
  const productEntity = await getEntity(productId, contentHubBaseUrl, chToken);
  const props = productEntity?.properties || {};

  const title = props.ProductName || props.Title || productEntity?.identifier || 'Untitled Product';
  const description = props.Description || props.ProductShortDescription?.['en-US'] || '';
  const vendor = props.Brand || 'Himalaya Wellness';
  const productType = props.Category || '';
  
  // FIX #4: Use product number as primary SKU, fallback to identifier
  // This ensures the Content Hub product number (e.g., 000800134652) is used as the Shopify SKU
  const productNumber = props.Number || props.ProductNumber || null;
  const identifier = productEntity?.identifier || String(productId);
  const sku = productNumber || identifier;
  
  const price = props.Price || '0.00';

  console.log(`🎯 Processing product: ${title}`);
  console.log(`   📌 Product Number (Content Hub): ${productNumber || 'N/A'}`);
  console.log(`   📌 Identifier (Content Hub): ${identifier}`);
  console.log(`   📌 SKU (Shopify): ${sku}`);

  // FIX #1: Check if product already exists to prevent duplicates
  const existingProduct = await findShopifyProductBySku(sku);
  
  // Fetch related assets BEFORE creating product
  const relatedAssets = await getRelatedAssets(productId, contentHubBaseUrl, chToken);

  const input = {
    title,
    descriptionHtml: description,
    vendor,
    productType,
    status: 'DRAFT'
  };

  let shopifyProduct;
  try {
    if (existingProduct) {
      console.log(`♻️ Updating existing product ${existingProduct.id}`);
      const data = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, {
        input: { id: `gid://shopify/Product/${existingProduct.id}`, ...input }
      });
      
      if (data.productUpdate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.productUpdate.userErrors));
      }
      shopifyProduct = data.productUpdate.product;
    } else {
      console.log(`✨ Creating new product: ${title}`);
      const data = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { input });
      
      if (data.productCreate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.productCreate.userErrors));
      }
      shopifyProduct = data.productCreate.product;
    }

    // FIX #3: Update variant via REST API (more reliable than GraphQL)
    if (shopifyProduct?.id) {
      try {
        const productGid = shopifyProduct.id;
        const productRestId = productGid.split('/').pop();
        
        console.log(`📦 Updating variant for product ${productRestId}`);
        const variantResult = await shopifyREST('GET', `/products/${productRestId}/variants.json`);
        
        if (variantResult.variants && variantResult.variants.length > 0) {
          const defaultVariant = variantResult.variants[0];
          
          await shopifyREST('PUT', `/variants/${defaultVariant.id}.json`, {
            variant: {
              sku,
              price: String(price)
            }
          });
          
          console.log(`✅ Variant updated: SKU=${sku}, Price=${price}`);
        }
      } catch (variantErr) {
        console.warn('⚠️ Variant update warning:', variantErr.message);
      }
    }

    // Attach related media
    if (relatedAssets.length > 0) {
      try {
        console.log(`🖼️ Attaching ${relatedAssets.length} images to product`);
        const mediaInput = buildMediaInput(relatedAssets);
        const mediaData = await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
          productId: shopifyProduct.id,
          media: mediaInput
        });
        
        if (mediaData.productCreateMedia?.mediaUserErrors?.length) {
          console.warn('⚠️ Media upload warnings:', mediaData.productCreateMedia.mediaUserErrors);
        } else {
          console.log(`✅ ${relatedAssets.length} images attached`);
        }
      } catch (mediaErr) {
        console.warn('⚠️ Media attachment failed:', mediaErr.message);
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
        { 
          headers: { 
            'X-Auth-Token': chToken, 
            'Content-Type': 'application/json' 
          },
          timeout: 5000
        }
      );
      console.log('✅ Sync status written to Content Hub');
    } catch (writeErr) {
      console.warn('⚠️ Could not write status to Content Hub:', writeErr.message);
    }

    return {
      entityType: 'Product',
      shopifyProductId: shopifyProduct.id,
      title: shopifyProduct.title,
      imagesAttached: relatedAssets.length,
      isUpdate: !!existingProduct,
      sku
    };
  } catch (err) {
    console.error('❌ Product sync failed:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// Flow B: ASSET entity was triggered
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

  // Find parent product
  const relResponse = await axios.get(
    `${contentHubBaseUrl}/api/entities/${assetId}/relations/PCMProductToMasterAsset/parents`,
    { headers: { 'X-Auth-Token': chToken, 'Content-Type': 'application/json' } }
  ).catch((err) => {
    console.warn('⚠️ Could not find related products:', err.message);
    return { data: { items: [] } };
  });

  const linkedProducts = relResponse.data?.items || [];

  if (linkedProducts.length > 0) {
    const productId = linkedProducts[0].id;
    const productEntity = await getEntity(productId, contentHubBaseUrl, chToken);
    const shopifyProductId = productEntity?.properties?.ShopifyProductId;

    if (!shopifyProductId) {
      throw new Error(`Linked product ${productId} has not been synced to Shopify yet`);
    }

    const mediaData = await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
      productId: shopifyProductId,
      media: buildMediaInput([{ title, imageUrl }])
    });

    if (mediaData.productCreateMedia?.mediaUserErrors?.length) {
      throw new Error(JSON.stringify(mediaData.productCreateMedia.mediaUserErrors));
    }

    return {
      entityType: 'Asset',
      attachedToProductId: shopifyProductId,
      title
    };
  }

  // No linked product — upload as standalone file
  const fileData = await shopifyGraphQL(FILE_CREATE_MUTATION, {
    files: [{ originalSource: imageUrl, alt: title, contentType: 'IMAGE' }]
  });

  if (fileData.fileCreate?.userErrors?.length) {
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
// Main route — Handles Product and Asset entities
// ─────────────────────────────────────────────
app.post('/shopify/publish', async (req, res) => {
  console.log('📢 Incoming publish request from Content Hub');

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const entityId = req.headers['target_id'] || req.body.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  console.log('✅ Entity ID:', entityId);

  if (!entityId) {
    return res.status(400).json({ error: 'No entity ID provided' });
  }

  try {
    const chToken = await getContentHubToken(sourceSystem);
    if (!chToken) {
      return res.status(500).json({ error: 'Content Hub auth failed' });
    }

    const entity = await getEntity(entityId, sourceSystem, chToken);
    const definitionName = extractDefinitionName(entity);

    console.log('✅ Definition name:', definitionName);

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
        error: `Unsupported entity type: ${definitionName}. Expected M.PCM.Product or M.Asset.`
      });
    }

    console.log('✅ Shopify push complete:', result);
    res.json({ success: true, ...result });

  } catch (err) {
    console.error('❌ Shopify publish failed:', err.message);
    res.status(500).json({
      error: 'Shopify publish failed',
      details: err.message
    });
  }
});

export default app;