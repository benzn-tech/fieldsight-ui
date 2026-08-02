# Programme Storage Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the programme off a single S3 JSON document onto Aurora tables with per-task writes, so a programme survives a refresh, saves incrementally without a Save button, and can carry allocations and local subtasks that a later re-import will not destroy.

**Architecture:** Six new Aurora tables keyed on a surrogate UUID, with the file's own identifier kept alongside as a separate matching key. Aurora becomes the source of truth; every write regenerates the legacy `programmes/{site_id}/programme.json` snapshot in the same transaction, so `lambda_programme_matcher.py` keeps working unchanged and the whole change stays revertible. The frontend's already-written per-task API functions — mocked since Sprint 5 against a backend that never existed — become real.

**Tech Stack:** Python 3.10+ / psycopg 3 (`dict_row`, `Jsonb`), Aurora PostgreSQL, AWS SAM, `pytest`. Frontend: plain ES2017+ browser JS, `node:test`.

## Global Constraints

- Spec: `fieldsight-ui/docs/superpowers/specs/2026-08-02-programme-foundation-design.md` §4, §5, §9, §10, §11, §12. This is Plan B of four for Project 1.
- **Cross-repo.** Backend in `fieldsight-pipeline`, frontend in `fieldsight-ui`.
- **Scope boundary.** `PUT /programme` keeps today's whole-document replace semantics, writing Aurora instead of S3. Update-mode reconciliation, the dry-run diff, version rollback and baseline are **Plan C**. The time-window view and My Work are **Plan D**. Do not build them here.
- **The matcher must not change in this plan.** Its compatibility is the snapshot's job (Task 3). If a change to `lambda_programme_matcher.py` looks necessary, stop — the snapshot is wrong.
- Next migration number is **0027** (`src/migrations/0026_meeting_session.sql` is the highest). Migrations are applied idempotently against `schema_migrations`, per database — prod runs `fieldsight`, test runs `fieldsight_test`.
- Repository style: module-level SQL strings, `conn.cursor(row_factory=dict_row).execute(...).fetchone()/.fetchall()`, `Jsonb()` for jsonb params. Mirror `src/repositories/programme_suggestions.py`.
- Tests: `pytest` from the repo root (`pythonpath = ["src"]`). Use the `FakeConn`/`FakeCursor` doubles from `tests/unit/test_programme_suggestions_repo.py` — they record every `execute()` call's SQL and params so behaviour is asserted without a live Postgres. Mark anything needing a real database `@pytest.mark.integration`.
- `?site=` takes the **org site UUID** or the site slug — `_resolve_site_param` accepts either and ACL-checks the resolved id either way. (The comment at `fieldsight-ui/scripts/api/programme.js:11-16` still claims a slug 403s; it is stale.)
- The caller row's primary key is `caller["id"]`, **not** `caller["user_id"]` — `caller` is a `users` row. Task 4 and Task 5's code below says `user_id` in places; use `caller["id"]`.
- **Permission empty-list trap:** an empty list means "deny everything", never "no restriction". Unrestricted is `None`. Getting this backwards has already caused a production over-permission incident in this codebase.
- `fieldsight-ui`'s `main` is production and auto-deploys on merge. Feature branches only.
- The pipeline working tree may be checked out on another session's branch. Verify with `git branch --show-current` before starting, and use a separate worktree rather than switching it.

---

## File Structure

### `fieldsight-pipeline`

| File | Responsibility |
|---|---|
| `src/migrations/0027_programme_tables.sql` (**create**) | The six tables and their indexes. |
| `src/repositories/programme_tasks.py` (**create**) | All SQL for programmes, versions, tasks, deps, assignees. One module: these tables are written together in single transactions and splitting them would spread one transaction across files. |
| `src/repositories/programme_snapshot.py` (**create**) | Aurora rows → legacy `{parents, leaves}` document. Isolated because it is the entire matcher-compatibility contract and must be independently testable. |
| `src/repositories/programme_delay_flags.py` (**create**) | Delay flags. Separate because it is a different lifecycle with a different permission rule. |
| `src/lambda_org_api.py` (**modify**) | Route wiring and handlers, replacing `get_programme` / `put_programme` (currently 2777-2803). |
| `tests/unit/test_programme_tasks_repo.py` (**create**) | |
| `tests/unit/test_programme_snapshot.py` (**create**) | |
| `tests/unit/test_programme_task_permissions.py` (**create**) | One case per cell of the permission matrix. |

### `fieldsight-ui`

| File | Responsibility |
|---|---|
| `scripts/api/programme.js` (**modify**) | `updateTask` / `createTask` / `deleteTask` become real calls (currently mocked at 158-198). |
| `scripts/pages/programme.js` (**modify**) | Autosave replaces the Save button; 409 conflict handling. |
| `tests/programme-autosave.test.js` (**create**) | |

---

## Task 1: Schema

**Files:**
- Create: `fieldsight-pipeline/src/migrations/0027_programme_tables.sql`

**Interfaces:**
- Consumes: `sites(id)`, `users(id)` from earlier migrations.
- Produces: the tables every later task reads and writes.

- [ ] **Step 1: Write the migration**

```sql
-- 0027: programme tables. Replaces the single S3 programmes/{site_id}/
-- programme.json document (src/repositories/programme.py) as the source of
-- truth. Spec: fieldsight-ui/docs/superpowers/specs/
-- 2026-08-02-programme-foundation-design.md §4.
--
-- Two identifiers per task, deliberately separate:
--   id             surrogate UUID. IDENTITY. Every foreign key points here.
--   source_task_id whatever the imported file calls it. MATCHING only.
-- Reconciliation (Plan C) joins on source_task_id; nothing else may. A
-- planner renaming a P6 Activity ID must cost one column update, not a
-- cascade of broken references. See design §4.1.

CREATE TABLE programmes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name             text NOT NULL,
  source_format    text,
  current_version  int  NOT NULL DEFAULT 0,
  baseline_version int,
  is_primary       boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','archived')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- A site may hold several programmes (main contract, subcontractor, option
-- study) but exactly one drives Today / My Work rollups.
CREATE UNIQUE INDEX uq_programmes_primary ON programmes (site_id)
  WHERE status = 'active' AND is_primary;
CREATE INDEX idx_programmes_site ON programmes (site_id, status);

CREATE TABLE programme_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id  uuid NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  version_no    int  NOT NULL,
  filename      text,
  mode          text NOT NULL CHECK (mode IN ('initial','update','replace')),
  imported_by   uuid REFERENCES users(id),
  imported_at   timestamptz NOT NULL DEFAULT now(),
  diff_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (programme_id, version_no)
);

CREATE TABLE programme_tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id       uuid NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  source_task_id     text,
  parent_id          uuid REFERENCES programme_tasks(id) ON DELETE CASCADE,

  origin             text NOT NULL CHECK (origin IN ('imported','local')),
  name               text NOT NULL,
  wbs_code           text,
  start_date         date,
  end_date           date,
  duration_days      int,
  progress_pct       smallint NOT NULL DEFAULT 0
                     CHECK (progress_pct BETWEEN 0 AND 100),
  status             text NOT NULL DEFAULT 'not_started',
  zone               text,

  total_float_days   int,
  is_critical        boolean NOT NULL DEFAULT false,

  first_seen_version int NOT NULL DEFAULT 1,
  removed_in_version int,
  locally_modified   boolean NOT NULL DEFAULT false,

  sort_order         int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id),
  row_version        int NOT NULL DEFAULT 1,

  -- A local row has no file identity; an imported row must have one, or
  -- reconciliation cannot match it and it would silently duplicate.
  CHECK ((origin = 'local'  AND source_task_id IS NULL)
      OR (origin = 'imported' AND source_task_id IS NOT NULL))
);
-- The reconciliation key. Partial so the many local rows (all NULL) do not
-- collide with each other.
CREATE UNIQUE INDEX uq_ptasks_source ON programme_tasks (programme_id, source_task_id)
  WHERE source_task_id IS NOT NULL;
CREATE INDEX idx_ptasks_window ON programme_tasks (programme_id, start_date, end_date)
  WHERE removed_in_version IS NULL;
CREATE INDEX idx_ptasks_parent ON programme_tasks (parent_id);

CREATE TABLE programme_task_deps (
  predecessor_id uuid NOT NULL REFERENCES programme_tasks(id) ON DELETE CASCADE,
  successor_id   uuid NOT NULL REFERENCES programme_tasks(id) ON DELETE CASCADE,
  dep_type       text NOT NULL DEFAULT 'FS'
                 CHECK (dep_type IN ('FS','SS','FF','SF')),
  lag_days       int  NOT NULL DEFAULT 0,
  PRIMARY KEY (predecessor_id, successor_id, dep_type),
  CHECK (predecessor_id <> successor_id)
);
CREATE INDEX idx_pdeps_successor ON programme_task_deps (successor_id);

CREATE TABLE programme_task_assignees (
  task_id   uuid NOT NULL REFERENCES programme_tasks(id) ON DELETE CASCADE,
  -- folder_name, matching the assignee axis Today and Tasks already use.
  assignee  text NOT NULL,
  role      text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','contributor')),
  PRIMARY KEY (task_id, assignee)
);
CREATE INDEX idx_ptassignees_assignee ON programme_task_assignees (assignee);

-- A site manager cannot move a contract date — the next import would
-- overwrite it anyway. This is how site knowledge reaches the PM instead.
CREATE TABLE programme_delay_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES programme_tasks(id) ON DELETE CASCADE,
  raised_by     uuid NOT NULL REFERENCES users(id),
  reason        text NOT NULL,
  expected_end  date,
  state         text NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','acknowledged','resolved')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX idx_pdelay_task_state ON programme_delay_flags (task_id, state);
```

