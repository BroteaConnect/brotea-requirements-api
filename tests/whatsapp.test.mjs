import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTwilioStatus, errorText, sendWhatsapp } from '../src/whatsapp.js';
import { NOW, fakeEvents, fakePb, fakeTwilio, hoursAgo } from './helpers/fake-pb.mjs';

const HX_ES = 'HX' + 'a'.repeat(32);
const HX_EN = 'HX' + 'b'.repeat(32);
const lead = { id: 'lead1', nombre: 'María', telefono: '600 000 001', idioma: 'es', consentimiento: true };
const plantilla = {
  id: 'pl1', clave: 'visita.confirmacion', nombre: 'Confirmación de visita', canal: 'whatsapp', categoria: 'utility', estado: 'aprobada', version: 3,
  variables: ['nombre', 'propiedad', 'fecha', 'hora'],
  cuerpo_es: 'Hola {{nombre}}, te confirmamos la visita a {{propiedad}} el {{fecha}} a las {{hora}}.',
  cuerpo_en: 'Hi {{nombre}}, your visit to {{propiedad}} is confirmed for {{fecha}} at {{hora}}.',
  content_sid: HX_ES, content_estado: 'approved', content_sid_en: HX_EN, content_estado_en: 'received',
};
const marketing = { id: 'pl2', clave: 'propiedad.encaja', nombre: 'Te encaja', canal: 'whatsapp', categoria: 'marketing', estado: 'aprobada', version: 1, variables: ['nombre'], cuerpo_es: 'Hola {{nombre}}', cuerpo_en: 'Hi {{nombre}}', content_sid: HX_ES, content_estado: 'approved' };
const inbound = { id: 'act0', lead: 'lead1', tipo: 'whatsapp', direccion: 'entrante', created: hoursAgo(2) };
const vars = { propiedad: 'Piso en Mayor 3', fecha: 'lunes 5', hora: '10:00' };

function setup({ leads = [lead], plantillas = [plantilla, marketing], actividades = [inbound], script } = {}) {
  const pb = fakePb({ leads, plantillas, actividades });
  const twilio = fakeTwilio(script);
  const logEvent = fakeEvents();
  const ctx = { pb, twilio, logEvent, now: NOW, publicUrl: 'https://api.brotea.dev', from: 'whatsapp:+15554760953', accountSid: 'AC1' };
  return { pb, twilio, logEvent, ctx };
}

test('inside the window with a template: free text rendered, rows and events in order', async () => {
  const { pb, twilio, logEvent, ctx } = setup();
  const out = await sendWhatsapp({ lead_id: 'lead1', plantilla: 'visita.confirmacion', variables: vars }, ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.via, 'free_text');
  assert.equal(out.body.estado, 'enviado');
  assert.match(out.body.mensaje_id, /^SM/);
  const form = Object.fromEntries(twilio.calls[0].body);
  assert.equal(form.From, 'whatsapp:+15554760953');
  assert.equal(form.To, 'whatsapp:+34600000001');
  assert.equal(form.Body, 'Hola María, te confirmamos la visita a Piso en Mayor 3 el lunes 5 a las 10:00.');
  assert.equal(form.StatusCallback, 'https://api.brotea.dev/twilio-status');
  assert.equal(form.ContentSid, undefined);
  const w = pb.writes.map((x) => `${x.method} ${x.collection}`);
  assert.deepEqual(w, ['POST actividades', 'POST envios', 'PATCH envios', 'PATCH actividades', 'PATCH leads']);
  const act = pb.writes[0].body;
  assert.equal(act.tipo, 'whatsapp'); assert.equal(act.direccion, 'saliente'); assert.equal(act.estado_envio, 'registrado');
  assert.equal(act.asunto, 'Confirmación de visita'); assert.equal(act.nota, form.Body);
  const envio = pb.writes[1].body;
  assert.equal(envio.estado, 'registrado'); assert.equal(envio.canal, 'whatsapp'); assert.equal(envio.plantilla, 'pl1'); assert.equal(envio.plantilla_version, 3);
  assert.equal(envio.actividad, out.body.actividad_id);
  assert.deepEqual(Object.keys(pb.writes[2].body), ['mensaje_id', 'estado', 'enviado_en'], 'the SID lands in the same patch as enviado, first');
  assert.equal(pb.writes[2].body.mensaje_id, out.body.mensaje_id);
  assert.deepEqual(pb.writes[3].body, { estado_envio: 'enviado', mensaje_id: out.body.mensaje_id });
  assert.equal(pb.writes[4].body.ultimo_contacto, NOW.toISOString());
  assert.deepEqual(logEvent.events, [{ type: 'whatsapp.sent', payload: { lead_id: 'lead1', envio_id: out.body.envio_id, plantilla: 'visita.confirmacion', via: 'free_text', mensaje_id: out.body.mensaje_id } }]);
});

