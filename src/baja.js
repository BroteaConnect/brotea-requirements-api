// baja.js — the one page the chassis renders: the answer to the opt-out
// link in an email footer. Both languages on one page (we do not know which
// one the reader wants from a click), copy from the locales, colours and
// spacing only through the tokens in tokens.json declared as custom
// properties — the rules below never carry a literal.
import { readFileSync } from 'node:fs';
import { escapeHtml, t } from './copy.js';

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
  'p[lang=en]{color:var(--color-muted)}';

/** The HTML page for a result: 'done' (revoked or already revoked) or 'invalid'. */
export function bajaPage(result) {
  const key = result === 'invalid' ? 'baja_invalid' : 'baja_done';
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="robots" content="noindex"><title>${escapeHtml(t('es', 'baja_title'))}</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${escapeHtml(t('es', 'baja_title'))} · ${escapeHtml(t('en', 'baja_title'))}</h1>` +
    `<p lang="es">${escapeHtml(t('es', key))}</p><p lang="en">${escapeHtml(t('en', key))}</p></main></body></html>`;
}
