import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bajaToken, bajaUrl, revokeByEmail, validBajaToken } from '../src/consent.js';
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