test('inside the window with free text only', async () => {
  const { pb, twilio, ctx } = setup();
  const out = await sendWhatsapp({ lead_id: 'lead1', text: 'Te llamo en 5 minutos' }, ctx);
  assert.equal(out.status, 200);
  assert.equal(Object.fromEntries(twilio.calls[0].body).Body, 'Te llamo en 5 minutos');
  assert.equal(pb.writes[0].body.asunto, 'WhatsApp');
  assert.equal(pb.writes[1].body.plantilla, undefined);
});

test('outside the window with an approved template: ContentSid + positional ContentVariables', async () => {
  const { pb, twilio, ctx } = setup({ actividades: [{ ...inbound, created: hoursAgo(30) }] });
  const out = await sendWhatsapp({ lead_id: 'lead1', plantilla: 'visita.confirmacion', variables: vars }, ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body.via, 'content');
  const form = Object.fromEntries(twilio.calls[0].body);
  assert.equal(form.ContentSid, HX_ES);
  assert.equal(form.Body, undefined);
  assert.deepEqual(JSON.parse(form.ContentVariables), { 1: 'María', 2: 'Piso en Mayor 3', 3: 'lunes 5', 4: '10:00' });
  assert.equal(pb.writes[0].body.nota, 'Hola María, te confirmamos la visita a Piso en Mayor 3 el lunes 5 a las 10:00.');
});

test('outside the window for an English lead uses the *_en pair and never switches language', async () => {
  const { logEvent, pb, ctx } = setup({ leads: [{ ...lead, idioma: 'en' }], actividades: [] });
  const out = await sendWhatsapp({ lead_id: 'lead1', plantilla: 'visita.confirmacion', variables: vars }, ctx);
  assert.equal(out.status, 422);
  assert.equal(out.body.error.code, 'template_not_approved');
  assert.match(out.body.error.text, /content_estado=received/);
  assert.match(out.body.error.text, /\ben\b/);
  assert.equal(pb.writes.length, 0);
  assert.deepEqual(logEvent.events, [{ type: 'whatsapp.refused', payload: { lead_id: 'lead1', plantilla: 'visita.confirmacion', code: 'template_not_approved' } }]);
});

test('outside the window with a template not yet approved → 422, no rows, whatsapp.refused', async () => {
  const { pb, logEvent, twilio, ctx } = setup({ plantillas: [{ ...plantilla, content_estado: 'pending' }], actividades: [] });
  const out = await sendWhatsapp({ lead_id: 'lead1', plantilla: 'visita.confirmacion', variables: vars }, ctx);
  assert.equal(out.status, 422);
  assert.equal(out.body.error.code, 'template_not_approved');
  assert.equal(pb.writes.length, 0);
  assert.equal(twilio.calls.length, 0);
  assert.equal(logEvent.of('whatsapp.refused').length, 1);
});

test('outside the window with free text → 422 outside_window', async () => {
  const { pb, ctx } = setup({ actividades: [] });
  const out = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, ctx);
  assert.equal(out.status, 422);
  assert.equal(out.body.error.code, 'outside_window');
  assert.equal(pb.writes.length, 0);
});

