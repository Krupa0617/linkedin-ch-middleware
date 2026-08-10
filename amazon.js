import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import cors from "cors";
import https from "https";
import crypto from "crypto";

dotenv.config();

const app = express();

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());


/***********************************************************************
 * Environment Variables
 ***********************************************************************/

const {

    //==================================================
    // Sitecore Content Hub
    //==================================================

    CONTENT_HUB_URL,
    CONTENT_HUB_USERNAME,
    CONTENT_HUB_PASSWORD,
    API_SECRET_KEY,

    //==================================================
    // Amazon Seller
    //==================================================

    AMAZON_SELLER_ID = process.env.AMAZON_SELLER_ID,
    AMAZON_MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID,

    //==================================================
    // Login With Amazon
    //==================================================

    LWA_CLIENT_ID = process.env.LWA_CLIENT_ID,
    LWA_CLIENT_SECRET = process.env.LWA_CLIENT_SECRET,
    LWA_REFRESH_TOKEN =  process.env.LWA_REFRESH_TOKEN,

    //==================================================
    // Optional
    //==================================================

    AMAZON_ENV = "PRODUCTION"

} = process.env;


const IS_SANDBOX =
    AMAZON_ENV === "SANDBOX";

/***********************************************************************
 * Amazon API VERSION
 ***********************************************************************/

const AMAZON_API_VERSION = {

    LISTINGS: "2021-08-01",

    PRODUCT_TYPES: "2020-09-01",

    CATALOG: "2022-04-01"

};

/***********************************************************************
 * Amazon Endpoint
 ***********************************************************************/

const AMAZON_ENDPOINTS = {

    NA: "https://sellingpartnerapi-na.amazon.com",

    EU: "https://sellingpartnerapi-eu.amazon.com",

    FE: "https://sellingpartnerapi-fe.amazon.com"

};

/***********************************************************************
 * Marketplace Configuration
 ***********************************************************************/

const MARKETPLACES = {

    IN: {

        id: AMAZON_MARKETPLACE_ID || "A21TJRUUN4KGV",

        endpoint: AMAZON_ENDPOINTS.EU,

        currency: "INR",

        language: "en_IN"

    }

};

const MARKETPLACE = MARKETPLACES.IN;

const MARKETPLACE_ID = MARKETPLACE.id;

const httpsAgent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: true
});

/***********************************************************************
 * Amazon API Base URL
 ***********************************************************************/

const AMAZON_API = IS_SANDBOX
?
"https://sandbox.sellingpartnerapi-eu.amazon.com"
:
MARKETPLACE.endpoint;

/***********************************************************************
 * Amazon HEADERS
 ***********************************************************************/
const AMAZON_HEADERS = {

    "user-agent":
    "SitecoreContentHubAmazonConnector/1.0"

};

/***********************************************************************
 * Login With Amazon Endpoint
 ***********************************************************************/

const LWA_ENDPOINT =
    "https://api.amazon.com/auth/o2/token";

/***********************************************************************
 * Cached Token
 ***********************************************************************/

let amazonAccessToken = null;

let amazonTokenExpiry = 0;

/***********************************************************************
 * Retry Configuration
 ***********************************************************************/

const MAX_RETRY = 3;

const RETRY_DELAY = 2000;

/***********************************************************************
 * Default Headers
 ***********************************************************************/

const DEFAULT_HEADERS = {

    "Content-Type": "application/json",

    Accept: "application/json"

};

/***********************************************************************
 * Product Types
 ***********************************************************************/

const PRODUCT_TYPES = {

    COSMETICS: "BEAUTY",

    MEDICINE: "HEALTH_PERSONAL_CARE",

    SKINCARE: "BEAUTY",

    PERSONAL_CARE: "HEALTH_PERSONAL_CARE",

    DEFAULT: "BEAUTY"

}

/***********************************************************************
 * Utility
 ***********************************************************************/

function sleep(ms) {

    return new Promise(resolve => setTimeout(resolve, ms));

}

function createRequestId() {

    return crypto.randomUUID();

}

function log(title, data = "") {

    console.log(

        `[${new Date().toISOString()}]`,

        title,

        data

    );

}

