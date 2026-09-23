import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Validation and routing tests only — no queries reach the DB, so the pool
// never connects and a dummy DATABASE_URL is enough.
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      GLITCHTIP_WEBHOOK_SECRET: 'test-secret',
      OUTBOUND_SECRET: 'test-outbound',
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

after(() => child.kill('SIGTERM'));

test('GET /health returns ok', async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok' });
});

test('GET /roadmap without project is rejected', async () => {
  const r = await fetch(`${BASE}/roadmap`);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid project' });
});

test('GET /roadmap with invalid slug is rejected', async () => {
  const r = await fetch(`${BASE}/roadmap?project=Not%20A%20Slug!`);
  assert.equal(r.status, 400);
});

test('GET /roadmap allows cross-origin reads', async () => {
  const r = await fetch(`${BASE}/roadmap`);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-methods'), /GET/);
});

test('GET /garden is routed and allows cross-origin reads', async () => {
  // The test DB is unreachable, so a 500 is expected — what matters here is
  // that the route exists (not 404) and CORS headers are always present.
  const r = await fetch(`${BASE}/garden`);
  assert.notEqual(r.status, 404);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('content-type'), 'application/json');
});

test('POST /garden is not allowed', async () => {
  const r = await fetch(`${BASE}/garden`, { method: 'POST' });
  assert.equal(r.status, 404);
});

test('unknown route returns 404', async () => {
  const r = await fetch(`${BASE}/nope`);
  assert.equal(r.status, 404);
});

test('POST /glitchtip-webhook without secret is forbidden', async () => {
  const r = await fetch(`${BASE}/glitchtip-webhook?project=demo`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(r.status, 403);
});

test('POST /glitchtip-webhook with wrong secret is forbidden', async () => {
  const r = await fetch(`${BASE}/glitchtip-webhook?project=demo&secret=nope`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(r.status, 403);
});

test('POST /glitchtip-webhook with invalid slug is rejected', async () => {
  const r = await fetch(`${BASE}/glitchtip-webhook?project=Not%20A%20Slug!&secret=test-secret`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid project' });
});

test('POST /glitchtip-webhook with invalid JSON is rejected', async () => {
  const r = await fetch(`${BASE}/glitchtip-webhook?project=demo&secret=test-secret`, {
    method: 'POST',
    body: 'not json',
  });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid JSON' });
});

test('GET /glitchtip-webhook is not routed', async () => {
  const r = await fetch(`${BASE}/glitchtip-webhook?project=demo&secret=test-secret`);
  assert.equal(r.status, 404);
});

test('POST /send-email without secret is forbidden', async () => {
  const r = await fetch(`${BASE}/send-email`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 403);
});

// The endpoint no longer takes a recipient from anybody. A body that names
// only an address is not "a send to that address" any more; it is a request
// that names no lead, and that is a refusal before anything else is looked at.
test('POST /send-email will not take a recipient from the request', async () => {
  for (const body of [
    { to: 'not-an-email', subject: 'x', text: 'y' },
    { to: 'alguien@example.com', subject: 'hola', text: 'texto' },
  ]) {
    const r = await fetch(`${BASE}/send-email?secret=test-outbound`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
    const json = await r.json();
    assert.equal(json.error.code, 'lead_required', JSON.stringify(body));
  }
});

test('POST /send-email with a lead but no PocketBase reports it, and never 500', async () => {
  // This harness configures neither PB_* nor SMTP_*: the address can only come
  // from a `leads` row, so with no PocketBase there is nowhere to read it.
  const r = await fetch(`${BASE}/send-email?secret=test-outbound`, {
    method: 'POST',
    body: JSON.stringify({ lead_id: 'abcdefghijklmno', subject: 'hola', text: 'texto' }),
  });
  assert.equal(r.status, 503);
});

test('POST /send-whatsapp, /content/submit and /content/sync without the secret are forbidden, not unknown', async () => {
  for (const p of ['/send-whatsapp', '/content/submit', '/content/sync']) {
    const r = await fetch(`${BASE}${p}`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 403, p);
  }
});

test('POST /send-whatsapp with the secret but no PUBLIC_URL / TWILIO_* reports 503', async () => {
  const r = await fetch(`${BASE}/send-whatsapp?secret=test-outbound`, {
    method: 'POST',
    body: JSON.stringify({ lead_id: 'abcdefghijklmno', text: 'hola' }),
  });
  assert.equal(r.status, 503);
  const bad = await fetch(`${BASE}/send-whatsapp?secret=test-outbound`, { method: 'POST', body: 'nope' });
  assert.equal(bad.status, 400);
});

test('POST /twilio-status without the Twilio config is 503, never a silent 200', async () => {
  const r = await fetch(`${BASE}/twilio-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ MessageSid: 'SM1', MessageStatus: 'delivered' }),
  });
  assert.equal(r.status, 503);
});

test('GET /baja with a bad token is a 403 page', async () => {
  const r = await fetch(`${BASE}/baja?lead=x&t=y`);
  assert.equal(r.status, 403);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

test('POST /brevo-webhook without secret is forbidden', async () => {
  const r = await fetch(`${BASE}/brevo-webhook`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 403);
});

test('POST /brevo-webhook ignores events it does not map', async () => {
  const r = await fetch(`${BASE}/brevo-webhook?secret=test-outbound`, {
    method: 'POST',
    body: JSON.stringify({ event: 'request', 'message-id': '<x@brotea.dev>' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.skipped, true);
});
