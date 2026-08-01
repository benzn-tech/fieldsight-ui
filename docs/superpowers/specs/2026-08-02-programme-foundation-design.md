# Programme Foundation — Design

Date: 2026-08-02
Status: Approved for implementation
Scope: Project 1 of 3 (see "Programme of work" below)
Repos: `fieldsight-ui` (frontend), `fieldsight-pipeline` (org-api, Aurora, matcher)

---

## 1. Why

The Programme module has three defects that make it unusable on a real
construction programme:

1. **It freezes.** A few thousand tasks lock the browser on scroll.
2. **It loses work.** A refresh after import discards the programme.
3. **It cannot absorb a new revision.** A programme is a living document —
   the client re-issues it monthly. Today a re-import overwrites everything,
   so any allocation, progress or breakdown done on our side is destroyed.

None of the higher-value work (time-range view, critical path, AI breakdown,
allocation, site-report → progress linking) can stand on that foundation.
This document specifies the foundation.

### Verified starting conditions

| Claim | Evidence |
|---|---|
| `rows` is rebuilt every render, O(parents × leaves) | `fieldsight-ui/scripts/pages/programme.js:802-817` |
| Scroll handler re-renders per scroll pixel, no rAF throttle | `fieldsight-ui/scripts/pages/programme.js:848-850` |
| Date strip emits one DOM node per calendar day, not memoized | `fieldsight-ui/scripts/composites/gantt-strip.js` |
| `GanttRow` / `TaskTreeCell` have no `React.memo` | `fieldsight-ui/scripts/composites/gantt-row.js`, `task-tree-cell.js` |
| Only whole-document `PUT` persists; per-task writes are permanently mocked | `fieldsight-ui/scripts/api/programme.js:158-198` |
| Storage is a single S3 doc, no version history | `fieldsight-pipeline/src/repositories/programme.py` |
| Write gate is `global_role in (admin, gm, pm)` | `fieldsight-pipeline/src/lambda_org_api.py:2792` |
| Baseline snapshot never leaves the browser | `fieldsight-ui/scripts/api/programme.js:273` |
| **No production programme data exists** | `aws s3 ls s3://fieldsight-data-509194952652/programmes/` → 0 objects. Test bucket holds one 214-byte 2-task stub. |

The last row is load-bearing: **there is nothing to migrate**. The new
schema can be built clean and the old S3 path retired without a data
migration script.

---

## 2. Product positioning (decided)

**Programme is an import-and-allocate surface, not a scheduling tool.**

Project managers plan in Primavera P6 or MS Project and will keep doing so.
FieldSight reads their programme in, lets them slice and allocate it, and
feeds real site progress back. Editing remains available — it is simply not
what the module is for, and no design decision may be made on the assumption
that a PM will reschedule here.

Three consequences that shape everything below:

- **Imported rows belong to the file.** The next import is authoritative over
  them. Local edits to imported rows are permitted but flagged, and are
  surfaced in the import diff before being overwritten — never silently lost.
- **Our work lives in a local subtree beneath each imported row.** Breakdown
  subtasks, zone splits and manual tasks hang off the imported task and are
  never touched by an import.
- **Contract dates and internal plan are separate by construction.** The
  imported row keeps the client's dates verbatim; the local subtree carries
  our actual arrangement. Divergence between the two is a feature — it is
  exactly the signal a PM needs.

### Import formats

Unchanged for this project: CSV, XLSX, MS-Project XML (MSPDI). `.xer`
(Primavera) and `.mpp` (binary, requires MPXJ on a JVM) are deferred; users
export XML from MS Project instead. Recorded consequence: **CSV and XLSX
carry no dependency data, so critical path cannot be computed for them.**
Project 2 must handle that degradation honestly rather than render a
meaningless path.

---

## 3. Programme of work

