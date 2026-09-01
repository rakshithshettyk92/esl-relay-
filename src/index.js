require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { boundedInt, fcmSafeTopic, usableTokenLifetimeMs } = require('./runtime-utils');

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

function envInt(name, fallback, min, max) {
  return boundedInt(process.env[name], fallback, min, max);
}

// ===========================================================================
// In-memory state
// Credentials come from Railway variables when configured, or can be set via
// POST /auth/login from the mobile app.
// Tokens are cached and auto-refreshed; the password is never written to disk.
// ===========================================================================

const ESL_BASE_URL = process.env.ESL_BASE_URL || 'https://eastus.common.solumesl.com/common';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ESL_REQUEST_TIMEOUT_MS = envInt('ESL_REQUEST_TIMEOUT_MS', 20_000, 1_000, 120_000);
const TOKEN_REFRESH_BUFFER_SECONDS = envInt('TOKEN_REFRESH_BUFFER_SECONDS', 300, 0, 3_600);
const ARTICLE_LOOKUP_TIMEOUT_MS = envInt('ARTICLE_LOOKUP_TIMEOUT_MS', 30_000, 5_000, 120_000);
const ARTICLE_CACHE_TTL_MS = envInt('ARTICLE_CACHE_TTL_SECONDS', 300, 0, 3_600) * 1000;
const ENV_ESL_USERNAME = process.env.ESL_USERNAME?.trim() || null;
const ENV_ESL_PASSWORD = process.env.ESL_PASSWORD || null;

let credentials = {
  username: ENV_ESL_USERNAME,
  password: ENV_ESL_PASSWORD,
};

let tokenCache = {
  accessToken:  null,
  refreshToken: null,
  expiresAt:    null,
};

let authHealth = {
  lastSuccessAt: null,
  lastError: null,
};
let tokenPromise = null;
const articleCache = new Map();

// Tracks which labelCodes have already been acknowledged and by whom.
// Entries expire after ACKNOWLEDGE_TTL_MS so the label can be called again later.
const ACKNOWLEDGE_TTL_MS = envInt('ACKNOWLEDGE_TTL_SECONDS', 60, 5, 3_600) * 1000;
const ACKNOWLEDGEMENTS_FILE = path.join(DATA_DIR, 'acknowledgements.json');

function acknowledgementKey(companyCode, storeCode, labelCode) {
  return `${companyCode}:${storeCode}:${labelCode}`;
}

function saveAcknowledgements() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const now = Date.now();
  for (const [key, value] of acknowledgements) {
    if (!value?.timestamp || now - value.timestamp >= ACKNOWLEDGE_TTL_MS) acknowledgements.delete(key);
  }
  fs.writeFileSync(ACKNOWLEDGEMENTS_FILE, JSON.stringify(Object.fromEntries(acknowledgements), null, 2));
}

function loadAcknowledgements() {
  try {
    if (!fs.existsSync(ACKNOWLEDGEMENTS_FILE)) return;
    const stored = JSON.parse(fs.readFileSync(ACKNOWLEDGEMENTS_FILE, 'utf8'));
    for (const [key, value] of Object.entries(stored)) acknowledgements.set(key, value);
    saveAcknowledgements();
  } catch (err) {
    console.error('Acknowledgements: failed to load:', err.message);
  }
}
const acknowledgements = new Map(); // labelCode → { timestamp, by }

// ===========================================================================
// Per-store field mapping
// Mapping tells the relay which columns in the Solum article response to read
// for product name, aisle, and the "help-enabled" flag. Mappings are pushed by
// the mobile app's admin screen and persisted to disk so they survive restarts.
// ===========================================================================

const MAPPINGS_FILE = path.join(DATA_DIR, 'field-mappings.json');

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
// Token persistence — survives Railway redeploys so we don't lose the Solum
// session every time we push code. Password is NEVER persisted; only the
// refresh token + username + access token. If the refresh token also expires
// while the container is down, the app will still need to re-login.
// ===========================================================================

const TOKENS_FILE = path.join(DATA_DIR, 'relay-tokens.json');

function persistSession() {
  try {
    fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
    const data = {
      username: credentials.username,
      tokenCache: {
        accessToken:  tokenCache.accessToken,
        refreshToken: tokenCache.refreshToken,
        expiresAt:    tokenCache.expiresAt ? tokenCache.expiresAt.toISOString() : null,
      },
    };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Tokens: failed to persist:', err.message);
  }
}

