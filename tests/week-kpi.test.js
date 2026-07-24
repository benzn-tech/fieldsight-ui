'use strict';

/*
 * Unit tests for fix/week-kpi — the Today page's weekly-completion tile.
 *
 * The tile used to read `tasks.getCrossDayAudit` → `actions.getActionsRange` →
 * the legacy DynamoDB overlay, on the task's REPORT-date axis, and rendered
 * "N / M actions resolved this week" where M was "rows that ever had an
 * overlay write". Check-off writes Aurora now, so that store never changed;
 * with real Feb–Jun reports the Mon→today report-date window was empty, so
 * `total === 0` hid the tile entirely.
 *
 * It now reads GET /api/org/action-items/closures (org.getActionClosures),
 * which counts content_edits status→'done' transitions bucketed on the NZ day
 * the CLOSE happened, and returns the same-length previous window for context.
 *
 * Covers today.js's pure parts (mondayOfISO / weekKpiModel / weekKpiHeadline /
 * weekKpiSubline) plus the component itself driven through a controllable
 * React stub, so "which endpoint does it call" and "what does the label say"
 * are both asserted, not assumed.
 *
 * today.js is a browser IIFE (window.FieldSight.PAGES registration); requiring
 * it under Node needs the same minimal stubs as the other page tests.
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---- harness ------------------------------------------------------------- */

let calls;          // every backend call the tile makes, by channel
let orgResponse;    // what getActionClosures resolves with
let orgRejects;

function addDaysISO(iso, n) {
  const p = iso.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

calls = { closures: [], legacyAudit: [] };
orgResponse = null;
orgRejects = false;

global.window = {
  FieldSight: {},
  FS: {
    api: {
      todayNZDT:  function () { return '2026-07-25'; },   // a Saturday
      addDaysISO: addDaysISO,
      org: {
        getActionClosures: function (opts) {
          calls.closures.push(opts);
          if (orgRejects) return Promise.reject(new Error('boom'));
          return Promise.resolve(orgResponse);
        },
      },
      /* The retired legacy path stays wired so a test can prove the tile no
         longer touches it — not merely that the new one was called. */
      tasks: {
        getCrossDayAudit: function (opts) {
          calls.legacyAudit.push(opts);
          return Promise.resolve({ entries: [] });
        },
      },
    },
  },
  console: { warn: function () {} },
};
global.console.warn = function () {};

/* A React stub whose state is controllable: `stateSeed` is what useState
   hands back, `setStates` collects everything the component sets, and
   useEffect runs its effect synchronously (returning the cleanup). */
let stateSeed = { status: 'loading' };
let setStates = [];
let effectCleanups = [];

global.React = {
  useState: function () { return [stateSeed, function (v) { setStates.push(v); }]; },
  useEffect: function (fn) { effectCleanups.push(fn()); },
  useRef: function (v) { return { current: v }; },
  useContext: function () { return null; },
  createContext: function (def) { return { Provider: 'Provider', _def: def }; },
  createElement: function (type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return { type: type, props: props || {}, children: children };
  },
  Fragment: 'Fragment',
};
global.document = { addEventListener() {}, removeEventListener() {} };

const {
  mondayOfISO, weekKpiModel, weekKpiHeadline, weekKpiSubline, WeeklyCompletionKpi,
} = require('../scripts/pages/today.js');

/* Flatten a stub element tree to its rendered text. */
function textOf(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children || []).map(textOf).join('');
}

function findByType(node, type, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(function (n) { findByType(n, type, out); }); return out; }
  if (node.type === type) out.push(node);
  (node.children || []).forEach(function (n) { findByType(n, type, out); });
  return out;
}

function reset() {
  calls = { closures: [], legacyAudit: [] };
  orgRejects = false;
  setStates = [];
  effectCleanups = [];
  stateSeed = { status: 'loading' };
}

/* A representative server response: Mon 20 → Sat 25 July 2026. */
function response(overrides) {
  return Object.assign({
    from: '2026-07-20', to: '2026-07-25', timezone: 'Pacific/Auckland',
    closed: 7,
    by_day: [
      { date: '2026-07-20', closed: 2 }, { date: '2026-07-21', closed: 0 },
      { date: '2026-07-22', closed: 0 }, { date: '2026-07-23', closed: 5 },
      { date: '2026-07-24', closed: 0 }, { date: '2026-07-25', closed: 0 },
    ],
    previous: { from: '2026-07-14', to: '2026-07-19', closed: 3 },
  }, overrides || {});
}

/* ---- mondayOfISO --------------------------------------------------------- */

test('mondayOfISO: a mid-week date resolves back to that week\'s Monday', () => {
  assert.strictEqual(mondayOfISO('2026-07-25'), '2026-07-20');   // Sat -> Mon
  assert.strictEqual(mondayOfISO('2026-07-20'), '2026-07-20');   // Mon -> itself
});

test('mondayOfISO: Sunday belongs to the week that just ended, not the next one', () => {
  assert.strictEqual(mondayOfISO('2026-07-26'), '2026-07-20');
});

/* ---- weekKpiModel: what the tile is allowed to believe -------------------- */

