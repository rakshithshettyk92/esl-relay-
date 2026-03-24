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

### 3. Configure AIMS

| Field | Value |
|---|---|
| Webhook URL | `https://your-app.railway.app/webhook` |
| Auth header name | value of `AUTH_HEADER_NAME` (e.g. `x-auth-key`) |
| Auth header value | value of `AUTH_KEY` |

### 4. Android app

Open the `ESLCallApp` Android project in Android Studio.
The app subscribes to the `employee-calls` FCM topic on first launch —
no extra config needed.

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
