require('dotenv').config();
const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });

const app = express();
app.use(express.json());

// ===========================================================================
// In-memory state
// Credentials are set via POST /auth/login from the mobile app.
// Tokens are cached and auto-refreshed — no credentials stored in Railway.
// ===========================================================================

const ESL_BASE_URL = process.env.ESL_BASE_URL || 'https://eastus.common.solumesl.com/common';

let credentials = {
  username: null,
  password: null,
};

let tokenCache = {
  accessToken:  null,
  refreshToken: null,
  expiresAt:    null,
};

// ===========================================================================
// ESL Auth — Token Management
// ===========================================================================

async function loginAndGetToken() {
  if (!credentials.username || !credentials.password) {
    throw new Error('Not authenticated. Please log in from the mobile app first.');
  }

  console.log(`ESL Auth: Logging in as ${credentials.username}`);

  const resp = await fetch(`${ESL_BASE_URL}/api/v2/token`, {
    method: 'POST',
    headers: {
      'accept':        'application/json',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      username: credentials.username,
      password: credentials.password,
    }),
  });

  const data = await resp.json();
  if (data.responseCode !== '200') {
    throw new Error(`Login failed (${data.responseCode}): ${JSON.stringify(data.responseMessage ?? data)}`);
  }

  storeTokens(data.responseMessage);
  console.log('ESL Auth: Login successful');
  return tokenCache.accessToken;
}

async function doRefreshToken(companyCode) {
  console.log('ESL Auth: Refreshing access token');

  const resp = await fetch(`${ESL_BASE_URL}/api/v2/token/refresh?company=${companyCode}`, {
    method: 'POST',
    headers: {
      'accept':        'application/json',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ refreshToken: tokenCache.refreshToken }),
  });

  const data = await resp.json();
  if (data.responseCode !== '200') {
    throw new Error(`Refresh failed (${data.responseCode}): ${JSON.stringify(data.responseMessage ?? data)}`);
  }

  storeTokens(data.responseMessage);
  console.log('ESL Auth: Token refreshed');
  return tokenCache.accessToken;
}

function storeTokens(tokens) {
  const expiresInMs = (tokens.expires_in - 300) * 1000; // 5 min buffer
  tokenCache = {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:    new Date(Date.now() + expiresInMs),
  };
}

async function getAccessToken(companyCode) {
  // Use cached token if still valid
  if (tokenCache.accessToken && tokenCache.expiresAt > new Date()) {
    return tokenCache.accessToken;
  }

  // Try refresh token
  if (tokenCache.refreshToken) {
    try {
      return await doRefreshToken(companyCode);
    } catch (err) {
      console.warn('ESL Auth: Refresh failed, re-logging in:', err.message);
      tokenCache.refreshToken = null;
    }
  }

  // Full login with stored credentials
  return await loginAndGetToken();
}

// ===========================================================================
// ESL API — Label Actions
// ===========================================================================