| # | Project | Contents | Status |
|---|---|---|---|
| 1 | **Foundation** | Rendering fixes, Aurora storage, per-task REST, autosave, import reconciliation, version history, time-window view | **This spec** |
| 2 | View | Critical path highlight + overview modal, lateness against baseline, dependency-less degradation | Next |
| 3 | Intelligence & collaboration | AI task breakdown, zone split + allocation, site-speech → progress with two-way visibility | After field validation of 1 & 2 |

The time-window view was promoted from Project 2 into Project 1 because it
*is* the performance strategy (§7), not an independent feature.

---

## 4. Data model

New Aurora tables. `programme_progress_suggestions` (migration 0008) is left
untouched in this project; it gains a `programme_task_uuid` foreign key in
Phase B of the cutover (§12).

```sql
CREATE TABLE programmes (
  id               uuid PRIMARY KEY,
  site_id          uuid NOT NULL,
  name             text NOT NULL,
  source_format    text,                     -- csv | xlsx | mspdi
  current_version  int  NOT NULL DEFAULT 0,
  baseline_version int,                      -- NULL until a baseline is set
  status           text NOT NULL DEFAULT 'active',  -- active | archived
  is_primary       boolean NOT NULL DEFAULT true,    -- the one Today/My Work roll up
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- A site may hold more than one programme (main contract, subcontractor,
-- option study). Exactly one is flagged primary for Today/My Work rollups.
CREATE UNIQUE INDEX ON programmes (site_id) WHERE status = 'active' AND is_primary;

CREATE TABLE programme_versions (
  id            uuid PRIMARY KEY,
  programme_id  uuid NOT NULL REFERENCES programmes(id),
  version_no    int  NOT NULL,
  filename      text,
  mode          text NOT NULL,               -- initial | update | replace
  imported_by   text NOT NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  diff_summary  jsonb NOT NULL DEFAULT '{}', -- counts + per-task deltas
  UNIQUE (programme_id, version_no)
);

CREATE TABLE programme_tasks (
  id                 uuid PRIMARY KEY,        -- IDENTITY key. All FKs point here.
  programme_id       uuid NOT NULL REFERENCES programmes(id),
  source_task_id     text,                    -- MATCHING key. NULL for local rows.
  parent_id          uuid REFERENCES programme_tasks(id),

  origin             text NOT NULL,           -- imported | local
  name               text NOT NULL,
  wbs_code           text,
  start_date         date,
  end_date           date,
  duration_days      int,
  progress_pct       int  NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'not_started',
  zone               text,                    -- free text (Level 3, Grid A-E, ...)

  total_float_days   int,                     -- read from source when present
  is_critical        boolean NOT NULL DEFAULT false,

  first_seen_version int  NOT NULL,
  removed_in_version int,                     -- soft delete; never hard-deleted
  locally_modified   boolean NOT NULL DEFAULT false,

  sort_order         int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text,
  row_version        int NOT NULL DEFAULT 1   -- optimistic lock
);
CREATE UNIQUE INDEX ON programme_tasks (programme_id, source_task_id)
  WHERE source_task_id IS NOT NULL AND origin = 'imported';
CREATE INDEX ON programme_tasks (programme_id, start_date, end_date);
CREATE INDEX ON programme_tasks (parent_id);

CREATE TABLE programme_task_deps (
  predecessor_id uuid NOT NULL REFERENCES programme_tasks(id),
  successor_id   uuid NOT NULL REFERENCES programme_tasks(id),
  dep_type       text NOT NULL DEFAULT 'FS',  -- FS | SS | FF | SF
  lag_days       int  NOT NULL DEFAULT 0,
  PRIMARY KEY (predecessor_id, successor_id, dep_type)
);

CREATE TABLE programme_task_assignees (
  task_id   uuid NOT NULL REFERENCES programme_tasks(id) ON DELETE CASCADE,
  assignee  text NOT NULL,                    -- folder_name, matching Today/Tasks
  role      text NOT NULL DEFAULT 'owner',    -- owner | contributor
  PRIMARY KEY (task_id, assignee)
);

CREATE TABLE programme_delay_flags (
  id            uuid PRIMARY KEY,
  task_id       uuid NOT NULL REFERENCES programme_tasks(id),
  raised_by     text NOT NULL,
  reason        text NOT NULL,
  expected_end  date,
  state         text NOT NULL DEFAULT 'open', -- open | acknowledged | resolved
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
```

