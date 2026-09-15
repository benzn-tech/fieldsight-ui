'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* One Ask, scoped to what you are looking at (docs/specs/2026-09-15-one-ask-scoped.md §5).

   The request is a REQUEST: the backend decides what it enforces and says so in
   `applied_scope`. So every helper here is pinned on both halves -- what we ask
   for, and that what we SHOW comes from the answer, never from our own request. */

function loadScope() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement: function () { return null; } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight.askScope;
}

function loadAskApi(capture) {
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  global.window = {
    FieldSight: {},
    FS: { api: {
      useMocks: false,
      orgBaseUrl: 'https://org.example',
      request: function (path, opts) {
        capture.body = opts.body;
        return Promise.resolve({ answer: 'ok', citations: [] });
      },
    } },
  };
  require('../scripts/api/ask.js');
  return global.window.FS.api.ask;
}

const DAY = { date: '2026-09-03', siteId: 'site-uuid', siteName: 'UC PK',
              authorFolder: 'Ben_UCPK2', authorName: 'Ben UCPK2' };
const TOPIC = Object.assign({}, DAY, { topicRowId: 'topic-uuid',
              topicTitle: 'Morning commercial chase and landscaping cost escalation' });

/* ---- 1. requestBodyFor --------------------------------------------------- */

test('1a requestBodyFor maps every context field to its contract name', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.requestBodyFor(TOPIC, 'q'), {
    question: 'q', date: '2026-09-03', site_id: 'site-uuid',
    author_folder: 'Ben_UCPK2', topic_row_id: 'topic-uuid', scoped: true,
  });
});

test('1b absent fields are absent -- not empty string, not null', () => {
  const S = loadScope();
  const body = S.requestBodyFor({ date: '2026-09-03', siteId: '', authorFolder: null,
                                  topicRowId: undefined }, 'q');
  assert.deepStrictEqual(Object.keys(body).sort(), ['date', 'question', 'scoped']);
  assert.deepStrictEqual(S.requestBodyFor({}, 'q'), { question: 'q' });
  assert.deepStrictEqual(S.requestBodyFor(undefined, 'q'), { question: 'q' });
});

test('1c scope and topic_id are never sent, whatever the context carries', () => {
  const S = loadScope();
  const body = S.requestBodyFor(Object.assign({ scope: 'both', topic_id: 3 }, TOPIC), 'q');
  assert.ok(!('scope' in body), 'scope leaked into the body');
  assert.ok(!('topic_id' in body), 'topic_id leaked into the body');
});

test('1c2 scoped:true is sent whenever any narrowing field is, and omitted otherwise', () => {
  const S = loadScope();
  assert.strictEqual(S.requestBodyFor(TOPIC, 'q').scoped, true);
  assert.strictEqual(S.requestBodyFor({ date: '2026-09-03' }, 'q').scoped, true);
  assert.strictEqual(S.requestBodyFor({ siteId: 's' }, 'q').scoped, true);
  assert.strictEqual(S.requestBodyFor({ authorFolder: 'A' }, 'q').scoped, true);
  assert.strictEqual(S.requestBodyFor({ topicRowId: 't' }, 'q').scoped, true);
  assert.ok(!('scoped' in S.requestBodyFor({}, 'q')), 'scoped present with no narrowing field');
  assert.ok(!('scoped' in S.requestBodyFor(undefined, 'q')), 'scoped present with no context');
});

test('1d the api forwards the new fields, and omits them when absent', async () => {
  const cap = {};
  const api = loadAskApi(cap);
  await api.ask({ question: 'q', date: '2026-09-03', site_id: 's', author_folder: 'A',
                  topic_row_id: 't', tz: null });
  assert.strictEqual(cap.body.site_id, 's');
  assert.strictEqual(cap.body.author_folder, 'A');
  assert.strictEqual(cap.body.topic_row_id, 't');

  await api.ask({ question: 'q', tz: null });
  /* The wire is JSON: an undefined value is a missing key there. */
  const wire = JSON.parse(JSON.stringify(cap.body));
  ['site_id', 'author_folder', 'topic_row_id', 'scope', 'topic_id', 'scoped'].forEach(function (k) {
    assert.ok(!(k in wire), k + ' present on the wire when not supplied');
  });
});

