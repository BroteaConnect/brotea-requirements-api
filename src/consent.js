// consent.js — the email half of consent: who may be written to, the two
// signed links an email carries, and what following one of them writes.
//
// The footer of every tracked email carries a signed link to GET /baja;
// following it ends where a WhatsApp BAJA ends: leads.consentimiento = false
// with the text and the date, one lead.consent_revoked event, one line of
// confirmation. The consent campaign (CU-15) carries the mirror link to
// GET /si, which ends where a WhatsApp SÍ ends: consentimiento = true with
// the text and the date, one lead.consent_given event.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { locale, t } from './copy.js';
import { pbQuote } from './templates.js';

// The `plantillas.evento` of the two consent-request templates,
// `consentimiento.solicitud` (WhatsApp) and `consentimiento.solicitud.email`.
// `evento` is a real field on the row and `loadTemplate` returns the whole
// record, so the marker travels with the template: a renamed clave keeps the
// exemption and a new marketing template cannot inherit it by accident.
export const CONSENT_REQUEST_EVENT = 'campana.consentimiento';

// Two conditions, not one, and the second is the reason the first is not
// enough: `plantillas.update` on the deployed instance is open to any
// signed-in CRM user, so `evento` is a field an operator can type. Setting it
// on a marketing template would otherwise open the 216 never-asked leads to
// that template. The clave is equally editable, but the pair means the
// exemption cannot be reached by changing one field of one row by accident,
// and a row that claims both is a deliberate act with an audit trail.
export const CONSENT_REQUEST_CLAVE_PREFIX = 'consentimiento.solicitud';

/** The message asking for consent — the one message that cannot require it. */
export const isConsentRequest = (plantilla) =>
  String(plantilla?.evento ?? '') === CONSENT_REQUEST_EVENT
  && String(plantilla?.clave ?? '').startsWith(CONSENT_REQUEST_CLAVE_PREFIX);

/**
 * Whether this template may go to this lead: null to send, or the refusal
 * code to answer with. Three states of `leads`, not two:
 *
 *   consentimiento true                     → anything (they said yes)
 *   false with a consentimiento_en date     → they said no. Only /baja and a
 *                                             WhatsApp BAJA write that pair,
 *                                             so it is an act, not a blank.
 *                                             Nothing marketing goes out.
 *   false with no date                      → nobody ever asked. The consent
 *                                             request itself may go out; any
 *                                             other marketing template may not.
 *
 * The exemption is keyed on the template's own `evento`, so it covers the
 * consent request and nothing else, and it never reaches a lead who opted out.
 */
export function consentGate(plantilla, lead) {
  if (plantilla?.categoria !== 'marketing') return null;
  if (lead?.consentimiento) return null;
  if (lead?.consentimiento_en) return 'consent_revoked';
  return isConsentRequest(plantilla) ? null : 'no_consent';
}

// -- the signed links -------------------------------------------------------
// One secret, two messages: a token that opts a lead out must never also opt
// them in. `baja` keeps the bare lead id it has always been computed over —
// every footer already sitting in an inbox has to keep working — and `si`
// signs `si:<leadId>`, so neither token validates for the other route.
const message = (kind, leadId) => (kind === 'si' ? `si:${leadId}` : String(leadId));

const token = (kind, leadId, secret) =>
  createHmac('sha256', String(secret)).update(message(kind, leadId)).digest('base64url');

const valid = (kind, leadId, given, secret) => {
  if (!leadId || !given || !secret) return false;
  const a = Buffer.from(token(kind, leadId, secret));
  const b = Buffer.from(String(given));
  return a.length === b.length && timingSafeEqual(a, b);
};

const link = (kind, publicUrl, leadId, secret) =>
  `${String(publicUrl).replace(/\/$/, '')}/${kind}?lead=${encodeURIComponent(leadId)}&t=${token(kind, leadId, secret)}`;

/** HMAC-SHA256(secret, leadId) as base64url: a link only the chassis can mint. */
export const bajaToken = (leadId, secret) => token('baja', leadId, secret);
/** HMAC-SHA256(secret, `si:${leadId}`): the opt-in half, never the opt-out one. */
export const siToken = (leadId, secret) => token('si', leadId, secret);

export const validBajaToken = (leadId, given, secret) => valid('baja', leadId, given, secret);
export const validSiToken = (leadId, given, secret) => valid('si', leadId, given, secret);

export const bajaUrl = (publicUrl, leadId, secret) => link('baja', publicUrl, leadId, secret);
export const siUrl = (publicUrl, leadId, secret) => link('si', publicUrl, leadId, secret);

/**
 * The placeholder names the chassis fills in itself. A caller's value for one
 * of these is dropped before anything is rendered: `render` substitutes any
 * placeholder it finds in the values, declared in the row's `variables` or
 * not, so trusting the declaration would let a row that uses `{{baja_url}}`
 * without declaring it carry somebody else's opt-out link.
 */
export const LINK_NAMES = ['baja_url', 'si_url'];

/** A caller's variables with the chassis's own names taken out. */
export const withoutLinks = (given) =>
  Object.fromEntries(Object.entries(given ?? {}).filter(([name]) => !LINK_NAMES.includes(name)));

/**
 * The link placeholders a template asks for, as values. Only the names in
 * `names` come back, so a template that mentions neither link never carries
 * one — and the caller never has to supply either (it could not: the secret
 * is the chassis's) nor gets a variables_missing for them.
 */
