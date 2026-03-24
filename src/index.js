require('dotenv').config();
const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------
initializeApp({
  credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

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
// POST /webhook  — receives ESL button events from AIMS and pushes to phones
//
// AIMS payload will vary by system. We try common field names and fall back
// to the full body as a JSON string so nothing is lost.
// ---------------------------------------------------------------------------
app.post('/webhook', validateAuth, async (req, res) => {
  try {
    const body = req.body ?? {};
    console.log('Webhook received:', JSON.stringify(body));

    // Extract human-readable info from whatever AIMS sends
    const label    = body.label    || body.buttonLabel || body.button_label || '';
    const location = body.location || body.shelf       || body.zone         || body.aisle || '';
    const message  = body.message  || body.description || '';

    const alertMessage =
      [label, location].filter(Boolean).join(' — ') ||
      message ||
      'Employee call — button pressed';

    // Send push notification to ALL phones subscribed to the "employee-calls" topic.
    // No device tokens to manage — phones subscribe when the app first opens.
    const fcmMessage = {
      topic: process.env.FCM_TOPIC || 'employee-calls',
      data: {
        title:   'Employee Call',
        message: alertMessage,
        payload: JSON.stringify(body),  // raw payload forwarded to the app
      },
      android: {
        priority: 'high',
        ttl: 60000, // 60 seconds — drop if phone doesn't receive within 1 min
      },
    };

    const result = await getMessaging().send(fcmMessage);
    console.log('FCM sent:', result);

    res.status(200).json({ status: 'ok', messageId: result });
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).json({ error: err.message });
  }
});

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
