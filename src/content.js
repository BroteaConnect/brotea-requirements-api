// content.js — a `plantillas` row at Twilio Content: submitted once per
// language for WhatsApp approval, and its approval state read back. Meta
// approves per language, so one row carries two Content sids: the Spanish
// one in content_sid/content_estado/content_motivo, the English one in the
// *_en trio. The chassis writes both as ordinary fields; a PATCH with a
// field the schema does not have yet is ignored by PocketBase, so the
// Spanish path never depends on the English fields existing.
import { dict, t } from './copy.js';
import { loadTemplate, pbQuote, positional, toContentBody, variableNames } from './templates.js';
import { buildApprovalRequest, buildCreateContent, buildFetchContent, buildListContentAndApprovals } from './twilio.js';

const LANGS = ['es', 'en'];
const SUBMITTED = new Set(['received', 'pending', 'approved']);
/** Meta keeps the name of a template it has judged: a new submission needs a new version in the name. */
const JUDGED = new Set(['rejected', 'paused', 'disabled']);
const FIELDS = { es: { sid: 'content_sid', estado: 'content_estado', motivo: 'content_motivo' }, en: { sid: 'content_sid_en', estado: 'content_estado_en', motivo: 'content_motivo_en' } };
const CLASS_STATUS = { provider_auth: 502, sender_not_ready: 502, template_invalid: 502, provider_unavailable: 502, already_submitted: 409, version_unchanged: 409, template_unknown: 404, template_channel: 400 };
const HX = /^HX[0-9a-f]{32}$/i;
const records = (c) => `/api/collections/${c}/records`;

/** Meta's template name: `<clave with dots → underscores>_<lang>_v<version>`, lowercase alphanumerics and underscores only. */
export const contentName = (clave, lang, version) =>
  `${String(clave).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_${lang}_v${Number(version) || 1}`;

/** Sample values for the review, keyed "1", "2", … in the row's variables order. */
export const sampleVariables = (names, lang) => {
  const samples = dict(lang).content_samples ?? {};
  return positional(names, Object.fromEntries(names.map((n) => [n, samples[n] ?? samples._default ?? n])));
};

class ContentFailure extends Error {
  constructor(cls, status, code, providerText) {
    super(`${cls} (${status}${code ? ` ${code}` : ''})`);
    this.class = cls;
    this.status = status;
    this.code = code ?? null;
    this.text = t('es', `refusal.${cls}`) + (providerText ? ` ${String(providerText).slice(0, 200)}` : '');
  }
}

/** A Content API answer that is not a 2xx, classified into an owner action. */
function classify(res, phase) {
  const status = res.status;
  const msg = String(res.data?.message ?? '');
  const code = res.data?.code ?? null;
  if (status === 0 || status >= 500) return new ContentFailure('provider_unavailable', status, code, msg);
  if (status === 401 || status === 403) return new ContentFailure('provider_auth', status, code, msg);
  if (/whatsapp business account|\bwaba\b|sender/i.test(msg)) return new ContentFailure('sender_not_ready', status, code, msg);
  if (status === 400 && phase === 'create') return new ContentFailure('template_invalid', status, code, msg);
  return new ContentFailure('template_invalid', status, code, msg);
}

async function call(twilio, req) {
  try { return await twilio(req); } catch (e) { return { status: 0, ok: false, data: { message: e.message } }; }
}

/** The version encoded in a Content's friendly_name (`…_v3` → 3), or null. */
const versionInName = (name) => { const m = /_v(\d+)$/.exec(String(name ?? '')); return m ? Number(m[1]) : null; };

/**
 * The Content to reuse for a language, or null when a new one must be
 * created. A sid whose approval never went (estado unsubmitted) is reused
 * as it is; a sid Meta has judged is only left behind once the row's
 * version moved past the one in its name, else the retry is refused.
 */