export function linkVariables(names, { publicUrl, leadId, secret }) {
  if (!publicUrl || !leadId || !secret) return {};
  const all = {
    baja_url: bajaUrl(publicUrl, leadId, secret),
    si_url: siUrl(publicUrl, leadId, secret),
  };
  return Object.fromEntries((names ?? []).filter((name) => name in all).map((name) => [name, all[name]]));
}

/**
 * The same text with every link value replaced by `[name]`. A signed link is
 * a bearer credential — following /si flips a lead's consent and the row it
 * writes is indistinguishable from a real one — and `actividades` and
 * `envios` are readable by every signed-in CRM user. The email carries the
 * real URL; what we keep says only that a link was sent.
 */
export function redactLinks(text, values = {}) {
  let out = String(text ?? '');
  for (const name of LINK_NAMES) {
    const url = values[name];
    if (typeof url === 'string' && url) out = out.split(url).join(`[${name}]`);
  }
  return out;
}

/** The same values with every link replaced by `[name]`, for a stored row. */
export const redactedValues = (values = {}) =>
  Object.fromEntries(Object.entries(values).map(([name, v]) => [name, LINK_NAMES.includes(name) && v ? `[${name}]` : v]));

// -- what following a link writes -------------------------------------------
// The same cap the WhatsApp path uses for consentimiento_texto: the evidence
// is a sentence on the lead, not a document.
const CONSENT_TEXT_MAX = 300;

/** An events write that can never undo a consent write that already committed. */
const safeLog = (logEvent, type, payload) =>
  Promise.resolve().then(() => logEvent(type, payload)).catch((e) => console.error(`event ${type} not logged:`, e.message));

/**
 * The evidence stored on the lead: the exact copy the /si page showed them,
 * and the identity of the request they answered. Not the request's body
 * inline — it is up to 2000 characters, carries the lead's own data and a
 * signed link, and this field is a sentence of 300; the clave and version
 * name the exact copy, which `plantillas` keeps under that version, and the
 * `envios` row of the send is the other half of the trail.
 */
export const consentText = (idioma, reference) => {
  const loc = locale(idioma);
  const shown = `${t(loc, 'si_ask')} ${t(loc, 'si_confirm')}`;
  return (reference ? `${shown} [${reference}]` : shown).slice(0, CONSENT_TEXT_MAX);
};

/**
 * `clave vN` of the consent request this lead was actually sent, or '' when
 * there is none to point at. Best effort by design: a read that fails must
 * never cost somebody the consent they just gave, so the write goes ahead
 * with the page copy alone.
 */
async function requestReference(pb, leadId) {
  try {
    const filter = encodeURIComponent(`evento = ${pbQuote(CONSENT_REQUEST_EVENT)} && canal = "email"`);
    const found = await pb('GET', `/api/collections/plantillas/records?perPage=1&filter=${filter}`);
    const plantilla = found?.items?.[0];
    if (!plantilla || !isConsentRequest(plantilla)) return '';
    const sent = await pb('GET', `/api/collections/envios/records?perPage=1&sort=-created&filter=${
      encodeURIComponent(`lead = ${pbQuote(leadId)} && plantilla = ${pbQuote(plantilla.id)}`)}`);
    const envio = sent?.items?.[0];
    if (!envio) return '';
    return `${plantilla.clave} v${Number(envio.plantilla_version) || Number(plantilla.version) || 1}`;
  } catch (e) {
    console.error('consent request reference not read:', e.message);
    return '';
  }
}

/**
 * Revoke a lead's consent from the email link. Idempotent: a lead already
 * opted out is reported {already: true} with no write and no event.
 */
export async function revokeByEmail(leadId, { pb, logEvent, now = new Date() }) {
  const lead = await pb('GET', `/api/collections/leads/records/${encodeURIComponent(leadId)}`);
  const idioma = locale(lead.idioma);
  if (lead.consentimiento === false && lead.consentimiento_en) return { already: true, idioma };
  await pb('PATCH', `/api/collections/leads/records/${encodeURIComponent(leadId)}`, {
    consentimiento: false,
    consentimiento_en: now.toISOString(),
    consentimiento_texto: t(idioma, 'baja_email_text'),
  });
  // After the PATCH, never before: the write has committed, and a platform
  // database that is down must not turn a recorded opt-out into "this link is
  // not valid" for the person who clicked it.
  await safeLog(logEvent, 'lead.consent_revoked', { lead_id: leadId, via: 'email' });
  return { revoked: true, idioma };
}

/**
 * Grant a lead's consent from the email link. Idempotent like revokeByEmail:
 * a lead already consenting is {already: true} with no write and no event.
 *
 * A lead who had opted out and then clicks the link is honoured: the click is
 * a deliberate act by the person themselves and it is more recent than the
 * opt-out. It is not silent — the event carries after_opt_out so the reversal
 * can be read back from the events table.
 */
export async function grantByEmail(leadId, { pb, logEvent, now = new Date() }) {
  const lead = await pb('GET', `/api/collections/leads/records/${encodeURIComponent(leadId)}`);
  const idioma = locale(lead.idioma);
  if (lead.consentimiento === true) return { already: true, idioma };
  const afterOptOut = lead.consentimiento === false && !!lead.consentimiento_en;
  await pb('PATCH', `/api/collections/leads/records/${encodeURIComponent(leadId)}`, {
    consentimiento: true,
    consentimiento_en: now.toISOString(),
    consentimiento_texto: consentText(idioma, await requestReference(pb, leadId)),
  });
  await safeLog(logEvent, 'lead.consent_given', { lead_id: leadId, via: 'email', ...(afterOptOut ? { after_opt_out: true } : {}) });
  return { granted: true, idioma, ...(afterOptOut ? { afterOptOut: true } : {}) };
}
