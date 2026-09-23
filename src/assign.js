// assign.js — give a web lead an owner the moment it lands.
//
// The public site creates the `leads` row itself through PocketBase's public
// create rule, which cannot set `asignado`; the same form then posts here as a
// `lead_web` requirement carrying the record id. This service already holds
// the superuser session for /send-email, so it is the one place that can
// fill the owner in — and it does so with the CRM's own rule: the on-duty
// agent from the `settings` row `agentes.guardia`, or the oldest user when
// nobody is on duty. An owner that is already set is never overwritten.
//
// Nothing in here throws: a lead without an owner is a CRM problem, a form
// that fails is a lost lead. The caller writes the events; this module says
// what happened.
import { pb, pbConfigured } from './email.js';

/** A PocketBase record id: 15 lowercase alphanumerics, nothing else. */
export const LEAD_ID_RE = /^[a-z0-9]{15}$/;

const ON_DUTY_KEY = 'agentes.guardia';

/**
 * PocketBase returns a parsed object for a `json` field but a string for a
 * `text` field holding JSON. Accept both; anything else is "no setting".
 */
function settingText(value) {
  let v = value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return ''; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
  return typeof v.text === 'string' ? v.text.trim() : '';
}

/**
 * Who takes the next web lead: `{ user_id, rule }`, where rule is
 * 'agentes.guardia' (the setting named someone) or 'oldest_user' (fallback).
 * Returns null when there is nobody at all.
 */
export async function pickOnDutyAgent() {
  const found = await pb('GET',
    `/api/collections/settings/records?perPage=1&filter=${encodeURIComponent(`key="${ON_DUTY_KEY}"`)}`);
  const onDuty = settingText(found?.items?.[0]?.value);
  if (onDuty) return { user_id: onDuty, rule: ON_DUTY_KEY };

  const users = await pb('GET', '/api/collections/users/records?sort=created&perPage=1');
  const oldest = users?.items?.[0]?.id;
  return oldest ? { user_id: oldest, rule: 'oldest_user' } : null;
}

/**
 * Assign one web lead. Never throws; returns one of
 *   { skipped: true, reason }                 — nothing to do (bad id, PB off, owner set)
 *   { assigned: true, user_id, rule }         — PATCHed and `lead.assigned` logged
 *   { error }                                 — something failed; `lead.assign_failed` logged
 *
 * `logEvent(type, payload)` is injected so the module owns no database pool
 * and the tests can read what would have been recorded.
 */
export async function assignWebLead({ leadId, project, logEvent = async () => {} }) {
  const id = String(leadId ?? '');
  if (!LEAD_ID_RE.test(id)) return { skipped: true, reason: 'no lead id' };
  if (!pbConfigured()) return { skipped: true, reason: 'pb not configured' };

  try {
    const lead = await pb('GET', `/api/collections/leads/records/${id}`);
    // Never take a lead away from whoever already has it.
    if (lead?.asignado) return { skipped: true, reason: 'already assigned', user_id: lead.asignado };

    const agent = await pickOnDutyAgent();
    if (!agent) throw new Error('no users to assign to');

    await pb('PATCH', `/api/collections/leads/records/${id}`, { asignado: agent.user_id });
    await logEvent('lead.assigned', {
      project, lead_id: id, user_id: agent.user_id, source: 'lead_web', rule: agent.rule,
    });
    return { assigned: true, ...agent };
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 200);
    console.error(`lead assign failed (${id}):`, error);
    await logEvent('lead.assign_failed', { project, lead_id: id, error })
      .catch((err) => console.error('event log failed:', err.message));
    return { error };
  }
}
