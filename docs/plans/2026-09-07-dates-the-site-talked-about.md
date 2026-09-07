# Dates the Site Talked About — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `critical_dates_and_deadlines` — 239 real entries the backend has always sent and nothing has ever read — on the Timeline day, ordered by a date this frontend can already resolve.

**Architecture:** One pure module under `scripts/api/` for ordering and labels, one section in `timeline.js`'s single-user day view, styles, and a fixture correction. No backend, no new endpoint, no library.

**Tech Stack:** Vanilla ES2017, in-browser Babel React. **No build step.** Tests: `node --test tests/*.test.js`.

**Spec:** `docs/specs/2026-09-07-dates-the-site-talked-about.md` — read §3 and §9 first; the first draft's central number was wrong by a factor of three.

## Global Constraints

- **Reuse `FS.api.resolveDeadline`.** Do not write a second date parser. `today-ordering.js:84-92` already rejected, in writing, the ISO-only split the first draft proposed.
- **`display` is the resolved day, not the words said.** 169 of 239 entries have a `display` that differs from `date_mentioned`. Rows render the resolved date; the original phrasing survives in `context`.
- **Unresolved entries keep payload order and sort last.** 55 of 239. Guessing a date puts an invention into a list people plan from.
- **Single-user day view only.** `AggregatedDayView` (`timeline.js:920`) has no photo mount and no Ask — "the slot the photos took" does not exist there. A second mount is a follow-up, and shipping without saying so would be a section that silently is not there.
- **Register new `FS.api` modules AFTER `scripts/api/index.js`** — that file assigns `window.FS.api` wholesale and anything earlier is silently wiped.
- **Bump the `?v=` of every file you change.** A stale `?v=` has made a working change read as broken three times in two days, including once where the tests were green and the browser showed the old behaviour.

---

### Task 1: Ordering and labels

**Files:**
- Create: `scripts/api/mentioned-dates.js`
- Test: `tests/mentioned-dates.test.js`

**Interfaces:**
- Produces: `FS.api.mentionedDates` with `orderEntries(entries, reportDate)`, `dateLabel(entry, reportDate)`, `showsUrgency(entry)`, `showsAuthor(entry, reportAuthor)`.

- [ ] **Step 1: Write the failing tests**

