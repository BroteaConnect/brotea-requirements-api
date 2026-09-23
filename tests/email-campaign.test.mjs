// An email sent for a campaign carries the campaign on both of its rows, as a
// WhatsApp send does; an email sent for none is written exactly as before;
// and a campaign that is not one is refused before anything leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCampaign, sendTrackedEmail } from '../src/email.js';
import { NOW, fakePb } from './helpers/fake-pb.mjs';

const CAMPAIGN = 'abcdefghij12345';
const seed = () => fakePb({ leads: [{ id: 'lead1', idioma: 'es' }], campanas: [{ id: CAMPAIGN, nombre: 'Primavera' }] });
const mailer = () => {
  const mails = [];
  return { mails, sendMail: async (m) => { mails.push(m); return { response: '250 ok' }; } };
};
const input = { to: 'lead@example.com', subject: 'Hola', text: 'Cuerpo', leadId: 'lead1', idioma: 'es', plantilla: 'pl1', plantillaVersion: 3, variables: { nombre: 'Ana' } };

test('a send with campanaId stamps the campaign on the envios row and on the activity', async () => {
  const pb = seed();
  const { sendMail } = mailer();
  const out = await sendTrackedEmail({ ...input, campanaId: CAMPAIGN }, { pb, sendMail, now: NOW });
  const envio = pb.writesTo('envios', 'POST')[0].body;
  assert.equal(envio.campana, CAMPAIGN);
  assert.deepEqual(envio, {
    lead: 'lead1', plantilla: 'pl1', plantilla_version: 3, actividad: out.activity_id, campana: CAMPAIGN,
    canal: 'email', mensaje_id: out.message_id, estado: 'enviado', enviado_en: NOW.toISOString(), variables: { nombre: 'Ana' },
  });
  assert.equal(pb.writesTo('actividades', 'POST')[0].body.campana, CAMPAIGN);
});

test('a send without campanaId writes the same rows and the same mail as before, with no campana key', async () => {
  const pb = seed();
  const { mails, sendMail } = mailer();
  const out = await sendTrackedEmail(input, { pb, sendMail, now: NOW });
  const envio = pb.writesTo('envios', 'POST')[0].body;
  assert.deepEqual(envio, {
    lead: 'lead1', plantilla: 'pl1', plantilla_version: 3, actividad: out.activity_id,
    canal: 'email', mensaje_id: out.message_id, estado: 'enviado', enviado_en: NOW.toISOString(), variables: { nombre: 'Ana' },
  });
  assert.equal('campana' in envio, false);
  const act = pb.writesTo('actividades', 'POST')[0].body;
  assert.deepEqual(act, {
    lead: 'lead1', tipo: 'email', direccion: 'saliente', asunto: 'Hola', nota: 'Cuerpo',
    estado_envio: 'enviado', mensaje_id: out.message_id,
  });
  assert.equal(mails.length, 1);
  assert.equal(pb.reads.some((r) => r.collection === 'campanas'), false);
});

test('resolveCampaign: nothing named is no campaign and no PocketBase call', async () => {
  for (const value of [undefined, null, '', '   ']) {
    const pb = seed();
    assert.deepEqual(await resolveCampaign(value, { pb }), { campanaId: null });
    assert.equal(pb.reads.length, 0);
  }
});

test('resolveCampaign: an id that is not a PocketBase id is refused without a PocketBase call', async () => {
  for (const value of ['nope', 'abcdefghij1234', 'abcdefghij12345"||1=1', 123]) {
    const pb = seed();
    const r = await resolveCampaign(value, { pb });
    assert.equal(r.code, 'campana_invalid');
    assert.equal(r.status, 400);
    assert.equal(pb.reads.length, 0);
  }
});

test('resolveCampaign: a well-formed id that names no campaign is refused; one that does is kept', async () => {
  const pb = seed();
  const missing = await resolveCampaign('zzzzzzzzzzzzzzz', { pb });
  assert.equal(missing.code, 'campana_invalid');
  assert.deepEqual(await resolveCampaign(` ${CAMPAIGN} `, { pb }), { campanaId: CAMPAIGN });
  assert.equal(pb.writes.length, 0, 'resolving a campaign never writes');
});

test('resolveCampaign: a PocketBase failure other than 404 is not turned into a refusal', async () => {
  const pb = seed();
  pb.failOnce('GET', 'campanas', Object.assign(new Error('pb down'), { status: 500 }));
  await assert.rejects(resolveCampaign(CAMPAIGN, { pb }), /pb down/);
});
