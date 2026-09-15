# To-do history where people edit, a save that says it saved, and a roomier day view

Status: design, revised after final review and extended with three user requests
(2026-09-15). Frontend, plus **one additive backend field** (§8.1).
Builds on `docs/specs/2026-08-30-todo-history-card.md` (the "card spec"). Read that first; this
document says where its rules apply, closes the gaps it left open, and **replaces its §3
numbering rule** (§3.4 below).

## 0. Why

Reported on dev, 2026-09-15: "editing a topic or a to-do leaves no history record". Measured,
the record exists — every edit lands in `content_edits`, and both history reads return it:

| Link | Evidence (TEST, `fieldsight_test`) |
|---|---|
| Write | Ben_UCPK2's 2026-09-15 10:23 NZ edit of topic `df023596…` summary is a `content_edits` row |
| Read, topic | `GET /api/org/content/topics/df023596…/history` as that user → 200, the edit |
| Read, to-do | `GET /api/org/content/action_items/2e3b17e0…/history` as that user → 200, its status edit |
| Render, topic | Timeline topic detail → History tab shows `summary · 2026/09/15 10:23 · edited by Ben_UCPK2` |

What the person could not do is *see* it from where they edited:

1. **A to-do's history is reachable from exactly one screen**, the Tasks page detail panel
   (`scripts/pages/tasks.js`, `actionItemHistoryProps`). Today's detail panel and the Timeline
   topic's action rows (`scripts/composites/action-item-row.js`) have no history entry point.
2. **A successful save is silent.** `EditableText.commit` (`timeline.js` ~3368) and Today's
   `commitTaskField` (`today.js` ~2759) toast only on failure; Timeline's assignee select
   (`timeline.js` `assignTo`, ~3585) does not even toast on failure — a 403 silently reverts.

Three further requests from the same review (user, 2026-09-15):

3. **An edited to-do should say so on Today's list** — show its version (`v2`, `v3`…) on the
   middle-panel card, not only inside the detail panel (§8).
4. **The middle panel is too narrow** (§9).
5. **Timeline's four stat tiles are too big**; the content below them is what matters (§10).

## 1. Scope

In:

* The card spec, implemented, on **Timeline action rows** and in **Today's detail panel**.
* A version chip on Today's middle-panel task card for any to-do at `v2` or later (§8), fed by a
  new `version` field on `/timeline` action items (§8.1).
* A success acknowledgement for every field editor save (§4), and a failure toast for the one
  field editor that has none (Timeline `assignTo`).
* Refreshing an open history list after a save (§5), and refreshing the version chip (§8.3).
* The mock fixture gains `session_kind` and `version` (§3.3, §8.1).
* Middle column: wider default and range (§9).
* Timeline day header: compact stat strip (§10).

Out:

* The Tasks page History tab keeps its current rendering, including its `No edits yet.` copy.
  It does subscribe to §5's refresh. Tasks-page rows get no version chip in this change.
* Check-off (the circle), bulk resolve, `TopicCorrectionPropagate.apply` (already toasts
  "Fixed N other places" and triggers `fs:timeline-refresh`), and Restore (already toasts
  "Restored") get no `Saved` toast and emit nothing new.
* Topic history: already reachable (Timeline topic detail → History). Unchanged.
* The stat tiles on any page other than Timeline (Insights, dashboards) — unchanged.
* Any backend change beyond §8.1.

## 2. One composite, two hosts

Add `scripts/composites/todo-history.js` exporting `window.FieldSight.TodoHistory`. It renders
the card spec's provenance line and version list — **not** the CURRENT line, which each host
already renders.

Props:

| Prop | Meaning |
|---|---|
| `actionItemId` | durable `action_items.id`. Absent (legacy rows) → render nothing, fetch nothing |
| `sessionId`, `sessionKind` | from the owning topic (`/timeline` `topics[].session_id`, `session_kind`) |
| `date`, `folder` | the report OWNER's day and folder — never the caller's |
| `open` | host-owned. **No request of any kind is made while `open` is false** |

Hosts:

