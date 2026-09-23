import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { sendTrackedEmail, applyBrevoEvent, emailConfigured, pbConfigured, pb, resolveLeadEmail, resolveTemplateEmail } from './email.js';
import { assignWebLead } from './assign.js';
import { t } from './copy.js';
import { twilioCaller, validSignature, whatsappAddress } from './twilio.js';
import { applyTwilioStatus, sendWhatsapp } from './whatsapp.js';
import { submitContent, syncContent } from './content.js';
import { bajaUrl, grantByEmail, revokeByEmail, validBajaToken, validSiToken } from './consent.js';
import { bajaPage, siPage } from './baja.js';
import { STAFF_ROLES, authorize, verifyUserToken } from './auth.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const PORT = Number(process.env.PORT ?? 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY = 64 * 1024;

// Naive per-IP rate limit: 5 submissions per minute.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) hits.clear(); // crude memory bound
  return list.length > 5;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // The CRM now authenticates with its user's PocketBase token, so the
    // preflight must allow the header that carries it.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function sendToProjectTopic(projectId, text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const { rows } = await pool.query(
    'SELECT topic_id FROM topics WHERE project_id = $1',
    [projectId],
  );
  if (!rows[0]) return;
  const params = new URLSearchParams({
    chat_id: CHAT_ID,
    message_thread_id: String(rows[0].topic_id),
    text,
  });
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?${params}`);
}

/** An events writer for one actor. The historic routes log as requirements-api; the messaging ones as chassis / twilio. */
const logAs = (actor) => (type, payload) => pool.query(
  'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
  [actor, type, payload],
);
const logEvent = logAs('requirements-api');
const logChassis = logAs('chassis');
const logTwilio = logAs('twilio');

// -- messaging configuration -----------------------------------------------------
// PUBLIC_URL is the exact origin Twilio calls back on: it goes into every
// StatusCallback and is the URL the callback's signature is computed over.
// The sender is normalised so `From` is `whatsapp:+…` whether or not the env
// carries the prefix.
const PUBLIC_URL = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM ? whatsappAddress(process.env.TWILIO_WHATSAPP_FROM) : null;
const whatsappConfigured = () => !!(PUBLIC_URL && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM);
const contentConfigured = () => !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
let twilioCall;
const twilio = (req) => (twilioCall ??= twilioCaller({ accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN }))(req);
/** The opt-out link is signed with its own secret when one is set; the shared outbound secret otherwise. */
const bajaSecret = () => process.env.BAJA_SECRET || process.env.OUTBOUND_SECRET || null;

function notifyTopic(projectId, projectName, content, submittedBy) {
  const excerpt = content.length > 300 ? `${content.slice(0, 300)}…` : content;
  return sendToProjectTopic(
    projectId,
    `📥 Nuevo requisito para ${projectName} (de ${submittedBy}):\n"${excerpt}"`,
  );
}

async function handleSubmission(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
  if (rateLimited(ip)) return send(res, 429, { error: 'too many requests' });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return send(res, 413, { error: 'body too large' });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'invalid JSON' });
  }

  const project = String(data.project ?? '');
  const content = String(data.content ?? '').trim();
  const submittedBy = String(data.submitted_by ?? '').trim().slice(0, 300) || null;
  const source = String(data.source ?? 'landing_form').slice(0, 50);
  if (!SLUG_RE.test(project)) return send(res, 400, { error: 'invalid project' });
  if (!content || content.length > 4000) return send(res, 400, { error: 'content required (max 4000 chars)' });

  const { rows } = await pool.query(
    'SELECT id, name FROM projects WHERE slug = $1',
    [project],
  );
  if (!rows[0]) return send(res, 404, { error: 'unknown project' });

  const ins = await pool.query(
    `INSERT INTO requirements (project_id, content, source, submitted_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [rows[0].id, content, source, submittedBy],
  );
  await pool.query(
    'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
    ['requirements-api', 'requirement.received',
     { requirement_id: ins.rows[0].id, project, source, submitted_by: submittedBy }],
  );
  notifyTopic(rows[0].id, rows[0].name, content, submittedBy ?? 'anónimo')
    .catch((e) => console.error('notify failed:', e.message));

  // A web lead gets an owner right away (see assign.js). It never fails the
  // form: the requirement is already stored and the outcome is an events row.
  if (source === 'lead_web') {
    await assignWebLead({ leadId: data.lead_id, project, logEvent })
      .catch((e) => console.error('lead assign crashed:', e.message));
  }

  return send(res, 201, { ok: true, id: ins.rows[0].id });
}

