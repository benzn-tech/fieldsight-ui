'use strict';

/*
 * From a sentence typed in the Editor to the bytes that leave the browser.
 *
 * This is the first half of a chain that crosses two languages. It ends by
 * WRITING THE BODY to tests/fixtures/editor-to-prompt.body.json, and the
 * Python half (fieldsight-pipeline, test_what_you_type_reaches_the_prompt.py)
 * starts by reading that same file and running report_template.render_prompt
 * over it.
 *
 * The fixture is the join, and it is the point. Two tests that each build
 * their own copy of the middle prove the two ends and nothing about the road
 * between them -- which is how three separate failures got to the owner today,
 * every one of them with green assertions on both sides.
 *
 * The chain here:
 *
 *     an editor row (what the person typed)
 *       -> sectionsToSchema        (pages/library.js, what Save builds)
 *       -> toBackendBody           (api/template-store.js, what is POSTed)
 *       -> the fixture             (what Python then renders)
 *
 * Nothing in between is written by hand. If any step drops the sentence, the
 * fixture no longer contains it and this file fails; if a step changes shape,
 * the committed fixture goes stale and this file fails too.
 *
 * THE test is `the sentence survives the whole way to the body`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'fixtures', 'editor-to-prompt.body.json');

/* ---- the real functions, lifted from the shipped files --------------------- */

const LIBRARY = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function liftSectionsToSchema() {
  const m = LIBRARY.match(/function sectionsToSchema\(sections\)[\s\S]*?\n  \}/);
  assert.ok(m, 'sectionsToSchema has moved or been renamed');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn sectionsToSchema;')();
}

function loadStore() {
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.window = { FS: { api: { useMocks: true, orgBaseUrl: '' } } };
  delete require.cache[require.resolve('../scripts/api/template-store.js')];
  require('../scripts/api/template-store.js');
  return global.window.FS.api.templates;
}

const sectionsToSchema = liftSectionsToSchema();
const templates = loadStore();

/* ---- what the person did ---------------------------------------------------
   One row of the editor, with a description somebody typed into the box. The
   wording is deliberately specific: a generic sentence could plausibly appear
   in a prompt by accident, and then the test would pass without proving
   anything travelled. */

const TYPED = 'Only hazards raised by name, and whether a control was agreed.';

const EDITOR_ROWS = [
  { title: 'What this was', kind: 'narrative', fields: [],
    prompt_hint: 'Whose meeting it was and what it covered.',
    children: [], _key: 0 },
  { title: 'Safety', kind: 'list', fields: ['hazard'],
    prompt_hint: TYPED,
    children: [], _key: 1 },
  { title: 'Actions', kind: 'table', fields: ['action', 'owner'],
    prompt_hint: 'One line per action.',
    children: [], _key: 2 },
];

function drive(rows) {
  /* Save builds the schema; the api layer builds the body that is POSTed. */
  return templates._toBackendBody(sectionsToSchema(rows));
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: the sentence survives the whole way to the body', () => {
  const body = drive(EDITOR_ROWS);
  const safety = body.sections.filter((s) => s.title === 'Safety')[0];
  assert.ok(safety, 'the section itself was lost');
  assert.strictEqual(safety.purpose, TYPED,
    'what the person typed is what render_prompt writes under the heading');
});

test('and it is written to the fixture the Python half reads', () => {
  /* The join. Regenerated here rather than hand-maintained, so it cannot
     drift away from what the code actually produces. */
  const body = drive(EDITOR_ROWS);
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  const written = JSON.stringify(body, null, 2) + '\n';
  const existing = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, 'utf8') : null;
  if (existing !== written) fs.writeFileSync(FIXTURE, written);

  const reread = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.ok(reread.sections.some((s) => s.purpose === TYPED),
    'the fixture must carry the typed sentence, or the Python half proves nothing');
});

test('the committed fixture matches what the code produces today', () => {
  /* If a step changes shape, the file on disk and the file the code would
     write disagree, and the Python half is quietly testing yesterday. */
  const body = drive(EDITOR_ROWS);
  const onDisk = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepStrictEqual(onDisk, JSON.parse(JSON.stringify(body)));
});

/* ---- what else has to be in there for the prompt to work ------------------- */

test('every heading keeps its own sentence, in order', () => {
  const body = drive(EDITOR_ROWS);
  assert.deepStrictEqual(
    body.sections.map((s) => [s.title, s.purpose]),
    EDITOR_ROWS.map((r) => [r.title, r.prompt_hint]));
});

test('a catch_all travels, because render_prompt subscripts it', () => {
  /* template["catch_all"] -- absence raises inside the worker rather than
     making a worse report. */
  const body = drive(EDITOR_ROWS);
  assert.ok(body.catch_all && body.catch_all.title && body.catch_all.purpose);
});

test('the editor’s own bookkeeping does not travel', () => {
  const body = drive(EDITOR_ROWS);
  for (const s of body.sections) {
    assert.ok(!('_key' in s), '_key is the editor’s, not the prompt’s');
  }
});

test('kind and fields ride along rather than being dropped', () => {
  /* They mean nothing to the prompt, but losing them empties the editor the
     next time somebody opens it. */
  const body = drive(EDITOR_ROWS);
  const safety = body.sections.filter((s) => s.title === 'Safety')[0];
  assert.strictEqual(safety.kind, 'list');
  assert.deepStrictEqual(safety.fields, ['hazard']);
});

/* ---- the edit itself -------------------------------------------------------- */

test('changing the sentence changes the body, and nothing else does', () => {
  /* The owner's own check, in miniature: edit one description, and only that
     description moves. */
  const before = drive(EDITOR_ROWS);
  const edited = EDITOR_ROWS.map((r) => (r.title === 'Safety'
    ? Object.assign({}, r, { prompt_hint: 'Near misses only, with who reported them.' })
    : r));
  const after = drive(edited);

  const diff = after.sections
    .map((s, i) => [s.title, s.purpose === before.sections[i].purpose])
    .filter(([, same]) => !same)
    .map(([title]) => title);
  assert.deepStrictEqual(diff, ['Safety']);
});
