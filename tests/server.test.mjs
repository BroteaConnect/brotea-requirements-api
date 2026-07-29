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

test('POST /send-email rejects an invalid recipient', async () => {
  const r = await fetch(`${BASE}/send-email?secret=test-outbound`, {
    method: 'POST',
    body: JSON.stringify({ to: 'not-an-email', subject: 'x', text: 'y' }),
  });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid to' });
});

test('POST /send-email requires subject and text', async () => {
  const r = await fetch(`${BASE}/send-email?secret=test-outbound`, {
    method: 'POST',
    body: JSON.stringify({ to: 'alguien@example.com', subject: '', text: '' }),
  });
  assert.equal(r.status, 400);
});

test('POST /send-email without SMTP config reports it', async () => {
  // El entorno de test no trae SMTP_*: debe fallar limpio, no 500.
  const r = await fetch(`${BASE}/send-email?secret=test-outbound`, {
    method: 'POST',
    body: JSON.stringify({ to: 'alguien@example.com', subject: 'hola', text: 'texto' }),
  });
  assert.equal(r.status, 503);
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
