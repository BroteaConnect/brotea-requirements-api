// A PocketBase stand-in with the same call shape as `pb(method, path, body)`
// in src/email.js: a few collections in memory, ids handed out in order,
// every write recorded so a test can assert on the exact PATCH bodies.
// Filters are the handful the chassis uses, matched by regexp on the
// decoded query string, not a PocketBase parser.

let seq = 0;
const nextId = (prefix) => `${prefix}${String(++seq).padStart(3, '0')}`;

export function fakePb(seed = {}) {
  const data = {
    leads: [], plantillas: [], actividades: [], envios: [], ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
  };
  const writes = [];
  const failures = new Map(); // `${method} ${collection}` → Error thrown on that write
  const reads = [];

  const match = (rows, filter) => {
    if (!filter) return rows;
    const f = decodeURIComponent(filter);
    return rows.filter((r) => {
      const clauses = f.split('&&').map((c) => c.trim());
      return clauses.every((c) => {
        const m = /^(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"$/.exec(c);
        if (!m) return true;
        const value = m[2].replace(/\\(.)/g, '$1');
        return String(r[m[1]] ?? '') === value;
      });
    });
  };

  async function pb(method, path, body) {
    const [p, query = ''] = path.split('?');
    const parts = p.split('/'); // ['', 'api', 'collections', name, 'records', id?]
    const collection = parts[3];
    const id = parts[5];
    const rows = data[collection] ?? (data[collection] = []);
    const key = `${method} ${collection}`;
    if (failures.has(key)) { const e = failures.get(key); failures.delete(key); throw e; }
    if (method === 'GET') {
      reads.push({ collection, id, query: decodeURIComponent(query) });
      if (id) {
        const row = rows.find((r) => r.id === id);
        if (!row) { const e = new Error(`pb GET ${path}: 404`); e.status = 404; throw e; }
        return { ...row };
      }
      const q = new URLSearchParams(query);
      let items = match(rows, q.get('filter'));
      const sort = q.get('sort');
      if (sort) {
        const desc = sort.startsWith('-'); const field = sort.replace(/^-/, '');
        items = [...items].sort((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')) * (desc ? -1 : 1));
      }
      const per = Number(q.get('perPage') ?? 30);
      return { items: items.slice(0, per).map((r) => ({ ...r })), totalItems: items.length };
    }
    if (method === 'POST') {
      const row = { id: nextId(collection.slice(0, 3)), created: new Date().toISOString().replace('T', ' '), ...body };
      rows.push(row);
      writes.push({ method, collection, id: row.id, body: { ...body } });
      return { ...row };
    }
    if (method === 'PATCH') {
      const row = rows.find((r) => r.id === id);
      if (!row) { const e = new Error(`pb PATCH ${path}: 404`); e.status = 404; throw e; }
      Object.assign(row, body);
      writes.push({ method, collection, id, body: { ...body } });
      return { ...row };
    }
    throw new Error(`fake pb: ${method} not supported`);
  }
  pb.data = data;
  pb.writes = writes;
  pb.reads = reads;
  pb.failOnce = (method, collection, error = new Error(`fake pb: ${method} ${collection} failed`)) => failures.set(`${method} ${collection}`, error);
  pb.row = (collection, id) => data[collection].find((r) => r.id === id);
  pb.writesTo = (collection, method) => writes.filter((w) => w.collection === collection && (!method || w.method === method));
  return pb;
}

/** An events recorder with the `logEvent(type, payload)` shape. */
export function fakeEvents() {
  const events = [];
  const logEvent = async (type, payload) => { events.push({ type, payload }); };
  logEvent.events = events;
  logEvent.of = (type) => events.filter((e) => e.type === type);
  return logEvent;
}

/**
 * A Twilio caller that answers from a script: each entry is {status, data}
 * or a function of the request; every request is kept for assertions.
 * `error` in an entry makes the call reject (network failure / timeout).
 */
export function fakeTwilio(script = []) {
  const calls = [];
  const queue = [...script];
  const twilio = async (req) => {
    calls.push(req);
    const next = queue.length ? queue.shift() : { status: 201, data: { sid: `SM${'0'.repeat(30)}${String(calls.length).padStart(2, '0')}`, status: 'queued' } };
    const answer = typeof next === 'function' ? next(req) : next;
    if (answer.error) throw answer.error instanceof Error ? answer.error : new Error(String(answer.error));
    return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, data: answer.data ?? {} };
  };
  twilio.calls = calls;
  return twilio;
}

/** A `now` fixed for a test. */
export const NOW = new Date('2026-09-23T12:00:00.000Z');
/** A PocketBase-formatted timestamp `hours` before NOW. */
export const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3600_000).toISOString().replace('T', ' ');
