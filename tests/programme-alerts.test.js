'use strict';

/*
 * The alerts route.
 *
 * Two things carry the weight here.
 *
 * The classifier must be NARROW. Real query logs run ~14:1 toward retrieval,
 * so the cost of matching too widely is stealing questions RAG answers well.
 * The routing spec's own labels are used as the fixture at the bottom of this
 * file, including the ones that must NOT match.
 *
 * "Nothing to worry about" must be unsayable when something could not be
 * checked. An alert set assembled from data that was not loaded is worse than
 * no answer, because reassurance is a claim.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  isAlertsQuestion, buildAlerts, overdueTasks, blockedTasks, notStartedButDue,
} = require('../scripts/api/programme-alerts.js');

const TODAY = '2026-05-01';

function t(id, extra) {
  return Object.assign({
    task_id: id, start: '2026-04-01', end: '2026-04-10',
    status: 'in_progress', progress_pct: 20,
  }, extra || {});
}

/* ---- the classifier ------------------------------------------------------ */

test('the question this route exists for', () => {
  assert.strictEqual(isAlertsQuestion('What should I worry about?'), true);
});

test('its ordinary phrasings match', () => {
  for (const q of [
    'anything I should be worried about?',
    'what are the risks',
    'is anything at risk?',
    'what needs my attention',
    'are we behind',
    'what problems do we have',
    'anything off track?',
  ]) assert.strictEqual(isAlertsQuestion(q), true, q);
});

test('a question about what was SAID goes to retrieval, not here', () => {
  /* "Were any risks flagged" contains "risks" and is still a question about
     speech. The report answers it far better than a list of task states. */
  for (const q of [
    'Were any risks flagged?',
    'did anyone mention any problems',
    'what did Ben say about the risks',
    'was anything raised about the crane',
  ]) assert.strictEqual(isAlertsQuestion(q), false, q);
});

test('the real logged questions do not get stolen from retrieval', () => {
  /* Verbatim from /aws/lambda/fieldsight-ask-agent. These are what people
     actually ask, and every one of them belongs to RAG. */
  for (const q of [
    'what is jack doing?',
    'What was decided?',
    'what this topic is about?',
    'What happened with the concrete?',
    'What was this training about?',
    'what ip issue was talking?',
    'what happened on 9th feb?',
    "does today's door issue relevant with any previous issue?",
    'What were the main action items?',
  ]) assert.strictEqual(isAlertsQuestion(q), false, q);
});

test('the routing spec TABLE rows are not stolen either', () => {
  for (const q of [
    'What am I supposed to do this week?',
    "What's on Level 3 next week?",
    'When does the slab pour finish?',
    "What's happening tomorrow?",
  ]) assert.strictEqual(isAlertsQuestion(q), false, q);
});

test('an empty or absent question matches nothing', () => {
  assert.strictEqual(isAlertsQuestion(''), false);
  assert.strictEqual(isAlertsQuestion(null), false);
  assert.strictEqual(isAlertsQuestion('   '), false);
});

/* ---- the signals --------------------------------------------------------- */

test('overdue is past the end date and unfinished', () => {
  const tasks = [
    t('a', { end: '2026-04-10' }),
    t('b', { end: '2026-06-01' }),
    t('c', { end: '2026-04-10', status: 'completed' }),
    t('d', { end: '2026-04-10', progress_pct: 100 }),
  ];
  assert.deepStrictEqual(overdueTasks(tasks, TODAY).map(x => x.task_id), ['a']);
});

test('overdue leads with the longest overdue', () => {
  const tasks = [t('recent', { end: '2026-04-28' }), t('old', { end: '2026-02-01' })];
  assert.deepStrictEqual(overdueTasks(tasks, TODAY).map(x => x.task_id),
                         ['old', 'recent']);
});

test('without a date, nothing date-based is claimed', () => {
  assert.deepStrictEqual(overdueTasks([t('a')], null), []);
  assert.deepStrictEqual(notStartedButDue([t('a')], null), []);
});

test('blocked excludes finished work', () => {
  const tasks = [
    t('a', { status: 'blocked' }),
    t('b', { status: 'blocked', progress_pct: 100 }),
  ];
  assert.deepStrictEqual(blockedTasks(tasks).map(x => x.task_id), ['a']);
});

test('a task due to have started but not started is surfaced', () => {
  const tasks = [
    t('a', { start: '2026-04-01', status: 'not_started' }),
    t('b', { start: '2026-06-01', status: 'not_started' }),
  ];
  assert.deepStrictEqual(notStartedButDue(tasks, TODAY).map(x => x.task_id), ['a']);
});

/* ---- assembly, and the refusals ------------------------------------------ */

test('sections are ordered worst first', () => {
  const r = buildAlerts({
    tasks: [t('o', { end: '2026-04-01' }), t('b', { status: 'blocked' }),
            t('n', { start: '2026-04-01', status: 'not_started' })],
    today: TODAY, silent: [],
    lateness: { status: 'ok', days: 12, projectedFinish: '2026-06-01',
                baselineFinish: '2026-05-20' },
  });
  assert.deepStrictEqual(r.sections.map(s => s.severity),
                         ['high', 'high', 'high', 'medium']);
  assert.strictEqual(r.sections[0].key, 'lateness');
});

