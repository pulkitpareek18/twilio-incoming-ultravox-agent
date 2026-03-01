# Twilio Incoming Ultravox Agent

Express-based voice agent backend that bridges incoming Twilio calls to Ultravox, stores call artifacts, and runs post-call risk analysis with optional Gemini augmentation.

## Core Capabilities

- Accepts inbound Twilio calls on `POST /incoming`
- Creates an Ultravox call and connects Twilio audio stream
- Ingests call completion/webhook events on `POST /ultravox/events`
- Fetches transcripts and recording metadata after call completion
- Runs keyword + pattern based risk scoring (Hindi/English/Hinglish)
- Optionally enriches analysis with Gemini
- Persists conversations in MongoDB with JSON-file fallback
- Exposes a monitoring dashboard and conversation detail pages

## API and UI Endpoints

- `POST /incoming`
- `POST /ultravox/events`
- `GET /health`
- `GET /dashboard`
- `GET /api/conversations`
- `POST /api/conversations/:id/refresh`
- `POST /api/conversations/:id/regenerate-analysis`
- `POST /api/conversations/refresh-all`
- `POST /api/conversations/import-from-ultravox`
- `POST /api/conversations/cleanup-invalid`
- `GET /conversations/:id`

## Tech Stack

- Node.js + Express
- Twilio Node SDK
- Ultravox API
- MongoDB (`mongodb` driver)
- Google Gemini (`@google/generative-ai`)

## Environment Variables

Create a `.env` file with the following:

Required:

- `ULTRAVOX_API_KEY`
- `BASE_URL` (public URL where this server is reachable)

Recommended:

- `MONGODB_URI`
- `MONGODB_DB`
- `MONGODB_COLLECTION`

Optional tuning:

- `PORT` (default `5000`)
- `ULTRAVOX_MODEL`
- `ULTRAVOX_VOICE_ID`
- `ULTRAVOX_TEMPERATURE`
- `FIRST_SPEAKER`
- `SYSTEM_PROMPT`
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)
- `GEMINI_MODEL`

## Local Run

```bash
npm install
npm start
```

Server defaults to `http://localhost:5000`.

## Twilio Setup

Point your Twilio phone number voice webhook to:

- `https://<your-public-url>/incoming` (HTTP `POST`)

If you use Twilio status callbacks, route them to:

- `https://<your-public-url>/ultravox/events`

## Notes

- If `MONGODB_URI` is not set, data is written to `data/conversations.json`.
- This service handles sensitive call data. Use secure secrets management, HTTPS-only ingress, and restricted dashboard access in production.
