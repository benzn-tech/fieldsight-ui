'use strict';

/*
 * Linking site speech to programme tasks.
 *
 * Two things here are easy to get quietly wrong, and both have their own
 * block below:
 *
 *   - the document id. programme_progress_suggestions.task_id holds the
 *     file's Activity ID for imported rows and our UUID for local ones. A
 *     resolver that only handles the first works perfectly on every imported
 *     task and fails silently on exactly the AI-generated breakdown subtasks
 *     Project 3 creates.
 *
 *   - silence. "Nobody has mentioned this in three weeks" is the most useful
 *     thing this module can say and the easiest to say dishonestly, because
 *     an empty lookup looks identical whether nothing was said or nothing was
 *     loaded.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  docIdOf, indexByTask, indexByTopic, mentionSummary, silentTasks,
  SILENT_AFTER_DAYS,
} = require('../scripts/api/programme-mentions.js');

const ALL = { states: 'all', from: '2026-01-01', to: '2026-04-30' };
const TODAY = '2026-04-30';

function sugg(id, taskId, date, extra) {
  return Object.assign({
    id: id, task_id: taskId, topic_id: 'topic-' + id, report_date: date,
    topic_title: 'Slab', suggested_progress: 50, state: 'pending',
  }, extra || {});
}

function task(id, extra) {
  return Object.assign({
    id: id, source_task_id: null, start_date: '2026-04-01',
    end_date: '2026-04-10', status: 'in_progress', progress_pct: 20,
  }, extra || {});
}

/* ---- the document id ----------------------------------------------------- */

test('an imported task is identified by its Activity ID', () => {
  assert.strictEqual(docIdOf(task('uuid-a', { source_task_id: 'A1020' })), 'A1020');
});

test('a local task is identified by its UUID', () => {
  /* The AI-generated breakdown subtasks. A resolver that only checked
     source_task_id would work on every imported task and fail on exactly
     these. */
  assert.strictEqual(docIdOf(task('uuid-local')), 'uuid-local');
});

test('an empty source id is treated as absent, not as an identifier', () => {
  /* CSV imports produce '' rather than null often enough that this is worth
     pinning: '' would index every such task under the same key. */
  assert.strictEqual(docIdOf(task('uuid-x', { source_task_id: '' })), 'uuid-x');
});

test('a numeric Activity ID is compared as a string', () => {
  /* The backend column is text; 1020 and '1020' must land in the same bucket
     or the lookup misses. */
  assert.strictEqual(docIdOf(task('u', { source_task_id: 1020 })), '1020');
});

test('a task with nothing to identify it returns null rather than "undefined"', () => {
  assert.strictEqual(docIdOf({}), null);
  assert.strictEqual(docIdOf(null), null);
});

/* ---- indexing ------------------------------------------------------------ */

test('mentions are grouped by task, newest first', () => {
  const idx = indexByTask([
    sugg('s1', 'A1020', '2026-04-01'),
    sugg('s2', 'A1020', '2026-04-20'),
    sugg('s3', 'A1030', '2026-04-05'),
  ]);
  assert.deepStrictEqual(idx['A1020'].map(s => s.id), ['s2', 's1']);
  assert.deepStrictEqual(idx['A1030'].map(s => s.id), ['s3']);
});

test('same-day mentions have a stable order rather than fetch order', () => {
  const a = indexByTask([sugg('s1', 'A', '2026-04-01'), sugg('s2', 'A', '2026-04-01')]);
  const b = indexByTask([sugg('s2', 'A', '2026-04-01'), sugg('s1', 'A', '2026-04-01')]);
  assert.deepStrictEqual(a['A'].map(s => s.id), b['A'].map(s => s.id));
});

test('mentions are grouped by topic for the report side', () => {
  const idx = indexByTopic([sugg('s1', 'A1020', '2026-04-01')]);
  assert.deepStrictEqual(idx['topic-s1'].map(s => s.task_id), ['A1020']);
});

test('a suggestion whose topic was superseded is dropped, not bucketed as null', () => {
  /* The backend sets topic_id NULL on ON DELETE SET NULL. Bucketing those
     under 'null' would render a phantom topic. */
  const idx = indexByTopic([
    sugg('s1', 'A1020', '2026-04-01', { topic_id: null }),
    sugg('s2', 'A1030', '2026-04-02'),
  ]);
  assert.deepStrictEqual(Object.keys(idx), ['topic-s2']);
});

/* ---- the summary --------------------------------------------------------- */

test('a mentioned task reports its newest mention and how long ago', () => {
  const idx = indexByTask([
    sugg('s1', 'A1020', '2026-04-10'), sugg('s2', 'A1020', '2026-04-25'),
  ]);
  const r = mentionSummary(task('u', { source_task_id: 'A1020' }), idx,
                           { today: TODAY, coverage: ALL });
  assert.strictEqual(r.status, 'mentioned');
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.latest.id, 's2');
  assert.strictEqual(r.daysSinceLastMention, 5);
});

