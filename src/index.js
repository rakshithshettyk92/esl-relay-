require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const {
  boundedInt,
  usableTokenLifetimeMs,
  articleCacheKey,
  validTimeZone,
  perHour,
} = require('./runtime-utils');
const database = require('./database');
const { installLogCapture, connectLogPersistence, mountOps } = require('./ops');

installLogCapture();

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function envInt(name, fallback, min, max) {
  return boundedInt(process.env[name], fallback, min, max);
}

// ===========================================================================
// Runtime configuration and bounded in-memory caches.
// Associate sessions and encrypted AIMS tokens live in PostgreSQL.
// ===========================================================================

const ESL_BASE_URL = process.env.ESL_BASE_URL || 'https://eastus.common.solumesl.com/common';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ESL_REQUEST_TIMEOUT_MS = envInt('ESL_REQUEST_TIMEOUT_MS', 20_000, 1_000, 120_000);
const TOKEN_REFRESH_BUFFER_SECONDS = envInt('TOKEN_REFRESH_BUFFER_SECONDS', 300, 0, 3_600);
const ARTICLE_LOOKUP_TIMEOUT_MS = envInt('ARTICLE_LOOKUP_TIMEOUT_MS', 30_000, 5_000, 120_000);
const ARTICLE_CACHE_TTL_MS = envInt('ARTICLE_CACHE_TTL_SECONDS', 300, 0, 3_600) * 1000;
const articleCache = new Map();
const sessionTokenPromises = new Map();

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
        await flipPage(job.payload.companyCode, job.payload.storeCode,
          job.payload.labelCode, 1, job.payload.sessionId);
      } else if (job.type === 'cancel') {
        await sendStoreMessage(job.payload.companyCode, job.payload.storeCode, {
          data: {
            type: 'cancel',
            callId: job.payload.callId || '',
            labelCode: job.payload.labelCode,
            claimedBy: job.payload.claimedBy || '',
          },
          android: { priority: 'high', ttl: 30000 },
        });
      } else if (job.type === 'esl-actions') {
        await triggerEslActions(job.payload.companyCode, job.payload.storeCode,
          job.payload.labelCode, job.payload.revertDelayMs, job.payload.sessionId);
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

function normalizeTokens(tokens) {
  const expiresInMs = usableTokenLifetimeMs(tokens.expires_in, TOKEN_REFRESH_BUFFER_SECONDS);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + expiresInMs),
  };
}

