'use strict';

/*
 * Contract test: the real fixtures must flow through programme-mentions.
 *
 * tests/programme-mentions.test.js asserts the module's behaviour against
 * task and suggestion objects this file's author invented. That is exactly
 * the kind of test that passed while the module could not read either of the
 * shapes it will actually be given.
 *
 * This file removes the invention. It loads the SHIPPED fixtures — the same
 * ones the existing suggestion review queue renders from, whose headers state
 * they mirror the live backend contract — and asserts that mentions actually
 * land on tasks.
 *
 * Two real defects were caught here and nowhere else:
 *
 *   - the programme fixture is DOCUMENT shaped (`task_id`, `start`), while
 *     the window endpoint returns ROW shape (`id`/`source_task_id`,
 *     `start_date`). A docIdOf that handled only rows worked against the live
 *     window endpoint and silently matched nothing in every mock and demo.
 *   - the suggestions fixture carried no `topic_id` and the daily-report
 *     fixture no `topic_row_id`, so the report-topic link could not be
 *     expressed at all. Both were added (plan Task 1); the assertions at the
 *     bottom of this file are what keep them agreeing.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');

const {
  docIdOf, indexByTask, indexByTopic, mentionSummary, startOf, mentionsForTopic,
} = require('../scripts/api/programme-mentions.js');

/* The fixtures are browser IIFEs that publish onto window.FieldSight, so they
   are evaluated in a sandbox with just enough of a window to land on. */
function loadFixtures() {
  const sandbox = { window: { FieldSight: { fixtures: {} } } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['programme.fixture.js', 'programme-suggestions.fixture.js',
                   'daily-report.fixture.js']) {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'mock', f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }
  return sandbox.window.FieldSight.fixtures;
}

const FIX = loadFixtures();
const PROGRAMME = FIX.programme;
const SUGGESTIONS = FIX.programmeSuggestions;
/* Reports are keyed reports[date][folder_name] — checked rather than guessed;
   the programme fixture publishes flat as `fixtures.programme`, and assuming
   the same here would silently give `undefined` and pass vacuously. */
const REPORT = FIX.reports['2026-04-29'].Jarley_Trainor;

test('the fixtures loaded at all', () => {
  /* If this fails the rest of the file is asserting on undefined and would
     otherwise pass vacuously. */
  assert.ok(PROGRAMME && PROGRAMME.tasks && PROGRAMME.tasks.length,
            'programme fixture has tasks');
  assert.ok(Array.isArray(SUGGESTIONS) && SUGGESTIONS.length,
            'suggestions fixture has rows');
});

test('every fixture task yields a document id', () => {
  for (const t of PROGRAMME.tasks) {
    assert.ok(docIdOf(t), `no document id for ${JSON.stringify(t).slice(0, 80)}`);
  }
});

test('the only undated fixture tasks are the WBS group headers', () => {
  /* silentTasks filters on the start date, and reading the wrong key would
     silently drop every task out of the result rather than erroring — so the
     shape has to be pinned. Undated rows are legitimate: a task with no dates
     is a structural header, which is the same rule programme_snapshot uses to
     split parents from leaves.

     Asserting "every task has a start" was the first version of this test.
     It failed, and the code was right — the five group rows are supposed to
     be undated. */
  const undated = PROGRAMME.tasks.filter(t => !startOf(t));
  /* Array.from pulls the result into THIS realm: the fixtures are evaluated
     in a vm context, so their arrays have that context's Array prototype and
     deepStrictEqual rejects them as "same structure, not reference-equal". */
  assert.deepStrictEqual(Array.from(undated, docIdOf),
                         ['T-100', 'T-200', 'T-300', 'T-400', 'T-500']);
  for (const t of undated) {
    assert.strictEqual(t.parent_id, null, `${docIdOf(t)} is a root header`);
  }
  for (const t of PROGRAMME.tasks.filter(t => t.parent_id)) {
    assert.ok(startOf(t), `leaf ${docIdOf(t)} must be dated`);
  }
});

test('undated group headers are never surfaced as silent', () => {
  /* They have nothing to say and nobody would mention them by name. */
  const { silentTasks } = require('../scripts/api/programme-mentions.js');
  const got = silentTasks(PROGRAMME.tasks, {},
                          { today: '2026-04-30', coverage: { states: 'all' } });
  assert.strictEqual(got.filter(t => !t.parent_id).length, 0);
});

