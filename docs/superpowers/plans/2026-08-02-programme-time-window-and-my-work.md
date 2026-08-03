# Programme Time Window and My Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a bounded time range the thing that gets loaded rather than a filter over a loaded programme, and reuse that one view — filtered to the caller — as My Work, so a site manager sees their own slice and a PM sees the whole thing from a single implementation.

**Architecture:** One server-side window query returns tasks intersecting `[from, to]` plus the ancestors needed to render tree structure, and serves three callers: the Programme page, My Work, and Today. Everything outside the window is reachable through a deliberately coarse Overview mode. A site manager who cannot move a contract date raises a delay flag instead, which is how site knowledge reaches the PM.

**Tech Stack:** Python 3.10+ / psycopg 3, Aurora PostgreSQL, `pytest`. Frontend: plain ES2017+ browser JS, `node:test`.

## Global Constraints

- Spec: `fieldsight-ui/docs/superpowers/specs/2026-08-02-programme-foundation-design.md` §7, §9, §10, §14. This is Plan D of four for Project 1.
- **Depends on Plan B** (migration 0027, `programme_tasks`, per-task endpoints). Plan C is independent of this one and the two can proceed in parallel.
- **The window is a load boundary, not a filter.** If any step ends up fetching the whole programme and filtering client-side, it has missed the point — that is the design's answer to 30,000-task programmes.
- **My Work is not a new page.** It is the programme window view with `assignee = me`. If it grows its own data path, delete it and start again.
- Permission empty-list rule, `?site=` UUID rule, repository style, test doubles: as in Plan B's Global Constraints.
- `fieldsight-ui`'s `main` is production and auto-deploys on merge.
- Next migration after Plan B's `0027` is **0028**.

---

## File Structure

### `fieldsight-pipeline`

| File | Responsibility |
|---|---|
| `src/migrations/0028_user_prefs.sql` (**create**) | `users.prefs jsonb` — the window choice must follow the user across devices, so localStorage is not an option. |
| `src/repositories/programme_window.py` (**create**) | The window query and its ancestor expansion. Separate from `programme_tasks` because the ancestor recursion is the one piece of real SQL complexity here. |
| `src/repositories/programme_delay_flags.py` (**create**) | Delay flag lifecycle. |
| `src/lambda_org_api.py` (**modify**) | `GET /programme/tasks`, delay-flag routes, `prefs` on `/me`. |
| `tests/unit/test_programme_window.py` (**create**) | |
| `tests/unit/test_programme_delay_flags.py` (**create**) | |

### `fieldsight-ui`

| File | Responsibility |
|---|---|
| `scripts/api/programme-window.js` (**create**) | Pure window arithmetic + preset definitions. |
| `scripts/api/programme.js` (**modify**) | `getTasksInWindow`, `raiseDelayFlag`, prefs read/write. |
| `scripts/pages/programme.js` (**modify**) | Window as the load boundary; Overview mode toggle. |
| `scripts/composites/programme-window-picker.js` (**create**) | The range control. |
| `scripts/pages/my-work.js` (**create**) | Thin wrapper: the programme window view with `assignee = me`. |
| `scripts/composites/delay-flag-modal.js` (**create**) | |
| `scripts/roles.js` (**modify**) | `mywork` nav item; Activity narrowed to managers. |
| `scripts/left-nav.js` (**modify**) | `mywork` in the DAILY group. |
| `scripts/pages/today.js` (**modify**) | Three sections; drop the all-sites fan-out. |
| `tests/programme-window.test.js` (**create**) | |
| `tests/today-sections.test.js` (**create**) | |

---

## Task 1: User preferences

**Files:**
- Create: `fieldsight-pipeline/src/migrations/0028_user_prefs.sql`
- Modify: `fieldsight-pipeline/src/lambda_org_api.py` (the `/me` handlers)

**Interfaces:**
- Produces: `prefs` on the `GET /me` response; `PATCH /me` accepts `{prefs: {...}}` and shallow-merges.

- [ ] **Step 1: Write the migration**

```sql
-- 0028: per-user UI preferences. The programme time window has to follow a
-- user between their office desktop and the site tablet, so localStorage is
-- not an option (spec §7). jsonb rather than columns because these are UI
-- choices with no referential meaning and will accrete.
ALTER TABLE users ADD COLUMN prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 2: Return prefs from `GET /me`**

Add `prefs` to the columns the `/me` handler selects and to its response body.

- [ ] **Step 3: Accept prefs on `PATCH /me`**

```python
    if "prefs" in body:
        if not isinstance(body["prefs"], dict):
            return error("prefs must be an object", 400)
        # Shallow merge: a client saving its own key must not clobber
        # another surface's preferences it never read.
        conn.cursor().execute(
            "UPDATE users SET prefs = prefs || %s WHERE id = %s",
            (Jsonb(body["prefs"]), caller["user_id"]))
```

- [ ] **Step 4: Verify and commit**

```bash
pytest tests/unit -q
git add src/migrations/0028_user_prefs.sql src/lambda_org_api.py
git commit -m "feat(users): per-user UI preferences on /me

