# One Ask, scoped to what you are looking at — frontend

Status: design, revised after final review (2026-09-15). Frontend half of
`fieldsight-pipeline/docs/superpowers/specs/2026-09-15-scoped-ask-design.md` (the "backend
spec"), which owns the contract (§3 there) and the reasons (§0–§2 there). Ships only after that
backend is live in the target environment.

## 0. Today

Four `AskChat` mounts, one component (`scripts/composites/ask-chat.js`):

| # | Where | Line (dev `a1ad1a0`) | Sends |
|---|---|---|---|
| 1 | Timeline day, compact, "Ask agent" section | `timeline.js` 2686 (scaffold literal 2704) | date, user, scope both |
| 2 | Timeline topic detail, `ask` tab (`DAILY_TABS` 3012/3018) | `timeline.js` 4196 | + `topic_id` |
| 3 | Timeline meeting-topic detail, `ask` tab (`MEETING_TABS` 3020/3022) | `timeline.js` 4157 | + `topic_id` |
| 4 | Search palette Ask (Cmd+K) | `search-palette.js` 498 | scope both |

The backend reads none of the differences (backend spec §0). Verified safe to remove #2/#3: no
`?tab=` deep link (the detail tab is `useState('overview')`, set only by clicks), no test
references the ask tab, and `FS.api.ask.ask` has one caller (`ask-chat.js` 563).

## 1. Target

| Entry | Default scope | Can clear |
|---|---|---|
| Timeline Ask (#1, the only Timeline mount) | the viewed day · site · owner | yes |
| "Ask about this topic" button in topic detail | same Ask, plus the topic | yes (topic chip, then day chip) |
| Search palette Ask (#4) | none — everything the caller can see | n/a |

Mounts #2 and #3 are removed, with the `ask` entries in `DAILY_TABS` and `MEETING_TABS`.

## 2. `AskChat` changes

New props (the host owns the context; AskChat never mutates it):

```js
context: {
  date: 'YYYY-MM-DD',                 // optional
  siteId: 'uuid', siteName: '',       // optional; siteId may be absent (see §3)
  authorFolder: '', authorName: '',   // optional
  topicRowId: 'uuid', topicTitle: '', // optional; only alongside date
}
onContextChange: function (nextContext) {}
```

Pure helpers extracted from `ask-chat.js` and exported for tests:
`requestBodyFor(context, question)`, `chipsFor(context)`, `suggestionsFor(context)`,
`placeholderFor(context)`, `basisLinesFor(response)`.

* **Request.** `requestBodyFor` maps `date → date`, `siteId → site_id`,
  `authorFolder → author_folder`, `topicRowId → topic_row_id`, and **omits** absent fields (no
  `''`, no `null` — `api/ask.js` relies on `JSON.stringify` dropping `undefined`). AskChat stops
  passing `scope` and `topic_id`. `FS.api.ask.ask` itself stays a pass-through: it keeps
  forwarding `scope`/`topic_id` when a caller supplies them, so
  `tests/ask-timezone-and-basis.test.js` "ask still sends what it always sent" stays green and
  unchanged. `user` and `tz` are still sent.
* **Chips** above the input, from `chipsFor(context)`: a day chip
  `Wed 3 Sep · UC PK · Ben_UCPK2` (date + site name if any + owner; removed as one) and a topic
  chip `Topic: Morning commercial chase…`. Removing the topic chip → `onContextChange(context
  minus topic*)`; removing the day chip → `onContextChange({})` (a topic cannot outlive its day).
  No chips when `context` is empty.
* **Chips reflect what was enforced once an answer exists.** Before the first answer the chips
  show the request. After an answer, a chip whose field is not in `applied_scope` (or when
  `applied_scope` is absent entirely) renders struck-through/greyed, so the chip row and the basis
  line never disagree.
* **Basis line**, from `basisLinesFor(response)` — never from `context`:
  * `applied_scope` absent → `Searched all your projects` (backend not yet scoped).
  * each `dropped` entry → one muted line, per field and reason:

    | field | reason | copy |
    |---|---|---|
    | `topic_row_id` | `not_visible` / `invalid` | `Topic not available — answered for the day` |
    | `author_folder` | `not_visible` / `invalid` | `Couldn't narrow to this person — answered for the project and day` |
    | `site_id` | `not_visible` / `invalid` | `Couldn't narrow to this project` |
    | `date` | `invalid` | `Couldn't narrow to this day` |
    | `date` | `overridden_by_question` | `Used the dates in your question` |
    | `date` | `overridden_by_topic` | `Answered for this topic's day` |
    | `question_range` | `overridden_by_topic` | `Answered for this topic's day, not the dates in your question` |

    An unknown field/reason pair renders nothing (never a raw code).
* **Conversation reset.** The reset effect (`ask-chat.js` 501–503, keyed on `date, user, scope,
  topic_id`) keys on `context.date, siteId, authorFolder, topicRowId` instead.
* **Empty scoped answer.** A scoped answer with no citations shows `Ask across everything`,
  which calls `onContextChange({})` and re-sends the same question.
* **Suggestions** (`suggestionsFor`), unless an explicit `suggestions` prop overrides:
  * topic → `What was decided?` · `Who is responsible for follow-ups?` · `Were any risks flagged?`
  * day → `What were the safety issues?` · `Which actions are still open?` · `What was decided?`
  * none → `What happened this week?` · `Which actions are overdue?`
* **Placeholder** (`placeholderFor`): topic `Ask about this topic…`; day `Ask about this day…`;
  none `Ask across all your projects…`.

## 3. Timeline wiring

There is **no Timeline Provider today**: `PAGES['/timeline']` registers only `Middle` and `Right`
(`timeline.js` 4297–4300). The shell already supports a `Provider` slot (`app-shell.js` 1365),
used by Today (`today.js` 3118).

* Add `TimelineAskProvider` + `TimelineAskContext` and register it as the page's `Provider`,
  mirroring `TodayProvider`. It holds only `{askContext, setAskContext, askFocusNonce, requestAskFocus}` —
  it does not move any existing Timeline state.
* `TimelineMiddleColumn` sets the initial context whenever the loaded day/owner changes:
  `{date, siteId: report.site_id, siteName: report.site, authorFolder: route user or
  folderName(report.user_name), authorName: report.user_name}`. `report.site_id` exists only on
  the Aurora timeline path; when absent, `siteId`/`siteName` are omitted — the chip shows date +
  owner, the request omits `site_id`, and date + author are still enforced.
* Topic detail header gets `Ask about this topic`, shown only when the topic has
  `topic_row_id` (meeting topics carry none → no button; the day Ask still covers their day).
  Click → `setAskContext(current + {topicRowId, topicTitle})`, `requestAskFocus()`; mount #1
  scrolls into view and focuses its input when the nonce changes (single-column mobile: the same
  scroll in the middle column).
* Selecting a different topic does **not** change the Ask context; only the button does.
  Changing day or owner resets context to that day (ending a pinned topic).
* **Palette hand-off** (`search-palette.js` 363–377 routes a question to Timeline's mount #1 via
  `askPrefill`): the hand-off sets `askContext` to `{}` before prefilling, so a question typed in
  the global palette stays global. The chip row then shows nothing, and the user can re-scope by
  navigating.
* `AggregatedDayView` (site-wide fan-out) still mounts no Ask. `alertsProvider` stays on mount #1.

## 4. Search palette

Mount #4 passes no `context` and no `suggestions`; behaviour otherwise unchanged.

## 5. Tests (`node --test tests/*.test.js`)

New `tests/ask-scoped-context.test.js`:

1. `requestBodyFor`: each context field → its contract name; absent fields absent (not `''`,
   not `null`); `scope` and `topic_id` never present.
2. `chipsFor`: empty → none; day → one; topic → two; day without `siteId` → chip has no site
   segment; removing day clears topic.
3. `basisLinesFor`: absent `applied_scope` → `Searched all your projects`; every row of the §2
   table → its copy; unknown pair → nothing; full `applied_scope` → no line.
4. Chip enforcement: after a response lacking `author_folder` in `applied_scope`, the owner
   segment is marked not-enforced.
5. `suggestionsFor` / `placeholderFor`: three contexts → three outputs; none contains "scaffold".
6. Timeline: `DAILY_TABS` and `MEETING_TABS` have no `ask` key; the registry entry has a
   `Provider`.
7. Topic button: hidden without `topic_row_id`; click sets `topicRowId` and bumps the focus nonce.
8. Day change resets context and drops the topic; palette hand-off sets `{}`.

Existing: `tests/ask-timezone-and-basis.test.js` passes unchanged (it tests the pass-through).

Mutation checks: add `scope` to `requestBodyFor` → test 1 red; build the basis line from
`context` → test 3 red; remove the `ask` tab deletion → test 6 red.

## 6. Manual verification on dev (TEST), after the backend is on TEST

As Ben_UCPK2, Timeline 2026-09-03:

1. Exactly one Ask on the page; day chip `Wed 3 Sep · UC PK · Ben_UCPK2`.
2. "Which actions are still open?" → every citation is 2026-09-03 / UC PK; no basis warning.
   Remove the day chip, ask again → citations span days.
3. Topic "Morning commercial chase and landscaping cost escalation" → `Ask about this topic` →
   topic chip, input focused → "Who is responsible for follow-ups?" → answer about that topic.
4. From the topic scope ask "what did we say last week?" → basis line
   `Answered for this topic's day, not the dates in your question`.
5. Search palette → Ask → no chips; placeholder `Ask across all your projects…`; palette
   fallback to Timeline → no chips.
6. Against a backend without `applied_scope` (stub `FS.api.ask.ask`) → `Searched all your
   projects` and greyed chips.

## 7. Out of scope

Raising `report_chunks.topic_id` linkage (pipeline); scoping the Search list; a Today-page Ask
(none exists); site-aggregated day Ask.
