// twilio.js — pure request builders for Twilio's Messages and Content APIs,
// the callback signature check, the status taxonomy, and one thin caller.
// Nothing here holds a credential: the builders produce {method, url,
// headers, body} and `twilioCaller` adds the Authorization header at the
// edge. Everything but `callTwilio` is unit-testable without a network.
//
// References read on 2026-09-23:
//   Messages API (create, ContentSid/ContentVariables, StatusCallback, status
//   values, the 1,600-character Body cap):
//     https://www.twilio.com/docs/messaging/api/message-resource
//   Content API (create a Content resource, request WhatsApp approval, read
//   the approval state, list ContentAndApprovals):
//     https://www.twilio.com/docs/content/content-api-resources
//   Webhook signature (HMAC-SHA1 over url + sorted key+value, base64):
//     https://www.twilio.com/docs/usage/webhooks/webhooks-security
//   Error codes used by the taxonomy, each at
//     https://www.twilio.com/docs/api/errors/<code>
//     21211 21408 21610 21614 63003 63005 63007 63012 63013 63015 63016 63018
//     63021 63024 63032 63038 63040 63041 63042 63049 63051
//
// Shapes settled on:
//   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
//     form: From, To, StatusCallback, and either Body or ContentSid +
//     ContentVariables (a JSON string keyed "1", "2", … in positional order)
//   POST https://content.twilio.com/v1/Content
//     json: {friendly_name, language, variables: {"1": sample}, types: {"twilio/text": {body}}}
//   POST https://content.twilio.com/v1/Content/{sid}/ApprovalRequests/whatsapp
//     json: {name, category}  (category upper-cased: UTILITY | MARKETING)
//   GET  https://content.twilio.com/v1/ContentAndApprovals?PageSize=&PageToken=
//     items: {sid, friendly_name, language, approval_requests: {status, rejection_reason, …}}
import { createHmac, timingSafeEqual } from 'node:crypto';
import { maskPhones } from './phone.js';

// -- signature ------------------------------------------------------------------
// Copied VERBATIM from the platform's whatsapp/src/transports/twilio.js, which
// carries Twilio's documented test vector. Never edit these two functions
// here: change them there and copy again.

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + Σ sorted(key+value))).
 * `url` must be the exact URL Twilio called, query string included.
 */