jsonb column plus a shallow merge on PATCH, so a surface saving its own key
cannot clobber preferences belonging to a surface it never read.

The programme time window needs to follow a user between an office desktop
and a site tablet, which rules out localStorage."
```

---

## Task 2: The window query

**Files:**
- Create: `fieldsight-pipeline/src/repositories/programme_window.py`
- Test: `fieldsight-pipeline/tests/unit/test_programme_window.py`

**Interfaces:**
- Consumes: migration 0027's tables.
- Produces: `tasks_in_window(conn, programme_id, *, date_from, date_to, assignee=None) -> list[dict]`

The subtlety is ancestors. A task inside the window whose parent is outside it still needs that parent row, or the tree renders as orphans. So the query is: rows intersecting the window, **plus** the transitive ancestors of those rows, marked so the client knows which are context rather than content.

- [ ] **Step 1: Write the failing tests**

Create `fieldsight-pipeline/tests/unit/test_programme_window.py`:

```python
"""
Tests for src/repositories/programme_window.py — Task 2 of the programme
time-window plan. Spec §7.

The window is what gets loaded, not a filter over what was loaded: that is
the design's whole answer to a 30,000-task programme. So the properties that
matter are what the SQL does and does not ask for.

Ancestor expansion is the subtle part. A task inside the window whose parent
sits outside it still needs that parent row, or the tree renders as orphans —
but the parent is context, not content, and must be marked so the client does
not present it as work in the window.
"""
from repositories import programme_window as repo

from tests.unit.test_programme_tasks_repo import FakeConn

PROG = "22222222-2222-2222-2222-222222222222"


def test_the_query_filters_on_overlap_not_containment():
    """A task running from before the window to after it is very much in the
    window. Containment would hide exactly the long tasks a PM cares about."""
    conn = FakeConn([[]])
    repo.tasks_in_window(conn, PROG, date_from="2026-04-01", date_to="2026-05-31")
    sql = conn.calls[0]["sql"]
    assert "start_date <= %s" in sql and "end_date >= %s" in sql, \
        "overlap is start <= window_end AND end >= window_start"


def test_the_query_expands_ancestors_recursively():
    conn = FakeConn([[]])
    repo.tasks_in_window(conn, PROG, date_from="2026-04-01", date_to="2026-05-31")
    sql = conn.calls[0]["sql"].upper()
    assert "RECURSIVE" in sql, \
        "a parent outside the window is still needed to render the tree"


def test_ancestors_are_marked_as_context_not_content():
    conn = FakeConn([[{"id": "g", "in_window": False},
                      {"id": "t", "in_window": True}]])
    rows = repo.tasks_in_window(conn, PROG, date_from="2026-04-01", date_to="2026-05-31")
    assert [r["in_window"] for r in rows] == [False, True]


def test_soft_deleted_tasks_are_excluded():
    conn = FakeConn([[]])
    repo.tasks_in_window(conn, PROG, date_from="2026-04-01", date_to="2026-05-31")
    assert "removed_in_version IS NULL" in conn.calls[0]["sql"]


def test_an_assignee_filter_joins_the_assignee_table():
    conn = FakeConn([[]])
    repo.tasks_in_window(conn, PROG, date_from="2026-04-01", date_to="2026-05-31",
                         assignee="Sam_SM")
    sql = conn.calls[0]["sql"]
    assert "programme_task_assignees" in sql
    assert "Sam_SM" in conn.calls[0]["params"]


def test_no_assignee_filter_means_everyone_not_nobody():
    """An absent filter is 'no restriction'. The inverse reading — treating a
    missing value as an empty allow-list — is the over-permission bug this
    codebase has shipped before, and here it would silently show an empty
    programme instead."""
    conn = FakeConn([[]])
    repo.tasks_in_window(conn, PROG, date_from="2026-04-01", date_to="2026-05-31")
    assert "programme_task_assignees" not in conn.calls[0]["sql"]


def test_the_window_bounds_are_bound_as_parameters():
    conn = FakeConn([[]])
    repo.tasks_in_window(conn, PROG, date_from="2026-04-01", date_to="2026-05-31")
    params = conn.calls[0]["params"]
    assert "2026-04-01" in params and "2026-05-31" in params


def test_results_are_ordered_for_stable_rendering():
    conn = FakeConn([[]])
    repo.tasks_in_window(conn, PROG, date_from="2026-04-01", date_to="2026-05-31")
    assert "ORDER BY" in conn.calls[0]["sql"]
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/unit/test_programme_window.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `fieldsight-pipeline/src/repositories/programme_window.py`:

