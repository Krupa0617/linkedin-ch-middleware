import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import sharp from 'sharp';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const {
  INSTAGRAM_APP_SECRET,
  INSTAGRAM_ACCESS_TOKEN,
  INSTAGRAM_BUSINESS_ACCOUNT_ID,
  API_SECRET_KEY,
  CONTENT_HUB_URL,
  CONTENT_HUB_USERNAME,
  CONTENT_HUB_PASSWORD,
} = process.env;

const INSTAGRAM_GRAPH_API_VERSION = 'v22.0';
const INSTAGRAM_GRAPH_URL = `https://graph.instagram.com/${INSTAGRAM_GRAPH_API_VERSION}`;

// In-memory token cache — avoids re-authenticating for every proxy request
const tokenCache = { token: null, expiry: 0 };

// ─────────────────────────────────────────────
// ROOT — mirrors LinkedIn '/'
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ Instagram Content Hub Middleware is running',
    endpoints: {
      publishImage:  'POST /api/instagram/publish-image',
      publishVideo:  'POST /api/instagram/publish-video',
      imageProxy:    'GET  /api/instagram/image-proxy/:assetId',
      insights:      'GET  /api/instagram/insights',
      refreshToken:  'POST /api/instagram/refresh-token',
      webhook:       'GET  /api/instagram/webhook',
      health:        'GET  /api/instagram/health',
    }
  });
});