function loadPersistedSession() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    if (ENV_ESL_USERNAME && data.username && data.username !== ENV_ESL_USERNAME) {
      console.warn('Tokens: persisted username does not match ESL_USERNAME; ignoring stale tokens');
      return;
    }
    if (!credentials.username && data.username) credentials.username = data.username;
    if (data.tokenCache) {
      tokenCache = {
        accessToken:  data.tokenCache.accessToken  ?? null,
        refreshToken: data.tokenCache.refreshToken ?? null,
        expiresAt:    data.tokenCache.expiresAt ? new Date(data.tokenCache.expiresAt) : null,
      };
    }
    console.log(
      `Tokens: restored session for ${credentials.username ?? 'unknown'} ` +
      `(tokenValid=${!!(tokenCache.accessToken && tokenCache.expiresAt > new Date())})`
    );
  } catch (err) {
    console.error('Tokens: failed to load:', err.message);
  }
}

function clearPersistedSession() {
  try {
    if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE);
  } catch (err) {
    console.error('Tokens: failed to clear:', err.message);
  }
}

// ===========================================================================
// Call log — append-only JSONL of every accepted call + its status updates.
// Powers /admin/analytics. Survives restarts only when a Railway Volume is
// mounted at /app/data; otherwise the file resets on each redeploy.
// ===========================================================================

const CALL_LOG_FILE = path.join(DATA_DIR, 'call-log.jsonl');
const JOBS_FILE = path.join(DATA_DIR, 'relay-jobs.json');
const jobs = new Map();
let jobTimer = null;
// Drop events older than this on read so the file doesn't grow without bound.
// 30d is the longest range the analytics UI exposes; keep a buffer.
const CALL_LOG_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

function appendCallEvent(event) {
  try {
    fs.mkdirSync(path.dirname(CALL_LOG_FILE), { recursive: true });
    fs.appendFileSync(CALL_LOG_FILE, JSON.stringify(event) + '\n');
  } catch (err) {
    console.error('CallLog: append failed:', err.message);
  }
}

function readCallEvents(sinceTs = 0) {
  try {
    if (!fs.existsSync(CALL_LOG_FILE)) return [];
    const raw = fs.readFileSync(CALL_LOG_FILE, 'utf8');
    const cutoff = Math.max(sinceTs, Date.now() - CALL_LOG_RETENTION_MS);
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.ts === 'number' && e.ts >= cutoff) out.push(e);
      } catch (_) { /* skip malformed */ }
    }
    return out;
  } catch (err) {
    console.error('CallLog: read failed:', err.message);
    return [];
  }
}

function saveJobs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${JOBS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify([...jobs.values()], null, 2));
  fs.renameSync(tempFile, JOBS_FILE);
}

function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const stored = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const job of Array.isArray(stored) ? stored : []) {
      if (job?.id && job?.type && Number.isFinite(job.runAt)) jobs.set(job.id, job);
    }
    console.log(`Jobs: restored ${jobs.size} pending job(s)`);
  } catch (err) {
    console.error('Jobs: failed to load:', err.message);
  }
}

function enqueueJob(type, payload, runAt = Date.now()) {
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    payload,
    runAt,
    attempts: 0,
  };
  jobs.set(job.id, job);
  saveJobs();
  scheduleJobRunner();
  return job;
}

function scheduleJobRunner() {
  if (jobTimer) clearTimeout(jobTimer);
  if (jobs.size === 0) return;
  const nextRunAt = Math.min(...[...jobs.values()].map(job => job.runAt));
  jobTimer = setTimeout(runDueJobs, Math.max(0, Math.min(60_000, nextRunAt - Date.now())));
}

