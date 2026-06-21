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
// Helper: Upload image to LinkedIn
// Returns LinkedIn image asset URN
// ─────────────────────────────────────────────
async function uploadImageToLinkedIn(imageUrl, accessToken, memberId) {
  try {
    console.log('🖼️ Starting image upload to LinkedIn...');
    console.log('🖼️ Image URL:', imageUrl);

    // Step A: Register image upload
    const registerResponse = await axios.post(
      'https://api.linkedin.com/v2/assets?action=registerUpload',
      {
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          owner: `urn:li:person:${memberId}`,
          serviceRelationships: [
            {
              relationshipType: 'OWNER',
              identifier: 'urn:li:userGeneratedContent'
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      }
    );

    const uploadUrl = registerResponse.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const assetUrn = registerResponse.data.value.asset;

    console.log('✅ Upload URL obtained');
    console.log('✅ Asset URN:', assetUrn);

    // Step B: Download image from Content Hub URL
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    console.log('✅ Image downloaded, size:', imageBuffer.length, 'bytes');

    // Step C: Upload image binary to LinkedIn
    await axios.put(uploadUrl, imageBuffer, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream'
      }
    });

    console.log('✅ Image uploaded to LinkedIn successfully!');
    return assetUrn;

  } catch (err) {
    console.error('❌ Image upload failed:', err.response?.data || err.message);
    return null; // fallback to text-only post
  }
}

// ─────────────────────────────────────────────
// STEP 3: Publish content to LinkedIn
// Supports text-only and image posts
// Called by Content Hub Trigger/Action
// ─────────────────────────────────────────────
app.post('/linkedin/publish', async (req, res) => {

  console.log('📢 Incoming publish request from Content Hub');
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));

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

  // Read values from Content Hub
  const shareCommentary = req.body.shareCommentary || req.body.ShareCommentary || 'New content published from Sitecore Content Hub';
  const lifecycleState = req.body.lifecycleState || req.body.LifecycleState || 'PUBLISHED';
  const visibility = req.body.visibility || req.body.Visibility || 'PUBLIC';
  const imageUrl = req.body.imageUrl || req.body.ImageUrl || null; // ← public URL of asset

  console.log('Message:', shareCommentary);
  console.log('Image URL:', imageUrl);

  try {
    let postBody;

    if (imageUrl) {
      // ── Post WITH image ──
      console.log('🖼️ Image URL provided — uploading image to LinkedIn...');
      const assetUrn = await uploadImageToLinkedIn(imageUrl, accessToken, memberId);

      if (assetUrn) {
        // Image uploaded successfully — create post with image
        postBody = {
          author: `urn:li:person:${memberId}`,
          lifecycleState,
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: { text: shareCommentary },
              shareMediaCategory: 'IMAGE',
              media: [
                {
                  status: 'READY',
                  description: { text: shareCommentary },
                  media: assetUrn,
                  title: { text: shareCommentary }
                }
              ]
            }
          },
          visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': visibility
          }
        };
        console.log('📸 Posting with image...');
      } else {
        // Image upload failed — fallback to text only
        console.log('⚠️ Image upload failed, falling back to text-only post');
        postBody = buildTextOnlyPost(memberId, shareCommentary, lifecycleState, visibility);
      }
    } else {
      // ── Text-only post ──
      console.log('📝 No image URL — posting text only...');
      postBody = buildTextOnlyPost(memberId, shareCommentary, lifecycleState, visibility);
    }

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
      hasImage: !!imageUrl,
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

// Helper: build text-only post body
function buildTextOnlyPost(memberId, shareCommentary, lifecycleState, visibility) {
  return {
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
}

// Handle GET on /linkedin/publish for test connection
app.get('/linkedin/publish', (req, res) => {
  res.json({ status: '✅ LinkedIn publish endpoint is ready. Use POST to publish.' });
});

app.listen(PORT || 3000, () => {
  console.log(`🚀 Middleware running on port ${PORT || 3000}`);
});