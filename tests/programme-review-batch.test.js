'use strict';

/*
 * The breakdown review gate.
 *
 * Two rules carry the weight, and both are about what does NOT get written:
 *
 *   silence is not consent. A reviewer who scrolls past thirty proposals and
 *   presses Commit must write nothing, not everything.
 *
 *   a rejected breakdown leaves no trace. That is the one behavioural
 *   difference from the matcher's suggestion queue: a rejected suggestion
 *   changes nothing because it was only ever about an existing task, whereas
 *   a rejected breakdown would otherwise have created rows.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  createBatch, decide, acceptAllValid, rejectAll, editChild, writeSet,
  summarise,
} = require('../scripts/api/programme-review-batch.js');

const okPlan = (n) => ({
  ok: true, errors: [],
  children: Array.from({ length: n }, (_, i) => ({
    name: 'Step ' + i, start_date: '2026-04-0' + (i + 1),
    end_date: '2026-04-0' + (i + 1), duration_days: 1, origin: 'local',
  })),
});
const badPlan = { ok: false, errors: ['Step 1 has no usable duration.'], children: [] };

function batchOf() {
  return createBatch([
    { taskId: 'A', taskName: 'Pour concrete', plan: okPlan(4) },
    { taskId: 'B', taskName: 'Steel frame', plan: okPlan(3) },
    { taskId: 'C', taskName: 'Roof', plan: badPlan },
  ]);
}

/* ---- silence is not consent --------------------------------------------- */

test('every item starts pending, never accepted', () => {
  for (const it of batchOf()) assert.strictEqual(it.decision, 'pending');
});

test('a fresh batch writes nothing', () => {
  assert.deepStrictEqual(writeSet(batchOf()), []);
});

test('commit is blocked while anything is unreviewed', () => {
  /* THE rule. Scrolling past a proposal is not reviewing it. */
  let b = decide(batchOf(), 'A', 'accepted');
  const s = summarise(b);
  assert.strictEqual(s.canCommit, false);
  assert.match(s.blockedReason, /2 proposals have not been reviewed/);
});

test('rejecting the rest unblocks commit — that is a decision', () => {
  let b = decide(batchOf(), 'A', 'accepted');
  b = decide(b, 'B', 'rejected');
  b = decide(b, 'C', 'rejected');
  assert.strictEqual(summarise(b).canCommit, true);
});

test('a fully rejected batch cannot commit, because there is nothing to write', () => {
  const s = summarise(rejectAll(batchOf()));
  assert.strictEqual(s.canCommit, false);
  assert.match(s.blockedReason, /Nothing was accepted/);
});

test('an empty batch cannot commit', () => {
  const s = summarise(createBatch([]));
  assert.strictEqual(s.canCommit, false);
  assert.match(s.blockedReason, /Nothing to review/);
});

/* ---- a rejected breakdown leaves no trace -------------------------------- */

test('rejected items never reach the write set', () => {
  let b = decide(batchOf(), 'A', 'accepted');
  b = decide(b, 'B', 'rejected');
  b = decide(b, 'C', 'rejected');
  assert.deepStrictEqual(writeSet(b).map(w => w.taskId), ['A']);
});

test('a rejection after an acceptance takes it back out', () => {
  let b = decide(batchOf(), 'A', 'accepted');
  assert.strictEqual(writeSet(b).length, 1);
  b = decide(b, 'A', 'rejected');
  assert.deepStrictEqual(writeSet(b), []);
});

/* ---- an invalid proposal cannot be accepted ------------------------------ */

test('accepting a proposal that failed validation does nothing', () => {
  /* The reviewer is reading errors, not rows. */
  const b = decide(batchOf(), 'C', 'accepted');
  assert.strictEqual(b.find(i => i.taskId === 'C').decision, 'pending');
  assert.deepStrictEqual(writeSet(b), []);
});

test('accept-all takes only what validated', () => {
  /* A bulk action that also accepted refused proposals would write rows
     nobody could have read. */
  const b = acceptAllValid(batchOf());
  assert.deepStrictEqual(b.map(i => i.decision),
                         ['accepted', 'accepted', 'pending']);
  assert.deepStrictEqual(writeSet(b).map(w => w.taskId), ['A', 'B']);
});

test('accept-all still leaves the invalid one blocking commit', () => {
  /* Correct: the reviewer has to say what happens to it. */
  assert.strictEqual(summarise(acceptAllValid(batchOf())).canCommit, false);
});

/* ---- edits --------------------------------------------------------------- */

test('an edit changes what would be written', () => {
  let b = editChild(batchOf(), 'A', 0, { name: 'Formwork', duration_days: 2 });
  b = acceptAllValid(b);
  b = decide(b, 'C', 'rejected');
  const written = writeSet(b).find(w => w.taskId === 'A').children[0];
  assert.strictEqual(written.name, 'Formwork');
  assert.strictEqual(written.duration_days, 2);
});

test('an edit leaves the original proposal visible next to it', () => {
  /* The reviewer is judging the model, not just the result. */
  const b = editChild(batchOf(), 'A', 0, { name: 'Formwork' });
  const item = b.find(i => i.taskId === 'A');
  assert.strictEqual(item.children[0].name, 'Formwork');
  assert.strictEqual(item.plan.children[0].name, 'Step 0');
});

test('editing an index that does not exist changes nothing', () => {
  const before = batchOf();
  assert.deepStrictEqual(editChild(before, 'A', 99, { name: 'x' }), before);
});

/* ---- immutability -------------------------------------------------------- */

test('decide returns a new batch rather than mutating in place', () => {
  /* Mutating is how a review screen stops re-rendering after the third
     decision. */
  const before = batchOf();
  const after = decide(before, 'A', 'accepted');
  assert.notStrictEqual(before, after);
  assert.strictEqual(before.find(i => i.taskId === 'A').decision, 'pending');
});

test('editChild does not mutate the batch it was given', () => {
  const before = batchOf();
  editChild(before, 'A', 0, { name: 'Formwork' });
  assert.strictEqual(before.find(i => i.taskId === 'A').children[0].name, 'Step 0');
});

/* ---- the summary a reviewer reads ---------------------------------------- */

test('the summary counts tasks and rows separately', () => {
  /* "2 tasks, 7 new rows" is the sentence someone needs before committing. */
  let b = acceptAllValid(batchOf());
  b = decide(b, 'C', 'rejected');
  const s = summarise(b);
  assert.strictEqual(s.taskCount, 2);
  assert.strictEqual(s.rowCount, 7);
  assert.strictEqual(s.invalid, 1);
  assert.strictEqual(s.canCommit, true);
});
