# brotea-requirements-api

Tiny ingestion endpoint for Brotea landing-page requirement forms.

- `POST /requirements` — `{project, source, submitted_by, content, lead_id?}` →
  validates, inserts into the `requirements` table, logs a
  `requirement.received` event and notifies the project's Telegram topic.
  CORS open (public forms), 5 req/min per IP.
  With `source: 'lead_web'` and a `lead_id` (the PocketBase `leads` record the
  form just created) it also assigns the lead: to the on-duty agent named in the
  `settings` row `agentes.guardia`, else to the oldest user; an owner already
  set is kept. Logged as `lead.assigned` / `lead.assign_failed`; a failed
  assignment never fails the form (still 201).
- `GET /health` — liveness.

Env: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PORT`
(via Coolify — never committed). Lead assignment and `/send-email` also need
the CRM's PocketBase: `PB_URL`, `PB_ADMIN_EMAIL`, `PB_ADMIN_PASS`, and
`PB_PROJECT` (the project slug that instance belongs to; default
`inmobiliaria`). Without them, or for another project, the lead is not
assigned and a `lead.assign_skipped` event says why.

Part of the [Brotea](https://github.com/BroteaConnect) platform.
