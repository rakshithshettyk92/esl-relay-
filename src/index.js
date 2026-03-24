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
// ESL API — Token Management
// Tokens are cached in memory. On expiry, we try refresh first, then login.
// ===========================================================================

const ESL_BASE_URL = process.env.ESL_BASE_URL || 'https://eastus.common.solumesl.com/common';

let tokenCache = {
  accessToken:  null,
  refreshToken: null,
  expiresAt:    null,   // Date — when the access token expires
  companyCode:  null,   // needed for the refresh endpoint URL
};

async function loginAndGetToken(companyCode) {
  console.log('ESL Auth: Logging in with username/password');
  const resp = await fetch(`${ESL_BASE_URL}/api/v2/token`, {
    method: 'POST',
    headers: {
      'accept':        'application/json',
      'Authorization': `Bearer ${process.env.ESL_API_BEARER}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      username: process.env.ESL_USERNAME,
      password: process.env.ESL_PASSWORD,
    }),
  });

  const data = await resp.json();
  if (data.responseCode !== '200') {
    throw new Error(`Login failed (${data.responseCode}): ${JSON.stringify(data)}`);
  }

  storeTokens(data.responseMessage, companyCode);
  console.log('ESL Auth: Login successful, token cached');
  return tokenCache.accessToken;
}

async function refreshToken(companyCode) {
  console.log('ESL Auth: Refreshing access token');
  const resp = await fetch(`${ESL_BASE_URL}/api/v2/token/refresh?company=${companyCode}`, {
    method: 'POST',
    headers: {
      'accept':        'application/json',
      'Authorization': `Bearer ${process.env.ESL_API_BEARER}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ refreshToken: tokenCache.refreshToken }),
  });

  const data = await resp.json();
  if (data.responseCode !== '200') {
    throw new Error(`Token refresh failed (${data.responseCode}): ${JSON.stringify(data)}`);
  }

  storeTokens(data.responseMessage, companyCode);
  console.log('ESL Auth: Token refreshed, new token cached');
  return tokenCache.accessToken;
}

function storeTokens(tokens, companyCode) {
  // Subtract 5 min buffer so we refresh before actual expiry
  const expiresInMs = (tokens.expires_in - 300) * 1000;
  tokenCache = {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:    new Date(Date.now() + expiresInMs),
    companyCode,
  };
}

async function getAccessToken(companyCode) {
  // Use cached token if still valid
  if (tokenCache.accessToken && tokenCache.expiresAt > new Date()) {
    return tokenCache.accessToken;
  }

  // Try refresh token first
  if (tokenCache.refreshToken) {
    try {
      return await refreshToken(companyCode);
    } catch (err) {
      console.warn('ESL Auth: Refresh failed, falling back to login:', err.message);
      tokenCache.refreshToken = null; // clear bad refresh token
    }
  }

  // Fallback: full login
  return await loginAndGetToken(companyCode);
}

// ===========================================================================
// ESL API — Label Actions
// ===========================================================================

async function flipPage(companyCode, labelCode, page) {
  const token = await getAccessToken(companyCode);
  console.log(`ESL: Flipping label ${labelCode} to page ${page}`);

  const resp = await fetch(`${ESL_BASE_URL}/api/v1/labels/contents/page?company=${companyCode}`, {
    method: 'POST',
    headers: {
      'accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      labels: [{ labelCode, displayPage: page }],
    }),
  });

  const data = await resp.json();
  console.log(`ESL: Page flip to ${page} result:`, JSON.stringify(data));
  return data;
}

async function blinkLed(companyCode, labelCode) {
  const token = await getAccessToken(companyCode);
  console.log(`ESL: Blinking LED on label ${labelCode}`);

  const resp = await fetch(`${ESL_BASE_URL}/api/v1/labels/contents/led?company=${companyCode}`, {
    method: 'PUT',
    headers: {
      'accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify([{
      labelCode,
      color:     'RED',
      duration:  '30s',
      patternId: 0,
      multiLed:  false,
    }]),
  });

  const data = await resp.json();
  console.log(`ESL: LED blink result:`, JSON.stringify(data));
  return data;
}

// Runs in background — flip to page 2, blink LED, wait 60s, flip back to page 1
async function triggerEslActions(companyCode, labelCode) {
  try {
    // Step 1: Flip page 1 → 2
    await flipPage(companyCode, labelCode, 2);

    // Step 2: Blink LED
    await blinkLed(companyCode, labelCode);

    // Step 3: Wait 60 seconds
    console.log(`ESL: Waiting 60s before flipping back label ${labelCode}...`);
    await new Promise(resolve => setTimeout(resolve, 60_000));

    // Step 4: Flip page 2 → 1
    await flipPage(companyCode, labelCode, 1);

    console.log(`ESL: All actions completed for ${labelCode}`);
  } catch (err) {
    console.error(`ESL: Actions failed for ${labelCode}:`, err.message);
  }
}

// ===========================================================================
// Auth middleware — validates the key AIMS sends in the header
// ===========================================================================

function validateAuth(req, res, next) {
  const headerName  = (process.env.AUTH_HEADER_NAME || 'x-auth-key').toLowerCase();
  const expectedKey = process.env.AUTH_KEY;

  if (!expectedKey) {
    console.warn('WARNING: AUTH_KEY not set. Accepting all requests.');
    return next();
  }

  const provided = req.headers[headerName];
  if (provided !== expectedKey) {
    console.warn(`Unauthorized request from ${req.ip} — bad or missing auth header`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// ===========================================================================
// Webhook handler
// ===========================================================================

async function handleWebhook(req, res) {
  try {
    const body = req.body ?? {};
    console.log('Webhook received:', JSON.stringify(body));

    // Extract from AIMS payload structure
    const companyCode = body.customerCode || '';
    const eventInfo   = Array.isArray(body.eventInfo) ? body.eventInfo[0] : {};
    const labelCode   = eventInfo.labelCode  || '';
    const button      = eventInfo.button     || '';
    const articleIds  = Array.isArray(eventInfo.articleIds)
      ? eventInfo.articleIds.join(', ')
      : (eventInfo.articleIds || '');

    // Build FCM alert message
    const parts        = [button, articleIds, labelCode ? `[${labelCode}]` : ''];
    const alertMessage = parts.filter(Boolean).join(' — ') || 'Employee call — button pressed';

    // Send FCM push to all subscribed phones
    const fcmMessage = {
      topic: process.env.FCM_TOPIC || 'employee-calls',
      data: {
        title:   'Employee Call',
        message: alertMessage,
        payload: JSON.stringify(body),
      },
      android: { priority: 'high', ttl: 60000 },
    };

    const fcmResult = await getMessaging().send(fcmMessage);
    console.log('FCM sent:', fcmResult);

    // Respond to AIMS immediately — ESL actions run in the background
    res.status(200).json({ status: 'ok', messageId: fcmResult });

    // Trigger ESL actions in background (don't await — response already sent)
    if (companyCode && labelCode) {
      triggerEslActions(companyCode, labelCode);
    } else {
      console.warn('ESL: Missing companyCode or labelCode — skipping label actions');
    }
  } catch (err) {
    console.error('Error processing webhook:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

// ===========================================================================
// Routes
// ===========================================================================

// Accept on both root and /webhook — works regardless of how AIMS is configured
app.post('/',        validateAuth, handleWebhook);
app.post('/webhook', validateAuth, handleWebhook);

app.get('/health', (_req, res) => {
  res.json({ status: 'running', timestamp: new Date().toISOString() });
});

// ===========================================================================
// Start
// ===========================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ESL Relay listening on port ${PORT}`);
});
