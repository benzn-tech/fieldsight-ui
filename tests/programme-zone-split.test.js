'use strict';

/*
 * Splitting one contract task into zones.
 *
 * The assertion this file exists for is the first one: a zone split must NOT
 * divide the parent's dates by default. Five zones handed to five site
 * managers run at the same time — that is what the five managers are for —
 * and dividing the span invents a sequence nobody stated, on real people's
 * dates. The same spec forbids that move for AI-generated breakdowns; it is
 * the same hazard here with a friendlier name.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  planZoneSplit, overrunDays,
} = require('../scripts/api/programme-zone-split.js');

const TASK = {
  id: 'uuid-a', source_task_id: 'A1020', name: 'Pour concrete',
  start_date: '2026-04-01', end_date: '2026-04-10', duration_days: 10,
};

const ZONES = ['Level 1', 'Level 2', 'Level 3'];

/* ---- the default ---------------------------------------------------------- */

test('every zone inherits the full contract span by default', () => {
  const r = planZoneSplit(TASK, { zones: ZONES });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.children.length, 3);
  for (const c of r.children) {
    assert.strictEqual(c.start_date, '2026-04-01');
    assert.strictEqual(c.end_date, '2026-04-10');
  }
});

test('the parent is never mutated', () => {
  const before = JSON.stringify(TASK);
  planZoneSplit(TASK, { zones: ZONES, distribute: 'sequential' });
  assert.strictEqual(JSON.stringify(TASK), before);
});

test('children are local, so they survive the next import', () => {
  const r = planZoneSplit(TASK, { zones: ZONES });
  for (const c of r.children) assert.strictEqual(c.origin, 'local');
});

test('children start unstarted rather than inheriting the parent progress', () => {
  const r = planZoneSplit(
    Object.assign({}, TASK, { progress_pct: 60, status: 'in_progress' }),
    { zones: ZONES });
  for (const c of r.children) {
    assert.strictEqual(c.progress_pct, 0);
    assert.strictEqual(c.status, 'not_started');
  }
});

test('the zone is carried as free text, exactly as typed', () => {
  const r = planZoneSplit(TASK, { zones: ['Grid A-E', 'Grid F-K'] });
  assert.deepStrictEqual(r.children.map(c => c.zone), ['Grid A-E', 'Grid F-K']);
});

test('names are readable on the Gantt without opening anything', () => {
  const r = planZoneSplit(TASK, { zones: ['Level 1'] });
  assert.strictEqual(r.children[0].name, 'Pour concrete — Level 1');
});

test('people are matched to zones positionally', () => {
  const r = planZoneSplit(TASK, { zones: ZONES, assignees: ['ben', 'sam', 'jo'] });
  assert.deepStrictEqual(r.children.map(c => c.assignee), ['ben', 'sam', 'jo']);
});

test('no assignees at all is fine — allocation can come later', () => {
  const r = planZoneSplit(TASK, { zones: ZONES });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.children.map(c => c.assignee), [null, null, null]);
});

/* ---- sequential, when it is actually asked for --------------------------- */

test('sequential division covers the span with no gap and no overlap', () => {
  const r = planZoneSplit(TASK, { zones: ZONES, distribute: 'sequential' });
  assert.deepStrictEqual(r.children.map(c => [c.start_date, c.end_date]), [
    ['2026-04-01', '2026-04-04'],
    ['2026-04-05', '2026-04-07'],
    ['2026-04-08', '2026-04-10'],
  ]);
});

test('the remainder goes to the earliest slices, not the last', () => {
  /* 10 days across 3 is 4/3/3. The tail absorbs slippage, so leaving it
     thinnest is the wrong way round. */
  const r = planZoneSplit(TASK, { zones: ZONES, distribute: 'sequential' });
  assert.deepStrictEqual(r.children.map(c => c.duration_days), [4, 3, 3]);
});

test('sequential durations sum to the parent duration exactly', () => {
  const r = planZoneSplit(TASK, { zones: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
                                  distribute: 'sequential' });
  assert.strictEqual(r.children.reduce((n, c) => n + c.duration_days, 0), 10);
});

