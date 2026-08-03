'use strict';

/*
 * Contract test: the rollup must work on the children the SPLITTER actually
 * produces, and on the tasks the fixtures actually ship.
 *
 * tests/programme-rollup.test.js asserts the arithmetic against child objects
 * this file's author invented. But the children this module will really see
 * come from planZoneSplit, and the parents come from the programme fixture —
 * neither of which the unit tests ever touch.
 *
 * That gap is not hypothetical: programme-mentions shipped handling only one
 * of its two task shapes with 22 unit tests passing, and only a contract test
 * against the shipped fixtures caught it.
 *
 * The parallel/sequential distinction is the interesting case here, because
 * the two produce very different coverage numbers and both have to be right.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');

const { planZoneSplit } = require('../scripts/api/programme-zone-split.js');
const {
  rollupProgress, applyRollup, groupByParent,
} = require('../scripts/api/programme-rollup.js');

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

const TASK = { id: 'uuid-a', name: 'Pour concrete',
               start_date: '2026-04-01', end_date: '2026-04-10',
               duration_days: 10, progress_pct: 0 };

/* ---- the splitter's own output ------------------------------------------- */

test('a parallel zone split rolls up as the share of zones finished', () => {
  /* Three zones, each carrying the full 10-day span, one of them done.
     One zone of three complete is 33% — not 100% because "a zone is
     finished", and not 10% because of some coverage arithmetic. */
  const plan = planZoneSplit(TASK, { zones: ['L1', 'L2', 'L3'] });
  plan.children[0].progress_pct = 100;

  const r = rollupProgress(TASK, plan.children);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.progress, 33);
});

test('a parallel split is over-coverage, and that is not an error', () => {
  /* Every zone inherits the whole span, so childDays is 3x parentDays. The
     module must not read that as "something is wrong". */
  const plan = planZoneSplit(TASK, { zones: ['L1', 'L2', 'L3'] });
  const r = rollupProgress(TASK, plan.children);
  assert.strictEqual(r.coverage, 3);
  assert.strictEqual(r.status, 'ok');
});

test('a sequential zone split covers the parent exactly once', () => {
  const plan = planZoneSplit(TASK, { zones: ['L1', 'L2', 'L3'],
                                     distribute: 'sequential' });
  const r = rollupProgress(TASK, plan.children);
  assert.strictEqual(r.coverage, 1);
  assert.strictEqual(r.status, 'ok');
});

test('finishing the first sequential slice moves the parent by its own weight', () => {
  /* 10 days across 3 is 4/3/3, so the first slice is 40% of the work. */
  const plan = planZoneSplit(TASK, { zones: ['L1', 'L2', 'L3'],
                                     distribute: 'sequential' });
  plan.children[0].progress_pct = 100;
  assert.strictEqual(rollupProgress(TASK, plan.children).progress, 40);
});

test('a freshly split task writes nothing back', () => {
  /* Every child starts at 0%, so the rollup is 0 and the parent must be left
     alone rather than stamped with it. */
  const plan = planZoneSplit(TASK, { zones: ['L1', 'L2'] });
  const r = rollupProgress(TASK, plan.children);
  assert.strictEqual(r.progress, 0);
  assert.strictEqual(applyRollup(TASK, r), null);
});

test('splitting a task that was already 60% done does not reset it', () => {
  /* The composition of the two refusals: the split produces 0% children, and
     applyRollup declines to lower recorded progress. */
  const started = Object.assign({}, TASK, { progress_pct: 60 });
  const plan = planZoneSplit(started, { zones: ['L1', 'L2'] });
  const r = rollupProgress(started, plan.children);
  assert.strictEqual(applyRollup(started, r), null);
});

test('completing every zone reports the parent complete', () => {
  const plan = planZoneSplit(TASK, { zones: ['L1', 'L2', 'L3'] });
  plan.children.forEach(c => { c.status = 'completed'; });
  const r = rollupProgress(TASK, plan.children);
  assert.strictEqual(r.progress, 100);
  assert.deepStrictEqual(applyRollup(TASK, r), { progress_pct: 100 });
});

/* ---- the shipped fixture ------------------------------------------------- */

test('every dated fixture leaf splits and rolls up without a refusal', () => {
  const programme = loadProgrammeFixture();
  const leaves = programme.tasks.filter(t => t.parent_id && t.start && t.end);
  assert.ok(leaves.length > 5);

  for (const leaf of leaves) {
    const plan = planZoneSplit(leaf, { zones: ['A', 'B'] });
    assert.strictEqual(plan.ok, true, `${leaf.task_id}: ${plan.errors.join(' ')}`);
    const r = rollupProgress(leaf, plan.children);
    assert.strictEqual(r.status, 'ok',
                       `${leaf.task_id} rolled up as ${r.status}`);
  }
});

test('the fixture WBS groups roll up from their real children', () => {
  /* The fixture links children to groups by task_id, not by uuid — the
     document shape. groupByParent has to handle it, or every group reports
     no_children and the tree looks empty. */
  const programme = loadProgrammeFixture();
  const byParent = groupByParent(programme.tasks);
  const groups = programme.tasks.filter(t => !t.parent_id);

  let rolled = 0;
  for (const g of groups) {
    const kids = byParent[g.task_id];
    if (!kids) continue;
    const r = rollupProgress(g, kids);
    assert.strictEqual(r.status, 'ok', `${g.task_id} -> ${r.status}`);
    assert.ok(r.progress >= 0 && r.progress <= 100);
    rolled++;
  }
  assert.ok(rolled > 0,
            'no fixture group found its children — groupByParent is keyed on '
            + 'the wrong id, which would show every group as empty');
});

test('a fixture group rollup matches a hand-computed weighting', () => {
  /* One group checked by hand, so the test cannot agree with a broken
     implementation by using the same broken arithmetic twice. */
  const programme = loadProgrammeFixture();
  const byParent = groupByParent(programme.tasks);
  const group = programme.tasks.find(t => !t.parent_id && byParent[t.task_id]);
  const kids = byParent[group.task_id];

  let days = 0, done = 0;
  for (const k of kids) {
    const d = k.duration_days;
    days += d;
    done += d * (k.status === 'completed' ? 100 : k.progress_pct) / 100;
  }
  assert.strictEqual(rollupProgress(group, kids).progress,
                     Math.round(done / days * 100));
});
