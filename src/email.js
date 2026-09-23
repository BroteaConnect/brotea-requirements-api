// email.js — outbound transactional email with delivery tracking.
//
// Why here and not in the CRM: the SMTP credentials must never reach a
// browser, and the Brevo webhook needs a public receiver. The CRM calls
// POST /send-email; Brevo calls POST /brevo-webhook with delivery events;
// both sides converge on the PocketBase `actividades` record and the
// `envios` ledger row identified by the Message-ID we mint ourselves, so
// the CRM sees "entregado" or "abierto" without polling anything.
import { createTransport } from 'nodemailer';
import { randomBytes } from 'node:crypto';
import { locale, t } from './copy.js';
import { consentGate, linkVariables, redactLinks, redactedValues, withoutLinks } from './consent.js';
import { bodyPlaceholders, loadTemplate, missingVariables, render, variableNames } from './templates.js';
import { RANK, moves } from './twilio.js';

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

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Plain text → simple HTML. Open tracking needs an HTML part: the provider
 *  injects its pixel there, so a text-only email is untrackable by design. */
const textoAHtml = (text) =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#09092d">` +
  text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') +
  `</body></html>`;

// -- a `plantillas` row for one lead -----------------------------------------
// Everything POST /send-email needs to resolve {lead_id, plantilla,
// variables} into a message, with no environment of its own: the server hands
// in `pb` and the public origin, so the whole decision runs in a test.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const REFUSAL_STATUS = {
  lead_required: 400, lead_unknown: 404, template_unknown: 404, template_channel: 400,
  template_retired: 422, no_email: 400, no_consent: 422, consent_revoked: 422, variables_missing: 400,
};
const refuse = (code, vars) => ({ code, status: REFUSAL_STATUS[code] ?? 400, vars });

/**
 * The address a free-text email goes to: the `leads` row's, never the
 * caller's. Resolves {to, idioma, lead} or {code, status}.
 *
 * This is the whole of the open-relay fix. The endpoint used to take `to`
 * straight off the request, which turned the agency's SMTP identity — its
 * domain, its SPF, its DKIM — into a relay for whoever held the credential.
 * A caller now says WHO, and the chassis alone decides where that lands.
 */
export async function resolveLeadEmail(leadId, { pb: pbCall }) {
  if (!leadId) return refuse('lead_required');
  let lead;
  try {
    lead = await pbCall('GET', `/api/collections/leads/records/${encodeURIComponent(leadId)}`);
  } catch (e) {
    if (e.status === 404) return refuse('lead_unknown');
    throw e;
  }
  const to = String(lead.email ?? '').trim();
  if (!EMAIL_RE.test(to)) return refuse('no_email');
  return { to, idioma: locale(lead.idioma), lead };
}

/**
 * Resolve a template send for a lead: {to, subject, text, idioma, plantilla,
 * values} when it may go out, {code, status, vars} when it may not.
 */
export async function resolveTemplateEmail({ leadId, clave, given }, { pb: pbCall, publicUrl, secret }) {
  if (!leadId) return refuse('lead_required');
  let lead;
  try {
    lead = await pbCall('GET', `/api/collections/leads/records/${encodeURIComponent(leadId)}`);
  } catch (e) {
    if (e.status === 404) return refuse('lead_unknown');
    throw e;
  }
  const loaded = await loadTemplate(pbCall, clave, 'email');
  if (loaded.code) return refuse(loaded.code, { canal: 'email' });
  const plantilla = loaded.plantilla;
  const to = String(lead.email ?? '').trim();
  if (!EMAIL_RE.test(to)) return refuse('no_email');
  const gate = consentGate(plantilla, lead);
  if (gate) return refuse(gate);

  const idioma = locale(lead.idioma);
  const names = variableNames(plantilla);
  const asunto = plantilla[`asunto_${idioma}`] || plantilla.asunto_es || '';
  const cuerpo = plantilla[`cuerpo_${idioma}`] || plantilla.cuerpo_es || '';
  // What the links are filled from is what the text actually uses, not only
  // what the row declares: `render` substitutes every placeholder it finds, so
  // a row that says {{baja_url}} without listing it would otherwise go out
  // with the placeholder visible in it.
  const used = [...new Set([...names, ...bodyPlaceholders(asunto), ...bodyPlaceholders(cuerpo)])];
  const values = {
    // Security-relevant, both halves: the caller's own value for a link name
    // is dropped, and the signed links — minted with a secret only the chassis
    // holds — go in last. A caller can neither be asked for them nor
    // substitute its own.
    nombre: lead.nombre || '',
    ...withoutLinks(given && typeof given === 'object' ? given : {}),
    ...linkVariables(used, { publicUrl, leadId, secret }),
  };
  // A link we cannot mint (no public origin, no secret) stays missing: the
  // refusal names it, rather than a body reaching an inbox with a literal
  // {{baja_url}} in it.
  const missing = missingVariables(names, values);
  if (missing.length) return refuse('variables_missing', { names: missing.join(', ') });

  return {
    to, plantilla, idioma, values,
    subject: render(asunto, values).trim(),
    text: render(cuerpo, values).trim(),
  };
}

/**
 * Send one email, record it as a lead activity and as an `envios` row.
 * With `leadId` and `bajaUrl` the opt-out footer is appended in the lead's
 * language. Returns { message_id, activity_id, envio_id, smtp }.
 */
