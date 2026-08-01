'use strict';

/*
 * Autosave contract for the programme page.
 *
 * Whole-document PUT is no longer the day-to-day write path — a 5,000-task
 * programme is ~1.5MB, and round-tripping that per keystroke is why the page
 * had a Save button in the first place. Each edit now PATCHes one task.
 *
 * The properties worth pinning: every write carries the row_version the
 * client last saw (or the optimistic lock cannot fire), unchanged fields are
 * not sent (or a second editor's harmless concurrent edit becomes a spurious
 * 409), and a 409 refreshes that one row rather than discarding the user's
 * other pending edits.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  planAutosave, applyConflict, mergeQueued,
} = require('../scripts/api/programme-autosave.js');

test('an edit produces a PATCH carrying the row_version last seen', () => {
  const task = { task_id: 'A1', row_version: 4, progress_pct: 10 };
  const plan = planAutosave(task, { progress_pct: 50 });
  assert.strictEqual(plan.method, 'PATCH');
  assert.strictEqual(plan.task_id, 'A1');
  assert.strictEqual(plan.body.row_version, 4);
  assert.strictEqual(plan.body.progress_pct, 50);
});

test('a no-op edit produces no request at all', () => {
  const task = { task_id: 'A1', row_version: 4, progress_pct: 10, name: 'Pour slab' };
  assert.strictEqual(planAutosave(task, { progress_pct: 10, name: 'Pour slab' }), null);
});

test('only changed fields are sent', () => {
  const task = { task_id: 'A1', row_version: 4, progress_pct: 10, name: 'Pour slab' };
  const plan = planAutosave(task, { progress_pct: 40, name: 'Pour slab' });
  assert.deepStrictEqual(Object.keys(plan.body).sort(), ['progress_pct', 'row_version']);
});

test('a row_version of 0 is still sent rather than dropped as falsy', () => {
  const task = { task_id: 'A1', row_version: 0, progress_pct: 10 };
  const plan = planAutosave(task, { progress_pct: 50 });
  assert.strictEqual(plan.body.row_version, 0);
});

test('an edit setting a field back to a falsy value is still an edit', () => {
  const task = { task_id: 'A1', row_version: 4, progress_pct: 50, zone: 'Level 3' };
  const plan = planAutosave(task, { progress_pct: 0, zone: '' });
  assert.strictEqual(plan.body.progress_pct, 0);
  assert.strictEqual(plan.body.zone, '');
});

test('a 409 replaces that one row and keeps every other edit', () => {
  const tasks = [
    { task_id: 'A1', row_version: 4, progress_pct: 50 },
    { task_id: 'A2', row_version: 2, progress_pct: 30 },
  ];
  const fresh = { task_id: 'A1', row_version: 9, progress_pct: 75 };
  const next = applyConflict(tasks, fresh);
  assert.deepStrictEqual(next[0], fresh);
  assert.deepStrictEqual(next[1], tasks[1], 'the untouched task must survive the conflict');
});

test('a 409 for an unknown task leaves the list alone', () => {
  const tasks = [{ task_id: 'A1', row_version: 4 }];
  assert.deepStrictEqual(applyConflict(tasks, { task_id: 'GONE', row_version: 1 }), tasks);
});

test('applyConflict does not mutate the array it was given', () => {
  const tasks = [{ task_id: 'A1', row_version: 4 }];
  applyConflict(tasks, { task_id: 'A1', row_version: 9 });
  assert.strictEqual(tasks[0].row_version, 4, 'React state must not be mutated in place');
});

/* ---- debounce coalescing -------------------------------------------------
   Dragging a progress slider fires a change per pixel. Those must collapse
   into one PATCH, and the collapse has to be last-write-wins per field —
   sending them in sequence would make every one after the first fail the
   optimistic lock against a row_version the server has already bumped. */

test('queued edits to the same task coalesce, last write winning per field', () => {
  const merged = mergeQueued(
    { progress_pct: 10, name: 'Pour slab' },
    { progress_pct: 60 },
  );
  assert.deepStrictEqual(merged, { progress_pct: 60, name: 'Pour slab' });
});

test('mergeQueued treats an absent pending edit as nothing queued', () => {
  assert.deepStrictEqual(mergeQueued(undefined, { progress_pct: 60 }),
    { progress_pct: 60 });
});

test('mergeQueued does not mutate either input', () => {
  const pending = { progress_pct: 10 };
  const next = { progress_pct: 60 };
  mergeQueued(pending, next);
  assert.strictEqual(pending.progress_pct, 10);
  assert.strictEqual(next.progress_pct, 60);
});
