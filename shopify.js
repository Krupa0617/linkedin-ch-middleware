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
  DATA_DIR,

  // ── NEW: Key Ingredients configuration ──────────────────────
  // Verify these against your actual Content Hub schema
  // (Admin > Configuration > Entity definitions) before running.
  CH_INGREDIENT_DEFINITION_NAME,   // e.g. "M.KeyIngredients"
  CH_INGREDIENT_RELATION_NAME,     // e.g. "PCMProductToKeyIngredients" (screenshot shows "KeyIngredients")
  CH_INGREDIENT_IMAGE_RELATION_NAME, // relation from ingredient entity -> M.Asset for IngredientImage, if it's a link field rather than inline

  // Shopify side
  SHOPIFY_INGREDIENT_METAOBJECT_TYPE,      // metaobject type handle, e.g. "key_ingredients"
  SHOPIFY_KEY_INGREDIENTS_METAFIELD_NAMESPACE, // e.g. "custom"
  SHOPIFY_KEY_INGREDIENTS_METAFIELD_KEY         // e.g. "key_ingredients" (must match the definition's key exactly)
} = process.env;

const SHOPIFY_VERSION = SHOPIFY_API_VERSION || '2026-07';

// Defaults — override in .env once you've confirmed the real names in Content Hub / Shopify
const INGREDIENT_DEFINITION_NAME = CH_INGREDIENT_DEFINITION_NAME || 'M.KeyIngredients';
const INGREDIENT_RELATION_NAME = CH_INGREDIENT_RELATION_NAME || 'PCMProductToKeyIngredients';
const INGREDIENT_IMAGE_RELATION_NAME = CH_INGREDIENT_IMAGE_RELATION_NAME || 'KeyIngredientsToImageAsset';

const INGREDIENT_METAOBJECT_TYPE = SHOPIFY_INGREDIENT_METAOBJECT_TYPE || 'key_ingredients';
const KEY_INGREDIENTS_METAFIELD_NAMESPACE = SHOPIFY_KEY_INGREDIENTS_METAFIELD_NAMESPACE || 'custom';
const KEY_INGREDIENTS_METAFIELD_KEY = SHOPIFY_KEY_INGREDIENTS_METAFIELD_KEY || 'key_ingredients';

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
// Helper: Extract localized text property
// ─────────────────────────────────────────────
function extractLocalizedText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (value['en-US']) return value['en-US'];
    const first = Object.values(value)[0];
    if (typeof first === 'string') return first;
  }
  return '';
}

// ─────────────────────────────────────────────
// Country name -> ISO 3166-1 alpha-2 code
// ─────────────────────────────────────────────
const COUNTRY_NAME_TO_ISO = {
  'india': 'IN',
  'united states': 'US',
  'united states of america': 'US',
  'usa': 'US',
  'united kingdom': 'GB',
  'uk': 'GB',
  'germany': 'DE',
  'china': 'CN',
  'sri lanka': 'LK',
  'nepal': 'NP',
  'bangladesh': 'BD',
  'united arab emirates': 'AE',
  'uae': 'AE',
  'canada': 'CA',
  'australia': 'AU'
};

function toCountryCode(rawValue) {
  const value = extractLocalizedText(rawValue).trim();
  if (!value) return null;

  if (/^[a-zA-Z]{2}$/.test(value)) {
    return value.toUpperCase();
  }

  const mapped = COUNTRY_NAME_TO_ISO[value.toLowerCase()];
  if (!mapped) {
    console.warn(`⚠️  Could not map country "${value}" to an ISO code`);
    return null;
  }
  return mapped;
}

