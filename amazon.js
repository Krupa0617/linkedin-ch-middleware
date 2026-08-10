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
    CONTENT_HUB_URL,
    CONTENT_HUB_USERNAME,
    CONTENT_HUB_PASSWORD,
    API_SECRET_KEY,

    AMAZON_SELLER_ID = process.env.AMAZON_SELLER_ID,
    AMAZON_MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID,

    LWA_CLIENT_ID = process.env.LWA_CLIENT_ID,
    LWA_CLIENT_SECRET = process.env.LWA_CLIENT_SECRET,
    LWA_REFRESH_TOKEN = process.env.LWA_REFRESH_TOKEN,

    AMAZON_ENV = "PRODUCTION"

} = process.env;


const IS_SANDBOX = AMAZON_ENV === "SANDBOX";

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
        // NOTE: fixed — was `AMAZON_MARKETPLACE_ID || MARKETPLACE_ID`, which
        // referenced MARKETPLACE_ID before it exists (TDZ). It only worked
        // because AMAZON_MARKETPLACE_ID is truthy in your env, so the
        // right-hand side was never evaluated. Still fragile — fixed properly.
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

const AMAZON_API = IS_SANDBOX
    ? "https://sandbox.sellingpartnerapi-eu.amazon.com"
    : MARKETPLACE.endpoint;

const LWA_ENDPOINT = "https://api.amazon.com/auth/o2/token";

let amazonAccessToken = null;
let amazonTokenExpiry = 0;

const MAX_RETRY = 3;
const RETRY_DELAY = 2000;

const PRODUCT_TYPES = {
    COSMETICS: "BEAUTY",
    MEDICINE: "HEALTH_PERSONAL_CARE",
    SKINCARE: "BEAUTY",
    PERSONAL_CARE: "HEALTH_PERSONAL_CARE",
    DEFAULT: "BEAUTY"
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(title, data = "") {
    console.log(`[${new Date().toISOString()}]`, title, data);
}

function logError(title, err) {
    console.error(`[${new Date().toISOString()}]`, title, err.response?.data || err.message);
}

const requiredVariables = [
    "CONTENT_HUB_URL", "CONTENT_HUB_USERNAME", "CONTENT_HUB_PASSWORD", "API_SECRET_KEY",
    "LWA_CLIENT_ID", "LWA_CLIENT_SECRET", "LWA_REFRESH_TOKEN", "AMAZON_SELLER_ID", "AMAZON_MARKETPLACE_ID"
];

const missing = requiredVariables.filter(key => !process.env[key]);
if (missing.length > 0) {
    console.warn("\n====================================================");
    console.warn("Missing Environment Variables", missing);
    console.warn("====================================================\n");
}

function verifyApiKey(req, res, next) {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_SECRET_KEY) {
        return res.status(401).json({ error: "Unauthorized", message: "Missing or invalid x-api-key header" });
    }
    next();
}

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", service: "Amazon SP-API + Sitecore Content Hub Connector", timestamp: new Date().toISOString() });
});

app.get("/amazon/health", verifyApiKey, (req, res) => {
    res.status(200).json({ status: "ok", endpoint: "/amazon/publish", method: "POST", timestamp: new Date().toISOString() });
});

app.post("/amazon/", verifyApiKey, async (req, res) => {
    try {
        log("Received /amazon/ test request");
        if (!CONTENT_HUB_URL) return res.status(400).json({ success: false, error: "Content Hub URL not configured" });
        try {
            await getAmazonAccessToken();
        } catch (err) {
            return res.status(500).json({ success: false, error: "Amazon authentication failed", message: err.message });
        }
        res.status(200).json({ success: true, message: "Connection successful", ready: true });
    } catch (err) {
        logError("/amazon/ test failed", err);
        res.status(500).json({ success: false, error: "Connection test failed", message: err.message });
    }
});

