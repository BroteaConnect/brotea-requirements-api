import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyPlaceholders, loadTemplate, missingVariables, pick, positional, render, toContentBody, variableNames } from '../src/templates.js';
import { fakePb } from './helpers/fake-pb.mjs';

const body = 'Hola {{nombre}}, te confirmamos la visita a {{propiedad}} el {{fecha}} a las {{hora}}. Hasta el {{fecha}}.';
const names = ['nombre', 'propiedad', 'fecha', 'hora'];

test('bodyPlaceholders lists names once, in order of appearance', () => {
  assert.deepEqual(bodyPlaceholders(body), names);
  assert.deepEqual(bodyPlaceholders('{{ a }} {{b_2}} {{A}}'), ['a', 'b_2']);
  assert.deepEqual(bodyPlaceholders(null), []);
});

test('render fills values and leaves a missing placeholder visible', () => {
  assert.equal(render(body, { nombre: 'María', propiedad: 'Piso', fecha: 'lunes', hora: '10:00' }), 'Hola María, te confirmamos la visita a Piso el lunes a las 10:00. Hasta el lunes.');
  assert.equal(render('Hola {{nombre}}', {}), 'Hola {{nombre}}');
  assert.equal(render('Hola {{nombre}}', { nombre: '' }), 'Hola {{nombre}}');
  assert.equal(render('{{n}}', { n: 0 }), '0');
});

test('positional follows the variables order, not the order of appearance', () => {
  const order = ['hora', 'nombre', 'fecha', 'propiedad'];
  assert.deepEqual(positional(order, { nombre: 'María', propiedad: 'Piso', fecha: 'lunes', hora: '10:00' }), { 1: '10:00', 2: 'María', 3: 'lunes', 4: 'Piso' });
  assert.deepEqual(positional(['a'], {}), { 1: '' });
});

test('toContentBody rewrites named placeholders as positional ones per the variables order', () => {
  assert.equal(toContentBody(body, names), 'Hola {{1}}, te confirmamos la visita a {{2}} el {{3}} a las {{4}}. Hasta el {{3}}.');
  assert.equal(toContentBody('Hola {{nombre}} {{otro}}', ['nombre']), 'Hola {{1}} {{otro}}');
});

test('missingVariables reports the names with no value after the nombre auto-fill', () => {
  const values = { nombre: 'Lead name', propiedad: 'Piso' };
  assert.deepEqual(missingVariables(names, values), ['fecha', 'hora']);
  assert.deepEqual(missingVariables(names, { ...values, fecha: ' ', hora: '10' }), ['fecha']);
  assert.deepEqual(missingVariables([], {}), []);
});

test('variableNames reads an array or a JSON string', () => {
  assert.deepEqual(variableNames({ variables: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(variableNames({ variables: '["a"]' }), ['a']);
  assert.deepEqual(variableNames({ variables: 'nope' }), []);
  assert.deepEqual(variableNames({}), []);
});

const row = {
  asunto_es: 'Confirmación', asunto_en: 'Confirmation', cuerpo_es: 'Hola {{nombre}}', cuerpo_en: 'Hi {{nombre}}',
  content_sid: 'HXes', content_estado: 'approved', content_motivo: '',
  content_sid_en: 'HXen', content_estado_en: 'rejected', content_motivo_en: 'INVALID_FORMAT',
};

test('pick returns the English fields and the *_en Content pair for idioma en', () => {
  assert.deepEqual(pick(row, 'en'), { lang: 'en', asunto: 'Confirmation', cuerpo: 'Hi {{nombre}}', contentSid: 'HXen', contentEstado: 'rejected', contentMotivo: 'INVALID_FORMAT' });
  assert.deepEqual(pick(row, 'es'), { lang: 'es', asunto: 'Confirmación', cuerpo: 'Hola {{nombre}}', contentSid: 'HXes', contentEstado: 'approved', contentMotivo: '' });
  assert.equal(pick(row, undefined).lang, 'es');
  // No English Content yet (the *_en fields are absent): the body falls back, the Content does not.
  const p = pick({ cuerpo_es: 'Hola', content_sid: 'HXes', content_estado: 'approved' }, 'en');
  assert.equal(p.cuerpo, 'Hola');
  assert.equal(p.contentSid, '');
  assert.equal(p.contentEstado, 'unsubmitted');
});

test('loadTemplate finds by clave and names the problem', async () => {
  const pb = fakePb({ plantillas: [
    { id: 'p1', clave: 'visita.confirmacion', canal: 'whatsapp', estado: 'aprobada' },
    { id: 'p2', clave: 'lead.nuevo', canal: 'email', estado: 'aprobada' },
    { id: 'p3', clave: 'vieja', canal: 'whatsapp', estado: 'retirada' },
  ] });
  assert.equal((await loadTemplate(pb, 'visita.confirmacion', 'whatsapp')).code, null);
  assert.equal((await loadTemplate(pb, 'nope', 'whatsapp')).code, 'template_unknown');
  assert.equal((await loadTemplate(pb, 'lead.nuevo', 'whatsapp')).code, 'template_channel');
  assert.equal((await loadTemplate(pb, 'vieja', 'whatsapp')).code, 'template_retired');
  assert.match(pb.reads[0].query, /clave = "visita\.confirmacion"/);
});