async function reusable(twilio, row, lang) {
  const sid = row[FIELDS[lang].sid];
  const estado = row[FIELDS[lang].estado] || 'unsubmitted';
  if (!HX.test(String(sid ?? ''))) return null;
  const existing = await call(twilio, buildFetchContent({ sid }));
  if (existing.status === 404) return null;
  if (!existing.ok) throw classify(existing, 'fetch');
  const name = existing.data?.friendly_name ?? '';
  if (estado === 'unsubmitted') return { sid, name: /^[a-z0-9_]+$/.test(name) ? name : contentName(row.clave, lang, row.version) };
  if (JUDGED.has(estado)) {
    const was = versionInName(name);
    if (was != null && (Number(row.version) || 1) <= was) throw new ContentFailure('version_unchanged', 0, null, `${name}`);
  }
  return null;
}

/**
 * Create the row's Content in every language that is not submitted yet and
 * request WhatsApp approval for each. Resolves {status, body}.
 */
export async function submitContent({ clave }, { pb, twilio, logEvent }) {
  const fail = async (f) => {
    await logEvent('content.submit_failed', { clave, class: f.class, status: f.status, code: f.code });
    return { status: CLASS_STATUS[f.class] ?? 502, body: { ok: false, error: { code: f.class, class: f.class, text: f.text } } };
  };
  const loaded = await loadTemplate(pb, clave, 'whatsapp');
  if (loaded.code && loaded.code !== 'template_retired') return fail(new ContentFailure(loaded.code, 0, null));
  const row = loaded.plantilla;
  const names = variableNames(row);
  const todo = LANGS.filter((lang) => !SUBMITTED.has(row[FIELDS[lang].estado]));
  if (!todo.length) return fail(new ContentFailure('already_submitted', 0, null));

  const patch = {};
  let failure = null;
  for (const lang of todo) {
    let reuse;
    try { reuse = await reusable(twilio, row, lang); } catch (f) { failure = f; break; }
    let sid; let name;
    if (reuse) {
      ({ sid, name } = reuse);
    } else {
      name = contentName(clave, lang, row.version);
      const body = toContentBody(row[`cuerpo_${lang}`] || row.cuerpo_es || '', names);
      const created = await call(twilio, buildCreateContent({ friendlyName: name, language: lang, body, variables: sampleVariables(names, lang) }));
      if (!created.ok) { failure = classify(created, 'create'); break; }
      sid = created.data.sid;
      patch[FIELDS[lang].sid] = sid;
    }
    const approval = await call(twilio, buildApprovalRequest({ sid, name, category: row.categoria }));
    if (!approval.ok) {
      // The Content exists; keep its sid on the row so a retry finds it, and say why the approval did not go.
      patch[FIELDS[lang].estado] = 'unsubmitted';
      patch[FIELDS[lang].motivo] = String(approval.data?.message ?? '').slice(0, 300);
      failure = classify(approval, 'approve');
      break;
    }
    patch[FIELDS[lang].estado] = approval.data?.status || 'received';
    patch[FIELDS[lang].motivo] = '';
  }
  if (Object.keys(patch).length) await pb('PATCH', `${records('plantillas')}/${row.id}`, patch);
  if (failure) return fail(failure);
  const merged = { ...row, ...patch };
  await logEvent('content.submitted', { clave, content_sid: merged.content_sid ?? null, content_sid_en: merged.content_sid_en ?? null });
  return {
    status: 200,
    body: {
      ok: true, clave,
      content_sid: merged.content_sid ?? null, content_sid_en: merged.content_sid_en ?? null,
      content_estado: merged.content_estado ?? null, content_estado_en: merged.content_estado_en ?? null,
    },
  };
}

/** Every Content resource of the account with its WhatsApp approval, keyed by sid. */
async function readApprovals(twilio) {
  const bySid = new Map();
  let pageToken = null;
  for (let page = 0; page < 50; page++) {
    const res = await call(twilio, buildListContentAndApprovals({ pageSize: 100, pageToken }));
    if (!res.ok) throw classify(res, 'list');
    for (const item of res.data?.contents ?? []) {
      const ar = item.approval_requests ?? {};
      bySid.set(item.sid, { status: ar.status || 'unsubmitted', reason: ar.rejection_reason || '' });
    }
    const next = res.data?.meta?.next_page_url;
    if (!next) break;
    pageToken = new URL(next).searchParams.get('PageToken');
    if (!pageToken) break;
  }
  return bySid;
}