```python
"""The programme time-window query.

Spec: fieldsight-ui/docs/superpowers/specs/2026-08-02-programme-foundation-design.md §7

This is the load boundary, not a filter. A ten-week window over a programme of
any size is typically a few hundred rows, which is why programme size stopped
being a rendering problem: we never render 30,000 tasks because we never fetch
them.

One subtlety. A task inside the window can have a parent outside it, and
dropping the parent leaves the tree rendering as orphans. So the CTE takes the
matching rows and walks up to the root, marking the added ancestors
`in_window = false` — they are context, and the client greys them rather than
presenting them as work happening now.
"""
from psycopg.rows import dict_row

_COLS = (
    "id, programme_id, source_task_id, parent_id, origin, name, wbs_code, "
    "start_date, end_date, duration_days, progress_pct, status, zone, "
    "total_float_days, is_critical, removed_in_version, locally_modified, "
    "sort_order, row_version"
)


def tasks_in_window(conn, programme_id, *, date_from, date_to, assignee=None):
    """Tasks overlapping [date_from, date_to], plus their ancestors.

    Overlap, not containment: a task that starts before the window and ends
    after it is in the window — and containment would hide precisely the long
    tasks a PM most needs to see.

    `assignee=None` means no restriction. It must never be turned into an
    empty allow-list; that inversion has shipped here before, and in this
    query it would render an empty programme with no error.
    """
    params = [programme_id, date_to, date_from]
    assignee_join = ""
    if assignee is not None:
        assignee_join = (
            " AND EXISTS (SELECT 1 FROM programme_task_assignees a "
            "             WHERE a.task_id = t.id AND a.assignee = %s)")
        params.append(assignee)

    sql = f"""
        WITH RECURSIVE matched AS (
            SELECT t.id, t.parent_id
              FROM programme_tasks t
             WHERE t.programme_id = %s
               AND t.removed_in_version IS NULL
               AND t.start_date <= %s
               AND t.end_date   >= %s
               {assignee_join}
        ),
        with_ancestors AS (
            SELECT id, parent_id, true AS in_window FROM matched
            UNION
            SELECT p.id, p.parent_id, false AS in_window
              FROM programme_tasks p
              JOIN with_ancestors w ON w.parent_id = p.id
             WHERE p.removed_in_version IS NULL
        )
        SELECT {_COLS}, bool_or(w.in_window) AS in_window
          FROM programme_tasks t
          JOIN with_ancestors w ON w.id = t.id
         GROUP BY t.id
         ORDER BY t.sort_order, t.wbs_code NULLS LAST, t.created_at
    """
    return conn.cursor(row_factory=dict_row).execute(sql, tuple(params)).fetchall()
```

Note the `bool_or` in the aggregate: a row can be reached both as a match and
as someone else's ancestor, and being a match wins.

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/unit/test_programme_window.py -v`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add an integration test against a real database**

The recursive CTE is the one piece of SQL here that a fake cursor cannot
validate. Add to the same file:

```python
import os
import pytest

pytestmark_integration = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"),
    reason="needs a real PostgreSQL")


@pytest.mark.integration
def test_ancestors_are_returned_for_a_task_whose_parent_is_outside_the_window(pg_conn):
    """The fake cursor can assert the SQL mentions RECURSIVE; only a real
    database can prove the recursion terminates and returns the right rows."""
    # Insert: group (no dates) -> mid (Jan) -> leaf (May).
    # Window covering May must return all three, with in_window true only
    # for the leaf.
    ...
```

Fill the body using whatever fixture the repo's other `@pytest.mark.integration`
tests use for a connection (`grep -rn "mark.integration" tests/`). If no
fixture exists, create the rows with raw `conn.cursor().execute` inserts and
roll back at the end.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/programme_window.py tests/unit/test_programme_window.py
git commit -m "feat(programme): time-window query with ancestor expansion

The window is the load boundary rather than a filter, which is what stops
programme size from being a rendering problem: a ten-week window is a few
hundred rows regardless of whether the programme has 500 tasks or 30,000.

Matching is on overlap, not containment — a task spanning the whole window is
in it, and containment would hide exactly the long tasks a PM watches. The
recursive CTE pulls in ancestors so a task whose parent sits outside the
window still renders in a tree, marked in_window = false so the client greys
them as context rather than showing them as work happening now."
```

---

## Task 3: The window endpoint and delay flags

**Files:**
- Create: `fieldsight-pipeline/src/repositories/programme_delay_flags.py`
- Modify: `fieldsight-pipeline/src/lambda_org_api.py`
- Test: `fieldsight-pipeline/tests/unit/test_programme_delay_flags.py`

**Interfaces:**
- Produces: `GET /programme/tasks?site=&from=&to=&assignee=`, `POST /programme/tasks/{id}/delay-flag`, `GET /programme/delay-flags?site=&state=`, `POST /programme/delay-flags/{id}/acknowledge`.

- [ ] **Step 1: Write the window handler**