- [ ] **Step 2: Verify it parses and is idempotent-safe**

The migration runner records applied filenames in `schema_migrations`, so the file itself needs no `IF NOT EXISTS`. Check the SQL parses against a scratch database:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migrations/0027_programme_tables.sql
```

If no scratch database is available, confirm by inspection that every `REFERENCES` target exists in migrations 0001-0026 (`sites`, `users`) and move on — Task 2's integration test will catch a genuine schema error.

- [ ] **Step 3: Commit**

```bash
git add src/migrations/0027_programme_tables.sql
git commit -m "feat(programme): Aurora schema for programme tasks

Six tables replacing the single S3 programme.json as the source of truth.

Task identity and file identity are separate columns on purpose: id is a
surrogate UUID every foreign key points at, source_task_id is only ever used
to reconcile against an imported file. A CHECK ties them to origin so an
imported row cannot exist without a matching key and a local row cannot
carry one."
```

---

## Task 2: Task repository

**Files:**
- Create: `fieldsight-pipeline/src/repositories/programme_tasks.py`
- Test: `fieldsight-pipeline/tests/unit/test_programme_tasks_repo.py`

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:
  - `get_primary_programme(conn, site_id) -> dict | None`
  - `create_programme(conn, *, site_id, name, source_format) -> dict`
  - `list_tasks(conn, programme_id, *, include_removed=False) -> list[dict]`
  - `get_task(conn, task_id) -> dict | None`
  - `create_task(conn, *, programme_id, parent_id, name, wbs_code, start_date, end_date, duration_days, status, zone, sort_order, updated_by) -> dict`
  - `update_task(conn, task_id, *, fields: dict, row_version: int, updated_by) -> dict | None` — `None` means the optimistic lock lost
  - `delete_local_task(conn, task_id) -> bool`
  - `replace_all_tasks(conn, programme_id, *, parents, leaves, version_no, updated_by) -> int`
  - `list_assignees(conn, task_ids) -> dict[str, list[str]]`
  - `set_assignees(conn, task_id, assignees: list[str]) -> None`

- [ ] **Step 1: Write the failing tests**

Create `fieldsight-pipeline/tests/unit/test_programme_tasks_repo.py`:

```python
"""
Tests for src/repositories/programme_tasks.py — Task 2 of the programme
storage foundation plan:

  fieldsight-ui/docs/superpowers/specs/2026-08-02-programme-foundation-design.md
  fieldsight-ui/docs/superpowers/plans/2026-08-02-programme-storage-foundation.md

The FakeConn/FakeCursor doubles record every execute()'s SQL text and params,
so behaviour is asserted without a live Postgres — same style as
tests/unit/test_programme_suggestions_repo.py.

The properties that matter here and are easy to regress:
  - update_task's WHERE carries row_version, so a lost optimistic-lock race
    updates nothing and returns None rather than silently overwriting
  - update_task only ever writes columns from an allow-list, so a client
    cannot PATCH its way to a different programme_id or origin
  - delete_local_task refuses imported rows in SQL, not just in the handler
  - list_tasks excludes soft-deleted rows unless asked
"""
import pytest

from repositories import programme_tasks as repo


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._rows = []

    def execute(self, sql, params=None):
        self.conn.calls.append({"sql": sql, "params": params})
        self._rows = self.conn._pop_result()
        return self

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    @property
    def rowcount(self):
        return len(self._rows)


class FakeConn:
    """`results` is consumed in call order: one entry per execute()."""

    def __init__(self, results=None):
        self.calls = []
        self._results = list(results or [])

    def cursor(self, row_factory=None):
        return FakeCursor(self)

    def _pop_result(self):
        if not self._results:
            return []
        nxt = self._results.pop(0)
        if nxt is None:
            return []
        return nxt if isinstance(nxt, list) else [nxt]


TASK_ID = "11111111-1111-1111-1111-111111111111"
PROG_ID = "22222222-2222-2222-2222-222222222222"
USER_ID = "33333333-3333-3333-3333-333333333333"


def test_update_task_guards_on_row_version():
    conn = FakeConn([{"id": TASK_ID, "row_version": 3}])
    repo.update_task(conn, TASK_ID, fields={"progress_pct": 50},
                     row_version=2, updated_by=USER_ID)
    sql = conn.calls[0]["sql"]
    assert "row_version = %s" in sql, "the optimistic lock must be in the WHERE clause"
    assert "row_version = programme_tasks.row_version + 1" in sql \
        or "row_version = row_version + 1" in sql, "a successful update must bump the version"
    assert 2 in conn.calls[0]["params"], "the caller's expected version must be bound"


def test_update_task_returns_none_when_the_lock_lost():
    conn = FakeConn([[]])          # UPDATE ... RETURNING matched no row
    assert repo.update_task(conn, TASK_ID, fields={"progress_pct": 50},
                            row_version=2, updated_by=USER_ID) is None


def test_update_task_rejects_columns_outside_the_allow_list():
    conn = FakeConn([{"id": TASK_ID}])
    with pytest.raises(ValueError):
        repo.update_task(conn, TASK_ID, fields={"programme_id": "somewhere-else"},
                         row_version=1, updated_by=USER_ID)
    with pytest.raises(ValueError):
        repo.update_task(conn, TASK_ID, fields={"origin": "imported"},
                         row_version=1, updated_by=USER_ID)
    assert conn.calls == [], "nothing may be executed for a rejected field"


def test_update_task_accepts_the_allowed_columns():
    for field, value in [("name", "Pour slab"), ("start_date", "2026-04-01"),
                         ("end_date", "2026-04-10"), ("progress_pct", 40),
                         ("status", "in_progress"), ("zone", "Level 3"),
                         ("duration_days", 10), ("sort_order", 3)]:
        conn = FakeConn([{"id": TASK_ID}])
        repo.update_task(conn, TASK_ID, fields={field: value},
                         row_version=1, updated_by=USER_ID)
        assert field in conn.calls[0]["sql"], f"{field} should reach the SET clause"


def test_update_task_marks_imported_rows_locally_modified():
    """An edit to an imported row must be visible in the next import's diff,
    so the PM sees what the file is about to overwrite rather than losing it
    silently."""
    conn = FakeConn([{"id": TASK_ID}])
    repo.update_task(conn, TASK_ID, fields={"name": "Renamed here"},
                     row_version=1, updated_by=USER_ID)
    sql = conn.calls[0]["sql"]
    assert "locally_modified" in sql


def test_delete_local_task_refuses_imported_rows_in_sql():
    conn = FakeConn([[]])
    repo.delete_local_task(conn, TASK_ID)
    sql = conn.calls[0]["sql"]
    assert "origin = 'local'" in sql, \
        "the guard must be in the DELETE's WHERE, not only in the handler"


def test_list_tasks_excludes_soft_deleted_by_default():
    conn = FakeConn([[]])
    repo.list_tasks(conn, PROG_ID)
    assert "removed_in_version IS NULL" in conn.calls[0]["sql"]


def test_list_tasks_can_include_soft_deleted():
    conn = FakeConn([[]])
    repo.list_tasks(conn, PROG_ID, include_removed=True)
    assert "removed_in_version IS NULL" not in conn.calls[0]["sql"]


