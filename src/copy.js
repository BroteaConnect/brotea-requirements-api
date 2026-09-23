// copy.js — the chassis's own user-facing strings, one file per language, as
// data. A copy of whatsapp/src/copy.js in the platform repo: the shape is the
// same so a string moved between the two services keeps its key.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const load = (code) => JSON.parse(readFileSync(join(dir, `${code}.json`), 'utf8'));
const dicts = { es: load('es'), en: load('en') };

/** The language code the copy exists in; anything else falls back to Spanish. */
export const locale = (code) => (code === 'en' ? 'en' : 'es');

/**
 * The string for `key` in `locale` (Spanish when the locale or the key is
 * missing). With `vars`, every `{name}` in it is replaced by `vars.name`;
 * a placeholder with no value stays visible rather than vanishing.
 */
export const t = (loc, key, vars) => {
  const s = (dicts[loc] ?? dicts.es)[key] ?? dicts.es[key] ?? key;
  if (typeof s !== 'string' || !vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) => (vars[name] == null ? m : String(vars[name])));
};

/** True when the locale carries a string for `key` (used for provider codes). */
export const has = (loc, key) => typeof (dicts[loc] ?? dicts.es)[key] === 'string';

/** The whole dictionary of a locale, for tests and for the sample values. */
export const dict = (loc) => dicts[loc] ?? dicts.es;

/** Anything a person typed goes through this before an HTML page. */
export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