```javascript
'use strict';

/*
 * The dates a day's report says somebody mentioned.
 *
 * Measured across the whole prod corpus: 239 entries on 62 of the 99 reports
 * that carry topics, median 3 per report. 184 of them (77 %) resolve through
 * FS.api.resolveDeadline against the report's own date — NOT the 26 % the
 * spec's first draft claimed, which counted ISO literals in the lake rather
 * than what this frontend can do.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../scripts/api/index.js');
require('../scripts/api/today-adapter.js');   /* provides resolveDeadline */
const {
  orderEntries, dateLabel, showsUrgency, showsAuthor,
} = require('../scripts/api/mentioned-dates.js');

const DAY = '2026-02-09';               /* a Monday */
function e(over) {
  return Object.assign({
    date_mentioned: 'Wednesday', context: 'something',
    who_mentioned: 'Jarley Trainor', urgency: 'medium', type: 'deadline',
  }, over);
}

/* ---- ordering ------------------------------------------------------------ */

test('resolved dates come first, ascending', () => {
  const out = orderEntries([
    e({ date_mentioned: 'Next week', context: 'later' }),
    e({ date_mentioned: 'Tomorrow', context: 'sooner' }),
  ], DAY);
  assert.deepStrictEqual(out.map(x => x.context), ['sooner', 'later']);
});

test('a weekday name IS resolved — it is not an unorderable phrase', () => {
  // The first draft's central error. "Wednesday" against a Monday report
  // resolves to that week's Wednesday; treating it as unorderable would put
  // 121 of the corpus's 184 orderable entries into the unordered tail.
  const out = orderEntries([
    e({ date_mentioned: 'This afternoon', context: 'vague' }),
    e({ date_mentioned: 'Wednesday', context: 'dated' }),
  ], DAY);
  assert.deepStrictEqual(out.map(x => x.context), ['dated', 'vague']);
});

test('unresolved entries keep the order the extractor gave them', () => {
  const out = orderEntries([
    e({ date_mentioned: 'End of week', context: 'a' }),
    e({ date_mentioned: '3 months', context: 'b' }),
    e({ date_mentioned: 'This afternoon', context: 'c' }),
  ], DAY);
  assert.deepStrictEqual(out.map(x => x.context), ['a', 'b', 'c']);
});

test('nothing is dropped and the caller list is not mutated', () => {
  const input = [e({ date_mentioned: 'Tomorrow' }), e({ date_mentioned: 'ASAP' })];
  const out = orderEntries(input, DAY);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(input[0].date_mentioned, 'Tomorrow');
});

test('the order is total, so it does not reshuffle between renders', () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) items.push(e({ date_mentioned: 'Wednesday', context: 'c' + i }));
  const once = orderEntries(items, DAY).map(x => x.context);
  assert.deepStrictEqual(orderEntries(items, DAY).map(x => x.context), once);
});

test('an empty or absent list is not an error', () => {
  assert.deepStrictEqual(orderEntries([], DAY), []);
  assert.deepStrictEqual(orderEntries(undefined, DAY), []);
});

/* ---- labels: the real corpus, with expected values -------------------- */

test('the label is the RESOLVED day, not the words said', () => {
  // 169 of 239 entries have a display that differs from date_mentioned.
  // "Tomorrow" printed under a day header three weeks later is a trap.
  assert.strictEqual(dateLabel(e({ date_mentioned: 'Tomorrow morning' }), DAY), '2026-02-10');
  assert.strictEqual(dateLabel(e({ date_mentioned: 'Wednesday' }), DAY), '2026-02-11');
  assert.strictEqual(dateLabel(e({ date_mentioned: 'Next week' }), DAY), '2026-02-16');
});

test('an embedded ISO date wins, as the resolver already decides', () => {
  assert.strictEqual(
    dateLabel(e({ date_mentioned: 'Wednesday (2026-02-11)' }), DAY), '2026-02-11');
});

test('"Week of X or Y" takes the first date, and that is accepted not fixed', () => {
  // The resolver's existing behaviour, one entry in the corpus. The full
  // phrase stays visible in `context`; special-casing it here would be a
  // second resolver by another name.
  assert.strictEqual(
    dateLabel(e({ date_mentioned: 'Week of 2026-07-23 or 2026-07-27' }), DAY),
    '2026-07-23');
});

test('an unresolvable phrase shows verbatim — it is all the reader has', () => {
  ['This afternoon', 'End of week', '3 months', '21st', 'ASAP'].forEach(function (p) {
    assert.strictEqual(dateLabel(e({ date_mentioned: p }), DAY), p);
  });
});

test('a missing date_mentioned yields an empty label, never "undefined"', () => {
  assert.strictEqual(dateLabel(e({ date_mentioned: null }), DAY), '');
  assert.strictEqual(dateLabel({}, DAY), '');
  assert.strictEqual(dateLabel(null, DAY), '');
});

/* ---- chips --------------------------------------------------------------- */

test('only high urgency earns a chip', () => {
  // 115 of 239 are high, 93 medium, 31 low. A chip on medium marks two rows
  // in five, which marks nothing.
  assert.strictEqual(showsUrgency(e({ urgency: 'high' })), true);
  assert.strictEqual(showsUrgency(e({ urgency: 'medium' })), false);
  assert.strictEqual(showsUrgency(e({ urgency: 'low' })), false);
  assert.strictEqual(showsUrgency(e({ urgency: null })), false);
});

test('urgency is read case-insensitively', () => {
  assert.strictEqual(showsUrgency(e({ urgency: 'HIGH' })), true);
});

test('the author shows only when it is not the report author', () => {
  // On a single-author day it is the same name on every row, which is noise.
  assert.strictEqual(showsAuthor(e({ who_mentioned: 'Ben Lin' }), 'Jarley Trainor'), true);
  assert.strictEqual(showsAuthor(e({ who_mentioned: 'Jarley Trainor' }), 'Jarley Trainor'), false);
  assert.strictEqual(showsAuthor(e({ who_mentioned: null }), 'Jarley Trainor'), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/mentioned-dates.test.js`
Expected: FAIL — `Cannot find module '../scripts/api/mentioned-dates.js'`

- [ ] **Step 3: Write the module**

