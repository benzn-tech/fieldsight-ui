'use strict';

/*
 * Unit tests for scripts/api/programme-rows.js — the pure row model behind
 * the Gantt.
 *
 * This module exists because GanttView used to rebuild its row list inline on
 * every render, calling a full `leaves.filter(...)` twice per parent
 * (programme.js:802-817 before this change). With 200 groups over 5,000
 * leaves that is ~2M iterations, paid again on every scroll event. The fix is
 * a single child index built once, so the structural guard below — which makes
 * `leaves.filter` throw — is the test that actually protects the performance
 * property. Correctness tests alone would not catch a regression back to
 * per-parent scanning.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  buildChildIndex,
  rollupFromChildren,
  buildRows,
  visibleSlice,
} = require('../scripts/api/programme-rows.js');

function leaf(id, parentId, start, end, days, pct) {
  return {
    task_id: id, parent_id: parentId, name: 'Task ' + id,
    start: start, end: end, duration_days: days, progress_pct: pct,
  };
}

const PARENTS = [
  { task_id: 'g1', wbs: '1', name: 'Foundations' },
  { task_id: 'g2', wbs: '2', name: 'Superstructure' },
];
const LEAVES = [
  leaf('t1', 'g1', '2026-04-01', '2026-04-10', 10, 100),
  leaf('t2', 'g1', '2026-04-05', '2026-04-20', 16, 50),
  leaf('t3', 'g2', '2026-05-01', '2026-05-08', 8, 0),
];

const noneCollapsed = new Set();

/* ---- buildChildIndex ----------------------------------------------------- */

test('buildChildIndex groups leaves under their parent_id', () => {
  const idx = buildChildIndex(LEAVES);
  assert.deepStrictEqual(idx.g1.map((t) => t.task_id), ['t1', 't2']);
  assert.deepStrictEqual(idx.g2.map((t) => t.task_id), ['t3']);
});

test('buildChildIndex preserves source order within a parent', () => {
  const idx = buildChildIndex([LEAVES[1], LEAVES[0]]);
  assert.deepStrictEqual(idx.g1.map((t) => t.task_id), ['t2', 't1']);
});

/* ---- rollupFromChildren -------------------------------------------------- */

test('rollupFromChildren spans min start to max end', () => {
  const r = rollupFromChildren([LEAVES[0], LEAVES[1]]);
  assert.strictEqual(r.start, '2026-04-01');
  assert.strictEqual(r.end, '2026-04-20');
});

test('rollupFromChildren weights progress by duration, not by task count', () => {
  /* t1: 10 days @ 100% = 10 done; t2: 16 days @ 50% = 8 done.
     18 / 26 = 69%. An unweighted mean would give 75%. */
  const r = rollupFromChildren([LEAVES[0], LEAVES[1]]);
  assert.strictEqual(r.progress, 69);
});

test('rollupFromChildren returns the empty shape for no children', () => {
  assert.deepStrictEqual(rollupFromChildren([]),
    { start: null, end: null, progress: 0 });
});

test('rollupFromChildren does not divide by zero when every duration is 0', () => {
  const r = rollupFromChildren([leaf('x', 'g1', '2026-04-01', '2026-04-01', 0, 50)]);
  assert.strictEqual(r.progress, 0);
});

/* ---- buildRows ----------------------------------------------------------- */

test('buildRows emits each group followed by its own leaves, in parent order', () => {
  const rows = buildRows(PARENTS, LEAVES, noneCollapsed);
  assert.deepStrictEqual(rows.map((r) => r.kind + ':' + r.task.task_id),
    ['group:g1', 'leaf:t1', 'leaf:t2', 'group:g2', 'leaf:t3']);
});

test('buildRows indents groups at 0 and leaves at 1', () => {
  const rows = buildRows(PARENTS, LEAVES, noneCollapsed);
  assert.strictEqual(rows[0].indent, 0);
  assert.strictEqual(rows[1].indent, 1);
});