/**
 * Read the approval state of every submitted row (or of one `clave`) back
 * from Twilio and PATCH only the rows whose state or reason changed.
 * `quiet` (the scheduled run) skips `content.synced` when nothing changed,
 * so an hourly timer does not flood `events`; a failure always logs.
 */
export async function syncContent({ clave, quiet = false } = {}, { pb, twilio, logEvent }) {
  const filter = clave ? `canal = "whatsapp" && clave = ${pbQuote(clave)}` : 'canal = "whatsapp"';
  const found = await pb('GET', `${records('plantillas')}?perPage=200&filter=${encodeURIComponent(filter)}`);
  const rows = (found?.items ?? []).filter((r) => r.content_sid || r.content_sid_en);
  let live;
  try {
    live = await readApprovals(twilio);
  } catch (f) {
    await logEvent('content.sync_failed', { class: f.class, status: f.status, code: f.code });
    return { status: CLASS_STATUS[f.class] ?? 502, body: { ok: false, error: { code: f.class, class: f.class, text: f.text } } };
  }
  const updated = [];
  for (const row of rows) {
    const patch = {};
    for (const lang of LANGS) {
      const f = FIELDS[lang];
      const sid = row[f.sid];
      if (!sid || !live.has(sid)) continue;
      const { status, reason } = live.get(sid);
      if (status !== (row[f.estado] || 'unsubmitted')) patch[f.estado] = status;
      if (reason !== (row[f.motivo] || '')) patch[f.motivo] = reason;
    }
    if (!Object.keys(patch).length) continue;
    await pb('PATCH', `${records('plantillas')}/${row.id}`, patch);
    const merged = { ...row, ...patch };
    updated.push({
      clave: row.clave, content_estado: merged.content_estado ?? null, content_estado_en: merged.content_estado_en ?? null,
      ...('content_motivo' in patch ? { content_motivo: patch.content_motivo } : {}),
      ...('content_motivo_en' in patch ? { content_motivo_en: patch.content_motivo_en } : {}),
    });
  }
  if (!quiet || updated.length) {
    await logEvent('content.synced', { updated: updated.map(({ clave: c, content_estado, content_estado_en }) => ({ clave: c, content_estado, content_estado_en })), checked: rows.length });
  }
  return { status: 200, body: { ok: true, updated, checked: rows.length } };
}

const DEFAULT_TIMERS = { setTimeout, setInterval, clearTimeout, clearInterval };

/**
 * CONTENT_SYNC_MINUTES as milliseconds, or 0 when the sync is off. Unset or
 * blank is 60; 0, a negative or a non-number disables it. Clamped to at least
 * one minute (a typo must not list Twilio back to back) and at most 2^31-1 ms,
 * past which Node fires every 1 ms.
 */
export function contentSyncEveryMs(raw) {
  const minutes = Number(String(raw ?? '').trim() || 60);
  if (!(minutes > 0)) return 0;
  return Math.min(Math.max(minutes, 1) * 60_000, 2 ** 31 - 1);
}

/**
 * Run `run()` once `bootDelayMs` after boot, then every `everyMs`, so
 * approval states come back without anyone calling /content/sync. A tick
 * while a run is still in flight is skipped, never stacked; a throw or a
 * rejection goes to `onError` and the next tick runs as usual. Timers are
 * unref'd: the scheduler never keeps the process alive. Returns stop().
 */
export function startContentSync({ everyMs, run, onError = () => {}, bootDelayMs = 30_000, timers = DEFAULT_TIMERS }) {
  let running = false;
  let interval = null;
  const unref = (h) => { if (typeof h?.unref === 'function') h.unref(); return h; };
  const tick = async () => {
    if (running) return;
    running = true;
    try { await run(); } catch (e) { try { onError(e); } catch { /* onError never crashes the process either */ } } finally { running = false; }
  };
  const boot = unref(timers.setTimeout(() => {
    tick();
    interval = unref(timers.setInterval(tick, everyMs));
  }, bootDelayMs));
  return () => {
    timers.clearTimeout(boot);
    if (interval) timers.clearInterval(interval);
  };
}