```javascript
/* ==========================================================================
   api/mentioned-dates.js — the dates a day's report says somebody named.

   `critical_dates_and_deadlines` has been on the wire since the report
   generator shipped and nothing in scripts/ has ever read it. 239 entries
   across 62 of the 99 prod reports that carry topics.

   Ordering reuses FS.api.resolveDeadline. It resolves 184 of those 239 (77 %)
   — weekday names, today/tomorrow, "next week", "within N days" — against the
   report's own date. The spec's first draft ordered only on ISO literals and
   put 121 orderable entries into the unordered tail; today-ordering.js:84-92
   had already rejected that exact split in writing.

   Registers as FS.api.mentionedDates.
   ========================================================================== */
(function () {
  'use strict';

  function resolved(entry, reportDate) {
    var api = window.FS && window.FS.api;
    if (!entry || !entry.date_mentioned || !api || !api.resolveDeadline) return null;
    var r = api.resolveDeadline(entry.date_mentioned, reportDate);
    return (r && r.absolute) ? r : null;
  }

  /* The resolved day when there is one, else the phrase verbatim.

     `display` rather than `absolute` because the resolver puts a time of day
     into display when the text had one, and that is information. For a purely
     relative phrase display IS the resolved date — which is the point: a row
     reading "Tomorrow" under a day header read three weeks later is a trap,
     and the words said survive in `context`. */
  function dateLabel(entry, reportDate) {
    if (!entry || !entry.date_mentioned) return '';
    var r = resolved(entry, reportDate);
    return r ? (r.display || r.absolute) : String(entry.date_mentioned);
  }

  /* Resolved first, ascending; the rest in payload order, after.

     The index tiebreak is what makes the comparator total — without it the
     list reshuffles between renders, which on a list people plan from reads
     as data changing. */
  function orderEntries(entries, reportDate) {
    return (entries || []).map(function (x, i) { return { x: x, i: i }; })
      .sort(function (a, b) {
        var ra = resolved(a.x, reportDate), rb = resolved(b.x, reportDate);
        if (ra && rb) {
          if (ra.absolute !== rb.absolute) return ra.absolute < rb.absolute ? -1 : 1;
          return a.i - b.i;
        }
        if (ra) return -1;
        if (rb) return 1;
        return a.i - b.i;
      })
      .map(function (o) { return o.x; });
  }

  /* 115 of 239 are high, 93 medium, 31 low. A chip on medium marks two rows in
     five, which marks nothing; a chip on low says "do not look here", which a
     chip cannot say quietly. */
  function showsUrgency(entry) {
    return String((entry && entry.urgency) || '').toLowerCase() === 'high';
  }

  /* Same name on every row of a single-author day is noise. */
  function showsAuthor(entry, reportAuthor) {
    var who = entry && entry.who_mentioned;
    return !!(who && String(who).trim() && who !== reportAuthor);
  }

  var mod = { orderEntries: orderEntries, dateLabel: dateLabel,
              showsUrgency: showsUrgency, showsAuthor: showsAuthor };
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.mentionedDates = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/mentioned-dates.test.js`
Expected: PASS (14 tests)

- [ ] **Step 5: Revert-check**

Change `resolved` to return null unless `/\d{4}-\d{2}-\d{2}/` matches the raw text — the first draft's ISO-only rule.

Expected: **exactly three** go red — `resolved dates come first, ascending`,
`a weekday name IS resolved`, and `the label is the RESOLVED day, not the words
said`. Verified by running it, not predicted: an earlier version of this line
said four, which is the kind of number that costs the next person a
head-scratch. Restore afterwards.

- [ ] **Step 6: Commit**

```bash
git add scripts/api/mentioned-dates.js tests/mentioned-dates.test.js
git commit -m "Order the dates a day mentioned, by a date this app can already resolve"
```

---

### Task 2: Fix the fixture's invented `type`

**Files:**
- Modify: `scripts/mock/daily-report.fixture.js` (~line 482)
- Test: `tests/mentioned-dates.test.js` (one added case)

`type: 'milestone'` is in the fixture. The generator's enum
(`lambda_report_generator.py:179`) is
`deadline|inspection|delivery|weather|meeting|other` and prod has never emitted
`milestone` — 239 entries, zero of them. v1 renders no `type`, so nothing breaks
either way; a mock teaching a value the backend cannot send is how the *next*
feature gets built against a shape that does not exist.

- [ ] **Step 1: Add the guard test**

```javascript
test('the fixture only uses types the generator can emit', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'mock', 'daily-report.fixture.js'), 'utf8');
  const block = src.slice(src.indexOf('critical_dates_and_deadlines'));
  const types = (block.slice(0, 2000).match(/type:\s*'([a-z]+)'/g) || [])
    .map(m => m.replace(/.*'([a-z]+)'.*/, '$1'));
  const allowed = ['deadline', 'inspection', 'delivery', 'weather', 'meeting', 'other'];
  types.forEach(t => assert.ok(allowed.includes(t), t + ' is not a type the generator emits'));
});
```

- [ ] **Step 2: Run — it fails on `milestone`**

- [ ] **Step 3: Change `milestone` to the value the entry actually is** (read its `context`; most are `deadline`), and re-run.

- [ ] **Step 4: Commit**

```bash
git commit -am "The fixture stops teaching a type the backend cannot send"
```

---

### Task 3: Render the section

**Files:**
- Modify: `scripts/pages/timeline.js`, `styles/composites.css`, `app-shell-preview.html`