// GlitchTip alert webhook → the project's Telegram topic. GlitchTip has no
// Telegram integration, so each project's alert rule points its webhook
// recipient here with ?project=<slug>&secret=<shared>. The secret gates the
// endpoint (it is public otherwise) and lives in GLITCHTIP_WEBHOOK_SECRET.
const GT_WEBHOOK_SECRET = process.env.GLITCHTIP_WEBHOOK_SECRET;

async function handleGlitchtipAlert(req, res, url) {
  if (!GT_WEBHOOK_SECRET) return send(res, 503, { error: 'webhook not configured' });
  if (url.searchParams.get('secret') !== GT_WEBHOOK_SECRET) return send(res, 403, { error: 'forbidden' });
  const project = url.searchParams.get('project') ?? '';
  if (!SLUG_RE.test(project)) return send(res, 400, { error: 'invalid project' });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return send(res, 413, { error: 'body too large' });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'invalid JSON' });
  }

  // GlitchTip posts a Slack-shaped payload; extract best-effort.
  const att = (Array.isArray(data.attachments) && data.attachments[0]) || {};
  const title = String(att.title || data.text || 'error').slice(0, 300);
  const link = typeof att.title_link === 'string' ? att.title_link.slice(0, 500) : '';

  const { rows } = await pool.query('SELECT id, name FROM projects WHERE slug = $1', [project]);
  if (!rows[0]) return send(res, 404, { error: 'unknown project' });

  await pool.query(
    'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
    ['requirements-api', 'error.alerted', { project, title }],
  );
  sendToProjectTopic(
    rows[0].id,
    `🐞 Error en producción — ${rows[0].name}\n"${title}"${link ? `\n${link}` : ''}`,
  ).catch((e) => console.error('notify failed:', e.message));

  return send(res, 200, { ok: true });
}

// Outbound email for CRMs: the browser must never hold SMTP credentials, so
// it asks the chassis to send instead. Delivery tracking arrives later via
// /brevo-webhook and lands on the same activity record.
const OUTBOUND_SECRET = process.env.OUTBOUND_SECRET;

// -- who may call the endpoints a browser calls ----------------------------------
// Two credentials, never interchangeable (src/auth.js says why at length): the
// CRM sends `Authorization: Bearer <PocketBase user token>`, the host processes
// keep `?secret=`. /twilio-status and /brevo-webhook are NOT gated here on
// purpose — a provider callback authenticates as the provider, and asking Twilio
// for a person's token is how a delivery state stops being recorded.
const PB_AUTH_COLLECTION = process.env.PB_AUTH_COLLECTION || 'users';
const configuredRoles = String(process.env.PB_STAFF_ROLES || '').split(',').map((r) => r.trim()).filter(Boolean);
const staffRoles = configuredRoles.length ? configuredRoles : STAFF_ROLES;

/** An events write that can never turn a refusal into a 500. */
const safeLog = (type, payload) =>
  Promise.resolve().then(() => logChassis(type, payload)).catch((e) => console.error(`event ${type} not logged:`, e.message));

/**
 * The caller behind one request, or null once the refusal has been answered.
 *
 * Every outcome leaves an events row carrying ids and codes only — never a
 * token, never the secret, never an address. `secret_from_browser` is the one
 * this gate exists to make visible: it is a bundle leaking a credential, and it
 * should be readable in `events` the day it happens rather than the day
 * somebody fetches the bundle.
 */
async function caller(req, res, url, route) {
  const decision = await authorize(
    { headers: req.headers, secretParam: url.searchParams.get('secret') },
    {
      secret: OUTBOUND_SECRET ?? null,
      pbConfigured: pbConfigured(),
      verify: (token) => verifyUserToken(token, {
        pbUrl: process.env.PB_URL, collection: PB_AUTH_COLLECTION, roles: staffRoles,
      }),
    },
  );
  if (decision.ok) {
    if (decision.via === 'user') {
      safeLog('chassis.authorized', { route, via: 'user', user_id: decision.user.id, role: decision.user.role });
    }
    return decision;
  }
  safeLog('chassis.refused', { route, code: decision.code, status: decision.status });
  send(res, decision.status, { ok: false, error: { code: decision.code, text: t('es', `refusal.${decision.code}`) } });
  return null;
}

