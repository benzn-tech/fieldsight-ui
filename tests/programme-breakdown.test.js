'use strict';

/*
 * Validating an AI breakdown proposal.
 *
 * This module is the gate between a model's output and rows in the database,
 * so the tests that matter are the refusals. Three carry the weight:
 *
 *   an inferred ORDER is never stored. A sequence nobody stated, written as
 *   data, lands on real people's dates.
 *
 *   a proposal that does not cover the parent is refused. Three days of steps
 *   under a ten-day task means the model dropped most of the work.
 *
 *   nothing is coerced. A missing duration refuses the proposal rather than
 *   being defaulted — inventing a number is how a plausible schedule gets
 *   built out of a model's omission.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  validateProposal, suggestedOrder, MAX_STEPS, MIN_COVERAGE,
} = require('../scripts/api/programme-breakdown.js');

const TASK = {
  task_id: 'A1020', name: 'Pour concrete',
  start_date: '2026-04-01', end_date: '2026-04-10', duration_days: 10,
};

const GOOD = { steps: [
  { name: 'Formwork', duration_days: 3 },
  { name: 'Rebar fixing', duration_days: 3 },
  { name: 'Pour', duration_days: 1 },
  { name: 'Cure', duration_days: 3 },
] };

/* ---- the happy path ------------------------------------------------------ */

test('a good proposal becomes local children tiling the parent span', () => {
  const r = validateProposal(TASK, GOOD);
  assert.strictEqual(r.ok, true, r.errors.join(' '));
  assert.deepStrictEqual(r.children.map(c => [c.start_date, c.end_date]), [
    ['2026-04-01', '2026-04-03'],
    ['2026-04-04', '2026-04-06'],
    ['2026-04-07', '2026-04-07'],
    ['2026-04-08', '2026-04-10'],
  ]);
});

test('children are local, so they survive the next import', () => {
  for (const c of validateProposal(TASK, GOOD).children) {
    assert.strictEqual(c.origin, 'local');
    assert.strictEqual(c.progress_pct, 0);
    assert.strictEqual(c.status, 'not_started');
  }
});

test('the parent is never mutated', () => {
  const before = JSON.stringify(TASK);
  validateProposal(TASK, GOOD);
  assert.strictEqual(JSON.stringify(TASK), before);
});

test('a remainder is left at the end rather than padded into the steps', () => {
  /* The model sized the work. Stretching its numbers to fill the box would
     be this module inventing a schedule. */
  const short = { steps: [{ name: 'A', duration_days: 4 },
                          { name: 'B', duration_days: 5 }] };
  const r = validateProposal(TASK, short);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.children[1].end_date, '2026-04-09');  // not -10
});

/* ---- THE refusal: no inferred order is ever stored ----------------------- */

test('an order the model suggested is never written as data', () => {
  const withOrder = { steps: [
    { name: 'Formwork', duration_days: 5 },
    { name: 'Pour', duration_days: 5, after: 'Formwork' },
  ] };
  const r = validateProposal(TASK, withOrder);
  assert.strictEqual(r.ok, true);
  for (const c of r.children) {
    assert.ok(!('depends_on' in c),
      'an inferred sequence became data — it lands on real people’s dates');
    assert.ok(!('after' in c));
  }
});

test('the suggested order is returned separately, for a person to accept', () => {
  const withOrder = { steps: [
    { name: 'Formwork', duration_days: 5 },
    { name: 'Pour', duration_days: 5, after: 'Formwork' },
  ] };
  assert.deepStrictEqual(suggestedOrder(withOrder),
                         [{ step: 'Pour', after: 'Formwork' }]);
});

test('a proposal with no hints suggests no order', () => {
  assert.deepStrictEqual(suggestedOrder(GOOD), []);
  assert.deepStrictEqual(suggestedOrder(null), []);
});

/* ---- coverage ------------------------------------------------------------ */

test('steps that cover most of the parent are accepted', () => {
  assert.strictEqual(MIN_COVERAGE, 0.8);
  const r = validateProposal(TASK, { steps: [{ name: 'A', duration_days: 4 },
                                             { name: 'B', duration_days: 4 }] });
  assert.strictEqual(r.ok, true);  // 8/10
});

test('steps that cover almost none of it are refused', () => {
  const r = validateProposal(TASK, { steps: [{ name: 'A', duration_days: 1 },
                                             { name: 'B', duration_days: 1 }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /Most of the work is missing/);
});

test('steps that overrun the parent are refused, not truncated', () => {
  const r = validateProposal(TASK, { steps: [{ name: 'A', duration_days: 9 },
                                             { name: 'B', duration_days: 9 }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /add up to 18 days/);
});

/* ---- nothing is coerced -------------------------------------------------- */

test('a step with no duration refuses the whole proposal', () => {
  const r = validateProposal(TASK, { steps: [{ name: 'A' },
                                             { name: 'B', duration_days: 5 }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /no usable duration/);
});

test('a fractional or negative duration is not rounded into shape', () => {
  for (const d of [2.5, -3, 0]) {
    const r = validateProposal(TASK, { steps: [{ name: 'A', duration_days: d },
                                               { name: 'B', duration_days: 5 }] });
    assert.strictEqual(r.ok, false, String(d));
  }
});

test('a step with no name refuses the proposal', () => {
  const r = validateProposal(TASK, { steps: [{ duration_days: 5 },
                                             { name: 'B', duration_days: 5 }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /has no name/);
});

test('duplicate step names are refused', () => {
  /* Two indistinguishable rows on the Gantt, and two indistinguishable
     entries on somebody's to-do list. */
  const r = validateProposal(TASK, { steps: [{ name: 'Pour', duration_days: 5 },
                                             { name: 'pour', duration_days: 5 }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /Duplicate step/);
});

/* ---- shape --------------------------------------------------------------- */

test('a single step is not a breakdown', () => {
  const r = validateProposal(TASK, { steps: [{ name: 'A', duration_days: 10 }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /single step/);
});

test('too many steps is refused as detail nobody asked for', () => {
  const steps = Array.from({ length: MAX_STEPS + 1 },
    (_, i) => ({ name: 'S' + i, duration_days: 1 }));
  const r = validateProposal(TASK, { steps });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /detail nobody asked for/);
});

test('an empty or absent proposal is refused, not treated as zero steps', () => {
  assert.strictEqual(validateProposal(TASK, { steps: [] }).ok, false);
  assert.strictEqual(validateProposal(TASK, null).ok, false);
});

test('an undated heading has nothing to break down', () => {
  const header = { task_id: 'G1', name: 'Foundations' };
  const r = validateProposal(header, GOOD);
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /heading/i);
});

test('a failed proposal returns no children at all', () => {
  /* Half a plan is the dangerous shape — a caller that checks `children`
     rather than `ok` must get nothing to write. */
  assert.deepStrictEqual(validateProposal(TASK, { steps: [] }).children, []);
});

/* ---- both task shapes ---------------------------------------------------- */

test('a document-shaped task is accepted too', () => {
  /* GET /programme returns { task_id, start, end }; the window endpoint
     returns start_date/end_date. Handling one and not the other is the bug
     programme-mentions shipped with. */
  const doc = { task_id: 'T-003', name: 'Pour concrete',
                start: '2026-04-01', end: '2026-04-10' };
  const r = validateProposal(doc, GOOD);
  assert.strictEqual(r.ok, true, r.errors.join(' '));
  assert.strictEqual(r.children[0].start_date, '2026-04-01');
});