**Interfaces:**
- Consumes: Task 1's module; `report.critical_dates_and_deadlines`, which reaches this scope unmodified — `report` is `results[0]` of `FS.api.timeline.getTimeline` (`timeline.js:1782`) and the field is passed through by `render_report_shape` on both the Aurora and legacy transports.

- [ ] **Step 1: Register the module**

In `app-shell-preview.html`, after `scripts/api/index.js` **and after `today-adapter.js`** (the module calls `resolveDeadline` at render time, but load order only has to satisfy `api/index.js`; keep it in the api block):

```html
  <!-- feat/mentioned-dates — the dates a day's report says somebody named.
       MUST load after api/index.js, which assigns window.FS.api wholesale. -->
  <script src="scripts/api/mentioned-dates.js?v=1"></script>
```

Bump `?v=` on `scripts/pages/timeline.js` and `styles/composites.css`.

- [ ] **Step 2: Add the section**

Directly after the photo section (`timeline.js:2418-2434`), inside
`TimelineMiddleColumn`, mirroring its shape:

```javascript
      /* ---- The dates this day named --------------------------------------
         `critical_dates_and_deadlines` has been on the wire since the report
         generator shipped and nothing read it: 239 entries across 62 of the
         99 prod reports that carry topics, 115 of them marked high urgency.

         Renders nothing when the field is absent or empty — an older report,
         a day nobody named a date on, or a graded caller viewing someone
         else's day, where the backend withholds the whole-day prose on
         purpose (lambda_org_api.py:6007, cross_user_clip). */
      (md && report.critical_dates_and_deadlines
          && report.critical_dates_and_deadlines.length)
        ? React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'fs-timeline-page__section-label' },
              'Dates mentioned (' + report.critical_dates_and_deadlines.length + ')'),
            React.createElement('ul', { className: 'fs-mentioned-dates' },
              md.orderEntries(report.critical_dates_and_deadlines, date)
                .map(function (x, i) {
                  return React.createElement('li', {
                    key: i, className: 'fs-mentioned-dates__row',
                  },
                    React.createElement('span', { className: 'fs-mentioned-dates__when' },
                      md.dateLabel(x, date)),
                    React.createElement('span', { className: 'fs-mentioned-dates__what' },
                      x.context || ''),
                    md.showsAuthor(x, report.user_name)
                      ? React.createElement('span', { className: 'fs-mentioned-dates__who' },
                          x.who_mentioned)
                      : null,
                    md.showsUrgency(x)
                      ? React.createElement('span', { className: 'fs-mentioned-dates__urgent' },
                          'High')
                      : null,
                  );
                })
            ),
          )
        : null,
```

with `var md = window.FS && window.FS.api && window.FS.api.mentionedDates;`
declared beside the existing `var PhotoGrid = window.FieldSight.PhotoGrid;`.

- [ ] **Step 3: Styles**

`.fs-mentioned-dates__when` gets `font-variant-numeric: tabular-nums` and a
fixed min-width so the dates form a column. The `High` chip is **amber, not
red** — red is bound to the SAFETY domain app-wide (CLAUDE.md) and these rows
are not safety. Pin the dark foreground: status scale tokens do not theme-flip.

- [ ] **Step 4: Run the suite**

Run: `node --test tests/*.test.js`
Expected: PASS, no existing test moves.

- [ ] **Step 5: Commit**

---

### Task 4: Verify in the browser

- [ ] **Step 1: Serve on a port proved free**

```bash
python -m http.server 8905
curl -s http://localhost:8905/scripts/api/mentioned-dates.js | grep -c orderEntries
```

A port held by another session serves **a different directory**, which reads
exactly like a stale file. The `curl` is the check, not a formality.

- [ ] **Step 2: Confirm the running code is the code you wrote**

```javascript
String(window.FS.api.mentionedDates.orderEntries).indexOf('resolveDeadline') >= 0
```

A stale `?v=` has made a working change read as broken three times in two days.

- [ ] **Step 3: Open a day that HAS entries**

`?dev=1#/timeline?date=<a fixture date with the field>`. Confirm: the count in
the header equals the rows; resolved rows show a date and unresolved ones show
their phrase; exactly the `high` rows carry a chip.

- [ ] **Step 4: Open a day that does not** — no section, no empty shell, no zero.

- [ ] **Step 5: Both themes.** Chip and dates legible in light and dark.

- [ ] **Step 6: PR to `dev`**, noting that the site-aggregated day view is
  deliberately not mounted and why.

---

## Deployment order

Tasks 1–4 are one PR. Nothing here touches a shared module: the new file is new,
and `timeline.js` gains one block after the photo section a parallel session
added earlier today — check that section is still where the plan says before
inserting, since that file is the busiest in the repo.
