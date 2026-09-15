# To-do history where people edit, and a save that says it saved

Status: design, revised after final review (2026-09-15). Frontend only — no backend change.
Builds on `docs/specs/2026-08-30-todo-history-card.md` (the "card spec"). Read that first; this
document does not restate its rules, it says where they apply and closes the gaps it left open.

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

## 1. Scope

In:

* The card spec, implemented, on **Timeline action rows** and in **Today's detail panel**.
* A success acknowledgement for every field editor save (§4), and a failure toast for the one
  field editor that has none (Timeline `assignTo`).
* Refreshing an open history list after a save (§5).
* The mock fixture gains `session_kind` (§3.3).

Out:

* The Tasks page History tab keeps its current rendering, including its `No edits yet.` copy
  (it is a tab, not the card; the card spec's "no empty container" rule applies to the card).
  It does subscribe to §5's refresh.
* Check-off (the circle), bulk resolve, `TopicCorrectionPropagate.apply` (already toasts
  "Fixed N other places" and triggers `fs:timeline-refresh`), and Restore (already toasts
  "Restored") get no `Saved` toast and emit nothing new.
* Topic history: already reachable (Timeline topic detail → History). Unchanged.
* Any backend change.

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
  mirroring Tasks; `open` = the panel is showing that item. The two `TaskCard` list mounts
  (`today.js` ~2437, ~2496) do not change. `today-adapter.js` (~437) additionally stamps
  `sessionId` / `sessionKind` from the topic onto each task item (Today reads `/timeline`,
  which carries both).

Registration (CLAUDE.md "Registration & load order", "Showcase"):

* `<script>` tag in `app-shell-preview.html`'s composites block, and in any other entry HTML
  that loads composites (the plan must list them after grepping).
* A smoke render in `components-preview.html` with fixture props. That page loads no api chain,
  so the composite must render without `window.FS.api` (render the empty/closed state).

## 3. Reads

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
  Never `From the daily report` (that is a claim about the source) and never a time.

Fixture: `scripts/mock/daily-report.fixture.js` (~645) stamps a derived `session_id` only; stamp
`session_kind: 'extraction'` beside it, and give one fixture topic `session_kind: 'report'` with
`session_id: null`, so all four states are reachable under mocks (CLAUDE.md "a join needs both
halves in the fixture").

All other rendering rules are the card spec's §2–§3 verbatim.

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
| 1 | `timeline.js` `EditableText.commit` (~3368) | `updateContent` — topic title/summary, action text, findings, safety. **Also covers Today's title editor**, which mounts this same `fs.EditableText` (`today.js` ~2967); add **no** call in `today.js` for the title. Call `settleSave` before the glossary-candidates early return (~3383): the write happened even when the editor stays open for candidates |
| 2 | `today.js` `commitTaskField` (~2759) | `updateAction` — priority / status / deadline / responsible |
| 3 | `tasks.js` detail field commit (~950) | `updateAction` — same fields |
| 4 | `timeline.js` `assignTo` (~3585) | `updateAction({responsible})`. On `!ok` **and** in `.catch`, add the error toast shape used by site 2 (`(res && res.error) \|\| 'Could not update task'`), which this site lacks today |

Each site's pattern: `if (!settleSave(res, {table, id}).ok) { …existing failure handling… }`.

## 5. After a save, an open history is re-read

Transport: add `scripts/api/events.js` exposing `FS.events.on(name, fn) → off`, `emit(name, payload)`,
loaded **after** `api/index.js` in every entry HTML. Do not reuse `FS.actionsBus`: it is generic
transport, but every subscriber assumes the check-off payload (`today.js` ~1384, `tasks.js` ~271
bail on `!payload.checked`; `timeline.js` ~1159/2033/4063 on `payload.date`), so a `{table,id}`
payload would couple two contracts.

`settleSave` emits `content:edited {table, id}`. `TodoHistory` (while `open`) and `ContentHistoryPanel`
(`timeline.js` ~3460, used by Tasks and topic History) subscribe and re-fetch when both match.
Never append optimistically (card spec §5).

## 6. Tests (`node --test tests/*.test.js`)

`tests/todo-history.test.js` — pure helpers extracted from the composite (`provenanceFor(topic,
sessions)`, `versionsFor(edits)`, plus the request decisions):

1. Card spec acceptance 1–5 over fixture `{topic, sessions, edits}`.
2. The fourth state: `unknown` / absent kind with null id → no provenance line.
3. `open:false` for N hosts → neither `getSessions` nor `getContentHistory` called (spies).
4. Two opens with the same `(date, folder)` → one `getSessions` call; after the Timeline day
   fetch has populated the cached key, an open → **zero** calls.
5. `{_notFound}` history → identical output to empty, no toast.
6. NULL `actor_name` → `edited by someone`.

`tests/save-settlement.test.js`:

7. `settleSave` over `{row}` → `ok:true`, one toast, one `content:edited` with the given
   table/id; over `_accessDenied`, `_notFound`, `{error}`, `undefined` → `ok:false`, no toast,
   no emit.
8. Wiring pin (source scan, labelled as such — it pins wiring, not behaviour): each of the four
   §4 sites contains a `settleSave(` call; `today.js`'s title editor block does not.
9. `ContentHistoryPanel` / `TodoHistory` subscribed to `content:edited`: matching `{table,id}` →
   re-fetch; different id → none.

Mutation checks: drop the `open` guard → test 3 red; make `settleSave` return `ok:true` for
`_accessDenied` → test 7 red; delete one site's call → test 8 red.

## 7. Manual verification on dev (TEST)

As a user who may edit (e.g. Ben_UCPK2, UC PK, 2026-09-03):

1. Today → select a to-do → detail panel shows provenance + no version block. Network: one
   `sessions` and one `history` request, none before selecting.
2. Change its deadline → one `Saved` toast → the panel's history shows `deadline changed to …`
   attributed to the editor.
3. Timeline → same day → the same to-do's row → expand → the same version entry, and **no**
   `sessions` request on expand.
4. Edit a topic summary → one `Saved` toast. Edit Today's title → exactly one `Saved` toast.
5. Timeline OverviewTab → reassign a to-do → `Saved`; as a user who may not → error toast and the
   select reverts.
6. Tick a to-do done → no `Saved` toast.
