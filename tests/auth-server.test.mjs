// The gate through the real HTTP server, on the four endpoints a browser
// calls, against a PocketBase that answers auth-refresh for real tokens.
//
// What each assertion is worth: a refusal is checked by its `error.code`, not
// only its status, because "403" alone cannot tell "you sent nothing" from
// "you sent the leaked secret out of a browser" — and those two are the before
// and after of this change. A request that gets PAST the gate is recognised by
// landing on the endpoint's own refusal (`lead_unknown`, `template_unknown`),
// which no unauthenticated caller ever reaches.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3995;
const PB_PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-outbound';
const dir = mkdtempSync(path.join(tmpdir(), 'chassis-auth-'));
const LOG = path.join(dir, 'events.jsonl');
let child;
let pb;

// The tokens this fake PocketBase knows. `foreign-token` stands for one minted
// by another project's instance: it is well formed, it is simply not signed by
// a key this instance holds, which is a 401 here and nothing more exotic.
const TOKENS = {
  'agent-token': { id: 'u_agent0000001', role: 'admin', email: 'agente@example.test' },
  'member-token': { id: 'u_member000001', role: 'member', email: 'member@example.test' },
  'norole-token': { id: 'u_norole000001', email: 'norole@example.test' },
  'revoked-token': { id: 'u_revoked00001', role: '', email: 'revoked@example.test' },
  'outsider-token': { id: 'u_outsider0001', role: 'guest', email: 'outsider@example.test' },
};

