// Preloaded with `--import` into a spawned server so POST /requirements can
// reach its 201 without a database. Answers the two reads the route makes and
// appends every events row to FAKE_PG_LOG (one JSON per line) so the test on
// the other side of the socket can see what was recorded.
import pg from 'pg';
import { appendFileSync } from 'node:fs';

pg.Pool.prototype.query = async (sql, params = []) => {
  if (/FROM projects WHERE slug/.test(sql)) return { rows: [{ id: 14, name: 'Inmobiliaria' }] };
  if (/INSERT INTO requirements/.test(sql)) return { rows: [{ id: 4242 }] };
  if (/INSERT INTO events/.test(sql)) {
    if (process.env.FAKE_PG_LOG) {
      appendFileSync(process.env.FAKE_PG_LOG, `${JSON.stringify({ actor: params[0], type: params[1], payload: params[2] })}\n`);
    }
    return { rows: [] };
  }
  return { rows: [] };
};
pg.Pool.prototype.end = async () => {};