test('THE contract assertion: fixture suggestions land on fixture tasks', () => {
  /* An empty intersection is how this whole feature fails in production: no
     error, no warning, just a Gantt with no mentions on it ever. */
  const byTask = indexByTask(SUGGESTIONS);
  const matched = PROGRAMME.tasks.filter(t => byTask[docIdOf(t)]);

  assert.ok(matched.length > 0,
            'no fixture suggestion matched any fixture task — the document id '
            + 'rule does not agree with the shapes actually shipped. '
            + `suggestion task_ids: ${SUGGESTIONS.map(s => s.task_id)}; `
            + `task doc ids: ${PROGRAMME.tasks.map(docIdOf).slice(0, 8)}`);
  assert.strictEqual(matched.length, new Set(SUGGESTIONS.map(s => s.task_id)).size,
                     'some suggestion points at a task the programme lacks');
});

test('a matched task reports its mention through the summary', () => {
  const byTask = indexByTask(SUGGESTIONS);
  const task = PROGRAMME.tasks.find(t => byTask[docIdOf(t)]);
  const r = mentionSummary(task, byTask,
                           { today: '2026-04-30', coverage: { states: 'all' } });
  assert.strictEqual(r.status, 'mentioned');
  assert.ok(r.latest.report_date, 'the mention carries a date to render');
  assert.strictEqual(typeof r.daysSinceLastMention, 'number');
});

test('every fixture suggestion carries the fields the summary renders', () => {
  for (const s of SUGGESTIONS) {
    assert.ok(s.id, 'id');
    assert.ok(s.task_id, `task_id on ${s.id}`);
    assert.ok(s.report_date, `report_date on ${s.id}`);
    assert.match(s.report_date, /^\d{4}-\d{2}-\d{2}$/,
                 `report_date on ${s.id} must be a plain date string — the `
                 + 'backend serialises with json.dumps(default=str) and this '
                 + 'module compares dates as strings');
  }
});

test('every fixture suggestion carries topic_id, so the report side can link', () => {
  /* The backend selects topic_id (repositories/programme_suggestions._COLS)
     and confirm_suggestion depends on it. */
  for (const s of SUGGESTIONS) {
    assert.ok(s.topic_id, `topic_id missing on ${s.id}`);
  }
});

test('every fixture report topic carries a durable topic_row_id', () => {
  /* The per-report topic_id is sequential (0, 1, 2...) and every section has
     a topic 0, so it cannot identify anything across reports. topic_row_id is
     the topics.id a suggestion actually points at. */
  for (const t of REPORT.topics) {
    assert.ok(t.topic_row_id, `topic_row_id missing on topic ${t.topic_id}`);
    assert.notStrictEqual(t.topic_row_id, t.topic_id);
  }
});

test('THE contract assertion: fixture suggestions link to fixture report topics', () => {
  const byTopic = indexByTopic(SUGGESTIONS);
  const linked = REPORT.topics.filter(t => mentionsForTopic(t, byTopic).length);

  assert.strictEqual(linked.length, 3,
    'report topics did not resolve their suggestions — check that each '
    + "suggestion's topic_id equals a topic's topic_row_id, not its "
    + `per-report topic_id. suggestion topic_ids: ${SUGGESTIONS.map(s => s.topic_id)}; `
    + `topic_row_ids: ${REPORT.topics.map(t => t.topic_row_id)}`);
});

test('the link resolves to the right task, not merely to something', () => {
  /* A count assertion alone would pass if every topic resolved the same
     suggestion. This pins the actual pairing. */
  const byTopic = indexByTopic(SUGGESTIONS);
  const crane = REPORT.topics.find(t => t.topic_title === 'Crane pre-start inspection slot');
  const got = mentionsForTopic(crane, byTopic);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].topic_title, 'Crane pre-start inspection slot');
});

test('the obvious wrong join returns nothing, which is why mentionsForTopic exists', () => {
  /* byTopic[topic.topic_id] is what anyone would write first. It has to fail
     here, or the trap is not actually being avoided — it is just absent from
     this fixture and would reappear against live data. */
  const byTopic = indexByTopic(SUGGESTIONS);
  for (const t of REPORT.topics) {
    assert.strictEqual(byTopic[t.topic_id], undefined,
                       'a sequential topic_id matched a suggestion bucket — '
                       + 'the two identifier spaces have collided');
  }
});
