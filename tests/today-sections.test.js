'use strict';

/*
 * Today's section model.
 *
 * Today answers "what do I do today". Anything else assigned to the caller
 * lives in My Work — a Today that lists everything stops being read at all,
 * which is the failure this is meant to prevent. The single exception is
 * overdue-and-open work, the one thing worth interrupting for.
 *
 * The properties worth pinning are the boundaries (a task belongs to exactly
 * one bucket, and "soon" ends where My Work begins) and the closed-status
 * handling: a completed task with a date in the past is not overdue, and
 * treating it as such would put a permanent red section in front of people
 * until they learned to ignore the colour.
 */
const test = require('node:test');
const assert = require('node:assert');

const { bucketTodayTasks, SOON_DAYS } = require('../scripts/api/today-sections.js');

const TODAY = '2026-05-01';

function t(id, end, status) {
  return { task_id: id, end: end, status: status || 'not_started' };
}

/* ---- overdue ------------------------------------------------------------- */

test('overdue and still open comes back in its own bucket', () => {
  const b = bucketTodayTasks([t('late', '2026-04-20')], TODAY);
  assert.deepStrictEqual(b.overdue.map((x) => x.task_id), ['late']);
});

test('overdue but completed is not overdue', () => {
  const b = bucketTodayTasks([t('done', '2026-04-20', 'completed')], TODAY);
  assert.strictEqual(b.overdue.length, 0);
  assert.strictEqual(b.today.length + b.soon.length, 0,
    'finished work belongs in no bucket');
});

test('overdue but cancelled is not overdue', () => {
  const b = bucketTodayTasks([t('gone', '2026-04-20', 'cancelled')], TODAY);
  assert.strictEqual(b.overdue.length, 0);
});

test('a blocked task past its date is still overdue', () => {
  /* Blocked is not closed. It is precisely the thing a PM needs to see. */
  const b = bucketTodayTasks([t('stuck', '2026-04-20', 'blocked')], TODAY);
  assert.deepStrictEqual(b.overdue.map((x) => x.task_id), ['stuck']);
});

test('overdue is sorted oldest first', () => {
  const b = bucketTodayTasks([
    t('recent', '2026-04-29'), t('ancient', '2026-01-05'), t('mid', '2026-03-01'),
  ], TODAY);
  assert.deepStrictEqual(b.overdue.map((x) => x.task_id),
    ['ancient', 'mid', 'recent']);
});

/* ---- today and soon ------------------------------------------------------ */

test('due today lands in today, not overdue', () => {
  const b = bucketTodayTasks([t('now', TODAY)], TODAY);
  assert.deepStrictEqual(b.today.map((x) => x.task_id), ['now']);
  assert.strictEqual(b.overdue.length, 0);
});

test('due tomorrow lands in soon', () => {
  const b = bucketTodayTasks([t('soon', '2026-05-02')], TODAY);
  assert.deepStrictEqual(b.soon.map((x) => x.task_id), ['soon']);
});

test('the last day of the soon window is still soon', () => {
  const last = '2026-05-0' + (1 + SOON_DAYS);
  const b = bucketTodayTasks([t('edge', last)], TODAY);
  assert.deepStrictEqual(b.soon.map((x) => x.task_id), ['edge']);
});

test('the day after the soon window belongs to My Work, not Today', () => {
  const past = '2026-05-0' + (2 + SOON_DAYS);
  const b = bucketTodayTasks([t('later', past)], TODAY);
  assert.strictEqual(b.overdue.length + b.today.length + b.soon.length, 0);
});

test('due far in the future appears in no Today bucket', () => {
  const b = bucketTodayTasks([t('later', '2026-09-20')], TODAY);
  assert.strictEqual(b.overdue.length + b.today.length + b.soon.length, 0);
});

/* ---- invariants ---------------------------------------------------------- */

test('a task appears in exactly one bucket', () => {
  const b = bucketTodayTasks(
    [t('a', '2026-04-20'), t('b', TODAY), t('c', '2026-05-03')], TODAY);
  const all = [].concat(b.overdue, b.today, b.soon).map((x) => x.task_id);
  assert.strictEqual(new Set(all).size, all.length);
  assert.strictEqual(all.length, 3);
});

test('a task with no due date is not overdue and not shown', () => {
  /* An undated task cannot be late. Showing it as overdue would make the
     red section permanent for any programme with open-ended work. */
  const b = bucketTodayTasks([t('undated', null)], TODAY);
  assert.strictEqual(b.overdue.length, 0);
  assert.strictEqual(b.today.length + b.soon.length, 0);
});

test('end_date is read as well as end', () => {
  /* The window endpoint returns Aurora column names; the legacy document
     uses `end`. One bucketing function serves both. */
  const b = bucketTodayTasks([{ task_id: 'x', end_date: '2026-04-20' }], TODAY);
  assert.deepStrictEqual(b.overdue.map((x) => x.task_id), ['x']);
});

test('an empty input produces three empty buckets, not undefined', () => {
  assert.deepStrictEqual(bucketTodayTasks([], TODAY),
    { overdue: [], today: [], soon: [] });
  assert.deepStrictEqual(bucketTodayTasks(null, TODAY),
    { overdue: [], today: [], soon: [] });
});

test('bucketing does not mutate or reorder the caller\'s array', () => {
  const input = [t('b', '2026-03-01'), t('a', '2026-01-01')];
  bucketTodayTasks(input, TODAY);
  assert.deepStrictEqual(input.map((x) => x.task_id), ['b', 'a'],
    'sorting overdue must not reorder the source list');
});
