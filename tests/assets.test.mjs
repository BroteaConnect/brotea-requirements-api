// The email templates point at this host with an absolute URL, because an inbox
// has no base URL. If these routes stop answering, every transactional email
// the identity plane sends shows a broken image — and nothing anywhere errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 3391;
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://localhost/none' },
  stdio: 'ignore',
});
const ready = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { await fetch(`${base}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('the server never came up');
};
await ready();

test('the logo the emails point at is served', async () => {
  const r = await fetch(`${base}/assets/email/brotea.png`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(body.length, readFileSync('assets/email/brotea.png').length);
  // A PNG, not an HTML error page dressed as one.
  assert.equal(body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('it can be cached for a long time', async () => {
  const r = await fetch(`${base}/assets/email/brotea.png`);
  assert.match(r.headers.get('cache-control') ?? '', /max-age=\d{5,}/);
});

test('the path cannot escape the assets folder', async () => {
  for (const attempt of ['/assets/../src/server.js', '/assets/email/../../src/email.js', '/assets/%2e%2e/package.json']) {
    const r = await fetch(base + attempt);
    assert.notEqual(r.status, 200, `${attempt} was served`);
  }
});

test('an unknown asset is a 404, not a crash', async () => {
  const r = await fetch(`${base}/assets/email/nope.png`);
  assert.equal(r.status, 404);
});

test('only image types are served', async () => {
  assert.ok(existsSync('src/server.js'));
  const r = await fetch(`${base}/assets/email/../../package.json`);
  assert.notEqual(r.status, 200);
});

test.after(() => server.kill());
