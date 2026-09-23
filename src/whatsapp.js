// whatsapp.js — one WhatsApp send through Twilio with its ledger rows, and
// the status callback applied to those rows. Both are pure of environment:
// the server hands in `pb`, `twilio`, `logEvent`, `now` and the account
// facts, so the whole flow runs in a test against fakes.
//
// The order of writes is the contract the CRM reads:
//   actividades (registrado) → envios (registrado) → Twilio → envios
//   {mensaje_id, estado: enviado, enviado_en} in ONE patch, mensaje_id first
//   → actividades {estado_envio, mensaje_id} → leads {ultimo_contacto}.
// A refusal (4xx) leaves no row and one whatsapp.refused event. A provider
// error leaves the rows in `error` with the code verbatim in error_codigo.
import { has, locale, t } from './copy.js';
import { consentGate } from './consent.js';
import { leadPhoneE164 } from './phone.js';
import { loadTemplate, missingVariables, pbQuote, pick, positional, render, variableNames } from './templates.js';
import { BODY_MAX, STATUS_MAP, buildSendMessage, moves, parseStatusCallback, twilioError } from './twilio.js';
import { insideWindow } from './window.js';

/** The language the ledger's sentences are written in: the agency's, not the lead's. */
const LEDGER_LOCALE = 'es';
const REFUSAL_STATUS = {
  lead_required: 400, lead_unknown: 404, template_unknown: 404, template_channel: 400,
  template_retired: 422, template_required: 400, variables_missing: 400, text_too_long: 400,
  no_phone: 422, no_consent: 422, consent_revoked: 422, outside_window: 422, template_not_approved: 422, actividad_invalid: 400,
};
const PB_ID = /^[a-z0-9]{15}$/i;

/** An events write that can never turn a message that left into a 500. */
const safeLog = (logEvent, type, payload) =>
  Promise.resolve().then(() => logEvent(type, payload)).catch((e) => console.error(`event ${type} not logged:`, e.message));

class Refusal extends Error {
  constructor(code, vars) {
    super(code);
    this.code = code;
    this.status = REFUSAL_STATUS[code] ?? 400;
    this.text = t(LEDGER_LOCALE, `refusal.${code}`, vars);
  }
}

/** The plain sentence for a provider code: ours when the code is known, the provider's (masked) otherwise. */
export const errorText = (code, providerMessage) =>
  (has(LEDGER_LOCALE, `twilio_error.${code}`) ? t(LEDGER_LOCALE, `twilio_error.${code}`) : String(providerMessage ?? '').slice(0, 300));

const records = (c) => `/api/collections/${c}/records`;
const str = (v) => (v == null ? '' : String(v));

/**
 * Send one WhatsApp message to a lead. Resolves {status, body} for the HTTP
 * answer; never throws for a refusal or a provider error.
 */
