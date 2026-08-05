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
// Helper: Fetch a Content Hub entity
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
// ─────────────────────────────────────────────
async function getRelatedAssets(productId, contentHubBaseUrl, token) {
  try {
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
// Helper: Build media input for Shopify
// ─────────────────────────────────────────────
function buildMediaInput(assets) {
  return assets.map((a) => ({
    originalSource: a.imageUrl,
    alt: a.title || 'Product image',
    mediaContentType: 'IMAGE'
  }));
}

// ─────────────────────────────────────────────
// ✅ FIXED MUTATIONS - Variants included in ProductInput
// ─────────────────────────────────────────────
const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product { 
        id 
        title 
        handle
        variants(first: 1) {
          edges {
            node {
              id
              sku
              price
            }
          }
        }
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
        variants(first: 1) {
          edges {
            node {
              id
              sku
              price
            }
          }
        }
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
// ✅ FIXED: handleProductPush with proper field mapping
// ─────────────────────────────────────────────
async function handleProductPush(productId, contentHubBaseUrl, chToken) {
  const productEntity = await getEntity(productId, contentHubBaseUrl, chToken);
  const props = productEntity?.properties || {};

  // ✅ FIXED: Proper field extraction from Content Hub
  const title = props.ProductName || props.Title || productEntity?.identifier || 'Untitled Product';
  
  // Description: Try ProductLongDescription first, then ProductShortDescription
  const descriptionData = props.ProductLongDescription || props.ProductShortDescription || {};
  const description = typeof descriptionData === 'object' 
    ? (descriptionData['en-US'] || descriptionData['ar-AE'] || '') 
    : (descriptionData || '');
  
  const vendor = props.Brand || 'Himalaya Wellness';
  const productType = props.Category || props.ProductType || 'General';
  const sku = productEntity?.identifier || productId;
  const price = props.Price || '0.00';
  const existingShopifyId = props.ShopifyProductId || null;

  const relatedAssets = await getRelatedAssets(productId, contentHubBaseUrl, chToken);

  console.log('📦 Product Details:');
  console.log('  Title:', title);
  console.log('  Description:', description.substring(0, 100) + '...');
  console.log('  Vendor:', vendor);
  console.log('  Product Type:', productType);
  console.log('  SKU:', sku);
  console.log('  Price:', price);
  console.log('  Related Assets:', relatedAssets.length);

  // ✅ FIXED: Include variant in ProductInput instead of separate mutation
  const input = {
    title,
    descriptionHtml: `<p>${description || 'No description available'}</p>`,
    vendor,
    productType,
    status: 'DRAFT',
    variants: [
      {
        sku,
        price: String(price)
      }
    ]
  };

  let shopifyProduct;
  try {
    if (existingShopifyId) {
      console.log('📝 Updating existing product:', existingShopifyId);
      const data = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, {
        input: { id: existingShopifyId, ...input }
      });
      if (data.productUpdate.userErrors.length) {
        throw new Error(JSON.stringify(data.productUpdate.userErrors));
      }
      shopifyProduct = data.productUpdate.product;
      console.log('✅ Product updated successfully');
    } else {
      console.log('🆕 Creating new product');
      const data = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { input });
      if (data.productCreate.userErrors.length) {
        throw new Error(JSON.stringify(data.productCreate.userErrors));
      }
      shopifyProduct = data.productCreate.product;
      console.log('✅ Product created successfully:', shopifyProduct.id);
    }

    // ✅ Attach related media
    if (relatedAssets.length > 0) {
      console.log('📸 Attaching', relatedAssets.length, 'images to product');
      const mediaInput = buildMediaInput(relatedAssets);
      const mediaData = await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
        productId: shopifyProduct.id,
        media: mediaInput
      });
      if (mediaData.productCreateMedia.mediaUserErrors.length) {
        console.warn('⚠️ Media upload warnings:', mediaData.productCreateMedia.mediaUserErrors);
      } else {
        console.log('✅ Images attached successfully');
      }
    } else {
      console.warn('⚠️ No images found to attach');
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
      console.log('✅ Status written back to Content Hub');
    } catch (writeErr) {
      console.warn('⚠️ Could not write status back to Content Hub:', writeErr.message);
    }

    return {
      entityType: 'Product',
      shopifyProductId: shopifyProduct.id,
      title: shopifyProduct.title,
      imagesAttached: relatedAssets.length,
      descriptionAdded: !!description
    };
  } catch (err) {
    // Try to write error status back
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

  // No linked product — upload as standalone file
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
// Main route — Content Hub trigger
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

export default app;