def test_create_task_always_writes_origin_local():
    """Only an import may mint an imported row. The create endpoint is for
    breakdown subtasks and manual work."""
    conn = FakeConn([{"id": TASK_ID}])
    repo.create_task(conn, programme_id=PROG_ID, parent_id=None, name="Formwork",
                     wbs_code=None, start_date="2026-04-01", end_date="2026-04-05",
                     duration_days=5, status="not_started", zone=None,
                     sort_order=0, updated_by=USER_ID)
    assert "'local'" in conn.calls[0]["sql"]


def test_get_primary_programme_filters_active_and_primary():
    conn = FakeConn([{"id": PROG_ID}])
    repo.get_primary_programme(conn, "site-uuid")
    sql = conn.calls[0]["sql"]
    assert "is_primary" in sql and "active" in sql


def test_list_assignees_returns_empty_mapping_for_no_ids():
    """Guard against building `IN ()`, which is a syntax error, and against
    an unfiltered query that would return every assignee in the database."""
    conn = FakeConn([])
    assert repo.list_assignees(conn, []) == {}
    assert conn.calls == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/unit/test_programme_tasks_repo.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'repositories.programme_tasks'`

- [ ] **Step 3: Write the repository**

Create `fieldsight-pipeline/src/repositories/programme_tasks.py`:

```python
"""Repository for the programme tables (migration 0027).

Style mirrors src/repositories/programme_suggestions.py: module-level SQL,
conn.cursor(row_factory=dict_row).execute(...).fetchone()/.fetchall().

Two invariants are enforced here rather than in the handler, so no future
caller can bypass them:

  * update_task writes only allow-listed columns. A PATCH body is client
    input; letting it name columns freely would let a caller move a task to
    another programme or flip an imported row to local.
  * delete_local_task carries `origin = 'local'` in its WHERE. Imported rows
    are the file's, and only an import may remove them.
"""
from psycopg.rows import dict_row

_TASK_COLS = (
    "id, programme_id, source_task_id, parent_id, origin, name, wbs_code, "
    "start_date, end_date, duration_days, progress_pct, status, zone, "
    "total_float_days, is_critical, first_seen_version, removed_in_version, "
    "locally_modified, sort_order, created_at, updated_at, updated_by, row_version"
)

# Columns a PATCH may address. Deliberately excludes programme_id, parent_id,
# origin, source_task_id, first_seen_version, removed_in_version and
# row_version — those are structural, and are set by import or by create.
_UPDATABLE = frozenset({
    "name", "start_date", "end_date", "duration_days",
    "progress_pct", "status", "zone", "sort_order",
})


def get_primary_programme(conn, site_id) -> dict | None:
    return conn.cursor(row_factory=dict_row).execute(
        "SELECT id, site_id, name, source_format, current_version, "
        "baseline_version, is_primary, status, created_at, updated_at "
        "FROM programmes "
        "WHERE site_id = %s AND status = 'active' AND is_primary "
        "LIMIT 1",
        (site_id,),
    ).fetchone()


def create_programme(conn, *, site_id, name, source_format) -> dict:
    return conn.cursor(row_factory=dict_row).execute(
        "INSERT INTO programmes (site_id, name, source_format) "
        "VALUES (%s,%s,%s) "
        "RETURNING id, site_id, name, source_format, current_version, "
        "baseline_version, is_primary, status, created_at, updated_at",
        (site_id, name, source_format),
    ).fetchone()


def list_tasks(conn, programme_id, *, include_removed=False) -> list[dict]:
    where = "programme_id = %s"
    if not include_removed:
        where += " AND removed_in_version IS NULL"
    return conn.cursor(row_factory=dict_row).execute(
        f"SELECT {_TASK_COLS} FROM programme_tasks "
        f"WHERE {where} "
        f"ORDER BY sort_order, wbs_code NULLS LAST, created_at",
        (programme_id,),
    ).fetchall()


def get_task(conn, task_id) -> dict | None:
    return conn.cursor(row_factory=dict_row).execute(
        f"SELECT {_TASK_COLS} FROM programme_tasks WHERE id = %s",
        (task_id,),
    ).fetchone()


def create_task(conn, *, programme_id, parent_id, name, wbs_code, start_date,
                end_date, duration_days, status, zone, sort_order,
                updated_by) -> dict:
    """Always origin='local'. Only an import mints imported rows."""
    return conn.cursor(row_factory=dict_row).execute(
        f"INSERT INTO programme_tasks ("
        f"programme_id, parent_id, origin, name, wbs_code, start_date, end_date, "
        f"duration_days, status, zone, sort_order, updated_by) "
        f"VALUES (%s,%s,'local',%s,%s,%s,%s,%s,%s,%s,%s,%s) "
        f"RETURNING {_TASK_COLS}",
        (programme_id, parent_id, name, wbs_code, start_date, end_date,
         duration_days, status, zone, sort_order, updated_by),
    ).fetchone()


def update_task(conn, task_id, *, fields: dict, row_version: int,
                updated_by) -> dict | None:
    """Optimistic-locked partial update.

    Returns the updated row, or None when the WHERE matched nothing — either
    the task is gone or another writer moved it first. The caller turns None
    into a 409; it must never be treated as success.
    """
    bad = set(fields) - _UPDATABLE
    if bad:
        raise ValueError(f"non-updatable programme task columns: {sorted(bad)}")
    if not fields:
        raise ValueError("no fields to update")

    sets = [f"{col} = %s" for col in fields]
    params = list(fields.values())

    # An edit to an imported row is surfaced in the next import's diff rather
    # than being silently overwritten. Local rows are ours already, so the
    # flag would mean nothing there.
    sets.append("locally_modified = (origin = 'imported')")
    sets.append("updated_by = %s")
    params.append(updated_by)
    sets.append("updated_at = now()")
    sets.append("row_version = row_version + 1")

    params.extend([task_id, row_version])
    return conn.cursor(row_factory=dict_row).execute(
        f"UPDATE programme_tasks SET {', '.join(sets)} "
        f"WHERE id = %s AND row_version = %s "
        f"RETURNING {_TASK_COLS}",
        tuple(params),
    ).fetchone()


def delete_local_task(conn, task_id) -> bool:
    """Hard-delete, local rows only. Imported rows are soft-deleted by import
    reconciliation (Plan C) and are never removed through this path."""
    row = conn.cursor(row_factory=dict_row).execute(
        "DELETE FROM programme_tasks WHERE id = %s AND origin = 'local' "
        "RETURNING id",
        (task_id,),
    ).fetchone()
    return row is not None


def replace_all_tasks(conn, programme_id, *, parents, leaves, version_no,
                      updated_by) -> int:
    """Whole-document replace — today's PUT semantics, moved to Aurora.

    Everything under the programme goes, including local rows: that is what
    replace means, and the caller is required to have obtained explicit
    confirmation. Update-mode reconciliation, which preserves local subtrees,
    is Plan C.

    Returns the number of task rows written.
    """
    conn.cursor().execute(
        "DELETE FROM programme_tasks WHERE programme_id = %s", (programme_id,))

    by_source = {}
    order = 0
    for p in parents:
        row = conn.cursor(row_factory=dict_row).execute(
            "INSERT INTO programme_tasks ("
            "programme_id, source_task_id, parent_id, origin, name, wbs_code, "
            "first_seen_version, sort_order, updated_by) "
            "VALUES (%s,%s,NULL,'imported',%s,%s,%s,%s,%s) RETURNING id",
            (programme_id, p["task_id"], p.get("name") or p["task_id"],
             p.get("wbs"), version_no, order, updated_by),
        ).fetchone()
        by_source[p["task_id"]] = row["id"]
        order += 1

    for t in leaves:
        conn.cursor().execute(
            "INSERT INTO programme_tasks ("
            "programme_id, source_task_id, parent_id, origin, name, wbs_code, "
            "start_date, end_date, duration_days, progress_pct, status, "
            "first_seen_version, sort_order, updated_by) "
            "VALUES (%s,%s,%s,'imported',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (programme_id, t["task_id"], by_source.get(t.get("parent_id")),
             t.get("name") or t["task_id"], t.get("wbs"),
             t.get("start"), t.get("end"), t.get("duration_days"),
             t.get("progress_pct") or 0, t.get("status") or "not_started",
             version_no, order, updated_by),
        )
        order += 1

    conn.cursor().execute(
        "UPDATE programmes SET current_version = %s, updated_at = now() "
        "WHERE id = %s",
        (version_no, programme_id))

    return len(parents) + len(leaves)