```python
# A window with no bounds would fetch the whole programme, which is the thing
# this endpoint exists to avoid.
_MAX_WINDOW_DAYS = 400


def list_programme_tasks(conn, caller, event):
    params = event.get("queryStringParameters") or {}
    site_id, err = _resolve_site_param(conn, caller, params.get("site"))
    if err is not None:
        return err

    date_from, date_to = params.get("from"), params.get("to")
    if not date_from or not date_to:
        return error("from and to are required", 400)
    try:
        span = (date.fromisoformat(date_to) - date.fromisoformat(date_from)).days
    except ValueError:
        return error("from and to must be YYYY-MM-DD", 400)
    if span < 0:
        return error("from must be on or before to", 400)
    if span > _MAX_WINDOW_DAYS:
        return error(f"window may not exceed {_MAX_WINDOW_DAYS} days — "
                     f"use the overview for a whole programme", 400)

    prog = programme_tasks.get_primary_programme(conn, site_id)
    if prog is None:
        return ok({"tasks": [], "programme_id": None})

    # `assignee` absent means no restriction. Only a present value narrows.
    assignee = params.get("assignee")
    if assignee == "me":
        assignee = caller.get("folder_name")
        if not assignee:
            # No folder identity means no programme work can be attributed to
            # this caller. Return nothing, not everything.
            return ok({"tasks": [], "programme_id": str(prog["id"])})

    rows = programme_window.tasks_in_window(
        conn, prog["id"], date_from=date_from, date_to=date_to, assignee=assignee)
    amap = programme_tasks.list_assignees(conn, [r["id"] for r in rows])
    for r in rows:
        r["assignees"] = amap.get(str(r["id"]), [])
    return ok({"tasks": rows, "programme_id": str(prog["id"]),
               "baseline_version": prog["baseline_version"]})
```

The `assignee == "me"` branch is where the empty-list trap would bite: a
caller with no `folder_name` has no attributable work, and the correct answer
is an empty list, not the unfiltered programme.

- [ ] **Step 2: Write the delay-flag repository**

Create `src/repositories/programme_delay_flags.py` with `raise_flag(conn, *,
task_id, raised_by, reason, expected_end)`, `list_for_site(conn, site_id,
state='open')` and `set_state(conn, flag_id, state)`, in the module-level-SQL
style of `programme_suggestions.py`.

- [ ] **Step 3: Write the failing delay-flag tests**

Create `fieldsight-pipeline/tests/unit/test_programme_delay_flags.py`:

```python
"""
Tests for the delay-flag path — Task 3 of the programme time-window plan.
Spec §10, scenario D.

A site manager knows a date has slipped before the plan does. They cannot
change a contract date — the next import would overwrite it — so they raise a
flag carrying the reason and the expected new date, and it surfaces to the PM
who reschedules in P6/MSP and re-imports.

The rule under test: raising is open to a site manager and above, and
acknowledging is a manager action. Letting a site manager acknowledge their
own flag would let the signal be closed without ever reaching the person who
can act on it.
"""
import pytest

from repositories import programme_delay_flags as repo

from tests.unit.test_programme_tasks_repo import FakeConn

TASK = "11111111-1111-1111-1111-111111111111"
USER = "33333333-3333-3333-3333-333333333333"


def test_raise_flag_records_reason_and_expected_end():
    conn = FakeConn([{"id": "f1"}])
    repo.raise_flag(conn, task_id=TASK, raised_by=USER,
                    reason="concrete pump unavailable", expected_end="2026-05-08")
    params = conn.calls[0]["params"]
    assert "concrete pump unavailable" in params
    assert "2026-05-08" in params


def test_raise_flag_requires_a_reason():
    """A flag with no reason is noise the PM cannot act on."""
    conn = FakeConn([])
    with pytest.raises(ValueError):
        repo.raise_flag(conn, task_id=TASK, raised_by=USER, reason="  ",
                        expected_end=None)
    assert conn.calls == []


def test_list_defaults_to_open_flags():
    conn = FakeConn([[]])
    repo.list_for_site(conn, "site-uuid")
    assert "open" in conn.calls[0]["params"]


def test_set_state_rejects_an_unknown_state():
    conn = FakeConn([])
    with pytest.raises(ValueError):
        repo.set_state(conn, "f1", "banana")
    assert conn.calls == []
```

- [ ] **Step 4: Wire the routes**

```python
    if route == "/programme/tasks" and method == "GET":
        return list_programme_tasks(conn, caller, event)
    m_df = re.match(r"^/programme/tasks/([^/]+)/delay-flag$", route)
    if m_df and method == "POST":
        return raise_delay_flag(conn, caller, m_df.group(1), parse_body(event))
    if route == "/programme/delay-flags" and method == "GET":
        return list_delay_flags(conn, caller, event)
    m_da = re.match(r"^/programme/delay-flags/([^/]+)/acknowledge$", route)
    if m_da and method == "POST":
        return acknowledge_delay_flag(conn, caller, m_da.group(1))
```

Order matters: `/programme/tasks` GET must be registered **before** the
`^/programme/tasks/([^/]+)$` PATCH/DELETE pattern from Plan B is reached, and
the `/delay-flag` suffix pattern must be registered before the bare
`([^/]+)$` pattern, or `tasks/<id>/delay-flag` will never match.

