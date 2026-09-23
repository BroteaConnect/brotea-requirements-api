// baja.js — the two pages the chassis renders: the answer to the opt-out link
// in an email footer and to the opt-in link of the consent campaign. Copy from
// the locales, colours and spacing only through the tokens in tokens.json
// declared as custom properties — the rules below never carry a literal.
//
// The opt-out page is bilingual (a click tells us nothing about the language
// the reader wants); the opt-in one is too until the write tells us the lead's
// language, and then the confirmation is in that language alone.
import { readFileSync } from 'node:fs';
import { escapeHtml, locale, t } from './copy.js';

const tokens = JSON.parse(readFileSync(new URL('./tokens.json', import.meta.url), 'utf8'));

const vars = [
  ...Object.entries(tokens.color).map(([k, v]) => `--color-${k}:${v}`),
  ...Object.entries(tokens.space).map(([k, v]) => `--space-${k}:${v}`),
  `--radius:${tokens.shape.radius}`,
  `--font-body:${tokens.font.body}`,
  `--font-size:${tokens.font.size}`,
  `--line:${tokens.font.line}`,
  `--container:${tokens.container}`,
].join(';');

const STYLE = `:root{${vars}}` +
  'html{background:var(--color-bg);color:var(--color-text);font-family:var(--font-body);font-size:var(--font-size);line-height:var(--line)}' +
  'body{margin:0;padding:var(--space-8) var(--space-4)}' +
  'main{max-width:var(--container);margin:0 auto;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius);padding:var(--space-6)}' +
  'h1{font-size:1.25rem;margin:0 0 var(--space-4);color:var(--color-primary)}' +
  'p{margin:0 0 var(--space-2)}' +
  'p[lang=en]{color:var(--color-muted)}' +
  'form{margin-top:var(--space-4)}' +
  'button{font:inherit;background:var(--color-primary);color:var(--color-surface);border:0;border-radius:var(--radius);padding:var(--space-2) var(--space-6);cursor:pointer}';

/**
 * The HTML page for a step of `kind` ('baja' or 'si'): 'ask' (the link was
 * opened: one button, so a mail scanner following the link never opts anyone
 * out — nor in), 'done' (written or already so) or 'invalid'. `form` carries
 * the lead and the token the button posts back; `idioma` narrows the page to
 * one language when the lead's is known.
 */
function page(kind, result, { form = {}, idioma } = {}) {
  const langs = idioma ? [locale(idioma)] : ['es', 'en'];
  const key = result === 'invalid' ? `${kind}_invalid` : result === 'ask' ? `${kind}_ask` : `${kind}_done`;
  const both = (k) => langs.map((lang) => escapeHtml(t(lang, k))).join(' · ');
  const button = result === 'ask'
    ? `<form method="post" action="/${kind}"><input type="hidden" name="lead" value="${escapeHtml(form.lead ?? '')}"><input type="hidden" name="t" value="${escapeHtml(form.t ?? '')}">` +
      `<button type="submit">${both(`${kind}_confirm`)}</button></form>`
    : '';
  return `<!doctype html><html lang="${langs[0]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(t(langs[0], `${kind}_title`))}</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${both(`${kind}_title`)}</h1>` +
    `${langs.map((lang) => `<p lang="${lang}">${escapeHtml(t(lang, key))}</p>`).join('')}${button}</main></body></html>`;
}

export const bajaPage = (result, form = {}) => page('baja', result, { form });
export const siPage = (result, options = {}) => page('si', result, options);
