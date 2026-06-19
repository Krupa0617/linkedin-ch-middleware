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
  PORT
} = process.env;

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
// STEP 2: LinkedIn calls back here with a code
// ─────────────────────────────────────────────
app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).json({ error: 'LinkedIn auth failed', details: error });
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

    // Get LinkedIn user profile
    const profileResponse = await axios.get(
      'https://api.linkedin.com/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const userInfo = profileResponse.data;

    // Redirect back to Content Hub with token info
    const redirectUrl =
      `${CONTENT_HUB_URL}/en-US/account` +
      `?linkedin_token=${accessToken}` +
      `&linkedin_user=${encodeURIComponent(userInfo.name)}`;

    res.redirect(redirectUrl);

  } catch (err) {
    console.error('Token exchange failed:', err.message);
    res.status(500).json({ error: 'Token exchange failed' });
  }
});

// ─────────────────────────────────────────────
// STEP 3: Publish content to LinkedIn
// Called by Content Hub Trigger/Action
// ─────────────────────────────────────────────
app.post('/linkedin/publish', async (req, res) => {
  const { accessToken, message, organizationId } = req.body;

  try {
    const postResponse = await axios.post(
      'https://api.linkedin.com/v2/ugcPosts',
      {
        author: `urn:li:organization:${organizationId}`,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text: message },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
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

    res.json({ success: true, postId: postResponse.data.id });

  } catch (err) {
    console.error('LinkedIn publish failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Publish failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});