import axios from 'axios';
import pdfParse from 'pdf-parse';

// Global cache for products (valid 1 hour)
let productsCache = null;
let productsCacheTime = 0;
const CACHE_DURATION = 3600000;

const INSTANCE = process.env.CONTENT_HUB_INSTANCE || 'btr-q-001.sitecorecontenthub.cloud';
const API_SECRET = process.env.CH_API_SECRET || 'ch_secret_2027';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ✅ Validate x-api-key header
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_SECRET) {
    console.warn('[PDF Association] Unauthorized - invalid API key:', apiKey);
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    console.log('[PDF Association] Request received');
    console.log('[PDF Association] Body:', JSON.stringify(req.body));

    const { entityId, fileName, instanceUrl } = req.body;

    if (!entityId) {
      console.warn('[PDF Association] No entityId provided');
      return res.status(200).json({ success: false, error: 'No entityId provided' });
    }

    const actualFileName = fileName || 'unknown.pdf';
    const instance = instanceUrl || INSTANCE;

    // Step 1: Get auth token using client credentials
    console.log('[PDF Association] Getting auth token');
    const token = await getAuthToken(instance);

    // Step 2: Download PDF from Content Hub
    console.log(`[PDF Association] Downloading PDF for asset: ${entityId}`);
    const pdfBuffer = await downloadPDFFromContentHub(entityId, token, instance);

    // Step 3: Extract text and metadata
    console.log('[PDF Association] Extracting PDF content');
    const pdfContent = await extractPDFContent(pdfBuffer, actualFileName);

    // Step 4: Get products
    console.log('[PDF Association] Fetching products');
    const products = await getProductsWithCache(token, instance);

    // Step 5: AI-powered matching
    console.log('[PDF Association] Running AI matching');
    const matches = await matchPDFToProducts(pdfContent, products);

    // Step 6: Create relations in Content Hub
    if (matches.length > 0) {
      console.log(`[PDF Association] Creating ${matches.length} relations`);
      await createProductRelations(entityId, matches, token, instance);
    }

    // Step 7: Update asset metadata
    console.log('[PDF Association] Updating asset metadata');
    await updateAssetMetadata(
      entityId,
      {
        'AssociatedProductCount': matches.length,
        'AIConfidenceScore': matches.length > 0 ? matches[0].confidence : 0,
        'LastAssociated': new Date().toISOString()
      },
      token,
      instance
    );

    console.log(`[PDF Association] Success: ${matches.length} products matched`);

    return res.status(200).json({
      success: true,
      assetId: entityId,
      fileName: actualFileName,
      matchCount: matches.length,
      matches: matches.map(m => ({
        productId: m.productId,
        productName: m.productName,
        confidence: m.confidence,
        reason: m.reason
      }))
    });

  } catch (error) {
    console.error('[PDF Association] Error:', error.message);
    // Always return 200 so Content Hub doesn't mark the action as failed
    return res.status(200).json({
      success: false,
      error: error.message,
      fallbackAction: 'manual_review_required'
    });
  }
}

// ============= AUTH =============

async function getAuthToken(instance) {
  try {
    // Try OAuth client credentials first
    const response = await axios.post(
      `https://${instance}/oauth/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CH_CLIENT_ID,
        client_secret: process.env.CH_CLIENT_SECRET
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );
    console.log('[Auth] Got OAuth token');
    return response.data.access_token;
  } catch (oauthError) {
    console.warn('[Auth] OAuth failed, trying username/password:', oauthError.message);

    // Fallback: username/password auth
    const response = await axios.post(
      `https://${instance}/api/authenticate`,
      {
        user_name: process.env.CH_USERNAME,
        password: process.env.CH_PASSWORD,
        disableHtmlEncoding: true
      },
      { timeout: 10000 }
    );
    console.log('[Auth] Got username/password token');
    return response.data.token;
  }
}

// ============= PDF DOWNLOAD =============

async function downloadPDFFromContentHub(assetId, token, instance) {
  // First get the asset details to find the download URL
  const assetRes = await axios.get(
    `https://${instance}/api/v2/entities/${assetId}`,
    {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000
    }
  );

  const asset = assetRes.data;
  console.log('[Download] Asset fetched, looking for file URL');

  // Try renditions first
  const renditions = asset?.renditions;
  let downloadUrl = null;

  if (renditions?.download?.[0]?.href) {
    downloadUrl = renditions.download[0].href;
  } else if (renditions?.original?.[0]?.href) {
    downloadUrl = renditions.original[0].href;
  } else {
    // Fallback: try the file endpoint directly
    downloadUrl = `https://${instance}/api/v2/entities/${assetId}/file`;
  }

  console.log('[Download] Downloading from:', downloadUrl);

  const fileRes = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    headers: { 'Authorization': `Bearer ${token}` },
    timeout: 30000
  });

  return Buffer.from(fileRes.data);
}

// ============= PDF PARSING =============