async function readJson(req, res, { optional = false } = {}) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) { send(res, 413, { error: 'body too large' }); return null; }
  }
  if (optional && raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    send(res, 400, { error: 'invalid JSON' });
    return null;
  }
}

/** A form-encoded body (Twilio's callbacks) as a plain object, capped like the JSON bodies. */
async function readForm(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) { send(res, 413, { error: 'body too large' }); return null; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const refusal = (res, status, code, vars) => send(res, status, { ok: false, error: { code, text: t('es', `refusal.${code}`, vars) } });

/**
 * Two shapes, both naming a lead and neither naming an address:
 * {lead_id, subject, text} for free text the agent wrote, and
 * {lead_id, plantilla, variables}, which resolves subject and body from the
 * `plantillas` row in the lead's language. Both may carry from_name.
 *
 * `to` is no longer part of either. It used to be, and an arbitrary recipient
 * plus a credential that shipped inside a public JS bundle is an open mail
 * relay over the agency's own SMTP identity, SPF and DKIM. Nothing on the host
 * ever used that shape (checked: only the E5 gate, which posts `{}` and asserts
 * a 403), so it is gone for every caller rather than kept for one — a relay
 * that only trusted callers may use is still a relay, and the trust was the
 * part that failed.
 */
async function handleSendEmail(req, res, url) {
  const who = await caller(req, res, url, '/send-email');
  if (!who) return undefined;

  const data = await readJson(req, res);
  if (!data) return undefined;
  const leadId = data.lead_id ? String(data.lead_id) : null;
  const clave = data.plantilla ? String(data.plantilla).trim() : '';
  const fromName = data.from_name ? String(data.from_name).slice(0, 100) : null;
  let to = '';
  let subject = String(data.subject ?? '').trim();
  let text = String(data.text ?? '').trim();
  let plantilla = null; let values = null; let idioma = 'es';

  if (!leadId) return refusal(res, 400, 'lead_required');
  if (!pbConfigured()) return send(res, 503, { error: 'pocketbase not configured' });

  if (clave) {
    const resolved = await resolveTemplateEmail(
      { leadId, clave, given: data.variables },
      { pb, publicUrl: PUBLIC_URL, secret: bajaSecret() },
    );
    if (resolved.code) return refusal(res, resolved.status, resolved.code, resolved.vars);
    ({ to, subject, text, idioma, values } = resolved);
    plantilla = resolved.plantilla;
  } else {
    const resolved = await resolveLeadEmail(leadId, { pb });
    if (resolved.code) return refusal(res, resolved.status, resolved.code, resolved.vars);
    ({ to, idioma } = resolved);
  }
  if (!EMAIL_RE.test(to)) return refusal(res, 400, 'no_email');
  if (!subject || !text) return send(res, 400, { error: 'subject and text required' });
  // Configuration is checked after validation: a malformed request is a 400
  // even when the relay is not mounted.
  if (!emailConfigured()) return send(res, 503, { error: 'smtp not configured' });

  try {
    const out = await sendTrackedEmail({
      to, subject, text, leadId, fromName, idioma,
      plantilla: plantilla?.id ?? null, plantillaVersion: plantilla?.version ?? null, variables: values,
      bajaUrl: leadId && PUBLIC_URL && bajaSecret() ? bajaUrl(PUBLIC_URL, leadId, bajaSecret()) : null,
    });
    await logEvent('email.sent', { to, subject, lead_id: leadId, envio_id: out.envio_id, plantilla: clave || null });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('send-email failed:', e.message);
    return send(res, 502, { error: 'send failed', detail: e.message.slice(0, 200) });
  }
}

// -- WhatsApp through Twilio ------------------------------------------------------
// The browser never holds the Twilio credentials: the CRM (and the WhatsApp
// service) post here with the shared secret, and the chassis only ever sends
// to the phone on the `leads` row named — never to a `to` from the request.
async function handleSendWhatsapp(req, res, url) {
  const who = await caller(req, res, url, '/send-whatsapp');
  if (!who) return undefined;
  const data = await readJson(req, res);
  if (!data) return undefined;
  if (!whatsappConfigured() || !pbConfigured()) return send(res, 503, { error: 'not configured' });
  const out = await sendWhatsapp(data, {
    pb, twilio, logEvent: logChassis, publicUrl: PUBLIC_URL, from: TWILIO_WHATSAPP_FROM, accountSid: TWILIO_ACCOUNT_SID,
  });
  return send(res, out.status, out.body);
}

// Twilio's status callback. No secret in the URL: the signature over the
// exact public URL is the authentication, and after it the answer is always
// 200 (Twilio retries anything else). Every call leaves an events row.
async function handleTwilioStatus(req, res) {
  if (!TWILIO_AUTH_TOKEN || !PUBLIC_URL) return send(res, 503, { error: 'not configured' });
  const form = await readForm(req, res);
  if (!form) return undefined;
  if (!validSignature(TWILIO_AUTH_TOKEN, `${PUBLIC_URL}${req.url}`, form, req.headers['x-twilio-signature'])) {
    return send(res, 403, { error: 'forbidden' });
  }
  let result;
  try {
    result = pbConfigured() ? await applyTwilioStatus(form, { pb }) : { skipped: true, reason: 'pb not configured' };
  } catch (e) {
    console.error('twilio status failed:', e.message);
    result = { skipped: true, reason: 'ledger unavailable', error: e.message.slice(0, 200) };
  }
  logTwilio('whatsapp.status_received', { mensaje_id: form.MessageSid ?? null, status: form.MessageStatus ?? null, result })
    .catch((e) => console.error('event log failed:', e.message));
  return send(res, 200, { ok: true, ...result });
}

// Twilio Content: submit a `plantillas` row for WhatsApp approval, and read
// the approval state of every submitted row back.
async function handleContent(req, res, url, action) {
  const who = await caller(req, res, url, `/content/${action}`);
  if (!who) return undefined;
  // The body is optional on both: /content/sync without one syncs every row.
  const data = await readJson(req, res, { optional: true });
  if (!data) return undefined;
  if (!contentConfigured() || !pbConfigured()) return send(res, 503, { error: 'not configured' });
  const clave = data.clave ? String(data.clave).trim() : '';
  if (action === 'submit' && !clave) return send(res, 400, { ok: false, error: { code: 'clave_required' } });
  const out = action === 'submit'
    ? await submitContent({ clave }, { pb, twilio, logEvent: logChassis })
    : await syncContent({ clave: clave || undefined }, { pb, twilio, logEvent: logChassis });
  return send(res, out.status, out.body);
}

// The opt-out link from an email footer. A page, not JSON: a person clicks
// it. GET only shows the button — mail scanners follow every link in an
// email, and a scanner must never opt a lead out — and POST does the write.
// Both carry the same signed token.
async function handleBaja(req, res, url) {
  const page = (status, result, form) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(bajaPage(result, form));
  };
  let leadId; let token;
  if (req.method === 'GET') {
    leadId = url.searchParams.get('lead') ?? '';
    token = url.searchParams.get('t') ?? '';
  } else {
    const form = await readForm(req, res);
    if (!form) return undefined;
    leadId = form.lead ?? '';
    token = form.t ?? '';
  }
  if (!bajaSecret() || !validBajaToken(leadId, token, bajaSecret())) return page(403, 'invalid');
  if (req.method === 'GET') return page(200, 'ask', { lead: leadId, t: token });
  if (!pbConfigured()) return page(503, 'invalid');
  try {
    await revokeByEmail(leadId, { pb, logEvent: logChassis });
  } catch (e) {
    console.error('baja failed:', e.message);
    return page(e.status === 404 ? 403 : 502, 'invalid');
  }
  return page(200, 'done');
}

