// What POST /send-email resolves before anything is sent: the consent gate
// and the two signed links. The rows are the live `plantillas` of the estate
// project (pb/plantillas.json in the landing repo), copied verbatim so a
// change to a body that breaks a placeholder shows up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemplateEmail } from '../src/email.js';
import { bajaUrl, siUrl } from '../src/consent.js';
import { fakePb } from './helpers/fake-pb.mjs';

const PUBLIC_URL = 'https://api.brotea.dev';
const SECRET = 's3cret';
const ctx = (pb) => ({ pb, publicUrl: PUBLIC_URL, secret: SECRET });

const solicitud = {
  id: 'pl1', clave: 'consentimiento.solicitud.email', nombre: 'Solicitud de consentimiento (email)',
  canal: 'email', categoria: 'marketing', evento: 'campana.consentimiento', estado: 'aprobada', version: 1,
  variables: ['nombre', 'agencia', 'si_url', 'url', 'baja_url'],
  asunto_es: '¿Te avisamos de viviendas que encajen contigo?',
  asunto_en: 'Shall we tell you about homes that fit you?',
  cuerpo_es: 'Hola {{nombre}},\n\nSomos {{agencia}}. Si estás de acuerdo, confirma aquí: {{si_url}}\n\nCómo tratamos tus datos: {{url}}/privacidad\n\nSi no quieres recibir más correos: {{baja_url}}',
  cuerpo_en: 'Hi {{nombre}},\n\nThis is {{agencia}}. If you agree, confirm here: {{si_url}}\n\nHow we handle your data: {{url}}/privacidad\n\nIf you do not want more emails: {{baja_url}}',
};
const reactivacion = {
  id: 'pl2', clave: 'lead.reactivacion.email', nombre: 'Reactivación de lead dormido (email)',
  canal: 'email', categoria: 'marketing', evento: 'job.reactivacion', estado: 'aprobada', version: 2,
  variables: ['nombre', 'n_propiedades', 'municipio', 'url', 'agente', 'baja_url'],
  asunto_es: 'Novedades en {{municipio}}: {{n_propiedades}} viviendas',
  cuerpo_es: 'Hola {{nombre}}, tenemos {{n_propiedades}} en {{municipio}}. Míralas aquí: {{url}}. Te atiende {{agente}}.\n\nSi no quieres recibir más correos: {{baja_url}}',
};
const visita = {
  id: 'pl3', clave: 'visita.confirmacion.email', nombre: 'Confirmación de visita (email)',
  canal: 'email', categoria: 'utility', evento: 'visita.created', estado: 'aprobada', version: 1,
  variables: ['nombre', 'propiedad'], asunto_es: 'Confirmación: {{propiedad}}', cuerpo_es: 'Hola {{nombre}}, visita a {{propiedad}}.',
};
const plantillas = [solicitud, reactivacion, visita];

// The 216 imported leads of CU-15: consent never given, never asked.
const historico = { id: 'lead1', nombre: 'María', email: 'maria@example.com', idioma: 'es', origen: 'histórico', consentimiento: false };
const optedOut = { ...historico, id: 'lead2', consentimiento: false, consentimiento_en: '2026-09-01 10:00:00.000Z' };
const consenting = { ...historico, id: 'lead3', consentimiento: true };

const vars = { agencia: 'Inmobiliaria Brotea', url: 'https://inmobiliaria.brotea.dev' };
const setup = (leads = [historico]) => fakePb({ leads, plantillas });

test('the consent request reaches a lead nobody ever asked — the gate that would refuse all 216', async () => {
  const pb = setup();
  const r = await resolveTemplateEmail({ leadId: 'lead1', clave: 'consentimiento.solicitud.email', given: vars }, ctx(pb));
  assert.equal(r.code, undefined, 'the message whose purpose is to ask cannot require consent');
  assert.equal(r.to, 'maria@example.com');
  assert.equal(r.idioma, 'es');
  assert.equal(r.subject, solicitud.asunto_es);
});

test('a second marketing template does not inherit the exemption', async () => {
  const pb = setup();
  const r = await resolveTemplateEmail(
    { leadId: 'lead1', clave: 'lead.reactivacion.email', given: { ...vars, n_propiedades: '4', municipio: 'Alicante', agente: 'Laura' } },
    ctx(pb),
  );
  assert.equal(r.code, 'no_consent');
  assert.equal(r.status, 422);
});

test('a lead who opted out is refused with consent_revoked, not the generic no_consent', async () => {
  const pb = setup([optedOut]);
  const request = await resolveTemplateEmail({ leadId: 'lead2', clave: 'consentimiento.solicitud.email', given: vars }, ctx(pb));
  assert.equal(request.code, 'consent_revoked');
  assert.equal(request.status, 422);
  const other = await resolveTemplateEmail({ leadId: 'lead2', clave: 'lead.reactivacion.email', given: vars }, ctx(pb));
  assert.equal(other.code, 'consent_revoked');
  // Utility is untouched by any of it.
  const utility = await resolveTemplateEmail({ leadId: 'lead2', clave: 'visita.confirmacion.email', given: { propiedad: 'Piso' } }, ctx(pb));
  assert.equal(utility.code, undefined);
});

