'use strict';

/*
 * Which critical-path tier a programme qualifies for, and the fallback
 * ranking used when it does not qualify.
 *
 * The whole point is that computeCriticalPath returns a plausible-looking
 * path on a programme with NO dependencies — every task has zero slack when
 * nothing constrains it. Rendering that as a red route would have a PM
 * sequencing real work off an artefact of missing data. So the tier is
 * derived from the data and the UI is forbidden from drawing a path below
 * tier 1.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  dependencyCoverage, criticalTier, deadlinePressure, rankByPressure,
  COVERAGE_THRESHOLD, PRESSURE_FLOOR,
} = require('../scripts/api/programme-critical-tier.js');

function leaf(id, deps, extra) {
  return Object.assign({
    task_id: id, depends_on: deps || [], duration_days: 10,
    start: '2026-04-01', end: '2026-04-10', progress_pct: 0,
    status: 'not_started',
  }, extra || {});
}

/* ---- coverage ------------------------------------------------------------ */

test('coverage counts tasks that participate in a dependency, either end', () => {
  /* B depends on A, so BOTH are constrained — counting only the successor
     would halve every real programme's coverage. */
  const c = dependencyCoverage([leaf('A'), leaf('B', ['A']), leaf('C')]);
  assert.strictEqual(c.participating, 2);
  assert.strictEqual(c.total, 3);
});

test('a dependency pointing at a task that is not in the set does not count', () => {
  /* Imports drop tasks; a dangling predecessor constrains nothing. */
  const c = dependencyCoverage([leaf('A', ['GONE'])]);
  assert.strictEqual(c.participating, 0);
});

test('a self-dependency does not count as coverage', () => {
  assert.strictEqual(dependencyCoverage([leaf('A', ['A'])]).participating, 0);
});

test('coverage of an empty programme is zero, not NaN', () => {
  const c = dependencyCoverage([]);
  assert.strictEqual(c.fraction, 0);
  assert.strictEqual(c.total, 0);
});

/* ---- tier ---------------------------------------------------------------- */

function chain(n) {
  const out = [leaf('T0')];
  for (let i = 1; i < n; i++) out.push(leaf('T' + i, ['T' + (i - 1)]));
  return out;
}

test('a fully linked programme is tier 1', () => {
  const t = criticalTier(chain(10));
  assert.strictEqual(t.tier, 1);
  assert.strictEqual(t.reason, null);
});

test('a programme with NO dependencies is tier 2, never tier 1', () => {
  /* The case this module exists for. */
  const t = criticalTier([leaf('A'), leaf('B'), leaf('C')]);
  assert.strictEqual(t.tier, 2);
  assert.match(t.reason, /no dependenc/i);
});

test('partial coverage below the threshold is tier 2 and says the number', () => {
  /* 4 of 12 linked = 33%. "Not enough" without the number is unactionable. */
  const tasks = chain(4).concat([
    leaf('X1'), leaf('X2'), leaf('X3'), leaf('X4'),
    leaf('X5'), leaf('X6'), leaf('X7'), leaf('X8'),
  ]);
  const t = criticalTier(tasks);
  assert.strictEqual(t.tier, 2);
  assert.match(t.reason, /33%/);
});

test('coverage exactly at the threshold qualifies for tier 1', () => {
  /* The boundary is inclusive; a programme sitting exactly on it should not
     be told it is short. */
  const linked = chain(6);                       // 6 participating
  const loose = [leaf('X1'), leaf('X2'), leaf('X3'), leaf('X4')];
  const tasks = linked.concat(loose);            // 6/10 = 0.6
  assert.strictEqual(dependencyCoverage(tasks).fraction, COVERAGE_THRESHOLD);
  assert.strictEqual(criticalTier(tasks).tier, 1);
});

test('a cycle forces tier 2 however good the coverage is', () => {
  /* CPM cannot run on a cyclic graph. Reporting a path anyway would be
     fabricating one. */
  const tasks = [leaf('A', ['B']), leaf('B', ['A'])];
  const t = criticalTier(tasks);
  assert.strictEqual(t.tier, 2);
  assert.match(t.reason, /circular|cycle/i);
});

