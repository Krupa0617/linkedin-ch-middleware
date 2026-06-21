import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Configuration
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const INSTAGRAM_GRAPH_API_VERSION = 'v22.0';
const INSTAGRAM_GRAPH_URL = `https://graph.instagram.com/${INSTAGRAM_GRAPH_API_VERSION}`;

// ============================================
// ROOT — Health check (mirrors LinkedIn's '/' endpoint)
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: '✅ Instagram Integration Middleware is running',
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

// ============================================
// 1. PUBLISH IMAGE POST TO INSTAGRAM
// ============================================
app.post('/api/instagram/publish-image', async (req, res) => {
  try {
    const { imageUrl, caption, mediaType = 'IMAGE' } = req.body;

    if (!imageUrl || !caption) {
      return res.status(400).json({ error: 'Missing required fields: imageUrl, caption' });
    }

    console.log('📢 Incoming Instagram image publish request');
    console.log('Publishing to Instagram:', { imageUrl, caption });

    // Step 1: Create media container
    const containerResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        image_url: imageUrl,
        caption: caption,
        media_type: mediaType,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const containerId = containerResponse.data.id;
    console.log('✅ Container created:', containerId);

    // Step 2: Publish the container
    const publishResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: containerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const postId = publishResponse.data.id;
    console.log('✅ Published successfully, Post ID:', postId);

    res.json({
      success: true,
      message: 'Post published successfully',
      postId,
      instagramUrl: `https://instagram.com/p/${postId}`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('❌ Instagram publishing error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to publish to Instagram',
      details: error.response?.data?.error || error.message,
      code: error.response?.status,
    });
  }
});

// ============================================
// 2. PUBLISH VIDEO/REEL TO INSTAGRAM
// ============================================
app.post('/api/instagram/publish-video', async (req, res) => {
  try {
    const { videoUrl, caption, thumbnailUrl } = req.body;

    if (!videoUrl || !caption) {
      return res.status(400).json({ error: 'Missing required fields: videoUrl, caption' });
    }

    console.log('📢 Incoming Instagram video publish request');
    console.log('Publishing video to Instagram:', { videoUrl, caption });

    const containerResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        video_url: videoUrl,
        caption: caption,
        media_type: 'VIDEO',
        thumbnail_url: thumbnailUrl || undefined,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const containerId = containerResponse.data.id;
    console.log('✅ Video container created:', containerId);

    const publishResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: containerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const postId = publishResponse.data.id;
    console.log('✅ Video published successfully, Post ID:', postId);

    res.json({
      success: true,
      message: 'Video published successfully',
      postId,
      instagramUrl: `https://instagram.com/p/${postId}`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('❌ Instagram video publishing error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to publish video to Instagram',
      details: error.response?.data?.error || error.message,
      code: error.response?.status,
    });
  }
});

// ============================================
// 3. GET INSTAGRAM ACCOUNT INSIGHTS
// ============================================
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

  } catch (error) {
    console.error('❌ Instagram insights error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch Instagram insights',
      details: error.response?.data?.error || error.message,
    });
  }
});

// ============================================
// 4. REFRESH ACCESS TOKEN
// ============================================
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

  } catch (error) {
    console.error('❌ Token refresh error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to refresh access token',
      details: error.response?.data?.error || error.message,
    });
  }
});

// ============================================
// 5. WEBHOOK VERIFICATION
// ============================================
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

// ============================================
// 6. WEBHOOK HANDLER
// ============================================
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

// ============================================
// 7. HEALTH CHECK
// ============================================
app.get('/api/instagram/health', (req, res) => {
  console.log('✅ Instagram health check');
  res.json({
    status: '✅ healthy',
    service: 'Instagram Integration Middleware',
    timestamp: new Date().toISOString(),
    accountId: INSTAGRAM_BUSINESS_ACCOUNT_ID,
  });
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ✅ REMOVED: app.listen() — Vercel serverless handles this via api/instagram.js wrapper

export default app;