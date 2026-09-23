// templates.js — the `plantillas` row as text: named placeholders for our
// own rendering, positional ones for Twilio Content, and the language pick.
//
// A body says `{{nombre}}`; Twilio Content only knows `{{1}}`, `{{2}}`…, so
// the row's `variables` array is the positional order in both directions:
// `toContentBody` rewrites the body for submission and `positional` builds
// ContentVariables for a send. Order comes from `variables`, never from
// where a placeholder first appears in the text.
const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

/** The placeholder names in a body, unique, in order of appearance. */
export const bodyPlaceholders = (body) => [...new Set([...String(body ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]))];

/** `{{name}}` → values.name; a placeholder with no value stays visible. */
export const render = (body, values = {}) =>
  String(body ?? '').replace(PLACEHOLDER, (m, name) => (values[name] == null || values[name] === '' ? m : String(values[name])));

/** ContentVariables: {"1": values[names[0]], "2": …} in the row's `variables` order. */
export const positional = (names, values = {}) =>
  Object.fromEntries((names ?? []).map((name, i) => [String(i + 1), values[name] == null ? '' : String(values[name])]));

/** `{{nombre}}` → `{{1}}` per the `variables` order; a name not in the list is left as it is. */
export const toContentBody = (body, names) =>
  String(body ?? '').replace(PLACEHOLDER, (m, name) => {
    const i = (names ?? []).indexOf(name);
    return i === -1 ? m : `{{${i + 1}}}`;
  });

/** The names in `names` that have no value (null, undefined or empty string). */
export const missingVariables = (names, values = {}) =>
  (names ?? []).filter((name) => values[name] == null || String(values[name]).trim() === '');

/** The row's `variables` as an array of names whatever PocketBase returned. */
export const variableNames = (plantilla) => {
  const v = plantilla?.variables;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
};

/**
 * The language half of a row for a lead's `idioma`: subject, body and the
 * Content sid/state of that language. The Spanish Content lives in
 * content_sid/content_estado/content_motivo, the English one in the *_en
 * trio. A missing English body falls back to Spanish so a send never goes
 * out empty; the Content pair never falls back (a wrong-language template
 * is a silent switch the lead would notice).
 */
export function pick(plantilla, idioma) {
  const lang = idioma === 'en' ? 'en' : 'es';
  const suffix = lang === 'en' ? '_en' : '';
  return {
    lang,
    asunto: plantilla[`asunto_${lang}`] || plantilla.asunto_es || '',
    cuerpo: plantilla[`cuerpo_${lang}`] || plantilla.cuerpo_es || '',
    contentSid: plantilla[`content_sid${suffix}`] || '',
    contentEstado: plantilla[`content_estado${suffix}`] || 'unsubmitted',
    contentMotivo: plantilla[`content_motivo${suffix}`] || '',
  };
}

/** A PocketBase filter string literal. */
export const pbQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The `plantillas` row for a clave, checked for the channel:
 * {plantilla, code} where code is null or one of template_unknown,
 * template_channel, template_retired.
 */
export async function loadTemplate(pb, clave, canal) {
  const filter = encodeURIComponent(`clave = ${pbQuote(clave)}`);
  const found = await pb('GET', `/api/collections/plantillas/records?perPage=1&filter=${filter}`);
  const plantilla = found?.items?.[0] ?? null;
  if (!plantilla) return { plantilla: null, code: 'template_unknown' };
  if (canal && plantilla.canal !== canal) return { plantilla, code: 'template_channel' };
  if (plantilla.estado === 'retirada') return { plantilla, code: 'template_retired' };
  return { plantilla, code: null };
}
