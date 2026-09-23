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

// The `plantillas.evento` of the two consent-request templates,
// `consentimiento.solicitud` (WhatsApp) and `consentimiento.solicitud.email`.
// `evento` is a real field on the row and `loadTemplate` returns the whole
// record, so the marker travels with the template: a renamed clave keeps the
// exemption and a new marketing template cannot inherit it by accident.
export const CONSENT_REQUEST_EVENT = 'campana.consentimiento';

/** The message asking for consent — the one message that cannot require it. */
export const isConsentRequest = (plantilla) =>
  String(plantilla?.evento ?? '') === CONSENT_REQUEST_EVENT;

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
 * The link placeholders a template declares, as values. Only the names in
 * `names` come back, so a template that does not mention `{{si_url}}` never
 * carries one — and the caller never has to supply either (it could not: the
 * secret is the chassis's) nor gets a variables_missing for them.
 */
export function linkVariables(names, { publicUrl, leadId, secret }) {
  if (!publicUrl || !leadId || !secret) return {};
  const all = {
    baja_url: bajaUrl(publicUrl, leadId, secret),
    si_url: siUrl(publicUrl, leadId, secret),
  };
  return Object.fromEntries((names ?? []).filter((name) => name in all).map((name) => [name, all[name]]));
}

// -- what following a link writes -------------------------------------------
// The same cap the WhatsApp path uses for consentimiento_texto: the evidence
// is a sentence on the lead, not a document.
const CONSENT_TEXT_MAX = 300;

/** The evidence stored on the lead: the exact copy the /si page showed them. */
export const consentText = (idioma) => {
  const loc = locale(idioma);
  return `${t(loc, 'si_ask')} ${t(loc, 'si_confirm')}`.slice(0, CONSENT_TEXT_MAX);
};

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
  await logEvent('lead.consent_revoked', { lead_id: leadId, via: 'email' });
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
    consentimiento_texto: consentText(idioma),
  });
  await logEvent('lead.consent_given', { lead_id: leadId, via: 'email', ...(afterOptOut ? { after_opt_out: true } : {}) });
  return { granted: true, idioma, ...(afterOptOut ? { afterOptOut: true } : {}) };
}
