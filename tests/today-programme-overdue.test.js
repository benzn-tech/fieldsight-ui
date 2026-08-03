'use strict';

/*
 * getUpcomingProgrammeTasks — window vs "as of today".
 *
 * Today used to fetch [today, today + 7], so a programme task whose deadline
 * had already passed fell outside the range and vanished from Today
 * completely. The adapter's own comment said overdue was "out of scope". It
 * is exactly what should be most visible.
 *
 * Widening the window backwards is not enough on its own: `day_index` and
 * `deadline_in_days` were both computed against `from`, so moving `from` back
 * 30 days would report every task as 30 days further along than it is, and
 * would give overdue tasks a positive "days until deadline". Hence `asOf`,
 * which stays at today while the window widens around it.
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---- harness: the adapter is a browser IIFE over FS.api ------------------ */

const TODAY = '2026-05-01';

function loadAdapter(leaves) {
  delete require.cache[require.resolve('../scripts/api/today-programme-adapter.js')];

  function addDaysISO(iso, n) {
    const p = iso.split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  global.window = {
    FieldSight: { programmeSchedule: { computeCriticalPath: () => [] } },
    FS: {
      api: {
        addDaysISO,
        todayNZDT: () => TODAY,
        folderName: (n) => n,
        pooledAll: (thunks) => Promise.all(thunks.map((t) => t())),
        org: { getOrgSites: async () => ({ sites: [{ site_id: 's1', name: 'Site 1' }] }) },
        programme: {
          getProgramme: async () => ({
            programme: { start_date: '2026-01-01', end_date: '2026-12-31', leaves },
          }),
        },
      },
    },
    AuthMock: { currentUser: { name: 'Sam_SM' } },
  };
  global.window.window = global.window;

  require('../scripts/api/today-programme-adapter.js');
  return global.window.FS.api.todayProgramme;
}

function leaf(id, start, end) {
  return {
    task_id: id, name: id, start, end, duration_days: 10,
    progress_pct: 0, status: 'not_started', assignees: ['Sam_SM'],
  };
}

const LEAVES = [
  leaf('overdue', '2026-04-01', '2026-04-20'),
  leaf('today', '2026-04-25', TODAY),
  leaf('soon', '2026-04-28', '2026-05-03'),
  leaf('far', '2026-06-01', '2026-06-10'),
];

/* ---- the window ---------------------------------------------------------- */

test('a widened window includes tasks whose deadline has already passed', async () => {
  const api = loadAdapter(LEAVES);
  const res = await api.getUpcomingProgrammeTasks({
    from: '2026-04-01', to: '2026-05-04', asOf: TODAY, user: 'Sam_SM',
  });
  const ids = res.rows.map((r) => r.task_id);
  assert.ok(ids.includes('overdue'),
    'an overdue task used to disappear from Today entirely');
  assert.ok(ids.includes('today') && ids.includes('soon'));
  assert.ok(!ids.includes('far'));
});

/* ---- asOf ---------------------------------------------------------------- */

test('deadline_in_days is measured from asOf, not from the window start', async () => {
  const api = loadAdapter(LEAVES);
  const res = await api.getUpcomingProgrammeTasks({
    from: '2026-04-01', to: '2026-05-04', asOf: TODAY, user: 'Sam_SM',
  });
  const by = Object.fromEntries(res.rows.map((r) => [r.task_id, r]));
  assert.strictEqual(by.today.deadline_in_days, 0);
  assert.strictEqual(by.soon.deadline_in_days, 2);
});

test('an overdue task reports a NEGATIVE deadline_in_days', async () => {
  /* Measured from the window start it would read as +19 days remaining —
     the opposite of the truth, on the one row that most needs to be right. */
  const api = loadAdapter(LEAVES);
  const res = await api.getUpcomingProgrammeTasks({
    from: '2026-04-01', to: '2026-05-04', asOf: TODAY, user: 'Sam_SM',
  });
  const overdue = res.rows.find((r) => r.task_id === 'overdue');
  assert.strictEqual(overdue.deadline_in_days, -11);
});

test('day_index counts from the task start to asOf, not to the window start', async () => {
  /* The deadline has to sit inside the window or the row is filtered out
     before day_index is ever computed. */
  const api = loadAdapter([leaf('running', '2026-04-28', '2026-05-04')]);
  const res = await api.getUpcomingProgrammeTasks({
    from: '2026-04-01', to: '2026-05-04', asOf: TODAY, user: 'Sam_SM',
  });
  assert.strictEqual(res.rows.length, 1);
  assert.strictEqual(res.rows[0].day_index, 4, 'Apr 28 → May 1 is day 4');
});

test('asOf defaults to from, so existing callers are unaffected', async () => {
  const api = loadAdapter(LEAVES);
  const res = await api.getUpcomingProgrammeTasks({
    from: TODAY, to: '2026-05-04', user: 'Sam_SM',
  });
  const by = Object.fromEntries(res.rows.map((r) => [r.task_id, r]));
  assert.strictEqual(by.today.deadline_in_days, 0);
  assert.ok(!by.overdue, 'the old narrow window still excludes overdue');
});

test('rows stay sorted by urgency, so overdue leads', async () => {
  const api = loadAdapter(LEAVES);
  const res = await api.getUpcomingProgrammeTasks({
    from: '2026-04-01', to: '2026-05-04', asOf: TODAY, user: 'Sam_SM',
  });
  assert.strictEqual(res.rows[0].task_id, 'overdue');
});
