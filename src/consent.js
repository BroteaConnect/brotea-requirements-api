// consent.js — the email half of opting out. The footer of every tracked
// email carries a signed link to GET /baja; following it ends where a
// WhatsApp BAJA ends: leads.consentimiento = false with the text and the
// date, one lead.consent_revoked event, one line of confirmation.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { locale, t } from './copy.js';

/** HMAC-SHA256(secret, leadId) as base64url: a link only the chassis can mint. */
export const bajaToken = (leadId, secret) =>
  createHmac('sha256', String(secret)).update(String(leadId)).digest('base64url');

export function validBajaToken(leadId, token, secret) {
  if (!leadId || !token || !secret) return false;
  const a = Buffer.from(bajaToken(leadId, secret));
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

export const bajaUrl = (publicUrl, leadId, secret) =>
  `${String(publicUrl).replace(/\/$/, '')}/baja?lead=${encodeURIComponent(leadId)}&t=${bajaToken(leadId, secret)}`;

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
