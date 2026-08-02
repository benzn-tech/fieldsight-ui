'use strict';

/*
 * Rolling breakdown progress up to the contract task.
 *
 * The two assertions this file exists for are both about refusing to move a
 * number:
 *
 *   a partial breakdown must not report the whole task as done. A 10-day
 *   task split into one 2-day subtask is not complete when that subtask is —
 *   but weighting only across children says it is, which is how a programme
 *   starts reporting work that has not happened.
 *
 *   a rollup must never lower progress a person recorded. A fresh breakdown
 *   sits at 0%, so the first split of a 60%-complete task would otherwise
 *   report it as not started.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  rollupProgress, applyRollup, groupByParent, durationOf, progressOf,
  FULL_COVERAGE,
} = require('../scripts/api/programme-rollup.js');

function t(id, days, pct, extra) {
  return Object.assign({
    id: id, duration_days: days, progress_pct: pct, status: 'in_progress',
  }, extra || {});
}

const PARENT = t('p', 10, 0);

/* ---- the arithmetic ------------------------------------------------------ */

test('progress is weighted by duration, not by task count', () => {
  /* An 8-day child at 0% and a 2-day child at 100% is 20%, not 50%. */
  const r = rollupProgress(PARENT, [t('a', 8, 0), t('b', 2, 100)]);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.progress, 20);
});

test('a fully complete breakdown rolls up to exactly 100', () => {
  const r = rollupProgress(PARENT, [t('a', 3, 100), t('b', 7, 100)]);
  assert.strictEqual(r.progress, 100);
});

test('a completed status counts as 100 even if progress_pct lags', () => {
  /* Site managers tick "done"; nobody types 100. */
  const r = rollupProgress(PARENT, [t('a', 10, 0, { status: 'completed' })]);
  assert.strictEqual(r.progress, 100);
});

test('progress outside 0-100 is clamped rather than propagated', () => {
  assert.strictEqual(progressOf({ progress_pct: 140 }), 100);
  assert.strictEqual(progressOf({ progress_pct: -20 }), 0);
});

test('duration falls back to the date span when duration_days is absent', () => {
  assert.strictEqual(durationOf({ start_date: '2026-04-01', end_date: '2026-04-10' }), 10);
  assert.strictEqual(durationOf({ start: '2026-04-01', end: '2026-04-10' }), 10);
});

/* ---- coverage: the refusal that matters most ----------------------------- */

test('a partial breakdown is reported as partial, not as the whole task', () => {
  /* THE test. 10-day parent, one 2-day child, and the child is finished.
     Weighting across children alone gives 100 — a task reported complete
     when four fifths of it has not been touched. */
  const r = rollupProgress(PARENT, [t('a', 2, 100)]);
  assert.strictEqual(r.status, 'partial');
  assert.strictEqual(r.coverage, 0.2);
  assert.strictEqual(r.progress, 100);   // of the covered part only
});

test('a partial rollup is never written to the parent', () => {
  const r = rollupProgress(PARENT, [t('a', 2, 100)]);
  assert.strictEqual(applyRollup(PARENT, r), null);
});

test('a breakdown covering the whole task is usable', () => {
  const r = rollupProgress(PARENT, [t('a', 4, 50), t('b', 6, 0)]);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.progress, 20);
});

test('a day lost to rounding does not disqualify a complete breakdown', () => {
  /* 9 of 10 days is 90% — below FULL_COVERAGE, so still partial. 10 of 10
     with one day shaved by a weekend is the case the threshold protects. */
  assert.strictEqual(FULL_COVERAGE, 0.95);
  const r = rollupProgress(t('p', 20, 0), [t('a', 19, 100)]);
  assert.strictEqual(r.status, 'ok');
});

test('children covering more than the parent still roll up', () => {
  /* Over-coverage is a real state — the internal plan running past the
     contract dates is the divergence Project 1 5 deliberately keeps
     visible — and must not be treated as an error here. */
  const r = rollupProgress(PARENT, [t('a', 8, 100), t('b', 8, 0)]);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.progress, 50);
});

/* ---- never destroy recorded progress ------------------------------------- */

test('a fresh breakdown does not reset a task someone recorded progress on', () => {
  /* THE other test. A PM set this to 60% before breaking it down; the new
     subtasks are all at 0%. Writing the rollup would report started work as
     not started. */
  const parent = t('p', 10, 60);
  const r = rollupProgress(parent, [t('a', 10, 0)]);
  assert.strictEqual(r.progress, 0);
  assert.strictEqual(applyRollup(parent, r), null);
});

test('a rollup that exceeds recorded progress is applied', () => {
  const parent = t('p', 10, 60);
  const r = rollupProgress(parent, [t('a', 10, 80)]);
  assert.deepStrictEqual(applyRollup(parent, r), { progress_pct: 80 });
});

test('an equal rollup writes nothing rather than a no-op patch', () => {
  const parent = t('p', 10, 40);
  const r = rollupProgress(parent, [t('a', 10, 40)]);
  assert.strictEqual(applyRollup(parent, r), null);
});

/* ---- the honest-failure states ------------------------------------------- */

test('a task with no children yields nothing to write', () => {
  const r = rollupProgress(PARENT, []);
  assert.strictEqual(r.status, 'no_children');
  assert.strictEqual(r.progress, null);
  assert.strictEqual(applyRollup(PARENT, r), null);
});

test('undated children are refused rather than counted equally', () => {
  /* Falling back to a count-weighted average here would be the
     duration-weighting mistake in disguise. */
  const r = rollupProgress(PARENT, [{ id: 'a', progress_pct: 100 }]);
  assert.strictEqual(r.status, 'undated');
  assert.strictEqual(r.progress, null);
});

test('an undated parent is covered by its children by definition', () => {
  /* A WBS header has no span of its own, so there is nothing for the
     children to fail to cover. */
  const header = { id: 'g', name: 'Foundations' };
  const r = rollupProgress(header, [t('a', 3, 100), t('b', 7, 0)]);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.coverage, 1);
  assert.strictEqual(r.progress, 30);
});

test('null children in the list are ignored rather than crashing', () => {
  const r = rollupProgress(PARENT, [t('a', 10, 50), null, undefined]);
  assert.strictEqual(r.progress, 50);
});

/* ---- grouping ------------------------------------------------------------ */

test('children are grouped by parent for both id shapes', () => {
  const idx = groupByParent([
    { id: 'c1', parent_id: 'p1' },
    { task_id: 'c2', parent_id: 'p1' },
    { id: 'c3', parent_id: 'p2' },
    { id: 'root', parent_id: null },
  ]);
  assert.strictEqual(idx['p1'].length, 2);
  assert.strictEqual(idx['p2'].length, 1);
  assert.ok(!('null' in idx), 'a root task must not bucket under "null"');
});

test('grouping an empty list is an empty index, not a crash', () => {
  assert.deepStrictEqual(groupByParent([]), {});
  assert.deepStrictEqual(groupByParent(null), {});
});
