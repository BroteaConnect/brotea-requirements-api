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

### Who may call the messaging routes

Two credentials, and they are not interchangeable.

| caller | credential |
| --- | --- |
| a browser (the CRM) | `Authorization: Bearer <PocketBase user token>` |
| a host process (`brotea-whatsapp`, `jobs/*.mjs`, the E5 gates) | `?secret=<OUTBOUND_SECRET>` |

A static app has no private storage: anything its bundle holds is published the
moment the bundle is served. `crm-inmobiliaria.brotea.dev` served the shared
secret inside its JS to anyone who asked, so the secret stopped being a
credential. The browser's credential is its own user's PocketBase token —
validated on every request against this chassis's `PB_URL` with
`POST /api/collections/<PB_AUTH_COLLECTION>/auth-refresh`, never cached, and
required to belong to a user whose `role` is one of `superadmin`, `admin`,
`member` (a users collection with no `role` field at all is accepted: that
project's model does not express staff). This is the contract in the platform's
`docs/social-factory-buildout.md` §4.4.

The secret is refused outright when the request could only have come from a
browser — `Origin`, `Referer`, `Sec-Fetch-Site`, `Sec-Fetch-Dest` or a
`Mozilla/` user agent. (`Sec-Fetch-Mode` is deliberately not on that list:
Node's own `fetch` sends `sec-fetch-mode: cors`, so counting it would lock out
every host caller.) This stops browsers, not attackers — a published secret is
only really retired by rotating it.

Refusals, each with its own `error.code` so a log can tell them apart:
`forbidden` (403, no credential), `invalid_token` (401, expired, malformed or
minted by another project's PocketBase), `not_staff` (403), `secret_from_browser`
(403), `auth_unavailable` (503, PocketBase did not answer — never an open door),
`auth_not_configured` (503). Every outcome leaves an events row: `chassis.refused
{route, code, status}` and, for an accepted token, `chassis.authorized {route,
via, user_id, role}`. Neither ever carries a token or the secret.

#### What the CRM must send

`src/crm/api.ts` today builds `?secret=${PUBLIC_OUTBOUND_SECRET}`. It becomes a
header and nothing else changes — same host, same paths, same bodies, same
`{ok:false, error:{code,text}}` failure shape:

```ts
const res = await fetch(`${CHASSIS_URL}${path}`, {   // no ?secret=
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${pbToken()}`,            // src/lib/pb.ts authStore token
  },
  body: JSON.stringify(body),
});
```

`enviarEmail` loses one field: `{lead_id, subject, text, from_name}` — drop
`to`, which is now ignored. `enviarPlantilla` and `sincronizarContent` keep
their bodies exactly. `PUBLIC_OUTBOUND_SECRET` then has no reader and must be
deleted from the build args, or the next bundle publishes it again.

A 401 `invalid_token` means the agent's session expired: sign in again and
retry, rather than surfacing it as a send failure.

`POST /twilio-status` and `POST /brevo-webhook` are **not** in this table.
A provider callback authenticates as the provider — Twilio's signature, Brevo's
query secret — and asking Twilio for a person's token is how a delivery state
stops being recorded.

### Messaging

- `POST /send-email` — two shapes, both naming a lead and **neither naming an
  address**: `{lead_id, subject, text, from_name?}` for free text the agent
  wrote, or `{lead_id, plantilla, variables?, from_name?}`, which
  resolves the subject and body from the
  `plantillas` row (`asunto_<idioma>` / `cuerpo_<idioma>`, `{{nombre}}` filled
  from the lead) and applies the [consent gate](#consent-gate) (422
  `no_consent` / `consent_revoked`). The signed links a subject or body uses —
  `{{baja_url}}` (opt-out) and `{{si_url}}` (opt-in, see `/si`) — are filled
  in by the chassis, which alone holds the secret: a caller never supplies
  them (and is never refused `variables_missing` for them), and a value it
  sends for one of those names is dropped before anything is rendered. A
  template that uses neither gets neither. Without `PUBLIC_URL` or a signing
  secret the links cannot be minted and the send is refused 400
  `variables_missing` naming them, never sent with a literal `{{si_url}}`.
  Neither link is ever stored: the `actividades` note and the `envios`
  variables keep `[baja_url]` / `[si_url]` in its place, because a signed
  link is a bearer credential and those rows are readable by every signed-in
  CRM user; only the email that leaves carries the real URL.

  ```bash
  curl -X POST "$API/send-email?secret=$OUTBOUND_SECRET" \
    -H 'Content-Type: application/json' \
    -d '{"lead_id":"<lead id>","plantilla":"consentimiento.solicitud.email",
         "variables":{"agencia":"Inmobiliaria Brotea","url":"https://inmobiliaria.brotea.dev"}}'
  # nombre, si_url and baja_url are filled by the chassis
  ```

  With a `lead_id` the opt-out footer (`/baja` link) is appended in the lead's
  language. Writes the `actividades` row and an `envios` row
  (`canal: email`, `mensaje_id` = our Message-ID, `estado: enviado`). Answers
  `{ok, message_id, activity_id, envio_id}`.

  **The recipient is never read from the request.** A `to` in the body is
  ignored; the address comes from the `leads` row named by `lead_id`, which is
  required (400 `lead_required` without it, 404 `lead_unknown` for a lead that
  is not there, 400 `no_email` for one with no usable address). The old
  arbitrary-`to` shape made this endpoint a mail relay over the agency's own
  SMTP identity, SPF and DKIM for whoever held the credential, and the
  credential was in a public bundle. Nothing on the host used that shape, so it
  is gone for every caller rather than kept for the trusted ones — the trust
  was the part that failed.
- `POST /brevo-webhook?secret=` — Brevo's delivery events. Updates the
  activity and the `envios` row by Message-ID under the never-backwards rule,
  stamps `entregado_en` / `abierto_en` / `click_en` / `error_en`, keeps the
  event name in `error_codigo` and Brevo's reason in `error_texto`. Opens are
  evidence when they arrive and nothing when they do not.
- `POST /send-whatsapp` — `{lead_id, plantilla?, variables?, text?,
  actividad_id?, campana_id?}`. The recipient is always the lead's own
  `telefono` (never a `to` from the request). A template goes through the same
  [consent gate](#consent-gate) as email (422 `no_consent` /
  `consent_revoked`, with the consent request exempt). Inside the 24-hour window (an
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
  in both languages. A bad token is a 403 page on either verb. The event is
  logged after the write; if the events table is down the opt-out still
  stands and the page still confirms it.
- `GET /si?lead=&t=` — the opt-in link the consent request carries as
  `{{si_url}}`, the mirror of `/baja` with its own token (`t` = HMAC-SHA256 of
  `si:<lead id>`, base64url, same secret as `/baja`, so neither token works on
  the other route). GET only shows a one-button page for the same reason —
  consent a mail scanner gave is not consent; `POST /si` (form-encoded, same
  `lead` and `t`) does the write:

  ```bash
  curl "$API/si?lead=<lead id>&t=<token>"                       # 200, the button
  curl -X POST "$API/si" -d 'lead=<lead id>' -d 't=<token>'     # 200, the write
  ```

  It sets `leads.consentimiento = true`, `consentimiento_en` = now and
  `consentimiento_texto` = the copy the page showed (`si_ask` + `si_confirm`
  in the lead's language) followed by `[clave vN]` — the clave and the
  version actually sent, read from the lead's latest `envios` row for the
  email consent request (just the copy when there is none), capped at 300
  characters. Then it logs `lead.consent_given {lead_id, via:'email'}`; the
  event is logged after the write and can never undo it. Idempotent: a lead
  already consenting is no write and no event, and still sees the
  confirmation. A lead who had opted out and then follows the link is
  honoured (the click is theirs and it is more recent), and the event
  carries `after_opt_out: true`. Responses are HTML pages with
  `Cache-Control: no-store`: 200 ask / done; 403 for a bad token (including a
  `/baja` token) or an unknown lead, the same page either way so the route
  never reveals which lead ids exist; 503 when PocketBase is not configured
  and 502 when it fails (POST only — a GET never touches PocketBase). The ask
  and invalid pages are bilingual; the confirmation is in the lead's
  language alone.

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
identical key sets; nothing user-facing is hardcoded in JS. A click tells
the chassis nothing about the reader's language, so the `/baja` pages and the
`/si` ask and invalid pages show both languages; the `/si` confirmation,
rendered after the write has read the lead, shows only `leads.idioma`.

## Consent gate

Only `categoria: marketing` templates are gated; a utility template (a visit
confirmation) goes to any lead, opted out or not. For marketing, `leads` has
three consent states, not two:

| Lead | Marketing template | Consent request |
|---|---|---|
| `consentimiento` true | sent | sent |
| false **with** a `consentimiento_en` date (opted out) | 422 `consent_revoked` | 422 `consent_revoked` |
| false, no date (never asked) | 422 `no_consent` | sent |

Only `/baja` and a WhatsApp BAJA write the false + date pair, so it is an
act, not a blank. The consent request is the one message whose purpose is to
ask, so it cannot require consent — without the exemption CU-15 would be
refused for every never-asked lead. It is exempt when the row has **both**
`evento = campana.consentimiento` **and** a clave starting with
`consentimiento.solicitud` (today `consentimiento.solicitud` on WhatsApp and
`consentimiento.solicitud.email`). Either field alone is editable by any
signed-in CRM user, so either alone would be a way to reach the never-asked
leads with an ordinary marketing template; any other marketing template is
still refused `no_consent`. The exemption never reaches a lead who said no.
`consentGate` in `src/consent.js` holds it; `/send-email` and
`/send-whatsapp` share the one function (on WhatsApp, outside the 24-hour
window the Content template must still be approved by Meta).

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
via:'email'}`, `lead.consent_given {lead_id, via:'email', after_opt_out?}`. Actor `twilio`: `whatsapp.status_received {mensaje_id, status,
result}` on every callback. Actor `brevo`: `email.event_received`. The historic
routes keep actor `requirements-api`. Payloads by the `chassis` and `twilio`
actors carry ids, never a phone, an email or a message body (the historic
`email.sent` / `email.event_received` rows still name the address, as they
did before).

