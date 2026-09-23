import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBrevoEvent, sendTrackedEmail } from '../src/email.js';
import { t } from '../src/copy.js';
import { NOW, fakePb } from './helpers/fake-pb.mjs';

const MID = '<lead-lead1-abcdef0123456789@brotea.dev>';
const ledger = () => fakePb({
  actividades: [{ id: 'act1', lead: 'lead1', tipo: 'email', estado_envio: 'enviado', mensaje_id: MID }],
  envios: [{ id: 'env1', lead: 'lead1', actividad: 'act1', canal: 'email', estado: 'enviado', mensaje_id: MID }],
});

test('applyBrevoEvent updates envios and actividades together under the rank rule', async () => {
  const pb = ledger();
  const r = await applyBrevoEvent({ event: 'delivered', 'message-id': MID }, { pb, now: NOW });
  assert.deepEqual(r, { updated: 'act1', estado: 'entregado', envio: { updated: 'env1', estado: 'entregado' } });
  assert.deepEqual(pb.writes, [
    { method: 'PATCH', collection: 'actividades', id: 'act1', body: { estado_envio: 'entregado' } },
    { method: 'PATCH', collection: 'envios', id: 'env1', body: { estado: 'entregado', entregado_en: NOW.toISOString() } },
  ]);
  // A late "delivered" after "opened" is skipped on both.
  const opened = await applyBrevoEvent({ event: 'opened', 'message-id': MID }, { pb, now: NOW });
  assert.equal(opened.envio.updated, 'env1');
  const late = await applyBrevoEvent({ event: 'delivered', 'message-id': MID }, { pb, now: NOW });
  assert.equal(late.skipped, true);
  assert.equal(late.envio.skipped, true);
  const row = pb.row('envios', 'env1');
  assert.equal(row.entregado_en, NOW.toISOString());
  assert.equal(row.abierto_en, NOW.toISOString());
  assert.equal(row.estado, 'abierto');
});

test('hard_bounce → error with error_codigo hard_bounce and the reason as text', async () => {
  const pb = ledger();
  const r = await applyBrevoEvent({ event: 'hard_bounce', 'message-id': MID, reason: 'mailbox does not exist' }, { pb, now: NOW });
  assert.equal(r.envio.estado, 'error');
  const row = pb.row('envios', 'env1');
  assert.equal(row.error_codigo, 'hard_bounce');
  assert.equal(row.error_texto, 'mailbox does not exist');
  assert.equal(row.error_en, NOW.toISOString());
  assert.equal(pb.row('actividades', 'act1').estado_envio, 'error');
});

test('an envios row without an activity, and an activity without a row, are each reported by name', async () => {
  const pb = fakePb({ envios: [{ id: 'env1', canal: 'email', estado: 'enviado', mensaje_id: MID }] });
  const r = await applyBrevoEvent({ event: 'delivered', 'message-id': MID }, { pb, now: NOW });
  assert.deepEqual(r, { skipped: true, reason: 'activity not found', envio: { updated: 'env1', estado: 'entregado' } });
  const only = fakePb({ actividades: [{ id: 'act1', estado_envio: 'enviado', mensaje_id: MID }] });
  const r2 = await applyBrevoEvent({ event: 'click', 'message-id': MID }, { pb: only, now: NOW });
  assert.deepEqual(r2, { updated: 'act1', estado: 'click', envio: { skipped: true, reason: 'unknown message' } });
  assert.deepEqual(await applyBrevoEvent({ event: 'request', 'message-id': MID }, { pb }), { skipped: true, event: 'request' });
});

test('a simulated send is never moved by a delivery event, on either side', async () => {
  const pb = fakePb({
    actividades: [{ id: 'act1', estado_envio: 'simulado', mensaje_id: MID }],
    envios: [{ id: 'env1', actividad: 'act1', canal: 'email', estado: 'simulado', mensaje_id: MID }],
  });
  const r = await applyBrevoEvent({ event: 'delivered', 'message-id': MID }, { pb, now: NOW });
  assert.deepEqual(r, { skipped: true, reason: 'simulated', estado: 'simulado', envio: { skipped: true, reason: 'simulated', estado: 'simulado' } });
  assert.equal(pb.writes.length, 0);
});

test('sendTrackedEmail appends the opt-out footer, writes the activity and the envios row', async () => {
  const pb = fakePb({ leads: [{ id: 'lead1', idioma: 'en' }] });
  const mails = [];
  const sendMail = async (m) => { mails.push(m); return { response: '250 ok' }; };
  const out = await sendTrackedEmail({
    to: 'lead@example.com', subject: 'Hi', text: 'Body', leadId: 'lead1', idioma: 'en',
    plantilla: 'pl1', plantillaVersion: 2, variables: { nombre: 'Mary' }, bajaUrl: 'https://api.brotea.dev/baja?lead=lead1&t=tok',
  }, { pb, sendMail, now: NOW });
  assert.match(out.message_id, /^<lead-lead1-[0-9a-f]{16}@brotea\.dev>$/);
  assert.equal(out.activity_id, 'act001'.slice(0, 3) + out.activity_id.slice(3));
  assert.ok(out.envio_id);
  assert.equal(out.smtp, '250 ok');
  assert.equal(mails[0].text, `Body\n\n${t('en', 'email_footer_baja', { url: 'https://api.brotea.dev/baja?lead=lead1&t=tok' })}`);
  assert.match(mails[0].html, /api\.brotea\.dev\/baja/);
  assert.equal(mails[0].messageId, out.message_id);
  const envio = pb.writesTo('envios', 'POST')[0].body;
  assert.deepEqual(envio, { lead: 'lead1', plantilla: 'pl1', plantilla_version: 2, actividad: out.activity_id, canal: 'email', mensaje_id: out.message_id, estado: 'enviado', enviado_en: NOW.toISOString(), variables: { nombre: 'Mary' } });
  assert.equal(pb.writesTo('actividades', 'POST')[0].body.nota, 'Body', 'the activity keeps the text without the footer');
  // No lead: no footer, no activity, still a ledger row.
  const anon = await sendTrackedEmail({ to: 'x@example.com', subject: 'S', text: 'T', bajaUrl: 'https://x' }, { pb, sendMail, now: NOW });
  assert.equal(mails[1].text, 'T');
  assert.equal(anon.activity_id, null);
  assert.ok(anon.envio_id);
});

test('a failed envios write never fails the send', async () => {
  const pb = fakePb({ leads: [{ id: 'lead1' }] });
  pb.failOnce('POST', 'envios');
  const out = await sendTrackedEmail({ to: 'a@example.com', subject: 'S', text: 'T', leadId: 'lead1' }, { pb, sendMail: async () => ({ response: 'ok' }), now: NOW });
  assert.equal(out.envio_id, null);
  assert.ok(out.activity_id);
});