def list_assignees(conn, task_ids) -> dict:
    """{task_id: [assignee, ...]}. Empty input returns {} without querying —
    building `IN ()` is a syntax error, and dropping the filter instead would
    return every assignee in the database."""
    if not task_ids:
        return {}
    rows = conn.cursor(row_factory=dict_row).execute(
        "SELECT task_id, assignee FROM programme_task_assignees "
        "WHERE task_id = ANY(%s) ORDER BY assignee",
        (list(task_ids),),
    ).fetchall()
    out: dict = {}
    for r in rows:
        out.setdefault(str(r["task_id"]), []).append(r["assignee"])
    return out


def set_assignees(conn, task_id, assignees) -> None:
    conn.cursor().execute(
        "DELETE FROM programme_task_assignees WHERE task_id = %s", (task_id,))
    for a in assignees or []:
        conn.cursor().execute(
            "INSERT INTO programme_task_assignees (task_id, assignee) "
            "VALUES (%s,%s) ON CONFLICT DO NOTHING",
            (task_id, a))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/unit/test_programme_tasks_repo.py -v`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/programme_tasks.py tests/unit/test_programme_tasks_repo.py
git commit -m "feat(programme): task repository with an optimistic lock and a column allow-list

update_task carries row_version in its WHERE and returns None when the race
is lost, so a concurrent write 409s instead of silently overwriting. It also
writes only allow-listed columns: a PATCH body is client input, and naming
columns freely would let a caller move a task to another programme or flip an
imported row to local.

delete_local_task carries origin = 'local' in the DELETE itself, so the
handler is not the only thing standing between a client and the file's rows."
```

---

## Task 3: Legacy snapshot generator

**Files:**
- Create: `fieldsight-pipeline/src/repositories/programme_snapshot.py`
- Test: `fieldsight-pipeline/tests/unit/test_programme_snapshot.py`

**Interfaces:**
- Consumes: `programme_tasks.list_tasks`.
- Produces: `build_snapshot(programme: dict, tasks: list[dict]) -> dict` returning `{name, start_date, end_date, parents, leaves}` in the exact shape `src/repositories/programme.py` reads and writes today.

This is the whole matcher-compatibility contract. `lambda_programme_matcher.py` reads `programmes/{site_id}/programme.json` and its `candidate_tasks()` consumes `leaves`. If this function is right, the matcher needs no change and the migration is revertible; if it is wrong, the matcher silently stops matching.

- [ ] **Step 1: Write the failing tests**

Create `fieldsight-pipeline/tests/unit/test_programme_snapshot.py`:

```python
"""
Tests for src/repositories/programme_snapshot.py — Task 3 of the programme
storage foundation plan.

This module regenerates the legacy programmes/{site_id}/programme.json
document from the Aurora rows, so lambda_programme_matcher.py keeps working
byte-compatibly while Aurora becomes the source of truth. The matcher reads
`leaves` and filters to schedulable ones (candidate_tasks, matcher line 167).

If any assertion here fails, the matcher stops matching SILENTLY — there is
no error path, candidates simply come back empty. Treat a failure as a stop.
"""
from repositories import programme_snapshot as snap

PROGRAMME = {"id": "p1", "name": "Main contract"}


def task(tid, *, source, parent=None, name="T", start=None, end=None,
         origin="imported", removed=None, progress=0, status="not_started"):
    return {
        "id": tid, "source_task_id": source, "parent_id": parent,
        "origin": origin, "name": name, "wbs_code": None,
        "start_date": start, "end_date": end, "duration_days": None,
        "progress_pct": progress, "status": status,
        "removed_in_version": removed,
    }


def test_leaf_task_id_prefers_the_source_id():
    """The matcher's suggestions and the confirm path key on task_id. For an
    imported row that must remain the file's identifier, or every suggestion
    already in programme_progress_suggestions orphans."""
    doc = snap.build_snapshot(PROGRAMME, [
        task("uuid-g", source="G1"),
        task("uuid-t", source="A1020", parent="uuid-g", start="2026-04-01", end="2026-04-10"),
    ])
    assert [t["task_id"] for t in doc["leaves"]] == ["A1020"]


def test_local_rows_fall_back_to_their_uuid():
    doc = snap.build_snapshot(PROGRAMME, [
        task("uuid-g", source="G1"),
        task("uuid-local", source=None, origin="local", parent="uuid-g",
             start="2026-04-01", end="2026-04-05"),
    ])
    assert [t["task_id"] for t in doc["leaves"]] == ["uuid-local"]


def test_a_task_with_children_is_a_parent_not_a_leaf():
    """The old document had exactly two levels. With an arbitrary-depth tree,
    'is it a group' has to be derived from whether anything points at it."""
    doc = snap.build_snapshot(PROGRAMME, [
        task("g", source="G1"),
        task("mid", source="M1", parent="g"),
        task("leaf", source="L1", parent="mid", start="2026-04-01", end="2026-04-02"),
    ])
    assert [p["task_id"] for p in doc["parents"]] == ["G1", "M1"]
    assert [t["task_id"] for t in doc["leaves"]] == ["L1"]


def test_leaf_parent_id_points_at_its_nearest_ancestor_source_id():
    doc = snap.build_snapshot(PROGRAMME, [
        task("g", source="G1"),
        task("mid", source="M1", parent="g"),
        task("leaf", source="L1", parent="mid", start="2026-04-01", end="2026-04-02"),
    ])
    assert doc["leaves"][0]["parent_id"] == "M1"


def test_soft_deleted_rows_never_reach_the_snapshot():
    """A row removed by a later import must stop being a match candidate."""
    doc = snap.build_snapshot(PROGRAMME, [
        task("g", source="G1"),
        task("gone", source="OLD", parent="g", start="2026-04-01", end="2026-04-02",
             removed=3),
        task("here", source="NEW", parent="g", start="2026-04-01", end="2026-04-02"),
    ])
    assert [t["task_id"] for t in doc["leaves"]] == ["NEW"]


def test_leaf_carries_the_keys_the_matcher_reads():
    doc = snap.build_snapshot(PROGRAMME, [
        task("g", source="G1"),
        task("t", source="A1", parent="g", name="Pour slab",
             start="2026-04-01", end="2026-04-10", progress=40, status="in_progress"),
    ])
    leaf = doc["leaves"][0]
    for key in ("task_id", "parent_id", "name", "start", "end",
                "progress_pct", "status"):
        assert key in leaf, f"the matcher's candidate_tasks reads {key}"
    assert leaf["start"] == "2026-04-01" and leaf["end"] == "2026-04-10"


def test_dates_are_iso_strings_not_date_objects():
    """psycopg returns datetime.date; json.dumps in write_programme would
    raise on those, so the snapshot must stringify them."""
    import datetime
    doc = snap.build_snapshot(PROGRAMME, [
        task("g", source="G1"),
        task("t", source="A1", parent="g",
             start=datetime.date(2026, 4, 1), end=datetime.date(2026, 4, 10)),
    ])
    assert doc["leaves"][0]["start"] == "2026-04-01"
    assert isinstance(doc["leaves"][0]["end"], str)


def test_programme_span_derives_from_the_leaves():
    doc = snap.build_snapshot(PROGRAMME, [
        task("g", source="G1"),
        task("a", source="A", parent="g", start="2026-05-01", end="2026-05-10"),
        task("b", source="B", parent="g", start="2026-04-01", end="2026-06-30"),
    ])
    assert doc["start_date"] == "2026-04-01"
    assert doc["end_date"] == "2026-06-30"


def test_empty_programme_produces_a_valid_empty_document():
    doc = snap.build_snapshot(PROGRAMME, [])
    assert doc["parents"] == [] and doc["leaves"] == []
    assert doc["start_date"] is None and doc["end_date"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/unit/test_programme_snapshot.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'repositories.programme_snapshot'`

- [ ] **Step 3: Write the implementation**

Create `fieldsight-pipeline/src/repositories/programme_snapshot.py`:

