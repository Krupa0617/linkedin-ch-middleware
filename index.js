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
// Helper: Authenticate with Content Hub
// Returns auth token string
// ✅ FIXED: Properly extract token from response
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
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    // ✅ FIXED: Extract token correctly from various response formats
    // Content Hub may return { token: "..." } or { access_token: "..." } or just the token string
    const token = response.data.token 
      || response.data.access_token 
      || response.data;
    
    // ✅ NEW: Validate token format
    if (typeof token !== 'string') {
      console.error('❌ Token extraction failed - not a string');
      console.error('❌ Response data:', JSON.stringify(response.data));
      return null;
    }

    if (token.trim().length === 0) {
      console.error('❌ Token is empty string');
      return null;
    }

    console.log('✅ Content Hub token obtained');
    console.log('✅ Token length:', token.length, 'characters');
    return token;
    
  } catch (err) {
    console.error('❌ Content Hub auth failed:', err.response?.status, err.response?.data || err.message);
    console.error('❌ Full error details:', JSON.stringify(err.response?.data, null, 2));
    return null;
  }
}

// ─────────────────────────────────────────────
// Helper: Get asset details from Content Hub API
// Returns { title, publicUrl, allProperties, token, renditionInfo, socialCaption, approvedBy, approvalDate, mainFileWidth, mainFileHeight }
// ✅ UPDATED: Extract images from Renditions + nested property examples
// ─────────────────────────────────────────────
async function getAssetDetails(assetId, contentHubBaseUrl) {
  try {
    console.log(`🔍 Fetching asset details for ID: ${assetId} from ${contentHubBaseUrl}`);

    // Step 1: Get auth token
    const token = await getContentHubToken(contentHubBaseUrl);
    if (!token) {
      console.error('❌ Could not get Content Hub token');
      return { title: null, publicUrl: null, allProperties: {} };
    }

    // ✅ NEW: Validate token is a string before using
    if (typeof token !== 'string' || token.trim().length === 0) {
      console.error('❌ Invalid token format or empty token');
      return { title: null, publicUrl: null, allProperties: {} };
    }

    console.log('✅ Token validated - proceeding with asset fetch');

    // Step 2: Fetch asset entity
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
    console.log('✅ Asset entity fetched successfully');

    // ✅ NEW: Comprehensive property logging
    console.log('\n📋 ═══════════════════════════════════════════');
    console.log('📋 ALL ASSET PROPERTIES');
    console.log('📋 ═══════════════════════════════════════════');
    
    if (entity?.properties) {
      // Full JSON output
      console.log('📋 Full Properties Object (JSON):');
      console.log(JSON.stringify(entity.properties, null, 2));
      
      // Individual property breakdown
      console.log('\n📋 Property Breakdown:');
      const propertyKeys = Object.keys(entity.properties);
      console.log(`📋 Total properties: ${propertyKeys.length}`);
      
      propertyKeys.forEach((key, index) => {
        const value = entity.properties[key];
        const valueType = typeof value;
        console.log(`\n  ${index + 1}. ${key}`);
        console.log(`     Type: ${valueType}`);
        if (Array.isArray(value)) {
          console.log(`     Is Array: true (length: ${value.length})`);
          console.log(`     Value: ${JSON.stringify(value)}`);
        } else if (typeof value === 'object' && value !== null) {
          console.log(`     Is Object: true`);
          console.log(`     Value: ${JSON.stringify(value, null, 2)}`);
        } else {
          console.log(`     Value: ${value}`);
        }
      });
    } else {
      console.log('📋 ⚠️  No properties found in entity');
    }
    
    console.log('📋 ═══════════════════════════════════════════\n');

    // ✅ NEW: Log complete entity structure
    console.log('📋 ENTITY STRUCTURE:');
    const entityKeys = Object.keys(entity);
    console.log(`📋 Entity has ${entityKeys.length} top-level fields:`);
    entityKeys.forEach((key, index) => {
      console.log(`  ${index + 1}. ${key}: ${typeof entity[key]}`);
    });
    console.log('');

    // Get title from properties
    const title = entity?.properties?.Title
      || entity?.properties?.FileName
      || entity?.properties?.Name
      || entity?.identifier
      || null;

    // ═══════════════════════════════════════════════════════════════
    // ✅ UPDATED: Extract image URL from Renditions (NOT _links)
    // ═══════════════════════════════════════════════════════════════
    let publicUrl = null;
    let renditionInfo = null;

    const renditions = entity?.properties?.Renditions;
    
    if (renditions && typeof renditions === 'object') {
      console.log('📸 ═══════════════════════════════════════════');
      console.log('📸 RENDITIONS FOUND:');
      console.log(`📸 Available renditions: ${Object.keys(renditions).join(', ')}`);
      
      // Priority order for image selection
      const renditionPriority = [
        'preview',           // Best for LinkedIn (good quality)
        'preview_download',  // Alternative preview
        'thumbnail_cropped', // Cropped thumbnail
        'bigthumbnail',      // Larger thumbnail
        'thumbnail',         // Small thumbnail
        'pdf'                // Last resort
      ];

      for (const renditionType of renditionPriority) {
        const rendition = renditions[renditionType];
        
        if (rendition && rendition.locations && rendition.locations.local && rendition.status === 'completed') {
          // ✅ NEW: Build proper Content Hub rendition URL
          publicUrl = `${contentHubBaseUrl}/api/entities/${assetId}/renditions/${renditionType}/download`;
          
          renditionInfo = {
            type: renditionType,
            status: rendition.status || 'unknown',
            properties: rendition.properties || {},
            url: publicUrl
          };

          console.log(`📸 Using rendition: ${renditionType}`);
          console.log(`📸   Status: ${rendition.status}`);
          console.log(`📸   URL: ${publicUrl}`);
          if (rendition.properties) {
            console.log(`📸   Dimensions: ${rendition.properties.width}x${rendition.properties.height}`);
            console.log(`📸   Content Type: ${rendition.properties.content_type}`);
            console.log(`📸   File Size: ${rendition.properties.filesizebytes} bytes`);
          }
          break; // Use first available in priority order
        }
      }

      console.log('📸 ═══════════════════════════════════════════\n');
    } else {
      console.log('⚠️  No renditions found in properties');
    }

    // Add token to image URL for authenticated access
    if (publicUrl && token) {
      publicUrl = publicUrl.includes('?')
        ? `${publicUrl}&X-Auth-Token=${token}`
        : `${publicUrl}?X-Auth-Token=${token}`;
    }

    // ═══════════════════════════════════════════════════════════════
    // ✅ NEW: Example of accessing nested properties
    // ═══════════════════════════════════════════════════════════════
    console.log('💡 ═══════════════════════════════════════════');
    console.log('💡 NESTED PROPERTY EXAMPLES:');
    
    // Simple property
    const fileName = entity?.properties?.FileName;
    console.log(`  ✓ Simple: FileName = "${fileName}"`);
    
    // Nested property (FileProperties.properties.colorspace)
    const colorspace = entity?.properties?.FileProperties?.properties?.colorspace;
    console.log(`  ✓ Nested: FileProperties.properties.colorspace = "${colorspace}"`);
    
    // Empty object property (SocialPostCaption)
    const socialCaption = entity?.properties?.SocialPostCaption;
    const hasSocialCaption = Object.keys(socialCaption || {}).length > 0;
    console.log(`  ✓ Empty Object: SocialPostCaption = ${JSON.stringify(socialCaption)} (has value: ${hasSocialCaption})`);
    
    // Complex nested (MainFile.properties)
    const mainFileWidth = entity?.properties?.MainFile?.properties?.width;
    console.log(`  ✓ Complex: MainFile.properties.width = "${mainFileWidth}"`);
    
    // Approval info
    const approvedBy = entity?.properties?.ApprovedBy;
    const approvalDate = entity?.properties?.ApprovalDate;
    console.log(`  ✓ Approval: ApprovedBy = "${approvedBy}" on ${approvalDate}`);
    
    console.log('💡 ═══════════════════════════════════════════\n');

    console.log('✅ Asset Title:', title);
    console.log('✅ Asset Image URL:', publicUrl ? 'Found ✓' : 'Not found - text only post');

    return { 
      title, 
      publicUrl, 
      token,
      allProperties: entity?.properties || {},
      renditionInfo,
      socialCaption: socialCaption && Object.keys(socialCaption).length > 0 ? socialCaption['en-US'] || socialCaption : null,
      approvedBy,
      approvalDate,
      mainFileWidth,
      mainFileHeight: entity?.properties?.MainFile?.properties?.height
    };

  } catch (err) {
    console.error('\n❌ Failed to fetch asset from Content Hub');
    console.error('❌ Error Status:', err.response?.status);
    console.error('❌ Error Message:', err.message);
    
    if (err.response?.data) {
      console.error('❌ Error Data:', JSON.stringify(err.response.data, null, 2));
    }

    // ✅ NEW: Enhanced troubleshooting for 401 error
    if (err.response?.status === 401) {
      console.error('\n⚠️  401 UNAUTHORIZED - Troubleshooting Steps:');
      console.error('   1. ❓ Verify CONTENT_HUB_USERNAME is correct');
      console.error('   2. ❓ Verify CONTENT_HUB_PASSWORD is correct');
      console.error('   3. ❓ Check if user has permissions to access asset ID:', assetId);
      console.error('   4. ❓ Verify asset ID exists in Content Hub');
      console.error('   5. ❓ Check if Content Hub API token is valid/not expired');
      console.error('   6. ❓ Ensure X-Auth-Token header is correctly formatted');
    }

    return { 
      title: null, 
      publicUrl: null, 
      token: null,
      allProperties: {}
    };
  }
}