// ─────────────────────────────────────────────
// Direct product lookup by GID
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
    console.warn('⚠️  Direct product lookup failed:', err.message);
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
    console.warn('⚠️ SKU search failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Combined lookup: local map → SKU search
// ─────────────────────────────────────────────
async function findExistingShopifyProduct(mapKey, sku) {
  const mappedGid = getMappedProductGid(mapKey);

  if (mappedGid) {
    console.log(`🗺️  Found local mapping for "${mapKey}"`);
    const product = await getShopifyProductById(mappedGid);

    if (product) {
      const productRestId = product.id.split('/').pop();
      console.log(`✅ Confirmed existing product: ${productRestId}`);
      return { id: productRestId, gid: product.id, title: product.title };
    }

    console.warn(`⚠️  Mapped product no longer exists — clearing stale mapping`);
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
        console.warn(`⚠️ Asset #${i}: Error processing`);
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
// DIAGNOSTIC: List every relation name Content Hub exposes on an entity.
// Run once against a product that has ingredients attached (e.g. Galactosure,
// entity 36294) to find the exact relation name to put in .env — the console
// output will show something like: 📎 Available relations: ["ProductToAsset",
// "ProductToDocument", "ActualRelationNameHere", ...]
// ─────────────────────────────────────────────
async function logAvailableRelations(entity) {
  try {
    const relationKeys = entity?.relations ? Object.keys(entity.relations) : [];
    console.log(`📎 Available relations on entity ${entity?.id}:`, JSON.stringify(relationKeys));

    // Also try the dedicated relations endpoint as a fallback / cross-check
  } catch (err) {
    console.warn('⚠️  Could not enumerate relations:', err.message);
  }
}

async function logRelationsFromApi(entityId, contentHubBaseUrl, token) {
  try {
    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/${entityId}/relations`,
      { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`📎 /relations endpoint for entity ${entityId}:`, JSON.stringify(response.data));
  } catch (err) {
    console.warn(`⚠️  /relations endpoint not available or failed:`, err.response?.status, err.message);
  }
}

// ─────────────────────────────────────────────
// UPDATED: Fetch related Key Ingredients from Content Hub
// Matches the "Add Key Ingredients" entry form: Title, Description, IngredientImage
// ─────────────────────────────────────────────
async function getRelatedIngredients(productId, contentHubBaseUrl, token) {
  try {
    console.log(`🌿 Fetching related Key Ingredients for product ${productId}`);
    console.log(`   Using definition: ${INGREDIENT_DEFINITION_NAME}, relation: ${INGREDIENT_RELATION_NAME}`);

    // DIAGNOSTIC — remove once the correct relation name is confirmed and set in .env
    const fullProductEntity = await getEntity(productId, contentHubBaseUrl, token);
    await logAvailableRelations(fullProductEntity);
    await logRelationsFromApi(productId, contentHubBaseUrl, token);

    const query = `Definition.Name=='${INGREDIENT_DEFINITION_NAME}' AND Parent('${INGREDIENT_RELATION_NAME}').id==${productId}`;

    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/query`,
      {
        params: { query },
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    const ingredientEntities = response.data?.items || [];
    console.log(`   ✅ Query returned ${ingredientEntities.length} ingredients`);

    const ingredients = [];
    for (let i = 0; i < ingredientEntities.length; i++) {
      try {
        const ingredient = ingredientEntities[i];
        const props = ingredient?.properties || {};

        const ingredientData = {
          id: ingredient.id,
          title: extractLocalizedText(props.Title || ingredient.identifier),
          description: extractLocalizedText(props.Description),
          imageUrl: await resolveIngredientImageUrl(ingredient, contentHubBaseUrl, token)
        };

        if (ingredientData.title) {
          ingredients.push(ingredientData);
        }
      } catch (err) {
        console.warn(`⚠️ Ingredient #${i}: Error processing`, err.message);
      }
    }

    console.log(`✅ Retrieved ${ingredients.length} Key Ingredient(s)`);
    return ingredients;
  } catch (err) {
    console.error('❌ Key Ingredients query error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// NEW: Resolve the IngredientImage field to an actual image URL.
// The "Add Key Ingredients" form has an "IngredientImage" field with a
// "Select image" button — that's an asset reference, not inline renditions,
// so we check both an inline rendition on the ingredient entity itself
// (in case it's stored directly) and a linked M.Asset entity as fallback.
// ─────────────────────────────────────────────
async function resolveIngredientImageUrl(ingredientEntity, contentHubBaseUrl, token) {
  // Case 1: renditions exist directly on the ingredient entity
  const directRenditions = ingredientEntity?.renditions;
  if (directRenditions && typeof directRenditions === 'object') {
    const directUrl = directRenditions.downloadOriginal?.[0]?.href
      || directRenditions.downloadOriginal?.[0]?.url;
    if (directUrl) return directUrl;
  }

  // Case 2: IngredientImage is a linked M.Asset entity via a relation
  try {
    const query = `Definition.Name=='M.Asset' AND Parent('${INGREDIENT_IMAGE_RELATION_NAME}').id==${ingredientEntity.id}`;
    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/query`,
      {
        params: { query },
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );
    const assetEntity = response.data?.items?.[0];
    if (assetEntity) {
      const { imageUrl } = extractAssetImage(assetEntity);
      return imageUrl;
    }
  } catch (err) {
    console.warn(`⚠️  Could not resolve IngredientImage for ingredient ${ingredientEntity.id}:`, err.message);
  }

  return null;
}

// ─────────────────────────────────────────────
// Create/Update Metaobject for a Key Ingredient in Shopify
// Field keys (title, description, ingredient_image) must match the
// metaobject definition's field keys under Settings > Custom data > Metaobjects.
// ─────────────────────────────────────────────
const CREATE_METAOBJECT_MUTATION = `
  mutation createMetaobject($metaobject: MetaobjectInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        id
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_METAOBJECT_MUTATION = `
  mutation updateMetaobject($id: ID!, $metaobject: MetaobjectInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject {
        id
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Look up an existing metaobject for this Content Hub ingredient by handle prefix
const FIND_METAOBJECT_BY_HANDLE_QUERY = `
  query findMetaobjectByHandle($type: String!, $handle: String!) {
    metaobjectByHandle(handle: { type: $type, handle: $handle }) {
      id
      handle
    }
  }
`;

async function findExistingIngredientMetaobject(ingredientId) {
  try {
    const handle = `ingredient-${ingredientId}`;
    const data = await shopifyGraphQL(FIND_METAOBJECT_BY_HANDLE_QUERY, {
      type: INGREDIENT_METAOBJECT_TYPE,
      handle
    });
    return data?.metaobjectByHandle?.id || null;
  } catch (err) {
    // Not found or handle mismatch — treat as new
    return null;
  }
}

async function createOrUpdateIngredientMetaobject(ingredient) {
  try {
    console.log(`\n📝 Creating/Updating Key Ingredient metaobject: ${ingredient.title}`);

    const existingMetaobjectId = await findExistingIngredientMetaobject(ingredient.id);

    const fields = [
      { key: 'title', value: ingredient.title },
      { key: 'description', value: ingredient.description || '' }
    ];

    if (ingredient.imageUrl) {
      fields.push({ key: 'ingredient_image', value: ingredient.imageUrl });
    }

    const metaobjectInput = {
      type: INGREDIENT_METAOBJECT_TYPE,
      fields,
      capabilities: {
        publishable: { status: 'ACTIVE' }
      }
    };

    let result;
    if (existingMetaobjectId) {
      console.log(`♻️ Updating metaobject: ${existingMetaobjectId}`);
      const data = await shopifyGraphQL(UPDATE_METAOBJECT_MUTATION, {
        id: existingMetaobjectId,
        metaobject: metaobjectInput
      });

      if (data.metaobjectUpdate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.metaobjectUpdate.userErrors));
      }
      result = data.metaobjectUpdate.metaobject;
      console.log(`✅ Key Ingredient metaobject UPDATED: ${ingredient.title}`);
    } else {
      // Stable, deterministic handle so re-syncs update instead of duplicating
      metaobjectInput.handle = `ingredient-${ingredient.id}`;

      console.log(`✨ Creating new metaobject for: ${ingredient.title}`);
      const data = await shopifyGraphQL(CREATE_METAOBJECT_MUTATION, {
        metaobject: metaobjectInput
      });

      if (data.metaobjectCreate?.userErrors?.length) {
        throw new Error(JSON.stringify(data.metaobjectCreate.userErrors));
      }
      result = data.metaobjectCreate.metaobject;
      console.log(`✅ Key Ingredient metaobject CREATED: ${ingredient.title}`);
    }

    return result;
  } catch (err) {
    console.error(`❌ Failed to create/update Key Ingredient metaobject:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// NEW: Link the created ingredient metaobjects to the product's
// "Key Ingredients" metafield (list.metaobject_reference).
// This is the piece that was missing — metaobjects were being created
// but never attached to the product, so the field stayed empty.
// ─────────────────────────────────────────────
async function setKeyIngredientsMetafield(productGid, metaobjectIds) {
  if (!productGid || !metaobjectIds?.length) {
    console.warn('⚠️  Skipping Key Ingredients metafield — no metaobjects to link');
    return false;
  }

  return setProductMetafields(
    productGid,
    KEY_INGREDIENTS_METAFIELD_NAMESPACE,
    KEY_INGREDIENTS_METAFIELD_KEY,
    JSON.stringify(metaobjectIds),
    'list.metaobject_reference'
  );
}

// ─────────────────────────────────────────────
// Set Shopify Product Metafield
// ─────────────────────────────────────────────
async function setProductMetafields(
  productGid,
  namespace,
  key,
  value,
  type = 'single_line_text_field'
) {
  try {
    console.log(`\n📝 Setting Shopify metafield`);
    console.log(`   Namespace : ${namespace}`);
    console.log(`   Key       : ${key}`);
    console.log(`   Value     : ${value}`);
    console.log(`   Type      : ${type}`);

    if (!productGid) {
      console.warn(`⚠️ Cannot set metafield: productGid is missing`);
      return false;
    }

    if (value === null || value === undefined || String(value).trim() === '') {
      console.warn(`⚠️ Skipping empty metafield: ${namespace}.${key}`);
      return false;
    }

    const productId = productGid.split('/').pop();

    if (!productId) {
      console.warn(`⚠️ Could not extract product ID from GID: ${productGid}`);
      return false;
    }

    // Check if metafield already exists
    const existingResponse = await shopifyREST(
      'GET',
      `/products/${productId}/metafields.json?namespace=${encodeURIComponent(
        namespace
      )}&key=${encodeURIComponent(key)}`
    );

    const existingMetafield = existingResponse?.metafields?.find(
      (m) => m.namespace === namespace && m.key === key
    );

    // Update existing metafield
    if (existingMetafield) {
      console.log(`♻️ Existing metafield found: ${namespace}.${key}`);
      console.log(`   Metafield ID: ${existingMetafield.id}`);
      console.log(`   Existing type: ${existingMetafield.type}`);

      const updateResponse = await shopifyREST(
        'PUT',
        `/products/${productId}/metafields/${existingMetafield.id}.json`,
        {
          metafield: {
            id: existingMetafield.id,
            value: String(value)
          }
        }
      );

      if (updateResponse?.metafield?.id) {
        console.log(`✅ Metafield UPDATED: ${namespace}.${key}`);
        return true;
      }

      console.warn(`⚠️ Unexpected update response`);
      return false;
    }

    // Create new metafield
    console.log(`✨ Metafield does not exist. Creating ${namespace}.${key}`);

    const createResponse = await shopifyREST(
      'POST',
      `/products/${productId}/metafields.json`,
      {
        metafield: {
          namespace,
          key,
          value: String(value),
          type
        }
      }
    );

    if (createResponse?.metafield?.id) {
      console.log(`✅ Metafield CREATED: ${namespace}.${key}`);
      return true;
    }

    console.warn(`⚠️ Unexpected create response`);
    return false;
  } catch (err) {
    console.error(`❌ Metafield update failed:`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// Set Country/Region of origin on InventoryItem
// ─────────────────────────────────────────────
async function setInventoryItemCountryOfOrigin(variantId, countryCode) {
  try {
    const variantData = await shopifyREST('GET', `/variants/${variantId}.json`);
    const inventoryItemId = variantData?.variant?.inventory_item_id;

    if (!inventoryItemId) {
      console.warn(`⚠️  Could not find inventory_item_id for variant ${variantId}`);
      return false;
    }

    await shopifyREST('PUT', `/inventory_items/${inventoryItemId}.json`, {
      inventory_item: { country_code_of_origin: countryCode }
    });

    console.log(`✅ Country/Region of origin set: ${countryCode}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to set country of origin:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// Build Shopify media input
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
// Handle product creation/update WITH KEY INGREDIENTS
// ─────────────────────────────────────────────
async function handleProductPush(productId, contentHubBaseUrl, chToken) {
  const productEntity = await getEntity(productId, contentHubBaseUrl, chToken);
  const props = productEntity?.properties || {};

  const title = props.ProductName || props.Title || productEntity?.identifier || 'Untitled Product';
  const sku = productEntity?.identifier || String(productId);
  const price = props.Price || '0.00';
  const mapKey = `product-${productId}`;

  // Extract Content Hub fields
  const productTypeField = extractLocalizedText(props.ProductType);
  const countryOfOriginRaw = props.CountryofOrigin;
  const manufacturedBy = extractLocalizedText(props.Manufacturedby);
  const contact = extractLocalizedText(props.Contact);

  console.log(`\n🔎 CONTENT HUB FIELD VALUES`);
  console.log(`   ProductType    VAL: "${productTypeField}"`);
  console.log(`   Manufacturedby VAL: "${manufacturedBy}"`);
  console.log(`   Contact        VAL: "${contact}"`);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎯 Product: ${title}`);
  console.log(`📌 SKU: "${sku}"`);
  console.log(`📌 Entity ID: ${productId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const existingProduct = await findExistingShopifyProduct(mapKey, sku);
  const relatedAssets = await getRelatedAssets(productId, contentHubBaseUrl, chToken);

  // Fetch related Key Ingredients
  const relatedIngredients = await getRelatedIngredients(productId, contentHubBaseUrl, chToken);

  // Extract description
  let description = '';
  if (props.ProductLongDescription) {
    description = extractLocalizedText(props.ProductLongDescription);
  } else if (props.Description) {
    description = extractLocalizedText(props.Description);
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
      console.log(`✅ Product updated`);
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

    // Persist the mapping
    if (shopifyProduct?.id) {
      setMappedProductGid(mapKey, shopifyProduct.id);
    }

    // Set SKU, price, and country of origin
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

          const countryCode = toCountryCode(countryOfOriginRaw);
          if (countryCode) {
            await setInventoryItemCountryOfOrigin(defaultVariant.id, countryCode);
          }
        }
      } catch (variantErr) {
        console.warn('⚠️  Variant update warning:', variantErr.message);
      }
    }

    // Attach images only on new products
    if (isNewProduct && relatedAssets.length > 0) {
      try {
        const mediaInput = buildMediaInput(relatedAssets);
        await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
          productId: shopifyProduct.id,
          media: mediaInput
        });
        console.log(`✅ ${relatedAssets.length} image(s) attached`);
      } catch (mediaErr) {
        console.warn('⚠️  Image attachment failed:', mediaErr.message);
      }
    } else if (!isNewProduct && relatedAssets.length > 0) {
      console.log(`ℹ️  Skipping image attachment on update`);
    }

    // Set metafields
    try {
      await setProductMetafields(
        shopifyProduct.id,
        'custom',
        'content_hub_product_id',
        String(productId),
        'number_integer'
      );
    } catch (metafieldErr) {
      console.warn('⚠️  Could not set Content Hub Product ID metafield:', metafieldErr.message);
    }

    // Set ProductType / Manufacturedby / Contact metafields
    try {
      if (productTypeField) {
        const trimmedType = productTypeField.trim();
        await setProductMetafields(
          shopifyProduct.id,
          'custom',
          'product_type_custom',
          trimmedType,
          'single_line_text_field'
        );
      }

      if (manufacturedBy) {
        const trimmedMfg = manufacturedBy.trim();
        const typeForMfg = trimmedMfg.length > 255 ? 'multi_line_text_field' : 'single_line_text_field';
        await setProductMetafields(
          shopifyProduct.id,
          'custom',
          'manufactured_by',
          trimmedMfg,
          typeForMfg
        );
      }

      if (contact) {
        const trimmedContact = contact.trim();
        await setProductMetafields(
          shopifyProduct.id,
          'custom',
          'contact',
          trimmedContact,
          'multi_line_text_field'
        );
      }
    } catch (metafieldErr) {
      console.warn('⚠️  Could not set additional metafields:', metafieldErr.message);
    }

    // Create/Update Key Ingredient metaobjects, then link them to the product
    const createdIngredientIds = [];
    if (relatedIngredients.length > 0) {
      console.log(`\n🌿 Processing ${relatedIngredients.length} Key Ingredient(s)...`);
      for (const ingredient of relatedIngredients) {
        const metaobject = await createOrUpdateIngredientMetaobject(ingredient);
        if (metaobject?.id) {
          createdIngredientIds.push(metaobject.id);
        }
      }
      console.log(`✅ Created/Updated ${createdIngredientIds.length} Key Ingredient metaobject(s)`);

      // NEW: link metaobjects back to the product's Key Ingredients metafield
      try {
        await setKeyIngredientsMetafield(shopifyProduct.id, createdIngredientIds);
      } catch (linkErr) {
        console.warn('⚠️  Could not link Key Ingredients metafield:', linkErr.message);
      }
    } else {
      console.log('ℹ️  No Key Ingredients found for this product — skipping metafield link');
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
      ingredientsAttached: createdIngredientIds.length,
      keyIngredientMetaobjectIds: createdIngredientIds,
      isUpdate: !!existingProduct,
      productType: productTypeField || null,
      countryOfOrigin: toCountryCode(countryOfOriginRaw) || null,
      manufacturedBy: manufacturedBy || null,
      contact: contact || null
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
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (!imageUrl) {
    throw new Error('Asset has no usable image rendition');
  }

  const existingProduct = await findExistingShopifyProduct(mapKey, sku);

  let description = '';
  const descriptionProp = assetEntity?.properties?.Description;
  if (descriptionProp) {
    description = extractLocalizedText(descriptionProp);
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
      console.log(`✅ Product updated`);
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

    // Persist the mapping
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

    // Attach image only on new products
    if (isNewProduct && imageUrl) {
      try {
        await shopifyGraphQL(PRODUCT_CREATE_MEDIA_MUTATION, {
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
      console.log(`ℹ️  Skipping image attachment on update`);
    }

    // Set Content Hub Asset ID metafield
    try {
      await setProductMetafields(
        shopifyProduct.id,
        'custom',
        'sitecore_content_hub_asset_id',
        String(assetId),
        'number_integer'
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
      isUpdate: !!existingProduct
    };
  } catch (err) {
    console.error('❌ Asset sync failed:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// Main webhook route
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
    console.warn(`⚠️  Duplicate webhook ignored`);
    return res.status(202).json({
      error: 'Webhook already processing',
      message: 'Duplicate webhook call ignored'
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