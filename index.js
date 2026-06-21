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
  CONTENT_HUB_API_KEY
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
// Helper: Get asset details from Content Hub API
// Returns { title, publicUrl, thumbnailUrl }
// ─────────────────────────────────────────────
async function getAssetDetails(assetId, contentHubBaseUrl) {
  try {
    console.log(`🔍 Fetching asset details for ID: ${assetId} from ${contentHubBaseUrl}`);

    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/${assetId}`,
      {
        headers: {
          'X-Auth-Token': CONTENT_HUB_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const entity = response.data;
    console.log('✅ Asset entity fetched:', JSON.stringify(entity?.properties));

    // Get title
    const title = entity?.properties?.Title
      || entity?.properties?.FileName
      || entity?.identifier
      || 'New content published from Sitecore Content Hub';

    // Get public link from entity links
    let publicUrl = null;
    const links = entity?.['_links'] || {};

    // Try to get thumbnail or preview URL
    if (links['thumbnail']) {
      publicUrl = links['thumbnail']?.href || null;
    } else if (links['preview']) {
      publicUrl = links['preview']?.href || null;
    } else if (links['download']) {
      publicUrl = links['download']?.href || null;
    }

    // Try renditions if available
    if (!publicUrl && entity?.renditions) {
      const renditions = entity.renditions;
      publicUrl = renditions?.thumbnail?.href
        || renditions?.preview?.href
        || renditions?.download?.href
        || null;
    }

    console.log('✅ Asset Title:', title);
    console.log('✅ Asset Public URL:', publicUrl);

    return { title, publicUrl };

  } catch (err) {
    console.error('❌ Failed to fetch asset from Content Hub:', err.response?.data || err.message);
    return { title: null, publicUrl: null };
  }
}

// ─────────────────────────────────────────────
// Helper: Upload image to LinkedIn
// Returns LinkedIn asset URN or null
// ─────────────────────────────────────────────
async function uploadImageToLinkedIn(imageUrl, accessToken, memberId) {
  try {
    console.log('🖼️ Starting image upload to LinkedIn...');
    console.log('🖼️ Image URL:', imageUrl);

    // Step A: Register image upload with LinkedIn
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

    const uploadUrl = registerResponse.data.value.uploadMechanism[
      'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'
    ].uploadUrl;
    const assetUrn = registerResponse.data.value.asset;

    console.log('✅ LinkedIn upload URL obtained');
    console.log('✅ Asset URN:', assetUrn);

    // Step B: Download image from Content Hub
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'X-Auth-Token': CONTENT_HUB_API_KEY
      }
    });

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
    console.error('❌ Image upload to LinkedIn failed:', err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Helper: Build text-only post body
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Handle GET on /linkedin/publish for test connection
// ─────────────────────────────────────────────
app.get('/linkedin/publish', (req, res) => {
  res.json({ status: '✅ LinkedIn publish endpoint is ready. Use POST to publish.' });
});

// ─────────────────────────────────────────────
// STEP 3: Publish content to LinkedIn
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

  // ─────────────────────────────────────────
  // Content Hub sends data inside "context"
  // Headers also contain useful metadata
  // ─────────────────────────────────────────
  const context = req.body.context || {};
  const saveMsg = req.body.saveEntityMessage || {};

  // Get asset ID and source system from headers
  const assetId = req.headers['target_id'] || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  console.log('✅ Asset ID:', assetId);
  console.log('✅ Source System:', sourceSystem);

  // Get lifecycle values from context
  const lifecycleState = context.lifecycleState || 'PUBLISHED';
  const visibility = context.visibility || 'PUBLIC';

  // ─────────────────────────────────────────
  // Fetch asset details from Content Hub API
  // to get real title and image URL
  // ─────────────────────────────────────────
  let shareCommentary = context.shareCommentary || null;
  let imageUrl = null;

  if (assetId && sourceSystem && CONTENT_HUB_API_KEY) {
    console.log('🔍 Fetching asset details from Content Hub...');
    const assetDetails = await getAssetDetails(assetId, sourceSystem);

    // Use fetched title if shareCommentary token didn't resolve properly
    if (!shareCommentary || shareCommentary === '{Title}' || shareCommentary === '') {
      shareCommentary = assetDetails.title;
    }

    // Use fetched image URL
    imageUrl = assetDetails.publicUrl;
  }

  // Final fallback for commentary
  if (!shareCommentary) {
    shareCommentary = 'New content published from Sitecore Content Hub';
  }

  console.log('✅ Share Commentary:', shareCommentary);
  console.log('✅ Image URL:', imageUrl);

  try {
    let postBody;

    if (imageUrl) {
      // ── Post WITH image ──
      console.log('🖼️ Uploading image to LinkedIn...');
      const assetUrn = await uploadImageToLinkedIn(imageUrl, accessToken, memberId);

      if (assetUrn) {
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
        console.log('⚠️ Image upload failed — falling back to text-only post');
        postBody = buildTextOnlyPost(memberId, shareCommentary, lifecycleState, visibility);
      }
    } else {
      // ── Text-only post ──
      console.log('📝 Posting text only...');
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
      shareCommentary,
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

app.listen(PORT || 3000, () => {
  console.log(`🚀 Middleware running on port ${PORT || 3000}`);
});