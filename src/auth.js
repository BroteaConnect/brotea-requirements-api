// auth.js — who may ask the chassis to send something on somebody's behalf.
//
// There are two kinds of caller and they must not share a credential:
//
//   a browser (the CRM)          → Authorization: Bearer <PocketBase user token>
//   a host process (brotea-whatsapp, jobs/*.mjs, the estate gates)
//                                → ?secret=<OUTBOUND_SECRET>
//
// Why the split, written down so it is not undone by accident: a static app
// has no private storage. Anything the bundle holds is published the moment
// the bundle is served, and `crm-inmobiliaria.brotea.dev/assets/index-*.js`
// was served anonymously with the shared secret inside it. A secret that every
// reader of a public file holds is not a credential; it is a URL. The app
// user's PocketBase JWT is the credential the browser is allowed to have,
// because it is that user's, it expires, and PocketBase's own rules bound it.
// This is the contract already written in the platform's
// docs/social-factory-buildout.md §4.4.
//
// Provider reference, read 2026-09-23:
//   PocketBase — records API, auth-refresh
//   https://pocketbase.io/docs/api-records/
//   POST /api/collections/{collection}/auth-refresh with `Authorization: <token>`
//   → 200 {token, record} for a live token, 401 for an expired, malformed or
//   foreign-signed one. Nothing about the answer is cached here: the check is
//   the token's own validity, so caching it would outlive the token.

/** The roles this chassis accepts as staff of an app, the closed set the auth
 *  brick mints (feature-templates/auth/pb/hooks/brotea-roles.js). A user with
 *  no role at all was never granted access, and the bridge never mints a token
 *  for one — but a project whose model has no `role` field must not be locked
 *  out either, so an absent field is accepted and a present-but-unknown one is
 *  not. */
export const STAFF_ROLES = ['superadmin', 'admin', 'member'];

/** The token out of an `Authorization` header, with or without the `Bearer`
 *  prefix (PocketBase itself accepts both). Empty or absent → null. */
export function bearerToken(headers = {}) {
  const value = String(headers.authorization ?? headers.Authorization ?? '').trim();
  // `Bearer` with nothing after it is an empty credential, not a token called
  // "Bearer" — a scheme name reaching PocketBase as a token is a 401 that
  // reads like an expired session and sends the agent looking in the wrong place.
  if (!value || /^bearer$/i.test(value)) return null;
  return value.replace(/^bearer\s+/i, '').trim() || null;
}

/**
 * Does this request come from a browser?
 *
 * Not an anti-attacker test — curl can send anything and omit anything, and a
 * secret that has already been published cannot be defended by inspecting
 * headers. It is the opposite test, and that one is sound: a browser cannot
 * omit any of these. `Origin` is mandatory on every request whose method is
 * not GET or HEAD, `Sec-Fetch-Site` and `Sec-Fetch-Dest` are forbidden header
 * names no page script can suppress, and `User-Agent` cannot be made to stop
 * saying `Mozilla/`. So "no browser may use the secret path" is enforceable
 * even though "only the host may" is not. The second half is rotation's job.
 *
 * `Sec-Fetch-Mode` is deliberately NOT in the list, and the omission is the
 * whole reason this function is tested. Node's own `fetch` (undici) sends
 * `sec-fetch-mode: cors` on every call it makes — so treating that header as a
 * browser tell locks out `brotea-whatsapp`, `jobs/*.mjs` and the estate gates,
 * all of which are node `fetch`. Node sends no `Origin`, no `Sec-Fetch-Site`,
 * no `Sec-Fetch-Dest`, and a `User-Agent` of `node`.
 */
export function browserShaped(headers = {}) {
  const has = (n) => {
    const v = headers[n] ?? headers[n.toLowerCase()];
    return typeof v === 'string' && v.trim() !== '';
  };
  if (has('origin') || has('referer')) return true;
  if (has('sec-fetch-site') || has('sec-fetch-dest')) return true;
  const ua = String(headers['user-agent'] ?? headers['User-Agent'] ?? '');
  return /^Mozilla\//.test(ua);
}

/** Is this PocketBase record a staff member of the app? A record with no
 *  `role` field is accepted (the project's model does not express one); a
 *  record with a role outside the closed set is not. */
export function isStaff(record, roles = STAFF_ROLES) {
  if (!record || typeof record !== 'object') return false;
  if (!('role' in record)) return true;
  const role = String(record.role ?? '').trim();
  if (!role) return false;
  return roles.includes(role);
}

/**
 * Validate one PocketBase user token against one PocketBase instance.
 *
 * Resolves {ok: true, user} or {ok: false, status, code}. A token signed by
 * another project's PocketBase fails here for a cryptographic reason, not a
 * naming one: the instances do not share a signing key, so `auth-refresh`
 * answers 401 — which is why this never needs to be told which project a
 * request claims to belong to.
 */
export async function verifyUserToken(token, { pbUrl, collection = 'users', fetchImpl = fetch, timeoutMs = 5_000, roles = STAFF_ROLES } = {}) {
  if (!pbUrl) return { ok: false, status: 503, code: 'auth_not_configured' };
  if (!token) return { ok: false, status: 401, code: 'invalid_token' };
  let res;
  try {
    res = await fetchImpl(`${String(pbUrl).replace(/\/+$/, '')}/api/collections/${encodeURIComponent(collection)}/auth-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // A PocketBase that does not answer is never an open door.
    console.error('token check unreachable:', e.message);
    return { ok: false, status: 503, code: 'auth_unavailable' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: 401, code: 'invalid_token' };
  if (!res.ok) {
    console.error(`token check failed: pb ${res.status}`);
    return { ok: false, status: 503, code: 'auth_unavailable' };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, status: 503, code: 'auth_unavailable' };
  }
  const record = body?.record;
  if (!record?.id) return { ok: false, status: 401, code: 'invalid_token' };
  if (!isStaff(record, roles)) return { ok: false, status: 403, code: 'not_staff' };
  // Only what an events row may carry travels on: an id and a role.
  return { ok: true, user: { id: record.id, role: record.role ?? null } };
}

/**
 * The credential decision for one request to an endpoint a browser calls.
 *
 * `verify` is the token check (wired to `verifyUserToken` by the server, to a
 * fake by the tests), `secret` the shared one or null. Resolves
 * {ok: true, via: 'user'|'secret', user?} or {ok: false, status, code}.
 *
 * Order matters and is deliberate:
 *   1. a Bearer token is always answered by the token check, even when the
 *      request also carries the secret — the token is the stronger claim and
 *      a valid one must not be silently downgraded to `via: 'secret'`;
 *   2. the secret is accepted only from a request no browser could have made;
 *   3. a browser-shaped request bearing the secret is refused by name, so the
 *      one thing this PR exists to stop is legible in a log.
 */
export async function authorize({ headers = {}, secretParam = null }, { secret = null, pbConfigured = false, verify } = {}) {
  const token = bearerToken(headers);
  if (token) {
    if (!pbConfigured) return { ok: false, status: 503, code: 'auth_not_configured' };
    const checked = await verify(token);
    return checked.ok ? { ...checked, via: 'user' } : checked;
  }
  if (secretParam != null && secret && secretParam === secret) {
    if (browserShaped(headers)) return { ok: false, status: 403, code: 'secret_from_browser' };
    return { ok: true, via: 'secret' };
  }
  if (!secret && !pbConfigured) return { ok: false, status: 503, code: 'auth_not_configured' };
  return { ok: false, status: 403, code: 'forbidden' };
}