* **Timeline** — `ActionItemRow` (mounted at `timeline.js` ~3744, which already passes `action`
  with `id`, `date`, `userFolder`). Add a disclosure control to the row; `open` = that row's
  disclosure state; expanded, `TodoHistory` renders beneath the row. The OverviewTab host passes
  the topic's `session_id` / `session_kind` as two new props.
* **Today** — the **right detail panel**, not `fs.TaskCard`. `TaskCard` is already
  click-to-select, batch-select and check-off, and all Today field editors live in the detail
  panel (`today.js` ~2759–2822, title editor ~2966). Mount `TodoHistory` beneath the field rows,
  mirroring Tasks; `open` = the panel is showing that item. `today-adapter.js` (~437)
  additionally stamps `sessionId` / `sessionKind` from the topic, and `version` from the action
  item (§8.1), onto each task item (Today reads `/timeline`, which carries all three).

Registration (CLAUDE.md "Registration & load order", "Showcase"):

* `<script>` tag in `app-shell-preview.html`'s composites block, and in any other entry HTML
  that loads composites (the plan must list them after grepping).
* A smoke render in `components-preview.html` with fixture props. That page loads no api chain,
  so the composite must render without `window.FS.api` (render the empty/closed state).

## 3. Reads and rendering

### 3.1 Sessions — one cached read per (date, owner), shared by every consumer

Add `FS.api.org.getSessionsCached(date, folder)` =
`FS.api.cache.cached('sessions:' + date + ':' + folder, undefined, () => getSessions({date, user: folder}))`.

* `TodoHistory` uses only this.
* **Timeline's existing day-level fetch (`timeline.js` ~1791) is switched to it**, so a Timeline
  day view that already loaded sessions makes expanding a card issue **zero** sessions requests.
* Today's `_sessionsFor(date)` (`today.js` ~416) calls `getSessions({date})` with no user and is
  a different key; leave it. Today's panel may issue one sessions read per (date, owner) the
  first time it shows that owner's item.

Response rows: `{session_id, started_at, ended_at, title, topic_count}`
(`lambda_org_api.build_day_sessions`).

### 3.2 History

`FS.api.actions.getContentHistory('action_items', actionItemId)`, fetched on each transition to
`open`, not cached. A `{_notFound}` envelope (history 404, `actions.js` ~518) renders exactly as
an empty list: no version block, no toast, no retry. `actor_name` may be NULL
(`content_edits.py` `NULLIF`); render `edited by someone` rather than `null`.

### 3.3 Provenance — four states, not three

The backend's `session_scope.session_ref` returns three kinds (`extraction`, `report`,
`unknown`). The card spec §2 covers extraction, report, and "extraction id not in sessions".
Add:

* **`session_kind: 'unknown'`, or absent, with a null id** → render **no provenance line**.
  Never `From the daily report` and never a time.

Fixture: `scripts/mock/daily-report.fixture.js` (~645) stamps a derived `session_id` only; stamp
`session_kind: 'extraction'` beside it, and give one fixture topic `session_kind: 'report'` with
`session_id: null`, so all four states are reachable under mocks.

### 3.4 Version numbering — replaces the card spec's §3 numbering

The card spec numbered **text** edits only. A chip on the list (§8) must agree with the list in
the card, and a to-do whose deadline moved *is* an updated to-do, so the numbering is now:

* **`v1` = the to-do as extracted.** Every `content_edits` row for the action item — any field
  (`text`, `status`, `priority`, `deadline`, `responsible`) — makes the next version.
  `version = 1 + (number of content_edits rows for this action item)`.
* The version list renders newest first: `vN … v2` one line per edit (text edits as the new
  text; other fields as sentences, card spec §3), then **`v1 · as recorded`** as the last line,
  showing the original text (the oldest text edit's `before_text`, or the current text when the
  text was never edited).
