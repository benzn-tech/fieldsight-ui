'use strict';

/*
 * My Work — how the window's tasks are grouped.
 *
 * Today answers "what do I do today" and stops at 3 days out. My Work answers
 * "what do I have coming" across the whole selected window, so it needs
 * coarser buckets than Today's — week-relative, not day-relative, because at
 * a 6-week horizon "due in 19 days" is noise and "the week of 18 May" is not.
 *
 * Overdue stays its own bucket for the same reason it does on Today: it is
 * the one thing worth interrupting for, and it must not be buried mid-list
 * under a date heading.
 */
const test = require('node:test');
const assert = require('node:assert');

const { groupMyWork } = require('../scripts/api/my-work-grouping.js');

const TODAY = '2026-05-13';   // a Wednesday

function t(id, end, status) {
  return { task_id: id, end_date: end, status: status || 'not_started' };
}

test('overdue work is its own bucket, ahead of everything', () => {
  const g = groupMyWork([t('late', '2026-05-01'), t('soon', '2026-05-14')], TODAY);
  assert.strictEqual(g[0].key, 'overdue');
  assert.deepStrictEqual(g[0].tasks.map((x) => x.task_id), ['late']);
});

test('the overdue bucket is omitted when nothing is overdue', () => {
  /* Same rule as Today: a permanent "0 overdue" heading trains people to
     skip the section that matters most. */
  const g = groupMyWork([t('soon', '2026-05-14')], TODAY);
  assert.ok(!g.some((b) => b.key === 'overdue'));
});

test('remaining work is bucketed by week, not by day', () => {
  const g = groupMyWork([
    t('a', '2026-05-14'),        // this week
    t('b', '2026-05-20'),        // next week
    t('c', '2026-06-10'),        // four weeks out
  ], TODAY);
  const keys = g.map((b) => b.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'buckets are distinct');
  assert.strictEqual(keys.length, 3);
});

test('two tasks in the same week share a bucket', () => {
  const g = groupMyWork([t('a', '2026-05-14'), t('b', '2026-05-15')], TODAY);
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual(g[0].tasks.map((x) => x.task_id), ['a', 'b']);
});

test('weeks are ordered soonest first', () => {
  const g = groupMyWork([t('far', '2026-06-10'), t('near', '2026-05-14')], TODAY);
  assert.deepStrictEqual(g.map((b) => b.tasks[0].task_id), ['near', 'far']);
});

test('the current week is labelled "This week"', () => {
  const g = groupMyWork([t('a', '2026-05-14')], TODAY);
  assert.strictEqual(g[0].label, 'This week');
});

test('the following week is labelled "Next week"', () => {
  const g = groupMyWork([t('a', '2026-05-20')], TODAY);
  assert.strictEqual(g[0].label, 'Next week');
});

test('weeks beyond next are labelled by their Monday', () => {
  /* "Week of 1 Jun" survives a glance; "in 19 days" needs arithmetic. */
  const g = groupMyWork([t('a', '2026-06-03')], TODAY);
  assert.match(g[0].label, /Week of 1 Jun/);
});

test('closed work is excluded entirely', () => {
  const g = groupMyWork([
    t('done', '2026-05-01', 'completed'),
    t('cancelled', '2026-05-02', 'cancelled'),
  ], TODAY);
  assert.deepStrictEqual(g, []);
});

test('a blocked task past its date is still overdue', () => {
  const g = groupMyWork([t('stuck', '2026-05-01', 'blocked')], TODAY);
  assert.strictEqual(g[0].key, 'overdue');
});

test('undated work gets its own bucket rather than being dropped', () => {
  /* On Today an undated task is correctly invisible — it cannot be due
     today. Here it is still the caller's work and hiding it would mean My
     Work is not actually all of my work. */
  const g = groupMyWork([t('open', null)], TODAY);
  assert.strictEqual(g[g.length - 1].key, 'undated');
});

test('undated work sorts last, after every dated week', () => {
  const g = groupMyWork([t('undated', null), t('soon', '2026-05-14')], TODAY);
  assert.strictEqual(g[g.length - 1].key, 'undated');
});

test('overdue is sorted oldest first within its bucket', () => {
  const g = groupMyWork([
    t('recent', '2026-05-11'), t('ancient', '2026-01-05'),
  ], TODAY);
  assert.deepStrictEqual(g[0].tasks.map((x) => x.task_id), ['ancient', 'recent']);
});

test('an empty input produces no buckets, not empty ones', () => {
  assert.deepStrictEqual(groupMyWork([], TODAY), []);
  assert.deepStrictEqual(groupMyWork(null, TODAY), []);
});

test('grouping does not reorder the caller\'s array', () => {
  const input = [t('b', '2026-05-20'), t('a', '2026-05-14')];
  groupMyWork(input, TODAY);
  assert.deepStrictEqual(input.map((x) => x.task_id), ['b', 'a']);
});
