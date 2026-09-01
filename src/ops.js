'use strict';

const path = require('path');
const util = require('util');
const express = require('express');

const MAX_MEMORY_LOGS = 1_000;
const COOKIE_NAME = 'esl_ops_session';
const logs = [];
let captureInstalled = false;
let logDatabase = null;

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/("?(?:password|accessToken|refreshToken|sessionToken|authorization)"?\s*[:=]\s*)[^,}\s]+/gi,
      '$1[redacted]');
}

function installLogCapture() {
  if (captureInstalled) return;
  captureInstalled = true;
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        message: redact(args.map(arg => typeof arg === 'string'
          ? arg : util.inspect(arg, { depth: 3, breakLength: 160 })).join(' ')),
      };
      logs.push(entry);
      if (logs.length > MAX_MEMORY_LOGS) logs.splice(0, logs.length - MAX_MEMORY_LOGS);
      if (logDatabase) void logDatabase.addSystemLog(entry).catch(() => {});
      original(...args);
    };
  }
}

function connectLogPersistence(database) {
  logDatabase = database;
  const timer = setInterval(() => void database.pruneOperationsData().catch(() => {}), 60 * 60 * 1000);
  timer.unref();
}

function parseCookies(req) {
  return Object.fromEntries((req.get('cookie') || '').split(';').map(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1))];
  }).filter(([key]) => key));
}

function mountOps(app, database, stateProvider) {
  const publicDir = path.join(__dirname, '..', 'public');
  const loginAttempts = new Map();
  const formParser = express.urlencoded({ extended: false, limit: '8kb' });

  const requireOpsSession = async (req, res, next) => {
    try {
      const token = parseCookies(req)[COOKIE_NAME];
      const session = await database.findOpsSession(token);
      if (!session) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required' });
        return res.redirect('/ops/login');
      }
      req.opsSession = session;
      next();
    } catch (error) {
      console.error('Operations session check failed:', error.message);
      res.status(503).send('Operations database is temporarily unavailable');
    }
  };

  app.get('/ops/login', (_req, res) => res.sendFile(path.join(publicDir, 'ops-login.html')));
  app.get('/ops/login.css', (_req, res) => res.sendFile(path.join(publicDir, 'ops-login.css')));
  app.get('/ops/login.js', (_req, res) => res.sendFile(path.join(publicDir, 'ops-login.js')));
  app.post('/ops/login', formParser, async (req, res) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(key) || { count: 0, resetAt: now + 15 * 60_000 };
    if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 15 * 60_000; }
    if (attempt.count >= 8) return res.status(429).send('Too many attempts. Try again in 15 minutes.');
    attempt.count += 1;
    loginAttempts.set(key, attempt);
    try {
      const user = await database.authenticateOpsAdmin(req.body.username?.trim(), req.body.password);
      if (!user) return res.redirect('/ops/login?error=1');
      const session = await database.createOpsSession(user.id, 12);
      loginAttempts.delete(key);
      res.cookie(COOKIE_NAME, session.rawToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/ops',
        expires: session.expiresAt,
      });
      res.redirect('/ops');
    } catch (error) {
      console.error('Operations login failed:', error.message);
      res.status(503).send('Operations login is temporarily unavailable');
    }
  });

  app.post('/ops/logout', requireOpsSession, async (req, res) => {
    const token = parseCookies(req)[COOKIE_NAME];
    await database.revokeOpsSession(token);
    res.clearCookie(COOKIE_NAME, { path: '/ops' });
    res.redirect('/ops/login');
  });

  app.get('/ops', requireOpsSession, (_req, res) => res.sendFile(path.join(publicDir, 'ops.html')));
  app.get('/ops/styles.css', requireOpsSession, (_req, res) => res.sendFile(path.join(publicDir, 'ops.css')));
  app.get('/ops/app.js', requireOpsSession, (_req, res) => res.sendFile(path.join(publicDir, 'ops.js')));
  app.get('/ops/api/status', requireOpsSession, async (req, res) => {
    try {
      const [dbHealth, summary, recentCalls] = await Promise.all([
        database.health(), database.getOpsSummary(), database.getRecentCalls(50),
      ]);
      res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        database: dbHealth,
        adminUsername: req.opsSession.username,
        retentionDays: 7,
        ...summary,
        ...stateProvider(),
        recentCalls,
      });
    } catch (error) {
      console.error('Ops status failed:', error.message);
      res.status(503).json({ status: 'degraded', error: error.message });
    }
  });
  app.get('/ops/api/logs', requireOpsSession, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(1000, Number.parseInt(req.query.limit, 10) || 300));
      const level = ['log', 'warn', 'error'].includes(req.query.level) ? req.query.level : null;
      const persisted = await database.getSystemLogs(limit, level);
      res.json({ retentionDays: 7, logs: persisted.length ? persisted : logs.slice(-limit).reverse() });
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
  });
}

module.exports = { installLogCapture, connectLogPersistence, mountOps };
