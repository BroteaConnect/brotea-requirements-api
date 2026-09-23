// The messaging routes through the real HTTP server: the secret gates, the
// Twilio signature over PUBLIC_URL + '/twilio-status', the events trail by
// actor, and the opt-out page. PocketBase is configured but unreachable, so
// every route that needs it fails after its own checks — and the status
// callback still answers 200, as Twilio requires.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signature } from '../src/twilio.js';
import { bajaToken, siToken } from '../src/consent.js';
import { t } from '../src/copy.js';

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC_URL = `http://127.0.0.1:${PORT}`;
const AUTH_TOKEN = 'test-auth-token';
const dir = mkdtempSync(path.join(tmpdir(), 'messaging-'));
const LOG = path.join(dir, 'events.jsonl');
let child;

before(async () => {
  child = spawn(process.execPath, ['--import', './tests/helpers/fake-pg.mjs', 'src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      FAKE_PG_LOG: LOG,
      OUTBOUND_SECRET: 'test-outbound',
      PUBLIC_URL,
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_WHATSAPP_FROM: '+15550000000',
      // Configured, but nothing listens there: every PocketBase call fails.
      PB_URL: 'http://127.0.0.1:1',
      PB_ADMIN_EMAIL: 'admin@test.invalid',
      PB_ADMIN_PASS: 'not-a-real-password',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

const events = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const json = { 'Content-Type': 'application/json' };
const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

test('POST /send-whatsapp, /send-email, /content/submit and /content/sync refuse without the secret (403, not 404)', async () => {
  for (const p of ['/send-whatsapp', '/send-email', '/content/submit', '/content/sync']) {
    const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: json, body: '{}' });
    assert.equal(r.status, 403, p);
    const wrong = await fetch(`${BASE}${p}?secret=nope`, { method: 'POST', headers: json, body: '{}' });
    assert.equal(wrong.status, 403, p);
  }
});

test('POST /send-whatsapp with the secret: 400 on bad JSON, then the PocketBase failure is a 500 not a hang', async () => {
  const bad = await fetch(`${BASE}/send-whatsapp?secret=test-outbound`, { method: 'POST', headers: json, body: 'nope' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'invalid JSON' });
  const r = await fetch(`${BASE}/send-whatsapp?secret=test-outbound`, { method: 'POST', headers: json, body: JSON.stringify({ lead_id: 'lead1', text: 'hola' }) });
  assert.equal(r.status, 500);
});

test('POST /twilio-status without a signature → 403; with a bad one → 403', async () => {
  const body = new URLSearchParams({ MessageSid: 'SM' + '0'.repeat(32), MessageStatus: 'delivered' });
  const none = await fetch(`${BASE}/twilio-status`, { method: 'POST', headers: form, body });
  assert.equal(none.status, 403);
  const bad = await fetch(`${BASE}/twilio-status`, { method: 'POST', headers: { ...form, 'X-Twilio-Signature': 'bm9wZQ==' }, body });
  assert.equal(bad.status, 403);
  // The right token over the wrong URL (another origin) is also refused.
  const params = Object.fromEntries(body);
  const elsewhere = await fetch(`${BASE}/twilio-status`, { method: 'POST', headers: { ...form, 'X-Twilio-Signature': signature(AUTH_TOKEN, 'https://api.brotea.dev/twilio-status', params) }, body });
  assert.equal(elsewhere.status, 403);
});

test('POST /twilio-status signed over PUBLIC_URL + /twilio-status → 200 {skipped} for an unknown SID, and an events row by actor twilio', async () => {
  const sid = 'SM' + '0'.repeat(32);
  const params = { AccountSid: 'ACtest', MessageSid: sid, MessageStatus: 'delivered', From: 'whatsapp:+15550000000' };
  const r = await fetch(`${BASE}/twilio-status`, {
    method: 'POST',
    headers: { ...form, 'X-Twilio-Signature': signature(AUTH_TOKEN, `${PUBLIC_URL}/twilio-status`, params) },
    body: new URLSearchParams(params),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.skipped, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ev = events().find((e) => e.type === 'whatsapp.status_received');
  assert.ok(ev, 'whatsapp.status_received was logged');
  assert.equal(ev.actor, 'twilio');
  assert.equal(ev.payload.mensaje_id, sid);
  assert.equal(ev.payload.status, 'delivered');
  assert.equal(ev.payload.result.skipped, true);
});

test('GET /baja with a bad token → 403 and both languages\' baja_invalid; a good token shows the button and writes nothing', async () => {
  const bad = await fetch(`${BASE}/baja?lead=lead1&t=nope`);
  assert.equal(bad.status, 403);
  assert.match(bad.headers.get('content-type'), /text\/html/);
  const html = await bad.text();
  assert.ok(html.includes(t('es', 'baja_invalid')));
  assert.ok(html.includes(t('en', 'baja_invalid')));
  assert.match(html, /--color-bg:/);
  assert.doesNotMatch(html, /<form/);
  const token = bajaToken('lead1', 'test-outbound');
  const good = await fetch(`${BASE}/baja?lead=lead1&t=${token}`);
  assert.equal(good.status, 200, 'a GET never touches PocketBase (which is down here)');
  const page = await good.text();
  assert.ok(page.includes(t('es', 'baja_ask')) && page.includes(t('en', 'baja_ask')));
  assert.ok(page.includes(t('es', 'baja_confirm')));
  assert.match(page, /<form method="post" action="\/baja">/);
  assert.match(page, new RegExp(`name="t" value="${token}"`));
  assert.match(page, /name="lead" value="lead1"/);
});

test('POST /baja does the write: 403 on a bad token, and the good token reaches PocketBase', async () => {
  const bad = await fetch(`${BASE}/baja`, { method: 'POST', headers: form, body: new URLSearchParams({ lead: 'lead1', t: 'nope' }) });
  assert.equal(bad.status, 403);
  const good = await fetch(`${BASE}/baja`, { method: 'POST', headers: form, body: new URLSearchParams({ lead: 'lead1', t: bajaToken('lead1', 'test-outbound') }) });
  assert.equal(good.status, 502, 'the token passed; PocketBase is what failed');
  assert.ok((await good.text()).includes(t('es', 'baja_invalid')));
});

test('GET /si is the mirror of /baja: a bad token → 403, the baja token → 403, its own token shows the button', async () => {
  const bad = await fetch(`${BASE}/si?lead=lead1&t=nope`);
  assert.equal(bad.status, 403);
  assert.match(bad.headers.get('content-type'), /text\/html/);
  const html = await bad.text();
  assert.ok(html.includes(t('es', 'si_invalid')) && html.includes(t('en', 'si_invalid')));
  assert.match(html, /--color-bg:/);
  assert.doesNotMatch(html, /<form/);
  // The link that opts a lead out must never opt them in.
  const crossed = await fetch(`${BASE}/si?lead=lead1&t=${bajaToken('lead1', 'test-outbound')}`);
  assert.equal(crossed.status, 403);
  const token = siToken('lead1', 'test-outbound');
  const good = await fetch(`${BASE}/si?lead=lead1&t=${token}`);
  assert.equal(good.status, 200, 'a GET never touches PocketBase (which is down here)');
  const page = await good.text();
  assert.ok(page.includes(t('es', 'si_ask')) && page.includes(t('en', 'si_ask')));
  assert.ok(page.includes(t('es', 'si_confirm')));
  assert.match(page, /<form method="post" action="\/si">/);
  assert.match(page, new RegExp(`name="t" value="${token}"`));
  assert.match(page, /name="lead" value="lead1"/);
});

test('POST /si does the write: 403 on a bad token or the baja one, and its own token reaches PocketBase', async () => {
  const bad = await fetch(`${BASE}/si`, { method: 'POST', headers: form, body: new URLSearchParams({ lead: 'lead1', t: 'nope' }) });
  assert.equal(bad.status, 403);
  const crossed = await fetch(`${BASE}/si`, { method: 'POST', headers: form, body: new URLSearchParams({ lead: 'lead1', t: bajaToken('lead1', 'test-outbound') }) });
  assert.equal(crossed.status, 403);
  const good = await fetch(`${BASE}/si`, { method: 'POST', headers: form, body: new URLSearchParams({ lead: 'lead1', t: siToken('lead1', 'test-outbound') }) });
  assert.equal(good.status, 502, 'the token passed; PocketBase is what failed');
  assert.ok((await good.text()).includes(t('es', 'si_invalid')));
});

test('POST /send-email with a plantilla and no lead_id → 400 lead_required', async () => {
  const r = await fetch(`${BASE}/send-email?secret=test-outbound`, { method: 'POST', headers: json, body: JSON.stringify({ plantilla: 'lead.nuevo', variables: {} }) });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.code, 'lead_required');
  assert.equal(body.error.text, t('es', 'refusal.lead_required'));
});

test('POST /content/submit needs a clave; /content/sync accepts an empty body', async () => {
  const r = await fetch(`${BASE}/content/submit?secret=test-outbound`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'clave_required');
  const s = await fetch(`${BASE}/content/sync?secret=test-outbound`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(s.status, 500, 'routed, PocketBase unreachable');
  const empty = await fetch(`${BASE}/content/sync?secret=test-outbound`, { method: 'POST' });
  assert.equal(empty.status, 500, 'an empty body is {} — the same path, not a 400');
  const emptySubmit = await fetch(`${BASE}/content/submit?secret=test-outbound`, { method: 'POST' });
  assert.equal(emptySubmit.status, 400);
  assert.equal((await emptySubmit.json()).error.code, 'clave_required');
});
