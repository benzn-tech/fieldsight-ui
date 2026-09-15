'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let requests;
function load() {
  requests = [];
  global.window = {
    FieldSight: {},
    FS: {
      api: {
        useMocks: false, timelineSource: 'aurora', orgBaseUrl: 'https://org.example/api',
        delay: () => Promise.resolve(),
        orgRequest: (p, opts) => {
          requests.push({ path: p, params: opts && opts.params });
          return Promise.resolve({ sessions: [{ session_id: 'S1', started_at: '2026-09-03T09:00:00+12:00', title: 'Site meeting' }] });
        },
      },
    },
  };
  for (const m of ['../scripts/api/_cache.js', '../scripts/api/org.js']) {
    delete require.cache[require.resolve(m)];
    require(m);
  }
  return window.FS.api.org;
}
const sessionCalls = () => requests.filter((r) => r.path === '/sessions').length;

test('getSessionsCached: same (date, folder) twice -> one /sessions request', async () => {
  const org = load();
  const [a, b] = await Promise.all([
    org.getSessionsCached('2026-09-03', 'Ben_UCPK2'),
    org.getSessionsCached('2026-09-03', 'Ben_UCPK2'),
  ]);
  await org.getSessionsCached('2026-09-03', 'Ben_UCPK2');
  assert.strictEqual(sessionCalls(), 1);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(requests[0].params, { date: '2026-09-03', user: 'Ben_UCPK2' });
});

test('getSessionsCached: a different owner is a different key', async () => {
  const org = load();
  await org.getSessionsCached('2026-09-03', 'Ben_UCPK2');
  await org.getSessionsCached('2026-09-03', 'Sarah_Chen');
  assert.strictEqual(sessionCalls(), 2);
});

/* SOURCE SCAN (wiring pin): Timeline's day-level sessions fetch uses the
   cached read, so expanding a card after the day loaded makes zero requests. */
test('timeline day fetch uses getSessionsCached(date, folder)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'timeline.js'), 'utf8');
  assert.match(src, /org\.getSessionsCached\(date, folder\)/);
  assert.doesNotMatch(src, /org\.getSessions\(\{ date: date, user: folder \}\)/);
});
