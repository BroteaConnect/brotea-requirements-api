// A web lead's form must get its 201 even when the CRM cannot be reached to
// assign the lead: the requirement is stored, the failure is an events row,
// and the browser never learns there was a problem.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(path.join(tmpdir(), 'lead-web-'));
const LOG = path.join(dir, 'events.jsonl');
let child;

before(async () => {
  child = spawn(process.execPath, ['--import', './tests/helpers/fake-pg.mjs', 'src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      FAKE_PG_LOG: LOG,
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

const events = () => readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('POST /requirements with a web lead still answers 201 when assignment fails', async () => {
  const r = await fetch(`${BASE}/requirements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: 'inmobiliaria', source: 'lead_web', lead_id: 'abcdefghijklmno',
      submitted_by: 'Alguien <600000000>', content: 'LEAD para "Ático": quiero verlo',
    }),
  });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { ok: true, id: 4242 });

  const types = events().map((e) => e.type);
  assert.deepEqual(types, ['requirement.received', 'lead.assign_failed']);
  const failed = events().find((e) => e.type === 'lead.assign_failed');
  assert.equal(failed.actor, 'requirements-api');
  assert.equal(failed.payload.project, 'inmobiliaria');
  assert.equal(failed.payload.lead_id, 'abcdefghijklmno');
  assert.ok(failed.payload.error);
});

test('POST /requirements for a web lead without lead_id is 201 and records the gap', async () => {
  // The landing that sends lead_id is in flight; until it lands, every web
  // lead takes this path and the events table has to show it.
  const r = await fetch(`${BASE}/requirements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'inmobiliaria', source: 'lead_web', content: 'LEAD sin id' }),
  });
  assert.equal(r.status, 201);
  const skipped = events().filter((e) => e.type === 'lead.assign_skipped');
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0].payload, { project: 'inmobiliaria', lead_id: '', reason: 'no lead id' });
});

test('POST /requirements from another source never touches the lead', async () => {
  const r = await fetch(`${BASE}/requirements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'inmobiliaria', source: 'landing_form', lead_id: 'abcdefghijklmno', content: 'hola' }),
  });
  assert.equal(r.status, 201);
  const types = events().map((e) => e.type);
  assert.deepEqual(types.filter((t) => t.startsWith('lead.')), ['lead.assign_failed', 'lead.assign_skipped'], 'only the earlier two');
});