export function signature(authToken, url, params) {
  const keys = Object.keys(params).sort();
  const data = url + keys.map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function validSignature(authToken, url, params, given) {
  if (!given) return false;
  const a = Buffer.from(signature(authToken, url, params));
  const b = Buffer.from(String(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

// -- builders ------------------------------------------------------------------
const MESSAGES_ORIGIN = 'https://api.twilio.com/2010-04-01/Accounts';
const CONTENT_ORIGIN = 'https://content.twilio.com/v1';
export const BODY_MAX = 1600;

/** `whatsapp:+…` whether or not the value already carries the prefix. */
export const whatsappAddress = (value) => `whatsapp:${String(value ?? '').trim().replace(/^whatsapp:/i, '')}`;

/** The Authorization header value for the account. Built at the edge, never inside a builder. */
export const twilioAuth = (accountSid, authToken) => 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

/**
 * One outbound message: free text (`body`) inside the 24-hour window, or an
 * approved Content template (`contentSid` + `contentVariables`) outside it.
 * `body` and `contentSid` are exclusive; `statusCallback` goes on every send.
 */
export function buildSendMessage({ accountSid, from, to, body, contentSid, contentVariables, statusCallback }) {
  if (!accountSid) throw new Error('buildSendMessage: accountSid required');
  if (!!body === !!contentSid) throw new Error('buildSendMessage: exactly one of body or contentSid');
  const form = new URLSearchParams({ From: whatsappAddress(from), To: whatsappAddress(to) });
  if (contentSid) {
    form.set('ContentSid', contentSid);
    form.set('ContentVariables', JSON.stringify(contentVariables ?? {}));
  } else {
    form.set('Body', String(body));
  }
  if (statusCallback) form.set('StatusCallback', statusCallback);
  return {
    method: 'POST',
    url: `${MESSAGES_ORIGIN}/${accountSid}/Messages.json`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  };
}

/** A Content resource of type twilio/text. `variables` are the sample values Meta reviews, keyed "1", "2", … */
export function buildCreateContent({ friendlyName, language, body, variables }) {
  if (!/^[a-z0-9_]+$/.test(String(friendlyName))) throw new Error('buildCreateContent: friendlyName must match ^[a-z0-9_]+$');
  return {
    method: 'POST',
    url: `${CONTENT_ORIGIN}/Content`,
    headers: { 'Content-Type': 'application/json' },
    body: { friendly_name: friendlyName, language, variables: variables ?? {}, types: { 'twilio/text': { body } } },
  };
}

/** The WhatsApp approval request for a Content sid. Meta's category is upper-cased; the name is lowercase alphanumerics and underscores. */
export function buildApprovalRequest({ sid, name, category }) {
  const cat = String(category ?? '').toUpperCase();
  if (!['UTILITY', 'MARKETING'].includes(cat)) throw new Error(`buildApprovalRequest: category must be utility or marketing, got ${category}`);
  if (!/^[a-z0-9_]+$/.test(String(name))) throw new Error('buildApprovalRequest: name must match ^[a-z0-9_]+$');
  return {
    method: 'POST',
    url: `${CONTENT_ORIGIN}/Content/${sid}/ApprovalRequests/whatsapp`,
    headers: { 'Content-Type': 'application/json' },
    body: { name, category: cat },
  };
}

/** One page of every Content resource with its approval state. */
export function buildListContentAndApprovals({ pageSize = 100, pageToken } = {}) {
  const q = new URLSearchParams({ PageSize: String(pageSize) });
  if (pageToken) q.set('PageToken', pageToken);
  return { method: 'GET', url: `${CONTENT_ORIGIN}/ContentAndApprovals?${q}`, headers: {}, body: null };
}

// -- status taxonomy -----------------------------------------------------------------
/** Twilio's message status → envios.estado. Anything not here is left alone. */
export const STATUS_MAP = {
  queued: 'registrado',
  accepted: 'registrado',
  sending: 'registrado',
  sent: 'enviado',
  delivered: 'entregado',
  read: 'abierto',
  failed: 'error',
  undelivered: 'error',
};

/** The never-backwards rank of envios.estado / actividades.estado_envio. */
export const RANK = { registrado: 0, enviado: 1, entregado: 2, abierto: 3, click: 4, error: 5 };

/** True when a row in `from` may move to `to`: strictly forward, and never out of `simulado`. */
export const moves = (from, to) => from !== 'simulado' && to in RANK && (RANK[to] > (RANK[from] ?? -1));

/** The fields of a status callback the ledger cares about. */
export const parseStatusCallback = (form) => ({
  mensaje_id: form.MessageSid ?? form.SmsSid ?? null,
  status: form.MessageStatus ?? form.SmsStatus ?? null,
  error_code: form.ErrorCode ? String(form.ErrorCode) : null,
  error_message: form.ErrorMessage ? maskPhones(form.ErrorMessage).slice(0, 300) : null,
});

// -- errors and the caller ----------------------------------------------------------
/** Twilio's error body → Error {code, text, status}. The code is kept verbatim; phones in the message are masked. */
export function twilioError(status, data = {}) {
  const code = data.code != null ? String(data.code) : `http_${status}`;
  const text = maskPhones(data.message ?? data.error_message ?? `HTTP ${status}`).slice(0, 300);
  const err = new Error(`Twilio ${status}: ${text} (${code})`);
  err.code = code;
  err.text = text;
  err.status = status;
  err.more_info = data.more_info ?? null;
  return err;
}

/**
 * Perform one built request. Resolves {status, ok, data}; rejects only on a
 * network failure or the 20-second timeout (the caller maps that to
 * provider_unavailable). A non-2xx answer is a value, not an exception.
 */
export async function callTwilio(req, fetchImpl = fetch) {
  const body = req.body == null ? undefined : req.body instanceof URLSearchParams ? req.body : JSON.stringify(req.body);
  const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body, signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.status >= 200 && res.status < 300, data };
}

/** The caller bound to an account: adds Authorization and performs the request. */
export const twilioCaller = ({ accountSid, authToken }, fetchImpl = fetch) => {
  const auth = twilioAuth(accountSid, authToken);
  return (req) => callTwilio({ ...req, headers: { ...req.headers, Authorization: auth } }, fetchImpl);
};
