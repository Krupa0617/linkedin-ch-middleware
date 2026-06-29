import axios from 'axios';
import pdfParse from 'pdf-parse';
import fetch from 'node-fetch';

// Global cache for products (valid 1 hour)
let productsCache = null;
let productsCacheTime = 0;
const CACHE_DURATION = 3600000; // 1 hour

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('[PDF Association] Request received');
    
    const {
      entity,
      entityId,
      assetId,
      fileName,
      fileId,
      contentHubToken,
      instanceUrl
    } = req.body;

    // Extract actual asset ID from Content Hub context
    const actualAssetId = entityId || assetId || entity?.id;
    const actualFileName = fileName || entity?.properties?.find(p => p.name === 'FileName')?.value || 'unknown.pdf';

    if (!actualAssetId) {
      console.warn('[PDF Association] No asset ID provided');
      return res.status(400).json({ 
        success: false, 
        error: 'No asset ID provided' 
      });
    }

    // Step 1: Download PDF from Content Hub
    console.log(`[PDF Association] Downloading PDF: ${actualAssetId}`);
    const pdfBuffer = await downloadPDFFromContentHub(
      actualAssetId,
      contentHubToken
    );

    // Step 2: Extract text and metadata
    console.log('[PDF Association] Extracting PDF content');
    const pdfContent = await extractPDFContent(pdfBuffer, actualFileName);

    // Step 3: Get products from cache or API
    console.log('[PDF Association] Fetching products');
    const products = await getProductsWithCache(contentHubToken);

    // Step 4: AI-powered matching
    console.log('[PDF Association] Running AI matching');
    const matches = await matchPDFToProducts(pdfContent, products);

    // Step 5: Create relations in Content Hub
    if (matches.length > 0) {
      console.log(`[PDF Association] Creating ${matches.length} relations`);
      await createProductRelations(actualAssetId, matches, contentHubToken);
    }

    // Step 6: Update asset metadata
    console.log('[PDF Association] Updating asset metadata');
    await updateAssetMetadata(
      actualAssetId,
      {
        'Associated Product Count': matches.length,
        'AI Confidence Score': matches.length > 0 ? matches[0].confidence : 0,
        'Last Associated': new Date().toISOString()
      },
      contentHubToken
    );

    console.log(`[PDF Association] Success: ${matches.length} products matched`);

    return res.status(200).json({
      success: true,
      assetId: actualAssetId,
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
    console.error('[PDF Association] Error:', error);
    
    // Always return 200 so Content Hub doesn't fail the task
    return res.status(200).json({
      success: false,
      error: error.message,
      fallbackAction: 'manual_review_required'
    });
  }
}

// ============= HELPER FUNCTIONS =============

async function downloadPDFFromContentHub(assetId, token) {
  const instance = process.env.CONTENT_HUB_INSTANCE || 'hmme-d-001.sitecorecontenthub.cloud';
  
  const response = await axios.get(
    `https://${instance}/api/v2/entities/${assetId}/file`,
    {
      responseType: 'arraybuffer',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Request-Id': `pdf-assoc-${Date.now()}`
      },
      timeout: 15000
    }
  );

  return Buffer.from(response.data);
}

async function extractPDFContent(pdfBuffer, fileName) {
  try {
    const pdf = await pdfParse(pdfBuffer);
    
    // Extract text from first 3 pages only to save tokens
    const text = pdf.text.substring(0, 3000);
    
    // Extract numbers in HIM-XXXX format (product IDs)
    const productNumberRegex = /HIM-\d{4}/g;
    const foundProductNumbers = text.match(productNumberRegex) || [];
    
    // Extract common product keywords
    const keywords = extractKeywords(text);

    return {
      fileName: fileName,
      text: text,
      pages: pdf.numpages,
      productNumbers: [...new Set(foundProductNumbers)], // Remove duplicates
      keywords: keywords,
      metadata: {
        title: pdf.info?.Title || '',
        author: pdf.info?.Author || '',
        subject: pdf.info?.Subject || ''
      }
    };
  } catch (error) {
    console.error('PDF parsing error:', error);
    throw new Error(`Failed to parse PDF: ${error.message}`);
  }
}

function extractKeywords(text) {
  // Split by common separators and filter
  const words = text
    .toLowerCase()
    .split(/[\s\n,\.\;:!?()]+/)
    .filter(word => word.length > 4 && word.length < 30)
    .filter(word => !/^[\d\-_]+$/.test(word)) // Skip numbers
    .slice(0, 25);

  return [...new Set(words)]; // Remove duplicates
}

