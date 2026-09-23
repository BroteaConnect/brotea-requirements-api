import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  CONSENT_REQUEST_EVENT, LINK_NAMES, bajaToken, bajaUrl, consentGate, consentText, grantByEmail, isConsentRequest,
  linkVariables, redactLinks, redactedValues, revokeByEmail, siToken, siUrl, validBajaToken, validSiToken, withoutLinks,
} from '../src/consent.js';
import { bajaPage, siPage } from '../src/baja.js';
import { t } from '../src/copy.js';
import { NOW, fakeEvents, fakePb } from './helpers/fake-pb.mjs';

test('the token round-trips and a tampered one is invalid', () => {
  const tok = bajaToken('lead1', 's3cret');
  assert.match(tok, /^[A-Za-z0-9_-]+$/);
  assert.ok(validBajaToken('lead1', tok, 's3cret'));
  assert.ok(!validBajaToken('lead2', tok, 's3cret'));
  assert.ok(!validBajaToken('lead1', tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A'), 's3cret'));
  assert.ok(!validBajaToken('lead1', tok, 'other'));
  assert.ok(!validBajaToken('lead1', '', 's3cret'));
  assert.ok(!validBajaToken('', tok, 's3cret'));
  assert.ok(!validBajaToken('lead1', tok, ''));
});

test('bajaUrl points at /baja on the public origin with the lead and its token', () => {
  const u = new URL(bajaUrl('https://api.brotea.dev/', 'lead1', 's3cret'));
  assert.equal(u.origin + u.pathname, 'https://api.brotea.dev/baja');
  assert.equal(u.searchParams.get('lead'), 'lead1');
  assert.equal(u.searchParams.get('t'), bajaToken('lead1', 's3cret'));
});

test('revokeByEmail writes the three fields in the lead\'s language and logs lead.consent_revoked', async () => {
  const pb = fakePb({ leads: [{ id: 'lead1', idioma: 'en', consentimiento: true }] });
  const logEvent = fakeEvents();
  const r = await revokeByEmail('lead1', { pb, logEvent, now: NOW });
  assert.deepEqual(r, { revoked: true, idioma: 'en' });
  assert.deepEqual(pb.writes, [{ method: 'PATCH', collection: 'leads', id: 'lead1', body: {
    consentimiento: false, consentimiento_en: NOW.toISOString(), consentimiento_texto: t('en', 'baja_email_text'),
  } }]);
  assert.deepEqual(logEvent.events, [{ type: 'lead.consent_revoked', payload: { lead_id: 'lead1', via: 'email' } }]);
  // The second call is idempotent: no write, no event.
  const again = await revokeByEmail('lead1', { pb, logEvent, now: NOW });
  assert.deepEqual(again, { already: true, idioma: 'en' });
  assert.equal(pb.writes.length, 1);
  assert.equal(logEvent.events.length, 1);
});

test('an unknown lead surfaces the 404', async () => {
  const pb = fakePb();
  await assert.rejects(revokeByEmail('nobody', { pb, logEvent: fakeEvents() }), (e) => e.status === 404);
});

// -- the consent gate --------------------------------------------------------
// The three states of a lead, against the template that asks for consent and a
// marketing template that does not.
const request = { clave: 'consentimiento.solicitud.email', categoria: 'marketing', evento: 'campana.consentimiento' };
const marketing = { clave: 'propiedad.encaja.email', categoria: 'marketing', evento: 'matcher.encaja' };
const utility = { clave: 'visita.confirmacion.email', categoria: 'utility', evento: 'visita.created' };
const neverAsked = { id: 'lead1', consentimiento: false };
const optedOut = { id: 'lead2', consentimiento: false, consentimiento_en: '2026-09-01 10:00:00.000Z', consentimiento_texto: 'BAJA' };
const consenting = { id: 'lead3', consentimiento: true, consentimiento_en: '2026-09-01 10:00:00.000Z' };

test('the consent request is exempt from the consent gate, and nothing else is', () => {
  assert.equal(consentGate(request, neverAsked), null, 'the one message whose purpose is to ask');
  assert.equal(consentGate(marketing, neverAsked), 'no_consent', 'a second marketing template does not inherit it');
  assert.equal(consentGate(utility, neverAsked), null, 'utility was never gated');
  for (const p of [request, marketing, utility]) assert.equal(consentGate(p, consenting), null);
  // The marker is the row's own evento AND its clave. Either alone is a field
  // any signed-in CRM user can type, and one of them typed on a marketing row
  // would otherwise open the never-asked leads to it.
  assert.ok(isConsentRequest(request));
  assert.ok(!isConsentRequest(marketing));
  assert.equal(consentGate({ ...request, evento: 'campana.otra' }, neverAsked), 'no_consent');
  assert.equal(consentGate({ ...marketing, evento: CONSENT_REQUEST_EVENT }, neverAsked), 'no_consent', 'an evento typed on another row does not buy the exemption');
  assert.equal(consentGate({ ...request, clave: 'propiedad.encaja.email' }, neverAsked), 'no_consent');
  // Both consent-request rows, WhatsApp and email, keep it.
  assert.equal(consentGate({ ...request, clave: 'consentimiento.solicitud' }, neverAsked), null);
});

test('a lead who said no is refused with consent_revoked, the consent request included', () => {
  assert.equal(consentGate(request, optedOut), 'consent_revoked', 're-asking is the one thing this must never do');
  assert.equal(consentGate(marketing, optedOut), 'consent_revoked');
  assert.equal(consentGate(utility, optedOut), null, 'a booked visit is still confirmed');
  // The pair false + consentimiento_en is what /baja and a WhatsApp BAJA write;
  // false with no date is a lead nobody ever asked.
  assert.equal(consentGate(request, { consentimiento: false, consentimiento_en: '' }), null);
  assert.equal(consentGate(request, {}), null);
  assert.ok(t('es', 'refusal.consent_revoked').length > 0);
});

// -- the two links -----------------------------------------------------------

test('the si token is not the baja token, and neither validates for the other', () => {
  const si = siToken('lead1', 's3cret');
  const baja = bajaToken('lead1', 's3cret');
  assert.notEqual(si, baja);
  assert.ok(validSiToken('lead1', si, 's3cret'));
  assert.ok(!validSiToken('lead1', baja, 's3cret'), 'an opt-out token must never opt anyone in');
  assert.ok(!validBajaToken('lead1', si, 's3cret'), 'nor the other way round');
  assert.ok(!validSiToken('lead2', si, 's3cret'));
  assert.ok(!validSiToken('lead1', si, 'other'));
  assert.ok(!validSiToken('lead1', si.slice(0, -1) + (si.endsWith('A') ? 'B' : 'A'), 's3cret'));
  assert.ok(!validSiToken('lead1', '', 's3cret'));
  assert.ok(!validSiToken('', si, 's3cret'));
  assert.ok(!validSiToken('lead1', si, ''));
});

test('bajaToken is byte-identical to what every footer already in an inbox carries', () => {
  // HMAC-SHA256('s3cret', 'lead1') as base64url — the vector the links minted
  // before /si existed. Changing it would break links already sent.
  assert.equal(bajaToken('lead1', 's3cret'), createHmac('sha256', 's3cret').update('lead1').digest('base64url'));
  assert.equal(siToken('lead1', 's3cret'), createHmac('sha256', 's3cret').update('si:lead1').digest('base64url'));
});

test('siUrl points at /si on the public origin with the lead and its own token', () => {
  const u = new URL(siUrl('https://api.brotea.dev/', 'lead1', 's3cret'));
  assert.equal(u.origin + u.pathname, 'https://api.brotea.dev/si');
  assert.equal(u.searchParams.get('lead'), 'lead1');
  assert.equal(u.searchParams.get('t'), siToken('lead1', 's3cret'));
});

test('linkVariables answers only the link names a template declares', () => {
  const ctx = { publicUrl: 'https://api.brotea.dev', leadId: 'lead1', secret: 's3cret' };
  assert.deepEqual(linkVariables(['nombre', 'agencia', 'si_url', 'url', 'baja_url'], ctx), {
    si_url: siUrl('https://api.brotea.dev', 'lead1', 's3cret'),
    baja_url: bajaUrl('https://api.brotea.dev', 'lead1', 's3cret'),
  });
  assert.deepEqual(linkVariables(['nombre', 'propiedad'], ctx), {}, 'a template that asks for no link gets none');
  // Nothing to mint with: the values stay missing so the refusal names them
  // rather than a body going out with a literal {{baja_url}} in it.
  assert.deepEqual(linkVariables(['baja_url'], { ...ctx, secret: null }), {});
  assert.deepEqual(linkVariables(['baja_url'], { ...ctx, publicUrl: '' }), {});
  assert.deepEqual(linkVariables(['baja_url'], { ...ctx, leadId: '' }), {});
});

// -- following the /si link --------------------------------------------------

test('grantByEmail writes the three fields with the copy that was shown and logs lead.consent_given', async () => {
  const pb = fakePb({ leads: [{ id: 'lead1', idioma: 'en', consentimiento: false }] });
  const logEvent = fakeEvents();
  const r = await grantByEmail('lead1', { pb, logEvent, now: NOW });
  assert.deepEqual(r, { granted: true, idioma: 'en' });
  assert.deepEqual(pb.writes, [{ method: 'PATCH', collection: 'leads', id: 'lead1', body: {
    consentimiento: true, consentimiento_en: NOW.toISOString(), consentimiento_texto: consentText('en'),
  } }]);
  assert.ok(consentText('en').includes(t('en', 'si_ask')) && consentText('en').includes(t('en', 'si_confirm')));
  assert.ok(consentText('en').length <= 300);
  assert.deepEqual(logEvent.events, [{ type: 'lead.consent_given', payload: { lead_id: 'lead1', via: 'email' } }]);
  // The second click is idempotent: no write, no event.
  const again = await grantByEmail('lead1', { pb, logEvent, now: NOW });
  assert.deepEqual(again, { already: true, idioma: 'en' });
  assert.equal(pb.writes.length, 1);
  assert.equal(logEvent.events.length, 1);
});

test('a lead who had opted out and then clicks si is honoured, and the reversal is on the record', async () => {
  const pb = fakePb({ leads: [{ id: 'lead1', idioma: 'es', consentimiento: false, consentimiento_en: '2026-09-01 10:00:00.000Z' }] });
  const logEvent = fakeEvents();
  const r = await grantByEmail('lead1', { pb, logEvent, now: NOW });
  assert.deepEqual(r, { granted: true, idioma: 'es', afterOptOut: true });
  assert.equal(pb.row('leads', 'lead1').consentimiento, true);
  assert.equal(pb.row('leads', 'lead1').consentimiento_texto, consentText('es'));
  assert.deepEqual(logEvent.events, [{ type: 'lead.consent_given', payload: { lead_id: 'lead1', via: 'email', after_opt_out: true } }]);
});

test('grantByEmail surfaces the 404 of an unknown lead', async () => {
  const pb = fakePb();
  await assert.rejects(grantByEmail('nobody', { pb, logEvent: fakeEvents() }), (e) => e.status === 404);
});

test('the si page asks before it writes, and says done in the lead\'s language alone', () => {
  const ask = siPage('ask', { form: { lead: 'lead1', t: 'tok' } });
  assert.match(ask, /<form method="post" action="\/si">/);
  assert.match(ask, /name="lead" value="lead1"/);
  assert.ok(ask.includes(t('es', 'si_ask')) && ask.includes(t('en', 'si_ask')));
  assert.ok(ask.includes(t('es', 'si_confirm')));
  assert.match(ask, /--color-bg:/, 'colours only as tokens');
  const done = siPage('done', { idioma: 'en' });
  assert.ok(done.includes(t('en', 'si_done')));
  assert.ok(!done.includes(t('es', 'si_done')));
  assert.doesNotMatch(done, /<form/);
  const invalid = siPage('invalid');
  assert.ok(invalid.includes(t('es', 'si_invalid')) && invalid.includes(t('en', 'si_invalid')));
  // The opt-out page is untouched: both languages, its own action.
  assert.match(bajaPage('ask', { lead: 'lead1', t: 'tok' }), /<form method="post" action="\/baja">/);
});

test('a caller value for a link name is dropped before anything is rendered', () => {
  assert.deepEqual(LINK_NAMES, ['baja_url', 'si_url']);
  assert.deepEqual(withoutLinks({ nombre: 'María', baja_url: 'https://evil.example/baja', si_url: 'https://evil.example/si' }), { nombre: 'María' });
  assert.deepEqual(withoutLinks(undefined), {});
});

test('what is stored keeps the message and drops the credential in it', () => {
  const values = { nombre: 'María', si_url: 'https://api.brotea.dev/si?lead=lead1&t=tok', baja_url: 'https://api.brotea.dev/baja?lead=lead1&t=other' };
  const body = `Hola María, confirma: ${values.si_url}\n\nBaja: ${values.baja_url}`;
  assert.equal(redactLinks(body, values), 'Hola María, confirma: [si_url]\n\nBaja: [baja_url]');
  assert.deepEqual(redactedValues(values), { nombre: 'María', si_url: '[si_url]', baja_url: '[baja_url]' });
  // Nothing to redact is not a crash and not a change.
  assert.equal(redactLinks('Hola María', {}), 'Hola María');
  assert.equal(redactLinks(undefined, values), '');
  assert.deepEqual(redactedValues({ nombre: 'María' }), { nombre: 'María' });
});

test('a platform database that is down cannot undo a consent that already committed', async () => {
  const pb = fakePb({ leads: [{ id: 'lead1', idioma: 'es', consentimiento: false }] });
  const down = async () => { throw new Error('connect ECONNREFUSED'); };
  const r = await grantByEmail('lead1', { pb, logEvent: down, now: NOW });
  assert.equal(r.granted, true, 'the person is told their consent is recorded, because it is');
  assert.equal(pb.row('leads', 'lead1').consentimiento, true);
  // The opt-out half had the identical bug and is fixed with it.
  const out = fakePb({ leads: [{ id: 'lead2', idioma: 'es', consentimiento: true }] });
  const revoked = await revokeByEmail('lead2', { pb: out, logEvent: down, now: NOW });
  assert.equal(revoked.revoked, true);
  assert.equal(out.row('leads', 'lead2').consentimiento, false);
});

test('consentimiento_texto names the request that was answered when there is one to name', async () => {
  const plantilla = {
    id: 'pl1', clave: 'consentimiento.solicitud.email', canal: 'email', categoria: 'marketing',
    evento: 'campana.consentimiento', estado: 'aprobada', version: 3,
  };
  const pb = fakePb({
    leads: [{ id: 'lead1', idioma: 'es', consentimiento: false }],
    plantillas: [plantilla],
    envios: [{ id: 'env1', lead: 'lead1', plantilla: 'pl1', plantilla_version: 2, canal: 'email', estado: 'entregado', created: '2026-09-20 09:00:00.000Z' }],
  });
  await grantByEmail('lead1', { pb, logEvent: fakeEvents(), now: NOW });
  const stored = pb.row('leads', 'lead1').consentimiento_texto;
  assert.equal(stored, consentText('es', 'consentimiento.solicitud.email v2'), 'the version that was sent, not the row\'s current one');
  assert.ok(stored.includes(t('es', 'si_ask')));
  assert.ok(stored.length <= 300);
  // Nothing to point at: the page copy alone, never a failed write.
  const alone = fakePb({ leads: [{ id: 'lead2', idioma: 'es', consentimiento: false }] });
  await grantByEmail('lead2', { pb: alone, logEvent: fakeEvents(), now: NOW });
  assert.equal(alone.row('leads', 'lead2').consentimiento_texto, consentText('es'));
});