async function runDueJobs() {
  jobTimer = null;
  const due = [...jobs.values()]
    .filter(job => job.runAt <= Date.now())
    .sort((a, b) => a.runAt - b.runAt);
  for (const job of due) {
    try {
      if (job.type === 'webhook') await processWebhookBody(job.payload);
      else if (job.type === 'revert') {
        await flipPage(job.payload.companyCode, job.payload.labelCode, 1);
      } else if (job.type === 'cancel') {
        await getMessaging().send({
          topic: fcmSafeTopic(['employee-calls', job.payload.companyCode, job.payload.storeCode]),
          data: { type: 'cancel', labelCode: job.payload.labelCode },
          android: { priority: 'high', ttl: 30000 },
        });
      } else if (job.type === 'esl-actions') {
        await triggerEslActions(job.payload.companyCode, job.payload.labelCode,
          job.payload.revertDelayMs);
      }
      jobs.delete(job.id);
    } catch (err) {
      job.attempts = (job.attempts || 0) + 1;
      const backoffMs = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(job.attempts, 6)));
      job.runAt = Date.now() + backoffMs;
      console.error(`Jobs: ${job.type} ${job.id} failed; retrying in ${backoffMs}ms:`, err.message);
    }
    saveJobs();
  }
  scheduleJobRunner();
}