async function loginWithCredentials(username, password) {
  console.log(`ESL Auth: validating associate ${username}`);
  const resp = await fetchWithTimeout(`${ESL_BASE_URL}/api/v2/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const data = await resp.json();
  if (data.responseCode !== '200') {
    throw new Error(`Login failed (${data.responseCode}): ${JSON.stringify(data.responseMessage ?? data)}`);
  }

  return normalizeTokens(data.responseMessage);
}

async function refreshSession(session, companyCode) {
  if (!session.refreshToken) throw new Error('Refresh token expired; please sign in again');
  console.log(`ESL Auth: refreshing token for ${session.username}`);

  const resp = await fetchWithTimeout(`${ESL_BASE_URL}/api/v2/token/refresh?company=${companyCode}`, {
    method: 'POST',
    headers: {
      'accept':        'application/json',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });

  const data = await resp.json();
  if (data.responseCode !== '200') {
    throw new Error(`Refresh failed (${data.responseCode}): ${JSON.stringify(data.responseMessage ?? data)}`);
  }

  const tokens = normalizeTokens(data.responseMessage);
  await database.saveSessionTokens(session.id, tokens);
  return tokens.accessToken;
}

async function getSessionAccessToken(sessionId, companyCode) {
  const session = await database.getSessionById(sessionId);
  if (!session) throw new Error('Associate session is no longer active; please sign in again');
  if (session.accessToken && session.accessExpiresAt > new Date()) return session.accessToken;
  if (sessionTokenPromises.has(sessionId)) return sessionTokenPromises.get(sessionId);
  const pending = refreshSession(session, companyCode);
  sessionTokenPromises.set(sessionId, pending);
  try {
    return await pending;
  } catch (err) {
    await database.clearSessionTokens(sessionId);
    throw err;
  } finally {
    sessionTokenPromises.delete(sessionId);
  }
}

async function getStoreAccessToken(companyCode, storeCode, preferredSessionId = null) {
  const candidates = await database.getStoreSessions(companyCode, storeCode);
  if (preferredSessionId) {
    candidates.sort((a, b) => (a.id === preferredSessionId ? -1 : b.id === preferredSessionId ? 1 : 0));
  }
  if (candidates.length === 0) {
    throw new Error(`No signed-in associate is registered for ${companyCode}/${storeCode}`);
  }
  let lastError;
  for (const session of candidates) {
    try {
      return { token: await getSessionAccessToken(session.id, companyCode), sessionId: session.id };
    } catch (error) {
      lastError = error;
      console.warn(`ESL Auth: ${session.username} unavailable for ${companyCode}/${storeCode}: ${error.message}`);
    }
  }
  throw lastError || new Error('No usable associate session is available');
}

// ===========================================================================
// ESL API — Label Actions
// ===========================================================================

async function flipPage(companyCode, storeCode, labelCode, page, preferredSessionId = null) {
  const { token, sessionId } = await getStoreAccessToken(companyCode, storeCode, preferredSessionId);
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
  return { data, sessionId };
}

async function blinkLed(companyCode, storeCode, labelCode, preferredSessionId = null) {
  const { token, sessionId } = await getStoreAccessToken(companyCode, storeCode, preferredSessionId);
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
  return { data, sessionId };
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
  // The AIMS response only contains the fields requested by the active mapping.
  // Include those field names in the key so a mapping change cannot reuse an
  // article cached with a different (and therefore incomplete) projection.
  const cacheKey = articleCacheKey(companyCode, storeCode, articleId, mapping);
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
    const { token } = await getStoreAccessToken(companyCode, storeCode);

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

async function triggerEslActions(companyCode, storeCode, labelCode, revertDelayMs = 60_000,
  preferredSessionId = null) {
  let pageFlipped = false;
  let sessionId = preferredSessionId;
  try {
    const flipped = await flipPage(companyCode, storeCode, labelCode, 2, sessionId);
    sessionId = flipped.sessionId;
    pageFlipped = true;
    try {
      await blinkLed(companyCode, storeCode, labelCode, sessionId);
    } catch (err) {
      console.error(`ESL: LED action failed for ${labelCode}:`, err.message);
    }
  } catch (err) {
    console.error(`ESL: Actions failed for ${labelCode}:`, err.message);
    throw err;
  } finally {
    if (pageFlipped) {
      enqueueJob('revert', { companyCode, storeCode, labelCode, sessionId }, Date.now() + revertDelayMs);
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

  const actual = Buffer.from(req.headers[headerName] || '');
  const expected = Buffer.from(expectedKey);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function requireSession(req, res, next) {
  try {
    const session = await database.findSession(req.get('x-session-token'));
    if (!session) return res.status(401).json({ error: 'Associate session expired; please sign in again' });
    req.associateSession = session;
    next();
  } catch (error) {
    console.error('Session validation failed:', error.message);
    res.status(503).json({ error: 'Session service is temporarily unavailable' });
  }
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
app.post('/auth/login', limitLoginAttempts, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' ||
      !username.trim() || !password || username.length > 256 || password.length > 1024) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  try {
    const tokens = await loginWithCredentials(username.trim(), password);
    const session = await database.createSession(username.trim(), tokens);
    loginAttempts.delete(req.loginAttemptKey);
    console.log(`Auth: associate logged in as ${username.trim()}`);
    res.json({
      status: 'ok',
      username: username.trim(),
      sessionToken: session.rawToken,
      message: `Logged in as ${username.trim()}`,
    });
  } catch (err) {
    console.error('Auth: Login failed:', err.message);
    res.status(401).json({ error: err.message });
  }
});

app.post('/auth/logout', requireSession, asyncRoute(async (req, res) => {
  await database.revokeSession(req.associateSession.id);
  console.log(`Auth: associate logged out ${req.associateSession.username}`);
  res.json({ status: 'ok', message: 'Logged out' });
}));

app.get('/auth/status', asyncRoute(async (req, res) => {
  const session = await database.findSession(req.get('x-session-token'));
  if (!session) {
    return res.json({ loggedIn: false, tokenValid: false, operational: false, managedLogin: false });
  }
  const tokenValid = !!(session.accessToken && session.accessExpiresAt > new Date());
  res.json({
    loggedIn: true,
    username: session.username,
    tokenValid,
    operational: tokenValid || !!session.refreshToken,
    managedLogin: false,
  });
}));

app.post('/devices/register', requireSession, asyncRoute(async (req, res) => {
  const { fcmToken, companyCode, storeCode, storeName } = req.body ?? {};
  if (typeof fcmToken !== 'string' || typeof companyCode !== 'string' ||
      typeof storeCode !== 'string' || !fcmToken || !companyCode || !storeCode ||
      fcmToken.length > 4096 || companyCode.length > 128 || storeCode.length > 128 ||
      (storeName && (typeof storeName !== 'string' || storeName.length > 256))) {
    return res.status(400).json({ error: 'fcmToken, companyCode and storeCode are required' });
  }
  await database.registerDevice(req.associateSession.id, fcmToken, companyCode, storeCode, storeName);
  console.log(`Device registered: ${req.associateSession.username} -> ${companyCode}/${storeCode}`);
  res.json({ status: 'ok' });
}));

app.post('/devices/unregister', requireSession, asyncRoute(async (req, res) => {
  const { fcmToken } = req.body ?? {};
  if (!fcmToken) return res.status(400).json({ error: 'fcmToken is required' });
  await database.removeSessionDevice(req.associateSession.id, fcmToken);
  res.json({ status: 'ok' });
}));

// ===========================================================================
// Webhook Routes
// ===========================================================================

async function sendStoreMessage(companyCode, storeCode, message) {
  const tokens = await database.getStoreDeviceTokens(companyCode, storeCode);
  if (tokens.length === 0) {
    console.warn(`FCM: no registered devices for ${companyCode}/${storeCode}`);
    return { successCount: 0, failureCount: 0, deviceCount: 0 };
  }
  let successCount = 0;
  let failureCount = 0;
  for (let offset = 0; offset < tokens.length; offset += 500) {
    const batch = tokens.slice(offset, offset + 500);
    const result = await getMessaging().sendEachForMulticast({ ...message, tokens: batch });
    successCount += result.successCount;
    failureCount += result.failureCount;
    await Promise.all(result.responses.map(async (response, index) => {
      const code = response.error?.code || '';
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        await database.removeDeviceToken(batch[index]);
      }
    }));
  }
  console.log(`FCM: ${companyCode}/${storeCode} delivered=${successCount} failed=${failureCount}`);
  return { successCount, failureCount, deviceCount: tokens.length };
}

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
      console.log(`Event ignored: type=${body.type}. Only buttonPress creates an employee call.`);
      return;
    }

    const companyCode = body.customerCode ?? '';
    const storeCode   = body.storeCode    ?? '';
    const eventInfo   = Array.isArray(body.eventInfo) ? body.eventInfo[0] : {};
    const labelCode   = eventInfo.labelCode  ?? '';
    const articleIds  = Array.isArray(eventInfo.articleIds) ? eventInfo.articleIds : [];
    const articleId   = articleIds[0] ?? '';

    if (!companyCode || !storeCode) {
      console.warn('Call skipped: webhook is missing customerCode or storeCode and cannot be routed.');
      return;
    }

    // Filter 0: Solum uses the sentinel articleId "imagepush" for image-push
    // events on a label. Drop without hitting Solum — saves an API call.
    if (articleId.toLowerCase() === 'imagepush') {
      console.log(`Event ignored: ${articleId} is an image-push event, not an employee call.`);
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
      if (flag === '') {
        console.log(
          `Call skipped: article ${articleId} has no value in eligibility field ` +
          `"${mapping.helpEnabledField}". Expected "${mapping.helpEnabledValue}". ` +
          'Update the AIMS article or the store Call Rules.'
        );
      } else {
        console.log(
          `Call skipped: article ${articleId} has "${flag}" in eligibility field ` +
          `"${mapping.helpEnabledField}"; expected "${mapping.helpEnabledValue}".`
        );
      }
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

    const created = await database.createCall({
      companyCode,
      storeCode,
      labelCode,
      articleId,
      articleName: name,
      aisle: aisle || null,
      message: alertMessage,
      payload: body,
    });
    if (!created.created) {
      console.log(`Webhook: duplicate open call ignored for ${companyCode}/${storeCode}/${labelCode}`);
      return;
    }

    const callId = created.call.id;
    const fcmResult = await sendStoreMessage(companyCode, storeCode, {
      data: {
        title:       'Employee Call',
        message:     alertMessage,
        callId,
        companyCode,
        storeCode,
        labelCode,
        payload:     JSON.stringify(body),
      },
      android: { priority: 'high', ttl: 60000 },
    });
    console.log(`FCM call ${callId}:`, fcmResult);

    await database.addCallEvent({
      callId,
      eventType: 'delivered',
      details: fcmResult,
    });

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

app.post('/webhook', validateAuth, handleWebhook);

// "On My Way" — triggered by the mobile app when user acknowledges the call
app.post('/esl/acknowledge', requireSession, asyncRoute(async (req, res) => {
  const { callId, companyCode, storeCode, labelCode } = req.body ?? {};
  if (!companyCode || !storeCode || !labelCode) {
    return res.status(400).json({ error: 'companyCode, storeCode and labelCode are required' });
  }
  if (callId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId)) {
    return res.status(400).json({ error: 'callId is invalid' });
  }
  if (req.associateSession.companyCode !== companyCode || req.associateSession.storeCode !== storeCode) {
    return res.status(403).json({ error: 'This associate is not registered to that store' });
  }

  const claimResult = await database.claimCall({
    callId: callId || null,
    companyCode,
    storeCode,
    labelCode,
    session: req.associateSession,
  });
  if (!claimResult.claimed) {
    const claimedBy = claimResult.call?.claimed_by_username || '';
    return res.status(409).json({
      status: 'already_acknowledged',
      claimedBy,
      message: claimedBy
        ? `Already acknowledged by ${claimedBy}`
        : 'Already acknowledged by another associate',
    });
  }

  console.log(`ESL: Acknowledge from app: ${companyCode} / ${storeCode} / ${labelCode}`);

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
  enqueueJob('cancel', {
    callId: claimResult.call.id,
    companyCode,
    storeCode,
    labelCode,
    claimedBy: req.associateSession.username,
  });
  enqueueJob('esl-actions', {
    companyCode, storeCode, labelCode,
    sessionId: req.associateSession.id,
    revertDelayMs: delaySec * 1000,
  });
  res.json({
    status: 'ok',
    callId: claimResult.call.id,
    claimedBy: req.associateSession.username,
  });
}));

// Reports a terminal status for an alert that the relay never observed —
// missed (timed out on the device) or dismissed (manually closed). Fire-and-
// forget from the app; failures are logged but never block the user.
app.post('/esl/status', requireSession, asyncRoute(async (req, res) => {
  const { callId, companyCode, storeCode, labelCode, status } = req.body ?? {};
  const allowed = new Set(['missed', 'dismissed']);
  if (!companyCode || !storeCode || !labelCode || !allowed.has(status)) {
    return res.status(400).json({
      error: 'companyCode, storeCode, labelCode and status (missed|dismissed) are required',
    });
  }
  if (req.associateSession.companyCode !== companyCode || req.associateSession.storeCode !== storeCode) {
    return res.status(403).json({ error: 'This associate is not registered to that store' });
  }
  appendCallEvent({
    type:      status,           // 'missed' or 'dismissed'
    ts:        Date.now(),
    company:   companyCode,
    store:     storeCode,
    labelCode,
  });
  await database.addCallEvent({
    callId: callId || null,
    eventType: status,
    session: req.associateSession,
    details: { companyCode, storeCode, labelCode },
  });
  res.json({ status: 'ok' });
}));

// ===========================================================================
// Admin Routes — used by the mobile app's setup screens
// ===========================================================================

// List stores for a company. Proxies Solum so the app doesn't need its own token.
app.get('/admin/stores', requireSession, async (req, res) => {
  const company = (req.query.company ?? '').toString().trim();
  if (!company) return res.status(400).json({ error: 'company is required' });

  try {
    const token = await getSessionAccessToken(req.associateSession.id, company);
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
app.get('/admin/articles/upload/format', requireSession, async (req, res) => {
  const company = (req.query.company ?? '').toString().trim();
  if (!company) return res.status(400).json({ error: 'company is required' });

  try {
    const token = await getSessionAccessToken(req.associateSession.id, company);
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
app.get('/admin/field-mapping', requireSession, (req, res) => {
  const company = (req.query.company ?? '').toString().trim();
  const store   = (req.query.store   ?? '').toString().trim();
  if (!company || !store) {
    return res.status(400).json({ error: 'company and store are required' });
  }
  const mapping = fieldMappings.get(mappingKey(company, store)) || DEFAULT_MAPPING;
  const saved   = fieldMappings.has(mappingKey(company, store));
  res.json({ mapping, saved });
});

app.post('/admin/field-mapping', requireSession, (req, res) => {
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
  // Mapping changes must take effect on the very next button press. Clearing
  // this small bounded cache avoids retaining projections created beforehand.
  articleCache.clear();
  saveMappings();
  console.log(`Admin: saved mapping for ${company}/${store}`);
  res.json({ status: 'ok', mapping: clean });
});

// Aggregates the per-store call log into the shape the Android Analytics
// screen renders. Status updates are matched back to the most recent prior
// delivered event for the same (company, store, labelCode) — that's how a
// "missed"/"acknowledged" event picks up the article name + aisle.
app.get('/admin/analytics', requireSession, (req, res) => {
  const company = (req.query.company ?? '').toString().trim();
  const store   = (req.query.store   ?? '').toString().trim();
  const range   = (req.query.range   ?? '7d').toString();
  const timeZone = validTimeZone((req.query.timeZone ?? '').toString());
  const todayStartMs = Number(req.query.todayStartMs);
  if (!company || !store) {
    return res.status(400).json({ error: 'company and store are required' });
  }

  const sinceTs = rangeStartMs(range, todayStartMs);
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
    timeZone,
    sinceTs,
    totals,
    responseMs:  { avg: avgMs, p50: p50Ms, p95: p95Ms, samples: responseMs.length },
    topAisles:   topByKey(calls, c => c.aisle, 10),
    topArticles: topByKey(calls, c => c.articleName, 10),
    perHour:     perHour(calls, timeZone),
  });
});

function rangeStartMs(range, deviceTodayStartMs) {
  const now = Date.now();
  if (range === 'today') {
    if (Number.isFinite(deviceTodayStartMs)
        && deviceTodayStartMs >= now - 36 * 60 * 60 * 1000
        && deviceTodayStartMs <= now + 60 * 60 * 1000) {
      return deviceTodayStartMs;
    }
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

app.get('/health', async (_req, res) => {
  try {
    const db = await database.health();
    res.json({
      status: 'running',
      timestamp: new Date().toISOString(),
      database: db,
      pendingJobs: jobs.size,
    });
  } catch (error) {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      database: { connected: false, error: error.message },
      pendingJobs: jobs.size,
    });
  }
});

mountOps(app, database, () => ({ pendingJobs: jobs.size }));

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  console.error('Unhandled request error:', error.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ===========================================================================
// Start
// ===========================================================================
const PORT = process.env.PORT || 3000;

async function startRelay() {
  if (!process.env.AUTH_KEY) {
    throw new Error('AUTH_KEY is required; refusing to start without request authentication');
  }
  await database.initDatabase();
  await database.ensureOpsAdmin(process.env.OPS_USERNAME, process.env.OPS_PASSWORD);
  await database.pruneOperationsData();
  connectLogPersistence(database);
  loadMappings();
  loadJobs();
  scheduleJobRunner();
  app.listen(PORT, () => console.log(`ESL Relay listening on port ${PORT}`));
}

(async () => {
  try {
    await startRelay();
  } catch (err) {
  console.error('Relay startup failed:', err.message);
  process.exitCode = 1;
  }
})();
