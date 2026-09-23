// The assignment rule, with PocketBase replaced by a fetch stub: a web lead
// goes to the on-duty agent, else to the oldest user, never over an existing
// owner, and a PocketBase failure comes back as a value, never as a throw.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// email.js reads its env at import time, so it has to be set before the
// module loads — hence the dynamic import below.
process.env.PB_URL = 'http://pb.test';
process.env.PB_ADMIN_EMAIL = 'admin@test.invalid';
process.env.PB_ADMIN_PASS = 'not-a-real-password';
const { assignWebLead, LEAD_ID_RE } = await import('../src/assign.js');

const LEAD = 'abcdefghijklmno';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** One PocketBase per test: what it answers, and what it was asked. */
let calls;
let world;
beforeEach(() => {
  calls = [];
  world = {
    lead: { id: LEAD, asignado: '' },
    settings: [],
    users: [{ id: 'user0000000001x' }, { id: 'user0000000002x' }],
    failPatch: false,
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname.endsWith('/auth-with-password')) return json({ token: 'tok' });
    if (u.pathname === '/api/collections/settings/records') return json({ items: world.settings });
    if (u.pathname === '/api/collections/users/records') return json({ items: world.users.slice(0, 1) });
    if (u.pathname === `/api/collections/leads/records/${LEAD}`) {
      if (method === 'GET') return json(world.lead);
      if (method === 'PATCH') {
        if (world.failPatch) return json({ message: 'boom' }, 500);
        return json({ ...world.lead, ...JSON.parse(init.body) });
      }
    }
    return json({ message: 'not found' }, 404);
  };
});

const events = () => {
  const list = [];
  return { list, log: async (type, payload) => { list.push({ type, payload }); } };
};
const patches = () => calls.filter((c) => c.method === 'PATCH');

test('a plausible lead id is 15 lowercase alphanumerics', () => {
  assert.ok(LEAD_ID_RE.test(LEAD));
  assert.ok(!LEAD_ID_RE.test('ABCDEFGHIJKLMNO'));
  assert.ok(!LEAD_ID_RE.test('short'));
  assert.ok(!LEAD_ID_RE.test(''));
});

test('the on-duty agent from settings takes the lead', async () => {
  world.settings = [{ key: 'agentes.guardia', value: { v: 1, text: 'guardia0000001x' } }];
  const ev = events();
  const out = await assignWebLead({ leadId: LEAD, project: 'inmobiliaria', logEvent: ev.log });

  assert.deepEqual(out, { assigned: true, user_id: 'guardia0000001x', rule: 'agentes.guardia' });
  assert.deepEqual(patches().map((c) => c.body), [{ asignado: 'guardia0000001x' }]);
  assert.deepEqual(ev.list, [{
    type: 'lead.assigned',
    payload: { project: 'inmobiliaria', lead_id: LEAD, user_id: 'guardia0000001x', source: 'lead_web', rule: 'agentes.guardia' },
  }]);
  // The fallback was never consulted.
  assert.ok(!calls.some((c) => c.path.startsWith('/api/collections/users/')));
});

test('a settings value stored as a JSON string still names the agent', async () => {
  world.settings = [{ key: 'agentes.guardia', value: JSON.stringify({ v: 1, text: 'guardia0000002x' }) }];
  const out = await assignWebLead({ leadId: LEAD, project: 'inmobiliaria' });
  assert.equal(out.user_id, 'guardia0000002x');
  assert.equal(out.rule, 'agentes.guardia');
});

test('without an on-duty setting the oldest user takes the lead', async () => {
  const ev = events();
  const out = await assignWebLead({ leadId: LEAD, project: 'inmobiliaria', logEvent: ev.log });

  assert.deepEqual(out, { assigned: true, user_id: 'user0000000001x', rule: 'oldest_user' });
  assert.deepEqual(patches().map((c) => c.body), [{ asignado: 'user0000000001x' }]);
  assert.match(calls.find((c) => c.path.startsWith('/api/collections/users/')).path, /sort=created&perPage=1/);
  assert.equal(ev.list[0].type, 'lead.assigned');
  assert.equal(ev.list[0].payload.rule, 'oldest_user');
});

test('an empty on-duty setting also falls back to the oldest user', async () => {
  world.settings = [{ key: 'agentes.guardia', value: { v: 1, text: '   ' } }];
  const out = await assignWebLead({ leadId: LEAD, project: 'inmobiliaria' });
  assert.equal(out.rule, 'oldest_user');
});

test('a lead that already has an owner is left alone', async () => {
  world.lead.asignado = 'owner000000001x';
  world.settings = [{ key: 'agentes.guardia', value: { v: 1, text: 'guardia0000001x' } }];
  const ev = events();
  const out = await assignWebLead({ leadId: LEAD, project: 'inmobiliaria', logEvent: ev.log });

  assert.deepEqual(out, { skipped: true, reason: 'already assigned', user_id: 'owner000000001x' });
  assert.equal(patches().length, 0);
  assert.deepEqual(ev.list, []);
});

test('a PocketBase failure is returned, logged, and never thrown', async () => {
  world.failPatch = true;
  const ev = events();
  const out = await assignWebLead({ leadId: LEAD, project: 'inmobiliaria', logEvent: ev.log });

  assert.ok(out.error, 'a failure object');
  assert.match(out.error, /500/);
  assert.equal(out.assigned, undefined);
  assert.equal(ev.list.length, 1);
  assert.equal(ev.list[0].type, 'lead.assign_failed');
  assert.deepEqual(Object.keys(ev.list[0].payload).sort(), ['error', 'lead_id', 'project']);
  assert.equal(ev.list[0].payload.lead_id, LEAD);
});

test('an implausible lead id is skipped before any PocketBase call', async () => {
  const out = await assignWebLead({ leadId: 'nope', project: 'inmobiliaria' });
  assert.deepEqual(out, { skipped: true, reason: 'no lead id' });
  assert.equal(calls.length, 0);
});

test('nobody to assign to is a failure, not a silent skip', async () => {
  world.users = [];
  const ev = events();
  const out = await assignWebLead({ leadId: LEAD, project: 'inmobiliaria', logEvent: ev.log });
  assert.match(out.error, /no users/);
  assert.equal(patches().length, 0);
  assert.equal(ev.list[0].type, 'lead.assign_failed');
});