test('marketing without consent → 422 no_consent; utility without consent is sent', async () => {
  const noConsent = { ...lead, consentimiento: false };
  const a = setup({ leads: [noConsent] });
  const r1 = await sendWhatsapp({ lead_id: 'lead1', plantilla: 'propiedad.encaja' }, a.ctx);
  assert.equal(r1.status, 422);
  assert.equal(r1.body.error.code, 'no_consent');
  assert.equal(a.pb.writes.length, 0);
  const b = setup({ leads: [noConsent] });
  const r2 = await sendWhatsapp({ lead_id: 'lead1', plantilla: 'visita.confirmacion', variables: vars }, b.ctx);
  assert.equal(r2.status, 200);
});

test('no phone or an ambiguous phone → 422 no_phone', async () => {
  for (const telefono of ['', '12345', '+0034600', 'llámame']) {
    const { pb, ctx } = setup({ leads: [{ ...lead, telefono }] });
    const out = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, ctx);
    assert.equal(out.status, 422, telefono);
    assert.equal(out.body.error.code, 'no_phone');
    assert.equal(pb.writes.length, 0);
  }
});

test('the template problems and the input problems have their own codes', async () => {
  const cases = [
    [{ lead_id: 'lead1', plantilla: 'nope' }, 404, 'template_unknown'],
    [{ lead_id: 'lead1', plantilla: 'visita.confirmacion', variables: { propiedad: 'x' } }, 400, 'variables_missing'],
    [{ lead_id: 'lead1', text: 'x'.repeat(1601) }, 400, 'text_too_long'],
    [{ lead_id: 'lead1' }, 400, 'template_required'],
    [{ lead_id: 'nobody', text: 'hola' }, 404, 'lead_unknown'],
    [{ text: 'hola' }, 400, 'lead_required'],
  ];
  for (const [input, status, code] of cases) {
    const { ctx, pb } = setup({ plantillas: [plantilla] });
    const out = await sendWhatsapp(input, ctx);
    assert.equal(out.status, status, code);
    assert.equal(out.body.error.code, code);
    assert.equal(pb.writes.length, 0);
  }
  const { ctx } = setup({ plantillas: [{ ...plantilla, canal: 'email' }] });
  assert.equal((await sendWhatsapp({ lead_id: 'lead1', plantilla: 'visita.confirmacion' }, ctx)).body.error.code, 'template_channel');
  const retired = setup({ plantillas: [{ ...plantilla, estado: 'retirada' }] });
  assert.equal((await sendWhatsapp({ lead_id: 'lead1', plantilla: 'visita.confirmacion' }, retired.ctx)).body.error.code, 'template_retired');
});

test('with actividad_id the activity is only patched and its nota is untouched', async () => {
  const ACT = 'actbot000000001';
  const mine = { id: ACT, lead: 'lead1', tipo: 'whatsapp', direccion: 'saliente', nota: 'written by the bot', estado_envio: 'registrado' };
  const { pb, ctx } = setup({ actividades: [inbound, mine] });
  const out = await sendWhatsapp({ lead_id: 'lead1', plantilla: 'visita.confirmacion', variables: vars, actividad_id: ACT }, ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body.actividad_id, ACT);
  assert.equal(pb.writesTo('actividades', 'POST').length, 0);
  assert.equal(pb.row('actividades', ACT).nota, 'written by the bot');
  assert.equal(pb.row('actividades', ACT).estado_envio, 'enviado');
  assert.equal(pb.writes[0].body.actividad, ACT);
});

test('Twilio 400 63016 → envios error with the code verbatim, 502, whatsapp.send_failed', async () => {
  const { pb, logEvent, ctx } = setup({ script: [{ status: 400, data: { code: 63016, message: 'Failed to send freeform message to whatsapp:+34600000001', status: 400 } }] });
  const out = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, ctx);
  assert.equal(out.status, 502);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.estado, 'error');
  assert.equal(out.body.error.code, '63016');
  assert.doesNotMatch(out.body.error.text, /600000001/);
  const envio = pb.row('envios', out.body.envio_id);
  assert.equal(envio.estado, 'error');
  assert.equal(envio.error_codigo, '63016');
  assert.equal(envio.error_en, NOW.toISOString());
  assert.equal(envio.error_texto, errorText('63016'));
  assert.equal(envio.mensaje_id, undefined);
  assert.equal(pb.row('actividades', out.body.actividad_id).estado_envio, 'error');
  assert.deepEqual(logEvent.events, [{ type: 'whatsapp.send_failed', payload: { lead_id: 'lead1', envio_id: out.body.envio_id, plantilla: null, code: '63016' } }]);
});

