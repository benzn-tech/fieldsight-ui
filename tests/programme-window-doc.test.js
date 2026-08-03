'use strict';

/*
 * Window rows → the {parents, leaves} document the Gantt renders.
 *
 * The window endpoint speaks Aurora: start_date/end_date, parent_id as a
 * uuid, and an in_window flag marking rows that were pulled in only as
 * ancestors. The Gantt speaks the legacy document. Something has to translate,
 * and doing it here — once, tested — beats teaching the page two shapes.
 *
 * The parents/leaves split uses the SAME rule as the server's snapshot
 * builder: DATES decide, not whether a task has children. Sorting by
 * "has children" would drop a contract task out of `leaves` the moment a PM
 * broke it down — the bug that the snapshot contract test caught on the
 * backend. Repeating it here would reintroduce it in the UI.
 */
const test = require('node:test');
const assert = require('node:assert');

const { windowRowsToDoc } = require('../scripts/api/programme-window-doc.js');

function row(id, over) {
  return Object.assign({
    id: id, source_task_id: id, parent_id: null,
    name: 'Task ' + id, wbs_code: null,
    start_date: '2026-04-01', end_date: '2026-04-10',
    duration_days: 10, progress_pct: 0, status: 'not_started',
    in_window: true, assignees: [],
  }, over || {});
}

test('dated rows become leaves', () => {
  const doc = windowRowsToDoc([row('A')]);
  assert.deepStrictEqual(doc.leaves.map((t) => t.task_id), ['A']);
  assert.deepStrictEqual(doc.parents, []);
});

test('undated rows become parents — the WBS headers', () => {
  const doc = windowRowsToDoc([row('G', { start_date: null, end_date: null })]);
  assert.deepStrictEqual(doc.parents.map((t) => t.task_id), ['G']);
  assert.deepStrictEqual(doc.leaves, []);
});

test('a dated row with children stays a LEAF', () => {
  /* The rule the backend's snapshot contract test caught. Sorting by "has
     children" would drop a contract task out of the Gantt's leaf list the
     moment a PM broke it down. */
  const doc = windowRowsToDoc([
    row('G', { start_date: null, end_date: null }),
    row('A', { parent_id: 'G' }),
    row('SUB', { parent_id: 'A', source_task_id: null }),
  ]);
  assert.deepStrictEqual(doc.parents.map((t) => t.task_id), ['G']);
  assert.deepStrictEqual(doc.leaves.map((t) => t.task_id).sort(), ['A', 'SUB']);
});

test('a leaf points at its nearest ancestor by document id', () => {
  const doc = windowRowsToDoc([
    row('G', { start_date: null, end_date: null }),
    row('A', { parent_id: 'G' }),
  ]);
  assert.strictEqual(doc.leaves[0].parent_id, 'G');
});

test('a local row with no source id falls back to its uuid', () => {
  const doc = windowRowsToDoc([row('u-1', { source_task_id: null })]);
  assert.strictEqual(doc.leaves[0].task_id, 'u-1');
});

test('column names are translated to the document\'s', () => {
  const doc = windowRowsToDoc([row('A')]);
  const leaf = doc.leaves[0];
  assert.strictEqual(leaf.start, '2026-04-01');
  assert.strictEqual(leaf.end, '2026-04-10');
  assert.ok(!('start_date' in leaf), 'the Gantt reads start/end, not the columns');
});

test('rows carried in only as ancestors are flagged as context', () => {
  /* They are outside the selected range and must render greyed, not as work
     happening now. */
  const doc = windowRowsToDoc([
    row('G', { start_date: null, end_date: null, in_window: false }),
    row('OLD', { in_window: false }),
    row('A'),
  ]);
  assert.strictEqual(doc.parents[0].out_of_window, true);
  const byId = Object.fromEntries(doc.leaves.map((t) => [t.task_id, t]));
  assert.strictEqual(byId.OLD.out_of_window, true);
  assert.strictEqual(byId.A.out_of_window, false);
});

test('row_version travels through so autosave can lock on it', () => {
  const doc = windowRowsToDoc([row('A', { row_version: 7 })]);
  assert.strictEqual(doc.leaves[0].row_version, 7);
});

test('the uuid travels through so per-task writes can address the row', () => {
  /* task_id is the file's identifier; PATCH addresses our uuid. Losing it
     here would make every write from the window view unaddressable. */
  const doc = windowRowsToDoc([row('A', { id: 'uuid-a' })]);
  assert.strictEqual(doc.leaves[0].id, 'uuid-a');
});

test('the span covers every dated row, ancestors included', () => {
  const doc = windowRowsToDoc([
    row('A', { start_date: '2026-05-01', end_date: '2026-05-10' }),
    row('B', { start_date: '2026-03-01', end_date: '2026-06-30' }),
  ]);
  assert.strictEqual(doc.start_date, '2026-03-01');
  assert.strictEqual(doc.end_date, '2026-06-30');
});

test('an empty window produces a valid empty document', () => {
  const doc = windowRowsToDoc([]);
  assert.deepStrictEqual(doc.parents, []);
  assert.deepStrictEqual(doc.leaves, []);
  assert.strictEqual(doc.start_date, null);
  assert.strictEqual(doc.end_date, null);
  assert.deepStrictEqual(windowRowsToDoc(null).leaves, []);
});

test('depends_on is carried through when present', () => {
  /* The critical-path tier reads it. Dropping it here would silently make
     every windowed programme tier 2. */
  const doc = windowRowsToDoc([row('B', { depends_on: ['A'] })]);
  assert.deepStrictEqual(doc.leaves[0].depends_on, ['A']);
});

test('a missing depends_on becomes an empty array, not undefined', () => {
  assert.deepStrictEqual(windowRowsToDoc([row('A')]).leaves[0].depends_on, []);
});
