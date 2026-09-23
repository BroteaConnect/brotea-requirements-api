# brotea-requirements-api

The chassis: the one public host of the fleet that holds credentials. It
ingests the landing forms, relays the CRM's outbound email and WhatsApp (the
browser never sees an SMTP password or a Twilio token), receives the
providers' delivery callbacks, and keeps the `envios` ledger in sync.

## Routes

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
- `GET /roadmap?project=`, `GET /garden`, `GET /assets/*` — public reads.
- `POST /glitchtip-webhook?project=&secret=` — error alerts to Telegram.

### Messaging (all gated by `?secret=OUTBOUND_SECRET`; 403 without it)

- `POST /send-email` — two shapes. Legacy `{to, subject, text, lead_id?,
  from_name?}`; or `{lead_id, plantilla, variables?, from_name?}`, which
  resolves the address from the lead, the subject and body from the
  `plantillas` row (`asunto_<idioma>` / `cuerpo_<idioma>`, `{{nombre}}` filled
  from the lead) and applies the consent gate below (422 `no_consent` /
  `consent_revoked`). The signed links a body declares — `{{baja_url}}`,
  `{{si_url}}` — are filled in by the chassis, which alone holds the secret:
  a caller never supplies them and can never substitute them. With a
  `lead_id` the opt-out footer (`/baja` link) is appended in the lead's
  language. Writes the `actividades` row and an `envios` row
  (`canal: email`, `mensaje_id` = our Message-ID, `estado: enviado`). Answers
  `{ok, message_id, activity_id, envio_id}`.
- `POST /brevo-webhook?secret=` — Brevo's delivery events. Updates the
  activity and the `envios` row by Message-ID under the never-backwards rule,
  stamps `entregado_en` / `abierto_en` / `click_en` / `error_en`, keeps the
  event name in `error_codigo` and Brevo's reason in `error_texto`. Opens are
  evidence when they arrive and nothing when they do not.
- `POST /send-whatsapp` — `{lead_id, plantilla?, variables?, text?,
  actividad_id?, campana_id?}`. The recipient is always the lead's own
  `telefono` (never a `to` from the request). Inside the 24-hour window (an
  inbound WhatsApp activity of the lead in the last 24 h) it sends the rendered
  body as free text (`via: free_text`); outside it, it needs an approved Twilio
  Content template in the lead's language and sends `ContentSid` +
  positional `ContentVariables` (`via: content`). Every send carries
  `StatusCallback = PUBLIC_URL/twilio-status`. Rows: `actividades`
  (`registrado` → `enviado`, unless `actividad_id` names the caller's own
  row, whose `nota` is never touched) and `envios` (`registrado` → `enviado`
  with `mensaje_id` = the Twilio SID, in the same PATCH). Answers 200
  `{ok, envio_id, actividad_id, mensaje_id, estado, via}`; 502 with the rows in
  `error` when Twilio refuses; 4xx `{ok:false, error:{code, text}}` with no
  rows for a refusal. 503 when `PUBLIC_URL` / `TWILIO_*` are not set.
- `POST /twilio-status` — Twilio's status callback, form-encoded. No secret:
  the `X-Twilio-Signature` over `PUBLIC_URL + '/twilio-status'` is the
  authentication (403 otherwise). After it the answer is always 200
  (`{ok:true, updated|skipped, …}`), because Twilio retries anything else.
- `POST /content/submit` — `{clave}`: creates the row's Twilio Content in each
  language not yet submitted (`friendly_name` =
  `<clave with dots → underscores>_<lang>_v<version>`, body with `{{1}}`…
  in the row's `variables` order, sample values from the locales) and
  requests WhatsApp approval with the row's `categoria` (`UTILITY` |
  `MARKETING` — never marketing for a transactional text). Answers `{ok, clave,
  content_sid, content_sid_en, content_estado, content_estado_en}` or
  `{ok:false, error:{code, class, text}}` with class `provider_auth`,
  `sender_not_ready`, `template_invalid`, `already_submitted` (409) or
  `provider_unavailable`.
  A resubmission after Meta judged a template (`rejected`, `paused`,
  `disabled`) is refused with class `version_unchanged` (409) until the
  row's `version` moves past the one in the existing Content's name; a
  Content whose approval request failed is reused, not recreated.