function getProductType(category) {

    if (!category)
        return PRODUCT_TYPES.DEFAULT;

    const value =
        category.toUpperCase();

    if (value.includes("COSMETIC"))
        return PRODUCT_TYPES.COSMETICS;

    if (value.includes("MEDICINE"))
        return PRODUCT_TYPES.MEDICINE;

    if (value.includes("SKIN"))
        return PRODUCT_TYPES.SKINCARE;

    return PRODUCT_TYPES.DEFAULT;

}

function logError(title, err) {

    console.error(

        `[${new Date().toISOString()}]`,

        title,

        err.response?.data || err.message

    );

}

const requiredVariables = [
    "CONTENT_HUB_URL",
    "CONTENT_HUB_USERNAME",
    "CONTENT_HUB_PASSWORD",
    "API_SECRET_KEY",
    "LWA_CLIENT_ID",
    "LWA_CLIENT_SECRET",
    "LWA_REFRESH_TOKEN",
    "AMAZON_SELLER_ID",
    "AMAZON_MARKETPLACE_ID"
];

const missing = requiredVariables.filter(

    key => !process.env[key]

);

if (missing.length > 0) {

    console.warn("");

    console.warn("====================================================");

    console.warn("Missing Environment Variables");

    console.warn(missing);

    console.warn("====================================================");

    console.warn("");

}

/***********************************************************************
 * MIDDLEWARE: Verify API Key
 ***********************************************************************/

function verifyApiKey(req, res, next) {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_SECRET_KEY) {
        return res.status(401).json({ 
            error: "Unauthorized",
            message: "Missing or invalid x-api-key header"
        });
    }
    next();
}

/***********************************************************************
 * HEALTH CHECK ENDPOINTS
 ***********************************************************************/

// ✅ Simple health check (no auth required for testing connection)
app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        service: "Amazon SP-API + Sitecore Content Hub Connector",
        timestamp: new Date().toISOString()
    });
});

// ✅ Amazon health check endpoint
app.get("/amazon/health", verifyApiKey, (req, res) => {
    res.status(200).json({
        status: "ok",
        endpoint: "/amazon/publish",
        method: "POST",
        description: "Publishes a Content Hub product to Amazon",
        timestamp: new Date().toISOString()
    });
});

// ✅ Amazon connection test (what Content Hub "Test Connection" calls)
app.post("/amazon/", verifyApiKey, async (req, res) => {
    try {
        log("Received /amazon/ test request");
        
        // Test Content Hub connectivity
        if (!CONTENT_HUB_URL) {
            return res.status(400).json({
                success: false,
                error: "Content Hub URL not configured"
            });
        }

        // Test Amazon authentication
        try {
            await getAmazonAccessToken();
        } catch (err) {
            return res.status(500).json({
                success: false,
                error: "Amazon authentication failed",
                message: err.message
            });
        }

        res.status(200).json({
            success: true,
            message: "Connection successful",
            service: "Amazon SP-API Connector",
            ready: true
        });
    } catch (err) {
        logError("/amazon/ test failed", err);
        res.status(500).json({
            success: false,
            error: "Connection test failed",
            message: err.message
        });
    }
});

/***********************************************************************
 * Content Hub Action: HEAD + POST /amazon/publish
 * HEAD: Connection test (Content Hub prerequisite check)
 * POST: Triggered from a Content Hub M.Action button on the Product entity
 * Also handles connection tests when target_id is not present
 ***********************************************************************/

// HEAD request for connection test
app.head("/amazon/publish", verifyApiKey, async (req, res) => {
    try {
        await getAmazonAccessToken(true);
        res.status(200).end();
    } catch (err) {
        res.status(500).end();
    }
});