test('1e the api forwards scoped:true, and the real ask.js body carries it end to end', async () => {
  const S = loadScope();
  const cap = {};
  const api = loadAskApi(cap);
  const body = S.requestBodyFor(TOPIC, 'q');
  await api.ask(Object.assign({ tz: null }, body));
  assert.strictEqual(cap.body.scoped, true);

  /* Any other value than true must not reach the wire. */
  const cap2 = {};
  const api2 = loadAskApi(cap2);
  await api2.ask({ question: 'q', scoped: false, tz: null });
  assert.ok(!('scoped' in JSON.parse(JSON.stringify(cap2.body))), 'scoped:false leaked onto the wire');
});

/* ---- 2. chipsFor --------------------------------------------------------- */

test('2a an empty context has no chips', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.chipsFor({}), []);
  assert.deepStrictEqual(S.chipsFor(undefined), []);
});

test('2b a day context is one chip: date · site · owner', () => {
  const S = loadScope();
  const chips = S.chipsFor(DAY);
  assert.strictEqual(chips.length, 1);
  assert.strictEqual(chips[0].kind, 'day');
  /* 2026-09-03 is a Thursday (the spec example said Wed; computed, not typed). */
  assert.strictEqual(chips[0].label, 'Thu 3 Sep · UC PK · Ben_UCPK2');
  assert.deepStrictEqual(chips[0].segments.map(s => s.field), ['date', 'site_id', 'author_folder']);
});

test('2c a topic context is two chips, the topic title truncated', () => {
  const S = loadScope();
  const chips = S.chipsFor(TOPIC);
  assert.deepStrictEqual(chips.map(c => c.kind), ['day', 'topic']);
  assert.strictEqual(chips[1].label, 'Topic: Morning commercial chase…');
  assert.strictEqual(chips[1].title, TOPIC.topicTitle, 'the full title belongs in the tooltip');
});

test('2d a day without siteId has no site segment', () => {
  const S = loadScope();
  const ctx = { date: '2026-09-03', authorFolder: 'Ben_UCPK2', siteName: 'UC PK' };
  const chips = S.chipsFor(ctx);
  assert.strictEqual(chips[0].label, 'Thu 3 Sep · Ben_UCPK2');
  assert.ok(!chips[0].segments.some(s => s.field === 'site_id'));
});

test('2e removing the day clears the topic; removing the topic keeps the day', () => {
  const S = loadScope();
  const chips = S.chipsFor(TOPIC);
  assert.deepStrictEqual(chips[0].next, {}, 'a topic cannot outlive its day');
  assert.deepStrictEqual(chips[1].next, DAY);
  assert.ok(!('topicRowId' in chips[1].next) && !('topicTitle' in chips[1].next));
});

test('2f the date label never goes through new Date(string)', () => {
  const src = fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  const fn = src.slice(src.indexOf('function shortDay'), src.indexOf('function shortDay') + 400);
  assert.match(fn, /Date\.UTC/);
  assert.doesNotMatch(fn, /new Date\(iso/);
});

/* ---- 4. chips say what was enforced once an answer exists ---------------- */

test('4a before any answer the chips show the request, unmarked', () => {
  const S = loadScope();
  S.chipsFor(TOPIC).forEach(c => c.segments.forEach(s =>
    assert.strictEqual(s.enforced, null, s.field + ' marked before an answer')));
});

test('4b an answer whose applied_scope lacks author_folder marks the owner segment', () => {
  const S = loadScope();
  const res = { applied_scope: { date: '2026-09-03', site_id: 'site-uuid',
    dropped: [{ field: 'author_folder', reason: 'not_visible' }] } };
  const seg = f => S.chipsFor(DAY, res)[0].segments.find(s => s.field === f);
  assert.strictEqual(seg('author_folder').enforced, false);
  assert.strictEqual(seg('date').enforced, true);
  assert.strictEqual(seg('site_id').enforced, true);
});

test('4c an answer with no applied_scope at all marks every segment not enforced', () => {
  const S = loadScope();
  S.chipsFor(TOPIC, { answer: 'x' }).forEach(c => c.segments.forEach(s =>
    assert.strictEqual(s.enforced, false, s.field)));
});