test('being ahead of baseline is not an alert', () => {
  const r = buildAlerts({
    tasks: [], today: TODAY, silent: [],
    lateness: { status: 'ok', days: -4 },
  });
  assert.strictEqual(r.sections.length, 0);
  assert.deepStrictEqual(r.unavailable, []);
  assert.strictEqual(r.empty, true);
});

test('THE refusal: no baseline is reported, not passed over', () => {
  /* Omitting it silently would let the answer imply the programme is on
     time. */
  const r = buildAlerts({
    tasks: [], today: TODAY, silent: [],
    lateness: { status: 'no_baseline', days: null, message: 'No baseline set.' },
  });
  assert.strictEqual(r.empty, false);
  assert.match(r.unavailable.join(' '), /baseline/i);
});

test('unestablished silence coverage is reported, not read as "none"', () => {
  /* silentTasks refuses to guess without state:"all" coverage. Passing null
     preserves that; flattening it to [] would turn "we do not know" into
     "nothing is neglected". */
  const r = buildAlerts({
    tasks: [], today: TODAY, silent: null,
    lateness: { status: 'ok', days: 0 },
  });
  assert.strictEqual(r.empty, false);
  assert.match(r.unavailable.join(' '), /mentioned/i);
});

test('a missing today reports that nothing date-based was checked', () => {
  const r = buildAlerts({ tasks: [t('a')], today: null, silent: [],
                          lateness: { status: 'ok', days: 0 } });
  assert.match(r.unavailable.join(' '), /date/i);
  assert.strictEqual(r.empty, false);
});

test('"nothing to worry about" is only sayable when everything was checkable', () => {
  /* THE test. `empty` is the flag a caller renders reassurance from, so it
     must be false whenever any section could not be evaluated. */
  const clean = buildAlerts({
    tasks: [t('ok', { end: '2026-06-01' })], today: TODAY, silent: [],
    lateness: { status: 'ok', days: 0 },
  });
  assert.strictEqual(clean.empty, true);

  const partial = buildAlerts({
    tasks: [t('ok', { end: '2026-06-01' })], today: TODAY, silent: null,
    lateness: { status: 'ok', days: 0 },
  });
  assert.strictEqual(partial.empty, false,
    'a section that could not be checked must block the all-clear');
});

test('silent tasks are carried through rather than recomputed', () => {
  /* The judgement about silence lives in programme-mentions, which refuses
     to answer without coverage. Recomputing it here would duplicate that
     rule and let the two drift. */
  const silent = [t('s1'), t('s2')];
  const r = buildAlerts({ tasks: [], today: TODAY, silent: silent,
                          lateness: { status: 'ok', days: 0 } });
  const section = r.sections.filter(s => s.key === 'silent')[0];
  assert.strictEqual(section.items.length, 2);
  assert.match(section.title, /2 tasks nobody has mentioned/);
});

test('singular and plural read correctly', () => {
  const r = buildAlerts({
    tasks: [t('a', { status: 'blocked' })], today: TODAY, silent: [],
    lateness: { status: 'ok', days: 1, projectedFinish: 'x', baselineFinish: 'y' },
  });
  assert.match(r.sections.filter(s => s.key === 'lateness')[0].title, /^1 day behind/);
  assert.match(r.sections.filter(s => s.key === 'blocked')[0].title, /^1 task blocked/);
});

/* ---- the answer text ----------------------------------------------------- */

const { formatAlerts } = require('../scripts/api/programme-alerts.js');

test('the all-clear is only rendered when everything was checkable', () => {
  const clean = buildAlerts({ tasks: [], today: TODAY, silent: [],
                              lateness: { status: 'ok', days: 0 } });
  assert.match(formatAlerts(clean), /Nothing is overdue/);
});

test('an unchecked section is named instead of an all-clear', () => {
  /* The failure this whole route guards: reassurance assembled from data
     that was never loaded. */
  const partial = buildAlerts({ tasks: [], today: TODAY, silent: null,
                                lateness: { status: 'ok', days: 0 } });
  const text = formatAlerts(partial);
  assert.doesNotMatch(text, /Nothing is overdue/);
  assert.match(text, /Not checked:.*mentioned/i);
});

test('a truncated list says how many it left out', () => {
  /* An unmarked top-5 is the same silent incompleteness this route exists
     to avoid. */
  const many = Array.from({ length: 9 }, (_, i) =>
    t('x' + i, { end: '2026-04-0' + ((i % 9) + 1), status: 'blocked' }));
  const text = formatAlerts(buildAlerts({ tasks: many, today: TODAY, silent: [],
                                          lateness: { status: 'ok', days: 0 } }),
                            { limit: 5 });
  assert.match(text, /and 4 more/);
});

test('lateness renders its baseline detail', () => {
  const text = formatAlerts(buildAlerts({
    tasks: [], today: TODAY, silent: [],
    lateness: { status: 'ok', days: 12, projectedFinish: '2026-06-01',
                baselineFinish: '2026-05-20' },
  }));
  assert.match(text, /12 days behind baseline/);
  assert.match(text, /2026-05-20/);
});
