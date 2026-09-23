import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { sendTrackedEmail, applyBrevoEvent, emailConfigured } from './email.js';
import { assignWebLead } from './assign.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const PORT = Number(process.env.PORT ?? 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY = 64 * 1024;

// Naive per-IP rate limit: 5 submissions per minute.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) hits.clear(); // crude memory bound
  return list.length > 5;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function sendToProjectTopic(projectId, text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const { rows } = await pool.query(
    'SELECT topic_id FROM topics WHERE project_id = $1',
    [projectId],
  );
  if (!rows[0]) return;
  const params = new URLSearchParams({
    chat_id: CHAT_ID,
    message_thread_id: String(rows[0].topic_id),
    text,
  });
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?${params}`);
}

const logEvent = (type, payload) => pool.query(
  'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
  ['requirements-api', type, payload],
);

function notifyTopic(projectId, projectName, content, submittedBy) {
  const excerpt = content.length > 300 ? `${content.slice(0, 300)}…` : content;
  return sendToProjectTopic(
    projectId,
    `📥 Nuevo requisito para ${projectName} (de ${submittedBy}):\n"${excerpt}"`,
  );
}

async function handleSubmission(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
  if (rateLimited(ip)) return send(res, 429, { error: 'too many requests' });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return send(res, 413, { error: 'body too large' });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'invalid JSON' });
  }

  const project = String(data.project ?? '');
  const content = String(data.content ?? '').trim();
  const submittedBy = String(data.submitted_by ?? '').trim().slice(0, 300) || null;
  const source = String(data.source ?? 'landing_form').slice(0, 50);
  if (!SLUG_RE.test(project)) return send(res, 400, { error: 'invalid project' });
  if (!content || content.length > 4000) return send(res, 400, { error: 'content required (max 4000 chars)' });

  const { rows } = await pool.query(
    'SELECT id, name FROM projects WHERE slug = $1',
    [project],
  );
  if (!rows[0]) return send(res, 404, { error: 'unknown project' });

  const ins = await pool.query(
    `INSERT INTO requirements (project_id, content, source, submitted_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [rows[0].id, content, source, submittedBy],
  );
  await pool.query(
    'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
    ['requirements-api', 'requirement.received',
     { requirement_id: ins.rows[0].id, project, source, submitted_by: submittedBy }],
  );
  notifyTopic(rows[0].id, rows[0].name, content, submittedBy ?? 'anónimo')
    .catch((e) => console.error('notify failed:', e.message));

  // A web lead gets an owner right away (see assign.js). It never fails the
  // form: the requirement is already stored and the outcome is an events row.
  if (source === 'lead_web') {
    await assignWebLead({ leadId: data.lead_id, project, logEvent })
      .catch((e) => console.error('lead assign crashed:', e.message));
  }

  return send(res, 201, { ok: true, id: ins.rows[0].id });
}

// GlitchTip alert webhook → the project's Telegram topic. GlitchTip has no
// Telegram integration, so each project's alert rule points its webhook
// recipient here with ?project=<slug>&secret=<shared>. The secret gates the
// endpoint (it is public otherwise) and lives in GLITCHTIP_WEBHOOK_SECRET.
const GT_WEBHOOK_SECRET = process.env.GLITCHTIP_WEBHOOK_SECRET;

async function handleGlitchtipAlert(req, res, url) {
  if (!GT_WEBHOOK_SECRET) return send(res, 503, { error: 'webhook not configured' });
  if (url.searchParams.get('secret') !== GT_WEBHOOK_SECRET) return send(res, 403, { error: 'forbidden' });
  const project = url.searchParams.get('project') ?? '';
  if (!SLUG_RE.test(project)) return send(res, 400, { error: 'invalid project' });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return send(res, 413, { error: 'body too large' });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'invalid JSON' });
  }

  // GlitchTip posts a Slack-shaped payload; extract best-effort.
  const att = (Array.isArray(data.attachments) && data.attachments[0]) || {};
  const title = String(att.title || data.text || 'error').slice(0, 300);
  const link = typeof att.title_link === 'string' ? att.title_link.slice(0, 500) : '';

  const { rows } = await pool.query('SELECT id, name FROM projects WHERE slug = $1', [project]);
  if (!rows[0]) return send(res, 404, { error: 'unknown project' });

  await pool.query(
    'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
    ['requirements-api', 'error.alerted', { project, title }],
  );
  sendToProjectTopic(
    rows[0].id,
    `🐞 Error en producción — ${rows[0].name}\n"${title}"${link ? `\n${link}` : ''}`,
  ).catch((e) => console.error('notify failed:', e.message));

  return send(res, 200, { ok: true });
}