```python
"""Regenerates the legacy programmes/{site_id}/programme.json document from
the Aurora rows (migration 0027).

Why this exists: lambda_programme_matcher.py reads that S3 document and its
candidate_tasks() consumes `leaves`. Keeping the snapshot current means
Aurora can become the source of truth without touching the matcher, and means
the whole change can be reverted by pointing the frontend back at
GET/PUT /programme. Phase B of the cutover (a separate plan) points the
matcher at Aurora and deletes this module.

The old document had exactly two levels — `parents` and `leaves` — and the
Aurora tree has arbitrary depth, so the split has to be derived. **Dates
decide it, not children.**

CORRECTION: this plan originally said "a task is a parent iff something points
at it". That rule passed all eleven shape tests and is wrong in a way that
fails silently — once a PM breaks a contract task down, "Pour slab" acquires
local subtasks, becomes a parent, drops out of `leaves`, and stops being a
match candidate, so "we poured the slab today" no longer lands on it. Nothing
raises; the task just goes quiet. In the legacy document `parents` were WBS
headers, which carry no dates; a task with dates is schedulable work whether
or not anything hangs off it.

Under the dates rule a broken-down task appears alongside its own subtasks and
both stay matchable — general speech lands on the parent, specific speech on
the subtask. Deeper structure is flattened, which is fine because the matcher
only ever looks at leaves.
"""


def _iso(value):
    """psycopg hands back datetime.date; the document is JSON."""
    if value is None:
        return None
    return value if isinstance(value, str) else value.isoformat()


def _doc_id(row):
    """The file's identifier for imported rows, our UUID for local ones.

    This must stay the source id for imported rows: programme_progress_
    suggestions.task_id already holds it, and the confirm path looks the task
    up in this document by that value.
    """
    return row["source_task_id"] or str(row["id"])


def build_snapshot(programme, tasks) -> dict:
    live = [t for t in tasks if t.get("removed_in_version") is None]

    has_children = {t["parent_id"] for t in live if t.get("parent_id")}
    by_uuid = {str(t["id"]): t for t in live}

    parents, leaves = [], []
    for t in live:
        uid = str(t["id"])
        if uid in {str(x) for x in has_children}:
            parents.append({
                "task_id": _doc_id(t),
                "name":    t.get("name"),
                "wbs":     t.get("wbs_code"),
            })
        else:
            parent_row = by_uuid.get(str(t.get("parent_id"))) if t.get("parent_id") else None
            leaves.append({
                "task_id":       _doc_id(t),
                "parent_id":     _doc_id(parent_row) if parent_row else None,
                "name":          t.get("name"),
                "wbs":           t.get("wbs_code"),
                "start":         _iso(t.get("start_date")),
                "end":           _iso(t.get("end_date")),
                "duration_days": t.get("duration_days"),
                "progress_pct":  t.get("progress_pct") or 0,
                "status":        t.get("status") or "not_started",
                "assignees":     t.get("assignees") or [],
                "depends_on":    t.get("depends_on") or [],
                "linked_action_items": [],
            })

    starts = [l["start"] for l in leaves if l["start"]]
    ends   = [l["end"] for l in leaves if l["end"]]

    return {
        "name":       programme.get("name"),
        "start_date": min(starts) if starts else None,
        "end_date":   max(ends) if ends else None,
        "parents":    parents,
        "leaves":     leaves,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/unit/test_programme_snapshot.py -v`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/programme_snapshot.py tests/unit/test_programme_snapshot.py
git commit -m "feat(programme): regenerate the legacy S3 snapshot from Aurora

This is the entire matcher-compatibility contract. lambda_programme_matcher
reads programmes/{site_id}/programme.json and its candidate_tasks consumes
`leaves`; keeping that document current lets Aurora become the source of truth
without touching the matcher, and keeps the change revertible.

A wrong snapshot fails silently — candidates simply come back empty, with no
error path — so the tests assert the specific keys the matcher reads, that
imported rows keep the file's task_id (the suggestions table already holds
it), and that soft-deleted rows stop being candidates."
```

---

## Task 4: Read and replace endpoints on Aurora

**Files:**
- Modify: `fieldsight-pipeline/src/lambda_org_api.py:2777-2803` (`get_programme`, `put_programme`)

**Interfaces:**
- Consumes: `programme_tasks`, `programme_snapshot` from Tasks 2 and 3.
- Produces: `GET /programme` and `PUT /programme` backed by Aurora, with the S3 snapshot written in the same transaction.

- [ ] **Step 1: Replace the two handlers**

```python
def get_programme(conn, caller, event):
    site_param = (event.get("queryStringParameters") or {}).get("site")
    site_id, err = _resolve_site_param(conn, caller, site_param)
    if err is not None:
        return err

    prog = programme_tasks.get_primary_programme(conn, site_id)
    if prog is None:
        # No programme has ever been imported for this site. A friendly empty
        # state, not a 404 — same contract the S3 path had.
        return ok({"programme": None})

    tasks = programme_tasks.list_tasks(conn, prog["id"])
    assignees = programme_tasks.list_assignees(conn, [t["id"] for t in tasks])
    for t in tasks:
        t["assignees"] = assignees.get(str(t["id"]), [])

    doc = programme_snapshot.build_snapshot(prog, tasks)
    doc["programme_id"] = str(prog["id"])
    doc["current_version"] = prog["current_version"]
    return ok({"programme": doc})


def put_programme(conn, caller, event, body):
    """Whole-document replace — today's semantics, now writing Aurora.

    Everything under the programme is discarded, including local rows. That
    is what replace means; the frontend is required to confirm before calling
    it. Update-mode reconciliation, which preserves local subtrees, is a
    separate plan.
    """
    site_param = (event.get("queryStringParameters") or {}).get("site")
    if not site_param:
        return error("site required", 400)
    if body is None:
        return error("malformed JSON body", 400)
    if caller["global_role"] not in ("admin", "gm", "pm"):
        return error("programme write requires manager role", 403)
    site_id, err = _resolve_site_param(conn, caller, site_param)
    if err is not None:
        return err

    prog = programme_tasks.get_primary_programme(conn, site_id)
    if prog is None:
        prog = programme_tasks.create_programme(
            conn, site_id=site_id,
            name=body.get("name") or "Programme",
            source_format=body.get("source_format"))

    version_no = (prog["current_version"] or 0) + 1
    programme_tasks.replace_all_tasks(
        conn, prog["id"],
        parents=body.get("parents") or [],
        leaves=body.get("leaves") or [],
        version_no=version_no,
        updated_by=caller.get("user_id"))
    programme_tasks.record_version(
        conn, prog["id"], version_no=version_no,
        filename=body.get("filename"),
        mode="initial" if version_no == 1 else "replace",
        imported_by=caller.get("user_id"))

    _write_snapshot(conn, site_id, prog["id"])

    tasks = programme_tasks.list_tasks(conn, prog["id"])
    return ok({"programme": programme_snapshot.build_snapshot(prog, tasks)})


def _write_snapshot(conn, site_id, programme_id):
    """Regenerate programmes/{site_id}/programme.json from Aurora.

    Called inside the request's transaction (lambda_handler wraps every
    request in `with get_connection() as conn:`), so a failed S3 write rolls
    the Aurora write back with it. The alternative — Aurora committed, S3
    stale — would leave the matcher matching against a programme that no
    longer exists.
    """
    prog = programme_tasks.get_primary_programme_by_id(conn, programme_id)
    tasks = programme_tasks.list_tasks(conn, programme_id)
    doc = programme_snapshot.build_snapshot(prog, tasks)
    updated_at = (datetime.utcnow() + timedelta(hours=13)).isoformat()
    programme.write_programme(s3(), S3_BUCKET, site_id, doc, updated_at)
```

- [ ] **Step 2: Add the two repository functions the handlers reference**

Append to `src/repositories/programme_tasks.py`:

```python
def get_primary_programme_by_id(conn, programme_id) -> dict | None:
    return conn.cursor(row_factory=dict_row).execute(
        "SELECT id, site_id, name, source_format, current_version, "
        "baseline_version, is_primary, status, created_at, updated_at "
        "FROM programmes WHERE id = %s",
        (programme_id,),
    ).fetchone()


def record_version(conn, programme_id, *, version_no, filename, mode,
                   imported_by) -> dict:
    return conn.cursor(row_factory=dict_row).execute(
        "INSERT INTO programme_versions "
        "(programme_id, version_no, filename, mode, imported_by) "
        "VALUES (%s,%s,%s,%s,%s) "
        "RETURNING id, programme_id, version_no, filename, mode, "
        "imported_by, imported_at, diff_summary",
        (programme_id, version_no, filename, mode, imported_by),
    ).fetchone()
```

- [ ] **Step 3: Add the imports**

At the top of `src/lambda_org_api.py`, alongside the existing
`from repositories import ... programme ...`:

```python
from repositories import programme_snapshot, programme_tasks
```

Keep the existing `programme` import — `_write_snapshot` still calls
`programme.write_programme`.

- [ ] **Step 4: Verify the module imports and the suite still passes**

```bash
python -c "import sys; sys.path.insert(0,'src'); import lambda_org_api"
pytest tests/unit -q
```

Expected: import succeeds, suite passes with no new failures.

- [ ] **Step 5: Commit**

```bash
git add src/lambda_org_api.py src/repositories/programme_tasks.py
git commit -m "feat(programme): serve and replace the programme from Aurora

