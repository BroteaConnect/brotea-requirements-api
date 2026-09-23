// The credential decision, branch by branch, with no network and no server.
// Every row of the table the fix promised is here: a valid token, an expired
// one, one minted by another project's PocketBase, no credential at all, the
// shared secret from a browser-shaped request, and the shared secret from the
// host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, bearerToken, browserShaped, isStaff, verifyUserToken } from '../src/auth.js';

const SECRET = 'shared-not-a-real-secret';
const PB = 'https://pb.example.test';

// The headers Node's own `fetch` puts on the wire — the host callers
// (brotea-whatsapp, jobs/*.mjs, the estate gates) all look exactly like this.
const HOST_HEADERS = {
  accept: '*/*',
  'accept-language': '*',
  'content-type': 'application/json',
  'sec-fetch-mode': 'cors',
  'user-agent': 'node',
};

// What a browser cannot avoid sending to a cross-origin endpoint.
const BROWSER_HEADERS = {
  origin: 'https://crm-inmobiliaria.brotea.dev',
  referer: 'https://crm-inmobiliaria.brotea.dev/leads',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

// -- bearerToken ---------------------------------------------------------------

test('bearerToken takes the token with or without the prefix, and nothing from an empty header', () => {
  assert.equal(bearerToken({ authorization: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
  assert.equal(bearerToken({ authorization: 'bearer   abc.def.ghi' }), 'abc.def.ghi');
  assert.equal(bearerToken({ authorization: 'abc.def.ghi' }), 'abc.def.ghi');
  assert.equal(bearerToken({ Authorization: 'Bearer abc' }), 'abc');
  assert.equal(bearerToken({ authorization: '   ' }), null);
  assert.equal(bearerToken({ authorization: 'Bearer   ' }), null);
  assert.equal(bearerToken({}), null);
});

// -- browserShaped -------------------------------------------------------------

test('a browser is recognised by any one of the headers it cannot suppress', () => {
  assert.equal(browserShaped(BROWSER_HEADERS), true);
  for (const h of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest']) {
    assert.equal(browserShaped({ [h]: BROWSER_HEADERS[h] }), true, h);
  }
  assert.equal(browserShaped({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }), true);
});

test('node fetch is NOT a browser — sec-fetch-mode alone must never be the tell', () => {
  // The trap this test exists for: undici sends `sec-fetch-mode: cors` on every
  // call, so counting it would have refused brotea-whatsapp in production while
  // every unit test stayed green.
  assert.equal(browserShaped(HOST_HEADERS), false);
  assert.equal(browserShaped({ 'sec-fetch-mode': 'cors' }), false);
  assert.equal(browserShaped({ 'user-agent': 'node' }), false);
  assert.equal(browserShaped({ 'user-agent': 'curl/8.5.0' }), false);
  assert.equal(browserShaped({}), false);
  assert.equal(browserShaped({ origin: '   ' }), false);
});

// -- isStaff -------------------------------------------------------------------

test('a role is required when the model has one, and not invented when it has not', () => {
  assert.equal(isStaff({ id: 'u1', role: 'admin' }), true);
  assert.equal(isStaff({ id: 'u1', role: 'superadmin' }), true);
  assert.equal(isStaff({ id: 'u1', role: 'member' }), true);
  // A project whose users collection has no `role` field at all: every
  // signed-in user of that app is its staff, and locking them out would be
  // this guard inventing an access model the project never had.
  assert.equal(isStaff({ id: 'u1', email: 'a@b.test' }), true);
  // Present but empty is a revoked grant, not a missing model.
  assert.equal(isStaff({ id: 'u1', role: '' }), false);
  assert.equal(isStaff({ id: 'u1', role: 'guest' }), false);
  assert.equal(isStaff({ id: 'u1', role: 'admin' }, ['superadmin']), false);
  assert.equal(isStaff(null), false);
});

// -- verifyUserToken -----------------------------------------------------------

/** A fetch that answers one canned response and records what it was asked. */
const fakeFetch = (answer, calls = []) => {
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: async () => answer.body,
    };
  };
  impl.calls = calls;
  return impl;
};

const OK_BODY = { token: 'a-fresh-token', record: { id: 'u_agent0000001', role: 'admin', email: 'agente@example.test' } };

test('a valid token resolves the user, asking the right PocketBase the right question', async () => {
  const f = fakeFetch({ status: 200, body: OK_BODY });
  const out = await verifyUserToken('live-token', { pbUrl: `${PB}/`, fetchImpl: f });
  assert.deepEqual(out, { ok: true, user: { id: 'u_agent0000001', role: 'admin' } });
  assert.equal(f.calls[0].url, `${PB}/api/collections/users/auth-refresh`);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.Authorization, 'live-token');
});

test('the answer carries the id and the role and nothing else — never the token, never the address', async () => {
  const f = fakeFetch({ status: 200, body: OK_BODY });
  const out = await verifyUserToken('live-token', { pbUrl: PB, fetchImpl: f });
  assert.deepEqual(Object.keys(out.user).sort(), ['id', 'role']);
});

test('an expired token is a 401, not a 500 and not a pass', async () => {
  const f = fakeFetch({ status: 401, body: { message: 'The request requires valid record authorization token to be set.' } });
  assert.deepEqual(await verifyUserToken('expired-token', { pbUrl: PB, fetchImpl: f }), { ok: false, status: 401, code: 'invalid_token' });
});

test('a token minted by another project\'s PocketBase is a 401 here', async () => {
  // Nothing checks a project name: the two instances do not share a signing
  // key, so the foreign token simply does not verify.
  const f = fakeFetch({ status: 401, body: {} });
  assert.deepEqual(await verifyUserToken('another-projects-token', { pbUrl: PB, fetchImpl: f }), { ok: false, status: 401, code: 'invalid_token' });
});

test('a 403 from the collection rule is refused as an invalid token too', async () => {
  const f = fakeFetch({ status: 403, body: {} });
  assert.deepEqual(await verifyUserToken('blocked', { pbUrl: PB, fetchImpl: f }), { ok: false, status: 401, code: 'invalid_token' });
});

test('a signed-in user who is not staff is refused by name', async () => {
  const f = fakeFetch({ status: 200, body: { record: { id: 'u_x', role: 'guest' } } });
  assert.deepEqual(await verifyUserToken('guest-token', { pbUrl: PB, fetchImpl: f }), { ok: false, status: 403, code: 'not_staff' });
});

test('a PocketBase that is down or broken refuses — never opens the door', async () => {
  for (const answer of [new Error('ECONNREFUSED'), { status: 500, body: {} }, { status: 200, body: { record: {} } }]) {
    const out = await verifyUserToken('whatever', { pbUrl: PB, fetchImpl: fakeFetch(answer) });
    assert.equal(out.ok, false);
    assert.ok(out.status === 503 || out.status === 401, JSON.stringify(out));
  }
});

test('no PocketBase configured and no token are each their own refusal, with no call made', async () => {
  const f = fakeFetch({ status: 200, body: OK_BODY });
  assert.deepEqual(await verifyUserToken('t', { pbUrl: '', fetchImpl: f }), { ok: false, status: 503, code: 'auth_not_configured' });
  assert.deepEqual(await verifyUserToken('', { pbUrl: PB, fetchImpl: f }), { ok: false, status: 401, code: 'invalid_token' });
  assert.equal(f.calls.length, 0);
});

// -- authorize -----------------------------------------------------------------

const verifyOk = async () => ({ ok: true, user: { id: 'u_agent0000001', role: 'admin' } });
const verifyNo = async () => ({ ok: false, status: 401, code: 'invalid_token' });
const deps = (over = {}) => ({ secret: SECRET, pbConfigured: true, verify: verifyOk, ...over });

test('a valid token from a browser is accepted as the user', async () => {
  const out = await authorize(
    { headers: { ...BROWSER_HEADERS, authorization: 'Bearer live-token' }, secretParam: null },
    deps(),
  );
  assert.deepEqual(out, { ok: true, via: 'user', user: { id: 'u_agent0000001', role: 'admin' } });
});

test('an expired token from a browser is a 401 — the browser has no second credential to fall back on', async () => {
  const out = await authorize(
    { headers: { ...BROWSER_HEADERS, authorization: 'Bearer expired-token' }, secretParam: SECRET },
    deps({ verify: verifyNo }),
  );
  // Note the secretParam above: even holding the leaked secret, a bad token
  // does not degrade into the secret path.
  assert.deepEqual(out, { ok: false, status: 401, code: 'invalid_token' });
});

test('no credential at all is a 403, and never a 404 that would hide the route', async () => {
  assert.deepEqual(await authorize({ headers: HOST_HEADERS, secretParam: null }, deps()),
    { ok: false, status: 403, code: 'forbidden' });
  assert.deepEqual(await authorize({ headers: BROWSER_HEADERS, secretParam: null }, deps()),
    { ok: false, status: 403, code: 'forbidden' });
});

test('a wrong secret is a 403 whoever sends it', async () => {
  assert.deepEqual(await authorize({ headers: HOST_HEADERS, secretParam: 'nope' }, deps()),
    { ok: false, status: 403, code: 'forbidden' });
});

test('THE FIX: the shared secret from a browser-shaped request is refused, by name', async () => {
  const out = await authorize({ headers: BROWSER_HEADERS, secretParam: SECRET }, deps());
  assert.deepEqual(out, { ok: false, status: 403, code: 'secret_from_browser' });
  // One header is enough — a browser cannot strip any of them.
  for (const h of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest']) {
    const one = await authorize({ headers: { [h]: BROWSER_HEADERS[h] }, secretParam: SECRET }, deps());
    assert.equal(one.code, 'secret_from_browser', h);
  }
  const ua = await authorize({ headers: { 'user-agent': 'Mozilla/5.0' }, secretParam: SECRET }, deps());
  assert.equal(ua.code, 'secret_from_browser');
});

test('the shared secret from the host still works — that is the whole compatibility promise', async () => {
  assert.deepEqual(await authorize({ headers: HOST_HEADERS, secretParam: SECRET }, deps()),
    { ok: true, via: 'secret' });
  assert.deepEqual(await authorize({ headers: {}, secretParam: SECRET }, deps()),
    { ok: true, via: 'secret' });
  // And with no PocketBase configured at all, which is how the chassis runs in
  // a project that has none.
  assert.deepEqual(await authorize({ headers: HOST_HEADERS, secretParam: SECRET }, deps({ pbConfigured: false })),
    { ok: true, via: 'secret' });
});

test('a token with no PocketBase to check it against is a 503, never an accepted one', async () => {
  const out = await authorize(
    { headers: { authorization: 'Bearer t' }, secretParam: null },
    deps({ pbConfigured: false }),
  );
  assert.deepEqual(out, { ok: false, status: 503, code: 'auth_not_configured' });
});

test('with neither mechanism configured the endpoint says so instead of refusing forever', async () => {
  assert.deepEqual(await authorize({ headers: HOST_HEADERS, secretParam: null }, deps({ secret: null, pbConfigured: false })),
    { ok: false, status: 503, code: 'auth_not_configured' });
  // With only PocketBase configured, a credential-less call is still a plain 403.
  assert.deepEqual(await authorize({ headers: HOST_HEADERS, secretParam: null }, deps({ secret: null })),
    { ok: false, status: 403, code: 'forbidden' });
});

test('an empty secret in the environment can never be matched by an empty query parameter', async () => {
  for (const secret of [null, '']) {
    assert.notEqual(
      (await authorize({ headers: HOST_HEADERS, secretParam: '' }, deps({ secret }))).ok,
      true,
      String(secret),
    );
  }
});
