# To-do history where people edit, and a save that says it saved

Status: design, not built. Frontend only — no backend change.
Builds on `docs/specs/2026-08-30-todo-history-card.md` (the "card spec"). Read that first; this
document does not restate its rules, it says where they apply and closes two gaps it left open.

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
   (`scripts/pages/tasks.js`, `actionItemHistoryProps`). Today (`scripts/pages/today.js`, which
   renders `fs.TaskCard`) and the Timeline topic's action rows (`scripts/composites/action-item-row.js`)
   have no history entry point at all.
2. **A successful save is silent.** `EditableText` (`scripts/pages/timeline.js`) and the Today
   field handlers toast only on failure. The editor closes and nothing says the edit was kept, so
   "I changed it and nothing happened" is the only reading available.

## 1. Scope

In:

* The card spec, implemented, on **both** Timeline action rows and Today task cards.
* A success acknowledgement for every *field editor* save (§4).
* Refreshing an open history list after a save (§5).

Out:

* The Tasks page History tab stays as it is (it already renders `ContentHistoryPanel`).
* Check-off (the circle) and bulk resolve get no new toast — the row's own state change is the
  acknowledgement, and a bulk resolve of 20 rows must not produce 20 toasts.
* Topic history: already reachable (Timeline topic detail → History). Unchanged.
* Any backend change. If an implementation step seems to need one, re-read the card spec §5.

## 2. One composite, two hosts

Add `scripts/composites/todo-history.js` exporting `window.FieldSight.TodoHistory`. It renders
the card spec's provenance line and version list — **not** the CURRENT line, which each host
already renders in its own layout.

Props:

| Prop | Meaning |
|---|---|
| `actionItemId` | durable `action_items.id`. When absent (legacy rows), render nothing |
| `sessionId`, `sessionKind` | from the owning topic (`topics[].session_id`, `session_kind`) |
| `date`, `folder` | the report OWNER's day and folder — never the caller's — used to key the sessions read |
| `open` | the host's expanded state. **No request of any kind is made while `open` is false** |

Hosts:

* **Timeline** — `ActionItemRow` (mounted in `timeline.js` OverviewTab). Add a disclosure control
  to the row; expanded, it renders `TodoHistory` beneath the row. `ActionItemRow` already receives
  `action` (with `id`), `date`, `userFolder`; the host passes the topic's `session_id`/`session_kind`
  as two new props.
* **Today** — `fs.TaskCard` (both mounts in `today.js`). Today items already carry
  `actionItemId`, `date`, `folder` (`today-adapter.js`). Add `sessionId`/`sessionKind` to what the
  adapter stamps from the topic, and give the card the same disclosure. Today rolls several days
  and several owners into one list; that is why the composite keys its sessions read on
  `(date, folder)` rather than assuming one day.

`TodoHistory` must be registered in `components-preview.html` (CLAUDE.md, Showcase trap).

## 3. Reads

* **Sessions**: `FS.api.org.getSessions({date, user: folder})` →
  `GET /api/org/sessions?date=&user=`, returning `sessions[]` of
  `{session_id, started_at, ended_at, title, topic_count}` (backend `build_day_sessions`).
  Wrap in `FS.api.cache.cached('sessions:' + date + ':' + folder, …)` so every card of one
  (date, owner) shares one request. A card never fires a sessions request of its own beyond
  that shared key.
* **History**: `FS.api.actions.getContentHistory('action_items', actionItemId)`, fetched on the
  transition to `open`, **not** cached (§5 depends on a fresh read).
* The provenance three-state rule, the 404-is-empty rule, `actor_name` on every version,
  non-text fields rendered as sentences, and "never print `occurred_at` / never treat
  `time_range` as when something happened" are the card spec's §2–§3, verbatim.

## 4. Save acknowledgement

On a **resolved, non-denied** save (i.e. not `_accessDenied`, not `_notFound`, not thrown):

```
FS.toast.show({ message: 'Saved', tone: 'success', duration: 2000 })
```

Sites (every field editor, no check-off, no bulk):

| Where | Save path |
|---|---|
| `timeline.js` `EditableText` commit | `actions.updateContent` — topic title/summary, action text, findings, safety |
| `today.js` field handler (`api.updateAction(item.actionItemId, patch)`) | priority / status select / deadline / responsible |
| `today.js` title editor (`fs.EditableText` mount) | `actions.updateContent('action_items', …)` |
| `tasks.js` detail field saves (`updateAction`) | same fields as Today |

One helper, `FS.api.actions.ackSaved()`, is the only place the toast literal lives, so the
copy and duration cannot drift across four call sites.

The failure toasts that exist today stay exactly as they are.

## 5. After a save, an open history is re-read

Emit `content:edited` with `{table, id}` on the same success branch as §4. `TodoHistory`
(when `open`) and the Tasks page's mounted `ContentHistoryPanel` subscribe and re-fetch when
`table`/`id` match. Never append optimistically — the server assigns `created_at` and
`actor_name` (card spec §5).

Transport: reuse the page-level subscribe/publish bus `ActionItemRow` already subscribes to
(`action-item-row.js`, `bus.subscribe`) if it is a general-purpose bus; otherwise add a minimal
`FS.events` (`on`/`off`/`emit`) in `scripts/api/` loaded after `api/index.js` (CLAUDE.md:
`FS.api` is assigned wholesale by `api/index.js`; anything registered on it earlier is wiped).
The implementation plan must state which, after reading the bus.

## 6. Tests (`node --test tests/*.test.js`)

New `tests/todo-history.test.js` (pure functions extracted from the composite, same pattern as
`actionItemHistoryProps`):

1. Card spec acceptance 1–5, each as a case over fixture `{topic, sessions, edits}`.
2. Card spec acceptance 6: rendering N collapsed hosts calls neither `getSessions` nor
   `getContentHistory` (spy on both).
3. Two cards with the same `(date, folder)` opened in sequence issue **one** sessions request.
4. A history 404 renders identically to an empty list and calls no toast.

New `tests/save-acknowledgement.test.js`:

5. Each §4 site: success → exactly one `Saved` toast; `_accessDenied` → the existing error
   toast and **no** `Saved`; thrown → no `Saved`.
6. Check-off and bulk resolve → no `Saved` toast.
7. A success emits `content:edited {table, id}`; an open `TodoHistory` for that id re-fetches;
   one for a different id does not.

Mutation check (CLAUDE.md "how to verify"): remove the `open` guard and confirm test 2 turns red;
remove the `ackSaved()` call from one site and confirm test 5 turns red.

## 7. Manual verification on dev (TEST)

As a user who may edit (e.g. Ben_UCPK2 on UC PK, 2026-09-03):

1. Today → expand a to-do → provenance line + no version block (never edited). Network shows
   one `sessions` and one `history` request, none before expanding.
2. Change its deadline → `Saved` toast → the open card now shows `deadline changed to …`,
   attributed to the editor.
3. Timeline → same day → same to-do's row → expand → the same version entry.
4. Edit a topic summary → `Saved` toast.
5. Tick a to-do done → no `Saved` toast.