// ─────────────────────────────────────────────
// Helper: Upload image to LinkedIn
// Returns LinkedIn asset URN or null
// ─────────────────────────────────────────────
async function uploadImageToLinkedIn(imageUrl, accessToken, memberId) {
  try {
    console.log('🖼️ Starting image upload to LinkedIn...');

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
      responseType: 'arraybuffer'
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
  // Read data from Content Hub request
  // Data comes inside "context" object
  // ─────────────────────────────────────────
  const context = req.body.context || {};
  const saveMsg = req.body.saveEntityMessage || {};

  // Get asset ID and source system from headers
  const assetId = req.headers['target_id'] || saveMsg.TargetId;
  const sourceSystem = req.headers['source_system'] || CONTENT_HUB_URL;

  // Get lifecycle values from context
  const lifecycleState = context.lifecycleState || 'PUBLISHED';
  const visibility = context.visibility || 'PUBLIC';

  console.log('✅ Asset ID:', assetId);
  console.log('✅ Source System:', sourceSystem);

  // ─────────────────────────────────────────
  // Fetch real asset details from Content Hub
  // ─────────────────────────────────────────
  let shareCommentary = context.shareCommentary || null;
  let imageUrl = null;
  let allAssetProperties = {};

  if (assetId && sourceSystem && CONTENT_HUB_USERNAME && CONTENT_HUB_PASSWORD) {
    console.log('🔍 Fetching asset details from Content Hub API...');
    const assetDetails = await getAssetDetails(assetId, sourceSystem);

    // ✅ NEW: Store all properties for flexible use
    allAssetProperties = assetDetails.allProperties || {};

    // Use fetched title if token not resolved
    if (!shareCommentary || shareCommentary === '{Title}' || shareCommentary.trim() === '') {
      shareCommentary = assetDetails.title;
    }

    // Use fetched image URL
    imageUrl = assetDetails.publicUrl || null;
  } else {
    console.log('⚠️ Skipping asset fetch - missing credentials or asset ID');
    if (!CONTENT_HUB_USERNAME) console.log('❌ CONTENT_HUB_USERNAME not set');
    if (!CONTENT_HUB_PASSWORD) console.log('❌ CONTENT_HUB_PASSWORD not set');
  }

  // Final fallback for commentary
  if (!shareCommentary) {
    shareCommentary = 'New content published from Sitecore Content Hub';
  }

  console.log('✅ Final Share Commentary:', shareCommentary);
  console.log('✅ Final Image URL:', imageUrl ? 'Found' : 'Not found - text only post');
  console.log('✅ Available asset properties:', Object.keys(allAssetProperties).join(', '));

  try {
    let postBody;

    if (imageUrl) {
      // ── Post WITH image ──
      console.log('🖼️ Attempting to upload image to LinkedIn...');
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
      availableProperties: Object.keys(allAssetProperties),
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