- `POST /content/sync` — `{clave?}`: reads every submitted row's approval
  state back from `ContentAndApprovals`, PATCHes only what changed (state and
  `content_motivo` from Meta's `rejection_reason`) and answers
  `{ok, updated:[{clave, content_estado, content_estado_en, …}], checked}`.
- `GET /baja?lead=&t=` — the opt-out link from the email footer (`t` =
  HMAC-SHA256 of the lead id). GET only shows a one-button page (mail
  scanners follow every link; a scanner must never opt a lead out);
  `POST /baja` with the same `lead` and `t` does the write: sets
  `leads.consentimiento = false` with the date and the text, logs
  `lead.consent_revoked {lead_id, via:'email'}`, and shows the confirmation
  in both languages. A bad token is a 403 page on either verb.
- `GET /si?lead=&t=` — the opt-in link of the consent campaign, the mirror of
  `/baja` with its own token (HMAC-SHA256 of `si:<lead id>`, so neither token
  works on the other route). GET only shows a one-button page for the same
  reason — consent a mail scanner gave is not consent; `POST /si` sets
  `leads.consentimiento = true` with the date and the copy that was shown,
  logs `lead.consent_given {lead_id, via:'email'}` and confirms in the lead's
  language. Idempotent: a lead already consenting is no write and no event.
  A lead who had opted out and then follows the link is honoured (the click
  is theirs and it is more recent), and the event carries `after_opt_out`.

## Language convention

`plantillas` rows are bilingual: `asunto_es` / `cuerpo_es` and `asunto_en` /
`cuerpo_en`, placeholders `{{name}}` with the names listed, in positional
order, in `variables`. Twilio Content is single-language, so one row carries
two Content sids: the Spanish one in `content_sid` / `content_estado` /
`content_motivo`, the English one in `content_sid_en` / `content_estado_en` /
`content_motivo_en`. A send picks the pair by `leads.idioma` and never
switches language silently: an English lead whose English Content is not
approved gets a 422 `template_not_approved`, not the Spanish template.

The chassis's own copy (the `/baja` and `/si` pages, the footer, the refusal
and error sentences) lives in `src/locales/es.json` and `en.json` with
identical key sets; nothing user-facing is hardcoded in JS.

## Consent gate

`leads` has three consent states, not two, and marketing reads all three:
`consentimiento` true sends; false **with** a `consentimiento_en` date is an
opt-out (only `/baja` and a WhatsApp BAJA write that pair) and refuses with
`consent_revoked`; false with no date is a lead nobody ever asked and refuses
with `no_consent` — except for the consent request itself, the one message
whose purpose is to ask. That exemption is keyed on the template's own
`plantillas.evento` (`campana.consentimiento`), so it covers
`consentimiento.solicitud` / `consentimiento.solicitud.email` and nothing
else, and it never reaches a lead who said no. `src/consent.js` holds it;
the email and WhatsApp paths share the one function.

## Status taxonomy

`envios.estado` and `actividades.estado_envio` share one vocabulary:
`registrado → enviado → entregado → abierto → click`, plus `error` and the
terminal `simulado`. A state never goes backwards (rank `registrado 0,
enviado 1, entregado 2, abierto 3, click 4, error 5`); a re-posted status is
skipped. Twilio maps `queued|sending → registrado`, `sent → enviado`,
`delivered → entregado`, `read → abierto`, `failed|undelivered → error`. On
`error`, `error_codigo` keeps the provider's code verbatim (`63016`, `63024`,
`hard_bounce`…) and `error_texto` a plain sentence (ours for the known
codes, the provider's with phones masked otherwise).

Refusal codes on a 4xx: `no_phone`, `no_consent`, `consent_revoked`, `outside_window`,
`template_not_approved` (422); `template_unknown`, `lead_unknown` (404);
`template_channel`, `variables_missing`, `text_too_long`, `template_required`,
`lead_required`, `actividad_invalid` (400). `provider_unavailable` (timeout
or 5xx) and `ledger_unavailable` (PocketBase failed before the send; nothing
left) are 502. Once Twilio has returned a SID the answer is 200 whatever the
ledger or the events table say (`recorded: false` when the rows lag).

## Events

Actor `chassis`: `whatsapp.sent {lead_id, envio_id, plantilla, via, mensaje_id}`,
`whatsapp.send_failed {…, code}`, `whatsapp.refused {lead_id, plantilla, code}`,
`whatsapp.sent_unrecorded`, `content.submitted`, `content.submit_failed`,
`content.synced`, `content.sync_failed`, `lead.consent_revoked {lead_id,
via:'email'}`. Actor `twilio`: `whatsapp.status_received {mensaje_id, status,
result}` on every callback. Actor `brevo`: `email.event_received`. The historic
routes keep actor `requirements-api`. Payloads by the `chassis` and `twilio`
actors carry ids, never a phone, an email or a message body (the historic
`email.sent` / `email.event_received` rows still name the address, as they
did before).

## Env

`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PORT`,
`GLITCHTIP_WEBHOOK_SECRET`, `OUTBOUND_SECRET` (via Coolify — never committed).
The CRM's PocketBase: `PB_URL`, `PB_ADMIN_EMAIL`, `PB_ADMIN_PASS`, `PB_PROJECT`
(default `inmobiliaria`). Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `MAIL_FROM`. WhatsApp and Content: `PUBLIC_URL` (the exact
public origin, e.g. `https://api.brotea.dev` — it goes into every
`StatusCallback` and is what the callback signature is computed over),
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (with or
without the `whatsapp:` prefix; normalised). Optional `BAJA_SECRET` signs the
opt-out links (falls back to `OUTBOUND_SECRET`).

## Layout

`src/twilio.js` holds the pure request builders (`buildSendMessage`,
`buildCreateContent`, `buildApprovalRequest`, `buildListContentAndApprovals`),
the signature check copied verbatim from the platform's
`whatsapp/src/transports/twilio.js`, the status map and rank, and the thin
caller; its header records the provider references and the date they were
read. `src/whatsapp.js` and `src/content.js` are the flows, `src/email.js` the
email relay, `src/consent.js` the opt-out, `src/templates.js` the placeholder
rules, `src/window.js` the 24-hour window. Tests run against fakes
(`tests/helpers/fake-pb.mjs`, `fake-pg.mjs`): `npm test`, no network.

Part of the [Brotea](https://github.com/BroteaConnect) platform.
