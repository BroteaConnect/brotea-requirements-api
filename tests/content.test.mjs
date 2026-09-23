import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentName, sampleVariables, submitContent, syncContent } from '../src/content.js';
import { fakeEvents, fakePb, fakeTwilio } from './helpers/fake-pb.mjs';

const HX_ES = 'HX' + 'a'.repeat(32);
const HX_EN = 'HX' + 'b'.repeat(32);
const row = {
  id: 'pl1', clave: 'visita.confirmacion', nombre: 'Confirmación de visita', canal: 'whatsapp', categoria: 'utility', version: 3,
  variables: ['nombre', 'propiedad', 'fecha', 'hora'],
  cuerpo_es: 'Hola {{nombre}}, visita a {{propiedad}} el {{fecha}} a las {{hora}}.',
  cuerpo_en: 'Hi {{nombre}}, visit to {{propiedad}} on {{fecha}} at {{hora}}.',
  content_estado: 'unsubmitted',
};
const created = (sid) => ({ status: 201, data: { sid } });
const approved = (status = 'received') => ({ status: 201, data: { status, rejection_reason: '' } });

test('contentName is unique per clave, language and version and matches Meta\'s charset', () => {
  assert.equal(contentName('visita.confirmacion', 'es', 3), 'visita_confirmacion_es_v3');
  assert.equal(contentName('Lead-Nuevo', 'en', undefined), 'lead_nuevo_en_v1');
  assert.match(contentName('propiedad.encaja', 'es', 12), /^[a-z0-9_]+$/);
});

test('sampleVariables covers every declared name, positionally, with a default for the unknown', () => {
  const s = sampleVariables(['nombre', 'propiedad', 'cosa_rara'], 'es');
  assert.deepEqual(Object.keys(s), ['1', '2', '3']);
  assert.equal(s['1'], 'María');
  assert.equal(s['3'], 'ejemplo');
  assert.equal(sampleVariables(['nombre'], 'en')['1'], 'Mary');
});

test('submit creates es then en, requests both approvals, patches sids and estados, logs content.submitted', async () => {
  const pb = fakePb({ plantillas: [row] });
  const twilio = fakeTwilio([created(HX_ES), approved(), created(HX_EN), approved()]);
  const logEvent = fakeEvents();
  const out = await submitContent({ clave: 'visita.confirmacion' }, { pb, twilio, logEvent });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, clave: 'visita.confirmacion', content_sid: HX_ES, content_sid_en: HX_EN, content_estado: 'received', content_estado_en: 'received' });
  assert.deepEqual(twilio.calls.map((c) => c.url), [
    'https://content.twilio.com/v1/Content',
    `https://content.twilio.com/v1/Content/${HX_ES}/ApprovalRequests/whatsapp`,
    'https://content.twilio.com/v1/Content',
    `https://content.twilio.com/v1/Content/${HX_EN}/ApprovalRequests/whatsapp`,
  ]);
  const es = twilio.calls[0].body;
  assert.equal(es.friendly_name, 'visita_confirmacion_es_v3');
  assert.equal(es.language, 'es');
  assert.equal(es.types['twilio/text'].body, 'Hola {{1}}, visita a {{2}} el {{3}} a las {{4}}.');
  assert.deepEqual(Object.keys(es.variables), ['1', '2', '3', '4']);
  assert.deepEqual(twilio.calls[1].body, { name: 'visita_confirmacion_es_v3', category: 'UTILITY' });
  const en = twilio.calls[2].body;
  assert.equal(en.friendly_name, 'visita_confirmacion_en_v3');
  assert.equal(en.language, 'en');
  assert.equal(en.types['twilio/text'].body, 'Hi {{1}}, visit to {{2}} on {{3}} at {{4}}.');
  assert.deepEqual(pb.writes, [{ method: 'PATCH', collection: 'plantillas', id: 'pl1', body: {
    content_sid: HX_ES, content_estado: 'received', content_motivo: '', content_sid_en: HX_EN, content_estado_en: 'received', content_motivo_en: '',
  } }]);
  assert.deepEqual(logEvent.events, [{ type: 'content.submitted', payload: { clave: 'visita.confirmacion', content_sid: HX_ES, content_sid_en: HX_EN } }]);
});

test('a marketing row asks for the MARKETING category, never the other way round', async () => {
  const pb = fakePb({ plantillas: [{ ...row, categoria: 'marketing' }] });
  const twilio = fakeTwilio([created(HX_ES), approved(), created(HX_EN), approved()]);
  await submitContent({ clave: 'visita.confirmacion' }, { pb, twilio, logEvent: fakeEvents() });
  assert.equal(twilio.calls[1].body.category, 'MARKETING');
});

test('401 → class provider_auth, no PATCH, content.submit_failed', async () => {
  const pb = fakePb({ plantillas: [row] });
  const twilio = fakeTwilio([{ status: 401, data: { code: 20003, message: 'Authenticate' } }]);
  const logEvent = fakeEvents();
  const out = await submitContent({ clave: 'visita.confirmacion' }, { pb, twilio, logEvent });
  assert.equal(out.status, 502);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.error.class, 'provider_auth');
  assert.equal(out.body.error.code, 'provider_auth');
  assert.ok(out.body.error.text);
  assert.equal(pb.writes.length, 0);
  assert.deepEqual(logEvent.events, [{ type: 'content.submit_failed', payload: { clave: 'visita.confirmacion', class: 'provider_auth', status: 401, code: 20003 } }]);
});

