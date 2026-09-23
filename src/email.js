// email.js — outbound transactional email with delivery tracking.
//
// Why here and not in the CRM: the SMTP credentials must never reach a
// browser, and the Brevo webhook needs a public receiver. The CRM calls
// POST /send-email; Brevo calls POST /brevo-webhook with delivery events;
// both sides converge on the PocketBase `actividades` record identified by
// its Message-ID, so the CRM sees "abierto" without polling anything.
import { createTransport } from 'nodemailer';
import { randomBytes } from 'node:crypto';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM ?? 'no-reply@brotea.dev';

// PocketBase instance holding the CRM data (per project, one for now).
const PB_URL = process.env.PB_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASS = process.env.PB_ADMIN_PASS;

export const emailConfigured = () => !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
export const pbConfigured = () => !!(PB_URL && PB_ADMIN_EMAIL && PB_ADMIN_PASS);

let transport;
const getTransport = () => (transport ??= createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
}));

// -- PocketBase superuser session (cached, re-authenticated on expiry) --------
// Every call is bounded: some of these run on the public form's request path,
// and a stalled PocketBase must become a logged failure, not a held socket.
const PB_TIMEOUT_MS = 5_000;
let pbToken = null;
let pbTokenAt = 0;
async function pbAuth() {
  if (pbToken && Date.now() - pbTokenAt < 10 * 60_000) return pbToken;
  const res = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: PB_ADMIN_EMAIL, password: PB_ADMIN_PASS }),
    signal: AbortSignal.timeout(PB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`pb auth ${res.status}`);
  const { token } = await res.json();
  pbToken = token;
  pbTokenAt = Date.now();
  return token;
}

/** One PocketBase call as the superuser. A 401/403 means the cached token is
 *  no longer good (restart, rotated password): drop it and retry once, so a
 *  bad token never poisons the next ten minutes. */
export async function pb(method, path, body, { retry = true } = {}) {
  const token = await pbAuth();
  const res = await fetch(`${PB_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: token },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(PB_TIMEOUT_MS),
  });
  if ((res.status === 401 || res.status === 403) && retry) {
    pbToken = null;
    return pb(method, path, body, { retry: false });
  }
  if (!res.ok) {
    const err = new Error(`pb ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Send one email and record it as a lead activity.
 * Returns { message_id, activity_id }.
 */
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Plain text → simple HTML. Open tracking needs an HTML part: the provider
 *  injects its pixel there, so a text-only email is untrackable by design. */
const textoAHtml = (text) =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#09092d">` +
  text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') +
  `</body></html>`;

export async function sendTrackedEmail({ to, subject, text, leadId, fromName, html }) {
  // Our own Message-ID is the join key with Brevo's webhook events.
  const messageId = `<lead-${leadId ?? 'na'}-${randomBytes(8).toString('hex')}@brotea.dev>`;
  const info = await getTransport().sendMail({
    from: fromName ? `${fromName} <${MAIL_FROM}>` : MAIL_FROM,
    to, subject, text, messageId,
    html: html || textoAHtml(text),
    // Brevo relays these as its own tracking tags.
    headers: { 'X-Mailin-custom': `lead:${leadId ?? ''}` },
  });

  let activityId = null;
  if (leadId && pbConfigured()) {
    const act = await pb('POST', '/api/collections/actividades/records', {
      lead: leadId, tipo: 'email', direccion: 'saliente',
      asunto: subject, nota: text.slice(0, 2000),
      estado_envio: 'enviado', mensaje_id: messageId,
    });
    activityId = act.id;
    await pb('PATCH', `/api/collections/leads/records/${leadId}`, {
      ultimo_contacto: new Date().toISOString(),
    });
  }
  return { message_id: messageId, activity_id: activityId, smtp: info.response };
}

// Brevo event names → our estado_envio vocabulary. Ordered by progress so a
// late "delivered" never overwrites an earlier "opened".
const RANK = { enviado: 1, entregado: 2, abierto: 3, click: 4, error: 5 };
const MAP = {
  delivered: 'entregado',
  opened: 'abierto',
  unique_opened: 'abierto',
  click: 'click',
  hard_bounce: 'error',
  soft_bounce: 'error',
  blocked: 'error',
  spam: 'error',
  invalid_email: 'error',
  deferred: null,
  request: null,
};

/** Apply one Brevo delivery event to its activity. Returns what it did. */
export async function applyBrevoEvent(payload) {
  const estado = MAP[payload.event];
  const messageId = payload['message-id'] ?? payload.messageId;
  if (!estado || !messageId) return { skipped: true, event: payload.event };
  if (!pbConfigured()) return { skipped: true, reason: 'pb not configured' };

  const found = await pb('GET',
    `/api/collections/actividades/records?perPage=1&filter=${encodeURIComponent(`mensaje_id="${messageId}"`)}`);
  const act = found.items?.[0];
  if (!act) return { skipped: true, reason: 'activity not found' };
  // No degradar el estado (los eventos llegan desordenados).
  if ((RANK[estado] ?? 0) <= (RANK[act.estado_envio] ?? 0)) {
    return { skipped: true, reason: 'already further along', estado: act.estado_envio };
  }
  await pb('PATCH', `/api/collections/actividades/records/${act.id}`, { estado_envio: estado });
  return { updated: act.id, estado };
}
