import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Configuration
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const INSTAGRAM_GRAPH_API_VERSION = 'v22.0'; // Latest version as of 2026
const INSTAGRAM_GRAPH_URL = `https://graph.instagram.com/${INSTAGRAM_GRAPH_API_VERSION}`;

// ============================================
// 1. PUBLISH IMAGE POST TO INSTAGRAM
// ============================================
app.post('/publish-image', async (req, res) => {
  try {
    const { imageUrl, caption, mediaType = 'IMAGE' } = req.body;

    if (!imageUrl || !caption) {
      return res.status(400).json({
        error: 'Missing required fields: imageUrl, caption',
      });
    }

    console.log('Publishing to Instagram:', { imageUrl, caption });

    // Step 1: Create media container
    const containerResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        image_url: imageUrl,
        caption: caption,
        media_type: mediaType, // IMAGE or CAROUSEL
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const containerId = containerResponse.data.id;
    console.log('Container created:', containerId);

    // Step 2: Publish the container (publish immediately)
    const publishResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: containerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const postId = publishResponse.data.id;

    res.json({
      success: true,
      message: 'Post published successfully',
      postId: postId,
      instagramUrl: `https://instagram.com/p/${postId}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Instagram publishing error:', error.response?.data || error.message);

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
app.post('/publish-video', async (req, res) => {
  try {
    const { videoUrl, caption, thumbnailUrl } = req.body;

    if (!videoUrl || !caption) {
      return res.status(400).json({
        error: 'Missing required fields: videoUrl, caption',
      });
    }

    console.log('Publishing video to Instagram:', { videoUrl, caption });

    // Create media container for video
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
    console.log('Video container created:', containerId);

    // Publish the video
    const publishResponse = await axios.post(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: containerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }
    );

    const postId = publishResponse.data.id;

    res.json({
      success: true,
      message: 'Video published successfully',
      postId: postId,
      instagramUrl: `https://instagram.com/p/${postId}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Instagram video publishing error:', error.response?.data || error.message);

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
app.get('/insights', async (req, res) => {
  try {
    const { metric = 'impressions,reach,profile_views' } = req.query;

    const insightsResponse = await axios.get(
      `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/insights`,
      {
        params: {
          metric: metric,
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
    console.error('Instagram insights error:', error.response?.data || error.message);

    res.status(500).json({
      error: 'Failed to fetch Instagram insights',
      details: error.response?.data?.error || error.message,
    });
  }
});

// ============================================
// 4. REFRESH ACCESS TOKEN (if using short-lived tokens)
// ============================================
app.post('/refresh-token', async (req, res) => {
  try {
    const { userAccessToken } = req.body;

    // Exchange short-lived token for long-lived token (valid for 60 days)
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

    res.json({
      success: true,
      newAccessToken: refreshResponse.data.access_token,
      expiresIn: refreshResponse.data.expires_in,
      message: 'Token refreshed successfully. Valid for 60 days.',
    });
  } catch (error) {
    console.error('Token refresh error:', error.response?.data || error.message);

    res.status(500).json({
      error: 'Failed to refresh access token',
      details: error.response?.data?.error || error.message,
    });
  }
});

// ============================================
// 5. WEBHOOK VERIFICATION (for future webhooks)
// ============================================
app.get('/webhook', (req, res) => {
  const verifyToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || 'sitecore_content_hub_webhook';
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (token === verifyToken) {
    res.send(challenge);
  } else {
    res.status(403).send('Verification failed');
  }
});

// ============================================
// 6. WEBHOOK HANDLER (receive Instagram events)
// ============================================
app.post('/webhook', (req, res) => {
  const { entry } = req.body;

  if (entry) {
    entry.forEach((item) => {
      const { messaging } = item;
      if (messaging) {
        messaging.forEach((event) => {
          console.log('Instagram webhook event received:', event);
          // Handle webhook events here (comments, DMs, etc.)
        });
      }
    });
  }

  res.status(200).send('Event received');
});

// ============================================
// 7. HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Instagram Integration Middleware',
    timestamp: new Date().toISOString(),
    accountId: INSTAGRAM_BUSINESS_ACCOUNT_ID,
  });
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ============================================
// REMOVED: app.listen() for Vercel serverless
// The wrapper (api/instagram.js) handles server startup
// ============================================

export default app;