test('buildRows keeps a collapsed group row but drops its leaves', () => {
  const rows = buildRows(PARENTS, LEAVES, new Set(['g1']));
  assert.deepStrictEqual(rows.map((r) => r.kind + ':' + r.task.task_id),
    ['group:g1', 'group:g2', 'leaf:t3']);
});

test('buildRows stamps the group row with rolled-up dates, status and zero duration', () => {
  const g1 = buildRows(PARENTS, LEAVES, noneCollapsed)[0];
  assert.strictEqual(g1.task.start, '2026-04-01');
  assert.strictEqual(g1.task.end, '2026-04-20');
  assert.strictEqual(g1.task.progress_pct, 69);
  assert.strictEqual(g1.task.status, 'group');
  assert.strictEqual(g1.task.duration_days, 0);
});

test('buildRows exposes the untouched parent alongside the derived group task', () => {
  const g1 = buildRows(PARENTS, LEAVES, noneCollapsed)[0];
  assert.strictEqual(g1.parent, PARENTS[0], 'parent must be the original object');
  assert.notStrictEqual(g1.task, PARENTS[0], 'task must be a derived copy');
  assert.strictEqual(PARENTS[0].status, undefined, 'the parent must not be mutated');
});

test('buildRows emits a group with no children and skips orphan leaves', () => {
  const rows = buildRows(
    [{ task_id: 'g9', wbs: '9', name: 'Empty' }],
    [leaf('orphan', 'nosuchgroup', '2026-04-01', '2026-04-02', 1, 0)],
    noneCollapsed,
  );
  assert.deepStrictEqual(rows.map((r) => r.task.task_id), ['g9']);
  assert.strictEqual(rows[0].task.start, null);
});

/* ---- the structural guard ------------------------------------------------ */

test('buildRows never scans the full leaf array per parent', () => {
  const parents = [];
  for (let i = 0; i < 200; i++) parents.push({ task_id: 'g' + i, wbs: String(i), name: 'G' + i });
  const leaves = [];
  for (let i = 0; i < 5000; i++) {
    leaves.push(leaf('t' + i, 'g' + (i % 200), '2026-04-01', '2026-04-10', 10, 0));
  }

  /* A per-parent `leaves.filter(...)` — the shape this module replaces — is
     what makes the row build O(parents x leaves) and therefore unaffordable
     inside a scroll handler. Make it detonate. */
  leaves.filter = function () {
    throw new Error('buildRows must not scan all leaves per parent — use the child index');
  };

  const rows = buildRows(parents, leaves, noneCollapsed);
  assert.strictEqual(rows.length, 200 + 5000);
});

/* ---- visibleSlice -------------------------------------------------------- */

test('visibleSlice covers the viewport plus overscan on both sides', () => {
  const s = visibleSlice(4400, 600, 1000, 44, 200);
  assert.strictEqual(s.first, Math.floor((4400 - 200) / 44));   // 95
  assert.strictEqual(s.last, Math.ceil((4400 + 600 + 200) / 44)); // 114
});

test('visibleSlice clamps to the first and last row', () => {
  const top = visibleSlice(0, 600, 10, 44, 200);
  assert.strictEqual(top.first, 0);
  assert.strictEqual(top.topSpc, 0);

  const bottom = visibleSlice(999999, 600, 10, 44, 200);
  assert.strictEqual(bottom.last, 9);
  assert.strictEqual(bottom.botSpc, 0);
});

test('visibleSlice spacers plus rendered rows always total the full height', () => {
  const rowCount = 1000, rowH = 44;
  const s = visibleSlice(4400, 600, rowCount, rowH, 200);
  const rendered = (s.last - s.first + 1) * rowH;
  assert.strictEqual(s.topSpc + rendered + s.botSpc, rowCount * rowH);
});

test('visibleSlice returns an empty slice for an empty programme', () => {
  assert.deepStrictEqual(visibleSlice(0, 600, 0, 44, 200),
    { first: 0, last: -1, topSpc: 0, botSpc: 0 });
});