`raise_delay_flag` allows `site_manager` and above; `acknowledge_delay_flag`
requires `_MANAGER_ROLES`.

- [ ] **Step 5: Verify and commit**

```bash
pytest tests/unit -q
git add src/repositories/programme_delay_flags.py src/lambda_org_api.py \
        tests/unit/test_programme_delay_flags.py
git commit -m "feat(programme): window endpoint and delay flags

GET /programme/tasks serves the Programme window view, My Work and Today from
one query, replacing Today's fan-out across every org site. The window is
capped at 400 days: an unbounded one would fetch the whole programme, which is
what this endpoint exists to avoid.

assignee=me resolves to the caller's folder_name, and a caller without one
gets an empty list rather than the unfiltered programme — the empty-list
inversion this codebase has shipped before.

Delay flags carry the site's knowledge to the PM. Raising is open to a site
manager; acknowledging is not, because letting the raiser close their own
flag would let the signal die before reaching anyone who can act on it."
```

---

## Task 4: Window arithmetic on the client

**Files:**
- Create: `fieldsight-ui/scripts/api/programme-window.js`
- Test: `fieldsight-ui/tests/programme-window.test.js`

**Interfaces:**
- Produces: `PRESETS`, `resolveWindow(preset, today) -> {from, to}`, `isInWindow(task, window) -> boolean`

- [ ] **Step 1: Write the failing test**

Create `fieldsight-ui/tests/programme-window.test.js`:

