require('dotenv').config();
const fs   = require('fs');
const path = require('path');
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

// Tracks which labelCodes have already been acknowledged and by whom.
// Entries expire after ACKNOWLEDGE_TTL_MS so the label can be called again later.
const ACKNOWLEDGE_TTL_MS = 1 * 60 * 1000; // 1 minute (testing)
const acknowledgements = new Map(); // labelCode → { timestamp, by }

// ===========================================================================
// Per-store field mapping
// Mapping tells the relay which columns in the Solum article response to read
// for product name, aisle, and the "help-enabled" flag. Mappings are pushed by
// the mobile app's admin screen and persisted to disk so they survive restarts.
// ===========================================================================

const MAPPINGS_FILE = path.join(__dirname, '..', 'data', 'field-mappings.json');

const DEFAULT_MAPPING = {
  articleIdField:     'ARTICLE_ID',
  articleNameField:   'ITEM_NAME',
  helpEnabledField:   'ASSOCIATE_HELP_ENABLED',
  helpEnabledValue:   'Y',
  aisleField:         null,
  revertDelaySeconds: 60,
};

const fieldMappings = new Map(); // "company:store" → mapping

function mappingKey(companyCode, storeCode) {
  return `${companyCode}:${storeCode}`;
}

function getFieldMapping(companyCode, storeCode) {
  return fieldMappings.get(mappingKey(companyCode, storeCode)) || DEFAULT_MAPPING;
}

function loadMappings() {
  try {
    if (!fs.existsSync(MAPPINGS_FILE)) return;
    const raw = fs.readFileSync(MAPPINGS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [key, mapping] of Object.entries(obj)) {
      fieldMappings.set(key, mapping);
    }
    console.log(`Mappings: loaded ${fieldMappings.size} entries from ${MAPPINGS_FILE}`);
  } catch (err) {
    console.error('Mappings: failed to load:', err.message);
  }
}

function saveMappings() {
  try {
    fs.mkdirSync(path.dirname(MAPPINGS_FILE), { recursive: true });
    const obj = Object.fromEntries(fieldMappings);
    fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Mappings: failed to save:', err.message);
  }
}



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