GET builds its response from the Aurora rows through the snapshot builder, so
the wire format is unchanged and the frontend needs no coordinated deploy.
PUT keeps whole-document replace semantics but writes Aurora, records a
version row, and regenerates the S3 snapshot inside the request transaction —
a failed S3 write rolls the Aurora write back rather than leaving the matcher
pointed at a programme that no longer exists."
```

---

## Task 5: Per-task write endpoints with row-level permissions

**Files:**
- Modify: `fieldsight-pipeline/src/lambda_org_api.py` (routes near 403-416, handlers after `put_programme`)
- Test: `fieldsight-pipeline/tests/unit/test_programme_task_permissions.py`

**Interfaces:**
- Consumes: `programme_tasks.get_task/update_task/create_task/delete_local_task`.
- Produces: `PATCH /programme/tasks/{id}`, `POST /programme/tasks`, `DELETE /programme/tasks/{id}`, and `can_edit_task(caller, task, fields, assignees) -> str | None` returning a refusal reason or `None` when allowed.

The permission rule, from spec §10: **imported rows have read-only dates and writable progress; local rows are writable in both.** A site manager may report progress on a task assigned to them, and may reschedule their own local subtree, but may not move a contract date — the next import would overwrite it anyway. Scenario D (the delay flag) is how that knowledge reaches the PM instead.

- [ ] **Step 1: Write the failing tests**

Create `fieldsight-pipeline/tests/unit/test_programme_task_permissions.py`:

```python
"""
Row-level permission rules for programme task writes — Task 5 of the
programme storage foundation plan. Spec §10.

One test per cell of the matrix. The rule under test:

    imported row  -> dates read-only for everyone but an import;
                     progress writable by managers and by the assignee
    local row     -> dates and progress both writable by managers and by
                     the assignee within their own subtree

The failure mode this guards against is not a crash but a quiet
over-permission: a site manager editing a contract date here would see it
accepted and then silently reverted by the next import.
"""
from lambda_org_api import can_edit_task

MANAGER = {"global_role": "pm", "folder_name": "Pat_PM"}
SITE_MGR = {"global_role": "site_manager", "folder_name": "Sam_SM"}
WORKER = {"global_role": "worker", "folder_name": "Wes_W"}

IMPORTED = {"id": "t1", "origin": "imported"}
LOCAL = {"id": "t2", "origin": "local"}


def test_manager_may_edit_progress_on_an_imported_row():
    assert can_edit_task(MANAGER, IMPORTED, {"progress_pct": 50}, []) is None


def test_manager_may_edit_dates_on_an_imported_row():
    """Permitted but flagged locally_modified — the next import's diff shows
    the PM what the file is about to overwrite."""
    assert can_edit_task(MANAGER, IMPORTED, {"start_date": "2026-04-01"}, []) is None


def test_site_manager_may_report_progress_on_a_task_assigned_to_them():
    assert can_edit_task(SITE_MGR, IMPORTED, {"progress_pct": 50}, ["Sam_SM"]) is None


def test_site_manager_may_not_report_progress_on_someone_elses_task():
    assert can_edit_task(SITE_MGR, IMPORTED, {"progress_pct": 50}, ["Other_Person"]) is not None


def test_site_manager_may_not_move_a_contract_date():
    reason = can_edit_task(SITE_MGR, IMPORTED, {"start_date": "2026-05-01"}, ["Sam_SM"])
    assert reason is not None
    assert "delay flag" in reason.lower(), \
        "the refusal should point at the route that does work"


def test_site_manager_may_reschedule_their_own_local_subtask():
    assert can_edit_task(SITE_MGR, LOCAL, {"start_date": "2026-05-01"}, ["Sam_SM"]) is None


def test_site_manager_may_not_edit_a_local_task_assigned_to_someone_else():
    assert can_edit_task(SITE_MGR, LOCAL, {"progress_pct": 10}, ["Other_Person"]) is not None


def test_worker_may_not_write_at_all():
    assert can_edit_task(WORKER, LOCAL, {"progress_pct": 10}, ["Wes_W"]) is not None
    assert can_edit_task(WORKER, IMPORTED, {"progress_pct": 10}, ["Wes_W"]) is not None


def test_unassigned_task_is_not_open_to_every_site_manager():
    """An empty assignee list means nobody is assigned — it must not read as
    'no restriction'. This codebase has already shipped that inversion once
    (see the empty-list over-permission incident)."""
    assert can_edit_task(SITE_MGR, IMPORTED, {"progress_pct": 50}, []) is not None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/unit/test_programme_task_permissions.py -v`
Expected: FAIL — `ImportError: cannot import name 'can_edit_task'`

- [ ] **Step 3: Write the permission rule and the handlers**

Add to `src/lambda_org_api.py`, before the route dispatch:

```python
_MANAGER_ROLES = ("admin", "gm", "pm")
# Fields that reschedule work. Read-only on imported rows for anyone below
# manager: the file owns those dates, and an edit here would be reverted by
# the next import without telling anyone.
_SCHEDULE_FIELDS = frozenset({"start_date", "end_date", "duration_days"})


def can_edit_task(caller, task, fields, assignees):
    """Returns a refusal reason, or None when the write is allowed.

    Note the assignee check: `assignees` is the task's actual assignee list.
    An empty list means nobody is assigned, which denies a site manager — it
    must never be read as "unrestricted".
    """
    role = caller.get("global_role")
    if role in _MANAGER_ROLES:
        return None
    if role != "site_manager":
        return "programme writes require a site manager or above"

    if caller.get("folder_name") not in (assignees or []):
        return "you can only update tasks assigned to you"

    if task.get("origin") == "imported" and (set(fields) & _SCHEDULE_FIELDS):
        return ("contract dates come from the imported programme and cannot be "
                "changed here — raise a delay flag instead")
    return None


def patch_programme_task(conn, caller, task_id, body):
    if body is None:
        return error("malformed JSON body", 400)
    row_version = body.get("row_version")
    if not isinstance(row_version, int):
        return error("row_version required", 400)

    task = programme_tasks.get_task(conn, task_id)
    if task is None:
        return error("not found", 404)

    prog = programme_tasks.get_primary_programme_by_id(conn, task["programme_id"])
    if prog is None or prog["site_id"] not in (_allowed_site_ids(conn, caller) or []):
        return error("not found", 404)

    fields = {k: v for k, v in body.items()
              if k not in ("row_version", "assignees")}
    assignees = programme_tasks.list_assignees(conn, [task["id"]]).get(str(task["id"]), [])

    reason = can_edit_task(caller, task, fields, assignees)
    if reason is not None:
        return error(reason, 403)

    try:
        updated = programme_tasks.update_task(
            conn, task_id, fields=fields, row_version=row_version,
            updated_by=caller.get("user_id"))
    except ValueError as e:
        return error(str(e), 400)

    if updated is None:
        # Either the row moved on or it is gone. Both mean "re-read before
        # writing again", which is what 409 says.
        return error("this task was updated by someone else", 409)

    if "assignees" in body and caller["global_role"] in _MANAGER_ROLES:
        programme_tasks.set_assignees(conn, task_id, body["assignees"])

    _write_snapshot(conn, prog["site_id"], prog["id"])
    return ok({"task": updated})
```

- [ ] **Step 4: Wire the routes**

In the dispatch function, immediately after the existing `/programme/suggestions` block:

```python
    if route == "/programme/tasks" and method == "POST":
        return create_programme_task(conn, caller, parse_body(event))
    m_pt = re.match(r"^/programme/tasks/([^/]+)$", route)
    if m_pt and method == "PATCH":
        return patch_programme_task(conn, caller, m_pt.group(1), parse_body(event))
    if m_pt and method == "DELETE":
        return delete_programme_task(conn, caller, m_pt.group(1))