### 4.1 Why identity and matching keys are separate

`id` is a surrogate UUID we mint. `source_task_id` is whatever the file
carries. They are deliberately different columns because they answer
different questions, and conflating them makes the schema depend on a
user-editable field in the client's planning tool.

Four reasons, none of which depend on how stable source IDs happen to be:

1. Zone splits produce several rows sharing one `source_task_id`. It cannot
   be a primary key.
2. Local rows (breakdown subtasks, manual tasks) have no source ID at all.
3. A site may hold multiple programmes; source IDs collide across files, so
   any source-keyed PK would need to be composite anyway.
4. Assignments, progress, suggestions and action-item links are foreign keys.
   When a planner renames Activity ID `A1020` → `A1020R1`, a surrogate key
   turns that into a one-column update; a source-keyed PK breaks every
   reference.

Source identifiers are also weaker than they appear:

- **MSPDI** `<Task><UID>` is a per-file integer, unique only within that file
  (this is what `programme-import.js:510` currently maps from).
- **P6 XER** `TASK.task_id` is the exporting database's internal row id and
  changes between databases; the identifier planners actually use is
  `task_code` (Activity ID), which is hand-editable.
- **CSV/XLSX** `task_id` is whatever the author typed.

**Reconciliation is `source_task_id`'s job alone.** The surrogate key does
not participate in matching; it exists so that our references survive
whatever the file does.

### 4.2 When a source ID does change

No scheme detects this silently — the row presents as one deletion plus one
addition. Mitigation: after exact matching, run a fallback pass over the
unmatched-removed and unmatched-added sets using name similarity + WBS path +
date proximity, and surface candidates in the import diff:

> `A1020R1 "Pour slab L3"` looks like the previous `A1020 "Pour slab L3"` —
> same task? [Yes, it moved] [No, they are different]

Accepting rewrites one column. Every assignment, progress record and local
subtree beneath it is untouched.

---

## 5. Hierarchy

`parent_id` self-reference, arbitrary depth. The current `parents` / `leaves`
split disappears; a task is a group iff it has children.

Semantics (decided):

- The imported row stays exactly as the client issued it — contract dates.
- Zone splits and breakdown subtasks become **children** of that row.
- The parent's own dates are **not** recomputed from its children. Rollup
  computes an *internal plan* start/end/progress shown alongside the contract
  dates, so `internal_end > contract_end` is directly visible as
  "internal plan already exceeds the contract programme".

This is also what makes reconciliation tractable: the row the file owns is
never mutated by our operations, so it always matches cleanly next import.

Rollup becomes a single bottom-up traversal, computed once per task-set change
and memoized — replacing the current per-render `filter` per parent.

---

## 6. Import

### 6.1 Two-phase: dry-run, then commit

`POST /api/org/programme/import` with `dry_run: true` parses, reconciles
in memory and returns a diff without writing. The UI shows the impact, the
user picks a mode, and a second call commits. The user never chooses blind.

Update-mode preview:

> 12 updated (8 pushed out, max 14 days) · 3 added · 1 no longer present ·
> 2 local breakdowns invalidated · 3 rows you edited here will be overwritten

Replace-mode preview:

> Will discard 47 local tasks, 12 allocations, 203 progress records.
> Type the site name to confirm.

### 6.2 Modes

