import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANK, STATUS_MAP, buildApprovalRequest, buildCreateContent, buildFetchContent, buildListContentAndApprovals, buildSendMessage,
  callTwilio, moves, parseStatusCallback, signature, twilioAuth, twilioCaller, twilioError, validSignature, whatsappAddress,
} from '../src/twilio.js';

// The worked example from Twilio's "Validating requests" documentation.
const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
const token = '12345';

test('signature matches the documented Twilio vector', () => {
  assert.equal(signature(token, url, params), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  assert.ok(validSignature(token, url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!validSignature(token, url, { ...params, Digits: '9999' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!validSignature(token, url, params, undefined));
  assert.ok(!validSignature(token, url, params, ''));
  assert.ok(!validSignature('other', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!validSignature(token, 'https://mycompany.com/myapp.php', params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
});

test('whatsappAddress normalises with or without the prefix', () => {
  assert.equal(whatsappAddress('+15554760953'), 'whatsapp:+15554760953');
  assert.equal(whatsappAddress('whatsapp:+15554760953'), 'whatsapp:+15554760953');
  assert.equal(whatsappAddress(' WHATSAPP:+1 '), 'whatsapp:+1');
});

test('buildSendMessage: free text inside the window', () => {
  const r = buildSendMessage({ accountSid: 'AC1', from: '+15554760953', to: '+34600000001', body: 'Hola', statusCallback: 'https://api.brotea.dev/twilio-status' });
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(r.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(r.body instanceof URLSearchParams);
  assert.deepEqual(Object.fromEntries(r.body), { From: 'whatsapp:+15554760953', To: 'whatsapp:+34600000001', Body: 'Hola', StatusCallback: 'https://api.brotea.dev/twilio-status' });
  assert.equal(r.headers.Authorization, undefined, 'a builder never carries a credential');
});

test('buildSendMessage: a Content template outside the window', () => {
  const r = buildSendMessage({ accountSid: 'AC1', from: 'whatsapp:+1', to: '+34600000001', contentSid: 'HX' + '0'.repeat(32), contentVariables: { 1: 'María', 2: 'Piso' }, statusCallback: 'https://x/twilio-status' });
  const form = Object.fromEntries(r.body);
  assert.equal(form.ContentSid, 'HX' + '0'.repeat(32));
  assert.equal(form.ContentVariables, '{"1":"María","2":"Piso"}');
  assert.equal(form.Body, undefined);
  assert.throws(() => buildSendMessage({ accountSid: 'AC1', from: '+1', to: '+2', body: 'x', contentSid: 'HX' }), /exactly one/);
  assert.throws(() => buildSendMessage({ accountSid: 'AC1', from: '+1', to: '+2' }), /exactly one/);
});

test('buildCreateContent and buildApprovalRequest follow the Content API shapes', () => {
  const c = buildCreateContent({ friendlyName: 'visita_confirmacion_es_v1', language: 'es', body: 'Hola {{1}}, visita a {{2}}', variables: { 1: 'María', 2: 'Piso' } });
  assert.equal(c.method, 'POST');
  assert.equal(c.url, 'https://content.twilio.com/v1/Content');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.deepEqual(c.body, { friendly_name: 'visita_confirmacion_es_v1', language: 'es', variables: { 1: 'María', 2: 'Piso' }, types: { 'twilio/text': { body: 'Hola {{1}}, visita a {{2}}' } } });
  assert.throws(() => buildCreateContent({ friendlyName: 'visita.confirmacion', language: 'es', body: 'x' }), /friendlyName/);

  const a = buildApprovalRequest({ sid: 'HX1', name: 'visita_confirmacion_es_v1', category: 'utility' });
  assert.equal(a.url, 'https://content.twilio.com/v1/Content/HX1/ApprovalRequests/whatsapp');
  assert.deepEqual(a.body, { name: 'visita_confirmacion_es_v1', category: 'UTILITY' });
  assert.equal(buildApprovalRequest({ sid: 'HX1', name: 'x', category: 'marketing' }).body.category, 'MARKETING');
  assert.throws(() => buildApprovalRequest({ sid: 'HX1', name: 'x', category: 'authentication' }), /category/);

  const f = buildFetchContent({ sid: 'HX' + 'a'.repeat(32) });
  assert.equal(f.method, 'GET');
  assert.equal(f.url, `https://content.twilio.com/v1/Content/HX${'a'.repeat(32)}`);
  assert.throws(() => buildFetchContent({ sid: '../Content' }), /Content sid/);

  const l = buildListContentAndApprovals();
  assert.equal(l.method, 'GET');
  assert.equal(l.url, 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=100');
  assert.equal(buildListContentAndApprovals({ pageSize: 50, pageToken: 'PAHX1' }).url, 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=50&PageToken=PAHX1');
});

test('STATUS_MAP is the documented provider mapping', () => {
  assert.equal(STATUS_MAP.queued, 'registrado');
  assert.equal(STATUS_MAP.sending, 'registrado');
  assert.equal(STATUS_MAP.sent, 'enviado');
  assert.equal(STATUS_MAP.delivered, 'entregado');
  assert.equal(STATUS_MAP.read, 'abierto');
  assert.equal(STATUS_MAP.failed, 'error');
  assert.equal(STATUS_MAP.undelivered, 'error');
  assert.equal(STATUS_MAP.received, undefined);
});

test('a state never goes backwards (the full table)', () => {
  const states = ['registrado', 'enviado', 'entregado', 'abierto', 'click', 'error'];
  for (const from of states) {
    for (const to of states) {
      assert.equal(moves(from, to), RANK[to] > RANK[from], `${from} → ${to}`);
    }
  }
  for (const to of states) assert.equal(moves('simulado', to), false, `simulado → ${to}`);
  assert.equal(moves(undefined, 'registrado'), true);
  assert.equal(moves('', 'enviado'), true);
  assert.equal(moves('enviado', 'nope'), false);
});

test('parseStatusCallback reads the fields the ledger cares about and masks phones', () => {
  assert.deepEqual(parseStatusCallback({ MessageSid: 'SM1', MessageStatus: 'delivered', AccountSid: 'AC1' }), { mensaje_id: 'SM1', status: 'delivered', error_code: null, error_message: null });
  assert.deepEqual(parseStatusCallback({ MessageSid: 'SM2', MessageStatus: 'failed', ErrorCode: 63024, ErrorMessage: 'No WhatsApp on +34600000001' }), { mensaje_id: 'SM2', status: 'failed', error_code: '63024', error_message: 'No WhatsApp on +…' });
});

test('twilioError keeps the code verbatim and masks phones in the message', () => {
  const e = twilioError(400, { code: 63016, message: 'Failed to send freeform message to whatsapp:+34600000001 outside the window', more_info: 'https://www.twilio.com/docs/errors/63016' });
  assert.equal(e.code, '63016');
  assert.equal(e.status, 400);
  assert.doesNotMatch(e.text, /600000001/);
  assert.match(e.text, /outside the window/);
  assert.equal(twilioError(429, {}).code, 'http_429');
});

test('twilioAuth and twilioCaller add the credential only at the edge', async () => {
  assert.equal(twilioAuth('AC1', 'tok'), 'Basic ' + Buffer.from('AC1:tok').toString('base64'));
  const seen = [];
  const fetchImpl = async (u, init) => { seen.push({ u, init }); return { status: 201, json: async () => ({ sid: 'SM1' }) }; };
  const call = twilioCaller({ accountSid: 'AC1', authToken: 'tok' }, fetchImpl);
  const r = await call(buildSendMessage({ accountSid: 'AC1', from: '+1', to: '+2', body: 'x' }));
  assert.deepEqual(r, { status: 201, ok: true, data: { sid: 'SM1' } });
  assert.equal(seen[0].init.headers.Authorization, twilioAuth('AC1', 'tok'));
  assert.ok(seen[0].init.body instanceof URLSearchParams);
  // JSON bodies are serialised; a non-JSON answer is an empty object, not a throw.
  const j = await callTwilio(buildCreateContent({ friendlyName: 'a', language: 'es', body: 'x' }), async (u, init) => { seen.push({ u, init }); return { status: 500, json: async () => { throw new Error('html'); } }; });
  assert.deepEqual(j, { status: 500, ok: false, data: {} });
  assert.equal(seen[1].init.body, JSON.stringify({ friendly_name: 'a', language: 'es', variables: {}, types: { 'twilio/text': { body: 'x' } } }));
});