test('weekKpiModel: a normal response yields the server total and a close-date-keyed trend', () => {
  const m = weekKpiModel(response());
  assert.strictEqual(m.status, 'ok');
  assert.strictEqual(m.closed, 7);
  assert.strictEqual(m.previousClosed, 3);
  assert.deepStrictEqual(m.trend.map((p) => p.date),
    ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25']);
  assert.deepStrictEqual(m.trend.map((p) => p.value), [2, 0, 0, 5, 0, 0]);
  assert.strictEqual(m.weekStart, '2026-07-20');
});

test('weekKpiModel: genuinely zero activity in BOTH windows is "empty" (the tile hides)', () => {
  const m = weekKpiModel(response({
    closed: 0,
    by_day: [{ date: '2026-07-20', closed: 0 }],
    previous: { from: '2026-07-14', to: '2026-07-19', closed: 0 },
  }));
  assert.strictEqual(m.status, 'empty');
});

test('weekKpiModel: zero this week but closures last week still has something to say', () => {
  const m = weekKpiModel(response({ closed: 0, by_day: [{ date: '2026-07-20', closed: 0 }] }));
  assert.strictEqual(m.status, 'ok');
  assert.strictEqual(m.closed, 0);
  assert.strictEqual(m.previousClosed, 3);
});

test('weekKpiModel: a denied / not-found / shapeless response is an error, never a zero', () => {
  assert.strictEqual(weekKpiModel({ _accessDenied: true, status: 403 }).status, 'error');
  assert.strictEqual(weekKpiModel({ _notFound: true, status: 404 }).status, 'error');
  assert.strictEqual(weekKpiModel(null).status, 'error');
  assert.strictEqual(weekKpiModel({}).status, 'error');          // no `closed` key at all
});

/* ---- the label states exactly what was computed -------------------------- */

test('weekKpiHeadline: says "closed this week" over the count it was given, and singularises', () => {
  assert.strictEqual(weekKpiHeadline(weekKpiModel(response())), '7 actions closed this week');
  assert.strictEqual(
    weekKpiHeadline(weekKpiModel(response({ closed: 1, by_day: [{ date: '2026-07-20', closed: 1 }] }))),
    '1 action closed this week');
});

test('weekKpiHeadline: promises no ratio — there is no "/" or "%" left in the label', () => {
  const h = weekKpiHeadline(weekKpiModel(response()));
  assert.ok(!h.includes('/'), 'no N / M denominator');
  assert.ok(!h.includes('%'), 'no completion percentage');
  assert.ok(!h.includes('resolved'), 'the old wording is gone');
});

test('weekKpiSubline: compares like with like — the same period one week earlier', () => {
  assert.strictEqual(weekKpiSubline(weekKpiModel(response())),
    'since Mon 20 · 3 in the same period last week');
  assert.strictEqual(
    weekKpiSubline(weekKpiModel(response({ previous: { closed: 0 } }))),
    'since Mon 20 · none in the same period last week');
});

/* ---- the component: which endpoint, and what it renders ------------------ */

test('WeeklyCompletionKpi: asks the aggregate endpoint ONCE for Mon→today, not the legacy overlay', async () => {
  reset();
  orgResponse = response();
  WeeklyCompletionKpi();
  await Promise.resolve();
  assert.deepStrictEqual(calls.closures, [{ from: '2026-07-20', to: '2026-07-25' }]);
  assert.deepStrictEqual(calls.legacyAudit, [], 'the DynamoDB overlay path is never touched');
});

test('WeeklyCompletionKpi: stores the model the endpoint implies', async () => {
  reset();
  orgResponse = response();
  WeeklyCompletionKpi();
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(setStates.length, 1);
  assert.strictEqual(setStates[0].status, 'ok');
  assert.strictEqual(setStates[0].closed, 7);
});

test('WeeklyCompletionKpi: renders the endpoint\'s numbers with a matching label', () => {
  reset();
  stateSeed = weekKpiModel(response());
  const tree = WeeklyCompletionKpi();
  assert.ok(tree, 'tile renders');
  assert.strictEqual(tree.props.className, 'fs-today__week-kpi');
  assert.strictEqual(textOf(tree),
    '7 actions closed this weeksince Mon 20 · 3 in the same period last week');
});

test('WeeklyCompletionKpi: the sparkline is keyed on CLOSE date, one point per day', () => {
  reset();
  window.FieldSight.SparkLine = 'SparkLine';
  stateSeed = weekKpiModel(response());
  const spark = findByType(WeeklyCompletionKpi(), 'SparkLine')[0];
  assert.ok(spark, 'sparkline is rendered');
  assert.deepStrictEqual(spark.props.points, [
    { date: '2026-07-20', value: 2 }, { date: '2026-07-21', value: 0 },
    { date: '2026-07-22', value: 0 }, { date: '2026-07-23', value: 5 },
    { date: '2026-07-24', value: 0 }, { date: '2026-07-25', value: 0 },
  ]);
  delete window.FieldSight.SparkLine;
});

test('WeeklyCompletionKpi: renders nothing on a genuine zero week', () => {
  reset();
  stateSeed = weekKpiModel(response({
    closed: 0, by_day: [{ date: '2026-07-20', closed: 0 }],
    previous: { closed: 0 },
  }));
  assert.strictEqual(stateSeed.status, 'empty');
  assert.strictEqual(WeeklyCompletionKpi(), null);
});

test('WeeklyCompletionKpi: a failed request hides the tile instead of rendering a fake zero', async () => {
  reset();
  orgRejects = true;
  WeeklyCompletionKpi();
  await Promise.resolve(); await Promise.resolve();
  assert.deepStrictEqual(setStates, [{ status: 'error' }]);
  stateSeed = { status: 'error' };
  assert.strictEqual(WeeklyCompletionKpi(), null);
});

test('WeeklyCompletionKpi: a 403 envelope is an error state, never a rendered 0', async () => {
  reset();
  orgResponse = { _accessDenied: true, status: 403, error: 'Access denied.' };
  WeeklyCompletionKpi();
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(setStates[0].status, 'error');
});
