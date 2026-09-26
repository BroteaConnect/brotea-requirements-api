import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSyncEveryMs, startContentSync } from '../src/content.js';

/** Timers driven by hand: fire(kind) runs every live timer of that kind once. */
function fakeTimers() {
  const live = new Map();
  let next = 1;
  const add = (kind) => (fn, ms) => {
    const id = next++;
    let unrefd = false;
    live.set(id, { kind, fn, ms });
    return { id, unref: () => { unrefd = true; }, get unrefd() { return unrefd; } };
  };
  const clear = (h) => { if (h) live.delete(h.id); };
  const timers = { setTimeout: add('timeout'), setInterval: add('interval'), clearTimeout: clear, clearInterval: clear };
  timers.live = live;
  timers.of = (kind) => [...live.values()].filter((t) => t.kind === kind);
  timers.fire = (kind) => {
    for (const [id, t] of [...live]) {
      if (t.kind !== kind) continue;
      if (kind === 'timeout') live.delete(id);
      t.fn();
    }
  };
  return timers;
}

const flush = () => new Promise((r) => setImmediate(r));

test('the first run waits for the boot delay, then the interval repeats it', async () => {
  const timers = fakeTimers();
  let runs = 0;
  startContentSync({ everyMs: 3_600_000, run: async () => { runs++; }, timers });
  assert.equal(runs, 0, 'nothing runs at boot itself');
  assert.equal(timers.of('timeout')[0].ms, 30_000);
  timers.fire('timeout');
  await flush();
  assert.equal(runs, 1);
  assert.equal(timers.of('interval')[0].ms, 3_600_000);
  timers.fire('interval');
  await flush();
  timers.fire('interval');
  await flush();
  assert.equal(runs, 3);
});

test('timers are unref\'d so the scheduler never keeps the process alive', () => {
  const handles = [];
  const timers = fakeTimers();
  const wrap = (f) => (...a) => { const h = f(...a); handles.push(h); return h; };
  timers.setTimeout = wrap(timers.setTimeout);
  timers.setInterval = wrap(timers.setInterval);
  startContentSync({ everyMs: 1000, run: async () => {}, timers });
  timers.fire('timeout');
  assert.equal(handles.length, 2);
  assert.ok(handles.every((h) => h.unrefd));
});

test('a tick while a run is in flight is skipped, not stacked', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let release;
  startContentSync({ everyMs: 1000, run: () => { runs++; return new Promise((r) => { release = r; }); }, timers });
  timers.fire('timeout');
  await flush();
  timers.fire('interval');
  timers.fire('interval');
  await flush();
  assert.equal(runs, 1, 'still the first run');
  release();
  await flush();
  timers.fire('interval');
  await flush();
  assert.equal(runs, 2);
});

test('a rejected or thrown run goes to onError and the next tick still runs', async () => {
  const timers = fakeTimers();
  const errors = [];
  let runs = 0;
  const run = () => {
    runs++;
    if (runs === 1) return Promise.reject(new Error('twilio down'));
    if (runs === 2) throw new Error('sync throw');
    return Promise.resolve();
  };
  startContentSync({ everyMs: 1000, run, onError: (e) => errors.push(e.message), timers });
  timers.fire('timeout');
  await flush();
  timers.fire('interval');
  await flush();
  timers.fire('interval');
  await flush();
  assert.equal(runs, 3);
  assert.deepEqual(errors, ['twilio down', 'sync throw']);
});

test('stop() clears the boot timer, and the interval once it exists', async () => {
  const early = fakeTimers();
  let runs = 0;
  const stop1 = startContentSync({ everyMs: 1000, run: async () => { runs++; }, timers: early });
  stop1();
  assert.equal(early.live.size, 0);
  early.fire('timeout');
  assert.equal(runs, 0);

  const late = fakeTimers();
  const stop2 = startContentSync({ everyMs: 1000, run: async () => { runs++; }, timers: late });
  late.fire('timeout');
  await flush();
  assert.equal(late.of('interval').length, 1);
  stop2();
  assert.equal(late.live.size, 0);
  late.fire('interval');
  await flush();
  assert.equal(runs, 1);
});

test('CONTENT_SYNC_MINUTES: unset is an hour, off is 0, a typo is floored at a minute and capped', () => {
  assert.equal(contentSyncEveryMs(undefined), 3_600_000);
  assert.equal(contentSyncEveryMs('  '), 3_600_000);
  assert.equal(contentSyncEveryMs('15'), 900_000);
  for (const off of ['0', '-5', 'abc']) assert.equal(contentSyncEveryMs(off), 0, off);
  assert.equal(contentSyncEveryMs('0.0001'), 60_000);
  assert.equal(contentSyncEveryMs('Infinity'), 2 ** 31 - 1);
});