test('an empty programme is tier 2 rather than a division by zero', () => {
  assert.strictEqual(criticalTier([]).tier, 2);
});

/* ---- deadline pressure --------------------------------------------------- */

const TODAY = '2026-05-01';

test('a task half elapsed and barely started is under pressure', () => {
  const p = deadlinePressure(
    leaf('A', [], { start: '2026-04-21', end: '2026-05-10', progress_pct: 10 }), TODAY);
  assert.ok(p > 0.3 && p < 0.6, 'got ' + p);
});

test('a task roughly tracking its own elapsed time scores near zero', () => {
  /* 52.6% elapsed against 50% done really is fractionally behind, so the raw
     score is small but not zero. The ranking, not the score, is where that
     gets filtered — see the floor test below. */
  const p = deadlinePressure(
    leaf('A', [], { start: '2026-04-21', end: '2026-05-10', progress_pct: 50 }), TODAY);
  assert.ok(p > 0 && p < PRESSURE_FLOOR, 'got ' + p);
});

test('trivial slippage is kept out of the ranking by the floor', () => {
  /* A programme where every task is a day or two adrift would otherwise fill
     an "at risk" list completely and say nothing. */
  const barely = leaf('barely', [], {
    start: '2026-04-21', end: '2026-05-10', progress_pct: 50 });
  assert.strictEqual(rankByPressure([barely], TODAY).length, 0);
});

test('a task ahead of its elapsed time is not given negative pressure', () => {
  /* Being early is not a form of risk; clamping keeps the ranking readable. */
  const p = deadlinePressure(
    leaf('A', [], { start: '2026-04-21', end: '2026-05-10', progress_pct: 95 }), TODAY);
  assert.strictEqual(p, 0);
});

test('an overdue open task is maximum pressure', () => {
  const p = deadlinePressure(
    leaf('A', [], { start: '2026-03-01', end: '2026-04-20', progress_pct: 40 }), TODAY);
  assert.strictEqual(p, 1);
});

test('a completed task has no pressure even if its dates have passed', () => {
  const p = deadlinePressure(
    leaf('A', [], { start: '2026-03-01', end: '2026-04-20',
                    progress_pct: 100, status: 'completed' }), TODAY);
  assert.strictEqual(p, 0);
});

test('a task that has not started yet has no pressure', () => {
  const p = deadlinePressure(
    leaf('A', [], { start: '2026-06-01', end: '2026-06-10' }), TODAY);
  assert.strictEqual(p, 0);
});

test('a zero-length task does not divide by zero', () => {
  const p = deadlinePressure(
    leaf('A', [], { start: TODAY, end: TODAY, progress_pct: 0 }), TODAY);
  assert.ok(p >= 0 && p <= 1);
});

test('an undated task has no pressure rather than NaN', () => {
  assert.strictEqual(deadlinePressure(leaf('A', [], { start: null, end: null }), TODAY), 0);
});

/* ---- ranking ------------------------------------------------------------- */

test('ranking puts the most pressured first and drops the unpressured', () => {
  const tasks = [
    leaf('calm', [], { start: '2026-04-21', end: '2026-05-10', progress_pct: 95 }),
    leaf('late', [], { start: '2026-03-01', end: '2026-04-20', progress_pct: 40 }),
    leaf('slipping', [], { start: '2026-04-21', end: '2026-05-10', progress_pct: 10 }),
  ];
  const r = rankByPressure(tasks, TODAY);
  assert.deepStrictEqual(r.map((x) => x.task.task_id), ['late', 'slipping']);
  assert.ok(!r.some((x) => x.task.task_id === 'calm'));
});

test('ranking does not reorder the caller\'s array', () => {
  const input = [
    leaf('a', [], { start: '2026-04-21', end: '2026-05-10', progress_pct: 10 }),
    leaf('b', [], { start: '2026-03-01', end: '2026-04-20', progress_pct: 40 }),
  ];
  rankByPressure(input, TODAY);
  assert.deepStrictEqual(input.map((x) => x.task_id), ['a', 'b']);
});
