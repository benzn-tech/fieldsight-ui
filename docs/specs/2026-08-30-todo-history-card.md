# The to-do card: CURRENT, where it came from, and every version of it

Backend spec: `docs/superpowers/specs/2026-08-30-todo-version-history.md` (pipeline repo),
including its §7 corrections — read those before this, because §2 of that spec named the wrong
data source and §7 replaces it.

**There is no new endpoint and no new backend work.** Everything below is composed from three
reads that are already live. If you find yourself asking for an API change, check §5 first —
the answer is probably that the field already arrives under a different name.

## The surface

```
Hemi — install joinery Thu, double crew, done Fri        [CURRENT]
From Tue site meeting · Tue 2:45 pm · open the meeting
  v3 · Thursday install, double crew          Tue 2:45 pm
  v2 · Rain delay, materials on hold          Tue 2:22 pm
  v1 · Supplier confirmed Wednesday           Sat  9:41 am
```

Line 1 is the action item as it stands now. Line 2 is provenance. Below it, the versions,
newest first, each one expandable to its full text.

## 1. Where every field comes from

| Line | Field | Source |
|---|---|---|
| CURRENT | `action`, `responsible`, `deadline`, `priority`, `status` | `GET /api/org/timeline?date=&user=` → `topics[].action_items[]` — already fetched by the day view |
| CURRENT | the durable id these calls key on | the same object's **`id`** |
| provenance | which recording | topic's `session_id` + `session_kind` |
| provenance | the time to print | `GET /api/org/sessions?date=&user=` → the matching session's `started_at` |
| provenance | the meeting's name | same session's `title` |
| versions | every earlier text | `GET /api/org/content/action_items/{id}/history` → `{ edits: [...] }`, already wrapped as `FS.api.actions.getContentHistory('action_items', id)` in `scripts/api/actions.js` |

`sessions` is one call per day view, not one per card. Join it to the topic on `session_id` and
keep it in the day's existing cache; a card must not fire its own `sessions` request.

## 2. Three states the provenance line must render, not two

**`session_kind: "extraction"`** — a real recording. Render
`From {title} · {started_at, formatted} · open the meeting`, linking to that session.

**`session_kind: "report"`** — a nightly-report-sourced topic. There is **no session and no
time**: the backend deliberately returns `session_id: null` because one key covers the whole
day and no session boundary exists in the data. Render `From the daily report` with **no
timestamp and no link**. Inventing a time here is the specific thing `session_scope`'s contract
forbids, and it is not a rare path — it is what a day looks like after the nightly pass on a
non-defer day.

**`session_id` present but absent from the `sessions` response** — render the session name if
the topic carries one and omit the time. Do not fall back to `time_range`: it is LLM free text
that may label a session and must never be presented as when something happened.

Never print `occurred_at`. It is NULL on every topic row in production and is not returned.

## 3. The version list

`edits` are `content_edits` rows — `{ field, before_text, after_text, actor_name, created_at }`,
newest first from the server. Render one entry per edit of the **`text`** field, numbered from
the bottom (`v1` is the oldest). The CURRENT line is not a version and is not numbered.

Rules:

* **An empty list is the normal case today, not an error.** Most action items have never been
  edited. Render the card with CURRENT and provenance and no version block at all — not an
  empty container, not "no history".
* **The history request can 404, and that is not a bug to report to the user.** When a nightly
  re-extraction supersedes a day, the action item's row is deleted and re-inserted with a new
  uuid; the old id then 404s. Treat 404 exactly like an empty list. Do not toast, do not log an
  error to the user, do not retry.
* Show `actor_name` on each version — a version a person wrote and a version the system wrote
  are different claims, and the field is already resolved server-side.
* Edits to fields other than the text (`status`, `deadline`, `responsible`) belong in the same
  chronological list but must read as what they are — `deadline changed to Fri` — not as a
  restatement of the to-do.

## 4. What this card does NOT do

It does not group two different action items together. Nothing in this card merges anything;
the version list is the edit history of **one** row.

That restraint is measured, not conservative-by-taste. In the whole production corpus there are
four cross-day near-duplicate clusters, and one of the four is:

```
FieldSight AI -- promote with DeAndre
FieldSight roadmap -- sync with Benny
FieldSight features -- meet James & Benny
FieldSight mobile -- upgrade and deploy
```

One subject, four different commitments to four different people. Any UI that folds those into
one card buries three real to-dos as old versions of a fourth. If a future backend release
starts returning a chain id on the action item, this card renders it — until then there is
nothing to render and guessing client-side is worse than the backend guessing.

## 5. Implementation notes

* `scripts/composites/action-item-row.js` is where the row already lives; the card is that row
  expanded, not a new component alongside it.
* `FS.api.actions.getContentHistory(table, id)` already exists and already returns `{edits: []}`
  under mocks — so the empty-state path is exercisable without a backend.
* Fetch history **on expand**, not with the day view. A day can hold 35 action items (measured,
  2026-08-10, one recorder), and 35 history requests to render a collapsed list is the
  behaviour to avoid.
* The card is read-only. Editing stays on the existing PATCH path, and after a successful edit
  the history is refetched rather than optimistically appended — the server assigns
  `created_at` and `actor_name`, and a guessed version that later disagrees is worse than a
  spinner.

## 6. Acceptance

1. A day with an extraction-sourced item: provenance shows the session title and its start
   time, and the link opens that session.
2. A report-sourced item: reads `From the daily report`, shows **no** time, and offers **no**
   link.
3. An item with no edits: no version block.
4. An item whose history 404s: identical rendering to case 3, and nothing user-visible about
   the failure.
5. An item with two text edits: `v1`/`v2` numbered oldest-first with the current text on top,
   each carrying who made it.
6. A collapsed list of 35 items issues **zero** history requests.
