require('dotenv').config();
const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// ---------------------------------------------------------------------------
// Firebase init
// Reads the entire service account JSON from one env var to avoid
// private key formatting issues when pasting into Railway variables.
// ---------------------------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Auth middleware — validates the key AIMS sends in the header
// Header name and value are configured via env vars so you can set anything
// ---------------------------------------------------------------------------
function validateAuth(req, res, next) {
  const headerName  = (process.env.AUTH_HEADER_NAME || 'x-auth-key').toLowerCase();
  const expectedKey = process.env.AUTH_KEY;

  if (!expectedKey) {
    // No key configured — warn but allow (useful during initial setup)
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

// ---------------------------------------------------------------------------
// Shared handler — processes AIMS payload and sends FCM push
// Mounted on both POST / and POST /webhook so it works regardless of
// how the URL is configured in AIMS.
// ---------------------------------------------------------------------------
async function handleWebhook(req, res) {
  try {
    const body = req.body ?? {};
    console.log('Webhook received:', JSON.stringify(body));

    // AIMS ESL payload fields
    const button     = body.button     || '';                          // e.g. "ALARM"
    const labelCode  = body.labelCode  || '';                          // e.g. "0F23D1AD669C"
    const articleIds = Array.isArray(body.articleIds)
      ? body.articleIds.join(', ')
      : (body.articleIds || '');                                       // e.g. "NP_KASHI"

    // Build a clear, readable alert message
    const parts = [button, articleIds, labelCode ? `[${labelCode}]` : ''];
    const alertMessage = parts.filter(Boolean).join(' — ') || 'Employee call — button pressed';

    const fcmMessage = {
      topic: process.env.FCM_TOPIC || 'employee-calls',
      data: {
        title:   'Employee Call',
        message: alertMessage,
        payload: JSON.stringify(body),
      },
      android: {
        priority: 'high',
        ttl: 60000,
      },
    };

    const result = await getMessaging().send(fcmMessage);
    console.log('FCM sent:', result);

    res.status(200).json({ status: 'ok', messageId: result });
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).json({ error: err.message });
  }
}

// Accept on both root and /webhook path
app.post('/',        validateAuth, handleWebhook);
app.post('/webhook', validateAuth, handleWebhook);

// ---------------------------------------------------------------------------
// GET /health — AIMS / Railway health checks hit this
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'running', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ESL Relay listening on port ${PORT}`);
});