// Outbound email for CRMs: the browser must never hold SMTP credentials, so
// the CRM posts here with the shared secret. Delivery tracking arrives later
// via /brevo-webhook and lands on the same activity record.
const OUTBOUND_SECRET = process.env.OUTBOUND_SECRET;

async function readJson(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) { send(res, 413, { error: 'body too large' }); return null; }
  }
  try {
    return JSON.parse(raw);
  } catch {
    send(res, 400, { error: 'invalid JSON' });
    return null;
  }
}

async function handleSendEmail(req, res, url) {
  if (!OUTBOUND_SECRET) return send(res, 503, { error: 'outbound email not configured' });
  if (url.searchParams.get('secret') !== OUTBOUND_SECRET) return send(res, 403, { error: 'forbidden' });

  const data = await readJson(req, res);
  if (!data) return undefined;
  const to = String(data.to ?? '').trim();
  const subject = String(data.subject ?? '').trim();
  const text = String(data.text ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return send(res, 400, { error: 'invalid to' });
  if (!subject || !text) return send(res, 400, { error: 'subject and text required' });
  // La configuración se comprueba tras validar: una petición mal formada es
  // un 400 aunque el relay no esté montado.
  if (!emailConfigured()) return send(res, 503, { error: 'smtp not configured' });

  try {
    const out = await sendTrackedEmail({
      to, subject, text,
      leadId: data.lead_id ? String(data.lead_id) : null,
      fromName: data.from_name ? String(data.from_name).slice(0, 100) : null,
    });
    await pool.query(
      'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
      ['requirements-api', 'email.sent', { to, subject, lead_id: data.lead_id ?? null }],
    );
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('send-email failed:', e.message);
    return send(res, 502, { error: 'send failed', detail: e.message.slice(0, 200) });
  }
}

// Brevo delivery events (delivered / opened / click / bounce…). Brevo cannot
// send custom headers, so the shared secret travels in the query string.
async function handleBrevoWebhook(req, res, url) {
  if (!OUTBOUND_SECRET) return send(res, 503, { error: 'not configured' });
  if (url.searchParams.get('secret') !== OUTBOUND_SECRET) return send(res, 403, { error: 'forbidden' });
  const data = await readJson(req, res);
  if (!data) return undefined;
  let result;
  try {
    result = await applyBrevoEvent(data);
  } catch (e) {
    console.error('brevo webhook failed:', e.message);
    result = { error: e.message.slice(0, 200) };
  }
  // Toda llamada entrante deja rastro: sin esto es imposible distinguir
  // "el proveedor no llama" de "llama y no encaja" (nos costó una tarde).
  pool.query(
    'INSERT INTO events (actor, event_type, payload) VALUES ($1, $2, $3)',
    ['brevo', 'email.event_received', {
      event: data.event ?? null,
      message_id: data['message-id'] ?? null,
      email: data.email ?? null,
      result,
    }],
  ).catch((e) => console.error('event log failed:', e.message));
  return send(res, 200, { ok: !result.error, ...result }); // 200 siempre: sin reintentos infinitos
}

// Public read-only roadmap. Status derives from the linked feature when one
// exists, so the roadmap can never drift from the real lifecycle.
async function handleRoadmap(req, res, url) {
  const project = url.searchParams.get('project') ?? '';
  if (!SLUG_RE.test(project)) return send(res, 400, { error: 'invalid project' });

  const { rows } = await pool.query(
    'SELECT id, name FROM projects WHERE slug = $1',
    [project],
  );
  if (!rows[0]) return send(res, 404, { error: 'unknown project' });

  const items = await pool.query(
    `SELECT r.id, r.title, r.description, r.shipped_at,
            CASE
              WHEN f.status IN ('implementing', 'in_review') THEN 'in_progress'
              WHEN f.status = 'deployed' THEN 'shipped'
              ELSE r.status::text
            END AS status
     FROM roadmap_items r
     LEFT JOIN features f ON f.id = r.feature_id
     WHERE r.project_id = $1
       AND r.is_public
       AND (f.status IS NULL OR f.status <> 'rejected')
     ORDER BY r.sort_order, r.id`,
    [rows[0].id],
  );

  return send(res, 200,
    { project: { slug: project, name: rows[0].name }, items: items.rows },
    { 'Cache-Control': 'public, max-age=60' });
}

// Public read-only snapshot for the App Madre (arbol-madre): every project
// with its creator, production URL and Telegram topic link, plus the recent
// factory events the tree animates as sap pulses.
const GARDEN_EVENTS = [
  'project.created', 'feature.proposed', 'feature.analyzed', 'feature.approved',
  'feature.implementation_started', 'feature.pr_opened', 'deployment.completed',
  'docs.updated',
];

function topicUrl(topicId) {
  if (!CHAT_ID || topicId == null) return null;
  const short = String(CHAT_ID).replace(/^-100/, '');
  return `https://t.me/c/${short}/${topicId}`;
}

async function handleGarden(req, res) {
  const projects = await pool.query(
    `SELECT p.slug, p.name, p.status, p.repo_url, p.created_at,
            u.username AS creator, u.display_name AS creator_name,
            t.topic_id,
            (SELECT d.url FROM deployments d
              WHERE d.project_id = p.id AND d.env = 'production'
                AND d.status = 'succeeded' AND d.url IS NOT NULL
              ORDER BY d.id DESC LIMIT 1) AS url,
            (SELECT count(*)::int FROM features f
              WHERE f.project_id = p.id
                AND f.status NOT IN ('deployed','rejected')) AS open_features,
            (SELECT count(*)::int FROM features f
              WHERE f.project_id = p.id AND f.status = 'deployed') AS deployed_features
       FROM projects p
       LEFT JOIN LATERAL (
         SELECT e.payload->>'ordered_by' AS tid FROM events e
          WHERE e.event_type IN ('order.new_project', 'project.created')
            AND e.payload->>'slug' = p.slug
          ORDER BY e.id LIMIT 1
       ) o ON true
       LEFT JOIN users u ON u.telegram_id::text = o.tid
       LEFT JOIN topics t ON t.project_id = p.id
      ORDER BY p.created_at`,
  );
  const events = await pool.query(
    `SELECT id, event_type,
            COALESCE(payload->>'project', payload->>'slug') AS project,
            created_at
       FROM events
      WHERE event_type = ANY($1)
      ORDER BY id DESC LIMIT 40`,
    [GARDEN_EVENTS],
  );
  return send(res, 200, {
    generated_at: new Date().toISOString(),
    projects: projects.rows.map(({ topic_id, ...p }) => ({ ...p, topic_url: topicUrl(topic_id) })),
    events: events.rows,
  }, { 'Cache-Control': 'public, max-age=10' });
}

// -- assets ------------------------------------------------------------------
// The brand images the transactional emails point at. An inbox has no base URL
// and cannot read a relative path, so the templates carry an absolute https one
// — and this is the only host in the fleet that is ours, monitored, and not
// somebody's project site.
//
// Read from disk on every request rather than cached in memory: these are two
// files of a few KB behind a CDN-less nginx, and a stale logo in an email that
// has already been sent cannot be fixed by a restart anyway.
const ASSET_DIR = new URL('../assets/', import.meta.url).pathname;
const ASSET_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

function handleAsset(req, res, url) {
  // No traversal: the path is rebuilt from its own basename, so '..' cannot
  // survive it and neither can a symlink somebody drops in the folder.
  const rel = url.pathname.replace(/^\/assets\//, '');
  const parts = rel.split('/').filter((p) => p && p !== '.' && p !== '..');
  const file = path.join(ASSET_DIR, ...parts);
  const type = ASSET_TYPES[path.extname(file).toLowerCase()];
  if (!type || !file.startsWith(ASSET_DIR) || !existsSync(file)) return send(res, 404, { error: 'not found' });
  const body = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    // A logo in an email is fetched once per reader and never changes without
    // changing its name.
    'Cache-Control': 'public, max-age=604800, immutable',
    'Access-Control-Allow-Origin': '*',
  });
  return res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) return handleAsset(req, res, url);
    if (req.method === 'GET' && url.pathname === '/roadmap') return await handleRoadmap(req, res, url);
    if (req.method === 'GET' && url.pathname === '/garden') return await handleGarden(req, res);
    if (req.method === 'POST' && url.pathname === '/requirements') return await handleSubmission(req, res);
    if (req.method === 'POST' && url.pathname === '/glitchtip-webhook') return await handleGlitchtipAlert(req, res, url);
    if (req.method === 'POST' && url.pathname === '/send-email') return await handleSendEmail(req, res, url);
    if (req.method === 'POST' && url.pathname === '/brevo-webhook') return await handleBrevoWebhook(req, res, url);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('request error:', e);
    return send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => console.log(`requirements-api listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