```

Place this **after** the `/programme/suggestions` routes: `/programme/tasks/{id}`
and `/programme/suggestions/{id}/confirm` do not overlap, but keeping the more
specific suggestion routes first avoids any future ambiguity.

- [ ] **Step 5: Write `create_programme_task` and `delete_programme_task`**

```python
def create_programme_task(conn, caller, body):
    """Creates a local task — a breakdown subtask or a manual addition.
    Imported rows only ever come from an import."""
    if body is None:
        return error("malformed JSON body", 400)
    if caller["global_role"] not in _MANAGER_ROLES:
        return error("creating programme tasks requires manager role", 403)

    site_id, err = _resolve_site_param(conn, caller, body.get("site"))
    if err is not None:
        return err
    prog = programme_tasks.get_primary_programme(conn, site_id)
    if prog is None:
        return error("no programme for this site", 404)

    created = programme_tasks.create_task(
        conn, programme_id=prog["id"], parent_id=body.get("parent_id"),
        name=body.get("name") or "Untitled", wbs_code=body.get("wbs_code"),
        start_date=body.get("start_date"), end_date=body.get("end_date"),
        duration_days=body.get("duration_days"),
        status=body.get("status") or "not_started", zone=body.get("zone"),
        sort_order=body.get("sort_order") or 0,
        updated_by=caller.get("user_id"))
    if body.get("assignees"):
        programme_tasks.set_assignees(conn, created["id"], body["assignees"])

    _write_snapshot(conn, site_id, prog["id"])
    return ok({"task": created})


def delete_programme_task(conn, caller, task_id):
    if caller["global_role"] not in _MANAGER_ROLES:
        return error("deleting programme tasks requires manager role", 403)

    task = programme_tasks.get_task(conn, task_id)
    if task is None:
        return error("not found", 404)
    prog = programme_tasks.get_primary_programme_by_id(conn, task["programme_id"])
    if prog is None or prog["site_id"] not in (_allowed_site_ids(conn, caller) or []):
        return error("not found", 404)

    if not programme_tasks.delete_local_task(conn, task_id):
        # The repository refuses imported rows in SQL. Reaching here means
        # the caller aimed at one.
        return error("imported tasks are removed by re-importing the programme, "
                     "not deleted here", 400)

    _write_snapshot(conn, prog["site_id"], prog["id"])
    return ok({"deleted": task_id})
```

- [ ] **Step 6: Run the tests**

Run: `pytest tests/unit/test_programme_task_permissions.py -v`
Expected: PASS, 9 tests.

Then the whole suite: `pytest tests/unit -q`

- [ ] **Step 7: Commit**

```bash
git add src/lambda_org_api.py tests/unit/test_programme_task_permissions.py
git commit -m "feat(programme): per-task write endpoints with row-level permissions

PATCH/POST/DELETE on individual tasks, replacing whole-document PUT as the
day-to-day write path — which is what makes autosave affordable.

The permission rule splits by row origin: imported rows have read-only dates
and writable progress, local rows are writable in both. A site manager can
report progress on work assigned to them and reschedule their own local
subtree, but cannot move a contract date; the refusal points them at the
delay flag, which is the route that actually reaches the PM.

The assignee check treats an empty assignee list as 'nobody is assigned' and
denies, never as 'no restriction' — the inversion this codebase has shipped
before."
```

---

## Task 6: Frontend switches to per-task writes and autosaves

> **Blocked, and the plan is wrong about why it is simple.**
>
> This task assumes "one edit = one PATCH". `applyTaskMutation`
> (`fieldsight-ui/scripts/pages/programme.js:436`) runs a cascade engine:
> dragging a bar shifts **every downstream dependent** and recomputes the
> critical path. One user action therefore produces N task writes.
>
> Three options, recorded with a recommendation on `fieldsight-ui` PR #152:
> send N PATCHes (**avoid** — not atomic, and its failure mode is "the Gantt
> looks right and the database is wrong"); add a batch endpoint that checks
> every `row_version` in one transaction (recommended now); or move the
> cascade server-side so the scheduling logic exists once instead of being
> duplicated in JS and Python (the right direction, largest job, and worth
> deciding alongside whether server-side CPM is warranted at all — see §14.1,
> since CSV/XLSX imports carry no dependencies either way).
>
> Steps 1–5 below (the pure module and the API functions) are done and
> shipped. Step 6, the page wiring, waits on that decision.

**Files:**
- Modify: `fieldsight-ui/scripts/api/programme.js:158-198`
- Modify: `fieldsight-ui/scripts/pages/programme.js` (the `dirty` / `saving` state and Save button, around 346-352 before Plan A's edits)
- Test: `fieldsight-ui/tests/programme-autosave.test.js`

**Interfaces:**
- Consumes: Task 5's endpoints.
- Produces: `FS.api.programme.updateTask({task_id, row_version, ...fields})` resolving `{task}` or rejecting with a `409` status; autosave in the page.

- [ ] **Step 1: Make the write functions real**

In `scripts/api/programme.js`, replace the permanently-mocked bodies. The
existing signatures were written against exactly this API shape, so keep
them:

```js
  async function updateTask(orgSiteId, patch) {
    if (orgLive()) {
      var id = patch.task_id;
      var body = Object.assign({}, patch);
      delete body.task_id;
      return window.FS.api.orgRequest('/programme/tasks/' + encodeURIComponent(id), {
        method: 'PATCH', body: body,
      });
    }
    await window.FS.api.delay();
    return { ok: true };
  }
```

Mirror the same pattern for `createTask` (`POST /programme/tasks`, body
carries `site`) and `deleteTask` (`DELETE /programme/tasks/{id}`).

- [ ] **Step 2: Write the failing autosave test**

Create `fieldsight-ui/tests/programme-autosave.test.js`:

```js
'use strict';

/*
 * Autosave contract for the programme page.
 *
 * Whole-document PUT is no longer the day-to-day write path — a 5,000-task
 * programme is ~1.5MB, and round-tripping that per keystroke is why the page
 * had a Save button in the first place. Each edit now PATCHes one task.
 *
 * The two properties worth pinning: every write carries the row_version the
 * client last saw (or the optimistic lock cannot fire), and a 409 refreshes
 * that one row rather than discarding the user's other edits.
 */
const test = require('node:test');
const assert = require('node:assert');

const { planAutosave, applyConflict } = require('../scripts/api/programme-autosave.js');

test('an edit produces a PATCH carrying the row_version last seen', () => {
  const task = { task_id: 'A1', row_version: 4, progress_pct: 10 };
  const plan = planAutosave(task, { progress_pct: 50 });
  assert.strictEqual(plan.method, 'PATCH');
  assert.strictEqual(plan.body.row_version, 4);
  assert.strictEqual(plan.body.progress_pct, 50);
});

test('unchanged fields are not sent', () => {
  const task = { task_id: 'A1', row_version: 4, progress_pct: 10, name: 'Pour slab' };
  const plan = planAutosave(task, { progress_pct: 10, name: 'Pour slab' });
  assert.strictEqual(plan, null, 'a no-op edit must not produce a request');
});

test('only changed fields are sent', () => {
  const task = { task_id: 'A1', row_version: 4, progress_pct: 10, name: 'Pour slab' };
  const plan = planAutosave(task, { progress_pct: 40, name: 'Pour slab' });
  assert.deepStrictEqual(Object.keys(plan.body).sort(), ['progress_pct', 'row_version']);
});

test('a 409 replaces that one row and keeps every other edit', () => {
  const tasks = [
    { task_id: 'A1', row_version: 4, progress_pct: 50 },
    { task_id: 'A2', row_version: 2, progress_pct: 30 },
  ];
  const fresh = { task_id: 'A1', row_version: 9, progress_pct: 75 };
  const next = applyConflict(tasks, fresh);
  assert.deepStrictEqual(next[0], fresh);
  assert.deepStrictEqual(next[1], tasks[1], 'the untouched task must survive the conflict');
});

