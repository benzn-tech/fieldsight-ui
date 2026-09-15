# One Ask, scoped to what you are looking at — frontend

Status: design, not built. Frontend half of
`fieldsight-pipeline/docs/superpowers/specs/2026-09-15-scoped-ask-design.md` (the "backend
spec"), which owns the contract (§3 there) and the reasons (§0–§2 there). Ships only after that
backend is live in the target environment.

## 0. Today

Four `AskChat` mounts, one component (`scripts/composites/ask-chat.js`):

| # | Where | Line (dev `a1ad1a0`) | Sends |
|---|---|---|---|
| 1 | Timeline day, compact, "Ask agent" section | `timeline.js` ~2686 | date, user, scope both |
| 2 | Timeline topic detail, `ask` tab (`DAILY_TABS`) | `timeline.js` ~4196 | + `topic_id` |
| 3 | Timeline meeting-topic detail, `ask` tab (`MEETING_TABS`) | `timeline.js` ~4157 | + `topic_id` |
| 4 | Search palette Ask (Cmd+K) | `search-palette.js` ~498 | scope both |

The backend reads none of the differences (backend spec §0). The suggestion chips on #1 include
the fixture leftover "Any decisions about the scaffold inspection?", shown to every real user.

## 1. Target

| Entry | Default scope | Can clear |
|---|---|---|
| Timeline Ask (#1, the only Timeline mount) | the viewed day · site · owner | yes |
| "Ask about this topic" button in topic detail | same Ask, plus the topic | yes (topic chip, then day chip) |
| Search palette Ask (#4) | none — everything the caller can see | n/a |

Mounts #2 and #3 are removed, with the `ask` entries in `DAILY_TABS` and `MEETING_TABS`.

## 2. `AskChat` changes

New prop `context` (replaces the use of `scope`/`topic_id`, which stop being sent):

```js
context: {
  date: 'YYYY-MM-DD',          // optional
  siteId: 'uuid', siteName: '', // optional
  authorFolder: '', authorName: '', // optional
  topicRowId: 'uuid', topicTitle: '', // optional; requires date/site/author present
}
onContextChange: function (nextContext) {}   // host owns the context; AskChat never mutates it
```

* **Chips** above the input, from `context`:
  `Wed 3 Sep · UC PK · Ben_UCPK2` (day chip: date + site + owner, removed as one) and
  `Topic: Morning commercial chase…` (topic chip). Each has a remove (×) control.
  Removing the topic chip → `onContextChange(context minus topic*)`.
  Removing the day chip → `onContextChange({})` (a topic cannot outlive its day).
  No chips when `context` is empty — the palette looks as it does now.
* **Request** (`FS.api.ask.ask`): send `date`, `site_id`, `author_folder`, `topic_row_id` from
  `context`; stop sending `scope` and `topic_id`. Keep `user` (legacy path still reads it) and `tz`.
* **Answer basis line**: render from the response's `applied_scope`, not from `context`.
  * `applied_scope` absent → a muted line `Searched all your projects` (backend not yet
    scoped; never claim a scope that was not applied).
  * `applied_scope.dropped` non-empty → one muted line per reason:
    `not_visible` → `Topic not available — answered for the day`;
    `overridden_by_question` → `Used the dates in your question`.
* **Conversation reset**: the existing reset effect (keyed on `date, user, scope, topic_id`,
  `ask-chat.js` ~499) keys on the `context` fields instead. Changing scope starts a new
  conversation, as switching topics does today.
* **Empty scoped answer**: when a scoped answer comes back with no citations, show a
  `Ask across everything` link that calls `onContextChange({})` and re-sends the same question.
* **Suggestions**: hosts stop passing literals; AskChat picks from `context`:
  * topic present → `What was decided?` · `Who is responsible for follow-ups?` · `Were any risks flagged?`
  * day only → `What were the safety issues?` · `Which actions are still open?` · `What was decided?`
  * none → `What happened this week?` · `Which actions are overdue?`
  An explicit `suggestions` prop still overrides (tests, future hosts).
* **Placeholder** from `context`: topic → `Ask about this topic…`; day → `Ask about this day…`;
  none → `Ask across all your projects…`.

## 3. Timeline wiring

`TimelineMiddleColumn` (owns mount #1) and `TimelineRightDetail` (owns the topic detail) are
separate page slots (`app-shell.js`), so the topic button cannot set #1's state directly.

* Page-level context state lives in the Timeline Provider (the same provider both slots read).
  Initial value on every day/owner change: `{date, siteId, siteName, authorFolder, authorName}`
  from the loaded report (`report.site_id`, `report.site`, route `user`, `report.user_name`).
* Topic detail header gets an `Ask about this topic` button, shown only when the topic has a
  `topic_row_id` (meeting topics carry none — they get no button; the day Ask still covers
  their day). Click → set context `+ {topicRowId, topicTitle}`, scroll mount #1 into view,
  focus its input. On mobile (single column) the same action scrolls the middle column.
* Selecting a different topic does **not** change the Ask context; only the button does.
  Changing day or owner resets context to that day (and ends a pinned topic).
* `AggregatedDayView` (site-wide fan-out) still mounts no Ask — unchanged.
* `alertsProvider` stays on mount #1 only, as now.

## 4. Search palette

Mount #4 passes no `context` and no `suggestions`. Behaviour otherwise unchanged
(`initialQuestion`, keyed remount per question).

## 5. Tests (`node --test tests/*.test.js`)

Extend `tests/ask-panel-ux.test.js` or add `tests/ask-scoped-context.test.js`, over pure helpers
extracted from `ask-chat.js` (`chipsFor(context)`, `requestBodyFor(context, question)`,
`suggestionsFor(context)`, `basisLinesFor(response)`):

1. `requestBodyFor` maps each context field to its contract name; omits absent fields (no `''`,
   no `null`); never sends `scope` or `topic_id`.
2. `chipsFor`: empty → none; day → one chip; topic → two; removing day clears topic.
3. `basisLinesFor`: no `applied_scope` → `Searched all your projects`; each `dropped` reason →
   its line; a full `applied_scope` → no warning line.
4. `suggestionsFor`: three contexts → three lists; none contains "scaffold".
5. Timeline: rendering a daily topic detail produces no `AskChat` (the `ask` tab is gone from
   `DAILY_TABS` and `MEETING_TABS`); the page renders exactly one `fs-ask-chat`.
6. Topic button: hidden without `topic_row_id`; click sets context with `topicRowId`.
7. Changing date resets context and drops the topic.

Mutation check: re-add `scope` to `requestBodyFor` → test 1 red; render chips from `context`
instead of `applied_scope` for the basis line → test 3 red.

## 6. Manual verification on dev (TEST), after the backend is on TEST

As Ben_UCPK2, Timeline 2026-09-03:

1. Exactly one Ask on the page; day chip reads `Wed 3 Sep · UC PK · Ben_UCPK2`.
2. "Which actions are still open?" → every citation is 2026-09-03 / UC PK. Remove the day chip,
   ask again → citations span days.
3. Open topic "Morning commercial chase and landscaping cost escalation" → `Ask about this topic`
   → topic chip appears, input focused → "Who is responsible for follow-ups?" → answer is about
   that topic; basis shows no warning.
4. Search palette → Ask → no chips; placeholder `Ask across all your projects…`.
5. Point the dev site at a backend without `applied_scope` (or stub it) → answers carry
   `Searched all your projects`.

## 7. Out of scope

Raising `report_chunks.topic_id` linkage (pipeline); scoping the Search list; Today-page Ask
(none exists); site-aggregated day Ask.