## Env

`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PORT`,
`GLITCHTIP_WEBHOOK_SECRET`, `OUTBOUND_SECRET` (via Coolify — never committed;
it is a server-to-server credential and must never be built into an app bundle).
The CRM's PocketBase: `PB_URL`, `PB_ADMIN_EMAIL`, `PB_ADMIN_PASS`, `PB_PROJECT`
(default `inmobiliaria`). Browser auth: `PB_AUTH_COLLECTION` (default `users`,
the auth collection the app signs in against) and `PB_STAFF_ROLES` (default
`superadmin,admin,member`). Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `MAIL_FROM`. WhatsApp and Content: `PUBLIC_URL` (the exact
public origin, e.g. `https://api.brotea.dev` — it goes into every
`StatusCallback` and is what the callback signature is computed over),
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (with or
without the `whatsapp:` prefix; normalised). `PUBLIC_URL` is also the origin
of the `/baja` and `/si` links. Optional `BAJA_SECRET` signs both the opt-out
and the opt-in links (falls back to `OUTBOUND_SECRET`).

## Layout

`src/twilio.js` holds the pure request builders (`buildSendMessage`,
`buildCreateContent`, `buildApprovalRequest`, `buildListContentAndApprovals`),
the signature check copied verbatim from the platform's
`whatsapp/src/transports/twilio.js`, the status map and rank, and the thin
caller; its header records the provider references and the date they were
read. `src/auth.js` is the credential decision — token parsing, the browser test,
the staff test and one `authorize` — all pure but the one `fetch` that asks
PocketBase whether a token is live. `src/whatsapp.js` and `src/content.js` are the flows, `src/email.js` the
email relay and template resolution (`resolveTemplateEmail`),
`src/consent.js` the consent gate, the signed `/baja` and `/si` links and
their writes, `src/baja.js` the two pages, `src/templates.js` the placeholder
rules, `src/window.js` the 24-hour window. Tests run against fakes
(`tests/helpers/fake-pb.mjs`, `fake-pg.mjs`): `npm test`, no network.

Part of the [Brotea](https://github.com/BroteaConnect) platform.
