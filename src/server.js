import http from 'node:http';
import pg from 'pg';

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/roadmap') return await handleRoadmap(req, res, url);
    if (req.method === 'GET' && url.pathname === '/garden') return await handleGarden(req, res);
    if (req.method === 'POST' && url.pathname === '/requirements') return await handleSubmission(req, res);
    if (req.method === 'POST' && url.pathname === '/glitchtip-webhook') return await handleGlitchtipAlert(req, res, url);
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
