import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import cors from 'cors';

dotenv.config();

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
// Helper: Authenticate with Content Hub
// ─────────────────────────────────────────────
async function getContentHubToken(contentHubBaseUrl) {
  try {
    console.log('🔐 Authenticating with Content Hub...');
    const response = await axios.post(
      `${contentHubBaseUrl}/api/authenticate`,
      {
        user_name: CONTENT_HUB_USERNAME,
        password: CONTENT_HUB_PASSWORD
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const token = response.data.token
      || response.data.access_token
      || response.data;

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
// Helper: Get asset details from Content Hub API
// Returns { title, imageUrl, imageToken, socialCaption }
// ─────────────────────────────────────────────
async function getAssetDetails(assetId, contentHubBaseUrl) {
  try {
    console.log(`🔍 Fetching asset details for ID: ${assetId}`);

    // Get auth token
    const token = await getContentHubToken(contentHubBaseUrl);
    if (!token) return { title: null, imageUrl: null, imageToken: null, socialCaption: null };

    // Fetch asset entity
    const response = await axios.get(
      `${contentHubBaseUrl}/api/entities/${assetId}`,
      {
        headers: {
          'X-Auth-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    const entity = response.data;
    const props = entity?.properties || {};

    console.log('✅ Asset fetched successfully');

    // ── Get Title ──
    const title = props.Title || props.FileName || entity?.identifier || null;
    console.log('✅ Title:', title);

    // ── Get SocialPostCaption ──
    // SocialPostCaption is a multilingual field: { "en-US": "caption text" }
    let socialCaption = null;
    const rawCaption = props.SocialPostCaption;
    if (rawCaption && typeof rawCaption === 'object') {
      socialCaption = rawCaption['en-US']
        || rawCaption['(Default)']
        || Object.values(rawCaption)[0]
        || null;
    }
    console.log('✅ SocialPostCaption:', socialCaption || '(empty)');

    // ── Get Image URL from Renditions ──
    let imageUrl = null;
    const renditions = entity?.renditions;

    if (renditions && typeof renditions === 'object') {
      imageUrl = renditions.downloadOriginal?.[0]?.href || renditions.downloadOriginal?.[0]?.url || null;
      console.log(`✅ Image rendition selected: ${imageUrl}`);
    }

    if (!imageUrl) {
      console.log('⚠️ No suitable image rendition found');
    }

    return { title, imageUrl, imageToken: token, socialCaption };

  } catch (err) {
    console.error('❌ Failed to fetch asset:', err.response?.status, err.message);
    return { title: null, imageUrl: null, imageToken: null, socialCaption: null };
  }
}

// ─────────────────────────────────────────────
// Helper: Upload image to LinkedIn
// ✅ FIXED: Pass token for authenticated image download
// ─────────────────────────────────────────────
async function uploadImageToLinkedIn(imageUrl, imageToken, accessToken, memberId) {
  try {
    console.log('🖼️ Starting LinkedIn image upload...');
    console.log('🖼️ Image URL:', imageUrl);

    // Step A: Register upload with LinkedIn
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
    console.log('✅ LinkedIn Asset URN:', assetUrn);

    // Step B: Download image from Content Hub WITH auth token
    console.log('📥 Downloading image from Content Hub...');
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'X-Auth-Token': imageToken
      },
      maxContentLength: 20 * 1024 * 1024,
      timeout: 30000
    });

    const imageBuffer = Buffer.from(imageResponse.data);
    const imageContentType = imageResponse.headers['content-type'] || '';
    console.log('✅ Image downloaded:', imageBuffer.length, 'bytes');
    console.log('✅ Image content type:', imageContentType);

    if (imageBuffer.length === 0) {
      console.error('❌ Downloaded image buffer is empty!');
      return null;
    }

    if (!imageContentType.startsWith('image/')) {
      console.error('❌ Content Hub download did not return an image:', imageContentType);
      return null;
    }

    // Step C: Upload to LinkedIn
    console.log('📤 Uploading to LinkedIn...');
    console.log('📤 Upload URL:', uploadUrl);
    await axios.put(uploadUrl, imageBuffer, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': imageContentType
      },
      maxContentLength: 20 * 1024 * 1024,
      timeout: 30000
    });

    console.log('✅ Image uploaded to LinkedIn successfully!');
    return assetUrn;

  } catch (err) {
    console.error('❌ Image upload failed:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

async function waitForLinkedInAsset(assetUrn, accessToken) {
  const encodedAssetUrn = encodeURIComponent(assetUrn);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await axios.get(
      `https://api.linkedin.com/v2/assets/${encodedAssetUrn}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0'
        },
        timeout: 10000
      }
    );

    const status = response.data?.recipes?.[0]?.status || response.data?.status;
    console.log(`LinkedIn asset status attempt ${attempt}:`, status || 'unknown');

    if (!status || status === 'AVAILABLE' || status === 'READY') {
      return true;
    }

    if (status === 'PROCESSING_FAILED' || status === 'FAILED') {
      throw new Error(`LinkedIn image processing failed: ${status}`);
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  throw new Error('LinkedIn image was uploaded but did not become available in time');
}

// ─────────────────────────────────────────────
// Helper: Build text-only post
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

// GET handler for test connection
app.get('/linkedin/publish', (req, res) => {
  res.json({ status: '✅ LinkedIn publish endpoint is ready. Use POST to publish.' });
});

// ─────────────────────────────────────────────
// STEP 3: Publish content to LinkedIn
// ─────────────────────────────────────────────
app.post('/linkedin/publish', async (req, res) => {

  console.log('📢 Incoming publish request from Content Hub');
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

  // Read context from Content Hub
  const context = req.body.context || {};
  const saveMsg = req.body.saveEntityMessage || {};

  const assetId = req.headers['target_id'] || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;
  const lifecycleState = context.lifecycleState || 'PUBLISHED';
  const visibility = context.visibility || 'PUBLIC';

  console.log('✅ Asset ID:', assetId);
  console.log('✅ Source System:', sourceSystem);

  // Fetch asset details from Content Hub
  let shareCommentary = context.shareCommentary || null;
  let imageUrl = null;
  let imageToken = null;

  if (assetId && sourceSystem && CONTENT_HUB_USERNAME && CONTENT_HUB_PASSWORD) {
    const assetDetails = await getAssetDetails(assetId, sourceSystem);

    // ── Build post text ──
    // Priority: SocialPostCaption > Title from context > Title from API
    if (assetDetails.socialCaption) {
      shareCommentary = assetDetails.socialCaption;
      console.log('✅ Using SocialPostCaption for post text');
    } else if (!shareCommentary || shareCommentary === '{Title}') {
      shareCommentary = assetDetails.title;
      console.log('✅ Using Title for post text');
    }

    imageUrl = assetDetails.imageUrl;
    imageToken = assetDetails.imageToken;
  }

  // Final fallback
  if (!shareCommentary) {
    shareCommentary = 'New content published from Sitecore Content Hub';
  }

  console.log('✅ Final Post Text:', shareCommentary);
  console.log('✅ Image URL:', imageUrl || 'none');

  try {
    let postBody;
    let linkedInImageAssetUrn = null;

    if (imageUrl && imageToken) {
      // Post WITH image
      console.log('🖼️ Uploading image to LinkedIn...');
      const assetUrn = await uploadImageToLinkedIn(imageUrl, imageToken, accessToken, memberId);

      if (assetUrn) {
        linkedInImageAssetUrn = assetUrn;
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
        console.log('📸 Posting WITH image...');
      } else {
        console.log('⚠️ Image upload failed — text only post');
        postBody = buildTextOnlyPost(memberId, shareCommentary, lifecycleState, visibility);
      }
    } else {
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
      postText: shareCommentary,
      hasImage: !!linkedInImageAssetUrn,
      imageAssetUrn: linkedInImageAssetUrn,
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


// ─────────────────────────────────────────────
// PUBLISH campaign — multiple assets from campaign
// POST /api/linkedin/publish-campaign
// ─────────────────────────────────────────────
app.post('/api/linkedin/publish-campaign', async (req, res) => {
  console.log('📢 Incoming LinkedIn campaign publish request');
  console.log('Body:', JSON.stringify(req.body));

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const accessToken = LINKEDIN_ACCESS_TOKEN;
  const memberId = LINKEDIN_MEMBER_ID;

  if (!accessToken) return res.status(500).json({ error: 'LINKEDIN_ACCESS_TOKEN not configured' });
  if (!memberId) return res.status(500).json({ error: 'LINKEDIN_MEMBER_ID not configured' });

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

    // Step 2: Fetch campaign entity to get linked assets
    // const campaignResponse = await axios.get(
    //   `${sourceSystem}/api/entities/${campaignId}?members=CampaignContent`,
    //   { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
    // );
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

// Get campaign title for caption
const campaignResponse = await axios.get(
  `${sourceSystem}/api/entities/${campaignId}`,
  { headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' } }
);
const rawCaption = campaignResponse.data?.properties?.SocialPostCaption;

let caption = 'Campaign post from Sitecore Content Hub';

if (rawCaption && typeof rawCaption === 'object') {
  caption =
    rawCaption['en-US'] ||
    rawCaption['(Default)'] ||
    Object.values(rawCaption)[0] ||
    caption;
} else if (typeof rawCaption === 'string') {
  caption = rawCaption;
}   const campaign = campaignResponse.data;

const shareCommentary =
  campaign?.properties?.SocialPostCaption ||
  'Campaign post from Sitecore Content Hub';

console.log('✅ Found', assetIds.length, 'assets in campaign');

if (assetIds.length === 0) {
  return res.status(400).json({
    error: 'No assets found in campaign'
  });
}

    // Step 3: Upload each asset to LinkedIn (max 20)
    const mediaArray = [];
    for (const assetId of assetIds.slice(0, 20)) {

      const assetDetails = await getAssetDetails(assetId, sourceSystem);

      if (!assetDetails.imageUrl) {
        console.log(`⚠️ Skipping asset ${assetId} — no image URL`);
        continue;
      }

      const assetUrn = await uploadImageToLinkedIn(
        assetDetails.imageUrl,
        assetDetails.imageToken,
        accessToken,
        memberId
      );

      if (assetUrn) {
        // await waitForLinkedInAsset(assetUrn, accessToken);
        mediaArray.push({
          status: 'READY',
          description: { text: shareCommentary },
          media: assetUrn,
          title: { text: assetDetails.title || shareCommentary }
        });
        console.log(`✅ Asset ${assetId} uploaded: ${assetUrn}`);
      }
    }

    if (mediaArray.length === 0) {
      return res.status(400).json({ error: 'No assets could be uploaded to LinkedIn' });
    }

    // Step 4: Post carousel to LinkedIn
    const postBody = {
      author: `urn:li:person:${memberId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: shareCommentary },
          shareMediaCategory: 'IMAGE',
          media: mediaArray
        }
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
      }
    };

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

    console.log('✅ LinkedIn carousel published! Post ID:', postResponse.data.id);

    res.json({
      success: true,
      postId: postResponse.data.id,
      shareCommentary,
      assetCount: mediaArray.length,
      message: 'Successfully published carousel to LinkedIn',
    });

  } catch (err) {
    console.error('❌ LinkedIn carousel publish failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to publish carousel to LinkedIn',
      details: err.response?.data || err.message,
    });
  }
});

// ✅ REMOVED: app.listen() - Vercel serverless handles this via wrapper
// For local development, the wrapper will handle server startup
// For Vercel, api/linkedin.js will wrap this with serverless-http

export default app;