| Mode | Behaviour |
|---|---|
| **Update** (default) | Reconcile by `source_task_id`. Local subtrees preserved. |
| **Replace** | New version supersedes everything. Prior version is **archived, not deleted** — recoverable via rollback. Requires typing the site name. |
| **Import as new programme** | Creates a second `programmes` row. For subcontractor programmes and option studies. |

Mode is suggested from `source_task_id` overlap with the current version:
overlap > 70% → Update; < 30% → warn that this looks like a different
programme and offer Replace or new-programme.

### 6.3 Reconciliation rules (Update mode)

| Situation | Action |
|---|---|
| Source ID present in both | Update imported fields (including renames). Local children untouched. If `locally_modified`, list it in the diff before overwriting. |
| Source ID gone from new file | Set `removed_in_version`. Hidden from default views, still queryable. Local subtree archived with it. Never hard-deleted — completed work and real progress records hang off it. |
| Source ID new | Insert with `first_seen_version = n`. |

### 6.4 Local subtree response to parent changes

Local children are scheduled relative to their parent, so they must react
when the parent moves. Default behaviour, applied at commit:

- **Shift only what has not started.** Tasks with actual progress keep their
  real dates; not-started tasks shift by the parent's delta.

This can leave a visible gap between a completed child and the shifted
remainder. The gap is real and is not smoothed over.

Escalation by magnitude of change:

| Parent change | Action |
|---|---|
| Shifted, duration unchanged | Auto-shift not-started children. Not reported individually. |
| Duration changed < 20% | Shift and scale proportionally, mark for review. |
| Duration changed ≥ 20%, or dependencies changed | Mark the breakdown **invalidated**. Offer "re-plan breakdown" (Project 3). **Never auto-rewrite** — the breakdown is already allocated to named people and must not change behind their backs. |
| Parent removed from the file | Archive the subtree with it. |

### 6.5 Version history, rollback, baseline

Every import writes a `programme_versions` row. From it:

- **Change summary** — "12 pushed out (max 14 days), 3 added, 1 dropped off
  the critical path". This is what a PM most wants when a revision lands and
  nothing currently provides it.
- **Rollback** — restore to version *n*. Available to pm / gm / admin.
  Because Replace archives rather than deletes, a mistaken Replace is
  fully recoverable.
- **Baseline** — replaces the current localStorage-only snapshot
  (`api/programme.js:273`). Defaults to version 1; a PM can designate any
  version as baseline, because the contractually approved revision is the
  meaningful one. Lateness in Project 2 is measured against it.

---

## 7. Time window as the default view

**The window is not a filter applied to a loaded programme; it is what gets
loaded.** This is the performance strategy.

- Server returns only tasks intersecting `[from, to]`, plus their ancestors
  to render tree structure. A 10-week window over any programme size is
  typically a few hundred rows.
- Default window: **2 weeks back, 4 weeks forward**. User-selectable
  (±2/4/6/8 weeks). The selection is stored as a **user preference**, not
  localStorage, so it follows the user across devices.
- Beyond the window, an **Overview mode** renders deliberately coarse:
  collapsed to WBS groups, month tier, no per-day grid. Its purpose is
  orientation, not manipulation.

30,000-row programmes therefore need no special handling: we never render
30,000 rows. This removes the need for horizontal virtualization of the
full timeline and for server-side pagination of the tree.

---

## 8. Rendering fixes

Independent of storage; do these first so the improvement is measurable in
isolation.

1. **Memoize `rows`** on `[tasks, collapsed, window]`. Precompute a
   `parent_id → children[]` index once instead of filtering all leaves per
   parent. (`programme.js:802-817`)
2. **rAF-throttle the scroll handler**, and skip `setState` when the derived
   row slice is unchanged. (`programme.js:848-850`)
3. **`React.memo` on `GanttRow`, `TaskTreeCell`, `GanttStrip`.**
4. **Render only visible ticks in `GanttStrip`**, driven by scroll offset
   rather than the full programme span.
5. **Measure row height** instead of the hard-coded `ROW_H = 44`, or enforce
   a fixed row height in CSS so the spacer arithmetic cannot drift.