// ===========================================================================
// ESL Auth — Token Management
// ===========================================================================

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ESL_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Solum request timed out after ${ESL_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function loginAndGetToken() {
  if (!credentials.username || !credentials.password) {
    throw new Error('Not authenticated. Please log in from the mobile app first.');
  }

  console.log(`ESL Auth: Logging in as ${credentials.username}`);

  const resp = await fetchWithTimeout(`${ESL_BASE_URL}/api/v2/token`, {
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

  const resp = await fetchWithTimeout(`${ESL_BASE_URL}/api/v2/token/refresh?company=${companyCode}`, {
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
  const expiresInMs = usableTokenLifetimeMs(tokens.expires_in, TOKEN_REFRESH_BUFFER_SECONDS);
  tokenCache = {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:    new Date(Date.now() + expiresInMs),
  };
  authHealth = { lastSuccessAt: new Date().toISOString(), lastError: null };
  persistSession();
}

async function getAccessToken(companyCode) {
  // Use cached token if still valid
  if (tokenCache.accessToken && tokenCache.expiresAt > new Date()) {
    return tokenCache.accessToken;
  }
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {

  // Try refresh token
  if (tokenCache.refreshToken) {
    try {
      return await doRefreshToken(companyCode);
    } catch (err) {
      console.warn('ESL Auth: Refresh failed, re-logging in:', err.message);
      tokenCache.refreshToken = null;
    }
  }

  // Full login with stored credentials. Password is only in memory (never
  // persisted), so after a restart with an expired refresh token we end up
  // here with no password — surface that as a clean signed-out state so the
  // app's /auth/status check and banner can prompt a re-login.
  if (!credentials.password) {
    credentials.username = null;
    clearPersistedSession();
    throw new Error('Not authenticated. Please log in from the mobile app first.');
  }
    return loginAndGetToken();
  })();
  try {
    return await tokenPromise;
  } catch (err) {
    authHealth.lastError = err.message;
    throw err;
  } finally {
    tokenPromise = null;
  }
}

// ===========================================================================
// ESL API — Label Actions
// ===========================================================================

async function flipPage(companyCode, labelCode, page) {
  const token = await getAccessToken(companyCode);
  console.log(`ESL: Flipping ${labelCode} → page ${page}`);

  const resp = await fetchWithTimeout(`${ESL_BASE_URL}/api/v1/labels/contents/page?company=${companyCode}`, {
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

  const resp = await fetchWithTimeout(`${ESL_BASE_URL}/api/v1/labels/contents/led?company=${companyCode}`, {
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
// filter and build a human-readable notification message. Returns null when
// the specific articleId can't be located (caller treats that as a skip).
//
// Solum's /article/info endpoint doesn't support querying by articleId in the
// filter syntax — it returns paginated results sorted by articleId — so we
// page through until we find the one we want. Capped to avoid runaway scans.
async function fetchArticle(companyCode, storeCode, articleId, mapping) {
  if (!articleId) return null;
  const cacheKey = `${companyCode}:${storeCode}:${articleId}`;
  const cached = articleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.article;
  const deadline = Date.now() + ARTICLE_LOOKUP_TIMEOUT_MS;

  const dataFields = [
    mapping.articleIdField,
    mapping.articleNameField,
    mapping.helpEnabledField,
    'IMAGE_URL',
  ];
  if (mapping.aisleField) dataFields.push(mapping.aisleField);

  const filter   = `{articleList[articleId,data[${dataFields.join(',')}]]}`;
  const pageSize = 200;
  const maxPages = 25;   // hard cap: 5,000 articles per store

  try {
    const token = await getAccessToken(companyCode);

    for (let page = 0; page < maxPages; page++) {
      if (Date.now() >= deadline) {
        throw new Error(`Article lookup exceeded ${ARTICLE_LOOKUP_TIMEOUT_MS}ms`);
      }
      const query = new URLSearchParams({
        company: companyCode,
        store:   storeCode,
        sort:    'articleId,asc',
        filter,
        page:    String(page),
        size:    String(pageSize),
      });

      const resp = await fetchWithTimeout(`${ESL_BASE_URL}/api/v2/common/config/article/info?${query}`, {
        method: 'GET',
        headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
      });

      const json = await resp.json();
      const list = json.articleList || [];
      if (list.length === 0) break;

      // EXACT match only — never fall back to a sibling article.
      const found = list.find(a => a.articleId === articleId);
      if (found) {
        const article = found.data || {};
        if (ARTICLE_CACHE_TTL_MS > 0) {
          articleCache.set(cacheKey, { article, expiresAt: Date.now() + ARTICLE_CACHE_TTL_MS });
        }
        return article;
      }

      // Last page reached without a match.
      if (list.length < pageSize) break;
    }

    console.warn(`Article ${articleId} not found in ${companyCode}/${storeCode}`);
    return null;
  } catch (err) {
    console.error(`Article fetch failed for ${articleId}:`, err.message);
    throw err;
  }
}

// Sanitizes a string for use in an FCM topic name. FCM allows [A-Za-z0-9-_.~%]
// only, so we replace everything else with underscore.
async function triggerEslActions(companyCode, labelCode, revertDelayMs = 60_000) {
  let pageFlipped = false;
  try {
    await flipPage(companyCode, labelCode, 2);
    pageFlipped = true;
    try {
      await blinkLed(companyCode, labelCode);
    } catch (err) {
      console.error(`ESL: LED action failed for ${labelCode}:`, err.message);
    }
  } catch (err) {
    console.error(`ESL: Actions failed for ${labelCode}:`, err.message);
    throw err;
  } finally {
    if (pageFlipped) {
      enqueueJob('revert', { companyCode, labelCode }, Date.now() + revertDelayMs);
      console.log(`ESL: Durable revert scheduled for ${labelCode}`);
    }
  }
}

// ===========================================================================
// Middleware
// ===========================================================================

function validateAuth(req, res, next) {
  const headerName  = (process.env.AUTH_HEADER_NAME || 'x-auth-key').toLowerCase();
  const expectedKey = process.env.AUTH_KEY;

  if (!expectedKey) {
    console.error('AUTH_KEY is not configured; refusing protected request');
    return res.status(503).json({ error: 'Relay authentication is not configured' });
  }

  if (req.headers[headerName] !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const loginAttempts = new Map();
function limitLoginAttempts(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  req.loginAttemptKey = key;
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return next();
  }
  if (current.count >= 5) {
    res.set('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many login attempts; try again later' });
  }
  current.count += 1;
  next();
}

// ===========================================================================
// Auth Routes — called from the mobile app
// ===========================================================================

// Login: store credentials, verify them by getting a token immediately
app.post('/auth/login', validateAuth, limitLoginAttempts, async (req, res) => {
  if (ENV_ESL_USERNAME && ENV_ESL_PASSWORD) {
    return res.status(409).json({
      error: 'Relay login is managed by server configuration; update ESL_USERNAME/ESL_PASSWORD',
    });
  }
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  // Temporarily set credentials and attempt login
  const previous = { ...credentials };
  const previousTokens = { ...tokenCache };
  credentials = { username, password };

  try {
    // Clear any stale token so loginAndGetToken is forced
    tokenCache = { accessToken: null, refreshToken: null, expiresAt: null };
    await loginAndGetToken();
    loginAttempts.delete(req.loginAttemptKey);
    console.log(`Auth: Logged in as ${username}`);
    res.json({ status: 'ok', message: `Logged in as ${username}` });
  } catch (err) {
    // A typo during re-authentication must not destroy a still-usable session.
    credentials = previous;
    tokenCache = previousTokens;
    console.error('Auth: Login failed:', err.message);
    res.status(401).json({ error: err.message });
  }
});

// Logout: wipe credentials and tokens
app.post('/auth/logout', validateAuth, (req, res) => {
  const who = credentials.username ?? 'unknown';
  credentials = { username: ENV_ESL_USERNAME, password: ENV_ESL_PASSWORD };
  tokenCache  = { accessToken: null, refreshToken: null, expiresAt: null };
  clearPersistedSession();
  console.log(`Auth: Session reset (was ${who}, managed=${!!ENV_ESL_USERNAME})`);
  res.json({
    status: 'ok',
    message: ENV_ESL_USERNAME ? 'Session reset; managed login remains available' : 'Logged out',
  });
});

// Status: mobile app polls this to know if it needs to show login screen
app.get('/auth/status', validateAuth, (req, res) => {
  const tokenValid = !!(tokenCache.accessToken && tokenCache.expiresAt > new Date());
  const managedRecoveryReady = !!(ENV_ESL_USERNAME && ENV_ESL_PASSWORD && !authHealth.lastError);
  const loggedIn = tokenValid || managedRecoveryReady || !!tokenCache.refreshToken;
  res.json({
    loggedIn,
    username:  loggedIn ? credentials.username : null,
    tokenValid,
    operational: tokenValid || managedRecoveryReady,
    managedLogin: !!(ENV_ESL_USERNAME && ENV_ESL_PASSWORD),
    lastAuthSuccessAt: authHealth.lastSuccessAt,
    lastAuthError: authHealth.lastError,
  });
});

// ===========================================================================
// Webhook Routes
// ===========================================================================

async function processWebhookBody(rawBody) {
  try {
    const body = rawBody ?? {};
    console.log('Webhook received:', JSON.stringify({
      type: body.type,
      customerCode: body.customerCode,
      storeCode: body.storeCode,
      eventCount: Array.isArray(body.eventInfo) ? body.eventInfo.length : 0,
    }));

    // Solum emits many webhook types — pageStatus, ledStatus, etc. — that are
    // status echoes of API calls the relay itself made (flipPage, blinkLed).
    // Only "buttonPress" represents an actual customer action; everything
    // else is noise that previously fired duplicate alerts.
    if (body.type && body.type !== 'buttonPress') {
      console.log(`Webhook: type=${body.type} — not a button press, skipping`);
      return;
    }

    const companyCode = body.customerCode ?? '';
    const storeCode   = body.storeCode    ?? '';
    const eventInfo   = Array.isArray(body.eventInfo) ? body.eventInfo[0] : {};
    const labelCode   = eventInfo.labelCode  ?? '';
    const articleIds  = Array.isArray(eventInfo.articleIds) ? eventInfo.articleIds : [];
    const articleId   = articleIds[0] ?? '';

    if (!companyCode || !storeCode) {
      console.warn('Webhook missing customerCode/storeCode — cannot route, dropping.');
      return;
    }

    // Filter 0: Solum uses the sentinel articleId "imagepush" for image-push
    // events on a label. Drop without hitting Solum — saves an API call.
    if (articleId.toLowerCase() === 'imagepush') {
      console.log(`Webhook: ${articleId} sentinel — image-push event, skipping`);
      return;
    }

    const mapping = getFieldMapping(companyCode, storeCode);
    const article = await fetchArticle(companyCode, storeCode, articleId, mapping);

    // Article must be reachable — we cannot confirm help-enabled without it,
    // and the rule is "no alert unless explicitly enabled".
    if (!article) {
      console.warn(`Webhook: ${articleId} article not available, skipping (cannot verify help-enabled)`);
      return;
    }

    // Filter 1: image-push articles are display labels, never customer calls.
    if ((article.IMAGE_URL ?? '').toString().trim() !== '') {
      console.log(`Webhook: ${articleId} is image-push, skipping`);
      return;
    }

    // Filter 2: help-enabled flag must be present AND match the configured value.
    // Missing field or mismatched value both count as "help not enabled" → drop.
    const flag = (article[mapping.helpEnabledField] ?? '').toString().trim();
    if (flag === '' || flag.toUpperCase() !== mapping.helpEnabledValue.toUpperCase()) {
      const reason = flag === '' ? 'help_field_missing' : 'help_disabled';
      console.log(
        `Webhook: ${articleId} ${reason} ` +
        `article["${mapping.helpEnabledField}"]=${JSON.stringify(flag)} ` +
        `configured=${JSON.stringify(mapping.helpEnabledValue)}, skipping`
      );
      return;
    }

    // Build the message from the article record.
    const name  = (article[mapping.articleNameField] || articleId || labelCode).toString();
    const aisle = mapping.aisleField
      ? (article[mapping.aisleField] ?? '').toString().trim()
      : '';
    const alertMessage = aisle
      ? `Help needed for ${name} - AISLE ${aisle}`
      : `Help needed for ${name}`;

    // New button press — clear any stale acknowledgement so it can be acknowledged fresh
    if (labelCode) {
      acknowledgements.delete(acknowledgementKey(companyCode, storeCode, labelCode));
      saveAcknowledgements();
    }

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

    appendCallEvent({
      type:         'delivered',
      ts:           Date.now(),
      company:      companyCode,
      store:        storeCode,
      labelCode,
      articleId,
      articleName:  name,
      aisle:        aisle || null,
    });
  } catch (err) {
    console.error('Webhook processing failed:', err.message);
    throw err;
  }
}

function handleWebhook(req, res) {
  const job = enqueueJob('webhook', req.body ?? {});
  res.status(202).json({ status: 'accepted', jobId: job.id });
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
  const ackKey = acknowledgementKey(companyCode, storeCode, labelCode);
  const existing = acknowledgements.get(ackKey);
  if (existing && (Date.now() - existing.timestamp) < ACKNOWLEDGE_TTL_MS) {
    console.log(`ESL: ${labelCode} already acknowledged — ignoring duplicate`);
    return res.status(409).json({
      status: 'already_acknowledged',
      message: 'Already acknowledged by another device',
    });
  }

  // Mark as acknowledged
  acknowledgements.set(ackKey, { timestamp: Date.now() });
  saveAcknowledgements();
  console.log(`ESL: Acknowledge from app — ${companyCode} / ${storeCode} / ${labelCode}`);

  appendCallEvent({
    type:      'acknowledged',
    ts:        Date.now(),
    company:   companyCode,
    store:     storeCode,
    labelCode,
  });

  // Pull the per-store revert delay so the page stays flipped long enough
  // for the responding staffer to spot it on the shelf. Clamped 5s–600s.
  const mapping  = getFieldMapping(companyCode, storeCode);
  const rawDelay = Number(mapping.revertDelaySeconds) || 60;
  const delaySec = Math.max(5, Math.min(600, rawDelay));
  enqueueJob('cancel', { companyCode, storeCode, labelCode });
  enqueueJob('esl-actions', {
    companyCode, labelCode, revertDelayMs: delaySec * 1000,
  });
  res.json({ status: 'ok' });
});

// Reports a terminal status for an alert that the relay never observed —
// missed (timed out on the device) or dismissed (manually closed). Fire-and-
// forget from the app; failures are logged but never block the user.
app.post('/esl/status', validateAuth, (req, res) => {
  const { companyCode, storeCode, labelCode, status } = req.body ?? {};
  const allowed = new Set(['missed', 'dismissed']);
  if (!companyCode || !storeCode || !labelCode || !allowed.has(status)) {
    return res.status(400).json({
      error: 'companyCode, storeCode, labelCode and status (missed|dismissed) are required',
    });
  }
  appendCallEvent({
    type:      status,           // 'missed' or 'dismissed'
    ts:        Date.now(),
    company:   companyCode,
    store:     storeCode,
    labelCode,
  });
  res.json({ status: 'ok' });
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
    const resp  = await fetchWithTimeout(`${ESL_BASE_URL}/api/v2/common/store?company=${encodeURIComponent(company)}`, {
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
    const resp  = await fetchWithTimeout(`${ESL_BASE_URL}/api/v2/common/articles/upload/format?company=${encodeURIComponent(company)}`, {
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

// Aggregates the per-store call log into the shape the Android Analytics
// screen renders. Status updates are matched back to the most recent prior
// delivered event for the same (company, store, labelCode) — that's how a
// "missed"/"acknowledged" event picks up the article name + aisle.
app.get('/admin/analytics', validateAuth, (req, res) => {
  const company = (req.query.company ?? '').toString().trim();
  const store   = (req.query.store   ?? '').toString().trim();
  const range   = (req.query.range   ?? '7d').toString();
  if (!company || !store) {
    return res.status(400).json({ error: 'company and store are required' });
  }

  const sinceTs = rangeStartMs(range);
  const events = readCallEvents(sinceTs).filter(
    e => e.company === company && e.store === store
  );

  // Walk events in order to stitch status updates back onto their delivered call.
  events.sort((a, b) => a.ts - b.ts);
  const calls = [];                          // each: {deliveredAt, articleName, aisle, status, ackedAt}
  const open  = new Map();                   // labelCode -> index in calls (latest open call)

  for (const e of events) {
    if (e.type === 'delivered') {
      const call = {
        deliveredAt: e.ts,
        labelCode:   e.labelCode,
        articleId:   e.articleId,
        articleName: e.articleName || e.articleId || e.labelCode,
        aisle:       e.aisle || null,
        status:      'delivered',
        ackedAt:     null,
      };
      calls.push(call);
      open.set(e.labelCode, calls.length - 1);
    } else {
      const idx = open.get(e.labelCode);
      if (idx === undefined) continue;  // status update with no prior delivered — ignore
      const call = calls[idx];
      call.status = e.type;             // 'acknowledged' | 'missed' | 'dismissed'
      if (e.type === 'acknowledged') call.ackedAt = e.ts;
      open.delete(e.labelCode);         // closed
    }
  }

  // Totals
  const totals = { delivered: 0, acknowledged: 0, missed: 0, dismissed: 0 };
  for (const c of calls) {
    totals.delivered += 1;
    if (c.status !== 'delivered') totals[c.status] = (totals[c.status] || 0) + 1;
  }

  // Response time stats over acknowledged calls
  const responseMs = calls
    .filter(c => c.status === 'acknowledged' && c.ackedAt)
    .map(c => c.ackedAt - c.deliveredAt)
    .sort((a, b) => a - b);
  const avgMs = responseMs.length
    ? Math.round(responseMs.reduce((a, b) => a + b, 0) / responseMs.length)
    : 0;
  const p50Ms = responseMs.length ? responseMs[Math.floor(responseMs.length * 0.50)] : 0;
  const p95Ms = responseMs.length ? responseMs[Math.floor(responseMs.length * 0.95)] : 0;

  res.json({
    company,
    store,
    range,
    sinceTs,
    totals,
    responseMs:  { avg: avgMs, p50: p50Ms, p95: p95Ms, samples: responseMs.length },
    topAisles:   topByKey(calls, c => c.aisle, 10),
    topArticles: topByKey(calls, c => c.articleName, 10),
    perHour:     perHour(calls),
  });
});

function rangeStartMs(range) {
  const now = Date.now();
  if (range === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === '30d') return now - 30 * 24 * 60 * 60 * 1000;
  return now - 7 * 24 * 60 * 60 * 1000;  // default: 7d
}

function topByKey(calls, keyFn, limit) {
  const counts = new Map();
  for (const c of calls) {
    const k = keyFn(c);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function perHour(calls) {
  const buckets = new Array(24).fill(0);
  for (const c of calls) {
    const h = new Date(c.deliveredAt).getHours();
    buckets[h] += 1;
  }
  return buckets;
}

app.get('/health', (_req, res) => {
  const tokenValid = !!(tokenCache.accessToken && tokenCache.expiresAt > new Date());
  const authOperational = tokenValid || !!(ENV_ESL_USERNAME && ENV_ESL_PASSWORD && !authHealth.lastError);
  res.json({
    status: authOperational ? 'running' : 'degraded',
    timestamp: new Date().toISOString(),
    authOperational,
    pendingJobs: jobs.size,
    lastAuthSuccessAt: authHealth.lastSuccessAt,
  });
});

// ===========================================================================
// Start
// ===========================================================================
const PORT = process.env.PORT || 3000;

function startRelay() {
  if (!process.env.AUTH_KEY) {
    throw new Error('AUTH_KEY is required; refusing to start without request authentication');
  }
  loadMappings();
  loadPersistedSession();
  loadAcknowledgements();
  loadJobs();

  if (ENV_ESL_USERNAME && ENV_ESL_PASSWORD &&
      !(tokenCache.accessToken && tokenCache.expiresAt > new Date())) {
    authHealth.lastError = 'Authentication validation in progress';
    loginAndGetToken().catch(err => {
      authHealth.lastError = err.message;
      console.error('ESL Auth: startup validation failed:', err.message);
    });
  }

  scheduleJobRunner();
  app.listen(PORT, () => console.log(`ESL Relay listening on port ${PORT}`));
}

try {
  startRelay();
} catch (err) {
  console.error('Relay startup failed:', err.message);
  process.exitCode = 1;
}
