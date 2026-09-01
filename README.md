# ESL Relay

Receives AIMS SaaS button-press webhooks and delivers employee-call alerts to
the Android devices registered to the affected store.

## Production flow

```text
AIMS SaaS -> HTTPS /webhook -> durable relay job -> PostgreSQL call
          -> Firebase direct device delivery -> first associate claims call
```

Each associate signs in with their own AIMS credentials. The relay validates
the credentials, discards the password, encrypts the returned access/refresh
tokens with AES-256-GCM, and issues an opaque device session. There is no shared
AIMS account and the webhook secret is never included in the Android APK.

## VM deployment

The production demo stack is defined by `docker-compose.vm.yml`:

- Shared app-launcher Nginx gateway on the existing host HTTPS port `443`.
- Node relay on a private Docker network.
- PostgreSQL 16 on the same private network with no published port.
- Named volumes for PostgreSQL and durable relay jobs/mappings.

Deploy committed source with:

```powershell
.\deploy-vm.ps1
```

The first deployment copies the existing Firebase and webhook settings from
the ignored local `.env`, generates database/encryption/dashboard secrets, and
stores them in `~/esl-relay/.env.vm` on the VM with mode `600`.

## AIMS webhook

| Field | Value |
|---|---|
| URL | `https://20.121.68.137/webhook` |
| Authentication Key Header | `x-auth-key` |
| Authentication Key Value | VM `AUTH_KEY` value |
| API Timeout | 10 seconds (30 seconds is also safe) |

Nginx allows `/webhook` only from `135.237.10.33` and `51.8.21.131`.
The endpoint responds `202 Accepted` after durably queueing the request.

## Employee Call Operation

Open `https://20.121.68.137/ops`. The dashboard has its own database-backed
admin login and displays service/database health, active sessions, registered
devices, queued jobs, recent calls, and redacted application logs. Logs shown
by the dashboard are retained in PostgreSQL for seven days.

## Android app

The Android client uses `https://20.121.68.137` by default. After login and
store selection it registers its exact FCM token with the relay. Calls are sent
only to devices registered to that company/store, and PostgreSQL atomically
ensures that only the first associate can claim a call.

## Local development

Copy `.env.example` to `.env`, provide a local PostgreSQL `DATABASE_URL`, and
run:

```bash
npm install
npm test
npm start
```