async function getProductsWithCache(token) {
  const now = Date.now();

  // Return cached if still valid
  if (productsCache && (now - productsCacheTime) < CACHE_DURATION) {
    console.log('[Cache] Using cached products');
    return productsCache;
  }

  console.log('[Cache] Fetching fresh products');
  const instance = process.env.CONTENT_HUB_INSTANCE || 'hmme-d-001.sitecorecontenthub.cloud';

  const response = await axios.get(
    `https://${instance}/api/v2/entities`,
    {
      params: {
        query: 'entitydefinition: M.Product AND name: *',
        limit: 1000,
        select: 'id,name'
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );

  const products = response.data.items.map(item => {
    const nameProperty = item.properties?.find(p => p.name === 'Name');
    return {
      id: item.id,
      name: nameProperty?.value || 'Unknown',
      entityId: item.id
    };
  });

  // Update cache
  productsCache = products;
  productsCacheTime = now;

  console.log(`[Cache] Cached ${products.length} products`);
  return products;
}

async function matchPDFToProducts(pdfContent, products) {
  // STRATEGY 1: Direct product number matching (highest priority)
  if (pdfContent.productNumbers.length > 0) {
    const directMatches = products.filter(p =>
      pdfContent.productNumbers.includes(p.id)
    );

    if (directMatches.length > 0) {
      console.log(`[Matching] Found ${directMatches.length} direct product number matches`);
      return directMatches.map(m => ({
        productId: m.id,
        productName: m.name,
        confidence: 0.99,
        reason: `Product ID found in PDF: ${pdfContent.productNumbers.join(', ')}`
      }));
    }
  }

  // STRATEGY 2: LLM-based semantic matching
  console.log('[Matching] Using LLM for semantic matching');
  
  const productList = products
    .map((p, idx) => `${idx + 1}. ${p.id}: ${p.name}`)
    .join('\n');

  const prompt = `You are a product catalog expert for Himalaya Wellness. Match the given PDF to our product catalog.

PDF File Name: "${pdfContent.fileName}"
PDF Content (first 3000 chars): 
${pdfContent.text}

PDF Keywords: ${pdfContent.keywords.join(', ')}

Our Products:
${productList}

Instructions:
1. Analyze the PDF content and file name
2. Match to products in our catalog
3. Return ONLY a valid JSON array with NO markdown or code blocks
4. Include only matches with confidence > 0.7
5. Format: [{"productId": "HIM-0001", "confidence": 0.95, "reason": "Brief reason for match"}]

Response:`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 800
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const content = response.data.choices[0].message.content.trim();
    console.log('[LLM Response]:', content.substring(0, 200));

    // Parse JSON - remove markdown code blocks if present
    let jsonContent = content;
    if (content.includes('```json')) {
      jsonContent = content.split('```json')[1].split('```')[0];
    } else if (content.includes('```')) {
      jsonContent = content.split('```')[1].split('```')[0];
    }

    const matches = JSON.parse(jsonContent.trim());

    // Enrich with product names
    const enrichedMatches = matches.map(m => ({
      ...m,
      productName: products.find(p => p.id === m.productId)?.name || 'Unknown Product'
    }));

    console.log(`[Matching] LLM found ${enrichedMatches.length} matches`);
    return enrichedMatches;

  } catch (error) {
    console.error('[LLM Matching Error]:', error.message);
    return [];
  }
}

async function createProductRelations(assetId, matches, token) {
  const instance = process.env.CONTENT_HUB_INSTANCE || 'hmme-d-001.sitecorecontenthub.cloud';

  for (const match of matches) {
    try {
      // Try to create relation from Product → Asset
      const relationPayload = {
        relationTypeId: 'ProductSheets',
        targetEntityId: assetId,
        targetEntityType: 'M.Asset',
        relatedEntity: assetId
      };

      const response = await axios.post(
        `https://${instance}/api/v2/entities/${match.productId}/relations`,
        relationPayload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000
        }
      );

      console.log(`[Relation] Created for ${match.productId}: ${response.data?.id}`);

    } catch (relationError) {
      console.warn(`[Relation] Failed for ${match.productId}:`, relationError.message);
      // Continue with next match, don't fail the whole operation
    }
  }
}

async function updateAssetMetadata(assetId, metadata, token) {
  const instance = process.env.CONTENT_HUB_INSTANCE || 'hmme-d-001.sitecorecontenthub.cloud';

  try {
    const properties = Object.entries(metadata).map(([key, value]) => ({
      name: key,
      value: value
    }));

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

  } catch (metadataError) {
    console.warn('[Metadata] Failed to update:', metadataError.message);
    // Don't fail - metadata is secondary
  }
}