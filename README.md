# FitFlow Backend

Deno backend for FitFlow authentication and client progress tracking.

## Stack

- Deno (`main.ts`)
- Hono + Zod OpenAPI (route docs and typed contracts)
- Deno KV (magic links, users, rate limits)
- Postmark (magic link email delivery)
- Base44 entities (`Client`, `DailyCheckIn`, `ProgressLog`)
- JWT auth (`HS256`)

## Prerequisites

- Deno 1.40+ (with `openKv` support)
- Postmark server token
- Base44 app ID + API key

## Setup

1. Copy env template:
   ```bash
   cp .env.example .env
   ```
2. Fill all required variables in `.env`.
3. Start the server:
   ```bash
   deno task dev
   ```

Production start:

```bash
deno task start
```

Default port is `8787`.

## Environment Variables

Required:

- `POSTMARK_SERVER_TOKEN`
- `POSTMARK_FROM_EMAIL`
- `MAGIC_LINK_FALLBACK_BASE_URL`
- `JWT_SECRET`
- `BASE44_APP_ID`
- `BASE44_API_KEY`

Optional (with defaults):

- `PORT` (`8787`)
- `APP_NAME` (`CoachStack`)
- `MAGIC_LINK_SCHEME` (`coachstack`)
- `JWT_ISSUER` (`coachstack-gateway`)
- `JWT_AUDIENCE` (`coachstack-mobile`)
- `BASE44_CLIENT_ENTITY` (`Client`)
- `BASE44_PROGRESS_ENTITY` (`ProgressLog`)
- `BASE44_DAILY_ENTITY` (`DailyCheckIn`)
- `BASE44_SESSION_ENTITY` (`Session`)
- `BASE44_PROGRAM_ENTITY` (`Program`)
- `BASE44_EXERCISE_ENTITY` (`Exercise`)
- `DEV_TOKEN_SECRET` (enables `/dev/token` route)

## Auth Flow

1. `POST /auth/start` with email.
2. User receives magic link via Postmark.
3. App posts token to `POST /auth/verify`.
4. API returns `access_token` (JWT).
5. Use `Authorization: Bearer <token>` for protected endpoints.

## API Endpoints

Public:

- `GET /health`
- `GET /openapi.json`
- `GET /docs`
- `POST /auth/start`
- `POST /auth/verify`
- `GET /auth/callback`
- `POST /dev/token` (only if `DEV_TOKEN_SECRET` is set)

Protected:

- `GET /me`
- `GET /dashboard?days=14`
- `GET /daily-checkin/recent?days=14`
- `GET /progress-log/recent?days=14`
- `GET /session/recent?days=14`
- `GET /sessions?days=7`
- `POST /sessions` with body `{ "days": 7 }`
- `POST /daily-checkin`
- `POST /daily-checkin/sync`
- `POST /progress-log`
- `POST /progress-log/sync`
- `POST /session`
- `POST /session/sync`

`days` is clamped to `1..60`.

`POST /session/sync` behavior:
- If a session item includes `program_name`, the API loads that program, finds the `weekly_schedule` for the session `scheduled_date` weekday, and populates `exercise_logs` and `cardio_logs` from that day before upsert.

OpenAPI notes:
- `/openapi.json` is generated from code-first route definitions.
- `/docs` serves Swagger UI backed by that generated spec.

## Example Requests

Start auth:

```bash
curl -X POST http://localhost:8787/auth/start \
  -H "content-type: application/json" \
  -d '{"email":"user@example.com"}'
```

Verify token:

```bash
curl -X POST http://localhost:8787/auth/verify \
  -H "content-type: application/json" \
  -d '{"token":"ml_..."}'
```

Create daily check-in:

```bash
curl -X POST http://localhost:8787/daily-checkin \
  -H "content-type: application/json" \
  -H "authorization: Bearer <JWT>" \
  -d '{
    "log_date":"2026-02-20",
    "mood":7,
    "sleep_hours":7.5,
    "stress":4,
    "energy":8
  }'
```

## Data Notes

- Daily and progress entries are upserted as one record per `log_date` per `client_id`.
- Client resolution uses `Client.user_email` in Base44, so each user must have a matching client row.

## CORS

Responses include:

- `access-control-allow-origin: *`
- `access-control-allow-headers: content-type, authorization, x-dev-token-secret`
- `access-control-allow-methods: GET,POST,OPTIONS`

## Security

- Rotate any secrets that were ever committed or shared.
- Keep `DEV_TOKEN_SECRET` unset in production unless explicitly needed.