export async function sendWhatsapp(input, { pb, twilio, logEvent, now = new Date(), publicUrl, from, accountSid }) {
  const leadId = str(input?.lead_id).trim();
  const clave = str(input?.plantilla).trim();
  const text = str(input?.text).trim();
  const given = input?.variables && typeof input.variables === 'object' ? input.variables : {};
  const actividadId = str(input?.actividad_id).trim() || null;
  const campanaId = str(input?.campana_id).trim() || null;
  const refuse = async (code, vars) => {
    const r = new Refusal(code, vars);
    await logEvent('whatsapp.refused', { lead_id: leadId || null, plantilla: clave || null, code });
    return { status: r.status, body: { ok: false, error: { code, text: r.text } } };
  };

  if (!leadId) return refuse('lead_required');
  let lead;
  try {
    lead = await pb('GET', `${records('leads')}/${encodeURIComponent(leadId)}`);
  } catch (e) {
    if (e.status === 404) return refuse('lead_unknown');
    throw e;
  }
  const idioma = locale(lead.idioma);

  let plantilla = null;
  if (clave) {
    const loaded = await loadTemplate(pb, clave, 'whatsapp');
    if (loaded.code) return refuse(loaded.code, { canal: 'whatsapp' });
    plantilla = loaded.plantilla;
  } else if (!text) {
    return refuse('template_required');
  }
  if (!plantilla && text.length > BODY_MAX) return refuse('text_too_long');

  // A caller-owned activity must exist and belong to this lead before anything is written.
  if (actividadId) {
    if (!PB_ID.test(actividadId)) return refuse('actividad_invalid');
    let act;
    try {
      act = await pb('GET', `${records('actividades')}/${encodeURIComponent(actividadId)}`);
    } catch (e) {
      if (e.status === 404) return refuse('actividad_invalid');
      throw e;
    }
    if (act.lead !== leadId) return refuse('actividad_invalid');
  }

  const to = leadPhoneE164(lead.telefono);
  if (!to) return refuse('no_phone');
  // The same gate as the email path, from the same module: marketing needs
  // consent, the consent request itself does not, and nobody who opted out is
  // written to. Outside the window Meta's approval still applies on top.
  const gate = consentGate(plantilla, lead);
  if (gate) return refuse(gate);

  const window = await insideWindow(pb, leadId, now);
  const names = plantilla ? variableNames(plantilla) : [];
  const values = plantilla ? { nombre: lead.nombre || '', ...given } : {};
  const picked = plantilla ? pick(plantilla, idioma) : null;

  let via; let message;
  if (window.inside) {
    if (plantilla) {
      const missing = missingVariables(names, values);
      if (missing.length) return refuse('variables_missing', { names: missing.join(', ') });
      message = { body: render(picked.cuerpo, values) };
    } else {
      message = { body: text };
    }
    via = 'free_text';
  } else {
    if (!plantilla) return refuse('outside_window');
    if (picked.contentEstado !== 'approved' || !picked.contentSid) {
      return refuse('template_not_approved', { estado: picked.contentEstado, idioma });
    }
    const missing = missingVariables(names, values);
    if (missing.length) return refuse('variables_missing', { names: missing.join(', ') });
    message = { contentSid: picked.contentSid, contentVariables: positional(names, values) };
    via = 'content';
  }
  const rendered = plantilla ? render(picked.cuerpo, values) : text;

  // -- the rows before the send ---------------------------------------------
  // A ledger that fails here is a 502 with the activity in error and a
  // send_failed event, never a 500 with a row left in registrado.
  let activity = actividadId;
  let envio;
  try {
    if (!activity) {
      const act = await pb('POST', records('actividades'), {
        lead: leadId, tipo: 'whatsapp', direccion: 'saliente',
        asunto: plantilla?.nombre || picked?.asunto || t(idioma, 'whatsapp_subject'),
        nota: rendered.slice(0, 2000), estado_envio: 'registrado',
        ...(campanaId ? { campana: campanaId } : {}),
      });
      activity = act.id;
    }
    envio = await pb('POST', records('envios'), {
      lead: leadId,
      ...(plantilla ? { plantilla: plantilla.id, plantilla_version: Number(plantilla.version) || 1 } : {}),
      ...(campanaId ? { campana: campanaId } : {}),
      actividad: activity, canal: 'whatsapp', estado: 'registrado', variables: values,
    });
  } catch (e) {
    console.error('ledger write failed before the send:', e.message);
    if (activity) await pb('PATCH', `${records('actividades')}/${encodeURIComponent(activity)}`, { estado_envio: 'error' }).catch(() => {});
    await safeLog(logEvent, 'whatsapp.send_failed', { lead_id: leadId, envio_id: null, plantilla: clave || null, code: 'ledger_unavailable' });
    return { status: 502, body: { ok: false, actividad_id: activity, estado: 'error', error: { code: 'ledger_unavailable', text: t(LEDGER_LOCALE, 'refusal.ledger_unavailable') } } };
  }

  // -- the send ------------------------------------------------------------------
  const req = buildSendMessage({ accountSid, from, to, ...message, statusCallback: `${publicUrl.replace(/\/$/, '')}/twilio-status` });
  let res;
  try {
    res = await twilio(req);
  } catch (e) {
    res = { status: 0, ok: false, data: { code: 'provider_unavailable', message: e.message } };
  }
  if (!res.ok) {
    const unavailable = res.status === 0 || res.status >= 500;
    const err = unavailable ? { code: 'provider_unavailable', text: t(LEDGER_LOCALE, 'refusal.provider_unavailable') } : twilioError(res.status, res.data);
    const errorTexto = unavailable ? err.text : errorText(err.code, err.text);
    try {
      await pb('PATCH', `${records('envios')}/${envio.id}`, {
        estado: 'error', error_en: now.toISOString(), error_codigo: err.code, error_texto: errorTexto,
      });
      await pb('PATCH', `${records('actividades')}/${encodeURIComponent(activity)}`, { estado_envio: 'error' });
    } catch (e) {
      console.error('ledger write failed after the refusal:', e.message);
    }
    await safeLog(logEvent, 'whatsapp.send_failed', { lead_id: leadId, envio_id: envio.id, plantilla: clave || null, code: err.code });
    return { status: 502, body: { ok: false, envio_id: envio.id, actividad_id: activity, estado: 'error', via, error: { code: err.code, text: errorTexto } } };
  }

  // -- the ledger after the SID: a failure here is reported, never hides the send --
  // From here on the answer is 200 whatever the ledger or the events table say.
  const sid = res.data?.sid ?? null;
  let recorded = true;
  try {
    await pb('PATCH', `${records('envios')}/${envio.id}`, { mensaje_id: sid, estado: 'enviado', enviado_en: now.toISOString() });
    await pb('PATCH', `${records('actividades')}/${encodeURIComponent(activity)}`, { estado_envio: 'enviado', mensaje_id: sid });
    await pb('PATCH', `${records('leads')}/${encodeURIComponent(leadId)}`, { ultimo_contacto: now.toISOString() });
  } catch (e) {
    recorded = false;
    await safeLog(logEvent, 'whatsapp.sent_unrecorded', { lead_id: leadId, envio_id: envio.id, mensaje_id: sid, error: String(e.message).slice(0, 200) });
  }
  await safeLog(logEvent, 'whatsapp.sent', { lead_id: leadId, envio_id: envio.id, plantilla: clave || null, via, mensaje_id: sid });
  return { status: 200, body: { ok: true, envio_id: envio.id, actividad_id: activity, mensaje_id: sid, estado: 'enviado', via, ...(recorded ? {} : { recorded: false }) } };
}

