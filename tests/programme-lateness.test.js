'use strict';

/*
 * "落后多少天" — the number the user called out as the important one.
 *
 * It is also the easiest thing here to get quietly wrong, because there is
 * always SOME number available. Three ways to be dishonest:
 *
 *   - measuring against the first import when nobody set a baseline, and
 *     calling that "the plan"
 *   - reporting lateness on a programme with no dependencies, where there is
 *     no projected finish at all — only a latest end date
 *   - counting finished work as late because its dates have passed
 *
 * Each has a test below. The module returns a status rather than a bare
 * number so a caller cannot accidentally render "0 days late" for "we cannot
 * tell".
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  programmeLateness, overallProgress,
} = require('../scripts/api/programme-lateness.js');

function t(id, start, end, pct, status) {
  return { task_id: id, start: start, end: end,
           duration_days: 10, progress_pct: pct || 0,
           status: status || 'not_started' };
}

const CURRENT = [t('A', '2026-04-01', '2026-04-10'), t('B', '2026-04-11', '2026-05-04')];
const BASELINE = [t('A', '2026-04-01', '2026-04-10'), t('B', '2026-04-11', '2026-04-20')];

/* ---- the honest-failure states ------------------------------------------ */

test('no baseline reports that, rather than measuring against the first import', () => {
  const r = programmeLateness({ tasks: CURRENT, baselineTasks: null, tier: 1 });
  assert.strictEqual(r.status, 'no_baseline');
  assert.strictEqual(r.days, null);
  assert.match(r.message, /baseline/i);
});

test('an empty baseline set is the same as none', () => {
  const r = programmeLateness({ tasks: CURRENT, baselineTasks: [], tier: 1 });
  assert.strictEqual(r.status, 'no_baseline');
});

test('a tier-2 programme reports unavailable, never a number', () => {
  /* Without dependencies there is no projected finish — only the latest end
     date — and the difference between those is what makes the number mean
     anything. */
  const r = programmeLateness({ tasks: CURRENT, baselineTasks: BASELINE, tier: 2 });
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.days, null);
  assert.match(r.message, /dependenc/i);
});

test('an empty programme reports unavailable rather than zero days late', () => {
  const r = programmeLateness({ tasks: [], baselineTasks: BASELINE, tier: 1 });
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.days, null);
});

/* ---- the number itself --------------------------------------------------- */

test('lateness is projected finish minus baseline finish', () => {
  const r = programmeLateness({ tasks: CURRENT, baselineTasks: BASELINE, tier: 1 });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.projectedFinish, '2026-05-04');
  assert.strictEqual(r.baselineFinish, '2026-04-20');
  assert.strictEqual(r.days, 14);
});

test('finishing early reports a NEGATIVE number, not zero', () => {
  /* Ahead of programme is information a PM wants; clamping it to zero would
     hide the only good news the metric can carry. */
  const early = [t('A', '2026-04-01', '2026-04-10'), t('B', '2026-04-11', '2026-04-15')];
  const r = programmeLateness({ tasks: early, baselineTasks: BASELINE, tier: 1 });
  assert.strictEqual(r.days, -5);
  assert.strictEqual(r.status, 'ok');
});

test('on programme reports exactly zero', () => {
  const r = programmeLateness({ tasks: BASELINE, baselineTasks: BASELINE, tier: 1 });
  assert.strictEqual(r.days, 0);
});

test('completed tasks still count toward the projected finish', () => {
  /* The finish date is when the work ends, not when the unfinished work
     ends. Excluding completed tasks would make a nearly-done programme
     appear to finish early. */
  const done = [t('A', '2026-04-01', '2026-05-04', 100, 'completed')];
  const r = programmeLateness({ tasks: done, baselineTasks: BASELINE, tier: 1 });
  assert.strictEqual(r.projectedFinish, '2026-05-04');
});

test('undated tasks do not break the finish calculation', () => {
  const mixed = CURRENT.concat([t('C', null, null)]);
  const r = programmeLateness({ tasks: mixed, baselineTasks: BASELINE, tier: 1 });
  assert.strictEqual(r.projectedFinish, '2026-05-04');
});

test('the baseline version is echoed back so the UI can name it', () => {
  /* "14 days later than baseline" is unanswerable without "which baseline". */
  const r = programmeLateness({ tasks: CURRENT, baselineTasks: BASELINE,
                                tier: 1, baselineVersion: 3 });
  assert.strictEqual(r.baselineVersion, 3);
});

/* ---- overall progress ---------------------------------------------------- */

test('progress is weighted by duration, not by task count', () => {
  /* A 40-day task at 0% and a 1-day task at 100% is not "50% done". */
  const tasks = [
    { task_id: 'big', duration_days: 40, progress_pct: 0 },
    { task_id: 'small', duration_days: 1, progress_pct: 100 },
  ];
  assert.strictEqual(overallProgress(tasks), 2);
});

test('progress of an empty programme is zero, not NaN', () => {
  assert.strictEqual(overallProgress([]), 0);
  assert.strictEqual(overallProgress(null), 0);
});

test('tasks with no duration do not divide by zero', () => {
  const tasks = [{ task_id: 'a', duration_days: 0, progress_pct: 50 }];
  assert.strictEqual(overallProgress(tasks), 0);
});

test('a fully complete programme is 100, not 99 from rounding', () => {
  const tasks = [
    { task_id: 'a', duration_days: 3, progress_pct: 100 },
    { task_id: 'b', duration_days: 7, progress_pct: 100 },
  ];
  assert.strictEqual(overallProgress(tasks), 100);
});
