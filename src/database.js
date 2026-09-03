'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

let pool;
let encryptionKey;

function requireConfiguration() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const rawKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!rawKey) throw new Error('TOKEN_ENCRYPTION_KEY is required');
  encryptionKey = Buffer.from(rawKey, 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a Base64-encoded 32-byte key');
  }
}

function encrypt(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64')).join('.');
}

function decrypt(value) {
  if (!value) return null;
  const [iv, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hydrateSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    companyCode: row.company_code,
    storeCode: row.store_code,
    storeName: row.store_name,
    accessToken: decrypt(row.access_token_enc),
    refreshToken: decrypt(row.refresh_token_enc),
    accessExpiresAt: row.access_expires_at ? new Date(row.access_expires_at) : null,
    createdAt: new Date(row.created_at),
    lastSeenAt: new Date(row.last_seen_at),
  };
}

async function initDatabase() {
  requireConfiguration();
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', error => console.error('PostgreSQL pool error:', error.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS associate_sessions (
      id UUID PRIMARY KEY,
      token_hash CHAR(64) UNIQUE NOT NULL,
      username TEXT NOT NULL,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      access_expires_at TIMESTAMPTZ,
      company_code TEXT,
      store_code TEXT,
      store_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS associate_sessions_store_idx
      ON associate_sessions (company_code, store_code)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS devices (
      fcm_token TEXT PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES associate_sessions(id) ON DELETE CASCADE,
      company_code TEXT NOT NULL,
      store_code TEXT NOT NULL,
      store_name TEXT,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS devices_store_idx ON devices (company_code, store_code);

    CREATE TABLE IF NOT EXISTS calls (
      id UUID PRIMARY KEY,
      company_code TEXT NOT NULL,
      store_code TEXT NOT NULL,
      label_code TEXT NOT NULL,
      article_id TEXT,
      article_name TEXT,
      aisle TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'claimed', 'closed', 'missed')),
      payload JSONB,
      claimed_by_session UUID REFERENCES associate_sessions(id),
      claimed_by_username TEXT,
      claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      resolution_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS calls_store_status_idx
      ON calls (company_code, store_code, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS calls_label_idx
      ON calls (company_code, store_code, label_code, created_at DESC);

    CREATE TABLE IF NOT EXISTS call_events (
      id BIGSERIAL PRIMARY KEY,
      call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      session_id UUID REFERENCES associate_sessions(id) ON DELETE SET NULL,
      username TEXT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS call_events_created_idx ON call_events (created_at DESC);

    CREATE TABLE IF NOT EXISTS ops_users (
      id UUID PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ops_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ops_sessions_expiry_idx ON ops_sessions (expires_at);

    CREATE TABLE IF NOT EXISTS system_logs (
      id BIGSERIAL PRIMARY KEY,
      logged_at TIMESTAMPTZ NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS system_logs_logged_idx ON system_logs (logged_at DESC);

    ALTER TABLE calls ADD COLUMN IF NOT EXISTS resolution_reason TEXT;
  `);
  await pool.query('SELECT 1');
}

async function health() {
  const started = Date.now();
  await pool.query('SELECT 1');
  return { connected: true, latencyMs: Date.now() - started };
}

async function createSession(username, tokens) {
  const id = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString('base64url');
  await pool.query(`
    INSERT INTO associate_sessions
      (id, token_hash, username, access_token_enc, refresh_token_enc, access_expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [id, tokenHash(rawToken), username, encrypt(tokens.accessToken),
    encrypt(tokens.refreshToken), tokens.expiresAt]);
  return { id, rawToken };
}

async function findSession(rawToken, { touch = true } = {}) {
  if (!rawToken) return null;
  const result = await pool.query(`
    SELECT * FROM associate_sessions
    WHERE token_hash = $1 AND revoked_at IS NULL
  `, [tokenHash(rawToken)]);
  const session = hydrateSession(result.rows[0]);
  if (session && touch) {
    await pool.query('UPDATE associate_sessions SET last_seen_at=NOW() WHERE id=$1', [session.id]);
  }
  return session;
}

async function getSessionById(id) {
  const result = await pool.query(`
    SELECT * FROM associate_sessions WHERE id=$1 AND revoked_at IS NULL
  `, [id]);
  return hydrateSession(result.rows[0]);
}

async function saveSessionTokens(id, tokens) {
  await pool.query(`
    UPDATE associate_sessions
    SET access_token_enc=$2, refresh_token_enc=$3, access_expires_at=$4, last_seen_at=NOW()
    WHERE id=$1 AND revoked_at IS NULL
  `, [id, encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt]);
}

async function clearSessionTokens(id) {
  await pool.query(`
    UPDATE associate_sessions
    SET access_token_enc=NULL, refresh_token_enc=NULL, access_expires_at=NULL
    WHERE id=$1
  `, [id]);
}

async function revokeSession(id) {
  await pool.query('UPDATE associate_sessions SET revoked_at=NOW() WHERE id=$1', [id]);
  await pool.query('DELETE FROM devices WHERE session_id=$1', [id]);
}

async function setSessionStore(id, companyCode, storeCode, storeName) {
  await pool.query(`
    UPDATE associate_sessions
    SET company_code=$2, store_code=$3, store_name=$4, last_seen_at=NOW()
    WHERE id=$1 AND revoked_at IS NULL
  `, [id, companyCode, storeCode, storeName || null]);
}

async function registerDevice(sessionId, fcmToken, companyCode, storeCode, storeName) {
  await setSessionStore(sessionId, companyCode, storeCode, storeName);
  await pool.query(`
    INSERT INTO devices (fcm_token, session_id, company_code, store_code, store_name)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (fcm_token) DO UPDATE SET
      session_id=EXCLUDED.session_id,
      company_code=EXCLUDED.company_code,
      store_code=EXCLUDED.store_code,
      store_name=EXCLUDED.store_name,
      last_seen_at=NOW()
  `, [fcmToken, sessionId, companyCode, storeCode, storeName || null]);
}

async function removeDeviceToken(fcmToken) {
  await pool.query('DELETE FROM devices WHERE fcm_token=$1', [fcmToken]);
}

async function removeSessionDevice(sessionId, fcmToken) {
  await pool.query('DELETE FROM devices WHERE session_id=$1 AND fcm_token=$2', [sessionId, fcmToken]);
}

async function getStoreDeviceTokens(companyCode, storeCode) {
  const result = await pool.query(`
    SELECT d.fcm_token
    FROM devices d
    JOIN associate_sessions s ON s.id=d.session_id
    WHERE d.company_code=$1 AND d.store_code=$2 AND s.revoked_at IS NULL
    ORDER BY d.last_seen_at DESC
  `, [companyCode, storeCode]);
  return result.rows.map(row => row.fcm_token);
}

async function getStoreSessions(companyCode, storeCode) {
  const result = await pool.query(`
    SELECT DISTINCT s.*
    FROM associate_sessions s
    JOIN devices d ON d.session_id=s.id
    WHERE d.company_code=$1 AND d.store_code=$2 AND s.revoked_at IS NULL
    ORDER BY s.last_seen_at DESC
  `, [companyCode, storeCode]);
  return result.rows.map(hydrateSession);
}

async function countActiveStoreSessions(companyCode, storeCode) {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM associate_sessions
    WHERE company_code=$1 AND store_code=$2 AND revoked_at IS NULL
  `, [companyCode, storeCode]);
  return result.rows[0]?.count || 0;
}

async function createCall(call) {
  await pool.query(`
    UPDATE calls SET status='missed', closed_at=NOW(),
      resolution_reason=COALESCE(resolution_reason, 'no_response')
    WHERE status='open' AND created_at < NOW() - INTERVAL '2 minutes'
  `);
  const recent = await pool.query(`
    SELECT * FROM calls
    WHERE company_code=$1 AND store_code=$2 AND label_code=$3
      AND created_at > NOW() - INTERVAL '30 seconds'
    ORDER BY created_at DESC LIMIT 1
  `, [call.companyCode, call.storeCode, call.labelCode]);
  if (recent.rows[0]) return { call: recent.rows[0], created: false };

  const id = crypto.randomUUID();
  const result = await pool.query(`
    INSERT INTO calls
      (id, company_code, store_code, label_code, article_id, article_name, aisle, message, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
  `, [id, call.companyCode, call.storeCode, call.labelCode, call.articleId || null,
    call.articleName || null, call.aisle || null, call.message, call.payload || null]);
  return { call: result.rows[0], created: true };
}

async function markCallMissed({ callId, companyCode, storeCode, labelCode, reason, details }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      UPDATE calls SET status='missed', closed_at=NOW(), resolution_reason=$5
      WHERE status='open' AND (
        ($1::uuid IS NOT NULL AND id=$1)
        OR ($1::uuid IS NULL AND company_code=$2 AND store_code=$3 AND label_code=$4)
      )
      RETURNING *
    `, [callId || null, companyCode, storeCode, labelCode, reason]);
    const call = result.rows[0];
    if (call) {
      await client.query(`
        INSERT INTO call_events (call_id, event_type, details)
        VALUES ($1, 'missed', $2)
      `, [call.id, { ...(details || {}), reason }]);
    }
    await client.query('COMMIT');
    return call || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function claimCall({ callId, companyCode, storeCode, labelCode, session }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(`
      UPDATE calls SET
        status='claimed', claimed_by_session=$1, claimed_by_username=$2, claimed_at=NOW()
      WHERE id = COALESCE(
        $3::uuid,
        (SELECT id FROM calls
         WHERE company_code=$4 AND store_code=$5 AND label_code=$6 AND status='open'
           AND created_at > NOW() - INTERVAL '10 minutes'
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE)
      ) AND status='open' AND created_at > NOW() - INTERVAL '10 minutes'
      RETURNING *
    `, [session.id, session.username, callId || null, companyCode, storeCode, labelCode]);
    if (claimed.rows[0]) {
      await client.query(`
        INSERT INTO call_events (call_id, event_type, session_id, username)
        VALUES ($1, 'claimed', $2, $3)
      `, [claimed.rows[0].id, session.id, session.username]);
      await client.query('COMMIT');
      return { claimed: true, call: claimed.rows[0] };
    }
    const existing = await client.query(`
      SELECT * FROM calls
      WHERE ($1::uuid IS NOT NULL AND id=$1)
         OR ($1::uuid IS NULL AND company_code=$2 AND store_code=$3 AND label_code=$4)
      ORDER BY created_at DESC LIMIT 1
    `, [callId || null, companyCode, storeCode, labelCode]);
    await client.query('COMMIT');
    return { claimed: false, call: existing.rows[0] || null };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function addCallEvent({ callId, eventType, session, details }) {
  await pool.query(`
    INSERT INTO call_events (call_id, event_type, session_id, username, details)
    VALUES ($1,$2,$3,$4,$5)
  `, [callId || null, eventType, session?.id || null, session?.username || null, details || null]);
}

async function getOpsSummary() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM associate_sessions WHERE revoked_at IS NULL) active_sessions,
      (SELECT COUNT(*)::int FROM devices) registered_devices,
      (SELECT COUNT(*)::int FROM calls WHERE status='open') open_calls,
      (SELECT COUNT(*)::int FROM calls WHERE created_at > NOW() - INTERVAL '24 hours') calls_24h
  `);
  return result.rows[0];
}

async function getRecentCalls(limit = 50) {
  const result = await pool.query(`
    SELECT id, company_code, store_code, label_code, article_name, aisle, message,
           status, claimed_by_username, created_at, claimed_at, closed_at, resolution_reason
    FROM calls
    WHERE created_at >= NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC LIMIT $1
  `, [Math.max(1, Math.min(200, limit))]);
  return result.rows;
}

async function getStoreCallHistory(companyCode, storeCode, limit = 100) {
  const result = await pool.query(`
    SELECT id, company_code, store_code, label_code, article_name, aisle, message,
           status, claimed_by_username, created_at, claimed_at, closed_at, resolution_reason
    FROM calls
    WHERE company_code=$1 AND store_code=$2
      AND status IN ('claimed', 'closed', 'missed')
      AND created_at >= NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC LIMIT $3
  `, [companyCode, storeCode, Math.max(1, Math.min(200, limit))]);
  return result.rows;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('base64');
}

async function ensureOpsAdmin(username, password) {
  if (!username || !password) throw new Error('OPS_USERNAME and OPS_PASSWORD are required');
  const existing = await pool.query('SELECT id FROM ops_users WHERE username=$1', [username]);
  const salt = crypto.randomBytes(24).toString('base64');
  if (existing.rows[0]) {
    await pool.query(`
      UPDATE ops_users SET password_salt=$2, password_hash=$3 WHERE id=$1
    `, [existing.rows[0].id, salt, hashPassword(password, salt)]);
    return;
  }
  await pool.query(`
    INSERT INTO ops_users (id, username, password_salt, password_hash)
    VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING
  `, [crypto.randomUUID(), username, salt, hashPassword(password, salt)]);
  console.log(`Operations admin seeded: ${username}`);
}

async function authenticateOpsAdmin(username, password) {
  const result = await pool.query('SELECT * FROM ops_users WHERE username=$1', [username]);
  const user = result.rows[0];
  if (!user) return null;
  const actual = Buffer.from(hashPassword(password || '', user.password_salt), 'base64');
  const expected = Buffer.from(user.password_hash, 'base64');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return { id: user.id, username: user.username };
}

async function createOpsSession(userId, lifetimeHours = 12) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + lifetimeHours * 60 * 60 * 1000);
  await pool.query(`
    INSERT INTO ops_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)
  `, [tokenHash(rawToken), userId, expiresAt]);
  return { rawToken, expiresAt };
}

async function findOpsSession(rawToken) {
  if (!rawToken) return null;
  const result = await pool.query(`
    SELECT u.id, u.username, s.expires_at
    FROM ops_sessions s JOIN ops_users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at > NOW()
  `, [tokenHash(rawToken)]);
  return result.rows[0] || null;
}

async function revokeOpsSession(rawToken) {
  if (rawToken) await pool.query('DELETE FROM ops_sessions WHERE token_hash=$1', [tokenHash(rawToken)]);
}

async function addSystemLog(entry) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO system_logs (logged_at, level, message) VALUES ($1,$2,$3)
  `, [entry.timestamp, entry.level, entry.message]);
}

async function getSystemLogs(limit = 200, level = null) {
  const safeLimit = Math.max(1, Math.min(1000, limit));
  const result = await pool.query(`
    SELECT logged_at AS timestamp, level, message
    FROM system_logs
    WHERE logged_at >= NOW() - INTERVAL '7 days'
      AND ($2::text IS NULL OR level=$2)
    ORDER BY logged_at DESC LIMIT $1
  `, [safeLimit, level]);
  return result.rows;
}

async function pruneOperationsData() {
  await pool.query("DELETE FROM system_logs WHERE logged_at < NOW() - INTERVAL '7 days'");
  await pool.query('DELETE FROM ops_sessions WHERE expires_at <= NOW()');
}

module.exports = {
  initDatabase,
  health,
  createSession,
  findSession,
  getSessionById,
  saveSessionTokens,
  clearSessionTokens,
  revokeSession,
  registerDevice,
  removeDeviceToken,
  removeSessionDevice,
  getStoreDeviceTokens,
  getStoreSessions,
  countActiveStoreSessions,
  createCall,
  claimCall,
  markCallMissed,
  addCallEvent,
  getOpsSummary,
  getRecentCalls,
  getStoreCallHistory,
  ensureOpsAdmin,
  authenticateOpsAdmin,
  createOpsSession,
  findOpsSession,
  revokeOpsSession,
  addSystemLog,
  getSystemLogs,
  pruneOperationsData,
};
