import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const {
  INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET,
  INSTAGRAM_ACCESS_TOKEN,
  INSTAGRAM_BUSINESS_ACCOUNT_ID,
  API_SECRET_KEY,
  CONTENT_HUB_URL,
  CONTENT_HUB_USERNAME,
  CONTENT_HUB_PASSWORD,
} = process.env;

const INSTAGRAM_GRAPH_API_VERSION = 'v23.0';
const INSTAGRAM_GRAPH_URL = `https://graph.facebook.com/${INSTAGRAM_GRAPH_API_VERSION}`;
// ─────────────────────────────────────────────
// ROOT — Health check (mirrors LinkedIn '/')
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ Instagram Content Hub Middleware is running',
    endpoints: {
      publishImage: 'POST /api/instagram/publish-image',
      publishVideo: 'POST /api/instagram/publish-video',
      insights:     'GET  /api/instagram/insights',
      refreshToken: 'POST /api/instagram/refresh-token',
      webhook:      'GET  /api/instagram/webhook',
      health:       'GET  /api/instagram/health',
    }
  });
});

// ─────────────────────────────────────────────
// Helper: Authenticate with Content Hub
// (identical to LinkedIn index.js)
// ─────────────────────────────────────────────
async function getContentHubToken(contentHubBaseUrl) {
  try {
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
// (mirrors LinkedIn getAssetDetails — adds videoUrl + mediaType detection)
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

    // ── Get SocialPostCaption (multilingual field) ──
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
    let imageUrl = null;
    let videoUrl = null;
    const renditions = entity?.renditions;

    if (renditions && typeof renditions === 'object') {
      const downloadHref = renditions.downloadOriginal?.[0]?.href || null;
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
// GET handler for test connection (mirrors LinkedIn GET /linkedin/publish)
// ─────────────────────────────────────────────
app.get('/api/instagram/publish-image', (req, res) => {
  res.json({ status: '✅ Instagram publish-image endpoint is ready. Use POST to publish.' });
});

app.get('/api/instagram/publish-video', (req, res) => {
  res.json({ status: '✅ Instagram publish-video endpoint is ready. Use POST to publish.' });
});

// ─────────────────────────────────────────────
// PUBLISH IMAGE POST TO INSTAGRAM
// Mirrors: POST /linkedin/publish from index.js
// ─────────────────────────────────────────────
app.post('/api/instagram/publish-image', async (req, res) => {

  console.log('📢 Incoming Instagram image publish request from Content Hub');
  console.log('Body:', JSON.stringify(req.body));

  // ── Security check ──
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');

    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  if (!INSTAGRAM_ACCESS_TOKEN) {
    return res.status(500).json({
      error: 'INSTAGRAM_ACCESS_TOKEN not configured'
    });
  }

  if (!INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    return res.status(500).json({
      error: 'INSTAGRAM_BUSINESS_ACCOUNT_ID not configured'
    });
  }

  // ─────────────────────────────────────────────
  // Read Content Hub context
  // ─────────────────────────────────────────────
  const context = req.body.context || {};
  const saveMsg = req.body.saveEntityMessage || {};

  const assetId =
    req.headers['target_id'] ||
    saveMsg.TargetId;

  const sourceSystem =
    req.headers['source_system'] ||
    CONTENT_HUB_URL;

  console.log('✅ Asset ID:', assetId);
  console.log('✅ Source System:', sourceSystem);

  // ─────────────────────────────────────────────
  // Fetch asset details
  // ─────────────────────────────────────────────
  let caption = context.caption || null;
  let imageUrl = null;

  if (
    assetId &&
    sourceSystem &&
    CONTENT_HUB_USERNAME &&
    CONTENT_HUB_PASSWORD
  ) {

    const assetDetails = await getAssetDetails(
      assetId,
      sourceSystem
    );

    // Priority:
    // SocialPostCaption > Context Caption > Title
    if (assetDetails.socialCaption) {

      caption = assetDetails.socialCaption;

      console.log(
        '✅ Using SocialPostCaption for caption'
      );

    } else if (!caption || caption === '{Title}') {

      caption = assetDetails.title;

      console.log(
        '✅ Using Title for caption'
      );
    }

    imageUrl = assetDetails.imageUrl;
  }

  // Final fallback caption
  if (!caption) {
    caption = 'New content published from Sitecore Content Hub';
  }

  console.log('✅ Final Caption:', caption);
  console.log('✅ Image URL:', imageUrl || 'none');

  // Validate image URL
  if (!imageUrl) {

    return res.status(400).json({
      error: 'No image URL found for asset',
      assetId,
      hint:
        'Ensure the asset has a downloadOriginal rendition'
    });
  }

  try {

    // ─────────────────────────────────────────────
    // Step 1: Create Instagram Media Container
    // ─────────────────────────────────────────────
    console.log(
      '📤 Creating Instagram media container...'
    );

    const containerResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        image_url: imageUrl,
        caption: caption,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      },
      {
        timeout: 60000,
      }
    );

    const containerId = containerResponse.data.id;

    console.log(
      '✅ Instagram container created:',
      containerId
    );

    // ─────────────────────────────────────────────
    // Step 2: Wait for Instagram Processing
    // ─────────────────────────────────────────────
    console.log(
      '⏳ Waiting for Instagram to process image...'
    );

    await waitForInstagramContainer(containerId);

    // ─────────────────────────────────────────────
    // Step 3: Publish Media
    // ─────────────────────────────────────────────
    console.log(
      '📤 Publishing Instagram media...'
    );

    const publishResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: containerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      },
      {
        timeout: 60000,
      }
    );

    const postId = publishResponse.data.id;

    console.log(
      '✅ Successfully published image to Instagram!'
    );

    console.log('✅ Instagram Post ID:', postId);

    return res.json({
      success: true,
      postId,
      caption,
      instagramUrl: `https://instagram.com/p/${postId}`,
      message:
        'Successfully published image to Instagram',
      timestamp: new Date().toISOString(),
    });

  } catch (err) {

    console.error(
      '❌ Instagram image publish failed:',
      err.response?.data || err.message
    );

    return res.status(500).json({
      error: 'Failed to publish image to Instagram',
      details:
        err.response?.data?.error ||
        err.message,
      code: err.response?.status,
    });
  }
});
// ─────────────────────────────────────────────
// PUBLISH VIDEO/REEL TO INSTAGRAM
// Same pattern as publish-image but for VIDEO
// ─────────────────────────────────────────────
app.post('/api/instagram/publish-video', async (req, res) => {

  console.log('📢 Incoming Instagram video publish request from Content Hub');
  console.log('Body:', JSON.stringify(req.body));

  // ── Security check ──
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!INSTAGRAM_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'INSTAGRAM_ACCESS_TOKEN not configured' });
  }
  if (!INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    return res.status(500).json({ error: 'INSTAGRAM_BUSINESS_ACCOUNT_ID not configured' });
  }

  // ── Read context from Content Hub ──
  const context = req.body.context || {};
  const saveMsg = req.body.saveEntityMessage || {};

  const assetId = req.headers['target_id'] || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  console.log('✅ Asset ID:', assetId);
  console.log('✅ Source System:', sourceSystem);

  // ── Fetch asset details from Content Hub ──
  let caption = context.caption || null;
  let videoUrl = null;
  let videoToken = null;

  if (assetId && sourceSystem && CONTENT_HUB_USERNAME && CONTENT_HUB_PASSWORD) {
    const assetDetails = await getAssetDetails(assetId, sourceSystem);

    if (assetDetails.socialCaption) {
      caption = assetDetails.socialCaption;
      console.log('✅ Using SocialPostCaption for caption');
    } else if (!caption || caption === '{Title}') {
      caption = assetDetails.title;
      console.log('✅ Using Title for caption');
    }

    videoUrl = assetDetails.videoUrl;
    videoToken = assetDetails.imageToken; // same CH token
  }

  if (!caption) {
    caption = 'New content published from Sitecore Content Hub';
  }

  console.log('✅ Final Caption:', caption);
  console.log('✅ Video URL:', videoUrl || 'none');

  if (!videoUrl) {
    return res.status(400).json({
      error: 'No video URL found for asset',
      assetId,
      hint: 'Ensure the asset has a downloadOriginal rendition and is a video file type (mp4, mov, etc.)',
    });
  }

  try {
    // ── Step 1: Create media container for video ──
    console.log('📤 Creating Instagram video media container...');
    const containerResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        video_url: videoUrl,  // Must be publicly accessible
        caption: caption,
        media_type: 'REELS',  // Use REELS for video posts (recommended by Meta)
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const containerId = containerResponse.data.id;
    console.log('✅ Video container created:', containerId);

    // ── Step 2: Wait for video processing ──
    console.log('⏳ Waiting for Instagram to process video...');
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
// Helper: Wait for Instagram video container to finish processing
// (mirrors waitForLinkedInAsset in index.js)
// ─────────────────────────────────────────────
async function waitForInstagramContainer(containerId) {

  const maxAttempts = 20;
  const delayMs = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

      const statusResponse = await axios.get(
        `${INSTAGRAM_GRAPH_URL}/${containerId}`,
        {
          params: {
            fields: 'status_code,status',
            access_token: INSTAGRAM_ACCESS_TOKEN,
          },
          timeout: 15000,
        }
      );

      const statusCode = statusResponse.data?.status_code;
      const status = statusResponse.data?.status;

      console.log(
        `⏳ Instagram container status attempt ${attempt}:`,
        statusCode || status || 'unknown'
      );

      // ✅ Success
      if (statusCode === 'FINISHED') {
        console.log('✅ Instagram container processing finished');
        return true;
      }

      // ❌ Failure
      if (
        statusCode === 'ERROR' ||
        statusCode === 'EXPIRED'
      ) {
        throw new Error(
          `Instagram media processing failed with status: ${statusCode}`
        );
      }

      // ⏳ Wait before next poll
      await new Promise(resolve => setTimeout(resolve, delayMs));

    } catch (err) {

      console.error(
        `❌ Error checking Instagram container status (attempt ${attempt}):`,
        err.response?.data || err.message
      );

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    'Instagram media container did not finish processing in time'
  );
}

// ─────────────────────────────────────────────
// GET INSTAGRAM ACCOUNT INSIGHTS
// ─────────────────────────────────────────────
app.get('/api/instagram/insights', async (req, res) => {
  try {
    const { metric = 'impressions,reach,profile_views' } = req.query;

    const insightsResponse = await axios.get(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/insights`,
      {
        params: {
          metric,
          period: 'day',
          access_token: INSTAGRAM_ACCESS_TOKEN,
        },
      }
    );

    res.json({
      success: true,
      insights: insightsResponse.data.data,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('❌ Instagram insights error:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to fetch Instagram insights',
      details: err.response?.data?.error || err.message,
    });
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
    res.status(500).json({
      error: 'Failed to refresh access token',
      details: err.response?.data?.error || err.message,
    });
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
      if (messaging) {
        messaging.forEach((event) => {
          console.log('Instagram webhook event received:', event);
        });
      }
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
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ✅ REMOVED: app.listen() — Vercel serverless handles this via api/instagram.js wrapper

export default app;