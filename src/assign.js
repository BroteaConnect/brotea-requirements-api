// assign.js — give a web lead an owner the moment it lands.
//
// The public site creates the `leads` row itself through PocketBase's public
// create rule, which cannot set `asignado`; the same form then posts here as a
// `lead_web` requirement carrying the record id. This service already holds
// the superuser session for /send-email, so it is the one place that can
// fill the owner in — and it does so with the CRM's own rule: the on-duty
// agent from the `settings` row `agentes.guardia`, or the oldest non-superadmin
// user when nobody is on duty. An owner that is already set is never
// overwritten.
//
// Nothing in here throws: a lead without an owner is a CRM problem, a form
// that fails is a lost lead. The caller writes the events; this module says
// what happened — including when it did nothing, because until the landing
// sends `lead_id` every web lead takes the skipped path and that gap has to
// be visible in the events table.
import { pb, pbConfigured } from './email.js';

/** A PocketBase record id: 15 lowercase alphanumerics, nothing else. */
export const LEAD_ID_RE = /^[a-z0-9]{15}$/;

const ON_DUTY_KEY = 'agentes.guardia';
/** The one instance this chassis talks to. */
const pbProject = () => process.env.PB_PROJECT || 'inmobiliaria';

/**
 * PocketBase returns a parsed object for a `json` field but a string for a
 * `text` field holding JSON. Accept both; anything that is not a users id
 * (a stale row, a name typed by hand) is "nobody on duty", so the fallback
 * runs instead of a 400 from the PATCH.
 */
function onDutyId(value) {
  let v = value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return ''; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
  const text = typeof v.text === 'string' ? v.text.trim() : '';
  return LEAD_ID_RE.test(text) ? text : '';
}

/** The agent named on duty, or null. */
async function onDutyAgent() {
  const found = await pb('GET',
    `/api/collections/settings/records?perPage=1&sort=-updated&filter=${encodeURIComponent(`key="${ON_DUTY_KEY}"`)}`);
  const id = onDutyId(found?.items?.[0]?.value);
  return id ? { user_id: id, rule: ON_DUTY_KEY } : null;
}

/** The oldest user who is an agent (superadmins run the CRM, they do not
 *  answer leads), or null when there is nobody. */
async function fallbackAgent() {
  const users = await pb('GET',
    `/api/collections/users/records?perPage=1&sort=created,id&filter=${encodeURIComponent('role != "superadmin"')}`);
  const id = users?.items?.[0]?.id;
  return id ? { user_id: id, rule: 'oldest_user' } : null;
}

/**
 * Who takes the next web lead: `{ user_id, rule }`, where rule is
 * 'agentes.guardia' (the setting named someone) or 'oldest_user' (fallback).
 * Returns null when there is nobody at all.
 */
export async function pickOnDutyAgent() {
  return (await onDutyAgent()) ?? (await fallbackAgent());
}

/**
 * Assign one web lead. Never throws; returns one of
 *   { skipped: true, reason }              — nothing to do (`lead.assign_skipped`
 *                                            logged, except for an owner already set)
 *   { assigned: true, user_id, rule }      — PATCHed and `lead.assigned` logged
 *                                            (`logged: false` if only the log failed)
 *   { error }                              — something failed; `lead.assign_failed` logged
 *
 * `logEvent(type, payload)` is injected so the module owns no database pool
 * and the tests can read what would have been recorded.
 */
export async function assignWebLead({ leadId, project, logEvent = async () => {} }) {
  const id = String(leadId ?? '');
  const log = (type, payload) => Promise.resolve().then(() => logEvent(type, payload))
    .catch((err) => { console.error('event log failed:', err.message); return false; });
  const skip = async (reason) => {
    await log('lead.assign_skipped', { project, lead_id: id, reason });
    return { skipped: true, reason };
  };

  if (!LEAD_ID_RE.test(id)) return skip('no lead id');
  if (project !== pbProject()) return skip('pb not for this project');
  if (!pbConfigured()) return skip('pb not configured');

  let agent;
  try {
    const lead = await pb('GET', `/api/collections/leads/records/${id}`);
    // Never take a lead away from whoever already has it.
    if (lead?.asignado) return { skipped: true, reason: 'already assigned', user_id: lead.asignado };

    agent = await onDutyAgent();
    if (agent) {
      try {
        await pb('PATCH', `/api/collections/leads/records/${id}`, { asignado: agent.user_id });
      } catch (e) {
        // The setting names a user PocketBase no longer knows: fall back once.
        if (e.status !== 400) throw e;
        console.error(`on-duty agent ${agent.user_id} rejected (${e.message}); falling back`);
        agent = null;
      }
    }
    if (!agent) {
      agent = await fallbackAgent();
      if (!agent) throw new Error('no agent user');
      await pb('PATCH', `/api/collections/leads/records/${id}`, { asignado: agent.user_id });
    }
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 200);
    console.error(`lead assign failed (${id}):`, error);
    await log('lead.assign_failed', { project, lead_id: id, error });
    return { error };
  }

  // The lead has its owner whatever happens to the log line.
  const logged = await log('lead.assigned', {
    project, lead_id: id, user_id: agent.user_id, source: 'lead_web', rule: agent.rule,
  });
  return { assigned: true, ...agent, ...(logged === false ? { logged: false } : {}) };
}
