require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const {
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  REDIRECT_URI,
  CONTENT_HUB_URL,
  PORT,
  LINKEDIN_ACCESS_TOKEN,
  LINKEDIN_MEMBER_ID,
  API_SECRET_KEY,
  CONTENT_HUB_USERNAME,
  CONTENT_HUB_PASSWORD
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
// ─────────────────────────────────────────────
app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error: 'LinkedIn auth failed', details: error });
  if (!code) return res.status(400).json({ error: 'No authorization code received' });

  try {
    const tokenResponse = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken', null,
      {
        params: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: LINKEDIN_CLIENT_ID,
          client_secret: LINKEDIN_CLIENT_SECRET,
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;
    const expiresIn = tokenResponse.data.expires_in;
    console.log('✅ Access Token obtained');
    console.log('✅ Expires in:', Math.round(expiresIn / 86400), 'days');

    const profileResponse = await axios.get(
      'https://api.linkedin.com/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const userInfo = profileResponse.data;
    console.log('✅ Member ID:', userInfo.sub);
    console.log('✅ Member Name:', userInfo.name);

    res.redirect(`${CONTENT_HUB_URL}/en-US/account?linkedin_user=${encodeURIComponent(userInfo.name)}&auth=success`);

  } catch (err) {
    console.error('❌ Token exchange failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Token exchange failed', details: err.response?.data || err.message });
  }
});

// ─────────────────────────────────────────────
// STEP 3: Publish content to LinkedIn
// Called by Content Hub Trigger/Action
// ─────────────────────────────────────────────
app.post('/linkedin/publish', async (req, res) => {

  console.log('📢 Incoming publish request from Content Hub');
  
  // ===== DEBUG: Log everything being sent =====
  console.log('\n🔍 === FULL DEBUG INFO ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('\nBody:', JSON.stringify(req.body, null, 2));
  console.log('=== END DEBUG INFO ===\n');

  // Security check
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const accessToken = LINKEDIN_ACCESS_TOKEN;
  const memberId = LINKEDIN_MEMBER_ID;

  if (!accessToken) return res.status(500).json({ error: 'LINKEDIN_ACCESS_TOKEN not configured' });
  if (!memberId) return res.status(500).json({ error: 'LINKEDIN_MEMBER_ID not configured' });

  // ─────────────────────────────────────────
  // Extract data from Content Hub request
  // ─────────────────────────────────────────
  const context = req.body.context || {};
  const saveMsg = req.body.saveEntityMessage || {};

  const assetId = req.headers['target_id'] || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;
  const lifecycleState = context.lifecycleState || 'PUBLISHED';
  const visibility = context.visibility || 'PUBLIC';

  // ===== DEBUG: What we extracted =====
  console.log('✅ Asset ID:', assetId);
  console.log('✅ Source System:', sourceSystem);
  console.log('✅ Context.shareCommentary:', context.shareCommentary);
  console.log('✅ ChangeSet PropertyChanges:', JSON.stringify(saveMsg?.ChangeSet?.PropertyChanges, null, 2));
  
  // Try to find the caption from ChangeSet
  let shareCommentary = context.shareCommentary;
  const propertyChanges = saveMsg?.ChangeSet?.PropertyChanges || [];
  
  for (const change of propertyChanges) {
    console.log(`Found property change: ${change.Property} = ${change.NewValue}`);
    // If there's a property with "Caption" or similar, use it
    if (change.Property?.toLowerCase().includes('caption') || 
        change.Property?.toLowerCase().includes('description')) {
      shareCommentary = change.NewValue;
      console.log(`✅ Found caption in ChangeSet: ${shareCommentary}`);
    }
  }

  // Final fallback
  if (!shareCommentary || shareCommentary === '{Post Caption}' || shareCommentary === '{SocialPostCaption}' || !shareCommentary.trim()) {
    shareCommentary = 'New content published from Sitecore Content Hub';
    console.log('⚠️ Using fallback caption');
  }

  console.log('✅ Final Share Commentary:', shareCommentary);

  try {
    const postBody = {
      author: `urn:li:person:${memberId}`,
      lifecycleState,
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: shareCommentary },
          shareMediaCategory: 'NONE'
        }
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility
      }
    };

    console.log('📝 Posting to LinkedIn with body:', JSON.stringify(postBody, null, 2));

    const postResponse = await axios.post(
      'https://api.linkedin.com/v2/ugcPosts',
      postBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      }
    );

    console.log('✅ Successfully published to LinkedIn!');
    console.log('✅ Post ID:', postResponse.data.id);

    res.json({
      success: true,
      postId: postResponse.data.id,
      shareCommentary,
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