test('a timeout or a 5xx → provider_unavailable', async () => {
  const a = setup({ script: [{ error: new Error('The operation was aborted due to timeout') }] });
  const r1 = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, a.ctx);
  assert.equal(r1.status, 502);
  assert.equal(r1.body.error.code, 'provider_unavailable');
  assert.equal(a.pb.row('envios', r1.body.envio_id).error_codigo, 'provider_unavailable');
  const b = setup({ script: [{ status: 503, data: {} }] });
  const r2 = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, b.ctx);
  assert.equal(r2.body.error.code, 'provider_unavailable');
});

test('a ledger failure after the SID → 200 with recorded:false and whatsapp.sent_unrecorded', async () => {
  const { pb, logEvent, ctx } = setup();
  pb.failOnce('PATCH', 'envios', new Error('pb PATCH: 500 down'));
  const out = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body.recorded, false);
  assert.match(out.body.mensaje_id, /^SM/);
  assert.deepEqual(logEvent.events.map((e) => e.type), ['whatsapp.sent_unrecorded', 'whatsapp.sent']);
  assert.equal(logEvent.events[0].payload.mensaje_id, out.body.mensaje_id);
});

test('once a SID exists the answer is 200 even when the events table is down', async () => {
  const { pb, ctx } = setup();
  let calls = 0;
  ctx.logEvent = async () => { calls++; throw new Error('postgres down'); };
  const out = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(calls, 1, 'whatsapp.sent was attempted');
  assert.equal(pb.row('envios', out.body.envio_id).estado, 'enviado');
  // The provider error path is a 502 with its rows, not a 500, when the events table is down.
  const { ctx: c2, pb: pb2 } = setup({ script: [{ status: 400, data: { code: 63024, message: 'bad' } }] });
  c2.logEvent = async () => { throw new Error('postgres down'); };
  const failed = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, c2);
  assert.equal(failed.status, 502);
  assert.equal(pb2.row('envios', failed.body.envio_id).error_codigo, '63024');
});

test('a caller-owned activity must be a PocketBase id, exist, and belong to the lead', async () => {
  const other = { id: 'actOtherLead000', lead: 'lead2', tipo: 'whatsapp', direccion: 'saliente', estado_envio: 'registrado' };
  for (const actividad_id of ['../records', 'nope', 'actOtherLead000', 'act000000000000']) {
    const { pb, ctx, logEvent } = setup({ actividades: [inbound, other] });
    const out = await sendWhatsapp({ lead_id: 'lead1', text: 'hola', actividad_id }, ctx);
    assert.equal(out.status, 400, actividad_id);
    assert.equal(out.body.error.code, 'actividad_invalid');
    assert.equal(pb.writes.length, 0);
    assert.equal(logEvent.of('whatsapp.refused')[0].payload.code, 'actividad_invalid');
  }
});

test('a ledger failure before the send is a 502 ledger_unavailable with the activity in error and nothing sent', async () => {
  const { pb, twilio, logEvent, ctx } = setup();
  pb.failOnce('POST', 'envios', new Error('pb POST: 503'));
  const out = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, ctx);
  assert.equal(out.status, 502);
  assert.equal(out.body.error.code, 'ledger_unavailable');
  assert.equal(twilio.calls.length, 0);
  assert.equal(pb.row('actividades', out.body.actividad_id).estado_envio, 'error');
  assert.deepEqual(logEvent.events, [{ type: 'whatsapp.send_failed', payload: { lead_id: 'lead1', envio_id: null, plantilla: null, code: 'ledger_unavailable' } }]);
  // The activity itself failing: nothing created, same answer.
  const b = setup();
  b.pb.failOnce('POST', 'actividades');
  const r2 = await sendWhatsapp({ lead_id: 'lead1', text: 'hola' }, b.ctx);
  assert.equal(r2.status, 502);
  assert.equal(r2.body.actividad_id, null);
  assert.equal(b.pb.writes.length, 0);
});

