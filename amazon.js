/***********************************************************************
 * AMAZON SP-API + SITECORE CONTENT HUB
 * Single File Integration
 ***********************************************************************/

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

    AMAZON_SELLER_ID,
    AMAZON_MARKETPLACE_ID,

    //==================================================
    // Login With Amazon
    //==================================================

    LWA_CLIENT_ID,
    LWA_CLIENT_SECRET,
    LWA_REFRESH_TOKEN,

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
"https://sandbox.sellingpartnerapi-na.amazon.com"
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
 * Content Hub Action: /amazon/publish
 * Triggered from a Content Hub M.Action button on the Product entity
 ***********************************************************************/

app.post("/amazon/publish", verifyApiKey, async (req, res) => {

    // Content Hub sends the triggering entity's id via header
    const productId = req.headers.target_id;

    log("Received /amazon/publish request", { productId, headers: req.headers });

    if (!productId) {
        return res.status(400).json({
            success: false,
            error: "Missing target_id header"
        });
    }

    try {
        const result = await syncProductToAmazon(productId);

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

    while (attempt < MAX_RETRY) {
        try {
            const accessToken = await getAmazonAccessToken();

            const response = await axios({
                method,
                url: `${AMAZON_API}${path}`,
                params,
                data,
                httpsAgent,
                headers: {
                    ...DEFAULT_HEADERS,
                    ...AMAZON_HEADERS,
                    "x-amz-access-token": accessToken
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
    const productType = getProductType(product.category);

    const attributes = {
        item_name: [{ value: product.title, marketplace_id: MARKETPLACE_ID }],
        brand: [{ value: product.brand, marketplace_id: MARKETPLACE_ID }],
        product_description: [{ value: product.description, marketplace_id: MARKETPLACE_ID }],
        bullet_point: product.bulletPoints.map(bp => ({
            value: bp,
            marketplace_id: MARKETPLACE_ID
        })),
        list_price: product.price ? [{
            value: Number(product.price),
            currency: MARKETPLACE.currency,
            marketplace_id: MARKETPLACE_ID
        }] : undefined,
        fulfillment_availability: [{
            fulfillment_channel_code: "DEFAULT",
            quantity: product.quantity,
            marketplace_id: MARKETPLACE_ID
        }]
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

function verifyApiKey(req, res, next) {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_SECRET_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
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
