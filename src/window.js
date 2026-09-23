// window.js — the 24-hour customer-service window, inferred from our own
// `actividades` rows: the latest inbound WhatsApp activity of the lead
// opens it. A window we cannot see is a closed one, which only ever costs a
// refused free text (never a send Meta would reject).
import { pbQuote } from './templates.js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** PocketBase writes "2026-09-23 10:00:00.000Z"; Date.parse wants the T. */
export const pbDate = (s) => new Date(String(s ?? '').replace(' ', 'T'));

/** {inside, since}: since is the ISO time of the inbound that opened the window, or null. */
export async function insideWindow(pb, leadId, now = new Date()) {
  const filter = encodeURIComponent(`lead = ${pbQuote(leadId)} && tipo = "whatsapp" && direccion = "entrante"`);
  const found = await pb('GET', `/api/collections/actividades/records?perPage=1&sort=-created&filter=${filter}`);
  const last = found?.items?.[0];
  if (!last?.created) return { inside: false, since: null };
  const at = pbDate(last.created);
  if (Number.isNaN(at.getTime())) return { inside: false, since: null };
  const inside = now.getTime() - at.getTime() < WINDOW_MS;
  return { inside, since: inside ? at.toISOString() : null };
}
