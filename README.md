# ESL Relay

Receives webhook events from the AIMS ESL SaaS system and pushes real-time
alerts to Android phones via Firebase Cloud Messaging (FCM).

## Flow

```
AIMS SaaS  →  POST /webhook  →  esl-relay  →  FCM topic  →  Android phones
```

## Setup

### 1. Firebase service account

1. Go to [Firebase Console](https://console.firebase.google.com) → your project
2. Project Settings → Service Accounts → **Generate new private key**
3. Copy `project_id`, `client_email`, and `private_key` into your env vars

### 2. Environment variables

Copy `.env.example` to `.env` and fill in the values.

On Railway, set these under **Variables** in the project dashboard.

For reliable unattended operation, set `ESL_USERNAME` and `ESL_PASSWORD` as
Railway variables. This lets the relay obtain a fresh Solum token after a
restart or after the persisted refresh token expires. The password is retained
only in the Railway environment and is never written to the relay data files.

Mount a Railway Volume at `/app/data` and set `DATA_DIR=/app/data`. The relay
stores refresh tokens, per-store field mappings, and analytics there; without a
volume those files are lost during a redeploy.

Operational timing is configurable with `ESL_REQUEST_TIMEOUT_MS`,
`TOKEN_REFRESH_BUFFER_SECONDS`, `ARTICLE_LOOKUP_TIMEOUT_MS`,
`ARTICLE_CACHE_TTL_SECONDS`, and `ACKNOWLEDGE_TTL_SECONDS`. See
`.env.example` for defaults.

Webhook processing, acknowledgement deduplication, and scheduled ESL page
reverts are persisted under `DATA_DIR` and automatically resumed after a
restart. Run only one relay instance when using this file-backed queue; use a
shared database/queue before scaling Railway to multiple replicas.

### 3. Configure AIMS

| Field | Value |
|---|---|
| Webhook URL | `https://your-app.railway.app/webhook` |
| Auth header name | value of `AUTH_HEADER_NAME` (e.g. `x-auth-key`) |
| Auth header value | value of `AUTH_KEY` |

### 4. Android app

Open the `ESLCallApp` Android project in Android Studio.
The app subscribes to the selected store's `employee-calls` FCM topic.
Signing out of one phone is device-local and does not terminate the relay's
shared Solum session for other phones.

## Local dev

```bash
npm install
cp .env.example .env   # fill in values
npm run dev
```

Test locally with curl:
```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "x-auth-key: your-secret" \
  -d '{"label": "Shelf A3", "location": "Aisle 2"}'
```
