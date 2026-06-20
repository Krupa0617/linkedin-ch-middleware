require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const {
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  REDIRECT_URI,
  CONTENT_HUB_URL,
  PORT,
  LINKEDIN_ACCESS_TOKEN,
  LINKEDIN_MEMBER_ID,
  API_SECRET_KEY
} = process.env;

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ LinkedIn Content Hub Middleware is running',
    endpoints: {
      login: 'GET /auth/linkedin',
      callback: 'GET /auth/linkedin/callback',
      publish: 'POST /linkedin/publish'
    }
  });
});

// ─────────────────────────────────────────────
// STEP 1: Redirect user to LinkedIn login page
// ─────────────────────────────────────────────
app.get('/auth/linkedin', (req, res) => {
  const scope = 'openid profile email w_member_social';
  const linkedinAuthUrl =
    `https://www.linkedin.com/oauth/v2/authorization` +
    `?response_type=code` +
    `&client_id=${LINKEDIN_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=contenthub_linkedin`;

  res.redirect(linkedinAuthUrl);
});

// ─────────────────────────────────────────────
// STEP 2: LinkedIn callback
// Exchanges code for token, gets member info
// then redirects back to Content Hub
// ─────────────────────────────────────────────
app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('❌ LinkedIn auth error:', error);
    return res.status(400).json({ error: 'LinkedIn auth failed', details: error });
  }

  if (!code) {
    return res.status(400).json({ error: 'No authorization code received from LinkedIn' });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      null,
      {
        params: {
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: REDIRECT_URI,
          client_id: LINKEDIN_CLIENT_ID,
          client_secret: LINKEDIN_CLIENT_SECRET,
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;
    const expiresIn = tokenResponse.data.expires_in;

    console.log('✅ Access Token obtained');
    console.log('✅ Expires in:', expiresIn, 'seconds (~', Math.round(expiresIn / 86400), 'days)');

    // Get LinkedIn user profile
    const profileResponse = await axios.get(
      'https://api.linkedin.com/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const userInfo = profileResponse.data;

    console.log('✅ Member ID (sub):', userInfo.sub);
    console.log('✅ Member Name:', userInfo.name);
    console.log('✅ Member Email:', userInfo.email);

    // Redirect back to Content Hub
    const redirectUrl =
      `${CONTENT_HUB_URL}/en-US/account` +
      `?linkedin_user=${encodeURIComponent(userInfo.name)}` +
      `&auth=success`;

    res.redirect(redirectUrl);

  } catch (err) {
    console.error('❌ Token exchange failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Token exchange failed',
      details: err.response?.data || err.message
    });
  }
});

// ─────────────────────────────────────────────
// STEP 3: Publish content to LinkedIn
// Called by Content Hub Trigger/Action
// Uses personal member posting (no Org ID needed)
// ─────────────────────────────────────────────
app.post('/linkedin/publish', async (req, res) => {

  // Security check — validate x-api-key sent from Content Hub action
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid or missing x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Read credentials from Vercel environment variables
  const accessToken = LINKEDIN_ACCESS_TOKEN;
  const memberId = LINKEDIN_MEMBER_ID;

  // Validate env variables are set
  if (!accessToken) {
    console.error('❌ LINKEDIN_ACCESS_TOKEN is not set in environment variables');
    return res.status(500).json({ error: 'LINKEDIN_ACCESS_TOKEN not configured' });
  }

  if (!memberId) {
    console.error('❌ LINKEDIN_MEMBER_ID is not set in environment variables');
    return res.status(500).json({ error: 'LINKEDIN_MEMBER_ID not configured' });
  }

  // Read values sent from Content Hub action body
  const {
    shareCommentary,
    lifecycleState,
    shareMediaCategory,
    visibility
  } = req.body;

  console.log('📢 Incoming publish request from Content Hub');
  console.log('Author: urn:li:person:' + memberId);
  console.log('Message:', shareCommentary);
  console.log('Body received:', JSON.stringify(req.body));

  try {
    const postResponse = await axios.post(
      'https://api.linkedin.com/v2/ugcPosts',
      {
        author: `urn:li:person:${memberId}`,
        lifecycleState: lifecycleState || 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text: shareCommentary || 'New content published from Sitecore Content Hub'
            },
            shareMediaCategory: shareMediaCategory || 'NONE',
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': visibility || 'PUBLIC',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );

    console.log('✅ Successfully published to LinkedIn!');
    console.log('✅ Post ID:', postResponse.data.id);

    res.json({
      success: true,
      postId: postResponse.data.id,
      message: 'Successfully published to LinkedIn'
    });

  } catch (err) {
    console.error('❌ LinkedIn publish failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Publish failed',
      details: err.response?.data || err.message
    });
  }
});

app.listen(PORT || 3000, () => {
  console.log(`🚀 Middleware running on port ${PORT || 3000}`);
});

const accessToken = tokenResponse.data.access_token;
console.log('✅ NEW ACCESS TOKEN:', accessToken); // ← add this line