test('a 400 naming the WhatsApp Business Account → sender_not_ready; another 400 → template_invalid', async () => {
  const a = fakePb({ plantillas: [row] });
  const r1 = await submitContent({ clave: 'visita.confirmacion' }, { pb: a, twilio: fakeTwilio([created(HX_ES), { status: 400, data: { message: 'No WhatsApp Business Account is associated with this account' } }]), logEvent: fakeEvents() });
  assert.equal(r1.body.error.class, 'sender_not_ready');
  // The Content exists: its sid stays on the row so a retry does not create a duplicate name.
  assert.equal(a.row('plantillas', 'pl1').content_sid, HX_ES);
  assert.equal(a.row('plantillas', 'pl1').content_estado, 'unsubmitted');
  const b = fakePb({ plantillas: [row] });
  const r2 = await submitContent({ clave: 'visita.confirmacion' }, { pb: b, twilio: fakeTwilio([{ status: 400, data: { message: 'Invalid body' } }]), logEvent: fakeEvents() });
  assert.equal(r2.body.error.class, 'template_invalid');
  assert.equal(b.writes.length, 0);
});

test('a pending row → already_submitted; a half-submitted row only submits the missing language', async () => {
  const pending = fakePb({ plantillas: [{ ...row, content_sid: HX_ES, content_estado: 'pending', content_sid_en: HX_EN, content_estado_en: 'approved' }] });
  const twilio = fakeTwilio();
  const r1 = await submitContent({ clave: 'visita.confirmacion' }, { pb: pending, twilio, logEvent: fakeEvents() });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.error.class, 'already_submitted');
  assert.equal(twilio.calls.length, 0);
  const half = fakePb({ plantillas: [{ ...row, content_sid: HX_ES, content_estado: 'approved' }] });
  const t2 = fakeTwilio([created(HX_EN), approved()]);
  const r2 = await submitContent({ clave: 'visita.confirmacion' }, { pb: half, twilio: t2, logEvent: fakeEvents() });
  assert.equal(r2.status, 200);
  assert.equal(t2.calls[0].body.language, 'en');
  assert.deepEqual(half.writes[0].body, { content_sid_en: HX_EN, content_estado_en: 'received', content_motivo_en: '' });
  assert.equal(r2.body.content_estado, 'approved');
});

const fetched = (sid, friendly_name) => ({ status: 200, data: { sid, friendly_name } });

test('a retry after a failed approval reuses the Content instead of creating another', async () => {
  const pb = fakePb({ plantillas: [{ ...row, content_sid: HX_ES, content_estado: 'unsubmitted', content_motivo: 'earlier failure' }] });
  const twilio = fakeTwilio([fetched(HX_ES, 'visita_confirmacion_es_v3'), approved(), created(HX_EN), approved()]);
  const out = await submitContent({ clave: 'visita.confirmacion' }, { pb, twilio, logEvent: fakeEvents() });
  assert.equal(out.status, 200);
  assert.deepEqual(twilio.calls.map((c) => `${c.method} ${c.url}`), [
    `GET https://content.twilio.com/v1/Content/${HX_ES}`,
    `POST https://content.twilio.com/v1/Content/${HX_ES}/ApprovalRequests/whatsapp`,
    'POST https://content.twilio.com/v1/Content',
    `POST https://content.twilio.com/v1/Content/${HX_EN}/ApprovalRequests/whatsapp`,
  ]);
  assert.equal(twilio.calls[1].body.name, 'visita_confirmacion_es_v3');
  assert.equal(pb.row('plantillas', 'pl1').content_sid, HX_ES, 'the sid did not change');
  assert.equal(pb.row('plantillas', 'pl1').content_estado, 'received');
  assert.equal(pb.row('plantillas', 'pl1').content_motivo, '');
});

