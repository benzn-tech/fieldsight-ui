'use strict';

/*
 * Measuring how far a programme has been developed.
 *
 * The module deliberately has no verdict in it — no `isMature`, no score, no
 * threshold — because only one end of that boundary has ever been measured.
 * So the tests that carry weight are not "does it classify correctly"; they
 * are:
 *
 *   it refuses rather than invents. A programme with no dates reports
 *   `status: 'unknown'`, never a median of 0 — which would read as "every
 *   task is instantaneous", the most misleading possible summary of a file
 *   we could not measure.
 *
 *   it reads BOTH shapes this codebase hands its programme modules.
 *   Twenty-two tests once passed on invented objects while the module under
 *   them could read only one of the two real shapes.
 *
 *   the denominators are the ones claimed. An undated leaf is not a short
 *   one; folding it into the duration denominator reports a finer programme
 *   than the file describes.
 */
const test = require('node:test');
const assert = require('node:assert');

const { measure, format } = require('../scripts/api/programme-maturity.js');

/* A leaf as `programme-import`'s cleanXMLRow actually emits one. */
function leaf(id, wbs, start, end, deps) {
  return {
    task_id: id, wbs: wbs, name: 'task ' + id,
    start: start, end: end,
    duration_days: start && end
      ? Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1
      : null,
    depends_on: deps || [], status: 'not_started',
  };
}

function group(id, wbs) {
  return { task_id: id, wbs: wbs, name: 'group ' + id, start: '', end: '',
           duration_days: null, depends_on: [], status: 'group' };
}

/* ---- it refuses rather than invents -------------------------------------- */

test('a programme whose leaves carry no dates reports unknown, not zero', () => {
  const r = measure({
    parents: [group('G1', '1')],
    leaves: [leaf('T-1', '1.1', '', ''), leaf('T-2', '1.2', '', '')],
  });
  assert.strictEqual(r.status, 'measured');
  assert.strictEqual(r.leafDuration.status, 'unknown');
  assert.strictEqual(r.leafDuration.medianDays, null);
  assert.strictEqual(r.leafDuration.longShare, null);
  assert.strictEqual(r.leafDuration.undated, 2);
});

test('rows with no WBS are excluded from depth and counted, not treated as depth 1', () => {
  const r = measure({ parents: [], leaves: [leaf('T-1', '', '2026-01-01', '2026-01-05')] });
  assert.strictEqual(r.depth.status, 'unknown');
  assert.strictEqual(r.depth.max, null);
  assert.strictEqual(r.depth.unplaced, 1);
});

test('an empty programme is empty, not a programme of zero-day tasks', () => {
  const r = measure({ parents: [], leaves: [] });
  assert.strictEqual(r.status, 'empty');
  assert.strictEqual(r.leafDuration.status, 'unknown');
  assert.strictEqual(r.dependencies.status, 'unknown');
});

test('a non-programme is refused with a reason, not measured as empty', () => {
  assert.strictEqual(measure(null).status, 'not_a_programme');
  assert.strictEqual(measure(42).status, 'not_a_programme');
  assert.strictEqual(measure({ nope: 1 }).status, 'not_a_programme');
  assert.match(measure(null).reason, /Expected/);
});

/* ---- both real input shapes ---------------------------------------------- */

test('reads the { parents, leaves } shape programme-import returns', () => {
  const r = measure({
    parents: [group('G1', '1')],
    leaves: [leaf('T-1', '1.1', '2026-01-01', '2026-01-07')],
  });
  assert.deepStrictEqual(r.counts, { tasks: 2, parents: 1, leaves: 1 });
});

test('reads the { tasks } shape GET /programme returns, grouping on status', () => {
  const r = measure({ tasks: [
    group('G1', '1'),
    leaf('T-1', '1.1', '2026-01-01', '2026-01-07'),
    leaf('T-2', '1.2', '2026-01-08', '2026-01-14'),
  ] });
  assert.deepStrictEqual(r.counts, { tasks: 3, parents: 1, leaves: 2 });
  assert.strictEqual(r.leafDuration.medianDays, 7);
});

test('a bare array is read as tasks', () => {
  const r = measure([group('G1', '1'), leaf('T-1', '1.1', '2026-01-01', '2026-01-07')]);
  assert.strictEqual(r.counts.leaves, 1);
});

test('a row carrying only dates measures the same as one carrying duration_days', () => {
  const withDuration = { task_id: 'A', wbs: '1.1', duration_days: 7, depends_on: [] };
  const withDates    = { task_id: 'B', wbs: '1.2', start: '2026-01-01', end: '2026-01-07', depends_on: [] };
  const r = measure({ parents: [], leaves: [withDuration, withDates] });
  assert.strictEqual(r.leafDuration.medianDays, 7);
  assert.strictEqual(r.leafDuration.undated, 0);
});