async function flipPage(companyCode, labelCode, page) {
  const token = await getAccessToken(companyCode);
  console.log(`ESL: Flipping ${labelCode} → page ${page}`);

  const resp = await fetch(`${ESL_BASE_URL}/api/v1/labels/contents/page?company=${companyCode}`, {
    method: 'POST',
    headers: {
      'accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ labels: [{ labelCode, displayPage: page }] }),
  });

  const data = await resp.json();
  console.log(`ESL: Page flip → ${page}:`, JSON.stringify(data));
  return data;
}

async function blinkLed(companyCode, labelCode) {
  const token = await getAccessToken(companyCode);
  console.log(`ESL: Blinking LED on ${labelCode}`);

  const resp = await fetch(`${ESL_BASE_URL}/api/v1/labels/contents/led?company=${companyCode}`, {
    method: 'PUT',
    headers: {
      'accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify([{ labelCode, color: 'RED', duration: '30s', patternId: 0, multiLed: false }]),
  });

  const data = await resp.json();
  console.log(`ESL: LED blink:`, JSON.stringify(data));
  return data;
}

async function triggerEslActions(companyCode, labelCode) {
  try {
    await flipPage(companyCode, labelCode, 2);
    await blinkLed(companyCode, labelCode);

    console.log(`ESL: Waiting 60s before reverting ${labelCode}...`);
    await new Promise(resolve => setTimeout(resolve, 60_000));

    await flipPage(companyCode, labelCode, 1);
    console.log(`ESL: All actions done for ${labelCode}`);
  } catch (err) {
    console.error(`ESL: Actions failed for ${labelCode}:`, err.message);
  }
}

// ===========================================================================
// Middleware
// ===========================================================================

function validateAuth(req, res, next) {
  const headerName  = (process.env.AUTH_HEADER_NAME || 'x-auth-key').toLowerCase();
  const expectedKey = process.env.AUTH_KEY;

  if (!expectedKey) {
    console.warn('WARNING: AUTH_KEY not set. Accepting all requests.');
    return next();
  }

  if (req.headers[headerName] !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ===========================================================================
// Auth Routes — called from the mobile app
// ===========================================================================

// Login: store credentials, verify them by getting a token immediately
app.post('/auth/login', validateAuth, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  // Temporarily set credentials and attempt login
  const previous = { ...credentials };
  credentials = { username, password };

  try {
    // Clear any stale token so loginAndGetToken is forced
    tokenCache = { accessToken: null, refreshToken: null, expiresAt: null };
    await loginAndGetToken();
    console.log(`Auth: Logged in as ${username}`);
    res.json({ status: 'ok', message: `Logged in as ${username}` });
  } catch (err) {
    // Restore previous credentials on failure
    credentials = previous;
    console.error('Auth: Login failed:', err.message);
    res.status(401).json({ error: err.message });
  }
});

// Logout: wipe credentials and tokens
app.post('/auth/logout', validateAuth, (req, res) => {
  const who = credentials.username ?? 'unknown';
  credentials = { username: null, password: null };
  tokenCache  = { accessToken: null, refreshToken: null, expiresAt: null };
  console.log(`Auth: Logged out (was ${who})`);
  res.json({ status: 'ok', message: 'Logged out' });
});

// Status: mobile app polls this to know if it needs to show login screen
app.get('/auth/status', validateAuth, (req, res) => {
  const loggedIn = !!(credentials.username);
  res.json({
    loggedIn,
    username:  loggedIn ? credentials.username : null,
    tokenValid: !!(tokenCache.accessToken && tokenCache.expiresAt > new Date()),
  });
});

// ===========================================================================
// Webhook Routes
// ===========================================================================

async function handleWebhook(req, res) {
  try {
    const body = req.body ?? {};
    console.log('Webhook received:', JSON.stringify(body));

    const companyCode = body.customerCode ?? '';
    const eventInfo   = Array.isArray(body.eventInfo) ? body.eventInfo[0] : {};
    const labelCode   = eventInfo.labelCode  ?? '';
    const button      = eventInfo.button     ?? '';
    const articleIds  = Array.isArray(eventInfo.articleIds)
      ? eventInfo.articleIds.join(', ')
      : (eventInfo.articleIds ?? '');

    const parts        = [button, articleIds, labelCode ? `[${labelCode}]` : ''];
    const alertMessage = parts.filter(Boolean).join(' — ') || 'Employee call — button pressed';

    const fcmResult = await getMessaging().send({
      topic: process.env.FCM_TOPIC || 'employee-calls',
      data: {
        title:       'Employee Call',
        message:     alertMessage,
        companyCode,           // passed back to app so it can call /esl/acknowledge
        labelCode,
        payload:     JSON.stringify(body),
      },
      android: { priority: 'high', ttl: 60000 },
    });
    console.log('FCM sent:', fcmResult);

    // Respond immediately — ESL actions only fire when user taps "On My Way" in the app
    res.status(200).json({ status: 'ok', messageId: fcmResult });
  } catch (err) {
    console.error('Webhook error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

app.post('/',        validateAuth, handleWebhook);
app.post('/webhook', validateAuth, handleWebhook);

// "On My Way" — triggered by the mobile app when user acknowledges the call
app.post('/esl/acknowledge', validateAuth, async (req, res) => {
  const { companyCode, labelCode } = req.body ?? {};
  if (!companyCode || !labelCode) {
    return res.status(400).json({ error: 'companyCode and labelCode are required' });
  }
  console.log(`ESL: Acknowledge from app — ${companyCode} / ${labelCode}`);
  res.json({ status: 'ok' });
  triggerEslActions(companyCode, labelCode); // runs in background
});

app.get('/health', (_req, res) => {
  res.json({ status: 'running', timestamp: new Date().toISOString() });
});

// ===========================================================================
// Start
// ===========================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ESL Relay listening on port ${PORT}`));