test('a 409 for an unknown task leaves the list alone', () => {
  const tasks = [{ task_id: 'A1', row_version: 4 }];
  assert.deepStrictEqual(applyConflict(tasks, { task_id: 'GONE', row_version: 1 }), tasks);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test tests/programme-autosave.test.js`
Expected: FAIL — `Cannot find module '../scripts/api/programme-autosave.js'`

- [ ] **Step 4: Write the module**

Create `fieldsight-ui/scripts/api/programme-autosave.js`:

```js
/* ==========================================================================
   FieldSight Programme Autosave — pure planning helpers
   --------------------------------------------------------------------------
   The page used to hold every edit in memory behind a Save button that PUT
   the whole document. On a real programme that document is ~1.5MB, which is
   why the button existed. With per-task PATCH the write is small enough to
   happen on every change, so the button goes away.

   These two functions are the decision logic, kept pure so they can be
   tested under Node — the page owns the debounce and the request itself.

   Exported to:
     window.FS.api.programmeAutosave   (browser)
     module.exports                    (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Returns the request to send, or null when nothing actually changed.
     Sending unchanged fields would burn row_versions and turn a second
     editor's harmless concurrent edit into a spurious 409. */
  function planAutosave(task, edits) {
    var changed = {};
    Object.keys(edits || {}).forEach(function (k) {
      if (edits[k] !== task[k]) changed[k] = edits[k];
    });
    if (!Object.keys(changed).length) return null;

    changed.row_version = task.row_version;
    return { method: 'PATCH', task_id: task.task_id, body: changed };
  }

  /* On 409 the server hands back the current row. Replace just that one and
     leave every other pending edit alone — reloading the whole programme
     would discard work the user has not been told about. */
  function applyConflict(tasks, fresh) {
    var found = false;
    var next = (tasks || []).map(function (t) {
      if (t.task_id === fresh.task_id) { found = true; return fresh; }
      return t;
    });
    return found ? next : tasks;
  }

  var api = { planAutosave: planAutosave, applyConflict: applyConflict };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeAutosave = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/programme-autosave.test.js`
Expected: PASS, 5 tests.

Then the full frontend suite: `node --test tests/*.test.js`

- [ ] **Step 6: Wire it into the page**

Load the module in `app-shell-preview.html` next to `programme-rows.js`:

```html
  <script src="scripts/api/programme-autosave.js?v=1"></script>
```

In `scripts/pages/programme.js`, in `ProgrammeProvider.updateTask`: build the
plan, skip when `null`, debounce 400 ms per task id, send, and on a 409
response call `applyConflict` with the returned row and surface a toast
reading "This task was updated by someone else — refreshed". Remove the Save
button and the `dirty` / `saving` state it drove.

- [ ] **Step 7: Commit**

```bash
git add scripts/api/programme.js scripts/api/programme-autosave.js \
        scripts/pages/programme.js app-shell-preview.html \
        tests/programme-autosave.test.js
git commit -m "feat(programme): autosave through per-task PATCH

The Save button existed because saving meant PUTting the whole document —
~1.5MB on a real programme. Per-task PATCH is small enough to send on every
edit, so the button goes.

planAutosave sends only fields that actually changed: sending unchanged ones
would burn row_versions and turn another editor's harmless concurrent edit
into a spurious 409. On conflict only the conflicting row is replaced, so a
409 on one task never discards pending edits on others."
```

---

## Task 7: Deploy to test and verify end to end

**Files:** none — verification only.

- [ ] **Step 1: Confirm the migration will run**

`deploy.yml` invokes `MigrateFunction` against `fieldsight_test`, recording
applied filenames in `schema_migrations`. Confirm `0027_programme_tables.sql`
is picked up by the same glob as `0026_meeting_session.sql`:

```bash
grep -n "migrations" src/db/migrate.py
```

- [ ] **Step 2: Deploy to test and check the migration landed**

After the deploy workflow completes, against the test cluster's Data API:

```sql
SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 3;
```

Expected: `0027_programme_tables.sql` present.

- [ ] **Step 3: Round-trip a programme**

1. Import a small CSV programme through the UI against the test stack.
2. `GET /api/org/programme?site=<uuid>` — parents and leaves match the file.
3. **Refresh the browser.** The programme is still there. This is the defect this plan exists to fix; if it fails, stop.
4. Change a task's progress. Confirm no Save button was needed and:

```sql
SELECT name, progress_pct, row_version, locally_modified
FROM programme_tasks WHERE programme_id = '<id>' ORDER BY sort_order LIMIT 5;
```

`row_version` incremented, and `locally_modified` is true for the edited
imported row.

- [ ] **Step 4: Verify the snapshot still satisfies the matcher**

```bash
aws s3 cp s3://fieldsight-data-test-509194952652/programmes/<site_id>/programme.json - | head -40
```

Confirm `leaves[].task_id` are the file's identifiers (not UUIDs), and that
`start` / `end` are ISO strings.

Then trigger the matcher with `{"dry_run": true}` against a report date that
has a topic mentioning one of the tasks, and confirm it still produces a
candidate. **If it does not, stop** — the snapshot is wrong, and Task 3's
tests need a case for whatever it got wrong.

- [ ] **Step 5: Confirm the permission matrix on real accounts**

As a `site_manager` account assigned to a task:

- `PATCH {progress_pct: 60}` → 200
- `PATCH {start_date: "..."}` on an imported row → 403 mentioning the delay flag
- `PATCH {progress_pct: 60}` on a task assigned to someone else → 403

- [ ] **Step 6: Open the PR**

```bash
gh pr create --base dev --title "feat(programme): Aurora storage foundation" --body "$(cat <<'BODY'
Plan B of Project 1.
Spec: fieldsight-ui/docs/superpowers/specs/2026-08-02-programme-foundation-design.md
Plan: fieldsight-ui/docs/superpowers/plans/2026-08-02-programme-storage-foundation.md

Moves the programme off a single S3 JSON document onto Aurora, so it survives
a refresh and saves incrementally.

- migration 0027: six tables, with task identity (surrogate UUID) and file
  identity (source_task_id) kept as separate columns
- per-task REST replacing whole-document PUT as the day-to-day write path
- row-level permissions: a site manager can report progress but cannot move a
  contract date
- the S3 snapshot is regenerated inside the request transaction, so
  lambda_programme_matcher.py is unchanged and the whole change is revertible

Out of scope, by design: import reconciliation and the dry-run diff (Plan C),
the time-window view (Plan D). PUT keeps today's replace semantics.

## Verification

- `pytest tests/unit` — green, 29 new tests
- test stack: import → refresh → programme still there; progress edit with no
  Save button; row_version increments; locally_modified set on the edited
  imported row
- snapshot re-read from S3 and matcher dry-run still produces candidates
- permission matrix exercised on a real site_manager account

## Migration risk

None. Production holds no programme data
(`aws s3 ls s3://fieldsight-data-509194952652/programmes/` → 0 objects), so
there is nothing to migrate and nothing to lose.
BODY
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4 schema, six tables | 1 |
| §4.1 identity vs matching key | 1 (CHECK + partial unique index), 3 (`_doc_id`) |
| §5 arbitrary-depth tree | 1 (`parent_id` self-reference), 3 (group derived from having children) |
| §9 API surface — GET, PATCH, POST, DELETE | 4, 5 |
| §9 window query `GET /programme/tasks?from=&to=` | **Plan D** — it exists to serve the time-window view, and building it here would leave an endpoint with no caller |
| §10 permission matrix | 5 |
| §10 delay flag | 1 (table). Endpoint is **Plan D**, with the UI that raises one |
| §11 autosave + optimistic lock | 2 (`row_version`), 5 (409), 6 (frontend) |
| §12 dual write, matcher untouched | 3, 4 (`_write_snapshot`) |
| §12 migration: none needed | 7 (PR body records the evidence) |
| §6 import modes, diff, versions, rollback, baseline | **Plan C** |

Three spec items are deferred with a stated reason rather than silently
dropped. The `programme_versions` and `programme_delay_flags` tables are
created here because a later migration to add them would be pure churn, and
`record_version` is already written on every PUT so Plan C inherits a
populated history rather than starting from an empty table.

**Placeholders:** none. Every step carries the code it needs. Task 6 step 6
describes the page wiring in prose rather than a diff because Plan A moves
the surrounding lines and a literal patch would not apply cleanly; the
behaviour is specified exactly (400 ms debounce per task id, `applyConflict`
on 409, remove the Save button and its `dirty`/`saving` state).

**Type consistency:** `programme_tasks.get_task/update_task/create_task/
delete_local_task/list_assignees/set_assignees/get_primary_programme/
get_primary_programme_by_id/record_version/replace_all_tasks/list_tasks` are
named identically in Task 2's implementation, Task 2's tests and their call
sites in Tasks 4 and 5. `update_task` returns `dict | None` and Task 5 tests
`is None` to raise the 409. `can_edit_task` returns `str | None` — a reason
or `None` — and Task 5's tests assert both directions. `build_snapshot`
returns `{name, start_date, end_date, parents, leaves}` and Task 4 adds
`programme_id` and `current_version` to it after the call, so the snapshot
written to S3 stays exactly the legacy shape.

**One risk the reviewer should look at closely:** `_write_snapshot` runs
inside the request transaction. If the S3 write is slow, it extends the
transaction and holds row locks for its duration. The alternative — commit
Aurora, then write S3 — trades that for a window where the matcher reads a
programme that no longer matches the database. The transactional choice is
right, but if PATCH latency becomes a problem the fix is to make the snapshot
asynchronous with a durable outbox, **not** to move the S3 write outside the
transaction and hope.