Acceptance: 5,000-row programme, sustained scroll, no frame over 50 ms.

---

## 9. API surface

| Method | Route | Notes |
|---|---|---|
| GET | `/api/org/programme?site=&programme_id=` | Full tree. Overview mode. |
| GET | `/api/org/programme/tasks?site=&from=&to=&assignee=&programme_id=` | Window query. Serves both the Programme time-window view and Today / My Work. |
| PATCH | `/api/org/programme/tasks/{id}` | Incremental write. Carries `row_version`. |
| POST | `/api/org/programme/tasks` | Create local task. |
| DELETE | `/api/org/programme/tasks/{id}` | Local rows only. |
| POST | `/api/org/programme/import` | `dry_run` or `commit`. |
| GET | `/api/org/programme/versions?programme_id=` | History + diff summaries. |
| POST | `/api/org/programme/versions/{n}/restore` | Rollback. |
| POST | `/api/org/programme/tasks/{id}/delay-flag` | Scenario D (§10). |

`?site=` remains the **org site UUID**, not the report slug — passing the
slug 403s (`fieldsight-ui/scripts/api/programme.js:11-16`).

The window query replaces `today-programme-adapter.js:111`, which currently
fans out across every org site with `pooledAll` and downloads each whole
`programme.json` in order to select a handful of rows. One SQL query
replaces it.

**Note:** `updateTask` / `createTask` / `deleteTask` / `importTasks` already
exist in `fieldsight-ui/scripts/api/programme.js:158-198`, written against
exactly this shape and permanently mocked because the backend never existed.
This project makes them real.

---

## 10. Permissions

`caller["global_role"]` gating today is coarse: writes require
`admin | gm | pm`, which locks site managers out entirely. Allocation
requires finer rules.

| Action | admin / gm / pm | site_manager | worker |
|---|---|---|---|
| Read programme | ✅ | ✅ (own site) | ✅ (assigned tasks) |
| Imported row: **dates** | ✅ (flagged `locally_modified`) | ❌ | ❌ |
| Imported row: **progress / status** | ✅ | ✅ if assigned | ❌ |
| Local row: create / edit / dates | ✅ | ✅ within own subtree | ❌ |
| Allocate | ✅ | ❌ | ❌ |
| Import (Update) | ✅ | ❌ | ❌ |
| Replace / rollback | ✅ | ❌ | ❌ |
| Raise delay flag | ✅ | ✅ | ❌ |

### Scenario D — the delay flag

A site manager knows before the plan does. He cannot change a contract date
(the next import would overwrite it anyway), so he raises a flag: reason,
expected new date, affected task. It surfaces to the PM, who reschedules in
P6/MSP and re-imports.

This converts the gap between "site knows" and "plan reflects" into an
explicit record with an owner, instead of an edit that dies at the next
import. It does not exist today and is the most valuable new element of the
collaboration loop.

---

## 11. Autosave

Edit-then-save is replaced by write-on-change. Per-task `PATCH` makes this
cheap — no more 1.5 MB whole-document round trip per keystroke.

Concurrency: `row_version` optimistic lock. On conflict the server returns
409 and the client refreshes that row and shows "updated by someone else".
No merge UI — concurrent editing of the same programme is rare and, given
§2, writes are mostly progress on distinct tasks.

---

## 12. Transition and matcher compatibility

`lambda_programme_matcher.py` reads `programmes/{site_id}/programme.json`
from S3 and `POST /suggestions/{id}/confirm` writes it back
(`lambda_org_api.py:2859-2928`). Changing both at once is unnecessary risk.

**Phase A — dual write.** Aurora becomes the source of truth. Every write
path (PATCH, import commit, suggestion confirm) regenerates the S3 snapshot
in the legacy `{parents, leaves}` shape:

- `leaves` — all leaf nodes not soft-deleted, `task_id` = `source_task_id`
  when present else the UUID
