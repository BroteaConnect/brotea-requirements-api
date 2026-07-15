# brotea-requirements-api

Tiny ingestion endpoint for Brotea landing-page requirement forms.

- `POST /requirements` — `{project, source, submitted_by, content}` →
  validates, inserts into the `requirements` table, logs a
  `requirement.received` event and notifies the project's Telegram topic.
  CORS open (public forms), 5 req/min per IP.
- `GET /health` — liveness.

Env: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PORT`
(via Coolify — never committed).

Part of the [Brotea](https://github.com/BroteaConnect) platform.