* A to-do with no edits is `v1`: no version block (card spec's "empty list is the normal case").
* The top of the list and the chip show the same `N`. If history returns a different count than
  the `version` the list was rendered with (an edit landed in between), the history read wins
  and the host's chip is updated from it (§8.3).

## 4. Save outcome: one function decides, every site calls it

Add to `scripts/api/actions.js`:

```js
/* Returns {ok}. ok === true only for a resolved, non-denied, non-error envelope.
   On ok: shows the 'Saved' toast and emits content:edited {table, id}. On !ok: does nothing —
   the caller keeps its own existing failure handling. */
settleSave(res, { table, id })
```

`ok` is false for: falsy `res`, `res._accessDenied`, `res._notFound`, `res.error`. A thrown save
never reaches `settleSave` (callers' `.catch` paths are unchanged). The toast literal
(`{message: 'Saved', tone: 'success', duration: 2000}`) exists only here.

Call sites — exactly these:

| # | Site | Save |
|---|---|---|
| 1 | `timeline.js` `EditableText.commit` (~3368) | `updateContent` — topic title/summary, action text, findings, safety. **Also covers Today's title editor**, which mounts this same `fs.EditableText` (`today.js` ~2967); add **no** call in `today.js` for the title. Call `settleSave` before the glossary-candidates early return (~3383) |
| 2 | `today.js` `commitTaskField` (~2759) | `updateAction` — priority / status / deadline / responsible |
| 3 | `tasks.js` detail field commit (~950) | `updateAction` — same fields |
| 4 | `timeline.js` `assignTo` (~3585) | `updateAction({responsible})`. On `!ok` **and** in `.catch`, add the error toast shape used by site 2 (`(res && res.error) \|\| 'Could not update task'`) |

Each site's pattern: `if (!settleSave(res, {table, id}).ok) { …existing failure handling… }`.

## 5. After a save, an open history is re-read

Transport: add `scripts/api/events.js` exposing `FS.events.on(name, fn) → off`, `emit(name, payload)`,
loaded **after** `api/index.js` in every entry HTML. Do not reuse `FS.actionsBus`: every
subscriber assumes the check-off payload (`today.js` ~1384, `tasks.js` ~271 bail on
`!payload.checked`; `timeline.js` ~1159/2033/4063 on `payload.date`).

`settleSave` emits `content:edited {table, id}`. `TodoHistory` (while `open`) and
`ContentHistoryPanel` (`timeline.js` ~3460, used by Tasks and topic History) subscribe and
re-fetch when both match. Never append optimistically (card spec §5).

## 6. Tests (`node --test tests/*.test.js`)

`tests/todo-history.test.js` — pure helpers extracted from the composite (`provenanceFor(topic,
sessions)`, `versionsFor(edits, currentText)`, plus the request decisions):

1. Card spec acceptance 1–4 over fixture `{topic, sessions, edits}`.
2. The fourth provenance state: `unknown` / absent kind with null id → no provenance line.
3. `open:false` for N hosts → neither `getSessions` nor `getContentHistory` called (spies).
4. Two opens with the same `(date, folder)` → one `getSessions` call; after the Timeline day
   fetch has populated the cached key, an open → **zero** calls.
5. `{_notFound}` history → identical output to empty, no toast.
6. NULL `actor_name` → `edited by someone`.
7. §3.4 numbering: edits `[text, deadline, status]` (newest first from the server) →
   `v4 text…`, `v3 deadline changed…`, `v2 status changed…`, `v1 · as recorded` with the oldest
   text edit's `before_text`; no text edit → `v1` shows the current text; no edits → no block.

`tests/save-settlement.test.js`:

8. `settleSave` over `{row}` → `ok:true`, one toast, one `content:edited`; over `_accessDenied`,
   `_notFound`, `{error}`, `undefined` → `ok:false`, no toast, no emit.
9. Wiring pin (source scan, labelled as such): each of the four §4 sites contains a
   `settleSave(` call; `today.js`'s title editor block does not.
10. `ContentHistoryPanel` / `TodoHistory` subscribed to `content:edited`: matching `{table,id}` →
    re-fetch; different id → none.

Version chip, width, stat strip: see §8.4, §9.3, §10.3.

Mutation checks: drop the `open` guard → test 3 red; make `settleSave` return `ok:true` for
`_accessDenied` → test 8 red; delete one site's call → test 9 red; number text edits only → test 7 red.

## 7. Manual verification on dev (TEST)

As a user who may edit (e.g. Ben_UCPK2, UC PK, 2026-09-03):

1. Today → select a never-edited to-do → detail panel shows provenance and no version block; its
   card shows no version chip. Network: one `sessions` and one `history` request, none before
   selecting.
2. Change its deadline → one `Saved` toast → the panel lists `v2 · deadline changed to …` over
   `v1 · as recorded` → **the card in the middle panel now shows `v2`** without a page reload.
3. Timeline → same day → the same to-do's row → expand → the same two entries, **no** `sessions`
   request on expand.
4. Edit a topic summary → one `Saved` toast. Edit Today's title → exactly one `Saved` toast.
5. Timeline OverviewTab → reassign a to-do → `Saved`; as a user who may not → error toast and the
   select reverts.
6. Tick a to-do done → no `Saved` toast.
7. Reload Today → the edited to-do still shows `v2` (served by `/timeline`, §8.1).
8. Middle column opens at the new default width on a browser that had the old width saved (§9).
9. Timeline day header: the four stats sit on one short row above Topics (§10).

## 8. Version chip on Today's middle-panel card

### 8.1 Backend — `version` on `/timeline` action items (fieldsight-pipeline)

Additive; nothing else in the payload changes.

* `repositories/topics.py`, in the read path that loads `action_items` for the day
  (`list_topics_for_*`, the `SELECT … FROM action_items WHERE topic_id = ANY(%s)` at ~473): one
  further batch query —
  `SELECT row_id, count(*) FROM content_edits WHERE table_name = 'action_items' AND row_id = ANY(%s) [AND company_id = %s] GROUP BY row_id`
  — over the ids of the items **after** the todo collapse (the survivor's id; `collapsed_ids`
  are not counted, matching what `GET …/history` returns for the survivor). Served by
  `idx_content_edits_row (table_name, row_id, created_at)` (migration 0019). Include the
  `company_id` predicate when the caller passes one, so the count agrees with
  `list_content_edits` (company-scoped).
* `lambda_org_api.render_report_shape` (~6209): add `"version": 1 + count` to each action item
  in the fixed allowlist. The comment above that allowlist records that fields dropped there
  once passed every repository test — so the test is on the **rendered** shape (below).
* No N+1: one query per day read regardless of item count.

Tests (pytest, FakeConn): an item with 0 edits → `version: 1`; with 3 → `4`; a collapsed pair
→ survivor's count only; the serialized `/timeline` response carries `version` (rendered shape,
not repository output). The count query is executed against a real Postgres (Data API, rolled-back
transaction) before merge. Mock fixture: `daily-report.fixture.js` action items gain
`version` (most `1`, one `2`, one `3`) so the chip is visible offline.

Rollout: backend to TEST before the UI reads it; the UI treats a missing `version` as `1`
(no chip), so an early UI deploy shows nothing wrong.

### 8.2 Placement

`TaskCard`'s bottom meta row (`task-card.js` ~305–340) already holds, left to right,
`raised N×`, `Possibly personal`, the status badge, and the due time. The chip goes **first in
that row**, before `raised N×`:

```
◯  Roofing price — confirm 530 figure with Aaron
   [v2] [raised 3×] [Open]  Fri 5 Sep
```

Why there, not beside the title: titles wrap to two lines at this width, so a trailing chip
jumps between line ends from card to card; the meta row is one line with a fixed left edge,
so every card's chip lands in the same place and scans as a column. Why first: it is the
freshest fact about the card — "someone changed this" — and `raised N×` explains the sort
order, which reads naturally after it.

* Rendered only when `task.version >= 2`. Text `v{N}`. `Badge` tone `neutral`, variant
  `outline`, size `sm` — deliberately quieter than status: it signals "this changed", not
  "act on this".
* `title` tooltip: `Edited {N-1} time(s) — open to see history`.
* Clicking the chip behaves like clicking the card body (opens the detail panel, where the
  history is); in batch mode it behaves like the row (selects). No separate handler.
* `aria-label`: `Version {N}, edited {N-1} time(s)`.

### 8.3 Keeping the chip current

On `content:edited {table:'action_items', id}` Today's provider bumps that item's `version` by
one immediately (the save succeeded, so an edit row exists), and when the open panel's history
read returns, sets `version = 1 + edits.length` (authoritative, §3.4). No refetch of the day.

### 8.4 Tests

In `tests/todo-history.test.js` (or a `task-card` test): `versionChipFor(task)` → null for
`undefined`, `1`; `{text:'v2', …}` for `2`; tooltip and aria text pluralise (`1 time`,
`2 times`). Adapter: `today-adapter.js` copies `version` from the action item and defaults to 1.
Provider: a matching `content:edited` bumps only that item. Mutation: render the chip at
`version >= 1` → red.

## 9. Middle column width

### 9.1 Change

| | Now | New |
|---|---|---|
| Default (`MIDDLE_WIDTH_DEFAULT`, `app-shell.js` 15) | 320 | **420** |
| Minimum (`MIDDLE_WIDTH_MIN`, 764; CSS `.middle-column` `min-width`, `app-shell.css` 51) | 280 | **360** |
| Maximum (`MIDDLE_WIDTH_MAX`, 765; CSS `max-width`, 52) | 480 | **640** |

JS constants and CSS limits change together — they are two copies of one rule.

### 9.2 Saved widths

The width persists under `fs.appshell.middleWidth` (`app-shell.js` 9, read at 1156). A browser
that saved the old default keeps 320 forever, so nobody who has used the app would see the
change. Rename the key to **`fs.appshell.middleWidth.v2`**; the old key is ignored (not
migrated — a width chosen inside the old 280–480 range is not a preference about the new one).
Any stored value outside the new range is clamped by the existing `DragDivider.clamp`.

Unchanged: mobile (`app-shell.css` ~177, `width:100% !important`, no resize handle) and print
(~905). No other script reads the key (grepped).

### 9.3 Tests / verification

A test over the exported constants: default within [min, max], and the CSS `min-width` /
`max-width` in `app-shell.css` equal the JS min / max (source read — pins that the two copies
agree). Manual: with `fs.appshell.middleWidth=320` in localStorage, reload → 420; drag → clamps
at 360 and 640; right detail still usable at a 1280px viewport with max width.

## 10. Timeline stat strip

### 10.1 Now

Timeline's day header renders `KpiStrip` with four `StatCard`s — Topics, Safety, Recordings,
Recorded (`timeline.js` ~825). `StatCard` is a column tile: `padding: 16px`, value 22px, label
below (`composites.css` 763–790). At the day header it takes more height than the topic list's
first card, above the content people came for.

### 10.2 Change

Add a `compact` variant, used **only** by this Timeline strip:

* `KpiStrip` prop `compact` → class `fs-kpi-strip--compact`; each `StatCard` inside renders as a
  single inline row: **value then label on one baseline** (`1 TOPICS`), `padding: 6px 10px`,
  value `15px` bold tabular, label unchanged 11px uppercase, `gap: 6px`, strip `gap: 6px`,
  target row height ~34px (from ~70px).
* Tone colours (Safety `danger` when > 0) are kept — the one number that should catch the eye
  still does.
* The mobile 2-column wrap (`composites.css` ~8166) keeps working: the compact tiles wrap to two
  per row at phone width.
* The CSS is scoped under `.fs-kpi-strip--compact`; the base `.fs-stat-card` rules are not
  edited, so Insights and the strategic dashboards are unaffected.

### 10.3 Tests / verification

Timeline renders `KpiStrip` with `compact: true`; no other `KpiStrip` mount passes it (source
scan, labelled as a wiring pin). `components-preview.html` shows the compact strip beside the
default one. Manual: Timeline 2026-09-03 → the stat row is a single short line; Insights tiles
look exactly as before; phone width wraps to two per row.
