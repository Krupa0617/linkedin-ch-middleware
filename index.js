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
  res.send(`
    <html>
      <body style="font-family: Arial; padding: 40px;">
        <h2>✅ LinkedIn Content Hub Middleware is Running</h2>
        <p><strong>Available Endpoints:</strong></p>
        <ul>
          <li>GET <a href="/auth/linkedin">/auth/linkedin</a> — Start LinkedIn login</li>
          <li>GET /auth/linkedin/callback — LinkedIn OAuth callback</li>
          <li>POST /linkedin/publish — Publish content to LinkedIn</li>
        </ul>
      </body>
    </html>
  `);
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
// STEP 2: LinkedIn callback — shows Member ID
// and Access Token on screen for easy copying
// ─────────────────────────────────────────────
app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <html>
        <body style="font-family: Arial; padding: 40px;">
          <h2>❌ LinkedIn Auth Failed</h2>
          <p><strong>Error:</strong> ${error}</p>
          <a href="/auth/linkedin">Try Again</a>
        </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html>
        <body style="font-family: Arial; padding: 40px;">
          <h2>❌ No code received from LinkedIn</h2>
          <a href="/auth/linkedin">Try Again</a>
        </body>
      </html>
    `);
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

    console.log('✅ Access Token:', accessToken);
    console.log('✅ Expires In:', expiresIn, 'seconds');

    // Get LinkedIn user profile
    const profileResponse = await axios.get(
      'https://api.linkedin.com/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const userInfo = profileResponse.data;

    console.log('✅ Member Info:', JSON.stringify(userInfo));
    console.log('✅ Member ID (sub):', userInfo.sub);
    console.log('✅ Member Name:', userInfo.name);
    console.log('✅ Member Email:', userInfo.email);

    // Calculate expiry date
    const expiryDate = new Date(Date.now() + expiresIn * 1000).toLocaleDateString();

    // Show credentials on screen for easy copying
    res.send(`
      <html>
        <head>
          <title>LinkedIn Auth Success</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; max-width: 700px; }
            h2 { color: #0077B5; }
            .card { background: #f4f4f4; border-radius: 8px; padding: 20px; margin: 20px 0; }
            label { font-weight: bold; display: block; margin-bottom: 6px; }
            input {
              width: 100%;
              padding: 10px;
              font-size: 14px;
              border: 1px solid #ccc;
              border-radius: 4px;
              box-sizing: border-box;
              background: white;
              cursor: pointer;
            }
            .copy-btn {
              margin-top: 8px;
              padding: 6px 16px;
              background: #0077B5;
              color: white;
              border: none;
              border-radius: 4px;
              cursor: pointer;
            }
            .warning {
              background: #fff3cd;
              border: 1px solid #ffc107;
              border-radius: 8px;
              padding: 16px;
              margin-top: 20px;
            }
            .steps { background: #e8f5e9; border-radius: 8px; padding: 20px; margin-top: 20px; }
            .steps ol { margin: 0; padding-left: 20px; }
            .steps li { margin-bottom: 8px; }
          </style>
        </head>
        <body>
          <h2>✅ LinkedIn Authentication Successful!</h2>
          <p>Hello, <strong>${userInfo.name}</strong>! Copy the values below into Vercel Environment Variables.</p>

          <div class="card">
            <label>LINKEDIN_MEMBER_ID (your sub value):</label>
            <input 
              id="memberId"
              value="${userInfo.sub}" 
              onclick="this.select()"
              readonly
            />
            <button class="copy-btn" onclick="copyText('memberId')">Copy</button>
          </div>

          <div class="card">
            <label>LINKEDIN_ACCESS_TOKEN (expires: ${expiryDate}):</label>
            <input 
              id="accessToken"
              value="${accessToken}" 
              onclick="this.select()"
              readonly
            />
            <button class="copy-btn" onclick="copyText('accessToken')">Copy</button>
          </div>

          <div class="card">
            <label>Your LinkedIn Profile Info:</label>
            <p>👤 <strong>Name:</strong> ${userInfo.name}</p>
            <p>📧 <strong>Email:</strong> ${userInfo.email}</p>
            <p>🆔 <strong>Member ID:</strong> ${userInfo.sub}</p>
            <p>⏳ <strong>Token Expires:</strong> ${expiryDate}</p>
          </div>

          <div class="steps">
            <strong>📋 Next Steps:</strong>
            <ol>
              <li>Copy <strong>LINKEDIN_MEMBER_ID</strong> → paste in Vercel Environment Variables</li>
              <li>Copy <strong>LINKEDIN_ACCESS_TOKEN</strong> → paste in Vercel Environment Variables</li>
              <li>Add <strong>API_SECRET_KEY</strong> = any random secret (e.g. ch_secret_2024)</li>
              <li>Redeploy your Vercel project</li>
              <li>Update Content Hub Action author value to: <code>urn:li:person:${userInfo.sub}</code></li>
            </ol>
          </div>

          <div class="warning">
            ⚠️ <strong>Important:</strong> This page shows sensitive credentials. 
            Once you have copied the values, remove or secure this debug endpoint 
            before going to production.
          </div>

          <script>
            function copyText(id) {
              const input = document.getElementById(id);
              input.select();
              document.execCommand('copy');
              alert('Copied to clipboard!');
            }
          </script>
        </body>
      </html>
    `);

  } catch (err) {
    console.error('❌ Token exchange failed:', err.response?.data || err.message);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; padding: 40px;">
          <h2>❌ Token Exchange Failed</h2>
          <p><strong>Error:</strong> ${err.message}</p>
          <pre>${JSON.stringify(err.response?.data, null, 2)}</pre>
          <a href="/auth/linkedin">Try Again</a>
        </body>
      </html>
    `);
  }
});

// ─────────────────────────────────────────────
// STEP 3: Publish content to LinkedIn
// Called by Content Hub Trigger/Action
// ─────────────────────────────────────────────
app.post('/linkedin/publish', async (req, res) => {

  // Security check
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const accessToken = LINKEDIN_ACCESS_TOKEN;
  const memberId = LINKEDIN_MEMBER_ID;

  if (!accessToken || !memberId) {
    console.error('❌ Missing LINKEDIN_ACCESS_TOKEN or LINKEDIN_MEMBER_ID');
    return res.status(500).json({ error: 'Missing LinkedIn credentials in environment variables' });
  }

  const { shareCommentary, lifecycleState, shareMediaCategory, visibility } = req.body;

  console.log('📢 Publishing to LinkedIn...');
  console.log('Author: urn:li:person:' + memberId);
  console.log('Message:', shareCommentary);

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

    console.log('✅ Published! Post ID:', postResponse.data.id);
    res.json({ success: true, postId: postResponse.data.id });

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