- `parents` — their nearest group ancestors

The matcher needs **no change**. Its `candidate_tasks()` only consumes
schedulable leaves.

**Phase B — cut over.** Point the matcher at Aurora, drop the snapshot, add
`programme_task_uuid` to `programme_progress_suggestions` and backfill.
Separate PR, after Phase A is stable in test.

Rollback at any point in Phase A: revert the frontend to `GET/PUT
/programme`; the snapshot is still current.

**Migration: none.** Production holds no programme data (§1). The test
bucket's 2-task stub is discarded.

---

## 13. Testing

**Backend**
- Reconciliation matrix: present / gone / new / renamed-in-place /
  source-ID-changed, each asserting local subtree survival
- Replace archives rather than deletes; rollback restores exactly
- Window query returns intersecting tasks plus ancestors, and nothing else
- Row-level permission matrix (§10), one case per cell
- `row_version` conflict returns 409 and does not write
- Snapshot regeneration produces a document the matcher's
  `candidate_tasks()` accepts unchanged

**Frontend**
- 5,000-row fixture: scroll profile, no frame > 50 ms
- `rows` memo does not recompute on scroll
- Import dry-run renders each diff category
- Replace requires typed confirmation
- Window preference round-trips across sessions

**End-to-end (test stack)**
- Import v1 → allocate → record progress → import v2 with shifted dates and
  one renamed task → assert allocations and progress intact, diff correct

---

## 14. Out of scope

Deferred to Project 2: critical-path highlight, overview modal, lateness
computation, dependency-less degradation UX, dependency authoring for
CSV/XLSX imports.

Deferred to Project 3: AI breakdown, breakdown re-planning on invalidation,
zone split, allocation UX, and the two-way visibility work below.

Deferred beyond: `.xer` and `.mpp` import (MPXJ on a JVM Lambda would cover
xer / mpp / P6 XML / Asta at once — revisit if XML export proves a real
obstacle for clients).

### Recorded for Project 3 — matcher visibility

The matcher works; it is invisible. Suggestions land in a review queue while
the programme task itself shows nothing, so there is no felt connection
between what was said on site and the plan. The fix is placement, not
prompt tuning or threshold changes:

1. On the programme task — inline: *"3/12 Ben on site: 'slab is about half
   poured, east side tomorrow' → suggest 50%"* with accept/reject in place.
2. On the report topic — *"→ linked to programme: Pour concrete (Level 3)"*,
   deep-linking into the Gantt.
3. On the timeline — a marker on task bars that were mentioned. **Tasks with
   no site mention for weeks are the ones worth attention**, and that is
   currently invisible.

### Recorded for Project 3 — Today and My Work

- **Today** carries three sections only: overdue-and-open (top, red, hidden
  when empty), today, next 2–3 days.
- **My Work** is the programme time-window view filtered to
  `assignee = me` — same data, same endpoint, same renderer. One
  implementation serves the site manager's own slice and the PM's full view.
- **Activity** (`fieldsight-ui/scripts/pages/activity.js`) is retained but
  restricted to pm / gm / admin. It answers "what did each person do" —
  backward-looking team oversight — which is a different question from My
  Work's "what do I have coming". For workers it returns only their own row,
  making it a poor duplicate of their own timeline; hiding it there is what
  gives site managers the clean `Today / My Work` nav.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Reconciliation quietly loses local work | Local subtrees are never touched by import; nothing is hard-deleted; every destructive path is previewed and reversible |
| Dual-write drift between Aurora and snapshot | Snapshot regenerated inside the same transaction as the Aurora write; Phase B removes it |
| Row-level permissions are new surface area | One test per matrix cell; default deny |
| Window query misses ancestors and breaks the tree | Explicit ancestor expansion, asserted in tests |
| CSV/XLSX critical path stays meaningless | Named as a Project 2 obligation, not silently shipped |
