/* data-window getSpan(): the span must expire. It used to be cached for the
   page's lifetime, so a tab opened yesterday never saw today in Tasks "All"
   (TEST, 2026-11-05: five new action items absent from Tasks, present on Today). */
const test = require('node:test');
const assert = require('node:assert');

let calls = 0;
let served = {};
global.window = {
  FS: {
    api: {
      todayNZDT: () => '2026-11-05',
      addDaysISO: (d) => d,
      dates: {
        hasContent: (m) => !!(m && m.hasReport),
        getDates: () => { calls += 1; return Promise.resolve({ dates: served }); },
      },
    },
  },
};
const dw = require('../scripts/api/data-window.js');

test('getSpan refetches once the TTL has passed, and not before', async () => {
  const realNow = Date.now;
  let now = 1000000;
  Date.now = () => now;
  try {
    served = { '2026-11-04': { hasReport: true } };
    assert.strictEqual((await dw.getSpan()).latest, '2026-11-04');
    served = { '2026-11-04': { hasReport: true }, '2026-11-05': { hasReport: true } };
    now += 1000;
    assert.strictEqual((await dw.getSpan()).latest, '2026-11-04');   // still cached
    assert.strictEqual(calls, 1);
    now += dw.SPAN_TTL_MS + 1;
    assert.strictEqual((await dw.getSpan()).latest, '2026-11-05');   // the new day appears
    assert.strictEqual(calls, 2);
  } finally {
    Date.now = realNow;
  }
});

test("resolve('all') ends today even when the last content day is earlier", () => {
  const r = dw.resolve('all', null, { earliest: '2026-09-11', latest: '2026-11-04' });
  assert.deepStrictEqual(r, { from: '2026-09-11', to: '2026-11-05' });
});
