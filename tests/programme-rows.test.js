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

/* ---- three levels: local children under a contract task ------------------ */
/*
 * The row builder used to iterate `parents` and emit only leaves whose
 * parent_id matched a WBS GROUP. A task parented to another TASK — exactly
 * what a zone split and an AI breakdown produce (Project 1 §5: local children
 * hang under the untouched imported row) — was never emitted. No error, no
 * warning, just a row that does not exist on screen. That is how ui#178
 * shipped a zone split whose children were invisible.
 */
test('a task parented to another task is rendered', () => {
  const parents = [{ task_id: 'G1', name: 'Foundations' }];
  const leaves = [
    { task_id: 'T1', parent_id: 'G1', name: 'Pour concrete',
      start: '2026-04-01', end: '2026-04-10', duration_days: 10, progress_pct: 0 },
    { task_id: 'Z1', parent_id: 'T1', name: 'Pour concrete — Level 1',
      start: '2026-04-01', end: '2026-04-10', duration_days: 10, progress_pct: 0 },
  ];
  const ids = buildRows(parents, leaves, new Set()).map(r => r.task.task_id);
  assert.deepStrictEqual(ids, ['G1', 'T1', 'Z1']);
});

test('a zone child is indented one level deeper than its contract task', () => {
  const parents = [{ task_id: 'G1' }];
  const leaves = [
    { task_id: 'T1', parent_id: 'G1' },
    { task_id: 'Z1', parent_id: 'T1' },
  ];
  const rows = buildRows(parents, leaves, new Set());
  assert.deepStrictEqual(rows.map(r => r.indent), [0, 1, 2]);
});

test('a task with children is flagged so the cell can offer a toggle', () => {
  const rows = buildRows([{ task_id: 'G1' }],
    [{ task_id: 'T1', parent_id: 'G1' }, { task_id: 'Z1', parent_id: 'T1' }],
    new Set());
  assert.strictEqual(rows[1].hasChildren, true);
  assert.strictEqual(rows[2].hasChildren, false);
});

test('collapsing a contract task hides its zones but keeps the task', () => {
  const rows = buildRows([{ task_id: 'G1' }],
    [{ task_id: 'T1', parent_id: 'G1' }, { task_id: 'Z1', parent_id: 'T1' }],
    new Set(['T1']));
  assert.deepStrictEqual(rows.map(r => r.task.task_id), ['G1', 'T1']);
});

test('collapsing the group hides the whole subtree', () => {
  const rows = buildRows([{ task_id: 'G1' }],
    [{ task_id: 'T1', parent_id: 'G1' }, { task_id: 'Z1', parent_id: 'T1' }],
    new Set(['G1']));
  assert.deepStrictEqual(rows.map(r => r.task.task_id), ['G1']);
});

test('a group rollup counts its own children, not its grandchildren', () => {
  /* The zones re-express the same work as their parent. Counting both would
     double it and report a task as further along than it is. */
  const rows = buildRows([{ task_id: 'G1' }], [
    { task_id: 'T1', parent_id: 'G1', duration_days: 10, progress_pct: 0,
      start: '2026-04-01', end: '2026-04-10' },
    { task_id: 'Z1', parent_id: 'T1', duration_days: 10, progress_pct: 100,
      start: '2026-04-01', end: '2026-04-10' },
  ], new Set());
  assert.strictEqual(rows[0].task.progress_pct, 0);
});

test('a parent_id cycle terminates instead of hanging the tab', () => {
  /* The server-side window CTE was proved to terminate on a cycle against
     real Aurora. Nothing was protecting the client, and here a cycle is an
     infinite loop inside a render. */
  const rows = buildRows([{ task_id: 'G1' }], [
    { task_id: 'A', parent_id: 'G1' },
    { task_id: 'B', parent_id: 'A' },
    { task_id: 'A2', parent_id: 'B', name: 'points back' },
  ], new Set());
  assert.ok(rows.length >= 3);
  assert.ok(rows.length < 20, 'terminated');
});

test('a task pointing at itself does not recurse', () => {
  const rows = buildRows([{ task_id: 'G1' }],
    [{ task_id: 'A', parent_id: 'G1' }, { task_id: 'A', parent_id: 'A' }],
    new Set());
  assert.ok(rows.length < 10);
});

test('depth is bounded', () => {
  /* Ten levels of nesting is a data problem, not a plan. */
  const leaves = [{ task_id: 'L0', parent_id: 'G1' }];
  for (let i = 1; i < 10; i++) {
    leaves.push({ task_id: 'L' + i, parent_id: 'L' + (i - 1) });
  }
  const rows = buildRows([{ task_id: 'G1' }], leaves, new Set());
  const maxIndent = Math.max(...rows.map(r => r.indent));
  assert.ok(maxIndent <= 6, 'indent capped, got ' + maxIndent);
});

test('every row is still one uniform row — the virtualiser depends on it', () => {
  /* visibleSlice and the spacer heights are pure arithmetic over a row
     COUNT at a fixed height. Nesting must add rows, never taller ones. */
  const rows = buildRows([{ task_id: 'G1' }], [
    { task_id: 'T1', parent_id: 'G1' },
    { task_id: 'Z1', parent_id: 'T1' },
    { task_id: 'Z2', parent_id: 'T1' },
  ], new Set());
  assert.strictEqual(rows.length, 4);
  const slice = visibleSlice(0, 100, rows.length, 36, 0);
  assert.strictEqual(slice.topSpc + (slice.last - slice.first + 1) * 36 + slice.botSpc,
                     rows.length * 36);
});
