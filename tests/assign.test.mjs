// The assignment rule, with PocketBase replaced by a fetch stub: a web lead
// goes to the on-duty agent, else to the oldest agent user, never over an
// existing owner, every call is bounded by a timeout, and a PocketBase failure
// comes back as a value, never as a throw.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// email.js reads its env at import time, so it has to be set before the
// module loads — hence the dynamic import below.
process.env.PB_URL = 'http://pb.test';
process.env.PB_ADMIN_EMAIL = 'admin@test.invalid';
process.env.PB_ADMIN_PASS = 'not-a-real-password';
delete process.env.PB_PROJECT;
const { assignWebLead, LEAD_ID_RE } = await import('../src/assign.js');

const LEAD = 'abcdefghijklmno';
const ON_DUTY = 'guardia0000001x';
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
    // Oldest first, as PocketBase would sort them. The superadmin is oldest on
    // purpose: the fallback has to look past it.
    users: [
      { id: 'root00000000001', role: 'superadmin' },
      { id: 'agent0000000001', role: 'member' },
      { id: 'agent0000000002', role: 'member' },
    ],
    failPatch: false,        // every PATCH → 500
    rejectPatchFor: null,    // PATCH with this asignado → 400
    unauthorizedOnce: false, // first lead GET → 401, then fine
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: u.searchParams, body, signal: init.signal });
    if (u.pathname.endsWith('/auth-with-password')) return json({ token: 'tok' });
    if (u.pathname === '/api/collections/settings/records') return json({ items: world.settings });
    if (u.pathname === '/api/collections/users/records') {
      // Honour the filter the way PocketBase would: superadmins out when asked.
      const filter = u.searchParams.get('filter') ?? '';
      const items = world.users.filter((x) => !(filter.includes('superadmin') && x.role === 'superadmin'));
      return json({ items: items.slice(0, Number(u.searchParams.get('perPage') ?? 30)) });
    }
    if (u.pathname === `/api/collections/leads/records/${LEAD}`) {
      if (method === 'GET') {
        if (world.unauthorizedOnce) { world.unauthorizedOnce = false; return json({ message: 'expired' }, 401); }
        return json(world.lead);
      }
      if (method === 'PATCH') {
        if (world.failPatch) return json({ message: 'boom' }, 500);
        if (world.rejectPatchFor && body.asignado === world.rejectPatchFor) {
          return json({ message: 'Failed to update record.', data: { asignado: { code: 'validation_missing_rel_records' } } }, 400);
        }
        return json({ ...world.lead, ...body });
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
const usersQueries = () => calls.filter((c) => c.path === '/api/collections/users/records');
const run = (ev, overrides = {}) =>
  assignWebLead({ leadId: LEAD, project: 'inmobiliaria', logEvent: ev.log, ...overrides });

test('a plausible lead id is 15 lowercase alphanumerics', () => {
  assert.ok(LEAD_ID_RE.test(LEAD));
  assert.ok(!LEAD_ID_RE.test('ABCDEFGHIJKLMNO'));
  assert.ok(!LEAD_ID_RE.test('short'));
  assert.ok(!LEAD_ID_RE.test(''));
});

test('the on-duty agent from settings takes the lead', async () => {
  world.settings = [{ key: 'agentes.guardia', value: { v: 1, text: ON_DUTY } }];
  const ev = events();
  const out = await run(ev);

  assert.deepEqual(out, { assigned: true, user_id: ON_DUTY, rule: 'agentes.guardia' });
  assert.deepEqual(patches().map((c) => c.body), [{ asignado: ON_DUTY }]);
  assert.deepEqual(ev.list, [{
    type: 'lead.assigned',
    payload: { project: 'inmobiliaria', lead_id: LEAD, user_id: ON_DUTY, source: 'lead_web', rule: 'agentes.guardia' },
  }]);
  // The fallback was never consulted.
  assert.equal(usersQueries().length, 0);
  // Duplicate settings rows resolve to the latest one.
  const settings = calls.find((c) => c.path === '/api/collections/settings/records');
  assert.equal(settings.query.get('sort'), '-updated');
  assert.equal(settings.query.get('filter'), 'key="agentes.guardia"');
});

test('every PocketBase call carries a timeout signal', async () => {
  world.settings = [{ key: 'agentes.guardia', value: { v: 1, text: ON_DUTY } }];
  await run(events());
  assert.ok(calls.length >= 3, 'auth, lead, settings, patch');
  for (const c of calls) {
    assert.ok(c.signal instanceof AbortSignal, `${c.method} ${c.path} has no signal`);
    assert.equal(c.signal.aborted, false);
  }
});

test('a settings value stored as a JSON string still names the agent', async () => {
  world.settings = [{ key: 'agentes.guardia', value: JSON.stringify({ v: 1, text: ON_DUTY }) }];
  const out = await run(events());
  assert.equal(out.user_id, ON_DUTY);
  assert.equal(out.rule, 'agentes.guardia');
});

test('without an on-duty setting the oldest agent user takes the lead', async () => {
  const ev = events();
  const out = await run(ev);

  assert.deepEqual(out, { assigned: true, user_id: 'agent0000000001', rule: 'oldest_user' });
  assert.deepEqual(patches().map((c) => c.body), [{ asignado: 'agent0000000001' }]);
  const q = usersQueries()[0].query;
  assert.equal(q.get('sort'), 'created,id');
  assert.equal(q.get('perPage'), '1');
  assert.equal(q.get('filter'), 'role != "superadmin"');
  assert.equal(ev.list[0].type, 'lead.assigned');
  assert.equal(ev.list[0].payload.rule, 'oldest_user');
});

test('the fallback never picks a superadmin, even the oldest one', async () => {
  const out = await run(events());
  assert.notEqual(out.user_id, 'root00000000001');
  assert.equal(out.user_id, 'agent0000000001');
});

test('an empty or malformed on-duty setting falls back to the oldest user', async () => {
  for (const text of ['   ', 'María la de guardia', 'ABCDEFGHIJKLMNO', 'tooshort']) {
    calls = [];
    world.settings = [{ key: 'agentes.guardia', value: { v: 1, text } }];
    const out = await run(events());
    assert.equal(out.rule, 'oldest_user', `setting "${text}" should not reach the PATCH`);
    assert.deepEqual(patches().map((c) => c.body), [{ asignado: 'agent0000000001' }]);
  }
});

test('an on-duty id PocketBase rejects with 400 is retried once with the fallback', async () => {
  world.settings = [{ key: 'agentes.guardia', value: { v: 1, text: 'gone000000000xx' } }];
  world.rejectPatchFor = 'gone000000000xx';
  const ev = events();
  const out = await run(ev);

  assert.deepEqual(out, { assigned: true, user_id: 'agent0000000001', rule: 'oldest_user' });
  assert.deepEqual(patches().map((c) => c.body), [{ asignado: 'gone000000000xx' }, { asignado: 'agent0000000001' }]);
  assert.deepEqual(ev.list.map((e) => e.type), ['lead.assigned']);
  assert.equal(ev.list[0].payload.rule, 'oldest_user');
});

test('a 401 drops the cached token and retries the call once', async () => {
  world.unauthorizedOnce = true;
  const out = await run(events());
  assert.equal(out.assigned, true);
  const seq = calls.map((c) => `${c.method} ${c.path}`);
  const first = seq.indexOf(`GET /api/collections/leads/records/${LEAD}`);
  assert.deepEqual(seq.slice(first, first + 3), [
    `GET /api/collections/leads/records/${LEAD}`,
    'POST /api/collections/_superusers/auth-with-password',
    `GET /api/collections/leads/records/${LEAD}`,
  ]);
});

test('a lead that already has an owner is left alone, silently', async () => {
  world.lead.asignado = 'owner000000001x';
  world.settings = [{ key: 'agentes.guardia', value: { v: 1, text: ON_DUTY } }];
  const ev = events();
  const out = await run(ev);

  assert.deepEqual(out, { skipped: true, reason: 'already assigned', user_id: 'owner000000001x' });
  assert.equal(patches().length, 0);
  assert.deepEqual(ev.list, []);
});

test('a PocketBase failure is returned, logged, and never thrown', async () => {
  world.failPatch = true;
  const ev = events();
  const out = await run(ev);

  assert.ok(out.error, 'a failure object');
  assert.match(out.error, /500/);
  assert.equal(out.assigned, undefined);
  assert.equal(ev.list.length, 1);
  assert.equal(ev.list[0].type, 'lead.assign_failed');
  assert.deepEqual(Object.keys(ev.list[0].payload).sort(), ['error', 'lead_id', 'project']);
  assert.equal(ev.list[0].payload.lead_id, LEAD);
});

test('nobody to assign to is a failure, not a silent skip', async () => {
  world.users = [{ id: 'root00000000001', role: 'superadmin' }];
  const ev = events();
  const out = await run(ev);
  assert.match(out.error, /no agent user/);
  assert.equal(patches().length, 0);
  assert.equal(ev.list[0].type, 'lead.assign_failed');
});

test('an implausible lead id is skipped before any PocketBase call, and says so', async () => {
  const ev = events();
  const out = await run(ev, { leadId: 'nope' });
  assert.deepEqual(out, { skipped: true, reason: 'no lead id' });
  assert.equal(calls.length, 0);
  assert.deepEqual(ev.list, [{
    type: 'lead.assign_skipped',
    payload: { project: 'inmobiliaria', lead_id: 'nope', reason: 'no lead id' },
  }]);
});

test('a lead for a project this PocketBase does not hold is skipped', async () => {
  const ev = events();
  const out = await run(ev, { project: 'otra-agencia' });
  assert.deepEqual(out, { skipped: true, reason: 'pb not for this project' });
  assert.equal(calls.length, 0);
  assert.equal(ev.list[0].type, 'lead.assign_skipped');
  assert.equal(ev.list[0].payload.project, 'otra-agencia');
});

test('PB_PROJECT names the project the instance belongs to', async () => {
  process.env.PB_PROJECT = 'otra-agencia';
  try {
    const out = await run(events(), { project: 'otra-agencia' });
    assert.equal(out.assigned, true);
    const skipped = await run(events(), { project: 'inmobiliaria' });
    assert.equal(skipped.reason, 'pb not for this project');
  } finally {
    delete process.env.PB_PROJECT;
  }
});

test('a successful PATCH whose event insert fails is still a success', async () => {
  const out = await run({ log: async () => { throw new Error('db down'); } });
  assert.deepEqual(out, { assigned: true, user_id: 'agent0000000001', rule: 'oldest_user', logged: false });
  assert.equal(patches().length, 1);
});