// Fetches one article's data from Solum so the relay can apply the help-enabled
// filter and build a human-readable notification message. Returns null on any
// failure — callers fall back to the legacy "Customer help needed" path.
async function fetchArticle(companyCode, storeCode, articleId, mapping) {
  if (!articleId) return null;

  const dataFields = [
    mapping.articleIdField,
    mapping.articleNameField,
    mapping.helpEnabledField,
    'IMAGE_URL',
  ];
  if (mapping.aisleField) dataFields.push(mapping.aisleField);

  const filter = `{articleList[articleId,data[${dataFields.join(',')}]]}`;
  const query  = new URLSearchParams({
    company: companyCode,
    store:   storeCode,
    filter,
    page:    '0',
    size:    '1',
  });

  try {
    const token = await getAccessToken(companyCode);
    const resp  = await fetch(`${ESL_BASE_URL}/api/v2/common/config/article/info?${query}`, {
      method: 'GET',
      headers: {
        'accept':        'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    const json = await resp.json();
    const list = json.articleList || [];
    // Solum returns matches for any article — find the one we asked for.
    const found = list.find(a => a.articleId === articleId) || list[0];
    return found ? (found.data || {}) : null;
  } catch (err) {
    console.error(`Article fetch failed for ${articleId}:`, err.message);
    return null;
  }
}

// Sanitizes a string for use in an FCM topic name. FCM allows [A-Za-z0-9-_.~%]
// only, so we replace everything else with underscore.
function fcmSafeTopic(parts) {
  return parts.map(p => String(p).replace(/[^A-Za-z0-9_~.%-]/g, '_')).join('-');
}

async function triggerEslActions(companyCode, labelCode, revertDelayMs = 60_000) {
  try {
    await flipPage(companyCode, labelCode, 2);
    await blinkLed(companyCode, labelCode);

    const secs = Math.round(revertDelayMs / 1000);
    console.log(`ESL: Waiting ${secs}s before reverting ${labelCode}...`);
    await new Promise(resolve => setTimeout(resolve, revertDelayMs));

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
    const storeCode   = body.storeCode    ?? '';
    const eventInfo   = Array.isArray(body.eventInfo) ? body.eventInfo[0] : {};
    const labelCode   = eventInfo.labelCode  ?? '';
    const articleIds  = Array.isArray(eventInfo.articleIds) ? eventInfo.articleIds : [];
    const articleId   = articleIds[0] ?? '';

    if (!companyCode || !storeCode) {
      console.warn('Webhook missing customerCode/storeCode — cannot route, dropping.');
      return res.status(200).json({ status: 'dropped', reason: 'missing company/store' });
    }

    // Filter 0: Solum uses the sentinel articleId "imagepush" for image-push
    // events on a label. Drop without hitting Solum — saves an API call.
    if (articleId.toLowerCase() === 'imagepush') {
      console.log(`Webhook: ${articleId} sentinel — image-push event, skipping`);
      return res.status(200).json({ status: 'skipped', reason: 'image_push_sentinel' });
    }

    const mapping = getFieldMapping(companyCode, storeCode);
    const article = await fetchArticle(companyCode, storeCode, articleId, mapping);

    // Article must be reachable — we cannot confirm help-enabled without it,
    // and the rule is "no alert unless explicitly enabled".
    if (!article) {
      console.warn(`Webhook: ${articleId} article not available, skipping (cannot verify help-enabled)`);
      return res.status(200).json({ status: 'skipped', reason: 'article_unavailable' });
    }

    // Filter 1: image-push articles are display labels, never customer calls.
    if ((article.IMAGE_URL ?? '').toString().trim() !== '') {
      console.log(`Webhook: ${articleId} is image-push, skipping`);
      return res.status(200).json({ status: 'skipped', reason: 'image_push' });
    }

    // Filter 2: help-enabled flag must be present AND match the configured value.
    // Missing field or mismatched value both count as "help not enabled" → drop.
    const flag = (article[mapping.helpEnabledField] ?? '').toString().trim();
    if (flag === '' || flag.toUpperCase() !== mapping.helpEnabledValue.toUpperCase()) {
      const reason = flag === '' ? 'help_field_missing' : 'help_disabled';
      console.log(`Webhook: ${articleId} ${reason} (${mapping.helpEnabledField}=${JSON.stringify(flag)}), skipping`);
      return res.status(200).json({ status: 'skipped', reason });
    }

    // Build the message from the article record.
    const name  = (article[mapping.articleNameField] || articleId || labelCode).toString();
    const aisle = mapping.aisleField
      ? (article[mapping.aisleField] ?? '').toString().trim()
      : '';
    const alertMessage = aisle ? `Help needed for ${name} - ${aisle}` : `Help needed for ${name}`;

    // New button press — clear any stale acknowledgement so it can be acknowledged fresh
    if (labelCode) acknowledgements.delete(labelCode);

    const topic = fcmSafeTopic(['employee-calls', companyCode, storeCode]);

    const fcmResult = await getMessaging().send({
      topic,
      data: {
        title:       'Employee Call',
        message:     alertMessage,
        companyCode,           // passed back to app so it can call /esl/acknowledge
        storeCode,
        labelCode,
        payload:     JSON.stringify(body),
      },
      android: { priority: 'high', ttl: 60000 },
    });
    console.log(`FCM sent (topic=${topic}):`, fcmResult);

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
  const { companyCode, storeCode, labelCode } = req.body ?? {};
  if (!companyCode || !storeCode || !labelCode) {
    return res.status(400).json({ error: 'companyCode, storeCode and labelCode are required' });
  }

  // Check if already acknowledged within the TTL window
  const existing = acknowledgements.get(labelCode);
  if (existing && (Date.now() - existing.timestamp) < ACKNOWLEDGE_TTL_MS) {
    console.log(`ESL: ${labelCode} already acknowledged — ignoring duplicate`);
    return res.status(409).json({
      status: 'already_acknowledged',
      message: 'Already acknowledged by another device',
    });
  }

  // Mark as acknowledged
  acknowledgements.set(labelCode, { timestamp: Date.now() });
  console.log(`ESL: Acknowledge from app — ${companyCode} / ${storeCode} / ${labelCode}`);

  // Push a cancel message to dismiss the popup on all other devices in this store
  const topic = fcmSafeTopic(['employee-calls', companyCode, storeCode]);
  getMessaging().send({
    topic,
    data: {
      type:      'cancel',
      labelCode,
    },
    android: { priority: 'high', ttl: 30000 },
  }).catch(err => console.error('FCM cancel send failed:', err.message));

  res.json({ status: 'ok' });
  // Pull the per-store revert delay so the page stays flipped long enough
  // for the responding staffer to spot it on the shelf. Clamped 5s–600s.
  const mapping  = getFieldMapping(companyCode, storeCode);
  const rawDelay = Number(mapping.revertDelaySeconds) || 60;
  const delaySec = Math.max(5, Math.min(600, rawDelay));
  triggerEslActions(companyCode, labelCode, delaySec * 1000); // runs in background
});

// ===========================================================================
// Admin Routes — used by the mobile app's setup screens
// ===========================================================================

// List stores for a company. Proxies Solum so the app doesn't need its own token.
app.get('/admin/stores', validateAuth, async (req, res) => {
  const company = (req.query.company ?? '').toString().trim();
  if (!company) return res.status(400).json({ error: 'company is required' });

  try {
    const token = await getAccessToken(company);
    const resp  = await fetch(`${ESL_BASE_URL}/api/v2/common/store?company=${encodeURIComponent(company)}`, {
      method: 'GET',
      headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
    const json = await resp.json();
    res.status(resp.status).json(json);
  } catch (err) {
    console.error('Admin: stores fetch failed:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Fetch the article column schema so the admin screen can populate dropdowns.
app.get('/admin/articles/upload/format', validateAuth, async (req, res) => {
  const company = (req.query.company ?? '').toString().trim();
  if (!company) return res.status(400).json({ error: 'company is required' });

  try {
    const token = await getAccessToken(company);
    const resp  = await fetch(`${ESL_BASE_URL}/api/v2/common/articles/upload/format?company=${encodeURIComponent(company)}`, {
      method: 'GET',
      headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
    const json = await resp.json();
    res.status(resp.status).json(json);
  } catch (err) {
    console.error('Admin: format fetch failed:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Read the saved field mapping for one company/store. Returns DEFAULT_MAPPING
// when nothing is saved yet, so the admin screen always has something to show.
app.get('/admin/field-mapping', validateAuth, (req, res) => {
  const company = (req.query.company ?? '').toString().trim();
  const store   = (req.query.store   ?? '').toString().trim();
  if (!company || !store) {
    return res.status(400).json({ error: 'company and store are required' });
  }
  const mapping = fieldMappings.get(mappingKey(company, store)) || DEFAULT_MAPPING;
  const saved   = fieldMappings.has(mappingKey(company, store));
  res.json({ mapping, saved });
});

app.post('/admin/field-mapping', validateAuth, (req, res) => {
  const { company, store, mapping } = req.body ?? {};
  if (!company || !store || !mapping) {
    return res.status(400).json({ error: 'company, store and mapping are required' });
  }
  const required = ['articleIdField', 'articleNameField', 'helpEnabledField', 'helpEnabledValue'];
  for (const field of required) {
    if (!mapping[field] || typeof mapping[field] !== 'string') {
      return res.status(400).json({ error: `mapping.${field} is required` });
    }
  }
  const rawDelay = Number(mapping.revertDelaySeconds);
  const clean = {
    articleIdField:     mapping.articleIdField.trim(),
    articleNameField:   mapping.articleNameField.trim(),
    helpEnabledField:   mapping.helpEnabledField.trim(),
    helpEnabledValue:   mapping.helpEnabledValue.trim(),
    aisleField:         (mapping.aisleField || '').toString().trim() || null,
    revertDelaySeconds: Math.max(5, Math.min(600, Number.isFinite(rawDelay) ? rawDelay : 60)),
  };
  fieldMappings.set(mappingKey(company, store), clean);
  saveMappings();
  console.log(`Admin: saved mapping for ${company}/${store}`);
  res.json({ status: 'ok', mapping: clean });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'running', timestamp: new Date().toISOString() });
});

// ===========================================================================
// Start
// ===========================================================================
const PORT = process.env.PORT || 3000;
loadMappings();
app.listen(PORT, () => console.log(`ESL Relay listening on port ${PORT}`));