// ─────────────────────────────────────────────
// Helper: Authenticate with Content Hub
// (identical to LinkedIn index.js)
// ─────────────────────────────────────────────
async function getContentHubToken(contentHubBaseUrl) {
  try {
    // Return cached token if still valid (cache for 15 mins)
    const now = Date.now();
    if (tokenCache.token && now < tokenCache.expiry) {
      console.log('✅ Using cached Content Hub token');
      return tokenCache.token;
    }

    console.log('🔐 Authenticating with Content Hub...');
    const response = await axios.post(
      `${contentHubBaseUrl}/api/authenticate`,
      {
        user_name: CONTENT_HUB_USERNAME,
        password: CONTENT_HUB_PASSWORD,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const token =
      response.data.token ||
      response.data.access_token ||
      response.data;

    if (typeof token !== 'string' || token.trim().length === 0) {
      console.error('❌ Token extraction failed:', JSON.stringify(response.data));
      return null;
    }

    // Cache for 15 minutes
    tokenCache.token = token;
    tokenCache.expiry = now + 15 * 60 * 1000;

    console.log('✅ Content Hub token obtained, length:', token.length);
    return token;

  } catch (err) {
    console.error('❌ Content Hub auth failed:', err.response?.status, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Helper: Get asset details from Content Hub
// Returns { title, imageUrl, videoUrl, imageToken, socialCaption, mediaType }
// ─────────────────────────────────────────────
async function getAssetDetails(assetId, contentHubBaseUrl) {
  try {
    console.log(`🔍 Fetching asset details for ID: ${assetId}`);

    const token = await getContentHubToken(contentHubBaseUrl);
    if (!token) {
      return { title: null, imageUrl: null, videoUrl: null, imageToken: null, socialCaption: null, mediaType: 'IMAGE' };
    }

    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/${assetId}`,
      {
        headers: {
          'X-Auth-Token': token,
          'Content-Type': 'application/json',
        },
      }
    );

    const entity = response.data;
    const props = entity?.properties || {};

    console.log('✅ Asset fetched successfully');

    // ── Get Title ──
    const title = props.Title || props.FileName || entity?.identifier || null;
    console.log('✅ Title:', title);

    // ── Get SocialPostCaption (multilingual — identical to LinkedIn) ──
    let socialCaption = null;
    const rawCaption = props.SocialPostCaption;
    if (rawCaption && typeof rawCaption === 'object') {
      socialCaption =
        rawCaption['en-US'] ||
        rawCaption['(Default)'] ||
        Object.values(rawCaption)[0] ||
        null;
    }
    console.log('✅ SocialPostCaption:', socialCaption || '(empty)');

    // ── Detect media type from file extension ──
    const fileName = (props.FileName || '').toLowerCase();
    const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
    const ext = fileName.split('.').pop();
    const mediaType = videoExtensions.includes(ext) ? 'VIDEO' : 'IMAGE';
    console.log('✅ Detected media type:', mediaType);

    // ── Get rendition URL ──
    // Priority: downloadOriginal → original → first available
    let imageUrl = null;
    let videoUrl = null;
    const renditions = entity?.renditions;

    if (renditions && typeof renditions === 'object') {
      const renditionKey = renditions.downloadOriginal
        ? 'downloadOriginal'
        : renditions.original
        ? 'original'
        : Object.keys(renditions)[0];

      const downloadHref = renditions[renditionKey]?.[0]?.href || null;
      console.log(`✅ Rendition key used: ${renditionKey}`);
      console.log(`✅ Rendition selected: ${downloadHref}`);

      if (mediaType === 'VIDEO') {
        videoUrl = downloadHref;
      } else {
        imageUrl = downloadHref;
      }
    }

    if (!imageUrl && !videoUrl) {
      console.log('⚠️ No suitable rendition found');
    }

    return { title, imageUrl, videoUrl, imageToken: token, socialCaption, mediaType };

  } catch (err) {
    console.error('❌ Failed to fetch asset:', err.response?.status, err.message);
    return { title: null, imageUrl: null, videoUrl: null, imageToken: null, socialCaption: null, mediaType: 'IMAGE' };
  }
}

// ─────────────────────────────────────────────
// Helper: Download + resize image buffer
// Returns resized JPEG buffer ready for streaming
// ─────────────────────────────────────────────
async function downloadAndResize(imageUrl, imageToken) {
  console.log('📥 Downloading image from Content Hub...');
  const imageResponse = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    headers: { 'X-Auth-Token': imageToken },
    maxContentLength: 20 * 1024 * 1024,
    timeout: 30000,
  });

  const imageBuffer = Buffer.from(imageResponse.data);
  const imageContentType = imageResponse.headers['content-type'] || 'image/jpeg';

  console.log('✅ Image downloaded:', imageBuffer.length, 'bytes');
  console.log('✅ Content type:', imageContentType);

  if (imageBuffer.length === 0) throw new Error('Downloaded image buffer is empty');
  if (!imageContentType.startsWith('image/')) throw new Error(`Not an image: ${imageContentType}`);

  // Check aspect ratio
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1080;
  const height = metadata.height || 1080;
  const ratio = width / height;

  console.log(`✅ Original dimensions: ${width}x${height} (ratio: ${ratio.toFixed(3)})`);

  // Instagram valid range: 4:5 (0.8) to 1.91:1
  const MIN_RATIO = 0.8;
  const MAX_RATIO = 1.91;

  let resizedBuffer;
  if (ratio >= MIN_RATIO && ratio <= MAX_RATIO) {
    console.log('✅ Aspect ratio valid — resizing to max 1080px wide');
    resizedBuffer = await sharp(imageBuffer)
      .resize(1080, null, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } else {
    console.log('⚠️ Aspect ratio out of range — cropping to 1:1 square (1080x1080)');
    resizedBuffer = await sharp(imageBuffer)
      .resize(1080, 1080, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  console.log('✅ Processed image size:', resizedBuffer.length, 'bytes');
  return resizedBuffer;
}

// ─────────────────────────────────────────────
// Helper: Wait for Instagram container to be ready
// (mirrors waitForLinkedInAsset in index.js)
// ─────────────────────────────────────────────
async function waitForInstagramContainer(containerId) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const statusResponse = await axios.get(
      `${INSTAGRAM_GRAPH_URL}/${containerId}`,
      {
        params: {
          fields: 'status_code,status',
          access_token: INSTAGRAM_ACCESS_TOKEN,
        },
        timeout: 10000,
      }
    );

    const statusCode = statusResponse.data?.status_code;
    console.log(`⏳ Instagram container status attempt ${attempt}:`, statusCode || 'unknown');

    if (statusCode === 'FINISHED' || statusCode === 'READY') return true;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new Error(`Instagram container processing failed: ${statusCode}`);
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  throw new Error('Instagram container did not become ready in time');
}

// ─────────────────────────────────────────────
// IMAGE PROXY ROUTE
// Instagram calls this URL to fetch the image.
// We download from Content Hub, resize with sharp,
// and stream back as a public JPEG — no second cloud needed.
//
// GET /api/instagram/image-proxy/:assetId
// ─────────────────────────────────────────────
app.get('/api/instagram/image-proxy/:assetId', async (req, res) => {
  const { assetId } = req.params;
  const sourceSystem = req.query.source || CONTENT_HUB_URL;

  console.log(`🖼️ Image proxy request for asset: ${assetId}`);

  try {
    const token = await getContentHubToken(sourceSystem);
    if (!token) {
      return res.status(500).send('Failed to authenticate with Content Hub');
    }

    // Fetch entity to get rendition URL
    const response = await axios.get(
      `${sourceSystem}/api/entities/${assetId}`,
      { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
    );

    const entity = response.data;
    const renditions = entity?.renditions;

    if (!renditions) {
      return res.status(404).send('No renditions found for asset');
    }

    const renditionKey = renditions.downloadOriginal
      ? 'downloadOriginal'
      : renditions.original
      ? 'original'
      : Object.keys(renditions)[0];

    const imageUrl = renditions[renditionKey]?.[0]?.href;
    if (!imageUrl) {
      return res.status(404).send('No image URL found in renditions');
    }

    // Download and resize
    const resizedBuffer = await downloadAndResize(imageUrl, token);

    // Stream back as public JPEG — Instagram fetches this URL directly
    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Length', resizedBuffer.length);
    res.set('Cache-Control', 'public, max-age=3600'); // cache 1hr
    res.send(resizedBuffer);

    console.log(`✅ Image proxy served for asset ${assetId}: ${resizedBuffer.length} bytes`);

  } catch (err) {
    console.error('❌ Image proxy error:', err.message);
    res.status(500).send('Failed to proxy image');
  }
});

// ─────────────────────────────────────────────
// GET — test connection (mirrors LinkedIn GET /linkedin/publish)
// ─────────────────────────────────────────────
app.get('/api/instagram/publish-image', (req, res) => {
  res.json({ status: '✅ Instagram publish-image endpoint is ready. Use POST to publish.' });
});

app.get('/api/instagram/publish-video', (req, res) => {
  res.json({ status: '✅ Instagram publish-video endpoint is ready. Use POST to publish.' });
});

// ─────────────────────────────────────────────
// PUBLISH IMAGE — mirrors POST /linkedin/publish
// ─────────────────────────────────────────────
app.post('/api/instagram/publish-image', async (req, res) => {

  console.log('📢 Incoming Instagram image publish request from Content Hub');
  console.log('Body:', JSON.stringify(req.body));

  // ── Security check (identical to LinkedIn) ──
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!INSTAGRAM_ACCESS_TOKEN) return res.status(500).json({ error: 'INSTAGRAM_ACCESS_TOKEN not configured' });
  if (!INSTAGRAM_BUSINESS_ACCOUNT_ID) return res.status(500).json({ error: 'INSTAGRAM_BUSINESS_ACCOUNT_ID not configured' });

  // ── Read context from Content Hub (identical pattern to LinkedIn) ──
  const context = req.body.context || {};
  const saveMsg = req.body.saveEntityMessage || {};

  const assetId = req.headers['target_id'] || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  console.log('✅ Asset ID:', assetId);
  console.log('✅ Source System:', sourceSystem);

  if (!assetId) {
    return res.status(400).json({ error: 'No asset ID provided', hint: 'Send target_id in headers' });
  }

  // ── Fetch asset details from Content Hub ──
  let caption = context.caption || null;

  const assetDetails = await getAssetDetails(assetId, sourceSystem);

  // Priority: SocialPostCaption > Title (identical to LinkedIn)
  if (assetDetails.socialCaption) {
    caption = assetDetails.socialCaption;
    console.log('✅ Using SocialPostCaption for caption');
  } else if (!caption || caption === '{Title}') {
    caption = assetDetails.title;
    console.log('✅ Using Title for caption');
  }

  if (!caption) {
    caption = 'New content published from Sitecore Content Hub';
  }

  console.log('✅ Final Caption:', caption);

  if (!assetDetails.imageUrl) {
    return res.status(400).json({
      error: 'No image URL found for asset',
      assetId,
      hint: 'Ensure the asset has a downloadOriginal rendition and is an image file type',
    });
  }

  try {
    // ── Build proxy URL — Instagram fetches this to get the image ──
    // Your Vercel function IS the public server, so we proxy through it.
    const vercelBaseUrl = `https://${req.headers.host}`;
    const proxyUrl = `${vercelBaseUrl}/api/instagram/image-proxy/${assetId}?source=${encodeURIComponent(sourceSystem)}`;

    console.log('✅ Proxy URL for Instagram:', proxyUrl);

    // ── Step 1: Create Instagram media container using proxy URL ──
    console.log('📤 Creating Instagram media container...');
    const containerResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        image_url: proxyUrl,   // ✅ Public proxy URL — no second cloud
        caption: caption,
        media_type: 'IMAGE',
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const containerId = containerResponse.data.id;
    console.log('✅ Container created:', containerId);

    // ── Step 2: Wait for Instagram to process the image ──
    console.log('⏳ Waiting for Instagram image container to be ready...');
    await waitForInstagramContainer(containerId);

    // ── Step 3: Publish the container ──
    const publishResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: containerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const postId = publishResponse.data.id;
    console.log('✅ Successfully published to Instagram!');
    console.log('✅ Post ID:', postId);

    res.json({
      success: true,
      postId,
      caption,
      instagramUrl: `https://instagram.com/p/${postId}`,
      message: 'Successfully published image to Instagram',
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('❌ Instagram image publish failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to publish image to Instagram',
      details: err.response?.data?.error || err.message,
      code: err.response?.status,
    });
  }
});

// ─────────────────────────────────────────────
// PUBLISH VIDEO — same pattern as publish-image
// ─────────────────────────────────────────────
app.post('/api/instagram/publish-video', async (req, res) => {

  console.log('📢 Incoming Instagram video publish request from Content Hub');
  console.log('Body:', JSON.stringify(req.body));

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!INSTAGRAM_ACCESS_TOKEN) return res.status(500).json({ error: 'INSTAGRAM_ACCESS_TOKEN not configured' });
  if (!INSTAGRAM_BUSINESS_ACCOUNT_ID) return res.status(500).json({ error: 'INSTAGRAM_BUSINESS_ACCOUNT_ID not configured' });

  const context = req.body.context || {};
  const saveMsg = req.body.saveEntityMessage || {};

  const assetId = req.headers['target_id'] || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  console.log('✅ Asset ID:', assetId);
  console.log('✅ Source System:', sourceSystem);

  let caption = context.caption || null;

  const assetDetails = await getAssetDetails(assetId, sourceSystem);

  if (assetDetails.socialCaption) {
    caption = assetDetails.socialCaption;
    console.log('✅ Using SocialPostCaption for caption');
  } else if (!caption || caption === '{Title}') {
    caption = assetDetails.title;
    console.log('✅ Using Title for caption');
  }

  if (!caption) caption = 'New content published from Sitecore Content Hub';

  console.log('✅ Final Caption:', caption);
  console.log('✅ Video URL:', assetDetails.videoUrl || 'none');

  if (!assetDetails.videoUrl) {
    return res.status(400).json({
      error: 'No video URL found for asset',
      assetId,
      hint: 'Ensure the asset has a downloadOriginal rendition and is a video file type (mp4, mov, etc.)',
    });
  }

  try {
    console.log('📤 Creating Instagram video media container...');
    const containerResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        video_url: assetDetails.videoUrl,
        caption: caption,
        media_type: 'REELS',
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const containerId = containerResponse.data.id;
    console.log('✅ Video container created:', containerId);

    console.log('⏳ Waiting for Instagram to process video...');
    await waitForInstagramContainer(containerId);

    const publishResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: containerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const postId = publishResponse.data.id;
    console.log('✅ Successfully published video to Instagram!');
    console.log('✅ Post ID:', postId);

    res.json({
      success: true,
      postId,
      caption,
      instagramUrl: `https://instagram.com/p/${postId}`,
      message: 'Successfully published video to Instagram',
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('❌ Instagram video publish failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to publish video to Instagram',
      details: err.response?.data?.error || err.message,
      code: err.response?.status,
    });
  }
});

// ─────────────────────────────────────────────
// INSIGHTS
// ─────────────────────────────────────────────
app.get('/api/instagram/insights', async (req, res) => {
  try {
    const { metric = 'impressions,reach,profile_views' } = req.query;
    const insightsResponse = await axios.get(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/insights`,
      { params: { metric, period: 'day', access_token: INSTAGRAM_ACCESS_TOKEN } }
    );
    res.json({ success: true, insights: insightsResponse.data.data, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('❌ Instagram insights error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch Instagram insights', details: err.response?.data?.error || err.message });
  }
});

// ─────────────────────────────────────────────
// REFRESH ACCESS TOKEN
// ─────────────────────────────────────────────
app.post('/api/instagram/refresh-token', async (req, res) => {
  try {
    const { userAccessToken } = req.body;
    const refreshResponse = await axios.get(
      `${INSTAGRAM_GRAPH_URL}/access_token`,
      {
        params: {
          grant_type: 'ig_exchange_token',
          client_secret: INSTAGRAM_APP_SECRET,
          access_token: userAccessToken || INSTAGRAM_ACCESS_TOKEN,
        },
      }
    );
    console.log('✅ Instagram token refreshed successfully');
    res.json({
      success: true,
      newAccessToken: refreshResponse.data.access_token,
      expiresIn: refreshResponse.data.expires_in,
      message: 'Token refreshed successfully. Valid for 60 days.',
    });
  } catch (err) {
    console.error('❌ Token refresh error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to refresh access token', details: err.response?.data?.error || err.message });
  }
});

// ─────────────────────────────────────────────
// WEBHOOK VERIFICATION
// ─────────────────────────────────────────────
app.get('/api/instagram/webhook', (req, res) => {
  const verifyToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || 'sitecore_content_hub_webhook';
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (token === verifyToken) {
    console.log('✅ Instagram webhook verified');
    res.send(challenge);
  } else {
    console.error('❌ Instagram webhook verification failed');
    res.status(403).send('Verification failed');
  }
});

// ─────────────────────────────────────────────
// WEBHOOK HANDLER
// ─────────────────────────────────────────────
app.post('/api/instagram/webhook', (req, res) => {
  const { entry } = req.body;
  if (entry) {
    entry.forEach((item) => {
      const { messaging } = item;
      if (messaging) messaging.forEach((event) => console.log('Instagram webhook event:', event));
    });
  }
  res.status(200).send('Event received');
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/api/instagram/health', (req, res) => {
  console.log('✅ Instagram health check');
  res.json({
    status: '✅ healthy',
    service: 'Instagram Integration Middleware',
    timestamp: new Date().toISOString(),
    accountId: INSTAGRAM_BUSINESS_ACCOUNT_ID,
  });
});

// ─────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});


// ─────────────────────────────────────────────
// PUBLISH CAROUSEL — multiple assets from campaign
// POST /api/instagram/publish-carousel
// ─────────────────────────────────────────────
app.post('/api/instagram/publish-carousel', async (req, res) => {
  console.log('📢 Incoming Instagram carousel publish request');
  console.log('Body:', JSON.stringify(req.body));

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!INSTAGRAM_ACCESS_TOKEN) return res.status(500).json({ error: 'INSTAGRAM_ACCESS_TOKEN not configured' });
  if (!INSTAGRAM_BUSINESS_ACCOUNT_ID) return res.status(500).json({ error: 'INSTAGRAM_BUSINESS_ACCOUNT_ID not configured' });

  const saveMsg = req.body.saveEntityMessage || {};
  const campaignId = req.headers['target_id'] || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  console.log('✅ Campaign ID:', campaignId);

  if (!campaignId) {
    return res.status(400).json({ error: 'No campaign ID provided' });
  }

  try {
    // Step 1: Auth with Content Hub
    const token = await getContentHubToken(sourceSystem);
    if (!token) return res.status(500).json({ error: 'Content Hub auth failed' });

    // Step 2: Fetch asset IDs from campaign selection pool
    const selectionResponse = await axios.get(
      `${sourceSystem}/api/selection/SelectionPool.ContentCampaignDetail/`,
      {
        params: {
          ignorePermissions: false,
          definitionNames: 'M.Content,M.Asset,M.Deliverable',
          subPoolId: campaignId
        },
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' }
      }
    );

    const assetIds = selectionResponse.data?.['M.Asset']?.items || [];
    console.log('✅ Found asset IDs from selection pool:', assetIds);

    if (assetIds.length === 0) {
      return res.status(400).json({ error: 'No assets found in campaign selection pool' });
    }

    // Step 3: Get campaign title for caption
    const campaignResponse = await axios.get(
      `${sourceSystem}/api/entities/${campaignId}`,
      { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
    );
    const caption = campaignResponse.data?.properties?.Title || 'Campaign post from Sitecore Content Hub';

    // Step 4: Build proxy URLs for each asset (max 10 for Instagram)
    const vercelBaseUrl = `https://${req.headers.host}`;
    const assetSlice = assetIds.slice(0, 10);

    // Step 5: Create individual media containers for each asset
    const childContainerIds = [];
    for (const assetId of assetSlice) {
      const proxyUrl = `${vercelBaseUrl}/api/instagram/image-proxy/${assetId}?source=${encodeURIComponent(sourceSystem)}`;

      console.log(`📤 Creating container for asset ${assetId}`);
      const containerRes = await axios.post(
        `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
        {
          image_url: proxyUrl,
          is_carousel_item: true,
          access_token: INSTAGRAM_ACCESS_TOKEN,
        }
      );
      childContainerIds.push(containerRes.data.id);
      console.log(`✅ Container created: ${containerRes.data.id}`);
    }

    // Step 6: Create carousel container
    console.log('📤 Creating carousel container...');
    const carouselRes = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        media_type: 'CAROUSEL',
        caption: caption,
        children: childContainerIds.join(','),
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const carouselContainerId = carouselRes.data.id;
    console.log('✅ Carousel container created:', carouselContainerId);

    // Step 7: Wait for carousel to be ready
    await waitForInstagramContainer(carouselContainerId);

    // Step 8: Publish
    const publishRes = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: carouselContainerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const postId = publishRes.data.id;
    console.log('✅ Instagram carousel published! Post ID:', postId);

    res.json({
      success: true,
      postId,
      caption,
      assetCount: childContainerIds.length,
      message: 'Successfully published carousel to Instagram',
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('❌ Instagram carousel publish failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to publish carousel to Instagram',
      details: err.response?.data?.error || err.message,
    });
  }
});

export default app;