app.post("/amazon/publish", verifyApiKey, async (req, res) => {

    // Content Hub sends the triggering entity's id via header
    const productId = req.headers.target_id;
      const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

    log("Received /amazon/publish request", { productId, headers: req.headers });

    // ═══════════════════════════════════════════════════════════════
    // HANDLE: Connection Test (no productId = Content Hub test)
    // ═══════════════════════════════════════════════════════════════
    if (!productId) {
        log("Connection test request - validating Amazon connectivity");
        
      
        try {
          
            // Test Amazon authentication
            await getAmazonAccessToken();
            
            log("✅ Connection test passed");
            return res.status(200).json({
                success: true,
                message: "Connection test successful",
                service: "Amazon SP-API Connector",
                ready: true
            });
        } catch (err) {
            logError("Connection test failed - Amazon auth error", err);
            return res.status(500).json({
                success: false,
                error: "Amazon authentication failed",
                message: err.message
            });
        }
    }
      const chToken = await getContentHubToken(sourceSystem);
    if (!chToken) {
      return res.status(500).json({ error: 'Content Hub auth failed' });
    }
      const entity = await getEntity(productId, sourceSystem, chToken);
    const definitionName = extractDefinitionName(entity);
    console.log(`✅ Definition: ${definitionName}`);

    if (!definitionName) {
      return res.status(400).json({ error: 'Could not extract definition name from entity' });
    }

  
    // ═══════════════════════════════════════════════════════════════
    // HANDLE: Actual Product Sync (productId present)
    // ═══════════════════════════════════════════════════════════════
    try {
        let result;
    if (definitionName === 'M.PCM.Product') {
      result = await syncProductToAmazon(productId);
    } else if (definitionName === 'M.Asset') {
      result = await handleAssetPush(productId);
    } else {
      return res.status(400).json({
        error: `Unsupported entity type: ${definitionName}`
      });
    }
       // const result = await syncProductToAmazon(productId);

        res.status(200).json({
            success: true,
            message: `Product ${productId} published to Amazon`,
            result
        });

    } catch (err) {
        logError(`/amazon/publish failed for product ${productId}`, err);

        res.status(500).json({
            success: false,
            error: err.response?.data || err.message
        });
    }
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
// FIX #2: Fetch related assets using Content Hub Query API
// ─────────────────────────────────────────────
async function getRelatedAssets(productId, contentHubBaseUrl, token) {
  try {
    console.log(`📸 Fetching related assets for product ${productId}`);

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


/***********************************************************************
 * Amazon Login With Amazon Authentication
 ***********************************************************************/

async function getAmazonAccessToken(forceRefresh = false) {

    try {

        //---------------------------------------------------------
        // Return cached token
        //---------------------------------------------------------

        if (
            !forceRefresh &&
            amazonAccessToken &&
            Date.now() < amazonTokenExpiry
        ) {

            return amazonAccessToken;

        }


        log("Requesting Amazon Access Token...");

        //---------------------------------------------------------
        // Exchange Refresh Token
        //---------------------------------------------------------

        const response = await axios.post(
            
            LWA_ENDPOINT,

            new URLSearchParams({

                grant_type: "refresh_token",

                refresh_token: LWA_REFRESH_TOKEN,

                client_id: LWA_CLIENT_ID,

                client_secret: LWA_CLIENT_SECRET

            }),

            {
                httpsAgent,
                headers: {

                    "Content-Type":
                        "application/x-www-form-urlencoded"

                },

                timeout: 30000

            }

        );
        console.log(response.data);
        //---------------------------------------------------------
        // Save Token
        //---------------------------------------------------------

        amazonAccessToken = response.data.access_token;

        const expiresIn =
            response.data.expires_in || 3600;

        amazonTokenExpiry =
            Date.now() + ((expiresIn - 60) * 1000);

        log("Amazon Access Token Generated");

        return amazonAccessToken;

    }

    catch (err) {

        logError(

            "Unable to generate Amazon Access Token",

            err

        );

        throw err;

    }

}

async function callAmazonAPI({ method, path, params = {}, data = null }) {
    let attempt = 0;
    console.log(`Calling Amazon API: ${AMAZON_API}  ${method.toUpperCase()} ${path} (attempt ${attempt + 1}/${MAX_RETRY})`);
    while (attempt < MAX_RETRY) {
        try {
            const accessToken = await getAmazonAccessToken();//LWA_REFRESH_TOKEN;

            const response = await axios({
                method,
                url: `${AMAZON_API}${path}`,
                params,
                data,
                httpsAgent,
              headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  "x-amz-access-token": accessToken,
                  Authorization: `Bearer ${accessToken}`
              },
                timeout: 30000
            });

            return response.data;

        } catch (err) {
            attempt++;
            const status = err.response?.status;

            if (status === 401) {
                log("Access token expired, refreshing...");
                await getAmazonAccessToken(true);
                continue;
            }

            if (status === 429 && attempt < MAX_RETRY) {
                log(`Rate limited. Retrying in ${RETRY_DELAY}ms (attempt ${attempt}/${MAX_RETRY})`);
                await sleep(RETRY_DELAY * attempt);
                continue;
            }

            if (attempt >= MAX_RETRY) {
                logError(`Amazon API call failed after ${MAX_RETRY} attempts`, err);
                throw err;
            }

            await sleep(RETRY_DELAY);
        }
    }
}

async function getProductEntity(productId, contentHubBaseUrl, token) {
    const entity = await getEntity(productId, contentHubBaseUrl, token);
    const definitionName = extractDefinitionName(entity);
    const props = entity?.properties || {};

    return {
        id: entity.id,
        identifier: entity.identifier,
        definitionName,
        sku: props.SKU || props.ProductSKU || entity.identifier,
        title: props.Title || props.ProductName || "",
        productType:props.ProductType,
        description: props.Description || props.LongDescription || "",
        bulletPoints: [
            props.BulletPoint1,
            props.BulletPoint2,
            props.BulletPoint3,
            props.BulletPoint4,
            props.BulletPoint5
        ].filter(Boolean),
        brand: props.Brand || "",
        category: props.Category || props.ProductCategory || "",
        price: props.Price || props.ListPrice || null,
        quantity: props.Quantity ?? props.StockQuantity ?? 0
    };
}

function buildListingPayload(product, images = []) {
    const productType = "BABY_PRODUCT";

    const attributes = {
        item_name: [{ value: product.title,  language_tag: "en_IN", marketplace_id: MARKETPLACE_ID }],
        brand: [{ value: "Himalaya", language_tag: "en_IN",marketplace_id: MARKETPLACE_ID }],
          "model_number": [
      {
        "value": product.title,
        "marketplace_id": MARKETPLACE_ID
      }
    ],
        product_description: [{ value: product.description,  language_tag: "en_IN", marketplace_id: MARKETPLACE_ID }],
         bullet_point: [
      {
        value: "Triple action lactation support",
        language_tag: "en_IN",
        marketplace_id: MARKETPLACE_ID
      },
      {
        value: "Contains Shatavari, Shigru (Moringa oleifera) and Saffron",
        language_tag: "en_IN",
        marketplace_id:MARKETPLACE_ID
      },
      {
        value: "200 g pack",
        language_tag: "en_IN",
        marketplace_id:MARKETPLACE_ID
      },
      {
        value: "Elaichi flavor",
        language_tag: "en_IN",
        marketplace_id:MARKETPLACE_ID
      }
    ],
          manufacturer: [
      {
        value: "Himalaya Wellness",
        language_tag: "en_IN",
        marketplace_id: MARKETPLACE_ID
      }
    ],
        externally_assigned_product_identifier: [
      {
        value: "8901234567890",
        type: "ean",
        marketplace_id: MARKETPLACE_ID
      }
    ],
    condition_type: [
      {
        value: "new_new",
        marketplace_id: MARKETPLACE_ID
      }
    ],
        item_weight: [
      {
        value: 200,
        unit: "GR",
        marketplace_id: MARKETPLACE_ID
      }
    ],
        color: [
      {
        value: "Elaichi Flavor",
        language_tag: "en_IN",
        marketplace_id: MARKETPLACE_ID
      }
    ],
        list_price: product.price ? [{
            value: Number(product.price),
            currency: "INR",
            marketplace_id: MARKETPLACE_ID
        }] : undefined,
        fulfillment_availability: [{
            fulfillment_channel_code: "DEFAULT",
            quantity: 10,
            marketplace_id: MARKETPLACE_ID
        }],
         generic_keyword: [
      {
        value: "galactosure lactation support shatavari moringa saffron elaichi",
        language_tag: "en_IN",
        marketplace_id: MARKETPLACE_ID
      }
    ],
    ingredients: [
      {
        value: "Shatavari (Asparagus racemosus), Shigru (Moringa oleifera), Saffron (Crocus sativus)",
        language_tag: "en_IN",
        marketplace_id:MARKETPLACE_ID
      }
    ],
    directions: [
      {
        value: "2 scoops (10 g) twice daily with one glass of milk, or as directed by the physician.",
        language_tag: "en_IN",
        marketplace_id: MARKETPLACE_ID
      }
    ],
        country_of_origin: [
      {
        value: "IN",
        marketplace_id: MARKETPLACE_ID
      }
    ],
    };

    images.forEach((img, index) => {
        const key = index === 0
            ? "main_product_image_locator"
            : `other_product_image_locator_${index}`;

        attributes[key] = [{ media_location: img.imageUrl, marketplace_id: MARKETPLACE_ID }];
    });

    Object.keys(attributes).forEach(key => {
        if (attributes[key] === undefined) delete attributes[key];
    });

    return { productType, attributes };
}

async function pushListingToAmazon(sku, payload) {
    const path = `/listings/${AMAZON_API_VERSION.LISTINGS}/items/${AMAZON_SELLER_ID}/${encodeURIComponent(sku)}`;

    log(`Pushing listing to Amazon: ${sku}`);

    const result = await callAmazonAPI({
        method: "put",
        path,
        params: { marketplaceIds: MARKETPLACE_ID },
        data: {
            productType: payload.productType,
            attributes: payload.attributes
        }
    });

    log("Amazon listing response", result);
    return result;
}

async function syncProductToAmazon(productId) {
    const contentHubToken = await getContentHubToken(CONTENT_HUB_URL);
    if (!contentHubToken) {
        throw new Error("Failed to authenticate with Content Hub");
    }

    const product = await getProductEntity(productId, CONTENT_HUB_URL, contentHubToken);
    const images = await getRelatedAssets(productId, CONTENT_HUB_URL, contentHubToken);
    const payload = buildListingPayload(product, images);
    const amazonResult = await pushListingToAmazon(product.sku, payload);

    return {
        productId,
        sku: product.sku,
        imagesFound: images.length,
        amazon: amazonResult
    };
}

// ─────────────────────────────────────────────
// Handle asset creation/update
// ─────────────────────────────────────────────
async function handleAssetPush(productId) {
const contentHubToken = await getContentHubToken(CONTENT_HUB_URL);
    if (!contentHubToken) {
        throw new Error("Failed to authenticate with Content Hub");
    }
    //------------------------------------------------------
    // Fetch Asset
    //------------------------------------------------------

    const asset = await getEntity(
        productId,
        CONTENT_HUB_URL,
        contentHubToken
    );

    const { title, imageUrl } = extractAssetImage(asset);

    if (!imageUrl) {
        throw new Error("Asset has no usable image.");
    }

    const sku = `hima${productId}`;

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Asset :", title);
    console.log("SKU   :", sku);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    //------------------------------------------------------
    // Description
    //------------------------------------------------------

    let description = "";

    const desc = asset.properties?.Description;

    if (typeof desc === "string") {

        description = desc;

    } else if (desc && typeof desc === "object") {

        description =
            desc["en-US"] ||
            Object.values(desc)[0] ||
            "";

    }

    //------------------------------------------------------
    // Build Amazon Payload
    //------------------------------------------------------

    const payload = {

        productType: PRODUCT_TYPES.DEFAULT,

        attributes: {

            item_name: [{
                value: title,
                marketplace_id: MARKETPLACE_ID
            }],

            brand: [{
                value: "Himalaya Wellness",
                marketplace_id: MARKETPLACE_ID
            }],

            product_description: [{
                value: description,
                marketplace_id: MARKETPLACE_ID
            }],

            main_product_image_locator: [{
                media_location: imageUrl,
                marketplace_id: MARKETPLACE_ID
            }]
        }

    };

    //------------------------------------------------------
    // Push Listing
    //------------------------------------------------------

    const amazonResult =
        await pushListingToAmazon(sku, payload);

    console.log("Amazon Response", amazonResult);

       return {
        entityType: "Asset",
        productId,
        sku,
        title,
        amazonResult
    };

}


app.post("/sync-product/:productId", verifyApiKey, async (req, res) => {
    const { productId } = req.params;

    try {
        const result = await syncProductToAmazon(productId);
        res.status(200).json({ success: true, result });
    } catch (err) {
        logError(`Sync failed for product ${productId}`, err);
        res.status(500).json({
            success: false,
            error: err.response?.data || err.message
        });
    }
});

/***********************************************************************
 * Export for Vercel
 ***********************************************************************/

export default app;
