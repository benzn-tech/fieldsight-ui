'use strict';

/*
 * Contract test: a zone-split plan must be writable by the backend that will
 * receive it, and must work on the task shapes actually shipped.
 *
 * tests/programme-zone-split.test.js asserts the planner's behaviour against
 * a task object this file's author invented — the same kind of test that
 * passed while programme-mentions could read only one of its two input
 * shapes.
 *
 * Two things are pinned here that unit tests cannot reach:
 *
 *   the field NAMES. The children carry start_date/end_date/duration_days/
 *   status/zone because that is what programme_tasks.create_task takes and
 *   what _UPDATABLE allows. A rename on either side should break a test, not
 *   a form. The pipeline checkout is read directly rather than mirrored.
 *
 *   the real fixture. A plan built from a shipped fixture task has to produce
 *   children inside the contract dates.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');

const {
  planZoneSplit, overrunDays,
} = require('../scripts/api/programme-zone-split.js');

/* The sibling pipeline checkout. Absent in a UI-only clone, in which case the
   backend half of this file skips rather than fails — a missing repo is not a
   defect in this one. */
const PIPE = path.resolve(__dirname, '..', '..', 'pipe',
                          'src', 'repositories', 'programme_tasks.py');
const havePipe = fs.existsSync(PIPE);

function loadProgrammeFixture() {
  const sandbox = { window: { FieldSight: { fixtures: {} } } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'scripts', 'mock',
                              'programme.fixture.js'), 'utf8'),
    sandbox, { filename: 'programme.fixture.js' });
  return sandbox.window.FieldSight.fixtures.programme;
}

/* ---- the backend contract ------------------------------------------------ */

test('every schedulable field a child carries is one the backend accepts',
  { skip: havePipe ? false : 'fieldsight-pipeline checkout not present' }, () => {
  const py = fs.readFileSync(PIPE, 'utf8');
  const updatable = new Set(
    (py.match(/_UPDATABLE = frozenset\(\{([\s\S]*?)\}\)/)[1].match(/"(\w+)"/g) || [])
      .map(s => s.replace(/"/g, '')));

  assert.ok(updatable.size > 0, 'parsed _UPDATABLE out of the repository');

  const child = planZoneSplit(
    { name: 'Pour concrete', start_date: '2026-04-01', end_date: '2026-04-10' },
    { zones: ['Level 1'], assignees: ['ben'] }).children[0];

  /* Not every key is a column: `assignee` is written through
     programme_task_assignees, and `origin` is forced to 'local' by
     create_task rather than passed. Everything else must be a real column. */
  const notColumns = new Set(['assignee', 'origin']);
  for (const key of Object.keys(child)) {
    if (notColumns.has(key)) continue;
    assert.ok(updatable.has(key),
              `child field "${key}" is not in programme_tasks._UPDATABLE `
              + `(${[...updatable].sort().join(', ')}) — either the planner or `
              + 'the backend was renamed without the other');
  }
});

test('the fields the backend needs are actually produced',
  { skip: havePipe ? false : 'fieldsight-pipeline checkout not present' }, () => {
  /* The reverse direction: a plan that omitted start_date would be written
     as an undated row, which programme_snapshot then classifies as a
     structural header — a split that silently becomes five more headings. */
  const child = planZoneSplit(
    { name: 'Pour concrete', start_date: '2026-04-01', end_date: '2026-04-10' },
    { zones: ['Level 1'] }).children[0];
  for (const required of ['name', 'start_date', 'end_date', 'zone']) {
    assert.ok(child[required], `child is missing ${required}`);
  }
});

/* ---- the real fixture ---------------------------------------------------- */

test('a shipped fixture task splits into children inside its contract dates', () => {
  const programme = loadProgrammeFixture();
  const task = programme.tasks.find(t => t.parent_id && t.start && t.end);
  assert.ok(task, 'the fixture has a dated leaf to split');

  const r = planZoneSplit(task, { zones: ['Level 1', 'Level 2'] });
  assert.strictEqual(r.ok, true, r.errors.join(' '));
  assert.strictEqual(overrunDays(task, r.children), 0);
  for (const c of r.children) {
    assert.strictEqual(c.start_date, task.start);
    assert.strictEqual(c.end_date, task.end);
  }
});

test('every dated fixture leaf can be split in parallel', () => {
  /* Parallel is the default, so it has to work on everything a PM might
     right-click. */
  const programme = loadProgrammeFixture();
  const leaves = programme.tasks.filter(t => t.parent_id && t.start && t.end);
  assert.ok(leaves.length > 5, 'enough leaves to be worth asserting over');
  for (const t of leaves) {
    const r = planZoneSplit(t, { zones: ['A', 'B'] });
    assert.strictEqual(r.ok, true, `${t.task_id}: ${r.errors.join(' ')}`);
  }
});

test('the fixture group headers all refuse to split', () => {
  const programme = loadProgrammeFixture();
  const headers = programme.tasks.filter(t => !t.parent_id);
  assert.ok(headers.length > 0);
  for (const h of headers) {
    assert.strictEqual(planZoneSplit(h, { zones: ['A'] }).ok, false,
                       `${h.task_id} is an undated heading and must refuse`);
  }
});