/**
 * Apply one Twilio status callback to the envios row that carries the SID
 * and to its activity. Resolves {updated, estado} or {skipped, reason}; the
 * server logs whatsapp.status_received with whatever this returns.
 */
export async function applyTwilioStatus(form, { pb, now = new Date() }) {
  const cb = parseStatusCallback(form);
  if (!cb.mensaje_id) return { skipped: true, reason: 'no message sid' };
  const estado = STATUS_MAP[cb.status];
  if (!estado) return { skipped: true, reason: 'unmapped status' };
  const found = await pb('GET', `${records('envios')}?perPage=1&filter=${encodeURIComponent(`mensaje_id = ${pbQuote(cb.mensaje_id)}`)}`);
  const row = found?.items?.[0];
  if (!row) return { skipped: true, reason: 'unknown message' };
  if (row.estado === 'simulado') return { skipped: true, reason: 'simulated', estado: row.estado };
  if (!moves(row.estado, estado)) return { skipped: true, reason: 'already further along', estado: row.estado };
  const patch = { estado };
  if (estado !== 'registrado') patch[`${estado}_en`] = now.toISOString();
  if (estado === 'error') {
    patch.error_codigo = cb.error_code ?? cb.status;
    patch.error_texto = errorText(cb.error_code ?? cb.status, cb.error_message ?? cb.status);
  }
  await pb('PATCH', `${records('envios')}/${row.id}`, patch);
  if (row.actividad) await pb('PATCH', `${records('actividades')}/${row.actividad}`, { estado_envio: estado });
  return { updated: row.id, estado };
}
