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
// STEP 2: LinkedIn callback — DEBUG VERSION
// Shows Member ID and Access Token on screen
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

    console.log('✅ New Access Token:', accessToken);
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

    // Calculate expiry date
    const expiryDate = new Date(Date.now() + expiresIn * 1000).toLocaleDateString('en-GB');

    // Show credentials on screen
    res.send(`
      <html>
        <head>
          <title>LinkedIn Auth Success</title>
          <style>
            * { box-sizing: border-box; }
            body { 
              font-family: Arial, sans-serif; 
              padding: 40px; 
              max-width: 750px; 
              margin: 0 auto;
              background: #f9f9f9;
            }
            h2 { color: #0077B5; }
            .card { 
              background: white; 
              border-radius: 8px; 
              padding: 20px; 
              margin: 16px 0; 
              box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            }
            label { 
              font-weight: bold; 
              display: block; 
              margin-bottom: 8px;
              color: #333;
            }
            .input-row {
              display: flex;
              gap: 8px;
              align-items: center;
            }
            input {
              flex: 1;
              padding: 10px;
              font-size: 13px;
              border: 1px solid #ccc;
              border-radius: 4px;
              background: #f4f4f4;
              cursor: pointer;
              font-family: monospace;
            }
            .copy-btn {
              padding: 10px 18px;
              background: #0077B5;
              color: white;
              border: none;
              border-radius: 4px;
              cursor: pointer;
              font-size: 13px;
              white-space: nowrap;
            }
            .copy-btn:hover { background: #005f91; }
            .copy-btn.copied { background: #28a745; }
            .info-grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 10px;
              margin-top: 10px;
            }
            .info-item {
              background: #f4f4f4;
              padding: 10px;
              border-radius: 4px;
            }
            .info-item span { 
              font-size: 12px; 
              color: #666; 
              display: block;
            }
            .info-item strong { font-size: 14px; }
            .steps {
              background: #e8f5e9;
              border: 1px solid #c8e6c9;
              border-radius: 8px;
              padding: 20px;
              margin-top: 16px;
            }
            .steps h3 { margin-top: 0; color: #2e7d32; }
            .steps ol { margin: 0; padding-left: 20px; }
            .steps li { margin-bottom: 10px; line-height: 1.5; }
            .steps code {
              background: #c8e6c9;
              padding: 2px 6px;
              border-radius: 3px;
              font-family: monospace;
            }
            .warning {
              background: #fff8e1;
              border: 1px solid #ffe082;
              border-radius: 8px;
              padding: 16px;
              margin-top: 16px;
              font-size: 13px;
            }
            .badge {
              display: inline-block;
              background: #0077B5;
              color: white;
              padding: 2px 8px;
              border-radius: 12px;
              font-size: 12px;
              margin-left: 8px;
            }
          </style>
        </head>
        <body>
          <h2>✅ LinkedIn Authentication Successful!</h2>
          <p>Hello, <strong>${userInfo.name}</strong>! Copy the values below and update your Vercel Environment Variables.</p>

          <!-- Member ID -->
          <div class="card">
            <label>
              LINKEDIN_MEMBER_ID
              <span class="badge">Copy to Vercel</span>
            </label>
            <div class="input-row">
              <input id="memberId" value="${userInfo.sub}" onclick="this.select()" readonly />
              <button class="copy-btn" onclick="copyText('memberId', this)">📋 Copy</button>
            </div>
          </div>

          <!-- Access Token -->
          <div class="card">
            <label>
              LINKEDIN_ACCESS_TOKEN
              <span class="badge">Copy to Vercel</span>
            </label>
            <div class="input-row">
              <input id="accessToken" value="${accessToken}" onclick="this.select()" readonly />
              <button class="copy-btn" onclick="copyText('accessToken', this)">📋 Copy</button>
            </div>
            <p style="margin: 8px 0 0; font-size: 12px; color: #e53935;">
              ⏳ This token expires on: <strong>${expiryDate}</strong> (~${Math.round(expiresIn / 86400)} days)
            </p>
          </div>

          <!-- Profile Info -->
          <div class="card">
            <label>Your LinkedIn Profile</label>
            <div class="info-grid">
              <div class="info-item">
                <span>👤 Name</span>
                <strong>${userInfo.name}</strong>
              </div>
              <div class="info-item">
                <span>📧 Email</span>
                <strong>${userInfo.email}</strong>
              </div>
              <div class="info-item">
                <span>🆔 Member ID</span>
                <strong>${userInfo.sub}</strong>
              </div>
              <div class="info-item">
                <span>⏳ Token Expires</span>
                <strong>${expiryDate}</strong>
              </div>
            </div>
          </div>

          <!-- Next Steps -->
          <div class="steps">
            <h3>📋 Next Steps</h3>
            <ol>
              <li>Click <strong>"📋 Copy"</strong> next to <code>LINKEDIN_ACCESS_TOKEN</code></li>
              <li>Go to <strong>Vercel → Your Project → Settings → Environment Variables</strong></li>
              <li>Find <code>LINKEDIN_ACCESS_TOKEN</code> → Click <strong>Edit</strong> → Paste new value → Save</li>
              <li>Also update <code>LINKEDIN_MEMBER_ID</code> if it changed</li>
              <li>Go to <strong>Vercel → Deployments → Redeploy</strong></li>
              <li>Test again from browser console</li>
            </ol>
          </div>

          <div class="warning">
            ⚠️ <strong>Security Note:</strong> This page displays sensitive credentials. 
            After copying the values and updating Vercel, switch back to the production 
            version of <code>index.js</code> that redirects to Content Hub instead of 
            showing this debug page.
          </div>

          <script>
            function copyText(id, btn) {
              const input = document.getElementById(id);
              input.select();
              document.execCommand('copy');
              const original = btn.innerHTML;
              btn.innerHTML = '✅ Copied!';
              btn.classList.add('copied');
              setTimeout(() => {
                btn.innerHTML = original;
                btn.classList.remove('copied');
              }, 2000);
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
          <pre style="background:#f4f4f4; padding:16px; border-radius:8px;">
${JSON.stringify(err.response?.data, null, 2)}
          </pre>
          <a href="/auth/linkedin">🔄 Try Again</a>
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
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    console.error('❌ Unauthorized - invalid or missing x-api-key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const accessToken = LINKEDIN_ACCESS_TOKEN;
  const memberId = LINKEDIN_MEMBER_ID;

  if (!accessToken) {
    console.error('❌ LINKEDIN_ACCESS_TOKEN is not set');
    return res.status(500).json({ error: 'LINKEDIN_ACCESS_TOKEN not configured in Vercel' });
  }

  if (!memberId) {
    console.error('❌ LINKEDIN_MEMBER_ID is not set');
    return res.status(500).json({ error: 'LINKEDIN_MEMBER_ID not configured in Vercel' });
  }

  const { shareCommentary, lifecycleState, shareMediaCategory, visibility } = req.body;

  console.log('📢 Incoming publish request from Content Hub');
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