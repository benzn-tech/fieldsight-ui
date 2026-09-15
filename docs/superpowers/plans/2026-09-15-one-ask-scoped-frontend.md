# One Ask, Scoped — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Timeline has exactly one Ask, scoped to the viewed day, site and owner by default. It can pin a topic from topic detail, and it shows the scope the backend actually enforced. The search palette Ask stays global.

**Architecture:** Pure helpers live in `scripts/composites/ask-chat.js`: the request body, chips, basis lines, suggestions and placeholder. They are exported on `window.FieldSight.askScope` so Node can test them. `AskChat` receives a host-owned `context` plus `onContextChange` and never mutates the context itself. Timeline gets a page `Provider` (`TimelineAskProvider`, the same pattern as `TodayProvider`) holding `{askContext, setAskContext, askFocusNonce, requestAskFocus}`. The middle column sets the day context. The topic detail header pins a topic. The two topic-tab mounts and their `ask` tabs are removed.

**Tech Stack:** Vanilla JS IIFEs + `React.createElement`, loaded in the browser without a build step. Tests use `node --test tests/*.test.js` (Node 24, no package.json).

**Spec:** `docs/specs/2026-09-15-one-ask-scoped.md` (frontend). The contract lives in `fieldsight-pipeline/docs/superpowers/specs/2026-09-15-scoped-ask-design.md` §3 (local copy: `C:/Users/camil/Dropbox/wt-pipe-specs/...`). Read both.

## Global Constraints

- Body field names, verbatim: `date`, `site_id`, `author_folder`, `topic_row_id`. Absent context fields are **omitted**, never `''` or `null`. AskChat never sends `scope` or `topic_id`. `user` and `tz` are still sent.
- The response is read from `applied_scope`; only its keys count as enforced. `dropped: [{field, reason}]`. Fields: `date|site_id|author_folder|topic_row_id|question_range`. Reasons: `invalid|not_visible|overridden_by_question|overridden_by_topic`.
- The basis line is built from the response only, **never from `context`**.
- Copy is verbatim from spec §2. Placeholders: `Ask about this topic…`, `Ask about this day…`, `Ask across all your projects…`. Button labels: `Ask across everything` and `Ask about this topic`.
- `tests/ask-timezone-and-basis.test.js` stays **byte-for-byte unchanged** and green. `FS.api.ask.ask` remains a pass-through for `scope`/`topic_id`.
- No `new Date('YYYY-MM-DD')` (BUG-19). Use `Date.UTC` arithmetic.
- Tokens only in CSS: semantic `--text-*`, `--surface-*`, `--border-*`. No colour-only signal. Any animation or smooth scroll must respect `prefers-reduced-motion`.
- `ask-panel-ux.test.js` slices ask-chat.js between the comments `Put the QUESTION at the top` and `When scope keys change`. Keep both comment openings, in that order.
- `ask-timezone-and-basis.test.js` needs, in ask-chat.js:
  - the first `'fs-ask-chat__basis'` before `fs-ask-chat__msg-text fs-ask-chat__msg-text--md`;
  - `zh:        askedInChinese(question)`, with its exact spacing;
  - at least two `formatAnswerBasis(m.basis, m.zh)` calls.
  Do not rename or reformat any of these.
- Code, comments and commit messages are English only. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd
  ```
- **Merge gate:** this branch merges to `dev` only after the backend (`applied_scope`) is live on TEST, and to `main` only after the prod backend deploy is live (backend spec §7).

## Spec discrepancy found while planning (decide before Task 2)

The spec's example chip `Wed 3 Sep · UC PK · Ben_UCPK2` is for 2026-09-03, but **2026-09-03 is a Thursday**. This was checked with `new Date(Date.UTC(2026,8,3)).getUTCDay()` → 4. The chip is computed from the date, so it will read `Thu 3 Sep · UC PK · Ben_UCPK2`. This plan's tests and the manual check (Task 8) use `Thu`. Tell the spec owner. Do not hard-code `Wed`.

The owner segment shows `authorFolder` (`Ben_UCPK2`), not `authorName`, to match the spec's example.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/api/ask.js` | modify (body literal, lines 50-56) | also forward `site_id`, `author_folder`, `topic_row_id` |
| `scripts/composites/ask-chat.js` | modify | pure scope helpers + `context`/`onContextChange`/`focusNonce` props, chips, scope lines, reset rekey, "Ask across everything" |
| `styles/composites.css` | modify (append after the `.fs-ask-chat__form` block, ~3557) | chip, scope-line, widen button, topic-ask button styles |
| `scripts/pages/timeline.js` | modify | `TimelineAskContext`/`TimelineAskProvider`, day-context helpers, `TopicAskButton`, mount #1 rewire, remove mounts #2/#3 + `ask` tabs, registry `Provider`, exports |
| `scripts/composites/search-palette.js` | modify (~348-358 comment, ~498-508 mount) | mount #4 passes no `scope`/context |
| `tests/ask-scoped-context.test.js` | create | spec §5 tests 1-8 |
| `app-shell-preview.html` | modify (lines 18, 98, 127, 239, 349) | cache busters |

---

### Task 1: `requestBodyFor` + API pass-through (spec §5 test 1)

**Files:**
- Create: `tests/ask-scoped-context.test.js`
- Modify: `scripts/composites/ask-chat.js` (add helpers above `function AskChat(props)` at ~450; export at the bottom, ~763-769)
- Modify: `scripts/api/ask.js:50-56`

**Interfaces:**
- Produces: `window.FieldSight.askScope.requestBodyFor(context, question) -> {question, date?, site_id?, author_folder?, topic_row_id?}`; `window.FieldSight.askScope.hasScope(context) -> boolean`; internal `present(v)`.
- `FS.api.ask.ask(opts)` additionally forwards `opts.site_id`, `opts.author_folder`, `opts.topic_row_id`.

- [ ] **Step 1: Write the failing test**

Create `tests/ask-scoped-context.test.js`:

```js
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
    author_folder: 'Ben_UCPK2', topic_row_id: 'topic-uuid',
  });
});

test('1b absent fields are absent -- not empty string, not null', () => {
  const S = loadScope();
  const body = S.requestBodyFor({ date: '2026-09-03', siteId: '', authorFolder: null,
                                  topicRowId: undefined }, 'q');
  assert.deepStrictEqual(Object.keys(body).sort(), ['date', 'question']);
  assert.deepStrictEqual(S.requestBodyFor({}, 'q'), { question: 'q' });
  assert.deepStrictEqual(S.requestBodyFor(undefined, 'q'), { question: 'q' });
});

test('1c scope and topic_id are never sent, whatever the context carries', () => {
  const S = loadScope();
  const body = S.requestBodyFor(Object.assign({ scope: 'both', topic_id: 3 }, TOPIC), 'q');
  assert.ok(!('scope' in body), 'scope leaked into the body');
  assert.ok(!('topic_id' in body), 'topic_id leaked into the body');
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
  ['site_id', 'author_folder', 'topic_row_id', 'scope', 'topic_id'].forEach(function (k) {
    assert.ok(!(k in wire), k + ' present on the wire when not supplied');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: FAIL. 1a-1c fail with `TypeError: Cannot read properties of undefined (reading 'requestBodyFor')`. 1d fails with `undefined !== 's'`.

- [ ] **Step 3: Implement**

In `scripts/api/ask.js`, replace the body literal at lines 50-56 with:

```js
      var body = {
        date:     opts.date,
        user:     opts.user,
        question: opts.question,
        scope:    opts.scope,
        topic_id: opts.topic_id,
        /* Scoped Ask (backend spec 2026-09-15 §3). Requests, not filters: the
           backend validates each one and reports what it enforced in
           `applied_scope`. Undefined values vanish in JSON.stringify, which is
           how an absent field stays absent on the wire. */
        site_id:       opts.site_id,
        author_folder: opts.author_folder,
        topic_row_id:  opts.topic_row_id,
      };