// The opt-in link of the consent campaign (CU-15), the mirror of /baja and
// gated the same way: a GET only shows the button, a POST does the write.
// The reason is the same one in reverse — a mail scanner follows every link in
// an email, and consent that a scanner gave is not consent. The confirmation
// is rendered in the lead's own language, and the write is what tells us
// which one that is.
async function handleSi(req, res, url) {
  const page = (status, result, options) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(siPage(result, options));
  };
  let leadId; let token;
  if (req.method === 'GET') {
    leadId = url.searchParams.get('lead') ?? '';
    token = url.searchParams.get('t') ?? '';
  } else {
    const form = await readForm(req, res);
    if (!form) return undefined;
    leadId = form.lead ?? '';
    token = form.t ?? '';
  }
  // The same page whether the token is wrong or the lead does not exist: this
  // endpoint never tells a stranger which lead ids are real.
  if (!bajaSecret() || !validSiToken(leadId, token, bajaSecret())) return page(403, 'invalid');
  if (req.method === 'GET') return page(200, 'ask', { form: { lead: leadId, t: token } });
  if (!pbConfigured()) return page(503, 'invalid');
  let out;
  try {
    out = await grantByEmail(leadId, { pb, logEvent: logChassis });
  } catch (e) {
    console.error('si failed:', e.message);
    return page(e.status === 404 ? 403 : 502, 'invalid');
  }
  return page(200, 'done', { idioma: out.idioma });
}