test('a task shorter than its zone count cannot be divided sequentially', () => {
  /* Three days, five zones. Silently producing zero-day or overlapping
     children would be worse than saying so. */
  const short = Object.assign({}, TASK, { end_date: '2026-04-03' });
  const r = planZoneSplit(short, { zones: ['a', 'b', 'c', 'd', 'e'],
                                   distribute: 'sequential' });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /parallel/i);
});

test('the same task splits fine in parallel', () => {
  /* The point of the message above: parallel is always available. */
  const short = Object.assign({}, TASK, { end_date: '2026-04-03' });
  const r = planZoneSplit(short, { zones: ['a', 'b', 'c', 'd', 'e'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.children.length, 5);
});

/* ---- what it refuses ----------------------------------------------------- */

test('a structural heading has nothing to divide', () => {
  /* Undated means WBS header — the same rule programme_snapshot uses to
     split parents from leaves. Dated children under an undated parent read
     as a schedule nobody wrote. */
  const header = { id: 'uuid-g', source_task_id: 'G1', name: 'Foundations' };
  const r = planZoneSplit(header, { zones: ZONES });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /heading/i);
});

test('duplicate zones are rejected rather than merged', () => {
  /* Merging would drop one manager's allocation with no trace. */
  const r = planZoneSplit(TASK, { zones: ['Level 1', 'Level 1'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /Duplicate zone: Level 1/);
});

test('duplicate detection ignores case and surrounding space', () => {
  const r = planZoneSplit(TASK, { zones: ['Level 1', ' level 1 '] });
  assert.strictEqual(r.ok, false);
});

test('a blank zone name is rejected', () => {
  const r = planZoneSplit(TASK, { zones: ['Level 1', '   '] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /needs a name/i);
});

test('no zones at all is rejected', () => {
  assert.strictEqual(planZoneSplit(TASK, { zones: [] }).ok, false);
});

test('a partial assignee list is rejected rather than half-allocated', () => {
  /* Three zones and two people: which zone goes unowned is a decision, not
     something to guess. */
  const r = planZoneSplit(TASK, { zones: ZONES, assignees: ['ben', 'sam'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /one person per zone/i);
});

test('a failed plan returns no children at all', () => {
  /* Half a plan is the dangerous shape — a caller that checks `children`
     rather than `ok` must get nothing to write. */
  const r = planZoneSplit(TASK, { zones: ['a', 'a'] });
  assert.deepStrictEqual(r.children, []);
});

/* ---- contract overrun ---------------------------------------------------- */

test('a split that runs past the contract end reports the overrun', () => {
  /* The parent is not recomputed from its children (Project 1 §5), so this
     divergence has to be surfaced rather than silently moving the deadline. */
  const r = planZoneSplit(TASK, { zones: ZONES });
  r.children[2].end_date = '2026-04-15';
  assert.strictEqual(overrunDays(TASK, r.children), 5);
});

test('a split inside the contract dates has no overrun', () => {
  const r = planZoneSplit(TASK, { zones: ZONES });
  assert.strictEqual(overrunDays(TASK, r.children), 0);
});

test('overrun on an undated parent is zero rather than NaN', () => {
  assert.strictEqual(overrunDays({ name: 'x' }, [{ end_date: '2026-04-15' }]), 0);
});

/* ---- both task shapes ---------------------------------------------------- */

test('a document-shaped task splits too', () => {
  /* GET /programme returns { task_id, start, end }; the window endpoint
     returns { id, source_task_id, start_date, end_date }. Handling only one
     works against live and does nothing in every mock — the exact bug the
     mentions module shipped with before its contract test. */
  const doc = { task_id: 'T-003', name: 'Pour concrete',
                start: '2026-04-01', end: '2026-04-10' };
  const r = planZoneSplit(doc, { zones: ZONES, distribute: 'sequential' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.children[0].start_date, '2026-04-01');
  assert.strictEqual(r.children[2].end_date, '2026-04-10');
});
