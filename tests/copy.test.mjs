import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dict, has, locale, t } from '../src/copy.js';

const es = JSON.parse(readFileSync(new URL('../src/locales/es.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));

test('es and en carry identical key sets, including the sample values', () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(es.content_samples).sort(), Object.keys(en.content_samples).sort());
  for (const k of Object.keys(es)) {
    if (k === 'content_samples') continue;
    assert.equal(typeof es[k], 'string', k);
    assert.ok(es[k].trim() && en[k].trim(), `${k} is empty in a locale`);
  }
});

test('every twilio_error.* sentence exists in both languages and every refusal code has one', () => {
  const codes = Object.keys(es).filter((k) => k.startsWith('twilio_error.'));
  assert.ok(codes.length >= 15);
  for (const k of codes) {
    assert.match(k, /^twilio_error\.\d+$/);
    assert.ok(has('es', k) && has('en', k), k);
  }
  for (const code of ['no_phone', 'no_consent', 'outside_window', 'template_not_approved', 'template_unknown', 'template_channel', 'template_retired', 'variables_missing', 'text_too_long', 'provider_unavailable', 'provider_auth', 'sender_not_ready', 'template_invalid', 'already_submitted']) {
    assert.ok(has('es', `refusal.${code}`), code);
  }
  assert.ok(!has('es', 'twilio_error.00000'));
});

test('t falls back to Spanish and fills placeholders, leaving a missing one visible', () => {
  assert.equal(t('en', 'baja_done'), en.baja_done);
  assert.equal(t('fr', 'baja_done'), es.baja_done);
  assert.equal(t('es', 'nope'), 'nope');
  assert.equal(t('es', 'email_footer_baja', { url: 'https://x/baja' }), es.email_footer_baja.replace('{url}', 'https://x/baja'));
  assert.equal(t('es', 'email_footer_baja', {}), es.email_footer_baja);
  assert.equal(locale('en'), 'en');
  assert.equal(locale('pt'), 'es');
  assert.equal(dict('en').baja_title, en.baja_title);
});