// Brevo delivery events (delivered / opened / click / bounce…). Brevo cannot
// send custom headers, so the shared secret travels in the query string.
async function handleBrevoWebhook(req, res, url) {
  if (!OUTBOUND_SECRET) return send(res, 503, { error: 'not configured' });
  if (url.searchParams.get('secret') !== OUTBOUND_SECRET) return send(res, 403, { error: 'forbidden' });
  const data = await readJson(req, res);
  if (!data) return undefined;
  let result;
  try {
    result = await applyBrevoEvent(data);
  } catch (e) {
    console.error('brevo webhook failed:', e.message);
    result = { error: e.message.slice(0, 200) };
  }
  // Toda llamada entrante deja rastro: sin esto es imposible distinguir
  // "el proveedor no llama" de "llama y no encaja" (nos costó una tarde).
  pool.query(
    'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
    ['brevo', 'email.event_received', {
      event: data.event ?? null,
      message_id: data['message-id'] ?? null,
      email: data.email ?? null,
      result,
    }],
  ).catch((e) => console.error('event log failed:', e.message));
  return send(res, 200, { ok: !result.error, ...result }); // 200 siempre: sin reintentos infinitos
}

// Public read-only roadmap. Status derives from the linked feature when one
// exists, so the roadmap can never drift from the real lifecycle.
async function handleRoadmap(req, res, url) {
  const project = url.searchParams.get('project') ?? '';
  if (!SLUG_RE.test(project)) return send(res, 400, { error: 'invalid project' });

  const { rows } = await pool.query(
    'SELECT id, name FROM projects WHERE slug = $1',
    [project],
  );
  if (!rows[0]) return send(res, 404, { error: 'unknown project' });

  const items = await pool.query(
    `SELECT r.id, r.title, r.description, r.shipped_at,
            CASE
              WHEN f.status IN ('implementing', 'in_review') THEN 'in_progress'
              WHEN f.status = 'deployed' THEN 'shipped'
              ELSE r.status::text
            END AS status
     FROM roadmap_items r
     LEFT JOIN features f ON f.id = r.feature_id
     WHERE r.project_id = $1
       AND r.is_public
       AND (f.status IS NULL OR f.status <> 'rejected')
     ORDER BY r.sort_order, r.id`,
    [rows[0].id],
  );

  return send(res, 200,
    { project: { slug: project, name: rows[0].name }, items: items.rows },
    { 'Cache-Control': 'public, max-age=60' });
}

// Public read-only snapshot for the App Madre (arbol-madre): every project
// with its creator, production URL and Telegram topic link, plus the recent
// factory events the tree animates as sap pulses.
const GARDEN_EVENTS = [
  'project.created', 'feature.proposed', 'feature.analyzed', 'feature.approved',
  'feature.implementation_started', 'feature.pr_opened', 'deployment.completed',
  'docs.updated',
];

function topicUrl(topicId) {
  if (!CHAT_ID || topicId == null) return null;
  const short = String(CHAT_ID).replace(/^-100/, '');
  return `https://t.me/c/${short}/${topicId}`;
}