test('errorText: a known code gives our sentence, an unknown one the provider message', () => {
  assert.notEqual(errorText('63024', 'x'), 'x');
  assert.equal(errorText('99999', 'Something the provider said'), 'Something the provider said');
});

// -- applyTwilioStatus ------------------------------------------------------------
const SID = 'SM' + '1'.repeat(32);
const ledger = () => fakePb({
  envios: [{ id: 'env1', lead: 'lead1', actividad: 'act1', canal: 'whatsapp', estado: 'enviado', mensaje_id: SID }],
  actividades: [{ id: 'act1', lead: 'lead1', estado_envio: 'enviado', mensaje_id: SID }],
});

test('delivered after enviado stamps entregado_en and moves the activity', async () => {
  const pb = ledger();
  const r = await applyTwilioStatus({ MessageSid: SID, MessageStatus: 'delivered' }, { pb, now: NOW });
  assert.deepEqual(r, { updated: 'env1', estado: 'entregado' });
  assert.deepEqual(pb.writes[0].body, { estado: 'entregado', entregado_en: NOW.toISOString() });
  assert.deepEqual(pb.writes[1], { method: 'PATCH', collection: 'actividades', id: 'act1', body: { estado_envio: 'entregado' } });
});

test('sent after entregado skips; the same callback twice skips the second', async () => {
  const pb = ledger();
  pb.row('envios', 'env1').estado = 'entregado';
  const r = await applyTwilioStatus({ MessageSid: SID, MessageStatus: 'sent' }, { pb, now: NOW });
  assert.deepEqual(r, { skipped: true, reason: 'already further along', estado: 'entregado' });
  assert.equal(pb.writes.length, 0);
  const first = await applyTwilioStatus({ MessageSid: SID, MessageStatus: 'read' }, { pb, now: NOW });
  assert.equal(first.updated, 'env1');
  const second = await applyTwilioStatus({ MessageSid: SID, MessageStatus: 'read' }, { pb, now: NOW });
  assert.equal(second.skipped, true);
  assert.equal(pb.row('envios', 'env1').abierto_en, NOW.toISOString());
});

test('failed with an ErrorCode writes error_codigo and a sentence', async () => {
  const pb = ledger();
  const r = await applyTwilioStatus({ MessageSid: SID, MessageStatus: 'failed', ErrorCode: '63024' }, { pb, now: NOW });
  assert.equal(r.estado, 'error');
  const row = pb.row('envios', 'env1');
  assert.equal(row.error_codigo, '63024');
  assert.equal(row.error_texto, errorText('63024'));
  assert.equal(row.error_en, NOW.toISOString());
  assert.equal(pb.row('actividades', 'act1').estado_envio, 'error');
});

test('an unknown SID, a simulated row and an unmapped status are skipped by name', async () => {
  const pb = ledger();
  assert.deepEqual(await applyTwilioStatus({ MessageSid: 'SM' + '0'.repeat(32), MessageStatus: 'delivered' }, { pb }), { skipped: true, reason: 'unknown message' });
  pb.row('envios', 'env1').estado = 'simulado';
  assert.equal((await applyTwilioStatus({ MessageSid: SID, MessageStatus: 'delivered' }, { pb })).reason, 'simulated');
  assert.equal((await applyTwilioStatus({ MessageSid: SID, MessageStatus: 'received' }, { pb })).reason, 'unmapped status');
  assert.equal((await applyTwilioStatus({ MessageStatus: 'delivered' }, { pb })).reason, 'no message sid');
  assert.equal(pb.writes.length, 0);
});