before(async () => {
  pb = http.createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/collections/_superusers/auth-with-password') {
      return json(200, { token: 'superuser-session', record: { id: 'admin' } });
    }
    if (req.url === '/api/collections/users/auth-refresh') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const record = TOKENS[token];
      if (!record) return json(401, { message: 'The request requires valid record authorization token to be set.' });
      return json(200, { token: 'a-fresh-token', record });
    }
    // Everything the endpoints ask for past the gate is absent, so a caller
    // that got through lands on the endpoint's own refusal.
    if (/\/records\//.test(req.url)) return json(404, { message: "The requested resource wasn't found." });
    return json(200, { items: [], page: 1, perPage: 30, totalItems: 0 });
  });
  await new Promise((resolve) => pb.listen(PB_PORT, '127.0.0.1', resolve));

  child = spawn(process.execPath, ['--import', './tests/helpers/fake-pg.mjs', 'src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      FAKE_PG_LOG: LOG,
      OUTBOUND_SECRET: SECRET,
      PUBLIC_URL: BASE,
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'test-auth-token',
      TWILIO_WHATSAPP_FROM: '+15550000000',
      PB_URL: `http://127.0.0.1:${PB_PORT}`,
      PB_ADMIN_EMAIL: 'admin@test.invalid',
      PB_ADMIN_PASS: 'not-a-real-password',
      SMTP_HOST: 'smtp.test.invalid',
      SMTP_USER: 'user',
      SMTP_PASS: 'not-a-real-password',
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

after(async () => {
  child.kill('SIGTERM');
  await new Promise((resolve) => pb.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const events = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// The four endpoints a browser calls, with a body each one gets far enough to
// look at. `/content/sync` takes an empty body by design.
const GATED = [
  ['/send-whatsapp', { lead_id: 'abcdefghijklmno', text: 'hola' }],
  ['/send-email', { lead_id: 'abcdefghijklmno', subject: 'hola', text: 'texto' }],
  ['/content/submit', { clave: 'bienvenida' }],
  ['/content/sync', {}],
];

// The subset a test may take PAST the gate. `/content/sync` is missing on
// purpose: it reads Twilio's approvals before it reads anything else, so any
// accepted call to it leaves this machine. A gate test must not need a
// provider to be reachable to mean something.
const PAST_GATE = GATED.filter(([p]) => p !== '/content/sync');

// A browser cannot omit any of these; `fetch` from Node sends none of them.
const BROWSER = {
  Origin: 'https://crm-inmobiliaria.brotea.dev',
  Referer: 'https://crm-inmobiliaria.brotea.dev/leads',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

const call = (path, body, { headers = {}, secret = null } = {}) =>
  fetch(`${BASE}${path}${secret ? `?secret=${encodeURIComponent(secret)}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const codeOf = async (res) => {
  const json = await res.json().catch(() => ({}));
  return json?.error?.code ?? json?.error ?? null;
};

// -- no credential -------------------------------------------------------------

test('no credential at all: 403 forbidden on every gated endpoint, from a browser or from the host', async () => {
  for (const [path, body] of GATED) {
    for (const headers of [{}, BROWSER]) {
      const res = await call(path, body, { headers });
      assert.equal(res.status, 403, path);
      assert.equal(await codeOf(res), 'forbidden', path);
    }
  }
});

// -- THE FIX -------------------------------------------------------------------

test('THE FIX: the shared secret from a browser-shaped request is refused on every gated endpoint', async () => {
  for (const [path, body] of GATED) {
    const res = await call(path, body, { headers: BROWSER, secret: SECRET });
    assert.equal(res.status, 403, path);
    assert.equal(await codeOf(res), 'secret_from_browser', path);
  }
});

test('one browser header is enough: the leaked secret cannot be laundered by stripping the rest', async () => {
  for (const header of ['Origin', 'Referer', 'Sec-Fetch-Site', 'Sec-Fetch-Dest', 'User-Agent']) {
    const res = await call('/send-whatsapp', { lead_id: 'abcdefghijklmno', text: 'hola' }, {
      headers: { [header]: BROWSER[header] }, secret: SECRET,
    });
    assert.equal(res.status, 403, header);
    assert.equal(await codeOf(res), 'secret_from_browser', header);
  }
});

test('a refused browser send leaves an events row naming the route and the code, and no credential', async () => {
  await call('/send-whatsapp', { lead_id: 'abcdefghijklmno', text: 'hola' }, { headers: BROWSER, secret: SECRET });
  const row = events().filter((e) => e.type === 'chassis.refused' && e.payload.code === 'secret_from_browser').at(-1);
  assert.ok(row, 'no chassis.refused event was written');
  assert.equal(row.actor, 'chassis');
  assert.equal(row.payload.route, '/send-whatsapp');
  assert.equal(row.payload.status, 403);
  assert.ok(!JSON.stringify(row).includes(SECRET), 'the secret must never reach an events row');
});

// -- the secret from the host --------------------------------------------------

test('the shared secret from the host still opens every gated endpoint', async () => {
  // Node `fetch` is what brotea-whatsapp and jobs/*.mjs use, headers and all
  // (including `sec-fetch-mode: cors`, which is not a browser tell).
  for (const [path, body] of PAST_GATE) {
    const res = await call(path, body, { secret: SECRET });
    assert.notEqual(res.status, 403, `${path} refused the host`);
    assert.notEqual(await codeOf(res), 'secret_from_browser', path);
  }
});

// -- a user token --------------------------------------------------------------

test('a valid staff token gets past the gate and lands on the endpoint\'s own answer', async () => {
  for (const token of ['agent-token', 'member-token', 'norole-token']) {
    const res = await call('/send-whatsapp', { lead_id: 'abcdefghijklmno', text: 'hola' }, {
      headers: { ...BROWSER, Authorization: `Bearer ${token}` },
    });
    // The lead does not exist in the fake PocketBase — a refusal only a caller
    // the gate let through can ever receive.
    assert.equal(res.status, 404, token);
    assert.equal(await codeOf(res), 'lead_unknown', token);
  }
});

test('a valid staff token works on /send-email and /content/* too, with no secret anywhere', async () => {
  const email = await call('/send-email', { lead_id: 'abcdefghijklmno', subject: 'hola', text: 'texto' }, {
    headers: { ...BROWSER, Authorization: 'Bearer agent-token' },
  });
  assert.equal(email.status, 404);
  assert.equal(await codeOf(email), 'lead_unknown');

  const submit = await call('/content/submit', { clave: 'no-existe' }, {
    headers: { ...BROWSER, Authorization: 'Bearer agent-token' },
  });
  assert.equal(submit.status, 404);
  assert.equal(await codeOf(submit), 'template_unknown');
});

test('an authorized user leaves an events row with the id and the role, and no token', async () => {
  await call('/content/submit', { clave: 'no-existe' }, { headers: { ...BROWSER, Authorization: 'Bearer agent-token' } });
  const row = events().filter((e) => e.type === 'chassis.authorized').at(-1);
  assert.ok(row, 'no chassis.authorized event was written');
  assert.equal(row.actor, 'chassis');
  assert.deepEqual(row.payload, { route: '/content/submit', via: 'user', user_id: 'u_agent0000001', role: 'admin' });
  assert.ok(!JSON.stringify(row).includes('agent-token'), 'a token must never reach an events row');
});

test('an expired or unknown token is a 401, on every endpoint', async () => {
  for (const [path, body] of GATED) {
    const res = await call(path, body, { headers: { ...BROWSER, Authorization: 'Bearer expired-token' } });
    assert.equal(res.status, 401, path);
    assert.equal(await codeOf(res), 'invalid_token', path);
  }
});

test('a token from another project\'s PocketBase is a 401 here, not a pass', async () => {
  const res = await call('/send-whatsapp', { lead_id: 'abcdefghijklmno', text: 'hola' }, {
    headers: { ...BROWSER, Authorization: 'Bearer foreign-token' },
  });
  assert.equal(res.status, 401);
  assert.equal(await codeOf(res), 'invalid_token');
});

test('a bad token does not fall back to the secret, even when the request carries it', async () => {
  const res = await call('/send-whatsapp', { lead_id: 'abcdefghijklmno', text: 'hola' }, {
    headers: { ...BROWSER, Authorization: 'Bearer expired-token' }, secret: SECRET,
  });
  assert.equal(res.status, 401);
  assert.equal(await codeOf(res), 'invalid_token');
});

test('a signed-in user who is not staff is a 403 not_staff, not a 401', async () => {
  for (const token of ['revoked-token', 'outsider-token']) {
    const res = await call('/send-whatsapp', { lead_id: 'abcdefghijklmno', text: 'hola' }, {
      headers: { ...BROWSER, Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403, token);
    assert.equal(await codeOf(res), 'not_staff', token);
  }
});

test('the token travels with or without the Bearer prefix, as PocketBase itself allows', async () => {
  const res = await call('/content/submit', { clave: 'no-existe' }, { headers: { ...BROWSER, Authorization: 'agent-token' } });
  assert.equal(res.status, 404);
  assert.equal(await codeOf(res), 'template_unknown');
});

// -- the recipient -------------------------------------------------------------

test('/send-email will not take a recipient from a signed-in browser either', async () => {
  const res = await call('/send-email', { to: 'cualquiera@example.test', subject: 'hola', text: 'texto' }, {
    headers: { ...BROWSER, Authorization: 'Bearer agent-token' },
  });
  assert.equal(res.status, 400);
  assert.equal(await codeOf(res), 'lead_required');
});

test('/send-email ignores a `to` that contradicts the lead: the lead is not there, so neither is the send', async () => {
  const res = await call('/send-email', {
    lead_id: 'abcdefghijklmno', to: 'attacker@example.test', subject: 'hola', text: 'texto',
  }, { headers: { ...BROWSER, Authorization: 'Bearer agent-token' } });
  // The address in the body buys nothing: the lead is what is looked up, and
  // the fake PocketBase does not have it.
  assert.equal(res.status, 404);
  assert.equal(await codeOf(res), 'lead_unknown');
});

// -- the callbacks are untouched -----------------------------------------------

test('the provider callbacks keep their own authentication and gain no user auth', async () => {
  // /brevo-webhook: still the secret in the query, and a Bearer token is not a
  // substitute for it — Brevo has no PocketBase user.
  const withSecret = await call('/brevo-webhook', { event: 'delivered', 'message-id': '<x@brotea.dev>' }, { secret: SECRET });
  assert.equal(withSecret.status, 200);
  const withToken = await call('/brevo-webhook', { event: 'delivered' }, { headers: { Authorization: 'Bearer agent-token' } });
  assert.equal(withToken.status, 403);

  // /twilio-status: still the signature, and a valid staff token does not open it.
  const signed = await fetch(`${BASE}/twilio-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer agent-token' },
    body: new URLSearchParams({ MessageSid: `SM${'0'.repeat(32)}`, MessageStatus: 'delivered' }).toString(),
  });
  assert.equal(signed.status, 403);
});

// -- CORS ----------------------------------------------------------------------

test('the preflight allows the Authorization header, or no browser could send the token at all', async () => {
  const res = await fetch(`${BASE}/send-whatsapp`, {
    method: 'OPTIONS',
    headers: {
      Origin: BROWSER.Origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(res.status, 204);
  const allowed = String(res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  assert.ok(allowed.includes('authorization'), allowed);
  assert.ok(allowed.includes('content-type'), allowed);
});