async function handleGarden(req, res) {
  const projects = await pool.query(
    `SELECT p.slug, p.name, p.status, p.repo_url, p.created_at,
            u.username AS creator, u.display_name AS creator_name,
            t.topic_id,
            (SELECT d.url FROM deployments d
              WHERE d.project_id = p.id AND d.env = 'production'
                AND d.status = 'succeeded' AND d.url IS NOT NULL
              ORDER BY d.id DESC LIMIT 1) AS url,
            (SELECT count(*)::int FROM features f
              WHERE f.project_id = p.id
                AND f.status NOT IN ('deployed','rejected')) AS open_features,
            (SELECT count(*)::int FROM features f
              WHERE f.project_id = p.id AND f.status = 'deployed') AS deployed_features
       FROM projects p
       LEFT JOIN LATERAL (
         SELECT e.payload->>'ordered_by' AS tid FROM events e
          WHERE e.event_type IN ('order.new_project', 'project.created')
            AND e.payload->>'slug' = p.slug
          ORDER BY e.id LIMIT 1
       ) o ON true
       LEFT JOIN users u ON u.telegram_id::text = o.tid
       LEFT JOIN topics t ON t.project_id = p.id
      ORDER BY p.created_at`,
  );
  const events = await pool.query(
    `SELECT id, event_type,
            COALESCE(payload->>'project', payload->>'slug') AS project,
            created_at
       FROM events
      WHERE event_type = ANY($1)
      ORDER BY id DESC LIMIT 40`,
    [GARDEN_EVENTS],
  );
  return send(res, 200, {
    generated_at: new Date().toISOString(),
    projects: projects.rows.map(({ topic_id, ...p }) => ({ ...p, topic_url: topicUrl(topic_id) })),
    events: events.rows,
  }, { 'Cache-Control': 'public, max-age=10' });
}

// -- assets ------------------------------------------------------------------
// The brand images the transactional emails point at. An inbox has no base URL
// and cannot read a relative path, so the templates carry an absolute https one
// — and this is the only host in the fleet that is ours, monitored, and not
// somebody's project site.
//
// Read from disk on every request rather than cached in memory: these are two
// files of a few KB behind a CDN-less nginx, and a stale logo in an email that
// has already been sent cannot be fixed by a restart anyway.
const ASSET_DIR = new URL('../assets/', import.meta.url).pathname;
const ASSET_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

function handleAsset(req, res, url) {
  // No traversal: the path is rebuilt from its own basename, so '..' cannot
  // survive it and neither can a symlink somebody drops in the folder.
  const rel = url.pathname.replace(/^\/assets\//, '');
  const parts = rel.split('/').filter((p) => p && p !== '.' && p !== '..');
  const file = path.join(ASSET_DIR, ...parts);
  const type = ASSET_TYPES[path.extname(file).toLowerCase()];
  if (!type || !file.startsWith(ASSET_DIR) || !existsSync(file)) return send(res, 404, { error: 'not found' });
  const body = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    // A logo in an email is fetched once per reader and never changes without
    // changing its name.
    'Cache-Control': 'public, max-age=604800, immutable',
    'Access-Control-Allow-Origin': '*',
  });
  return res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) return handleAsset(req, res, url);
    if (req.method === 'GET' && url.pathname === '/roadmap') return await handleRoadmap(req, res, url);
    if (req.method === 'GET' && url.pathname === '/garden') return await handleGarden(req, res);
    if (req.method === 'POST' && url.pathname === '/requirements') return await handleSubmission(req, res);
    if (req.method === 'POST' && url.pathname === '/glitchtip-webhook') return await handleGlitchtipAlert(req, res, url);
    if (req.method === 'POST' && url.pathname === '/send-email') return await handleSendEmail(req, res, url);
    if (req.method === 'POST' && url.pathname === '/brevo-webhook') return await handleBrevoWebhook(req, res, url);
    if (req.method === 'POST' && url.pathname === '/send-whatsapp') return await handleSendWhatsapp(req, res, url);
    if (req.method === 'POST' && url.pathname === '/twilio-status') return await handleTwilioStatus(req, res);
    if (req.method === 'POST' && url.pathname === '/content/submit') return await handleContent(req, res, url, 'submit');
    if (req.method === 'POST' && url.pathname === '/content/sync') return await handleContent(req, res, url, 'sync');
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/baja') return await handleBaja(req, res, url);
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/si') return await handleSi(req, res, url);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('request error:', e);
    return send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => console.log(`requirements-api listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