test('a task with no mentions, over a fully loaded history, is silent', () => {
  const r = mentionSummary(task('u', { source_task_id: 'A1020' }), {},
                           { today: TODAY, coverage: ALL });
  assert.strictEqual(r.status, 'silent');
  assert.strictEqual(r.silentSince, '2026-04-09');   // 21 days back
});

/* ---- the dishonesty this module exists to prevent ------------------------ */

test('a pending-only fetch cannot report silence', () => {
  /* THE test. Confirming a suggestion moves it out of state=pending, so a
     caller that loaded only pending rows sees an empty lookup for every task
     whose mentions were all reviewed — the well-run ones. Reporting that as
     silence would light up the work going best. */
  const r = mentionSummary(task('u', { source_task_id: 'A1020' }), {},
                           { today: TODAY, coverage: { states: ['pending'] } });
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.reason, /reviewed/i);
});

test('a history that starts inside the silent window cannot report silence', () => {
  /* Loaded the last week, asked about the last three. The first fortnight is
     simply unknown. */
  const r = mentionSummary(task('u', { source_task_id: 'A1020' }), {}, {
    today: TODAY,
    coverage: { states: 'all', from: '2026-04-24', to: TODAY },
  });
  assert.strictEqual(r.status, 'unknown');
});

test('a history that stops before today cannot report silence', () => {
  const r = mentionSummary(task('u', { source_task_id: 'A1020' }), {}, {
    today: TODAY,
    coverage: { states: 'all', from: '2026-01-01', to: '2026-04-20' },
  });
  assert.strictEqual(r.status, 'unknown');
});

test('no coverage at all is unknown, never silent', () => {
  const r = mentionSummary(task('u'), {}, { today: TODAY });
  assert.strictEqual(r.status, 'unknown');
});

test('an open-ended coverage range covers silence', () => {
  /* from/to null means "everything there is" — the natural result of
     ?state=all with no date filter. */
  const r = mentionSummary(task('u', { source_task_id: 'A1020' }), {}, {
    today: TODAY, coverage: { states: 'all', from: null, to: null },
  });
  assert.strictEqual(r.status, 'silent');
});

/* ---- which silences are worth surfacing ---------------------------------- */

test('silent tasks are the started, unfinished, undiscussed ones', () => {
  const tasks = [
    task('t-started', { source_task_id: 'A1', start_date: '2026-04-01' }),
    task('t-future', { source_task_id: 'A2', start_date: '2026-06-01' }),
    task('t-done', { source_task_id: 'A3', status: 'completed' }),
    task('t-undated', { source_task_id: 'A4', start_date: null }),
  ];
  const got = silentTasks(tasks, {}, { today: TODAY, coverage: ALL });
  assert.deepStrictEqual(got.map(t => t.id), ['t-started']);
});

test('a task at 100% is not surfaced even if its status was never updated', () => {
  const tasks = [task('t', { source_task_id: 'A1', progress_pct: 100 })];
  assert.deepStrictEqual(silentTasks(tasks, {}, { today: TODAY, coverage: ALL }), []);
});

test('a mentioned task is not surfaced as silent', () => {
  const tasks = [task('t', { source_task_id: 'A1' })];
  const idx = indexByTask([sugg('s1', 'A1', '2026-04-28')]);
  assert.deepStrictEqual(silentTasks(tasks, idx, { today: TODAY, coverage: ALL }), []);
});

test('the oldest neglected work leads', () => {
  const tasks = [
    task('t-newer', { source_task_id: 'A1', start_date: '2026-04-20' }),
    task('t-older', { source_task_id: 'A2', start_date: '2026-02-01' }),
  ];
  const got = silentTasks(tasks, {}, { today: TODAY, coverage: ALL });
  assert.deepStrictEqual(got.map(t => t.id), ['t-older', 't-newer']);
});

test('nothing is surfaced when coverage cannot support the claim', () => {
  /* silentTasks must inherit mentionSummary's honesty rather than routing
     around it — an empty list is the right answer when we cannot tell. */
  const tasks = [task('t', { source_task_id: 'A1' })];
  const got = silentTasks(tasks, {}, { today: TODAY, coverage: { states: ['pending'] } });
  assert.deepStrictEqual(got, []);
});

test('the silence threshold is three weeks, not one', () => {
  /* A fortnight of quiet on a multi-month programme is normal, and an alert
     that fires on normal is one people learn to ignore. */
  assert.strictEqual(SILENT_AFTER_DAYS, 21);
});
