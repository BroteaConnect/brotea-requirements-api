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

async function notifyTopic(projectId, projectName, content, submittedBy) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const { rows } = await pool.query(
    'SELECT topic_id FROM topics WHERE project_id = $1',
    [projectId],
  );
  if (!rows[0]) return;
  const excerpt = content.length > 300 ? `${content.slice(0, 300)}…` : content;
  const params = new URLSearchParams({
    chat_id: CHAT_ID,
    message_thread_id: String(rows[0].topic_id),
    text: `📥 Nuevo requisito para ${projectName} (de ${submittedBy}):\n"${excerpt}"`,
  });
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?${params}`);
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/roadmap') return await handleRoadmap(req, res, url);
    if (req.method === 'POST' && url.pathname === '/requirements') return await handleSubmission(req, res);
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