```js
'use strict';

/*
 * The programme time window.
 *
 * Presets are expressed as weeks back and weeks forward from today, because
 * that is how the work is actually discussed on site — "the last fortnight
 * and the next month" — not as absolute dates.
 */
const test = require('node:test');
const assert = require('node:assert');

const { PRESETS, resolveWindow, isInWindow } = require('../scripts/api/programme-window.js');

test('the default window is two weeks back and four weeks forward', () => {
  const def = PRESETS.find((p) => p.default);
  assert.ok(def, 'exactly one preset must be marked default');
  assert.strictEqual(def.backWeeks, 2);
  assert.strictEqual(def.forwardWeeks, 4);
});

test('resolveWindow turns a preset into absolute dates around today', () => {
  const w = resolveWindow({ backWeeks: 2, forwardWeeks: 4 }, '2026-05-01');
  assert.strictEqual(w.from, '2026-04-17');
  assert.strictEqual(w.to, '2026-05-29');
});

test('every preset stays inside the 400-day server cap', () => {
  PRESETS.forEach((p) => {
    const days = (p.backWeeks + p.forwardWeeks) * 7;
    assert.ok(days <= 400, p.label + ' exceeds the server window cap');
  });
});

test('a task spanning the whole window is in it', () => {
  const w = { from: '2026-04-17', to: '2026-05-29' };
  assert.strictEqual(isInWindow({ start: '2026-01-01', end: '2026-12-31' }, w), true);
});

test('a task touching only the first day of the window is in it', () => {
  const w = { from: '2026-04-17', to: '2026-05-29' };
  assert.strictEqual(isInWindow({ start: '2026-03-01', end: '2026-04-17' }, w), true);
});

test('a task ending the day before the window is out', () => {
  const w = { from: '2026-04-17', to: '2026-05-29' };
  assert.strictEqual(isInWindow({ start: '2026-03-01', end: '2026-04-16' }, w), false);
});

test('a task with no dates is never in the window', () => {
  const w = { from: '2026-04-17', to: '2026-05-29' };
  assert.strictEqual(isInWindow({ start: null, end: null }, w), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/programme-window.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `fieldsight-ui/scripts/api/programme-window.js` using the dual-export
idiom, with:

```js
  /* Weeks back / forward rather than absolute dates: it is how the work gets
     discussed on site, and it keeps the window anchored to today without the
     user having to re-pick it every morning. */
  var PRESETS = [
    { key: '2-4', label: '2 weeks back · 4 ahead', backWeeks: 2, forwardWeeks: 4, default: true },
    { key: '2-8', label: '2 weeks back · 8 ahead', backWeeks: 2, forwardWeeks: 8 },
    { key: '4-4', label: '4 weeks back · 4 ahead', backWeeks: 4, forwardWeeks: 4 },
    { key: '4-12', label: '4 weeks back · 12 ahead', backWeeks: 4, forwardWeeks: 12 },
    { key: '8-8', label: '8 weeks back · 8 ahead', backWeeks: 8, forwardWeeks: 8 },
  ];

  function addDays(iso, n) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function resolveWindow(preset, todayISO) {
    return {
      from: addDays(todayISO, -preset.backWeeks * 7),
      to:   addDays(todayISO,  preset.forwardWeeks * 7),
    };
  }

  /* Overlap, matching the server's rule exactly. Containment would hide the
     long tasks, which are the ones worth watching. */
  function isInWindow(task, window) {
    if (!task.start || !task.end) return false;
    return task.start <= window.to && task.end >= window.from;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/programme-window.test.js` → PASS, 7 tests.
Then `node --test tests/*.test.js`.

- [ ] **Step 5: Commit**

```bash
git add scripts/api/programme-window.js tests/programme-window.test.js
git commit -m "feat(programme): time-window presets and overlap arithmetic

Presets are weeks back and forward rather than absolute dates: that is how
the work is discussed on site, and it keeps the window anchored to today
without the user re-picking it every morning.

isInWindow uses the same overlap rule as the server query, so a task the
server returns is never one the client then hides."
```

---

## Task 5: The programme page loads a window

**Files:**
- Create: `fieldsight-ui/scripts/composites/programme-window-picker.js`
- Modify: `fieldsight-ui/scripts/pages/programme.js`
- Modify: `fieldsight-ui/scripts/api/programme.js`

- [ ] **Step 1: Add the API function**

```js
  async function getTasksInWindow(orgSiteId, opts) {
    if (orgLive()) {
      return window.FS.api.orgRequest('/programme/tasks', {
        params: {
          site: orgSiteId, from: opts.from, to: opts.to,
          assignee: opts.assignee || undefined,
        },
      });
    }
    await window.FS.api.delay();
    var doc = (await getProgramme(orgSiteId)).programme;
    if (!doc) return { tasks: [] };
    var win = { from: opts.from, to: opts.to };
    return { tasks: doc.leaves.filter(function (t) {
      return window.FS.api.programmeWindow.isInWindow(t, win);
    }) };
  }
```

- [ ] **Step 2: Make the window the load boundary**

In `ProgrammeProvider`:

- Hold `windowPreset`, seeded from `FS.api.me.prefs.programmeWindow` and
  falling back to the default preset.
- Fetch through `getTasksInWindow` rather than `getProgramme` whenever the
  page is in window mode.
- On preset change: `PATCH /me {prefs: {programmeWindow: key}}` and refetch.

**Do not** fetch the whole programme and filter locally. If the code ends up
doing that, the entire design has been reduced to a cosmetic filter.

- [ ] **Step 3: Add the Overview mode**

A toggle in the programme header switching between **Window** (default) and
**Overview**. Overview calls `getProgramme` — the whole tree — and renders
deliberately coarse: month tier, all groups collapsed, no per-day grid, no
drag. Its purpose is orientation, and its coarseness is what keeps it
affordable on a large programme.

Render ancestors returned with `in_window: false` at reduced emphasis with a
tooltip reading "outside the selected range".

- [ ] **Step 4: Verify in the browser**

With `?bigprogramme=1` (the 5,000-leaf fixture from Plan A), confirm the
window view mounts a few hundred rows rather than 5,200, that switching
presets refetches, that the choice survives a reload, and that Overview
renders the whole programme without locking up.

- [ ] **Step 5: Commit**

```bash
git add scripts/composites/programme-window-picker.js scripts/pages/programme.js \
        scripts/api/programme.js app-shell-preview.html
git commit -m "feat(programme): load a time window rather than the whole programme

The window is the load boundary. A ten-week range is a few hundred rows on a
programme of any size, so programme size stops being a rendering problem
instead of being managed around.

Everything outside it is reachable through Overview, which is coarse on
purpose — month tier, collapsed, no drag. Its job is orientation, and that
coarseness is what keeps it affordable.

The preset is stored in user prefs rather than localStorage so it follows a
user from the office desktop to the site tablet."
```

---

## Task 6: My Work

**Files:**
- Create: `fieldsight-ui/scripts/pages/my-work.js`
- Modify: `fieldsight-ui/scripts/roles.js`, `scripts/left-nav.js`

**Interfaces:**
- Consumes: Task 5's window view.
- Produces: route `/my-work`, nav item `mywork`.

- [ ] **Step 1: Write the page as a thin wrapper**

`my-work.js` renders the same middle column and right detail as `/programme`,
passing `assignee: 'me'` into `getTasksInWindow` and hiding the site picker
(a site manager has one site; a PM using My Work wants their own work, not a
project chooser).

It must not carry its own fetching, row model or renderer. If it needs
something the programme view cannot do, add it to the programme view behind a
prop.

- [ ] **Step 2: Register the nav item**

In `scripts/roles.js`:

```js
  mywork:     { permission: P('programme', 'view'),                   label: 'My Work' },
```

`site_manager` already holds `P('programme','view', SCOPES.SITE)`, so this
grants it without touching any role definition.

In `scripts/left-nav.js`, DAILY becomes:

```js
    items: ['today', 'mywork', 'activity'],
```

- [ ] **Step 3: Narrow Activity to managers**

Activity is per-person contribution history — backward-looking team oversight.
For a worker the aggregator returns only their own row, making it a poor
duplicate of their own timeline, and for a site manager it answers a question
they rarely ask. Narrowing it is what leaves site managers with a clean
`Today / My Work` nav.

In `scripts/roles.js`, change the Activity entry:

```js
  /* Activity answers "what did each person do" — backward-looking oversight,
     a different question from My Work's "what do I have coming". Gated on its
     own permission rather than report:view, which every role holds. */
  activity:   { permission: P('activity',  'view'),                   label: 'Activity' },
```

and add `P('activity', 'view', SCOPES.PROJECT)` to `project_manager`,
`construction_manager`, `gm`, `director` and the admin role. Do **not** add it
to `worker`, `foreman`, `site_manager` or `client_viewer`.

- [ ] **Step 4: Verify**

Sign in as each of `site_manager`, `project_manager` and `worker`. Confirm the
DAILY nav shows `Today / My Work` for the first and third, `Today / My Work /
Activity` for the second, and that `/activity` is not reachable by direct URL
for a site manager.

- [ ] **Step 5: Commit**

```bash
git add scripts/pages/my-work.js scripts/roles.js scripts/left-nav.js \
        app-shell-preview.html
git commit -m "feat(programme): My Work, and narrow Activity to managers

My Work is the programme window view with assignee=me — same data, same
endpoint, same renderer. One implementation serves the site manager's own
slice and the PM's full view; a second data path would drift from the first
within a sprint.

Activity moves off report:view, which every role holds, onto its own
permission granted to PM and above. It answers 'what did each person do' —
backward-looking oversight, a different question from My Work's 'what do I
have coming'. For a worker it returned only their own row, making it a poor
duplicate of their own timeline. Narrowing it is what leaves site managers
with a clean Today / My Work nav."
```

---

## Task 7: Today keeps three sections

**Files:**
- Modify: `fieldsight-ui/scripts/pages/today.js`
- Test: `fieldsight-ui/tests/today-sections.test.js`

Spec §14. Today answers "what do I do today". Everything else assigned to the
caller belongs in My Work. The one thing allowed to interrupt that is work
that is overdue and still open.

This also removes `today-programme-adapter.js`'s fan-out, which currently
calls `pooledAll` across every org site and downloads each whole programme
document to select a handful of rows.

- [ ] **Step 1: Write the failing test**

Create `fieldsight-ui/tests/today-sections.test.js`:

```js
'use strict';

/*
 * Today's section model.
 *
 * Today answers "what do I do today". Anything else assigned to the caller
 * lives in My Work — a Today that lists everything stops being read at all.
 * The single exception is overdue-and-open work, which is the one thing worth
 * interrupting for.
 */
const test = require('node:test');
const assert = require('node:assert');

const { bucketTodayTasks } = require('../scripts/api/today-sections.js');

const TODAY = '2026-05-01';

function t(id, end, status) {
  return { task_id: id, end: end, status: status || 'not_started' };
}

test('overdue and still open comes first', () => {
  const b = bucketTodayTasks([t('late', '2026-04-20')], TODAY);
  assert.deepStrictEqual(b.overdue.map((x) => x.task_id), ['late']);
});

test('overdue but completed is not overdue', () => {
  const b = bucketTodayTasks([t('done', '2026-04-20', 'completed')], TODAY);
  assert.strictEqual(b.overdue.length, 0);
  assert.strictEqual(b.today.length + b.soon.length, 0,
    'finished work belongs in neither bucket');
});

test('due today lands in today', () => {
  const b = bucketTodayTasks([t('now', TODAY)], TODAY);
  assert.deepStrictEqual(b.today.map((x) => x.task_id), ['now']);
});

test('due within three days lands in soon', () => {
  const b = bucketTodayTasks([t('soon', '2026-05-04')], TODAY);
  assert.deepStrictEqual(b.soon.map((x) => x.task_id), ['soon']);
});

test('due beyond three days appears in no Today bucket', () => {
  const b = bucketTodayTasks([t('later', '2026-05-20')], TODAY);
  assert.strictEqual(b.overdue.length + b.today.length + b.soon.length, 0,
    'it belongs in My Work, not Today');
});

test('a task appears in exactly one bucket', () => {
  const b = bucketTodayTasks(
    [t('a', '2026-04-20'), t('b', TODAY), t('c', '2026-05-03')], TODAY);
  const all = [].concat(b.overdue, b.today, b.soon).map((x) => x.task_id);
  assert.strictEqual(new Set(all).size, all.length);
  assert.strictEqual(all.length, 3);
});

test('a task with no due date is not overdue', () => {
  const b = bucketTodayTasks([t('undated', null)], TODAY);
  assert.strictEqual(b.overdue.length, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/today-sections.test.js` → module not found.

- [ ] **Step 3: Write the module**

Create `fieldsight-ui/scripts/api/today-sections.js` (dual export) with
`bucketTodayTasks(tasks, todayISO)` returning `{overdue, today, soon}`,
`soon` being 1-3 days out, closed statuses (`completed`, `cancelled`) excluded
from every bucket, and undated tasks never counted as overdue.

- [ ] **Step 4: Rewire Today's data source**

Replace the `getUpcomingProgrammeTasks` call in `today.js` with a single
`getTasksInWindow(siteId, {from: today - 30d, to: today + 3d, assignee: 'me'})`,
then bucket the result. Delete the `pooledAll` fan-out in
`scripts/api/today-programme-adapter.js` and anything left with no callers.

The 30-day look-back exists so an item that went overdue last month still
appears; it is not a display range.

- [ ] **Step 5: Render the three sections**

Overdue first, red, **hidden entirely when empty** — an always-present "0
overdue" heading trains people to skip the section that matters most. Then
today, then next 2-3 days. Below them, the existing on-site card stays.

- [ ] **Step 6: Verify and commit**

```bash
node --test tests/*.test.js
git add scripts/api/today-sections.js scripts/pages/today.js \
        scripts/api/today-programme-adapter.js app-shell-preview.html \
        tests/today-sections.test.js
git commit -m "feat(today): three sections, and one query instead of a fan-out

Today answers 'what do I do today'; everything else assigned to the caller
lives in My Work, because a Today that lists everything stops being read.
Overdue-and-open is the single exception, and it is hidden entirely when
empty — a permanent '0 overdue' heading trains people to skip the section
that matters most.

The data now comes from one window query. It previously fanned out across
every org site with pooledAll and downloaded each whole programme document to
select a handful of rows."
```

---

## Task 8: Delay flag UI and verification

**Files:**
- Create: `fieldsight-ui/scripts/composites/delay-flag-modal.js`
- Modify: `fieldsight-ui/scripts/pages/programme.js`, `scripts/pages/my-work.js`

- [ ] **Step 1: Build the modal**

Opened from a task's detail pane. Fields: reason (required), expected new end
date (optional), and a read-only line showing the current contract dates so
the person can see what they are flagging against.

For a site manager, the 403 returned when they try to edit an imported task's
dates should offer this modal directly — the refusal already names the delay
flag, so the UI should make it one click rather than a search.

- [ ] **Step 2: Surface open flags to the PM**

On the programme page, a task with an open delay flag carries a marker; the
detail pane shows who raised it, when, why and the expected new date, with an
Acknowledge action. This is the point of the feature — a flag nobody sees is
worse than no flag, because the site manager believes they reported it.

- [ ] **Step 3: End-to-end verification on the test stack**

1. As a **site manager**: open My Work, confirm only tasks assigned to them
   appear, and that changing the preset refetches rather than filtering
   locally (check the network panel — one request per change, and the row
   count changes).
2. Attempt to edit an imported task's start date → 403 offering the delay
   flag. Raise one.
3. As a **PM**: confirm the flag appears on that task, acknowledge it.
4. Reload as the site manager: the window preset survived.
5. On the 5,000-task fixture: confirm the window request returns a few hundred
   tasks, not 5,000. **If it returns all of them, the window is being applied
   client-side and this task is not done.**
6. Today shows only overdue / today / next 3 days, and the overdue section is
   absent rather than empty when there is nothing overdue.

- [ ] **Step 4: Open the PR**

Title: `feat(programme): time window, My Work, and delay flags`

The body must record the row count from verification step 5 — it is the single
number that shows the window is a load boundary rather than a filter.

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| §7 window as the load boundary | 2, 5 |
| §7 default 2 back / 4 forward, selectable | 4 |
| §7 preference follows the user, not localStorage | 1, 5 |
| §7 Overview mode, deliberately coarse | 5 |
| §9 `GET /programme/tasks?site=&from=&to=&assignee=` | 3 |
| §9 replaces Today's all-sites fan-out | 7 |
| §10 delay flag endpoint and UI | 3, 8 |
| §14 Today: three sections, overdue hidden when empty | 7 |
| §14 My Work reuses the programme view | 6 |
| §14 Activity restricted to managers | 6 |

**Placeholders:** Tasks 5, 6 and 8 describe UI construction in prose rather
than as diffs, because they modify files Plan A and Plan B have already
rewritten and a literal patch would not apply. Each names the exact function,
prop or endpoint involved. Task 2 step 5's integration test body is left to
the implementer because it depends on which connection fixture the repo's
existing `@pytest.mark.integration` tests use — the step says to find it with
a specific grep, and states exactly what the test must prove.

**Type consistency:** `tasks_in_window` returns rows carrying `in_window`,
which Task 5 reads to grey ancestors. `resolveWindow` returns `{from, to}`,
matching the `opts` shape `getTasksInWindow` takes and the `from`/`to` query
parameters the handler reads. `PRESETS` entries carry
`{key, label, backWeeks, forwardWeeks}` and `key` is what is stored in
`prefs.programmeWindow`. `bucketTodayTasks` returns `{overdue, today, soon}`,
which Task 7 step 5 renders in that order.

**The one thing most likely to go wrong:** Task 5 is easy to implement as
"fetch everything, then filter" — it is fewer lines, it makes the preset
switch feel instant, and every test in this plan would still pass. It would
also silently discard the entire point of the design, and the failure would
not show up until someone imported a genuinely large programme. Verification
step 5 in Task 8 exists specifically to catch it, and it asserts on the
network request rather than on what is rendered.