app.head("/amazon/publish", verifyApiKey, async (req, res) => {
    try {
        await getAmazonAccessToken(true);
        res.status(200).end();
    } catch (err) {
        res.status(500).end();
    }
});

app.post("/amazon/publish", verifyApiKey, async (req, res) => {
    const productId = req.headers.target_id;
    const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;
    // NOTE: still flagging — sourceSystem from a header means anyone who has
    // your x-api-key can redirect where your Content Hub credentials get
    // POSTed. Worth allowlisting to CONTENT_HUB_URL only when you get a
    // chance, separate from the current listing issue.

    log("Received /amazon/publish request", { productId });

    if (!productId) {
        try {
            await getAmazonAccessToken();
            return res.status(200).json({ success: true, message: "Connection test successful", ready: true });
        } catch (err) {
            logError("Connection test failed - Amazon auth error", err);
            return res.status(500).json({ success: false, error: "Amazon authentication failed", message: err.message });
        }
    }

    try {
        const chToken = await getContentHubToken(sourceSystem);
        if (!chToken) return res.status(500).json({ error: 'Content Hub auth failed' });

        const entity = await getEntity(productId, sourceSystem, chToken);
        const definitionName = extractDefinitionName(entity);
        log(`Definition: ${definitionName}`);

        if (!definitionName) {
            return res.status(400).json({ error: 'Could not extract definition name from entity' });
        }

        let result;
        if (definitionName === 'M.PCM.Product') {
            result = await syncProductToAmazon(productId);
        } else if (definitionName === 'M.Asset') {
            result = await handleAssetPush(productId);
        } else {
            return res.status(400).json({ error: `Unsupported entity type: ${definitionName}` });
        }

        // Surface Amazon-side rejections as failures instead of masking as 200 success.
        if (result?.amazon?.status === "INVALID" || result?.amazon?.status === "REJECTED") {
            return res.status(422).json({
                success: false,
                message: `Amazon rejected the listing for product ${productId}`,
                issues: result.amazon.issues,
                result
            });
        }

        res.status(200).json({ success: true, message: `Product ${productId} published to Amazon`, result });

    } catch (err) {
        logError(`/amazon/publish failed for product ${productId}`, err);
        res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});

// ─────────────────────────────────────────────
// Content Hub helpers (unchanged)
// ─────────────────────────────────────────────

async function getContentHubToken(contentHubBaseUrl) {
    try {
        const response = await axios.post(
            `${contentHubBaseUrl}/api/authenticate`,
            { user_name: CONTENT_HUB_USERNAME, password: CONTENT_HUB_PASSWORD },
            { headers: { 'Content-Type': 'application/json' } }
        );
        const token = response.data.token || response.data.access_token || response.data;
        if (typeof token !== 'string' || token.trim().length === 0) return null;
        return token;
    } catch (err) {
        console.error('❌ Content Hub auth failed:', err.response?.status, err.message);
        return null;
    }
}

async function getEntity(entityId, contentHubBaseUrl, token) {
    const response = await axios.get(
        `${contentHubBaseUrl}/api/entities/${entityId}`,
        { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
    );
    return response.data;
}

function extractDefinitionName(entity) {
    if (!entity?.entitydefinition?.href) return null;
    const match = entity.entitydefinition.href.match(/\/entitydefinitions\/(.+?)($|\/)/);
    return match ? match[1] : null;
}

function extractAssetImage(entity) {
    const props = entity?.properties || {};
    const title = props.Title || props.FileName || entity?.identifier || null;
    let imageUrl = null;
    const renditions = entity?.renditions;
    if (renditions && typeof renditions === 'object') {
        imageUrl = renditions.downloadOriginal?.[0]?.href || renditions.downloadOriginal?.[0]?.url || null;
    }
    return { title, imageUrl };
}

async function getRelatedAssets(productId, contentHubBaseUrl, token) {
    try {
        const query = `Definition.Name=='M.Asset' AND Parent('PCMProductToAsset').id==${productId}`;
        const response = await axios.get(`${contentHubBaseUrl}/api/entities/query`, {
            params: { query },
            headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
            timeout: 10000
        });
        const assetEntities = response.data?.items || [];
        if (assetEntities.length === 0) return [];

        const imageAssets = [];
        for (const asset of assetEntities) {
            const { title, imageUrl } = extractAssetImage(asset);
            if (imageUrl) imageAssets.push({ id: asset.id, title, imageUrl });
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
        if (!forceRefresh && amazonAccessToken && Date.now() < amazonTokenExpiry) {
            return amazonAccessToken;
        }
        const response = await axios.post(
            LWA_ENDPOINT,
            new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: LWA_REFRESH_TOKEN,
                client_id: LWA_CLIENT_ID,
                client_secret: LWA_CLIENT_SECRET
            }),
            { httpsAgent, headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000 }
        );
        amazonAccessToken = response.data.access_token;
        const expiresIn = response.data.expires_in || 3600;
        amazonTokenExpiry = Date.now() + ((expiresIn - 60) * 1000);
        return amazonAccessToken;
    } catch (err) {
        logError("Unable to generate Amazon Access Token", err);
        throw err;
    }
}

async function callAmazonAPI({ method, path, params = {}, data = null }) {
    let attempt = 0;
    while (attempt < MAX_RETRY) {
        try {
            const accessToken = await getAmazonAccessToken();
            log(`Calling Amazon API: ${method.toUpperCase()} ${path} (attempt ${attempt + 1}/${MAX_RETRY})`);
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
                await getAmazonAccessToken(true);
                continue;
            }
            if (status === 429 && attempt < MAX_RETRY) {
                await sleep(RETRY_DELAY * attempt);
                continue;
            }
            if ((status === 400 || status === 422) || attempt >= MAX_RETRY) {
                logError(`Amazon API call failed`, err);
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
        sku: (props.SKU || props.ProductSKU || entity.identifier || "").toString().trim(),

        // Core content
        title: props.Title || props.ProductName || "",
        description: props.Description || props.LongDescription || "",
        bulletPoints: [
            props.BulletPoint1, props.BulletPoint2, props.BulletPoint3,
            props.BulletPoint4, props.BulletPoint5
        ].filter(Boolean),
        brand: props.Brand || "Himalaya",
        manufacturer: props.Manufacturer || "Himalaya Wellness Company",
        category: props.Category || props.ProductCategory || "",

        // Commerce
        price: props.Price || props.ListPrice || null,
        quantity: props.Quantity ?? props.StockQuantity ?? 0,

        // Identifiers
        gtin: props.GTIN || props.EAN || props.UPC || null,
        gtinType: props.GTINType || "EAN",
        // Only set this if THIS product is meant to attach to a known
        // existing ASIN. Leave null for a genuinely new product.
        suggestedAsin: props.SuggestedASIN || props.ExistingASIN || null,

        // Nutritional-supplement-specific fields — map these to whatever
        // Content Hub actually calls them, falling back to safe defaults.
        flavor: props.Flavor || null,
        itemForm: props.ItemForm || "Granules",
        ingredients: props.Ingredients || "",
        specialIngredients: props.SpecialIngredients || props.KeyIngredients || "",
        servingRecommendation: props.ServingRecommendation || props.Directions || "",
        vegStatus: props.VegStatus || props.DietaryPreference || "vegetarian", // "vegetarian" | "non_vegetarian"
        isExpirationDated: props.IsExpirationDated ?? true,
        shelfLifeMonths: props.ShelfLifeMonths || 24,
        containsFoodOrBeverage: props.ContainsFoodOrBeverage ?? false,
        isHeatSensitive: props.IsHeatSensitive ?? false,
        containsLiquidContents: props.ContainsLiquidContents ?? false,

        // Physical attributes
        unitCountValue: props.UnitCountValue || props.NetContentValue || null,
        weightGrams: props.WeightGrams || props.NetWeightGrams || null,
        packageWeightGrams: props.PackageWeightGrams || null,
        dimensionsCm: {
            height: props.HeightCm || null,
            length: props.LengthCm || null,
            width: props.WidthCm || null
        },
        packageDimensionsCm: {
            height: props.PackageHeightCm || null,
            length: props.PackageLengthCm || null,
            width: props.PackageWidthCm || null
        },

        // Compliance/contact
        countryOfOrigin: props.CountryOfOrigin || "IN",
        manufacturerContactInfo: props.ManufacturerContactInfo ||
            "Himalaya Wellness Company, Makali, Bengaluru - 562162, Karnataka, India",
        packerContactInfo: props.PackerContactInfo || props.ManufacturerContactInfo ||
            "Himalaya Wellness Company, Makali, Bengaluru - 562162, Karnataka, India",

        genericKeywords: props.GenericKeywords || props.SearchKeywords || ""
    };
}

/***********************************************************************
 * FIXED: buildListingPayload — offer-only mode
 *
 * This product (galactosure) is confirmed the same physical product as
 * the existing ASIN B0FQCL31HV. All 13 errors from the last log
 * (Item Weight Unit, Unit Count, fssai_veg_non_veg_status, dimension
 * units, Fulfillment Center Shelf Life, External Product ID/Information,
 * Product Expiration Type, Merchant Suggested ASIN) were all "new
 * catalog product" requirements — none of them apply once you tell
 * Amazon you're only submitting an OFFER against an EXISTING ASIN.
 ***********************************************************************/

function buildListingPayload(product, images = []) {
    const productType = "NUTRITIONAL_SUPPLEMENT";
    const lang = "en_IN";
    const mid = MARKETPLACE_ID;

    // ── Attaching to a known existing ASIN — offer only ──────────────
    if (product.suggestedAsin) {
        const attributes = {
            merchant_suggested_asin: [{ value: product.suggestedAsin, marketplace_id: mid }],
            condition_type: [{ value: "new_new", marketplace_id: mid }],
            fulfillment_availability: [{
                fulfillment_channel_code: "DEFAULT",
                quantity: product.quantity ?? 10,
                marketplace_id: mid
            }]
        };
        if (product.price) {
            attributes.list_price = [{ value: Number(product.price), currency: "INR", marketplace_id: mid }];
        }
        images.forEach((img, index) => {
            const key = index === 0 ? "main_offer_image_locator" : `other_offer_image_locator_${index}`;
            attributes[key] = [{ media_location: img.imageUrl, marketplace_id: mid }];
        });
        return { productType, requirements: "LISTING_OFFER_ONLY", attributes };
    }

    // ── Genuinely new product — full catalog creation ────────────────
    if (!product.sku) throw new Error("Product is missing a SKU.");
    if (!product.title) throw new Error("Product is missing a title.");

    const attributes = {
        item_name: [{ value: product.title, language_tag: lang, marketplace_id: mid }],
        brand: [{ value: product.brand, language_tag: lang, marketplace_id: mid }],
        manufacturer: [{ value: product.manufacturer, language_tag: lang, marketplace_id: mid }],
        model_number: [{ value: product.sku, language_tag: lang, marketplace_id: mid }],
        part_number: [{ value: product.sku, language_tag: lang, marketplace_id: mid }],

        product_description: [{ value: product.description, language_tag: lang, marketplace_id: mid }],
        bullet_point: (product.bulletPoints.length ? product.bulletPoints : [product.description]).map(bp => ({
            value: bp, language_tag: lang, marketplace_id: mid
        })),
        generic_keyword: product.genericKeywords
            ? [{ value: product.genericKeywords, language_tag: lang, marketplace_id: mid }]
            : undefined,

        item_type_name: [{ value: product.category || "Nutritional Supplement", language_tag: lang, marketplace_id: mid }],
        item_form: [{ value: product.itemForm, language_tag: lang, marketplace_id: mid }],
        flavor: product.flavor ? [{ value: product.flavor, language_tag: lang, marketplace_id: mid }] : undefined,

        number_of_items: [{ value: 1, language_tag: lang,marketplace_id: mid }],
        item_package_quantity: [{ value: 1, language_tag: lang,marketplace_id: mid }],

        ingredients: product.ingredients
            ? [{ value: product.ingredients, language_tag: lang, marketplace_id: mid }] : undefined,
        special_ingredients: product.specialIngredients
            ? [{ value: product.specialIngredients, language_tag: lang, marketplace_id: mid }] : undefined,
        serving_recommendation: product.servingRecommendation
            ? [{ value: product.servingRecommendation, language_tag: lang, marketplace_id: mid }] : undefined,

        contains_food_or_beverage: [{ value: !!product.containsFoodOrBeverage, marketplace_id: mid }],
        is_heat_sensitive: [{ value: !!product.isHeatSensitive, language_tag: lang,marketplace_id: mid }],
        is_expiration_dated_product: [{ value: !!product.isExpirationDated, language_tag: lang,marketplace_id: mid }],
        product_expiration_type: [{ value: "expiration_dated", language_tag: lang,marketplace_id: mid }], // verify enum via schema
        fssai_veg_non_veg_status: [{ value: product.vegStatus, language_tag: lang,marketplace_id: mid }], // verify enum via schema
        fc_shelf_life: [{ value: product.shelfLifeMonths, unit: "months", language_tag: lang,marketplace_id: mid }], // verify unit enum

        packer_contact_information: [{ value: product.packerContactInfo, language_tag: lang, marketplace_id: mid }],
        rtip_manufacturer_contact_information: [{ value: product.manufacturerContactInfo, language_tag: lang, marketplace_id: mid }],

        country_of_origin: [{ value: product.countryOfOrigin, language_tag: lang,marketplace_id: mid }],
        contains_liquid_contents: [{ value: !!product.containsLiquidContents, language_tag: lang,marketplace_id: mid }],

        condition_type: [{ value: "new_new", language_tag: lang,marketplace_id: mid }],
        fulfillment_availability: [{
            fulfillment_channel_code: "DEFAULT",
            quantity: product.quantity ?? 10,
            language_tag: lang,
            marketplace_id: mid
        }]
    };

    // Identifiers — GTIN if present, otherwise exemption flag.
    if (product.gtin) {
        attributes.externally_assigned_product_identifier = [
            { value: product.gtin, type: product.gtinType,language_tag: lang, marketplace_id: mid }
        ];
    } else {
        attributes.supplier_declared_has_product_identifier_exemption = [{ value: true, language_tag: lang, marketplace_id: mid }];
        log(`⚠️ No GTIN for SKU ${product.sku} — declaring identifier exemption. Confirm this is actually approved for this brand/category.`);
    }

    if (product.price) {
        attributes.list_price = [{ value: Number(product.price), currency: "INR", language_tag: lang, marketplace_id: mid }];
    }

    // Physical dimensions — only include if Content Hub actually has them,
    // otherwise Amazon will reject with placeholder/fake values anyway.
    if (product.weightGrams) {
        attributes.item_weight = [{ value: product.weightGrams, unit: "grams", language_tag: lang, marketplace_id: mid }];
    }
    if (product.packageWeightGrams) {
        attributes.item_package_weight = [{ value: product.packageWeightGrams, unit: "grams", language_tag: lang, marketplace_id: mid }];
    }
    if (product.unitCountValue) {
        attributes.unit_count = [{ value: product.unitCountValue, type: "grams", language_tag: lang, marketplace_id: mid }]; // verify "type" enum
    }
    const d = product.dimensionsCm;
    if (d.height && d.length && d.width) {
        attributes.item_dimensions = [{
            height: { value: d.height, unit: "centimeters" },
            length: { value: d.length, unit: "centimeters" },
            width: { value: d.width, unit: "centimeters" },
            language_tag: lang,
            marketplace_id: mid
        }];
    }
    const pd = product.packageDimensionsCm;
    if (pd.height && pd.length && pd.width) {
        attributes.item_package_dimensions = [{
            height: { value: pd.height, unit: "centimeters" },
            length: { value: pd.length, unit: "centimeters" },
            width: { value: pd.width, unit: "centimeters" },
            language_tag: lang,
            marketplace_id: mid
        }];
    }

    images.forEach((img, index) => {
        const key = index === 0 ? "main_product_image_locator" : `other_product_image_locator_${index}`;
        attributes[key] = [{ media_location: img.imageUrl, language_tag: lang, marketplace_id: mid }];
    });

    Object.keys(attributes).forEach(key => {
        if (attributes[key] === undefined) delete attributes[key];
    });

    return { productType, requirements: "LISTING", attributes };
}

async function pushListingToAmazon(sku, payload) {
    const path = `/listings/${AMAZON_API_VERSION.LISTINGS}/items/${AMAZON_SELLER_ID}/${encodeURIComponent(sku)}`;

    log(`Pushing listing to Amazon: ${sku} (requirements: ${payload.requirements})`);

    const result = await callAmazonAPI({
        method: "put",
        path,
        params: { marketplaceIds: MARKETPLACE_ID, issueLocale: "en_IN" },
        data: {
            productType: payload.productType,
            requirements: payload.requirements,
            attributes: payload.attributes
        }
    });

    log("Amazon listing response", result);
    if (result?.issues?.length) log(`⚠️ ${result.issues.length} issue(s) for ${sku}`, result.issues);
    return result;
}

async function syncProductToAmazon(productId) {
    const contentHubToken = await getContentHubToken(CONTENT_HUB_URL);
    if (!contentHubToken) throw new Error("Failed to authenticate with Content Hub");

    const product = await getProductEntity(productId, CONTENT_HUB_URL, contentHubToken);
    const images = await getRelatedAssets(productId, CONTENT_HUB_URL, contentHubToken);
    const payload = buildListingPayload(product, images);
    const amazonResult = await pushListingToAmazon(product.sku, payload);

    return { productId, sku: product.sku, imagesFound: images.length, amazon: amazonResult };
}

async function handleAssetPush(productId) {
    const contentHubToken = await getContentHubToken(CONTENT_HUB_URL);
    if (!contentHubToken) throw new Error("Failed to authenticate with Content Hub");

    const asset = await getEntity(productId, CONTENT_HUB_URL, contentHubToken);
    const { title, imageUrl } = extractAssetImage(asset);
    if (!imageUrl) throw new Error("Asset has no usable image.");

    const sku = `hima${productId}`;
    let description = "";
    const desc = asset.properties?.Description;
    if (typeof desc === "string") description = desc;
    else if (desc && typeof desc === "object") description = desc["en-US"] || Object.values(desc)[0] || "";

    const payload = {
        productType: PRODUCT_TYPES.DEFAULT,
        attributes: {
            item_name: [{ value: title, marketplace_id: MARKETPLACE_ID }],
            brand: [{ value: "Himalaya Wellness", marketplace_id: MARKETPLACE_ID }],
            product_description: [{ value: description, marketplace_id: MARKETPLACE_ID }],
            main_product_image_locator: [{ media_location: imageUrl, marketplace_id: MARKETPLACE_ID }]
        }
    };

    const amazonResult = await pushListingToAmazon(sku, payload);
    return { entityType: "Asset", productId, sku, title, amazonResult };
}

app.post("/sync-product/:productId", verifyApiKey, async (req, res) => {
    const { productId } = req.params;
    try {
        const result = await syncProductToAmazon(productId);
        res.status(200).json({ success: true, result });
    } catch (err) {
        logError(`Sync failed for product ${productId}`, err);
        res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});

export default app;