async function extractPDFContent(pdfBuffer, fileName) {
  try {
    const pdf = await pdfParse(pdfBuffer);
    const text = pdf.text.substring(0, 3000);

    // Extract HIM-XXXX product codes
    const productNumberRegex = /HIM-\d{4}/g;
    const foundProductNumbers = text.match(productNumberRegex) || [];
    const keywords = extractKeywords(text);

    return {
      fileName,
      text,
      pages: pdf.numpages,
      productNumbers: [...new Set(foundProductNumbers)],
      keywords,
      metadata: {
        title: pdf.info?.Title || '',
        author: pdf.info?.Author || '',
        subject: pdf.info?.Subject || ''
      }
    };
  } catch (error) {
    throw new Error(`Failed to parse PDF: ${error.message}`);
  }
}

function extractKeywords(text) {
  const words = text
    .toLowerCase()
    .split(/[\s\n,\.;:!?()]+/)
    .filter(w => w.length > 4 && w.length < 30)
    .filter(w => !/^[\d\-_]+$/.test(w))
    .slice(0, 25);
  return [...new Set(words)];
}

// ============= PRODUCTS =============

async function getProductsWithCache(token, instance) {
  const now = Date.now();
  if (productsCache && (now - productsCacheTime) < CACHE_DURATION) {
    console.log('[Cache] Using cached products');
    return productsCache;
  }

  console.log('[Cache] Fetching fresh products');
  const response = await axios.get(
    `https://${instance}/api/v2/entities`,
    {
      params: {
        query: 'definition.name==\'M.Product\'',
        take: 1000,
        skip: 0
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  const items = response.data?.items || [];
  const products = items.map(item => {
    const nameProperty = item.properties?.find(p => p.name === 'ProductName' || p.name === 'Name');
    return {
      id: item.id,
      name: nameProperty?.value || item.identifier || 'Unknown',
      entityId: item.id
    };
  });

  productsCache = products;
  productsCacheTime = now;
  console.log(`[Cache] Cached ${products.length} products`);
  return products;
}

// ============= AI MATCHING =============

async function matchPDFToProducts(pdfContent, products) {
  // Strategy 1: Direct product code match
  if (pdfContent.productNumbers.length > 0) {
    const directMatches = products.filter(p =>
      pdfContent.productNumbers.some(num => p.name?.includes(num) || String(p.id) === num)
    );
    if (directMatches.length > 0) {
      console.log(`[Matching] ${directMatches.length} direct matches`);
      return directMatches.map(m => ({
        productId: m.id,
        productName: m.name,
        confidence: 0.99,
        reason: `Product code found in PDF: ${pdfContent.productNumbers.join(', ')}`
      }));
    }
  }

  // Strategy 2: OpenAI semantic matching
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[Matching] No OpenAI key, skipping AI match');
    return [];
  }

  console.log('[Matching] Using OpenAI for semantic matching');
  const productList = products.slice(0, 200).map((p, i) => `${i + 1}. ID:${p.id} Name:${p.name}`).join('\n');

  const prompt = `You are a product catalog expert for Himalaya Wellness. Match this PDF to products.

PDF File: "${pdfContent.fileName}"
PDF Text (first 3000 chars):
${pdfContent.text}

Keywords: ${pdfContent.keywords.join(', ')}

Products:
${productList}

Return ONLY a JSON array, no markdown. Only include matches with confidence > 0.7.
Format: [{"productId": 123, "confidence": 0.95, "reason": "reason"}]`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4-turbo-preview',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 800
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    let content = response.data.choices[0].message.content.trim();
    content = content.replace(/```json|```/g, '').trim();
    const matches = JSON.parse(content);

    return matches.map(m => ({
      ...m,
      productName: products.find(p => p.id == m.productId)?.name || 'Unknown Product'
    }));
  } catch (error) {
    console.error('[OpenAI Error]:', error.message);
    return [];
  }
}

// ============= RELATIONS =============

async function createProductRelations(assetId, matches, token, instance) {
  for (const match of matches) {
    try {
      await axios.post(
        `https://${instance}/api/v2/entities/${match.productId}/relations/ProductToAsset`,
        {
          parent: { id: match.productId },
          child: { id: assetId }
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000
        }
      );
      console.log(`[Relation] Created: Product ${match.productId} → Asset ${assetId}`);
    } catch (err) {
      console.warn(`[Relation] Failed for ${match.productId}:`, err.message);
    }
  }
}

// ============= METADATA =============

async function updateAssetMetadata(assetId, metadata, token, instance) {
  try {
    // Get current entity first to get culture info
    const entityRes = await axios.get(
      `https://${instance}/api/v2/entities/${assetId}`,
      { headers: { 'Authorization': `Bearer ${token}` }, timeout: 8000 }
    );

    const properties = entityRes.data.properties || [];

    // Merge new metadata
    Object.entries(metadata).forEach(([key, value]) => {
      const existing = properties.find(p => p.name === key);
      if (existing) {
        existing.value = value;
      } else {
        properties.push({ name: key, value });
      }
    });

    await axios.put(
      `https://${instance}/api/v2/entities/${assetId}`,
      { properties },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      }
    );
    console.log(`[Metadata] Updated for ${assetId}`);
  } catch (err) {
    console.warn('[Metadata] Failed:', err.message);
  }
}