test('si_url and baja_url reach the body without the caller supplying either', async () => {
  const pb = setup();
  const r = await resolveTemplateEmail({ leadId: 'lead1', clave: 'consentimiento.solicitud.email', given: vars }, ctx(pb));
  assert.equal(r.code, undefined, 'never a variables_missing for a link only the chassis can mint');
  assert.ok(r.text.includes(siUrl(PUBLIC_URL, 'lead1', SECRET)));
  assert.ok(r.text.includes(bajaUrl(PUBLIC_URL, 'lead1', SECRET)));
  assert.doesNotMatch(r.text, /\{\{/, 'no placeholder survives into an inbox');
  assert.equal(r.values.si_url, siUrl(PUBLIC_URL, 'lead1', SECRET));
  // A template that declares only the opt-out link gets only that one.
  const other = await resolveTemplateEmail(
    { leadId: 'lead3', clave: 'lead.reactivacion.email', given: { ...vars, n_propiedades: '4', municipio: 'Alicante', agente: 'Laura' } },
    ctx(setup([consenting])),
  );
  assert.equal(other.code, undefined);
  assert.ok(other.text.includes(bajaUrl(PUBLIC_URL, 'lead3', SECRET)));
  assert.equal(other.values.si_url, undefined);
});

test('a caller cannot substitute its own opt-in or opt-out link', async () => {
  const pb = setup();
  const r = await resolveTemplateEmail(
    { leadId: 'lead1', clave: 'consentimiento.solicitud.email', given: { ...vars, si_url: 'https://evil.example/si', baja_url: 'https://evil.example/baja' } },
    ctx(pb),
  );
  assert.equal(r.values.si_url, siUrl(PUBLIC_URL, 'lead1', SECRET));
  assert.equal(r.values.baja_url, bajaUrl(PUBLIC_URL, 'lead1', SECRET));
  assert.ok(!r.text.includes('evil.example'));
});

test('with no public origin or no secret the links are named by the refusal, never rendered as placeholders', async () => {
  for (const missing of [{ publicUrl: '' }, { secret: null }]) {
    const r = await resolveTemplateEmail(
      { leadId: 'lead1', clave: 'consentimiento.solicitud.email', given: vars },
      { ...ctx(setup()), ...missing },
    );
    assert.equal(r.code, 'variables_missing');
    assert.equal(r.status, 400);
    assert.equal(r.vars.names, 'si_url, baja_url');
  }
});

test('the refusals that were already there keep their codes and statuses', async () => {
  const pb = setup([{ ...historico, id: 'lead9', email: 'not-an-email' }]);
  assert.deepEqual(
    await resolveTemplateEmail({ leadId: '', clave: 'visita.confirmacion.email' }, ctx(pb)),
    { code: 'lead_required', status: 400, vars: undefined },
  );
  const unknown = await resolveTemplateEmail({ leadId: 'nobody', clave: 'visita.confirmacion.email' }, ctx(pb));
  assert.deepEqual([unknown.code, unknown.status], ['lead_unknown', 404]);
  const noTemplate = await resolveTemplateEmail({ leadId: 'lead9', clave: 'nope' }, ctx(pb));
  assert.deepEqual([noTemplate.code, noTemplate.status], ['template_unknown', 404]);
  const noEmail = await resolveTemplateEmail({ leadId: 'lead9', clave: 'visita.confirmacion.email' }, ctx(pb));
  assert.deepEqual([noEmail.code, noEmail.status], ['no_email', 400]);
  const retired = await resolveTemplateEmail(
    { leadId: 'lead1', clave: 'visita.confirmacion.email' },
    ctx(fakePb({ leads: [historico], plantillas: [{ ...visita, estado: 'retirada' }] })),
  );
  assert.deepEqual([retired.code, retired.status], ['template_retired', 422]);
  const wrongChannel = await resolveTemplateEmail(
    { leadId: 'lead1', clave: 'visita.confirmacion.email' },
    ctx(fakePb({ leads: [historico], plantillas: [{ ...visita, canal: 'whatsapp' }] })),
  );
  assert.deepEqual([wrongChannel.code, wrongChannel.status, wrongChannel.vars], ['template_channel', 400, { canal: 'email' }]);
  const missing = await resolveTemplateEmail({ leadId: 'lead1', clave: 'visita.confirmacion.email' }, ctx(setup()));
  assert.deepEqual([missing.code, missing.vars.names], ['variables_missing', 'propiedad']);
});