test('a rejected row is refused with version_unchanged until the version moves past the name, then submitted anew', async () => {
  const rejected = { ...row, content_sid: HX_ES, content_estado: 'rejected', content_motivo: 'INVALID_FORMAT', content_sid_en: HX_EN, content_estado_en: 'approved' };
  const same = fakePb({ plantillas: [rejected] });
  const t1 = fakeTwilio([fetched(HX_ES, 'visita_confirmacion_es_v3')]);
  const logEvent = fakeEvents();
  const r1 = await submitContent({ clave: 'visita.confirmacion' }, { pb: same, twilio: t1, logEvent });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.error.class, 'version_unchanged');
  assert.match(r1.body.error.text, /visita_confirmacion_es_v3/);
  assert.equal(t1.calls.length, 1, 'only the fetch; nothing created');
  assert.equal(same.writes.length, 0);
  assert.equal(logEvent.events[0].payload.class, 'version_unchanged');
  const bumped = fakePb({ plantillas: [{ ...rejected, version: 4 }] });
  const t2 = fakeTwilio([fetched(HX_ES, 'visita_confirmacion_es_v3'), created('HX' + 'd'.repeat(32)), approved()]);
  const r2 = await submitContent({ clave: 'visita.confirmacion' }, { pb: bumped, twilio: t2, logEvent: fakeEvents() });
  assert.equal(r2.status, 200);
  assert.equal(t2.calls[1].body.friendly_name, 'visita_confirmacion_es_v4');
  assert.equal(bumped.row('plantillas', 'pl1').content_sid, 'HX' + 'd'.repeat(32));
  // A Content Twilio no longer has (404) is simply recreated.
  const gone = fakePb({ plantillas: [{ ...row, content_sid: HX_ES, content_estado: 'unsubmitted' }] });
  const t3 = fakeTwilio([{ status: 404, data: {} }, created(HX_ES), approved(), created(HX_EN), approved()]);
  assert.equal((await submitContent({ clave: 'visita.confirmacion' }, { pb: gone, twilio: t3, logEvent: fakeEvents() })).status, 200);
  assert.equal(t3.calls[1].method, 'POST');
});

test('an unknown clave or an email row is refused before Twilio', async () => {
  const pb = fakePb({ plantillas: [{ ...row, canal: 'email' }] });
  const twilio = fakeTwilio();
  assert.equal((await submitContent({ clave: 'nope' }, { pb, twilio, logEvent: fakeEvents() })).status, 404);
  assert.equal((await submitContent({ clave: 'visita.confirmacion' }, { pb, twilio, logEvent: fakeEvents() })).status, 400);
  assert.equal(twilio.calls.length, 0);
});

const listing = (contents, next = null) => ({ status: 200, data: { contents, meta: { next_page_url: next } } });

test('sync updates only changed rows, writes content_motivo from rejection_reason, pages the listing', async () => {
  const pb = fakePb({ plantillas: [
    { ...row, id: 'pl1', content_sid: HX_ES, content_estado: 'received', content_sid_en: HX_EN, content_estado_en: 'received' },
    { ...row, id: 'pl2', clave: 'lead.nuevo', content_sid: 'HX' + 'c'.repeat(32), content_estado: 'approved' },
    { ...row, id: 'pl3', clave: 'sin.enviar' },
  ] });
  const twilio = fakeTwilio([
    listing([{ sid: HX_ES, approval_requests: { status: 'approved', rejection_reason: '' } }], 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=100&PageToken=PAxyz'),
    listing([
      { sid: HX_EN, approval_requests: { status: 'rejected', rejection_reason: 'INVALID_FORMAT: placeholders' } },
      { sid: 'HX' + 'c'.repeat(32), approval_requests: { status: 'approved', rejection_reason: '' } },
    ]),
  ]);
  const logEvent = fakeEvents();
  const out = await syncContent({}, { pb, twilio, logEvent });
  assert.equal(out.status, 200);
  assert.equal(twilio.calls.length, 2);
  assert.match(twilio.calls[1].url, /PageToken=PAxyz/);
  assert.deepEqual(pb.writes, [{ method: 'PATCH', collection: 'plantillas', id: 'pl1', body: { content_estado: 'approved', content_estado_en: 'rejected', content_motivo_en: 'INVALID_FORMAT: placeholders' } }]);
  assert.deepEqual(out.body, { ok: true, checked: 2, updated: [{ clave: 'visita.confirmacion', content_estado: 'approved', content_estado_en: 'rejected', content_motivo_en: 'INVALID_FORMAT: placeholders' }] });
  assert.deepEqual(logEvent.events, [{ type: 'content.synced', payload: { updated: [{ clave: 'visita.confirmacion', content_estado: 'approved', content_estado_en: 'rejected' }], checked: 2 } }]);
});

test('sync with a clave reads one row; nothing changed → empty updated; a provider failure is classified', async () => {
  const pb = fakePb({ plantillas: [
    { ...row, id: 'pl1', content_sid: HX_ES, content_estado: 'approved' },
    { ...row, id: 'pl2', clave: 'lead.nuevo', content_sid: 'HX' + 'c'.repeat(32), content_estado: 'received' },
  ] });
  const twilio = fakeTwilio([listing([{ sid: HX_ES, approval_requests: { status: 'approved' } }, { sid: 'HX' + 'c'.repeat(32), approval_requests: { status: 'approved' } }])]);
  const out = await syncContent({ clave: 'visita.confirmacion' }, { pb, twilio, logEvent: fakeEvents() });
  assert.deepEqual(out.body, { ok: true, updated: [], checked: 1 });
  assert.match(pb.reads.at(-1).query, /clave = "visita\.confirmacion"/);
  assert.equal(pb.writes.length, 0);
  const logEvent = fakeEvents();
  const down = await syncContent({}, { pb, twilio: fakeTwilio([{ error: new Error('timeout') }]), logEvent });
  assert.equal(down.status, 502);
  assert.equal(down.body.error.class, 'provider_unavailable');
  assert.equal(logEvent.events[0].type, 'content.sync_failed');
});