```

Also update the header comment on line 4 to `POST /api/ask  body { question, date?, user?, site_id?, author_folder?, topic_row_id?, tz?, scope?, topic_id? }`.

In `scripts/composites/ask-chat.js`, insert this directly above `function AskChat(props) {` (~450):

```js
  /* ---- scope: what this Ask is narrowed to --------------------------------

     The host owns the context ({date, siteId, siteName, authorFolder,
     authorName, topicRowId, topicTitle}); AskChat only reads it. Everything
     below is pure so it can be driven from Node -- this file cannot be rendered
     there. */

  function present(v) {
    return typeof v === 'string' ? v.trim() !== '' : v != null;
  }

  function hasScope(context) {
    var c = context || {};
    return present(c.date) || present(c.siteId) || present(c.authorFolder)
        || present(c.topicRowId);
  }

  /* Context -> POST /api/ask body. Omits absent fields rather than sending ''
     or null: the backend treats a present-but-empty field as malformed and
     reports it `dropped: invalid`, which would put a warning under every
     answer. Never sends `scope` / `topic_id` -- the RAG path ignores both. */
  function requestBodyFor(context, question) {
    var c = context || {};
    var body = { question: question };
    if (present(c.date))         body.date          = c.date;
    if (present(c.siteId))       body.site_id       = c.siteId;
    if (present(c.authorFolder)) body.author_folder = c.authorFolder;
    if (present(c.topicRowId))   body.topic_row_id  = c.topicRowId;
    return body;
  }
```

At the bottom, after `window.FieldSight.formatAnswerBasis = formatAnswerBasis;`, add:

```js
  /* Pure scope helpers, exported for tests (tests/ask-scoped-context.test.js).
     Later tasks add chipsFor / basisLinesFor / suggestionsFor / placeholderFor
     to this same object. */
  window.FieldSight.askScope = {
    requestBodyFor: requestBodyFor,
    hasScope:       hasScope,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/ask-scoped-context.test.js tests/ask-timezone-and-basis.test.js`
Expected: PASS, with 0 failures in both files.

- [ ] **Step 5: Mutation check (spec §5)**

Temporarily add `body.scope = 'both';` as the last line before `return body;` in `requestBodyFor`.
Run: `node --test tests/ask-scoped-context.test.js`
Expected: `1c` FAILS with `scope leaked into the body`. **Revert the line**, re-run, and confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/ask-scoped-context.test.js scripts/composites/ask-chat.js scripts/api/ask.js
git commit -m "feat(ask): scoped request body helper and api pass-through

requestBodyFor maps the host context to date/site_id/author_folder/
topic_row_id and omits absent fields; FS.api.ask.ask forwards the three
new fields while staying a pass-through for scope/topic_id.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 2: `chipsFor` with enforcement (spec §5 tests 2 and 4)

**Files:**
- Modify: `scripts/composites/ask-chat.js` (append to the helper block from Task 1; extend the `askScope` export)
- Test: `tests/ask-scoped-context.test.js`

**Interfaces:**
- Consumes: `present` (Task 1).
- Produces: `askScope.chipsFor(context, response?) -> Array<{kind:'day'|'topic', label:string, title:string, segments:Array<{field:string, text:string, enforced:boolean|null}>, next:object}>`.
  - `response === undefined` means no answer yet, so every `enforced` is `null`.
  - Otherwise `enforced` is true only when `field` is a key of `response.applied_scope`.
  - `next` is the context that removing the chip produces.
- Produces: `askScope.shortDay('YYYY-MM-DD') -> 'Thu 3 Sep'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ask-scoped-context.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: every 2x/4x test FAILS with `S.chipsFor is not a function`, and 2f fails with a regex mismatch. Task 1's tests still PASS.

- [ ] **Step 3: Implement**

Append to the helper block in `ask-chat.js`, below `requestBodyFor`:

```js
  var SCOPE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var SCOPE_DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  /* 'YYYY-MM-DD' -> 'Thu 3 Sep'. UTC arithmetic only (BUG-19): a date string
     parsed as local time drifts a day in New Zealand. */
  function shortDay(iso) {
    var p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return String(iso || '');
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return SCOPE_DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + SCOPE_MONTHS[d.getUTCMonth()];
  }

  var TOPIC_CHIP_MAX = 24;
  function truncateTitle(title) {
    var t = String(title || '').trim();
    if (t.length <= TOPIC_CHIP_MAX) return t;
    var cut = t.slice(0, TOPIC_CHIP_MAX + 1);
    var sp = cut.lastIndexOf(' ');
    return (sp > 0 ? cut.slice(0, sp) : t.slice(0, TOPIC_CHIP_MAX)).trim() + '…';
  }

  /* null  = no answer yet: the chip shows the request, unmarked.
     true  = the backend says it enforced this field.
     false = it did not -- including a backend that predates applied_scope,
             which must read as "not scoped" rather than silently scoped. */
  function isEnforced(response, field) {
    if (response === undefined) return null;
    var applied = response && response.applied_scope;
    return !!(applied && typeof applied === 'object'
              && Object.prototype.hasOwnProperty.call(applied, field));
  }

  function chipsFor(context, response) {
    var c = context || {};
    var chips = [];

    var segs = [];
    if (present(c.date)) segs.push({ field: 'date', text: shortDay(c.date) });
    if (present(c.siteId) && present(c.siteName)) segs.push({ field: 'site_id', text: c.siteName });
    if (present(c.authorFolder)) segs.push({ field: 'author_folder', text: c.authorFolder });
    if (segs.length) {
      segs.forEach(function (s) { s.enforced = isEnforced(response, s.field); });
      chips.push({
        kind: 'day',
        label: segs.map(function (s) { return s.text; }).join(' · '),
        title: '',
        segments: segs,
        /* Removed as one, and it takes the topic with it: a topic is pinned
           to its own day, so it cannot outlive the day chip. */
        next: {},
      });
    }

    if (present(c.topicRowId)) {
      var rest = Object.assign({}, c);
      delete rest.topicRowId;
      delete rest.topicTitle;
      var label = 'Topic: ' + (truncateTitle(c.topicTitle) || 'this topic');
      chips.push({
        kind: 'topic',
        label: label,
        title: c.topicTitle || '',
        segments: [{ field: 'topic_row_id', text: label,
                     enforced: isEnforced(response, 'topic_row_id') }],
        next: rest,
      });
    }
    return chips;
  }
```

Extend the export object:

```js
  window.FieldSight.askScope = {
    requestBodyFor: requestBodyFor,
    hasScope:       hasScope,
    shortDay:       shortDay,
    chipsFor:       chipsFor,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: PASS (all of tests 1, 2 and 4).

- [ ] **Step 5: Mutation check**

Temporarily change `isEnforced`'s last line to `return true;`.
Run: `node --test tests/ask-scoped-context.test.js`
Expected: 4a, 4b and 4c FAIL. **Revert**, re-run, and confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/ask-scoped-context.test.js scripts/composites/ask-chat.js
git commit -m "feat(ask): scope chips that mark what the backend enforced

chipsFor builds a day chip (date · site · owner) and a topic chip from the
host context; after an answer each segment is marked enforced only when its
field is a key of applied_scope, so an older backend reads as not scoped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 3: `basisLinesFor` (spec §5 test 3)

**Files:**
- Modify: `scripts/composites/ask-chat.js` (helper block + export)
- Test: `tests/ask-scoped-context.test.js`

**Interfaces:**
- Produces: `askScope.basisLinesFor(response) -> string[]`. It takes **one** argument and reads only `response.applied_scope`.

- [ ] **Step 1: Write the failing tests**

Append:

```js
/* ---- 3. basisLinesFor ---------------------------------------------------- */

test('3a no applied_scope means the backend did not scope: say so', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.basisLinesFor({ answer: 'x' }), ['Searched all your projects']);
  assert.deepStrictEqual(S.basisLinesFor({ applied_scope: null }), ['Searched all your projects']);
});

test('3b every dropped row of the spec table renders its own copy', () => {
  const S = loadScope();
  const rows = [
    ['topic_row_id', 'not_visible', 'Topic not available — answered for the day'],
    ['topic_row_id', 'invalid', 'Topic not available — answered for the day'],
    ['author_folder', 'not_visible', "Couldn't narrow to this person — answered for the project and day"],
    ['author_folder', 'invalid', "Couldn't narrow to this person — answered for the project and day"],
    ['site_id', 'not_visible', "Couldn't narrow to this project"],
    ['site_id', 'invalid', "Couldn't narrow to this project"],
    ['date', 'invalid', "Couldn't narrow to this day"],
    ['date', 'overridden_by_question', 'Used the dates in your question'],
    ['date', 'overridden_by_topic', "Answered for this topic's day"],
    ['question_range', 'overridden_by_topic', "Answered for this topic's day, not the dates in your question"],
  ];
  rows.forEach(function (r) {
    assert.deepStrictEqual(
      S.basisLinesFor({ applied_scope: { dropped: [{ field: r[0], reason: r[1] }] } }),
      [r[2]], r[0] + '/' + r[1]);
  });
});

test('3c an unknown field/reason pair renders nothing, never a raw code', () => {
  const S = loadScope();
  const out = S.basisLinesFor({ applied_scope: { dropped: [
    { field: 'date', reason: 'not_visible' },
    { field: 'weather', reason: 'invalid' },
    { field: 'site_id', reason: 'exploded' },
    null,
  ] } });
  assert.deepStrictEqual(out, []);
});