export async function sendTrackedEmail({ to, subject, text, leadId, fromName, html, plantilla, plantillaVersion, variables, bajaUrl, idioma }, deps = {}) {
  const pbCall = deps.pb ?? pb;
  const pbReady = deps.pb ? true : pbConfigured();
  const now = deps.now ?? new Date();
  const footer = leadId && bajaUrl ? `\n\n${t(locale(idioma), 'email_footer_baja', { url: bajaUrl })}` : '';
  const body = `${text}${footer}`;
  // Our own Message-ID is the join key with Brevo's webhook events.
  const messageId = `<lead-${leadId ?? 'na'}-${randomBytes(8).toString('hex')}@brotea.dev>`;
  const info = await (deps.sendMail ?? ((m) => getTransport().sendMail(m)))({
    from: fromName ? `${fromName} <${MAIL_FROM}>` : MAIL_FROM,
    to, subject, text: body, messageId,
    html: html ? (footer ? html.replace(/<\/body>/i, `<p>${esc(footer.trim())}</p></body>`) : html) : textoAHtml(body),
    // Brevo relays these as its own tracking tags.
    headers: { 'X-Mailin-custom': `lead:${leadId ?? ''}` },
  });

  // The rows keep the message, never the credential in it: `actividades` and
  // `envios` are readable by every signed-in CRM user, and a /si link stored
  // there would let any of them grant a lead's consent. The email that left
  // carries the real URLs; what is kept says `[si_url]`.
  const stored = redactLinks(text, variables);
  const storedVariables = variables ? redactedValues(variables) : variables;

  let activityId = null;
  let envioId = null;
  if (leadId && pbReady) {
    const act = await pbCall('POST', '/api/collections/actividades/records', {
      lead: leadId, tipo: 'email', direccion: 'saliente',
      asunto: subject, nota: stored.slice(0, 2000),
      estado_envio: 'enviado', mensaje_id: messageId,
    });
    activityId = act.id;
    await pbCall('PATCH', `/api/collections/leads/records/${leadId}`, {
      ultimo_contacto: now.toISOString(),
    });
  }
  if (pbReady) {
    // The ledger row never fails a send that already left: a miss here is
    // an events row on the caller's side, with the Message-ID to reconcile.
    try {
      const envio = await pbCall('POST', '/api/collections/envios/records', {
        ...(leadId ? { lead: leadId } : {}),
        ...(plantilla ? { plantilla, plantilla_version: Number(plantillaVersion) || 1 } : {}),
        ...(activityId ? { actividad: activityId } : {}),
        canal: 'email', mensaje_id: messageId, estado: 'enviado', enviado_en: now.toISOString(),
        ...(storedVariables ? { variables: storedVariables } : {}),
      });
      envioId = envio.id;
    } catch (e) {
      console.error('envios write failed:', e.message);
    }
  }
  return { message_id: messageId, activity_id: activityId, envio_id: envioId, smtp: info?.response ?? null };
}

// Brevo event names → our estado vocabulary. The rank (shared with the
// WhatsApp ledger in twilio.js) keeps a late "delivered" from overwriting an
// earlier "opened".
export { RANK };
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

/**
 * Apply one Brevo delivery event to its activity and its envios row, each
 * under the never-backwards rule. Returns what it did on both:
 * {updated|skipped, estado?, envio: {updated|skipped}}.
 */
export async function applyBrevoEvent(payload, deps = {}) {
  const estado = MAP[payload.event];
  const messageId = payload['message-id'] ?? payload.messageId;
  if (!estado || !messageId) return { skipped: true, event: payload.event };
  const pbCall = deps.pb ?? pb;
  if (!deps.pb && !pbConfigured()) return { skipped: true, reason: 'pb not configured' };
  const now = deps.now ?? new Date();
  const filter = encodeURIComponent(`mensaje_id="${String(messageId).replace(/"/g, '')}"`);

  let result;
  const found = await pbCall('GET', `/api/collections/actividades/records?perPage=1&filter=${filter}`);
  const act = found.items?.[0];
  if (!act) result = { skipped: true, reason: 'activity not found' };
  else if (!moves(act.estado_envio, estado)) result = { skipped: true, reason: act.estado_envio === 'simulado' ? 'simulated' : 'already further along', estado: act.estado_envio };
  else {
    await pbCall('PATCH', `/api/collections/actividades/records/${act.id}`, { estado_envio: estado });
    result = { updated: act.id, estado };
  }

  const ledger = await pbCall('GET', `/api/collections/envios/records?perPage=1&filter=${filter}`);
  const row = ledger.items?.[0];
  if (!row) result.envio = { skipped: true, reason: 'unknown message' };
  else if (!moves(row.estado, estado)) result.envio = { skipped: true, reason: row.estado === 'simulado' ? 'simulated' : 'already further along', estado: row.estado };
  else {
    const patch = { estado, [`${estado}_en`]: now.toISOString() };
    if (estado === 'error') {
      patch.error_codigo = String(payload.event);
      patch.error_texto = String(payload.reason ?? payload.event).slice(0, 300);
    }
    await pbCall('PATCH', `/api/collections/envios/records/${row.id}`, patch);
    result.envio = { updated: row.id, estado };
  }
  return result;
}