/* ---- the denominators are the ones claimed -------------------------------- */

test('the long-leaf share is over measurable leaves, and the undated ones are shown', () => {
  const r = measure({ parents: [], leaves: [
    leaf('T-1', '1.1', '2026-01-01', '2026-01-20'),  /* 20 days */
    leaf('T-2', '1.2', '2026-01-01', '2026-01-03'),  /*  3 days */
    leaf('T-3', '1.3', '', ''),                      /* undated */
  ] });
  /* 1 of the 2 measurable leaves, not 1 of 3. */
  assert.strictEqual(r.leafDuration.longCount, 1);
  assert.strictEqual(r.leafDuration.longShare, 0.5);
  assert.strictEqual(r.leafDuration.undated, 1);
});

test('the long-leaf bucket is a parameter, because it is a bucket and not a boundary', () => {
  const p = { parents: [], leaves: [leaf('T-1', '1.1', '2026-01-01', '2026-01-10')] };
  assert.strictEqual(measure(p).leafDuration.longCount, 0);
  assert.strictEqual(measure(p, { longLeafDays: 10 }).leafDuration.longCount, 1);
  assert.strictEqual(measure(p, { longLeafDays: 10 }).leafDuration.longLeafDays, 10);
});

test('depth is measured over every row, not only leaves', () => {
  const r = measure({
    parents: [group('G1', '1'), group('G2', '1.1'), group('G3', '1.1.1')],
    leaves:  [leaf('T-1', '1.1.1.1', '2026-01-01', '2026-01-02')],
  });
  assert.strictEqual(r.depth.max, 4);
  assert.deepStrictEqual(r.depth.histogram, { 1: 1, 2: 1, 3: 1, 4: 1 });
});

/* ---- dependencies --------------------------------------------------------- */

test('coverage counts a leaf on an edge in either direction', () => {
  const r = measure({ parents: [], leaves: [
    leaf('T-1', '1.1', '2026-01-01', '2026-01-02'),                 /* predecessor only */
    leaf('T-2', '1.2', '2026-01-03', '2026-01-04', ['T-1']),        /* successor */
    leaf('T-3', '1.3', '2026-01-05', '2026-01-06'),                 /* sequenced by nobody */
  ] });
  assert.strictEqual(r.dependencies.edges, 1);
  assert.strictEqual(r.dependencies.linkedLeaves, 2);
  assert.strictEqual(Math.round(r.dependencies.leafCoverage * 100), 67);
});

test('a depends_on naming a task absent from the file is reported, never silently dropped', () => {
  /* This number was the first visible symptom of the truncated-id collision
     (ui#191). A measurement that discarded it would have hidden the bug. */
  const r = measure({ parents: [], leaves: [
    leaf('T-1', '1.1', '2026-01-01', '2026-01-02', ['T-999']),
  ] });
  assert.strictEqual(r.dependencies.danglingRefs, 1);
  assert.strictEqual(r.dependencies.edges, 0);
  assert.strictEqual(r.dependencies.linkedLeaves, 0);
});

test('a programme of only summary bars has unknown dependency coverage, not 0%', () => {
  const r = measure({ parents: [group('G1', '1')], leaves: [] });
  assert.strictEqual(r.dependencies.status, 'unknown');
  assert.strictEqual(r.dependencies.leafCoverage, null);
});

/* ---- the rendering keeps the refusals visible ----------------------------- */

test('format prints unknown where a signal is unknown, never a stand-in number', () => {
  const out = format(measure({ parents: [], leaves: [leaf('T-1', '1.1', '', '')] }));
  assert.match(out, /median leaf duration\s+unknown days/);
  assert.match(out, /undated leaves\s+1/);
  assert.doesNotMatch(out, /median leaf duration\s+0 days/);
});

test('format survives the refusal cases without throwing', () => {
  assert.match(format(measure(null)), /not a programme/);
  assert.match(format(measure({ parents: [], leaves: [] })), /empty programme/);
});

/* ---- the module has no verdict in it --------------------------------------
   Asserted rather than trusted. The plan is explicit that a classifier
   anchored on one measured end and a guessed other end would look
   quantitative and be arbitrary, and this is the test that notices if one
   quietly appears. */

test('measure returns no maturity verdict and no threshold', () => {
  const r = measure({ parents: [group('G1', '1')], leaves: [
    leaf('T-1', '1.1', '2026-01-01', '2026-01-07', []),
  ] });
  const keys = JSON.stringify(r);
  assert.doesNotMatch(keys, /isMature|maturity|"early"|"mature"|score/i);
  const api = require('../scripts/api/programme-maturity.js');
  assert.strictEqual(typeof api.classify, 'undefined');
  assert.deepStrictEqual(Object.keys(api).sort(),
    ['DEFAULT_LONG_LEAF_DAYS', 'format', 'measure']);
});