test('3d a fully enforced scope has no line', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.basisLinesFor({ applied_scope: {
    date: '2026-09-03', site_id: 's', author_folder: 'A', topic_row_id: 't',
    topic_title: 'T', dropped: [] } }), []);
  assert.deepStrictEqual(S.basisLinesFor({ applied_scope: { date: '2026-09-03' } }), []);
});

test('3e the line comes from the response, not the request', () => {
  const S = loadScope();
  /* Same request, two answers: the lines must differ, so they cannot have
     been built from the request. */
  const a = S.basisLinesFor({ applied_scope: { date: '2026-09-03', dropped: [] } });
  const b = S.basisLinesFor({ applied_scope: { dropped: [{ field: 'date', reason: 'invalid' }] } });
  assert.notDeepStrictEqual(a, b);
  assert.strictEqual(S.basisLinesFor.length, 1, 'basisLinesFor must take the response only');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: 3a-3e FAIL with `S.basisLinesFor is not a function`.

- [ ] **Step 3: Implement**

Append to the helper block:

```js
  /* Copy for each `applied_scope.dropped` entry (spec §2 table). Keyed on the
     exact field:reason pair; anything else renders nothing -- a raw code under
     an answer is worse than silence, and the chips already grey the field. */
  var SCOPE_DROP_COPY = {
    'topic_row_id:not_visible':  'Topic not available — answered for the day',
    'topic_row_id:invalid':      'Topic not available — answered for the day',
    'author_folder:not_visible': "Couldn't narrow to this person — answered for the project and day",
    'author_folder:invalid':     "Couldn't narrow to this person — answered for the project and day",
    'site_id:not_visible':       "Couldn't narrow to this project",
    'site_id:invalid':           "Couldn't narrow to this project",
    'date:invalid':              "Couldn't narrow to this day",
    'date:overridden_by_question':        'Used the dates in your question',
    'date:overridden_by_topic':           "Answered for this topic's day",
    'question_range:overridden_by_topic': "Answered for this topic's day, not the dates in your question",
  };

  /* Built from the RESPONSE only. The UI renders what the backend enforced,
     never its own request: a backend that predates applied_scope must read as
     visibly unscoped, not as silently scoped. */
  function basisLinesFor(response) {
    var applied = response && response.applied_scope;
    if (!applied || typeof applied !== 'object') return ['Searched all your projects'];
    var out = [];
    (Array.isArray(applied.dropped) ? applied.dropped : []).forEach(function (d) {
      if (!d) return;
      var key = d.field + ':' + d.reason;
      if (!Object.prototype.hasOwnProperty.call(SCOPE_DROP_COPY, key)) return;
      if (out.indexOf(SCOPE_DROP_COPY[key]) === -1) out.push(SCOPE_DROP_COPY[key]);
    });
    return out;
  }
```

Add `basisLinesFor: basisLinesFor,` to the `askScope` export.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation check (spec §5)**

Temporarily replace the body of `basisLinesFor` with a version built from a context:

```js
  function basisLinesFor(response, context) {
    return hasScope(context) ? [] : ['Searched all your projects'];
  }
```

Run: `node --test tests/ask-scoped-context.test.js`
Expected: 3b, 3d and 3e FAIL. **Revert**, re-run, and confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/ask-scoped-context.test.js scripts/composites/ask-chat.js
git commit -m "feat(ask): basis lines built from applied_scope, never the request

Absent applied_scope reads 'Searched all your projects'; each dropped
field/reason pair maps to the spec copy; unknown pairs render nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 4: `suggestionsFor` + `placeholderFor` (spec §5 test 5)

**Files:**
- Modify: `scripts/composites/ask-chat.js` (helper block + export)
- Test: `tests/ask-scoped-context.test.js`

**Interfaces:**
- Produces: `askScope.suggestionsFor(context) -> string[]` and `askScope.placeholderFor(context) -> string`. Both classify the context as topic, then day, then none.

- [ ] **Step 1: Write the failing tests**

Append:

```js
/* ---- 5. suggestions and placeholder follow the scope --------------------- */

test('5a three contexts, three suggestion sets', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.suggestionsFor(TOPIC),
    ['What was decided?', 'Who is responsible for follow-ups?', 'Were any risks flagged?']);
  assert.deepStrictEqual(S.suggestionsFor(DAY),
    ['What were the safety issues?', 'Which actions are still open?', 'What was decided?']);
  assert.deepStrictEqual(S.suggestionsFor({}),
    ['What happened this week?', 'Which actions are overdue?']);
});

test('5b three contexts, three placeholders', () => {
  const S = loadScope();
  assert.strictEqual(S.placeholderFor(TOPIC), 'Ask about this topic…');
  assert.strictEqual(S.placeholderFor(DAY), 'Ask about this day…');
  assert.strictEqual(S.placeholderFor({}), 'Ask across all your projects…');
});

test('5c no suggestion is the fixture scaffold question', () => {
  const S = loadScope();
  [TOPIC, DAY, {}].forEach(function (ctx) {
    S.suggestionsFor(ctx).concat([S.placeholderFor(ctx)]).forEach(function (s) {
      assert.ok(!/scaffold/i.test(s), s);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: 5a-5c FAIL with `S.suggestionsFor is not a function`.

- [ ] **Step 3: Implement**

Append to the helper block:

```js
  function scopeKind(context) {
    var c = context || {};
    if (present(c.topicRowId)) return 'topic';
    return hasScope(c) ? 'day' : 'none';
  }

  var SCOPE_SUGGESTIONS = {
    topic: ['What was decided?', 'Who is responsible for follow-ups?', 'Were any risks flagged?'],
    day:   ['What were the safety issues?', 'Which actions are still open?', 'What was decided?'],
    none:  ['What happened this week?', 'Which actions are overdue?'],
  };
  var SCOPE_PLACEHOLDER = {
    topic: 'Ask about this topic…',
    day:   'Ask about this day…',
    none:  'Ask across all your projects…',
  };

  function suggestionsFor(context) { return SCOPE_SUGGESTIONS[scopeKind(context)].slice(); }
  function placeholderFor(context) { return SCOPE_PLACEHOLDER[scopeKind(context)]; }
```

Add `suggestionsFor: suggestionsFor, placeholderFor: placeholderFor,` to the export.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/ask-scoped-context.test.js scripts/composites/ask-chat.js
git commit -m "feat(ask): suggestions and placeholder derived from scope

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 5: Wire the helpers into `AskChat`: chips, scope lines, reset rekey, "Ask across everything", focus

**Files:**
- Modify: `scripts/composites/ask-chat.js`. Edits, top to bottom:
  - props doc comment, lines 12-32;
  - `AskChat` variables, 451-454;
  - effects, 476-503;
  - `send`, 525-630;
  - render, 639-760.
- Modify: `styles/composites.css` (append after the `.fs-ask-chat__form` rule block starting ~3557)
- Test: `tests/ask-scoped-context.test.js`

**Interfaces:**
- Consumes: `requestBodyFor`, `hasScope`, `chipsFor`, `basisLinesFor`, `suggestionsFor`, `placeholderFor` (Tasks 1-4).
- Produces (props on `window.FieldSight.AskChat`): `context` (object, optional), `onContextChange(nextContext)` (optional; chips render no remove button without it), `focusNonce` (number; when it changes to a truthy value, the Ask scrolls into view and focuses its input). The `scope` and `topic_id` props are removed.
- Assistant message shape gains:
  - `scopeResponse: {applied_scope}`, set only on agent answers;
  - `scoped: boolean`, whether the request carried a scope;
  - `question: string`.

- [ ] **Step 1: Write the failing wiring tests**

These only pin wiring; the behaviour is already driven by Tasks 1-4. They exist because a correct helper connected to nothing passes every test above. `ask-timezone-and-basis.test.js` calls that out as a pattern this repo has already shipped.

Append:

```js
/* ---- wiring: the helpers are what the component actually uses ----------- */

const askSrc = () => fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');

test('W1 the component sends requestBodyFor(context, ...) and no scope/topic_id', () => {
  const src = askSrc();
  const send = src.slice(src.indexOf('function send('), src.indexOf('function onSubmit('));
  assert.match(send, /requestBodyFor\(/);
  assert.doesNotMatch(send, /scope:\s/, 'send still passes scope');
  assert.doesNotMatch(send, /topic_id:\s/, 'send still passes topic_id');
});

test('W2 the reset effect is keyed on the four context fields', () => {
  const src = askSrc();
  const eff = src.slice(src.indexOf('When scope keys change'));
  const deps = eff.slice(0, eff.indexOf(']);') + 3);
  ['context.date', 'context.siteId', 'context.authorFolder', 'context.topicRowId']
    .forEach(k => assert.ok(deps.includes(k), 'reset effect missing ' + k));
  assert.doesNotMatch(deps, /\bscope, topic_id\b/);
});

test('W3 scope lines render from the stored response, above the answer text', () => {
  const src = askSrc();
  const at = src.indexOf('basisLinesFor(m.scopeResponse)');
  assert.ok(at > 0, 'basisLinesFor is not called with the stored response');
  assert.ok(at < src.indexOf('fs-ask-chat__msg-text fs-ask-chat__msg-text--md'));
  assert.doesNotMatch(src, /basisLinesFor\([^)]*context/);
});

test('W4 chips, the widen button and focus are wired', () => {
  const src = askSrc();
  assert.match(src, /chipsFor\(context,/);
  assert.match(src, /Ask across everything/);
  assert.match(src, /props\.onContextChange\(\{\}\)/);
  assert.match(src, /\[props\.focusNonce\]/);
  assert.match(src, /props\.suggestions \|\| suggestionsFor\(context\)/);
  assert.match(src, /props\.placeholder \|\| placeholderFor\(context\)/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: W1-W4 FAIL. Tasks 1-4 tests PASS.

- [ ] **Step 3: Update the props doc comment**

Replace lines 12-32 of the header comment (from `Two scoping modes:` through the `initialQuestion` entry) with:

```
   Scope (spec docs/specs/2026-09-15-one-ask-scoped.md): the HOST owns a
   `context` and AskChat only reads it. The request carries date / site_id /
   author_folder / topic_row_id; what was actually enforced comes back as
   `applied_scope` and is what the chips and scope lines show.

   Props:
     context         {date?, siteId?, siteName?, authorFolder?, authorName?,
                      topicRowId?, topicTitle?} — omitted = unscoped
     onContextChange function(nextContext) — chip removal / "Ask across
                     everything"; without it chips have no remove button
     focusNonce      number — a change scrolls the Ask into view and focuses
                     its input (Timeline's "Ask about this topic")
     user            folder-name string (optional — server handles default)
     placeholder     overrides placeholderFor(context)
     suggestions     overrides suggestionsFor(context)
     compact         boolean — tighter layout
     alertsProvider  optional programme alerts route (unchanged)
     initialQuestion optional string — auto-sends once on mount (Search's
                     "Ask FieldSight" hand-off).
```

Also fix the stale sentence at lines 65-67: `There are four mounts (three on Timeline, one in the search palette)` becomes `There are two mounts (Timeline and the search palette)`.

- [ ] **Step 4: Replace the component's variables and effects**

Replace lines 451-454 (`var date = ...` through `var topic_id = ...`) with:

```js
    var user    = props.user;
    var context = props.context || {};
```

Directly after `var listRef = React.useRef(null);` (~469), add:

```js
    var rootRef  = React.useRef(null);
    var inputRef = React.useRef(null);
    /* A question waiting to be re-sent once the host has applied a new
       context ("Ask across everything"). Sent from the reset effect, i.e.
       after the re-render, so it goes out with the NEW context rather than
       the one this render closed over. */
    var resendRef = React.useRef(null);
    /* The reset effect must not run on mount: it runs after the
       initialQuestion effect and would wipe the question that effect just
       added (palette hand-off). */
    var resetMountedRef = React.useRef(false);
```

Replace the reset effect at 499-503 with the version below. Keep the comment's first words exactly as they are, because `ask-panel-ux.test.js` slices on them.

```js
    /* When scope keys change (the host changed the context: a day/owner
       change, a pinned or removed topic, "Ask across everything"), drop
       history since prior context no longer applies. */
    React.useEffect(function () {
      if (!resetMountedRef.current) { resetMountedRef.current = true; return; }
      setMsgs([]);
      var pending = resendRef.current;
      if (pending) {
        resendRef.current = null;
        send(pending);
      }
    }, [context.date, context.siteId, context.authorFolder, context.topicRowId]);

    /* "Ask about this topic" — bring the one Ask into view and put the cursor
       in it. Smooth scroll only when the reader has not asked for reduced
       motion. */
    React.useEffect(function () {
      if (!props.focusNonce) return;
      var root = rootRef.current;
      var input = inputRef.current;
      var reduce = !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      if (root && root.scrollIntoView) {
        root.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      }
      if (input && input.focus) input.focus({ preventScroll: true });
    }, [props.focusNonce]);
```

- [ ] **Step 5: Change `send`**

Replace the call at 563-569:

```js
      window.FS.api.ask.ask({
        date:     date,
        ...
      }).then(function (res) {
```

with:

```js
      /* Captured at send time: the context may change while this is in flight. */
      var scopedRequest = hasScope(context);
      var body = requestBodyFor(context, question);
      body.user = user;   /* undefined is dropped on the wire */
      window.FS.api.ask.ask(body).then(function (res) {
```

In the assistant message object (581-602), directly after `zh:        askedInChinese(question),` (leave that line untouched), add:

```js
          /* What the backend says it enforced. Stored as a response-shaped
             object so the chips and scope lines read exactly what came back;
             `applied_scope` undefined = a backend that predates scoping. */
          scopeResponse: { applied_scope: res.applied_scope },
          scoped:        scopedRequest,
          question:      question,
```

- [ ] **Step 6: Change the render**

1. Just before `var className = ...` (~639), add:

```js
    var suggestions = props.suggestions || suggestionsFor(context);
    var lastAnswer = null;
    for (var li = msgs.length - 1; li >= 0; li--) {
      if (msgs[li].scopeResponse) { lastAnswer = msgs[li]; break; }
    }
    var chips = chipsFor(context, lastAnswer ? lastAnswer.scopeResponse : undefined);
```

2. On the root `React.createElement('div', { className: className },`, change the props to `{ className: className, ref: rootRef }`.

3. In the suggestions row (644-655) and the empty-state check (662-665), replace every `props.suggestions` with `suggestions`. Replace the empty-state text `'Ask anything grounded in this ' + (topic_id != null ? 'topic.' : 'report.')` with `placeholderFor(context)`.

4. In the message renderer, directly **after** the `formatAnswerBasis(m.basis, m.zh)` ternary block and **before** `m.role === 'assistant' ? renderWebOrigin(m) : null,`, add:

```js
            /* What the scope turned out to be. Above the answer for the same
               reason as the basis line: the reader learns the answer is not
               about what they were looking at BEFORE reading it. */
            m.role === 'assistant' && m.scopeResponse
              ? basisLinesFor(m.scopeResponse).map(function (line, li2) {
                  return React.createElement('div', {
                    key: 'scope-' + li2, className: 'fs-ask-chat__scope-line',
                  }, line);
                })
              : null,
```

5. Directly after `m.role === 'assistant' ? renderCitations(m.citations) : null,`, add:

```js
            /* A scoped answer that found nothing: offer the same question
               across everything. The host clears the context; the reset
               effect re-sends once the new (empty) context has rendered. */
            m.role === 'assistant' && m.scoped && m.scopeResponse && !m.error
                && !(m.citations && m.citations.length) && props.onContextChange
              ? React.createElement('button', {
                  type: 'button',
                  className: 'fs-ask-chat__widen',
                  disabled: busy,
                  onClick: function () {
                    resendRef.current = m.question;
                    props.onContextChange({});
                  },
                }, 'Ask across everything')
              : null,
```

6. Directly before the `/* Input */` form (~741), add the chip row:

```js
      chips.length
        ? React.createElement('div', {
            className: 'fs-ask-chat__chips',
            role: 'group',
            'aria-label': 'This Ask is narrowed to',
          },
            chips.map(function (chip) {
              return React.createElement('span', {
                key: chip.kind,
                className: 'fs-ask-chip fs-ask-chip--' + chip.kind,
                title: chip.title || null,
              },
                chip.segments.map(function (s, si) {
                  return React.createElement(React.Fragment, { key: s.field },
                    si > 0
                      ? React.createElement('span', { className: 'fs-ask-chip__sep', 'aria-hidden': 'true' }, ' · ')
                      : null,
                    React.createElement('span', {
                      className: 'fs-ask-chip__seg'
                        + (s.enforced === false ? ' fs-ask-chip__seg--unenforced' : ''),
                      /* Not colour alone: struck through, and said in words. */
                      title: s.enforced === false ? 'Not applied to this answer' : null,
                    }, s.text,
                      s.enforced === false
                        ? React.createElement('span', { className: 'fs-sr-only' }, ' (not applied)')
                        : null));
                }),
                props.onContextChange
                  ? React.createElement('button', {
                      type: 'button',
                      className: 'fs-ask-chip__remove',
                      'aria-label': chip.kind === 'topic' ? 'Remove topic scope' : 'Remove day scope',
                      disabled: busy,
                      onClick: function () { props.onContextChange(chip.next); },
                    }, '×')
                  : null);
            }))
        : null,
```

7. On the input, add `ref: inputRef,` and change the placeholder to `placeholder: props.placeholder || placeholderFor(context),`.

Before relying on `fs-sr-only`, check that it exists: `grep -n "fs-sr-only\|\.sr-only" styles/*.css`. If there is no hit, add the CSS rule in Step 7 as well.

- [ ] **Step 7: CSS**

Append to `styles/composites.css` after the `.fs-ask-chat__form` rule block:

```css
/* One Ask, scoped (docs/specs/2026-09-15-one-ask-scoped.md) */
.fs-ask-chat__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.fs-ask-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  gap: 2px;
  padding: 2px 4px 2px 10px;
  font-size: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--surface-panel-muted);
  color: var(--text-secondary);
}
.fs-ask-chip__seg { white-space: nowrap; }
.fs-ask-chip__seg--unenforced {
  text-decoration: line-through;
  color: var(--text-tertiary);
}
.fs-ask-chip__sep { color: var(--text-tertiary); }
.fs-ask-chip__remove {
  font: inherit;
  min-width: 32px;
  min-height: 32px;
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  border-radius: var(--radius-full);
  cursor: pointer;
}
.fs-ask-chip__remove:hover { color: var(--text-primary); }
.fs-ask-chip__remove:focus-visible { outline: 2px solid var(--border-focus, var(--border-strong)); outline-offset: -2px; }
@media (pointer: coarse) {
  .fs-ask-chip__remove { min-width: 44px; min-height: 44px; }
}
.fs-ask-chat__scope-line {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}
.fs-ask-chat__widen {
  font: inherit;
  font-size: 12px;
  margin-top: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--surface-panel);
  color: var(--text-primary);
  cursor: pointer;
}
.fs-topic-detail__ask { margin-top: 8px; }
```

Before using `var(--border-focus)`, `var(--border-strong)` and `var(--surface-panel)`, confirm they exist: `grep -n "\-\-border-focus\|\-\-border-strong\|\-\-surface-panel:" styles/tokens.css`. Replace any missing token with one that exists; `--border-subtle`, `--surface-panel-muted` and `--text-tertiary` are already used by the `.fs-ask-chat__suggestion` rule at ~3341.

- [ ] **Step 8: Run the full suite**

Run: `node --check scripts/composites/ask-chat.js && node --test tests/*.test.js`
Expected: PASS, including W1-W4, `ask-panel-ux`, `ask-timezone-and-basis`, `ask-says-when-it-came-from-the-web`, `ask-timeout-and-retry` and `corroboration-did-not-search`.

- [ ] **Step 9: Mutation check**

Temporarily change the body line in `send` to `var body = Object.assign({ scope: 'both' }, requestBodyFor(context, question));`.
Run: `node --test tests/ask-scoped-context.test.js`
Expected: W1 FAILS. **Revert**, re-run, and confirm PASS.

- [ ] **Step 10: Commit**

```bash
git add scripts/composites/ask-chat.js styles/composites.css tests/ask-scoped-context.test.js
git commit -m "feat(ask): AskChat takes a host-owned scope context

Chips above the input (greyed when not in applied_scope), scope lines above
the answer, reset keyed on the context fields, 'Ask across everything' for
an empty scoped answer, and focusNonce to bring the Ask into view. Stops
sending scope/topic_id; no longer wipes the auto-sent question on mount.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 6: Timeline has one Ask with a page Provider (spec §5 tests 6, 7 and 8)

**Files:**
- Modify: `scripts/pages/timeline.js`:
  - helpers after `makeAlertsProvider` (~1038) and the stale comment at 1004-1015;
  - `TimelineMiddleColumn` hooks after `askPrefill` (2097) and mount #1 (2680-2707);
  - `DAILY_TABS`/`MEETING_TABS` (3012-3023);
  - `TimelineRightDetail` (4025-4291);
  - registry (4297-4300) and `module.exports` (4328-4365).
- Test: `tests/ask-scoped-context.test.js`

**Interfaces:**
- Consumes: `AskChat` props `context`, `onContextChange`, `focusNonce` (Task 5).
- Produces (module exports):
  - `DAILY_TABS`, `MEETING_TABS`;
  - `askContextForDay(report, date, routeUser) -> context`;
  - `askContextForLoadedDay(report, date, routeUser, fromPalette) -> context`, which returns `{}` when `fromPalette` is set;
  - `askContextWithTopic(current, topic, dayContext) -> context|null`;
  - `pinTopicAsk(askApi, topic, dayContext) -> boolean`;
  - `TopicAskButton(props: {topic, onAsk})`;
  - `TimelineAskProvider`;
  - `useTimelineAsk() -> {askContext, setAskContext, askFocusNonce, requestAskFocus}`.
- Registry: `PAGES['/timeline'] = { Provider: TimelineAskProvider, Middle, Right }`.

- [ ] **Step 1: Write the failing tests**

Append:

```js
/* ---- Timeline --------------------------------------------------------- */

function makeReactStub(extra) {
  return Object.assign({
    createElement(type, props) {
      const kids = Array.prototype.slice.call(arguments, 2);
      const flat = [].concat.apply([], kids).filter(k => k !== null && k !== undefined && k !== false);
      return { type: type, props: props || {}, children: flat };
    },
    useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; },
    useRef(v) { return { current: v }; },
    useEffect() {}, useLayoutEffect() {}, useContext() { return null; },
    useMemo(fn) { return fn(); }, useCallback(fn) { return fn; },
    Fragment: 'Fragment', memo(c) { return c; },
  }, extra || {});
}

function loadTimeline(reactExtra) {
  global.React = makeReactStub(reactExtra);
  global.window = {
    FieldSight: {},
    FS: { api: { folderName: n => String(n || '').trim().replace(/ /g, '_') } },
    AuthMock: { currentUser: null },
    location: { href: 'https://example.test/#/timeline' },
    addEventListener() {}, removeEventListener() {},
  };
  global.document = { addEventListener() {}, removeEventListener() {},
                      createElement() { return { style: {} }; } };
  delete require.cache[require.resolve('../scripts/pages/timeline.js')];
  const mod = require('../scripts/pages/timeline.js');
  return { mod: mod, page: global.window.FieldSight.PAGES['/timeline'] };
}

const timelineSrc = () => fs.readFileSync(require.resolve('../scripts/pages/timeline.js'), 'utf8');

/* ---- 6. one Ask on the page ------------------------------------------ */

test('6a the topic detail tabs have no ask tab', () => {
  const { mod } = loadTimeline();
  assert.ok(Array.isArray(mod.DAILY_TABS) && Array.isArray(mod.MEETING_TABS), 'tabs not exported');
  assert.ok(!mod.DAILY_TABS.some(t => t.key === 'ask'), 'DAILY_TABS still has ask');
  assert.ok(!mod.MEETING_TABS.some(t => t.key === 'ask'), 'MEETING_TABS still has ask');
});

test('6b the page registers a Provider', () => {
  const { page } = loadTimeline();
  assert.strictEqual(typeof page.Provider, 'function');
  assert.strictEqual(typeof page.Middle, 'function');
  assert.strictEqual(typeof page.Right, 'function');
});

test('6c the Provider holds only the four ask fields', () => {
  const { page } = loadTimeline({ createContext() { return { Provider: 'AskCtxProvider' }; } });
  const el = page.Provider({ children: 'kids' });
  assert.strictEqual(el.type, 'AskCtxProvider');
  assert.deepStrictEqual(Object.keys(el.props.value).sort(),
    ['askContext', 'askFocusNonce', 'requestAskFocus', 'setAskContext']);
});

test('6d exactly one AskChat mount remains in timeline.js', () => {
  const mounts = timelineSrc().match(/React\.createElement\(AskChat\b/g) || [];
  assert.strictEqual(mounts.length, 1, 'found ' + mounts.length + ' AskChat mounts');
});

/* ---- 7. Ask about this topic ------------------------------------------ */

test('7a the button is hidden for a topic without topic_row_id', () => {
  const { mod } = loadTimeline();
  assert.strictEqual(mod.TopicAskButton({ topic: { topic_id: 2 }, onAsk() {} }), null);
  assert.strictEqual(mod.TopicAskButton({ topic: null, onAsk() {} }), null);
});

test('7b the button renders and clicking it calls onAsk', () => {
  const { mod } = loadTimeline();
  let clicked = 0;
  const el = mod.TopicAskButton({ topic: { topic_row_id: 't' }, onAsk() { clicked++; } });
  assert.strictEqual(el.type, 'button');
  assert.deepStrictEqual(el.children, ['Ask about this topic']);
  el.props.onClick();
  assert.strictEqual(clicked, 1);
});

test('7c pinning sets topicRowId on the current day and bumps the focus nonce', () => {
  const { mod } = loadTimeline();
  const api = {
    askContext: DAY, askFocusNonce: 4, set: null,
    setAskContext(next) { this.set = next; },
    requestAskFocus() { this.askFocusNonce++; },
  };
  const ok = mod.pinTopicAsk(api,
    { topic_row_id: 'topic-uuid', topic_title: 'Morning commercial chase' },
    { date: '2026-09-03', authorFolder: 'Ben_UCPK2' });
  assert.strictEqual(ok, true);
  assert.strictEqual(api.set.topicRowId, 'topic-uuid');
  assert.strictEqual(api.set.topicTitle, 'Morning commercial chase');
  assert.strictEqual(api.set.siteName, 'UC PK', 'the current day scope is kept');
  assert.strictEqual(api.askFocusNonce, 5);
});

test('7d pinning from an empty or other-day context uses the topic\'s own day', () => {
  const { mod } = loadTimeline();
  const dayCtx = { date: '2026-09-04', authorFolder: 'Ben_UCPK2' };
  assert.deepStrictEqual(mod.askContextWithTopic({}, { topic_row_id: 't', topic_title: 'T' }, dayCtx),
    { date: '2026-09-04', authorFolder: 'Ben_UCPK2', topicRowId: 't', topicTitle: 'T' });
  assert.strictEqual(mod.askContextWithTopic(DAY, { topic_row_id: 't' }, dayCtx).date, '2026-09-04');
  assert.strictEqual(mod.askContextWithTopic(DAY, { topic_id: 1 }, dayCtx), null);
});

test('7e the topic detail header mounts the button; selecting a topic does not touch the context', () => {
  const src = timelineSrc();
  const right = src.slice(src.indexOf('function TimelineRightDetail('), src.indexOf('/* ---------- Register'));
  assert.match(right, /React\.createElement\(TopicAskButton/);
  assert.match(right, /pinTopicAsk\(/);
  /* Only the button changes the Ask context from this column. */
  assert.strictEqual((right.match(/setAskContext\(/g) || []).length, 0,
    'the right detail must go through pinTopicAsk, not set the context on selection');
});

/* ---- 8. day changes reset; palette hand-off is global ------------------ */

test('8a the loaded day builds a fresh context: no topic survives a day change', () => {
  const { mod } = loadTimeline();
  const report = { site_id: 'site-uuid', site: 'UC PK', user_name: 'Ben UCPK2' };
  const ctx = mod.askContextForLoadedDay(report, '2026-09-04', 'Ben_UCPK2', false);
  assert.deepStrictEqual(ctx, { date: '2026-09-04', siteId: 'site-uuid', siteName: 'UC PK',
    authorFolder: 'Ben_UCPK2', authorName: 'Ben UCPK2' });
  assert.ok(!('topicRowId' in ctx));
});

test('8b without report.site_id the site is omitted; owner falls back to the report name', () => {
  const { mod } = loadTimeline();
  const ctx = mod.askContextForDay({ site: 'UC PK', user_name: 'Ben UCPK2' }, '2026-09-03', undefined);
  assert.deepStrictEqual(ctx, { date: '2026-09-03', authorFolder: 'Ben_UCPK2', authorName: 'Ben UCPK2' });
  assert.deepStrictEqual(mod.askContextForDay(null, '2026-09-03', 'Ben_UCPK2'),
    { date: '2026-09-03', authorFolder: 'Ben_UCPK2' });
});

test('8c a question handed off from the palette stays global', () => {
  const { mod } = loadTimeline();
  assert.deepStrictEqual(
    mod.askContextForLoadedDay({ site_id: 's', site: 'UC PK', user_name: 'B' }, '2026-09-03', 'B', true),
    {});
});

test('8d the middle column wires the day reset and the palette rule', () => {
  const src = timelineSrc();
  const mid = src.slice(src.indexOf('function TimelineMiddleColumn('), src.indexOf('function SessionPicker('));
  assert.match(mid, /React\.useRef\(!!askPrefill\)/, 'palette hand-off is not remembered');
  assert.match(mid, /askContextForLoadedDay\(/);
  const eff = mid.slice(mid.indexOf('askContextForLoadedDay('));
  const deps = eff.slice(eff.indexOf('}, [') , eff.indexOf(']);') + 1);
  assert.match(deps, /\bdate\b/, 'day change does not reset the context');
  assert.match(deps, /askOwner/, 'owner change does not reset the context');
  assert.match(mid, /askFromPaletteRef\.current \? \{\} : askApi\.askContext/,
    'mount #1 can auto-send a palette question with a stale scope');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ask-scoped-context.test.js`
Expected:
- 6a fails with `tabs not exported`; 6b and 6c fail because Provider is undefined.
- 6d fails with `found 3 AskChat mounts`.
- 7a-7e and 8a-8d fail on missing exports or missing wiring.

- [ ] **Step 3: Add the Provider and pure helpers**

In `timeline.js`, replace the stale comment at 1004-1015 (`AskChat is mounted in THREE places...`) with:

```js
  /* ---- alerts Ask route (routing spec §3.5) ------------------------------
     Timeline has ONE AskChat (the day view, TimelineMiddleColumn); topic
     detail pins a topic onto it instead of mounting its own (spec
     2026-09-15-one-ask-scoped §3). The tasks still live at module scope,
     written by whichever view fetched them. An empty cache means the route
     does not exist and the question goes to the agent — the designed
     degradation, not a bug. */
```

Directly after the closing `}` of `makeAlertsProvider` (~1038), insert:

```js
  /* =====================================================================
     One Ask, scoped (docs/specs/2026-09-15-one-ask-scoped.md §3)
     ---------------------------------------------------------------------
     The page's single AskChat lives in the middle column, the "Ask about
     this topic" button lives in the right column; they share the context
     through this Provider (same slot TodayProvider uses, app-shell.js
     ~1365). It holds ONLY the ask context and a focus nonce — it does not
     move any existing Timeline state.

     createContext is guarded because Node tests load this file with a
     React stub that has none; without a context, useTimelineAsk returns an
     inert value and the page still renders. */
  var TimelineAskContext = (typeof React !== 'undefined' && React && React.createContext)
    ? React.createContext(null)
    : null;

  var NO_TIMELINE_ASK = {
    askContext: {},
    setAskContext: function () {},
    askFocusNonce: 0,
    requestAskFocus: function () {},
  };

  function TimelineAskProvider(props) {
    var refCtx   = React.useState({});
    var refNonce = React.useState(0);
    var value = {
      askContext:      refCtx[0],
      setAskContext:   function (next) { refCtx[1](next || {}); },
      askFocusNonce:   refNonce[0],
      requestAskFocus: function () { refNonce[1](function (n) { return n + 1; }); },
    };
    if (!TimelineAskContext) return React.createElement(React.Fragment, null, props.children);
    return React.createElement(TimelineAskContext.Provider, { value: value }, props.children);
  }

  function useTimelineAsk() {
    var v = (TimelineAskContext && React.useContext) ? React.useContext(TimelineAskContext) : null;
    return v || NO_TIMELINE_ASK;
  }

  /* The day scope for a loaded report. `report.site_id` exists only on the
     Aurora timeline path; without it the site is omitted entirely (the chip
     shows date + owner and the request carries no site_id). */
  function askContextForDay(report, date, routeUser) {
    var ctx = {};
    if (date) ctx.date = date;
    if (report && report.site_id) {
      ctx.siteId = report.site_id;
      if (report.site) ctx.siteName = report.site;
    }
    var folder = routeUser
      || (report && report.user_name && window.FS.api.folderName(report.user_name))
      || '';
    if (folder) ctx.authorFolder = folder;
    if (report && report.user_name) ctx.authorName = report.user_name;
    return ctx;
  }

  /* A question typed in the global palette stays global: when the page was
     opened by the palette's prefill hand-off, the first loaded day does not
     scope the Ask. */
  function askContextForLoadedDay(report, date, routeUser, fromPalette) {
    return fromPalette ? {} : askContextForDay(report, date, routeUser);
  }

  /* Current context + a pinned topic. A topic is only ever pinned alongside
     its own day, so when the current context is empty (palette hand-off,
     day chip removed) or on another day, the topic's day scope is used. */
  function askContextWithTopic(current, topic, dayContext) {
    if (!topic || !topic.topic_row_id) return null;
    var day = dayContext || {};
    var base = (current && current.date && current.date === day.date) ? current : day;
    return Object.assign({}, base, {
      topicRowId: topic.topic_row_id,
      topicTitle: topic.topic_title || '',
    });
  }

  function pinTopicAsk(askApi, topic, dayContext) {
    var next = askContextWithTopic(askApi.askContext, topic, dayContext);
    if (!next) return false;
    askApi.setAskContext(next);
    askApi.requestAskFocus();
    return true;
  }

  /* Meeting topics carry no topic_row_id → no button; the day Ask still
     covers their day. */
  function TopicAskButton(props) {
    if (!props.topic || !props.topic.topic_row_id) return null;
    return React.createElement('button', {
      type: 'button',
      className: 'fs-btn fs-btn--secondary fs-btn--sm fs-topic-detail__ask',
      onClick: function () { props.onAsk(); },
    }, 'Ask about this topic');
  }
```

- [ ] **Step 4: Middle column: day reset, palette rule, rewire mount #1**

Directly after `var askPrefill = refAskPrefill[0];` (2097), which is still above every early return, insert:

```js
    /* One Ask, scoped — the viewed day/site/owner is the default scope.
       Reset whenever the loaded day or owner changes (which also ends a
       pinned topic). Selecting a topic does NOT change it; only the topic
       detail's "Ask about this topic" button does. */
    var askApi = useTimelineAsk();
    var askFromPaletteRef = React.useRef(!!askPrefill);
    var askReport = state.report;
    var askReportReady = !!(askReport && !askReport._notFound && !askReport.available_users);
    var askOwner = user || (askReportReady && askReport.user_name) || '';
    React.useEffect(function () {
      if (state.status === 'loading') return;
      var fromPalette = askFromPaletteRef.current;
      askFromPaletteRef.current = false;
      askApi.setAskContext(askContextForLoadedDay(askReportReady ? askReport : null,
                                                  date, user, fromPalette));
    }, [state.status, date, askOwner, askReportReady && askReport.site_id]);
```

Replace mount #1 (2680-2707, from the `/* Per-report Ask Agent` comment through `) : null,`) with:

```js
      /* The page's one Ask (spec 2026-09-15-one-ask-scoped). Scoped to this
         day · site · owner by default; topic detail pins a topic onto it.
         While a palette hand-off is pending the context is forced to {} for
         this render: AskChat's mount effect auto-sends before this column's
         reset effect has run, and must not send the previous day's scope. */
      AskChat ? React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'fs-timeline-page__section-label' },
          'Ask agent'),
        React.createElement(AskChat, {
          user:            user || (report && report.user_name && window.FS.api.folderName(report.user_name)),
          context:         askFromPaletteRef.current ? {} : askApi.askContext,
          onContextChange: askApi.setAskContext,
          focusNonce:      askApi.askFocusNonce,
          /* Supplied only when the programme actually loaded. AskChat treats
             an absent provider as "this route does not exist", so a failed
             fetch degrades to the agent rather than to a wrong answer.

             `silent` is passed as null unless the suggestion fetch used
             state:'all' — programmeMentions refuses to claim silence without
             that coverage, and flattening it here would undo the refusal. */
          alertsProvider:  makeAlertsProvider(suggestions),
          compact:         true,
          initialQuestion: askPrefill,
        }),
      ) : null,
```

`placeholder` and `suggestions` are removed on purpose, which also drops the fixture-only `scaffold inspection` suggestion. AskChat now derives both from the context.

- [ ] **Step 5: Remove the ask tabs and mounts #2/#3; add the topic button**

Delete `{ key: 'ask',        label: 'Ask' },` from `DAILY_TABS` (3018) and `{ key: 'ask',      label: 'Ask' },` from `MEETING_TABS` (3022).

In `TimelineRightDetail`:
- Directly after `var setActions = refActions[1];` (4036), which is before any early return, add `var askApi = useTimelineAsk();`.
- Delete `var AskChat        = fs.AskChat;` (4110).
- In the meeting `bodyByTab` (4155-4170), delete the whole `ask:` entry (4157-4169). In the daily `bodyByTab` (4172-4209), delete the whole `ask:` entry (4196-4208), and remove the trailing comma it leaves after the `photos:` entry if your style requires it.
- In the header, directly after the `fs-topic-detail__metaline` div's closing `),` (~4260) and still inside `fs-topic-detail__header-main`, add:

```js
          React.createElement(TopicAskButton, {
            topic: topic,
            onAsk: function () {
              pinTopicAsk(askApi, topic, askContextForDay(
                { site_id: sel.site_id || null, user_name: sel.user_name },
                sel.date, sel.user));
              /* Single-column mobile: the middle column is hidden while a
                 topic is selected (app-shell.css `.has-selection`, max-width
                 48rem). Close the detail so the one Ask is on screen; the
                 focus effect runs after this same batched render. */
              if (window.matchMedia && window.matchMedia('(max-width: 48rem)').matches
                  && props.onClose) {
                props.onClose();
              }
            },
          }),
```

`sel.site_id` is set by the single-user daily `onSelect` (2531). `sel` has no site name, so a topic pinned from an empty context shows date + owner + topic, and the request still carries `site_id`.

- [ ] **Step 6: Register the Provider and export**

Replace the registry at 4297-4300 with:

```js
  window.FieldSight.PAGES['/timeline'] = {
    /* One Ask, scoped — shares the ask context between the middle column's
       AskChat and the right column's "Ask about this topic". */
    Provider: TimelineAskProvider,
    Middle:   TimelineMiddleColumn,
    Right:    TimelineRightDetail,
  };
```

Add to the `module.exports` object, after `buildSessionEmailDraft: buildSessionEmailDraft,`:

```js
      /* one Ask, scoped (spec 2026-09-15) */
      DAILY_TABS: DAILY_TABS,
      MEETING_TABS: MEETING_TABS,
      TimelineAskProvider: TimelineAskProvider,
      useTimelineAsk: useTimelineAsk,
      askContextForDay: askContextForDay,
      askContextForLoadedDay: askContextForLoadedDay,
      askContextWithTopic: askContextWithTopic,
      pinTopicAsk: pinTopicAsk,
      TopicAskButton: TopicAskButton,
```

- [ ] **Step 7: Run the full suite**

Run: `node --check scripts/pages/timeline.js && node --test tests/*.test.js`
Expected: PASS for everything. Timeline tests such as `timeline-own-day-first` load the file with `global.React = {}`; the `createContext` guard is what keeps them green.

- [ ] **Step 8: Mutation check (spec §5)**

Temporarily put `{ key: 'ask', label: 'Ask' },` back at the end of `DAILY_TABS`.
Run: `node --test tests/ask-scoped-context.test.js`
Expected: 6a FAILS with `DAILY_TABS still has ask`. **Revert**, re-run, and confirm PASS.

Then temporarily change the effect's `askContextForLoadedDay(..., fromPalette)` call to pass `false`, and change mount #1's context to `askApi.askContext`. Expected: 8d FAILS. **Revert**, re-run, and confirm PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/pages/timeline.js tests/ask-scoped-context.test.js
git commit -m "feat(timeline): one scoped Ask with a page Provider

TimelineAskProvider shares the ask context between the day view's AskChat
and a new 'Ask about this topic' button in topic detail. The day/owner
change resets the scope; a palette hand-off stays global. Removes the
topic and meeting-topic Ask tabs and their two AskChat mounts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 7: Search palette Ask is unscoped (spec §4)

**Files:**
- Modify: `scripts/composites/search-palette.js:348-358` (comment) and `:498-508` (mount)
- Test: `tests/ask-scoped-context.test.js`

**Interfaces:**
- Consumes: AskChat without `context` is unscoped (Task 5). Timeline's `askFromPaletteRef` rule (Task 6).

The palette is mounted by `app-shell.js` (~1490), outside `PageProvider` (~1424), so it cannot reach `TimelineAskContext`. The "hand-off sets `{}`" rule is therefore enforced on the Timeline side by `askFromPaletteRef` (Task 6), triggered by the `fs.ask.prefill` it already writes.

- [ ] **Step 1: Write the failing test**

Append:

```js
test('8e the palette mount passes no scope, no context and no suggestions', () => {
  const src = fs.readFileSync(require.resolve('../scripts/composites/search-palette.js'), 'utf8');
  const at = src.indexOf('React.createElement(window.FieldSight.AskChat');
  assert.ok(at > 0, 'palette AskChat mount not found');
  const mount = src.slice(at, src.indexOf('}),', at));
  assert.doesNotMatch(mount, /\bscope:/);
  assert.doesNotMatch(mount, /\bcontext:/);
  assert.doesNotMatch(mount, /\bsuggestions:/);
  assert.doesNotMatch(mount, /\btopic_id:/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/ask-scoped-context.test.js`
Expected: 8e FAILS on `/\bscope:/`.

- [ ] **Step 3: Implement**

In the palette mount at 498-508, delete the line `scope:           'both',`.

In the `doAsk` comment (348-358), after `...across the caller's whole ACL rather than one report).`, add:

```
       Unscoped by design (spec 2026-09-15-one-ask-scoped §4): no context, so
       the chips are empty and the placeholder reads "Ask across all your
       projects…". The fallback below hands the question to Timeline, which
       sees the prefill and keeps that first Ask global (askFromPaletteRef in
       pages/timeline.js) — a question typed in the global palette stays
       global.
```

- [ ] **Step 4: Run the full suite**

Run: `node --check scripts/composites/search-palette.js && node --test tests/*.test.js`
Expected: PASS. `ask-panel-ux` still finds exactly one Escape handler.

- [ ] **Step 5: Commit**

```bash
git add scripts/composites/search-palette.js tests/ask-scoped-context.test.js
git commit -m "feat(search): palette Ask sends no scope

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 8: Cache busters, load-order check, manual verification (spec §6)

**Files:**
- Modify: `app-shell-preview.html`:

| Line | From | To |
|---|---|---|
| 18 | `composites.css?v=120` | `?v=121` |
| 98 | `ask-chat.js?v=10` | `?v=11` |
| 127 | `search-palette.js?v=8` | `?v=9` |
| 239 | `api/ask.js?v=2` | `?v=3` |
| 349 | `pages/timeline.js?v=63` | `?v=64` |

Re-read each number before editing; another branch may have moved it.

- [ ] **Step 1: Bump only the busters of changed files**

Run `git diff --name-only origin/dev...HEAD` and bump exactly the files it lists that `app-shell-preview.html` loads. Leave every other number alone.

- [ ] **Step 2: Check the load order and syntax**

```bash
grep -n "api/index.js\|api/ask.js\|ask-chat.js\|search-palette.js\|pages/today.js\|pages/timeline.js\|app-shell.js" app-shell-preview.html
for f in scripts/api/ask.js scripts/composites/ask-chat.js scripts/composites/search-palette.js scripts/pages/timeline.js; do node --check "$f" || echo "FAIL $f"; done
node --test tests/*.test.js
git diff origin/dev -- tests/ask-timezone-and-basis.test.js
```

Expected:
- `api/ask.js` loads after `api/index.js`; nothing new registers onto `FS.api`.
- `pages/timeline.js` loads before `app-shell.js`.
- No `FAIL` lines, and the full suite passes.
- **The last command prints nothing**, meaning `ask-timezone-and-basis.test.js` is unchanged.
- `grep -n "components-preview" CLAUDE.md` confirms the showcase rule. No new L5 composite was added (`TopicAskButton` is page-internal), so `components-preview.html` needs no entry.

- [ ] **Step 3: Commit**

```bash
git add app-shell-preview.html
git commit -m "chore(preview): bump cache busters for scoped Ask files

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

- [ ] **Step 4: GATE — do not run Steps 5-6 until the backend is on TEST**

Confirm the backend scoped-Ask change is deployed to TEST (pipeline `develop` → `fieldsight-test`) by checking the `applied_scope` key:

```bash
# From the pipeline repo, on a deployed TEST ask-agent, per backend spec §6.1:
# the response JSON must contain "applied_scope".
```

If `applied_scope` is absent, **stop**: record the manual verification as deferred and do not merge to `dev`. An early UI shows "Searched all your projects" plus greyed chips, which is honest but not verifiable.

- [ ] **Step 5: Manual verification on dev (TEST), as Ben_UCPK2, Timeline 2026-09-03**

Serve the site (`python3 -m http.server 8765` or the dev Amplify branch) and open `app-shell-preview.html#/timeline?date=2026-09-03&user=Ben_UCPK2`. For every item, look at the rendered DOM, not the code (CLAUDE.md "How to verify").

1. `document.querySelectorAll('.fs-ask-chat').length === 1`. The day chip reads `Thu 3 Sep · UC PK · Ben_UCPK2`: the weekday is computed, and the spec's `Wed` was wrong. If `UC PK` is missing, `report.site_id` is absent on this path, so check that the request has no `site_id`.
2. Ask "Which actions are still open?". In DevTools Network, the `/ask` body has `date`, `site_id`, `author_folder`, `user` and `tz`, and has no `scope` or `topic_id`. Every citation is 2026-09-03 / UC PK, and there is no scope line. Remove the day chip, confirm the conversation clears, ask again, and check that citations span days.
3. Select topic "Morning commercial chase and landscaping cost escalation". Topic detail has no Ask tab and does show `Ask about this topic`. Click it: the topic chip `Topic: Morning commercial chase…` appears, the Ask scrolls into view and the input has focus. Ask "Who is responsible for follow-ups?"; the body carries `topic_row_id`, and the answer is about that topic. Selecting another topic afterwards leaves the chips unchanged.
4. From the topic scope, ask "what did we say last week?". The line `Answered for this topic's day, not the dates in your question` appears above the answer.
5. Open a meeting topic: there is no Ask button and no Ask tab.
6. Search palette (Cmd+K) → Ask: no chips, the placeholder reads `Ask across all your projects…`, and the body has no `date`, `site_id`, `author_folder` or `topic_row_id`. Force the palette fallback by running `delete window.FieldSight.AskChat` in the console before asking, then restoring it by reload after navigation. On Timeline the first Ask has no chips.
7. Stub an older backend: in the console, `var o = FS.api.ask.ask; FS.api.ask.ask = q => o(q).then(r => { delete r.applied_scope; return r; });`. Ask a question: `Searched all your projects` appears and every chip segment is struck through and greyed.
8. Empty scoped answer: on a day with no matching content, ask something unrelated. `Ask across everything` appears; clicking it clears the chips and re-sends the same question unscoped.
9. Resize to 390px wide and repeat step 3. The detail closes, the middle column shows, and the Ask input has focus.
10. Toggle dark theme and check that the chips, struck segments and scope line are legible. With `prefers-reduced-motion: reduce` emulated, the scroll in step 3 jumps instead of animating.

- [ ] **Step 6: Record the outcome**

Write the result of each numbered item, pass or fail with the observed value, into the PR description. If Step 4's gate blocked, state explicitly that browser verification is deferred and why.

---

## Self-Review

**Spec coverage:**
- §2 props and pure helpers: Tasks 1-5.
- §2 request, including the pass-through left unchanged: Task 1.
- §2 chips and enforcement: Tasks 2 and 5.
- §2 basis line table: Tasks 3 and 5.
- §2 conversation reset: Task 5 Step 4.
- §2 empty scoped answer: Task 5 Step 6.5.
- §2 suggestions and placeholder: Tasks 4 and 5.
- §3:
  - Provider and context: Task 6 Step 3.
  - initial context and `site_id` absence: Task 6 Steps 3-4, test 8b.
  - topic button and nonce: Task 6 Step 5, test 7.
  - "selecting a topic does not change context": test 7e.
  - day/owner reset: test 8a/8d.
  - palette hand-off `{}`: tests 8c/8d plus Task 7.
  - AggregatedDayView still has no Ask (untouched), and alertsProvider stays on mount #1: Task 6 Step 4.
- §4: Task 7.
- §5 tests 1-8: all present. Mutation checks: Task 1 Step 5, Task 3 Step 5 and Task 6 Step 8.
- §6: Task 8, gated.

**Found gaps and resolutions:**
- `api/ask.js` whitelisted body fields and would have silently dropped the new ones. Task 1 fixes this and test 1d covers it.
- AskChat's reset effect ran on mount after the auto-send effect, wiping the palette question. The mount guard is in Task 5.
- A child mount effect sends before the parent's reset effect. The `askFromPaletteRef` render-time `{}` is in Task 6.
- On mobile, the middle column is hidden while a topic is selected, so Task 6 closes the detail first.
- The spec's weekday is wrong (noted at the top).

**Placeholders:** none. Every code step shows its code, and every command has an expected result.

**Name consistency:**
- `askScope.{requestBodyFor, hasScope, shortDay, chipsFor, basisLinesFor, suggestionsFor, placeholderFor}`.
- Message fields `scopeResponse`, `scoped`, `question`.
- Timeline exports `askContextForDay`, `askContextForLoadedDay`, `askContextWithTopic`, `pinTopicAsk`, `TopicAskButton`, `TimelineAskProvider`, `useTimelineAsk`, `DAILY_TABS`, `MEETING_TABS`.
- Context API `{askContext, setAskContext, askFocusNonce, requestAskFocus}`.
- These are used identically across Tasks 1-8.
