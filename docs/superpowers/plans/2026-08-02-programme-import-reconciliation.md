# Programme Import Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make re-importing a revised programme an act of reconciliation rather than destruction — the client's monthly revision updates what it owns, while allocations, breakdown subtasks and recorded progress survive.

**Architecture:** Reconciliation is a pure function over the existing rows and the parsed file, producing a plan of inserts, updates and soft-removals joined on `source_task_id`. The endpoint runs it twice: once as a dry run that returns a diff for the user to look at, then again to commit the mode they chose. Nothing is ever hard-deleted, so every destructive path is reversible from `programme_versions`.

**Tech Stack:** Python 3.10+ / psycopg 3, Aurora PostgreSQL, `pytest`. Frontend: plain ES2017+ browser JS, `node:test`.

## Global Constraints

- Spec: `fieldsight-ui/docs/superpowers/specs/2026-08-02-programme-foundation-design.md` §6. This is Plan C of four for Project 1.
- **Depends on Plan B.** Migration 0027, `repositories/programme_tasks.py`, `repositories/programme_snapshot.py` and the per-task endpoints must be merged first. Do not start until they are.
- **Cross-repo.** Backend in `fieldsight-pipeline`, frontend in `fieldsight-ui`.
- **Nothing is hard-deleted.** Rows that leave the file get `removed_in_version`; a Replace archives the prior version rather than dropping it. If a step reads like it deletes user data, it is wrong.
- **Import owns imported fields; we own local rows.** An import never edits, moves or removes a `local` row's own content. It may only reschedule a local row in response to its parent moving, under the rules in Task 3.
- Repository style, test doubles, `?site=` UUID rule, permission empty-list rule and branch rules: as in Plan B's Global Constraints. Re-read them before starting.
- `fieldsight-ui`'s `main` is production and auto-deploys on merge.

---

## File Structure

### `fieldsight-pipeline`

| File | Responsibility |
|---|---|
| `src/programme_reconcile.py` (**create**) | Pure: existing rows + parsed file → a reconciliation plan. No database, no S3. |
| `src/programme_rebase.py` (**create**) | Pure: how a local subtree responds when its imported parent moves. |
| `src/repositories/programme_import.py` (**create**) | Applies a plan in one transaction; version history; rollback; baseline. |
| `src/lambda_org_api.py` (**modify**) | `/programme/import`, `/programme/versions`, `/programme/versions/{n}/restore`, `/programme/baseline`. |
| `tests/unit/test_programme_reconcile.py` (**create**) | |
| `tests/unit/test_programme_rebase.py` (**create**) | |
| `tests/unit/test_programme_import_repo.py` (**create**) | |

### `fieldsight-ui`

| File | Responsibility |
|---|---|
| `scripts/composites/programme-import-diff.js` (**create**) | The diff panel and mode chooser. New file rather than growing `programme-import-modal.js` (500 lines) — it is a distinct screen with its own state. |
| `scripts/composites/programme-import-modal.js` (**modify**) | New `reconcile` phase between `preview` and commit. |
| `scripts/api/programme.js` (**modify**) | `importProgramme(orgSiteId, {dryRun, mode, ...})`. |
| `scripts/composites/programme-version-history.js` (**create**) | Version list, rollback, baseline designation. |
| `tests/programme-import-diff.test.js` (**create**) | |

---

## Task 1: The reconciliation core

**Files:**
- Create: `fieldsight-pipeline/src/programme_reconcile.py`
- Test: `fieldsight-pipeline/tests/unit/test_programme_reconcile.py`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `reconcile(existing, parents, leaves, *, version_no) -> Plan`
  - `Plan` is a dict: `{"insert": [...], "update": [...], "remove": [...], "rename_candidates": [...], "summary": {...}}`
  - `suggest_mode(existing, parents, leaves) -> str` — `'update'` or `'replace'`

- [ ] **Step 1: Write the failing tests**

Create `fieldsight-pipeline/tests/unit/test_programme_reconcile.py`:

```python
"""
Tests for src/programme_reconcile.py — Task 1 of the programme import
reconciliation plan. Spec §6.3.

The property this module exists to protect: a client's monthly revision
updates the rows the file owns and leaves everything we built underneath
them alone. The failure mode is silent — a reconciliation bug does not
raise, it just quietly drops a site manager's allocations and a month of
recorded progress — so these tests assert survival explicitly, not just
counts.
"""
from programme_reconcile import reconcile, suggest_mode


def existing_task(uid, source, *, origin="imported", parent=None, name="T",
                  start=None, end=None, progress=0, removed=None):
    return {
        "id": uid, "source_task_id": source, "parent_id": parent,
        "origin": origin, "name": name, "wbs_code": None,
        "start_date": start, "end_date": end, "duration_days": None,
        "progress_pct": progress, "status": "not_started",
        "removed_in_version": removed, "locally_modified": False,
    }


def incoming_leaf(source, *, parent="G1", name="T", start="2026-04-01",
                  end="2026-04-10"):
    return {"task_id": source, "parent_id": parent, "name": name,
            "start": start, "end": end, "duration_days": 10,
            "progress_pct": 0, "status": "not_started"}


GROUP = [{"task_id": "G1", "name": "Foundations", "wbs": "1"}]


def test_a_task_present_in_both_is_updated_not_reinserted():
    existing = [existing_task("u-g", "G1"), existing_task("u-a", "A1", parent="u-g")]
    plan = reconcile(existing, GROUP, [incoming_leaf("A1")], version_no=2)
    assert [u["id"] for u in plan["update"]] == ["u-g", "u-a"] or "u-a" in [u["id"] for u in plan["update"]]
    assert plan["insert"] == []
    assert plan["remove"] == []


def test_a_rename_updates_in_place_because_the_id_is_the_join_key():
    """Spec §2: source ids are stable, names are not."""
    existing = [existing_task("u-g", "G1"),
                existing_task("u-a", "A1", parent="u-g", name="Pour slab")]
    plan = reconcile(existing, GROUP,
                     [incoming_leaf("A1", name="Pour slab to level 3")],
                     version_no=2)
    upd = [u for u in plan["update"] if u["id"] == "u-a"][0]
    assert upd["fields"]["name"] == "Pour slab to level 3"
    assert plan["insert"] == [] and plan["remove"] == []


def test_a_task_missing_from_the_file_is_soft_removed_never_deleted():
    existing = [existing_task("u-g", "G1"), existing_task("u-a", "A1", parent="u-g")]
    plan = reconcile(existing, GROUP, [], version_no=3)
    assert [r["id"] for r in plan["remove"]] == ["u-a"]
    assert all(r["removed_in_version"] == 3 for r in plan["remove"])


def test_local_rows_are_never_removed_updated_or_touched():
    """The whole point. A breakdown subtask is ours; the file has no opinion
    about it and must not be able to express one."""
    existing = [
        existing_task("u-g", "G1"),
        existing_task("u-a", "A1", parent="u-g"),
        existing_task("u-local", None, origin="local", parent="u-a", name="Formwork"),
    ]
    plan = reconcile(existing, GROUP, [incoming_leaf("A1")], version_no=2)
    touched = ({u["id"] for u in plan["update"]}
               | {r["id"] for r in plan["remove"]})
    assert "u-local" not in touched


def test_a_local_row_survives_even_when_its_imported_parent_leaves_the_file():
    """Archived with the parent, not deleted — completed work hangs off it."""
    existing = [
        existing_task("u-g", "G1"),
        existing_task("u-a", "A1", parent="u-g"),
        existing_task("u-local", None, origin="local", parent="u-a"),
    ]
    plan = reconcile(existing, GROUP, [], version_no=4)
    removed = {r["id"]: r for r in plan["remove"]}
    assert "u-a" in removed
    assert removed.get("u-local", {}).get("archived_with_parent") is True
    assert all(r["removed_in_version"] == 4 for r in plan["remove"])


def test_a_new_task_is_inserted_and_stamped_with_the_version_it_arrived_in():
    existing = [existing_task("u-g", "G1")]
    plan = reconcile(existing, GROUP, [incoming_leaf("B9")], version_no=5)
    assert len(plan["insert"]) == 1
    assert plan["insert"][0]["source_task_id"] == "B9"
    assert plan["insert"][0]["first_seen_version"] == 5


def test_a_previously_removed_task_that_reappears_is_revived_not_duplicated():
    """Its allocations and progress are still attached to that row."""
    existing = [existing_task("u-g", "G1"),
                existing_task("u-a", "A1", parent="u-g", removed=2)]
    plan = reconcile(existing, GROUP, [incoming_leaf("A1")], version_no=6)
    assert plan["insert"] == [], "reviving must not create a second row"
    upd = [u for u in plan["update"] if u["id"] == "u-a"][0]
    assert upd["fields"]["removed_in_version"] is None


def test_progress_recorded_here_is_never_overwritten_by_the_file():
    """Progress is site truth. The file's 0% is a planning artefact, not an
    observation, and must not erase what someone recorded."""
    existing = [existing_task("u-g", "G1"),
                existing_task("u-a", "A1", parent="u-g", progress=60)]
    plan = reconcile(existing, GROUP, [incoming_leaf("A1")], version_no=2)
    upd = [u for u in plan["update"] if u["id"] == "u-a"][0]
    assert "progress_pct" not in upd["fields"]


def test_locally_modified_rows_are_listed_so_the_diff_can_warn():
    existing = [existing_task("u-g", "G1"),
                dict(existing_task("u-a", "A1", parent="u-g", name="Edited here"),
                     locally_modified=True)]
    plan = reconcile(existing, GROUP, [incoming_leaf("A1", name="From file")],
                     version_no=2)
    assert "u-a" in [t["id"] for t in plan["summary"]["locally_modified_overwritten"]]


def test_summary_counts_what_the_diff_screen_shows():
    existing = [existing_task("u-g", "G1"),
                existing_task("u-a", "A1", parent="u-g", start="2026-04-01", end="2026-04-10"),
                existing_task("u-b", "B1", parent="u-g")]
    plan = reconcile(existing, GROUP,
                     [incoming_leaf("A1", start="2026-04-15", end="2026-04-24"),
                      incoming_leaf("C1")],
                     version_no=2)
    s = plan["summary"]
    assert s["added"] == 1 and s["removed"] == 1
    assert s["date_shifted"] == 1
    assert s["max_shift_days"] == 14


def test_rename_candidate_pairs_a_disappearance_with_an_arrival():
    """A planner changing an Activity ID presents as one removal plus one
    addition. Offer the repair rather than silently orphaning the row."""
    existing = [existing_task("u-g", "G1"),
                existing_task("u-a", "A1020", parent="u-g", name="Pour slab L3",
                              start="2026-04-01", end="2026-04-10")]
    plan = reconcile(existing, GROUP,
                     [incoming_leaf("A1020R1", name="Pour slab L3",
                                    start="2026-04-01", end="2026-04-10")],
                     version_no=2)
    cands = plan["rename_candidates"]
    assert len(cands) == 1
    assert cands[0]["existing_id"] == "u-a"
    assert cands[0]["incoming_source_task_id"] == "A1020R1"


def test_unrelated_add_and_remove_do_not_become_a_rename_candidate():
    existing = [existing_task("u-g", "G1"),
                existing_task("u-a", "A1", parent="u-g", name="Excavate",
                              start="2026-01-01", end="2026-01-10")]
    plan = reconcile(existing, GROUP,
                     [incoming_leaf("Z9", name="Landscaping",
                                    start="2027-06-01", end="2027-06-30")],
                     version_no=2)
    assert plan["rename_candidates"] == []


def test_suggest_mode_says_update_when_the_ids_mostly_overlap():
    existing = [existing_task(f"u{i}", f"A{i}") for i in range(10)]
    incoming = [incoming_leaf(f"A{i}") for i in range(10)]
    assert suggest_mode(existing, [], incoming) == "update"


def test_suggest_mode_says_replace_when_it_looks_like_a_different_programme():
    existing = [existing_task(f"u{i}", f"A{i}") for i in range(10)]
    incoming = [incoming_leaf(f"Z{i}") for i in range(10)]
    assert suggest_mode(existing, [], incoming) == "replace"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/unit/test_programme_reconcile.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'programme_reconcile'`

- [ ] **Step 3: Write the implementation**

Create `fieldsight-pipeline/src/programme_reconcile.py`:

```python
"""Pure reconciliation of an imported programme against what is already stored.

Spec: fieldsight-ui/docs/superpowers/specs/2026-08-02-programme-foundation-design.md §6.3

The join key is `source_task_id` and nothing else. Names change between
revisions; ids do not. Our own surrogate `id` never participates in matching —
it exists so allocations, progress and breakdown subtrees keep pointing at the
same row no matter what the file does (design §4.1).

Three rules the rest of the system depends on:

  1. A `local` row is never updated or removed by an import. It is ours.
     The one exception is being archived alongside an imported parent that
     left the file — and even then the row survives, flagged, because
     completed work and real progress records hang off it.
  2. `progress_pct` is never taken from the file. Progress is an observation
     made on site; the file's 0% is a planning artefact and overwriting with
     it would erase what someone recorded.
  3. Nothing is deleted. Departures are stamped with `removed_in_version`.
"""

# Fields the file owns. Everything else on an imported row is ours or
# structural. progress_pct and status are deliberately absent — see rule 2.
_IMPORT_OWNED = ("name", "wbs_code", "start_date", "end_date", "duration_days")

# Rename detection. A candidate needs the same name and starts within this
# many days of the row that disappeared; anything looser starts pairing
# genuinely unrelated tasks, and a wrong pairing silently transplants one
# task's history onto another.
_RENAME_MAX_DAY_DRIFT = 14


def _norm(s):
    return " ".join((s or "").lower().split())


def _days_between(a, b):
    if not a or not b:
        return None
    from datetime import date
    def d(v):
        return v if isinstance(v, date) else date.fromisoformat(str(v))
    return abs((d(a) - d(b)).days)


def _iso(v):
    if v is None:
        return None
    return v if isinstance(v, str) else v.isoformat()


def _incoming_rows(parents, leaves):
    """One flat list keyed by the file's id, groups first so a leaf can
    resolve its parent."""
    rows = []
    for p in parents or []:
        rows.append({
            "source_task_id": p["task_id"],
            "parent_source_id": None,
            "name": p.get("name") or p["task_id"],
            "wbs_code": p.get("wbs"),
            "start_date": None, "end_date": None, "duration_days": None,
        })
    for t in leaves or []:
        rows.append({
            "source_task_id": t["task_id"],
            "parent_source_id": t.get("parent_id"),
            "name": t.get("name") or t["task_id"],
            "wbs_code": t.get("wbs"),
            "start_date": _iso(t.get("start")),
            "end_date": _iso(t.get("end")),
            "duration_days": t.get("duration_days"),
        })
    return rows


def reconcile(existing, parents, leaves, *, version_no):
    incoming = _incoming_rows(parents, leaves)
    incoming_by_src = {r["source_task_id"]: r for r in incoming}

    imported = [t for t in existing if t.get("origin") == "imported"]
    local = [t for t in existing if t.get("origin") == "local"]
    existing_by_src = {t["source_task_id"]: t for t in imported
                       if t.get("source_task_id")}

    updates, removals, inserts = [], [], []
    locally_modified_overwritten = []
    date_shifted = 0
    max_shift = 0

    for src, row in existing_by_src.items():
        if src not in incoming_by_src:
            continue
        inc = incoming_by_src[src]

        fields = {}
        for col in _IMPORT_OWNED:
            new = inc.get(col)
            old = _iso(row.get(col)) if col.endswith("_date") else row.get(col)
            if new != old:
                fields[col] = new

        # A row that left in an earlier version and is back in this one is
        # revived in place: its allocations and progress are still attached.
        if row.get("removed_in_version") is not None:
            fields["removed_in_version"] = None

        if fields:
            shift = _days_between(inc.get("start_date"), row.get("start_date"))
            if shift:
                date_shifted += 1
                max_shift = max(max_shift, shift)
            if row.get("locally_modified"):
                locally_modified_overwritten.append(
                    {"id": row["id"], "name": row.get("name")})
            updates.append({"id": row["id"], "source_task_id": src,
                            "fields": fields})

    departed = [row for src, row in existing_by_src.items()
                if src not in incoming_by_src
                and row.get("removed_in_version") is None]
    for row in departed:
        removals.append({"id": row["id"], "source_task_id": row["source_task_id"],
                         "name": row.get("name"),
                         "removed_in_version": version_no,
                         "archived_with_parent": False})

    # Local rows hanging off a departing imported row go with it — archived,
    # not deleted, and flagged so the UI can say why they vanished.
    departing_ids = {r["id"] for r in removals}
    for row in local:
        if row.get("parent_id") in departing_ids \
                and row.get("removed_in_version") is None:
            removals.append({"id": row["id"], "source_task_id": None,
                             "name": row.get("name"),
                             "removed_in_version": version_no,
                             "archived_with_parent": True})

    for src, inc in incoming_by_src.items():
        if src in existing_by_src:
            continue
        inserts.append({
            "source_task_id": src,
            "parent_source_id": inc.get("parent_source_id"),
            "name": inc["name"], "wbs_code": inc.get("wbs_code"),
            "start_date": inc.get("start_date"), "end_date": inc.get("end_date"),
            "duration_days": inc.get("duration_days"),
            "first_seen_version": version_no,
        })

    rename_candidates = _rename_candidates(departed, inserts)

    return {
        "insert": inserts,
        "update": updates,
        "remove": removals,
        "rename_candidates": rename_candidates,
        "summary": {
            "added": len(inserts),
            "removed": len([r for r in removals if not r["archived_with_parent"]]),
            "archived_with_parent": len([r for r in removals if r["archived_with_parent"]]),
            "updated": len(updates),
            "date_shifted": date_shifted,
            "max_shift_days": max_shift,
            "locally_modified_overwritten": locally_modified_overwritten,
        },
    }


def _rename_candidates(departed, inserts):
    """Pair a disappearance with an arrival that is plausibly the same task.

    A planner renaming an Activity ID produces exactly this shape. Offering
    the repair costs one column update and preserves the row's whole history;
    not offering it orphans allocations and progress with no visible cause.

    Deliberately strict — same normalised name AND a start within
    _RENAME_MAX_DAY_DRIFT days. A wrong pairing transplants one task's
    history onto another, which is worse than making the user redo the
    allocation.
    """
    out = []
    taken = set()
    for gone in departed:
        for inc in inserts:
            if inc["source_task_id"] in taken:
                continue
            if _norm(gone.get("name")) != _norm(inc.get("name")):
                continue
            drift = _days_between(gone.get("start_date"), inc.get("start_date"))
            if drift is not None and drift > _RENAME_MAX_DAY_DRIFT:
                continue
            out.append({
                "existing_id": gone["id"],
                "existing_source_task_id": gone.get("source_task_id"),
                "incoming_source_task_id": inc["source_task_id"],
                "name": inc.get("name"),
            })
            taken.add(inc["source_task_id"])
            break
    return out


def suggest_mode(existing, parents, leaves) -> str:
    """Which mode to preselect. Low id overlap means this is probably a
    different programme, and Update would produce a huge add + huge remove
    that reads as data loss."""
    have = {t.get("source_task_id") for t in existing
            if t.get("origin") == "imported" and t.get("source_task_id")}
    incoming = {r["source_task_id"] for r in _incoming_rows(parents, leaves)}
    if not have or not incoming:
        return "update"
    overlap = len(have & incoming) / len(have | incoming)
    return "update" if overlap >= 0.3 else "replace"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/unit/test_programme_reconcile.py -v`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/programme_reconcile.py tests/unit/test_programme_reconcile.py
git commit -m "feat(programme): pure import reconciliation joined on source_task_id

Re-importing a revision now updates the rows the file owns and leaves
everything built underneath them intact.

Three rules the rest of the system leans on. A local row is never updated or
removed by an import — the one exception is being archived alongside an
imported parent that left the file, and even then it survives, flagged.
progress_pct is never taken from the file: progress is an observation made on
site, and the file's 0% is a planning artefact that would erase it. Nothing is
deleted; departures are stamped with removed_in_version.

Rename detection is deliberately strict — same normalised name and a start
within 14 days. A wrong pairing transplants one task's history onto another,
which is worse than making the user redo an allocation."
```

---

## Task 2: Local subtree rebase rules

**Files:**
- Create: `fieldsight-pipeline/src/programme_rebase.py`
- Test: `fieldsight-pipeline/tests/unit/test_programme_rebase.py`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `rebase_children(parent_before, parent_after, children) -> {"shift": [...], "invalidated": bool, "reason": str|None}`

Spec §6.4. A local subtree is scheduled relative to its imported parent, so it must react when the parent moves. The default shifts only what has not started; real dates on started work are never rewritten. When the parent's *duration* changes materially the breakdown may no longer fit at all, and the correct response is to flag it, not to reshape it — the subtasks are already allocated to named people.

- [ ] **Step 1: Write the failing tests**

Create `fieldsight-pipeline/tests/unit/test_programme_rebase.py`:

```python
"""
Tests for src/programme_rebase.py — Task 2 of the programme import
reconciliation plan. Spec §6.4.

The rule: shift what has not started, never rewrite the dates of work that
has. That can leave a visible gap between a finished child and the shifted
remainder. The gap is real and is not smoothed over — closing it would mean
asserting that work happened on days it did not.
"""
from programme_rebase import rebase_children


def parent(start, end):
    return {"start_date": start, "end_date": end}


def child(cid, start, end, progress=0):
    return {"id": cid, "start_date": start, "end_date": end,
            "progress_pct": progress}


def test_a_pure_shift_moves_every_not_started_child_by_the_same_delta():
    before, after = parent("2026-03-01", "2026-03-28"), parent("2026-03-15", "2026-04-11")
    out = rebase_children(before, after, [child("c1", "2026-03-01", "2026-03-10")])
    assert out["invalidated"] is False
    assert out["shift"][0]["start_date"] == "2026-03-15"
    assert out["shift"][0]["end_date"] == "2026-03-24"


def test_a_completed_child_keeps_its_real_dates():
    before, after = parent("2026-03-01", "2026-03-28"), parent("2026-03-15", "2026-04-11")
    out = rebase_children(before, after, [child("done", "2026-03-01", "2026-03-10", 100)])
    assert out["shift"] == [], "finished work is a record of what happened"


def test_an_in_progress_child_keeps_its_real_dates():
    before, after = parent("2026-03-01", "2026-03-28"), parent("2026-03-15", "2026-04-11")
    out = rebase_children(before, after, [child("wip", "2026-03-01", "2026-03-10", 40)])
    assert out["shift"] == []


def test_a_mixed_subtree_shifts_only_the_untouched_part():
    before, after = parent("2026-03-01", "2026-03-28"), parent("2026-03-15", "2026-04-11")
    out = rebase_children(before, after, [
        child("done", "2026-03-01", "2026-03-10", 100),
        child("next", "2026-03-11", "2026-03-20", 0),
    ])
    assert [s["id"] for s in out["shift"]] == ["next"]


def test_a_small_duration_change_scales_as_well_as_shifts():
    before = parent("2026-03-01", "2026-03-20")   # 20 days
    after  = parent("2026-03-01", "2026-03-22")   # 22 days, +10%
    out = rebase_children(before, after, [child("c1", "2026-03-01", "2026-03-10")])
    assert out["invalidated"] is False
    assert out["shift"][0]["end_date"] > "2026-03-10"


def test_a_large_duration_change_invalidates_instead_of_reshaping():
    """The subtasks are allocated to named people. Silently re-planning them
    would change someone's week without telling them."""
    before = parent("2026-03-01", "2026-03-28")   # 28 days
    after  = parent("2026-03-01", "2026-03-14")   # 14 days, -50%
    out = rebase_children(before, after, [child("c1", "2026-03-01", "2026-03-10")])
    assert out["invalidated"] is True
    assert out["shift"] == [], "an invalidated breakdown must not be silently rewritten"
    assert "duration" in out["reason"].lower()


def test_an_unchanged_parent_produces_no_work():
    p = parent("2026-03-01", "2026-03-28")
    out = rebase_children(p, p, [child("c1", "2026-03-01", "2026-03-10")])
    assert out["shift"] == [] and out["invalidated"] is False


def test_a_parent_with_no_dates_cannot_rebase_anything():
    out = rebase_children(parent(None, None), parent("2026-03-01", "2026-03-28"),
                          [child("c1", "2026-03-01", "2026-03-10")])
    assert out["shift"] == [] and out["invalidated"] is False


def test_no_children_is_not_an_invalidation():
    before, after = parent("2026-03-01", "2026-03-28"), parent("2026-03-01", "2026-03-05")
    out = rebase_children(before, after, [])
    assert out["invalidated"] is False
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/unit/test_programme_rebase.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `fieldsight-pipeline/src/programme_rebase.py`:

```python
"""How a local subtree responds when its imported parent moves.

Spec: fieldsight-ui/docs/superpowers/specs/2026-08-02-programme-foundation-design.md §6.4

Local subtasks are scheduled relative to their imported parent, so a revision
that moves the parent has to move them too. Two rules:

  * Shift only what has not started. A task with recorded progress keeps its
    real dates — those are a record of what happened, and rewriting them
    would assert work occurred on days it did not. This can leave a gap
    between a finished child and the shifted remainder. The gap is real.

  * When the parent's duration changes materially, do not reshape the
    breakdown — flag it. The subtasks are already allocated to named people,
    and quietly re-planning them changes someone's week without telling them.
    The UI offers a re-plan the PM can accept.
"""
from datetime import date, timedelta

# Above this relative duration change, a proportional scale is no longer a
# reasonable guess at what the work should look like.
_INVALIDATE_ABOVE = 0.20


def _d(v):
    if v is None:
        return None
    return v if isinstance(v, date) else date.fromisoformat(str(v))


def _span(p):
    s, e = _d(p.get("start_date")), _d(p.get("end_date"))
    if s is None or e is None:
        return None
    return (e - s).days + 1


def rebase_children(parent_before, parent_after, children):
    before_start, after_start = _d(parent_before.get("start_date")), _d(parent_after.get("start_date"))
    before_span, after_span = _span(parent_before), _span(parent_after)

    if before_start is None or after_start is None \
            or before_span is None or after_span is None:
        return {"shift": [], "invalidated": False, "reason": None}

    delta = (after_start - before_start).days
    ratio = after_span / before_span if before_span else 1.0

    if children and abs(ratio - 1.0) > _INVALIDATE_ABOVE:
        return {
            "shift": [],
            "invalidated": True,
            "reason": (f"the parent's duration changed from {before_span} to "
                       f"{after_span} days — the existing breakdown no longer "
                       f"fits and needs re-planning"),
        }

    shift = []
    for c in children or []:
        # Started or finished work keeps its real dates.
        if (c.get("progress_pct") or 0) > 0:
            continue
        cs, ce = _d(c.get("start_date")), _d(c.get("end_date"))
        if cs is None or ce is None:
            continue
        offset = (cs - before_start).days
        new_start = after_start + timedelta(days=round(offset * ratio))
        new_len = round(((ce - cs).days + 1) * ratio)
        new_end = new_start + timedelta(days=max(0, new_len - 1))
        shift.append({"id": c["id"],
                      "start_date": new_start.isoformat(),
                      "end_date": new_end.isoformat()})

    return {"shift": shift, "invalidated": False, "reason": None}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/unit/test_programme_rebase.py -v`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/programme_rebase.py tests/unit/test_programme_rebase.py
git commit -m "feat(programme): rebase local subtrees when their imported parent moves

Shift only what has not started. A task with recorded progress keeps its real
dates, because those are a record of what happened and rewriting them would
assert work occurred on days it did not. That can leave a gap between a
finished child and the shifted remainder; the gap is real and is not smoothed
over.

Above a 20% duration change the breakdown is flagged invalidated rather than
reshaped. The subtasks are already allocated to named people, so silently
re-planning them would change someone's week without telling them — the UI
offers a re-plan the PM accepts."
```

---

## Task 3: Apply, version, roll back

**Files:**
- Create: `fieldsight-pipeline/src/repositories/programme_import.py`
- Test: `fieldsight-pipeline/tests/unit/test_programme_import_repo.py`

**Interfaces:**
- Consumes: `programme_reconcile.reconcile`, `programme_tasks`.
- Produces:
  - `apply_plan(conn, programme_id, plan, *, version_no, updated_by) -> dict` — counts actually written
  - `apply_rename(conn, existing_id, new_source_task_id) -> bool`
  - `list_versions(conn, programme_id) -> list[dict]`
  - `restore_version(conn, programme_id, version_no, *, restored_by) -> dict`
  - `set_baseline(conn, programme_id, version_no) -> dict`

- [ ] **Step 1: Write the failing tests**

Create `fieldsight-pipeline/tests/unit/test_programme_import_repo.py`:

```python
"""
Tests for src/repositories/programme_import.py — Task 3 of the programme
import reconciliation plan.

FakeConn/FakeCursor record every execute()'s SQL and params, as in
tests/unit/test_programme_suggestions_repo.py.

What is pinned here: removals are UPDATEs and never DELETEs, a rename touches
exactly one column, and restore does not destroy the version it is rolling
back from — otherwise the rollback itself becomes unrecoverable.
"""
import pytest

from repositories import programme_import as repo

from tests.unit.test_programme_tasks_repo import FakeConn  # shared double

PROG = "22222222-2222-2222-2222-222222222222"
USER = "33333333-3333-3333-3333-333333333333"


def test_removals_are_soft_and_never_delete():
    plan = {"insert": [], "update": [],
            "remove": [{"id": "t1", "removed_in_version": 3,
                        "archived_with_parent": False}],
            "rename_candidates": [], "summary": {}}
    conn = FakeConn([[{"id": "t1"}]])
    repo.apply_plan(conn, PROG, plan, version_no=3, updated_by=USER)
    sql = " ".join(c["sql"] for c in conn.calls)
    assert "removed_in_version" in sql
    assert "DELETE" not in sql.upper(), "an import must never delete a task row"


def test_apply_plan_writes_nothing_for_an_empty_plan():
    plan = {"insert": [], "update": [], "remove": [],
            "rename_candidates": [], "summary": {}}
    conn = FakeConn([])
    counts = repo.apply_plan(conn, PROG, plan, version_no=2, updated_by=USER)
    assert counts == {"inserted": 0, "updated": 0, "removed": 0}
    assert conn.calls == []


def test_apply_rename_updates_only_the_source_id():
    conn = FakeConn([{"id": "t1"}])
    repo.apply_rename(conn, "t1", "A1020R1")
    sql = conn.calls[0]["sql"]
    assert "source_task_id" in sql
    for col in ("progress_pct", "start_date", "end_date", "origin", "programme_id"):
        assert col not in sql, f"a rename must not touch {col}"


def test_restore_archives_the_current_state_before_rolling_back():
    """Otherwise rolling back is itself unrecoverable."""
    conn = FakeConn([{"version_no": 5}, [], [], {"id": "v"}])
    repo.restore_version(conn, PROG, 3, restored_by=USER)
    sql = " ".join(c["sql"] for c in conn.calls)
    assert "programme_versions" in sql, \
        "restore must record a version row for the state it is leaving"


def test_restore_rejects_a_version_that_does_not_exist():
    conn = FakeConn([None])
    with pytest.raises(ValueError):
        repo.restore_version(conn, PROG, 99, restored_by=USER)


def test_set_baseline_rejects_a_version_that_does_not_exist():
    conn = FakeConn([None])
    with pytest.raises(ValueError):
        repo.set_baseline(conn, PROG, 99)


def test_list_versions_returns_newest_first():
    conn = FakeConn([[]])
    repo.list_versions(conn, PROG)
    assert "ORDER BY version_no DESC" in conn.calls[0]["sql"]
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/unit/test_programme_import_repo.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `fieldsight-pipeline/src/repositories/programme_import.py`:

```python
"""Applies a reconciliation plan, and owns version history, rollback and
baseline selection.

Everything here runs inside the request transaction (lambda_org_api wraps
each request in `with get_connection() as conn:`), so a plan is applied whole
or not at all. A half-applied reconciliation would be worse than a failed
one: the programme would disagree with the file in a way nobody could see.
"""
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def apply_plan(conn, programme_id, plan, *, version_no, updated_by) -> dict:
    inserted = updated = removed = 0

    # Groups first: a leaf's parent_id resolves through source ids, so the
    # parent row has to exist before the child references it.
    src_to_uuid = {}
    for row in plan["insert"]:
        if row.get("parent_source_id") is None:
            new = conn.cursor(row_factory=dict_row).execute(
                "INSERT INTO programme_tasks ("
                "programme_id, source_task_id, parent_id, origin, name, wbs_code, "
                "start_date, end_date, duration_days, first_seen_version, updated_by) "
                "VALUES (%s,%s,NULL,'imported',%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (programme_id, row["source_task_id"], row["name"], row.get("wbs_code"),
                 row.get("start_date"), row.get("end_date"), row.get("duration_days"),
                 row["first_seen_version"], updated_by),
            ).fetchone()
            src_to_uuid[row["source_task_id"]] = new["id"]
            inserted += 1

    for row in plan["insert"]:
        if row.get("parent_source_id") is None:
            continue
        parent_uuid = src_to_uuid.get(row["parent_source_id"])
        if parent_uuid is None:
            got = conn.cursor(row_factory=dict_row).execute(
                "SELECT id FROM programme_tasks "
                "WHERE programme_id = %s AND source_task_id = %s",
                (programme_id, row["parent_source_id"]),
            ).fetchone()
            parent_uuid = got["id"] if got else None
        conn.cursor().execute(
            "INSERT INTO programme_tasks ("
            "programme_id, source_task_id, parent_id, origin, name, wbs_code, "
            "start_date, end_date, duration_days, first_seen_version, updated_by) "
            "VALUES (%s,%s,%s,'imported',%s,%s,%s,%s,%s,%s,%s)",
            (programme_id, row["source_task_id"], parent_uuid, row["name"],
             row.get("wbs_code"), row.get("start_date"), row.get("end_date"),
             row.get("duration_days"), row["first_seen_version"], updated_by),
        )
        inserted += 1

    for row in plan["update"]:
        fields = row["fields"]
        if not fields:
            continue
        sets = [f"{c} = %s" for c in fields]
        params = list(fields.values())
        # An import is the authority for these columns, so the local-edit
        # flag is cleared: the file and the row now agree again.
        sets.append("locally_modified = false")
        sets.append("updated_at = now()")
        sets.append("row_version = row_version + 1")
        params.append(row["id"])
        conn.cursor().execute(
            f"UPDATE programme_tasks SET {', '.join(sets)} WHERE id = %s",
            tuple(params))
        updated += 1

    for row in plan["remove"]:
        # Soft. Allocations, progress and any local subtree hang off this row.
        conn.cursor().execute(
            "UPDATE programme_tasks SET removed_in_version = %s, "
            "updated_at = now(), row_version = row_version + 1 WHERE id = %s",
            (row["removed_in_version"], row["id"]))
        removed += 1

    return {"inserted": inserted, "updated": updated, "removed": removed}


def apply_rename(conn, existing_id, new_source_task_id) -> bool:
    """Repair for a planner changing an Activity ID. One column — the row's
    allocations, progress and local subtree are untouched, which is the whole
    reason identity and matching keys are separate columns."""
    row = conn.cursor(row_factory=dict_row).execute(
        "UPDATE programme_tasks SET source_task_id = %s, updated_at = now() "
        "WHERE id = %s AND origin = 'imported' RETURNING id",
        (new_source_task_id, existing_id),
    ).fetchone()
    return row is not None


def list_versions(conn, programme_id) -> list[dict]:
    return conn.cursor(row_factory=dict_row).execute(
        "SELECT id, programme_id, version_no, filename, mode, imported_by, "
        "imported_at, diff_summary FROM programme_versions "
        "WHERE programme_id = %s ORDER BY version_no DESC",
        (programme_id,),
    ).fetchall()


def record_version(conn, programme_id, *, version_no, filename, mode,
                   imported_by, diff_summary) -> dict:
    return conn.cursor(row_factory=dict_row).execute(
        "INSERT INTO programme_versions "
        "(programme_id, version_no, filename, mode, imported_by, diff_summary) "
        "VALUES (%s,%s,%s,%s,%s,%s) "
        "RETURNING id, programme_id, version_no, filename, mode, imported_by, "
        "imported_at, diff_summary",
        (programme_id, version_no, filename, mode, imported_by,
         Jsonb(diff_summary or {})),
    ).fetchone()


def restore_version(conn, programme_id, version_no, *, restored_by) -> dict:
    """Roll the task set back to how it stood at `version_no`.

    A version row is recorded for the state being left FIRST, so the rollback
    is itself reversible. Without that, an accidental restore destroys the
    thing it was meant to protect.
    """
    target = conn.cursor(row_factory=dict_row).execute(
        "SELECT version_no FROM programme_versions "
        "WHERE programme_id = %s AND version_no = %s",
        (programme_id, version_no),
    ).fetchone()
    if target is None:
        raise ValueError(f"no such version: {version_no}")

    # Rows that had not arrived yet at the target version go back to removed;
    # rows removed after it come back. Both are column flips, not deletions,
    # so nothing is lost either way.
    conn.cursor().execute(
        "UPDATE programme_tasks SET removed_in_version = %s "
        "WHERE programme_id = %s AND origin = 'imported' "
        "AND first_seen_version > %s AND removed_in_version IS NULL",
        (version_no, programme_id, version_no))
    conn.cursor().execute(
        "UPDATE programme_tasks SET removed_in_version = NULL "
        "WHERE programme_id = %s AND origin = 'imported' "
        "AND removed_in_version > %s",
        (programme_id, version_no))

    cur = conn.cursor(row_factory=dict_row).execute(
        "SELECT current_version FROM programmes WHERE id = %s",
        (programme_id,)).fetchone()
    next_version = (cur["current_version"] if cur else version_no) + 1

    return record_version(
        conn, programme_id, version_no=next_version, filename=None,
        mode="replace", imported_by=restored_by,
        diff_summary={"restored_from": version_no})


def set_baseline(conn, programme_id, version_no) -> dict:
    """The contractually approved revision, not necessarily the first import.
    Lateness is measured against it."""
    exists = conn.cursor(row_factory=dict_row).execute(
        "SELECT version_no FROM programme_versions "
        "WHERE programme_id = %s AND version_no = %s",
        (programme_id, version_no),
    ).fetchone()
    if exists is None:
        raise ValueError(f"no such version: {version_no}")
    return conn.cursor(row_factory=dict_row).execute(
        "UPDATE programmes SET baseline_version = %s, updated_at = now() "
        "WHERE id = %s RETURNING id, baseline_version",
        (version_no, programme_id),
    ).fetchone()
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/unit/test_programme_import_repo.py -v`
Expected: PASS, 7 tests.

If the shared-double import fails, add `tests/unit/__init__.py` (it already
exists) and run from the repo root so `tests.unit` resolves.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/programme_import.py tests/unit/test_programme_import_repo.py
git commit -m "feat(programme): apply reconciliation plans, version history, rollback, baseline

Removals are UPDATEs setting removed_in_version — an import never issues a
DELETE, because allocations, progress and local subtrees hang off those rows.

restore_version records a version row for the state it is leaving before
rolling back, so the rollback is itself reversible; without that an
accidental restore destroys the thing it was meant to protect. It works by
flipping removed_in_version rather than deleting or reinserting, so no history
is lost in either direction.

apply_rename touches exactly one column, which is the payoff of keeping
identity and matching keys in separate columns."
```

---

## Task 4: The import endpoint

**Files:**
- Modify: `fieldsight-pipeline/src/lambda_org_api.py`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  - `POST /programme/import` — `{dry_run, mode, filename, parents, leaves, accept_renames}`
  - `GET /programme/versions?site=`
  - `POST /programme/versions/{n}/restore?site=`
  - `POST /programme/baseline?site=` — `{version_no}`

- [ ] **Step 1: Write the handler**

```python
_IMPORT_MODES = ("update", "replace", "new")


def import_programme(conn, caller, event, body):
    """Two-phase. `dry_run: true` reconciles in memory and returns the diff
    without writing; the client shows it, the user picks a mode, and a second
    call commits. The user never chooses blind — which matters because
    Replace discards work that Update would have kept."""
    if body is None:
        return error("malformed JSON body", 400)
    if caller["global_role"] not in _MANAGER_ROLES:
        return error("importing a programme requires manager role", 403)

    site_id, err = _resolve_site_param(
        conn, caller, (event.get("queryStringParameters") or {}).get("site"))
    if err is not None:
        return err

    parents = body.get("parents") or []
    leaves = body.get("leaves") or []
    if not parents and not leaves:
        return error("nothing to import", 400)

    mode = body.get("mode")
    if mode is not None and mode not in _IMPORT_MODES:
        return error(f"mode must be one of {_IMPORT_MODES}", 400)

    prog = programme_tasks.get_primary_programme(conn, site_id)
    if prog is None:
        prog = programme_tasks.create_programme(
            conn, site_id=site_id, name=body.get("name") or "Programme",
            source_format=body.get("source_format"))

    existing = programme_tasks.list_tasks(conn, prog["id"], include_removed=True)
    version_no = (prog["current_version"] or 0) + 1
    plan = programme_reconcile.reconcile(existing, parents, leaves,
                                         version_no=version_no)

    if body.get("dry_run"):
        # Replace's cost is not visible from the plan — it is measured in the
        # things the plan would have preserved.
        local_rows = [t for t in existing
                      if t["origin"] == "local" and t["removed_in_version"] is None]
        local_ids = [t["id"] for t in local_rows]
        assignee_map = programme_tasks.list_assignees(
            conn, [t["id"] for t in existing])
        return ok({
            "dry_run": True,
            "suggested_mode": programme_reconcile.suggest_mode(existing, parents, leaves),
            "update_preview": plan["summary"],
            "rename_candidates": plan["rename_candidates"],
            "replace_preview": {
                "local_tasks_discarded": len(local_ids),
                "allocations_discarded": sum(len(v) for v in assignee_map.values()),
                "tasks_with_progress_discarded": len(
                    [t for t in existing if (t["progress_pct"] or 0) > 0]),
            },
        })

    if mode is None:
        return error("mode required to commit an import", 400)

    if mode == "replace":
        # Destructive, and confirmed twice: the client requires the site name
        # typed, and this flag has to be sent explicitly.
        if not body.get("confirm_replace"):
            return error("replace requires confirm_replace", 400)
        programme_tasks.replace_all_tasks(
            conn, prog["id"], parents=parents, leaves=leaves,
            version_no=version_no, updated_by=caller.get("user_id"))
        counts = {"replaced": len(parents) + len(leaves)}
        summary = {"mode": "replace", "tasks": len(parents) + len(leaves)}
    elif mode == "new":
        prog = programme_tasks.create_programme(
            conn, site_id=site_id, name=body.get("name") or "Programme",
            source_format=body.get("source_format"))
        conn.cursor().execute(
            "UPDATE programmes SET is_primary = false WHERE id = %s", (prog["id"],))
        version_no = 1
        programme_tasks.replace_all_tasks(
            conn, prog["id"], parents=parents, leaves=leaves,
            version_no=version_no, updated_by=caller.get("user_id"))
        counts = {"created": len(parents) + len(leaves)}
        summary = {"mode": "new", "tasks": len(parents) + len(leaves)}
    else:
        for r in body.get("accept_renames") or []:
            programme_import.apply_rename(conn, r["existing_id"],
                                          r["incoming_source_task_id"])
        # Re-reconcile: an accepted rename turns what looked like a
        # remove+insert pair into a plain update, and applying the stale plan
        # would soft-remove the row we just repaired.
        if body.get("accept_renames"):
            existing = programme_tasks.list_tasks(conn, prog["id"], include_removed=True)
            plan = programme_reconcile.reconcile(existing, parents, leaves,
                                                 version_no=version_no)
        counts = programme_import.apply_plan(
            conn, prog["id"], plan, version_no=version_no,
            updated_by=caller.get("user_id"))
        summary = plan["summary"]

    conn.cursor().execute(
        "UPDATE programmes SET current_version = %s, updated_at = now() WHERE id = %s",
        (version_no, prog["id"]))
    programme_import.record_version(
        conn, prog["id"], version_no=version_no, filename=body.get("filename"),
        mode="initial" if version_no == 1 else mode,
        imported_by=caller.get("user_id"), diff_summary=summary)

    _write_snapshot(conn, site_id, prog["id"])
    return ok({"counts": counts, "version_no": version_no, "summary": summary})
```

- [ ] **Step 2: Write the version handlers**

```python
def list_programme_versions(conn, caller, event):
    site_id, err = _resolve_site_param(
        conn, caller, (event.get("queryStringParameters") or {}).get("site"))
    if err is not None:
        return err
    prog = programme_tasks.get_primary_programme(conn, site_id)
    if prog is None:
        return ok({"versions": []})
    return ok({"versions": programme_import.list_versions(conn, prog["id"]),
               "baseline_version": prog["baseline_version"],
               "current_version": prog["current_version"]})


def restore_programme_version(conn, caller, event, version_no):
    if caller["global_role"] not in _MANAGER_ROLES:
        return error("restoring a programme version requires manager role", 403)
    site_id, err = _resolve_site_param(
        conn, caller, (event.get("queryStringParameters") or {}).get("site"))
    if err is not None:
        return err
    prog = programme_tasks.get_primary_programme(conn, site_id)
    if prog is None:
        return error("no programme for this site", 404)
    try:
        row = programme_import.restore_version(
            conn, prog["id"], int(version_no), restored_by=caller.get("user_id"))
    except (ValueError, TypeError) as e:
        return error(str(e), 400)
    _write_snapshot(conn, site_id, prog["id"])
    return ok({"restored_to": int(version_no), "version": row})


def set_programme_baseline(conn, caller, event, body):
    if caller["global_role"] not in _MANAGER_ROLES:
        return error("setting the baseline requires manager role", 403)
    if body is None or not isinstance(body.get("version_no"), int):
        return error("version_no required", 400)
    site_id, err = _resolve_site_param(
        conn, caller, (event.get("queryStringParameters") or {}).get("site"))
    if err is not None:
        return err
    prog = programme_tasks.get_primary_programme(conn, site_id)
    if prog is None:
        return error("no programme for this site", 404)
    try:
        return ok({"programme": programme_import.set_baseline(
            conn, prog["id"], body["version_no"])})
    except ValueError as e:
        return error(str(e), 400)
```

- [ ] **Step 3: Wire the routes**

After the `/programme/tasks` routes added in Plan B:

```python
    if route == "/programme/import" and method == "POST":
        return import_programme(conn, caller, event, parse_body(event))
    if route == "/programme/versions" and method == "GET":
        return list_programme_versions(conn, caller, event)
    m_pv = re.match(r"^/programme/versions/(\d+)/restore$", route)
    if m_pv and method == "POST":
        return restore_programme_version(conn, caller, event, m_pv.group(1))
    if route == "/programme/baseline" and method == "POST":
        return set_programme_baseline(conn, caller, event, parse_body(event))
```

Add the imports:

```python
import programme_reconcile
from repositories import programme_import
```

- [ ] **Step 4: Verify**

```bash
python -c "import sys; sys.path.insert(0,'src'); import lambda_org_api"
pytest tests/unit -q
```

- [ ] **Step 5: Commit**

```bash
git add src/lambda_org_api.py
git commit -m "feat(programme): two-phase import endpoint with versions, rollback and baseline

dry_run reconciles in memory and returns the diff without writing, so the
user picks a mode having seen what each one costs. Replace's cost is not
visible from the plan — it is measured in what Update would have preserved —
so the dry run counts the local tasks, allocations and recorded progress it
would discard, and the commit requires confirm_replace on top of the client's
typed confirmation.

Accepting a rename re-runs reconciliation before applying: the repair turns
what looked like a remove-plus-insert into a plain update, and applying the
stale plan would soft-remove the row just repaired."
```

---

## Task 5: The diff screen

**Files:**
- Create: `fieldsight-ui/scripts/composites/programme-import-diff.js`
- Modify: `fieldsight-ui/scripts/composites/programme-import-modal.js`
- Modify: `fieldsight-ui/scripts/api/programme.js`
- Test: `fieldsight-ui/tests/programme-import-diff.test.js`

**Interfaces:**
- Consumes: `POST /programme/import`.
- Produces: `FS.api.programme.importProgramme(orgSiteId, payload)`; a `reconcile` phase in the modal; `describeDiff(preview) -> string[]` and `canCommit(mode, state) -> boolean` as pure, tested helpers.

- [ ] **Step 1: Write the failing test**

Create `fieldsight-ui/tests/programme-import-diff.test.js`:

```js
'use strict';

/*
 * The import diff screen's decision logic.
 *
 * Replace discards local tasks, allocations and recorded progress. The guard
 * against doing that by accident is not a confirm dialog — those get clicked
 * through — it is requiring the site name to be typed, and showing what is
 * about to be lost while the user types it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { describeDiff, canCommit } = require('../scripts/composites/programme-import-diff.js');

const PREVIEW = {
  update_preview: {
    added: 3, removed: 1, updated: 12, date_shifted: 8, max_shift_days: 14,
    archived_with_parent: 0, locally_modified_overwritten: [],
  },
  replace_preview: {
    local_tasks_discarded: 47, allocations_discarded: 12,
    tasks_with_progress_discarded: 203,
  },
};

test('update mode describes what changes', () => {
  const lines = describeDiff('update', PREVIEW).join(' | ');
  assert.match(lines, /12 updated/);
  assert.match(lines, /3 added/);
  assert.match(lines, /1 no longer/);
  assert.match(lines, /14 days/);
});

test('replace mode describes what is destroyed, not what changes', () => {
  const lines = describeDiff('replace', PREVIEW).join(' | ');
  assert.match(lines, /47/);
  assert.match(lines, /12/);
  assert.match(lines, /203/);
  assert.doesNotMatch(lines, /updated/,
    'the update counts are irrelevant and would soften the warning');
});

test('locally edited rows are called out so the PM sees the overwrite coming', () => {
  const preview = JSON.parse(JSON.stringify(PREVIEW));
  preview.update_preview.locally_modified_overwritten = [
    { id: 'a', name: 'Pour slab' }, { id: 'b', name: 'Strip forms' },
  ];
  assert.match(describeDiff('update', preview).join(' | '),
    /2 .*edited here.*overwritten/i);
});

test('update commits without a typed confirmation', () => {
  assert.strictEqual(canCommit('update', { typed: '', siteName: 'UC Physics' }), true);
});

test('replace stays blocked until the site name matches exactly', () => {
  assert.strictEqual(canCommit('replace', { typed: '', siteName: 'UC Physics' }), false);
  assert.strictEqual(canCommit('replace', { typed: 'uc physics', siteName: 'UC Physics' }), false);
  assert.strictEqual(canCommit('replace', { typed: 'UC Physics', siteName: 'UC Physics' }), true);
});

test('a new-programme import needs no confirmation because it destroys nothing', () => {
  assert.strictEqual(canCommit('new', { typed: '', siteName: 'UC Physics' }), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/programme-import-diff.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `fieldsight-ui/scripts/composites/programme-import-diff.js` containing
`describeDiff` and `canCommit` as pure functions plus an `ImportDiff` React
component, exported both to `window.FieldSight.ProgrammeImportDiff` and via
`module.exports` (the dual-export idiom from `scripts/api/content-hash.js`):

```js
  function pluralise(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function describeDiff(mode, preview) {
    if (mode === 'replace') {
      var r = preview.replace_preview || {};
      return [
        'Will discard ' + pluralise(r.local_tasks_discarded || 0,
          'task created here', 'tasks created here'),
        pluralise(r.allocations_discarded || 0, 'allocation', 'allocations'),
        pluralise(r.tasks_with_progress_discarded || 0,
          'task with recorded progress', 'tasks with recorded progress'),
        'The current version is archived, so this can be rolled back.',
      ];
    }
    if (mode === 'new') {
      return ['Imported as a second programme. Nothing existing is changed.'];
    }
    var u = preview.update_preview || {};
    var lines = [
      pluralise(u.updated || 0, 'task updated', 'tasks updated'),
      pluralise(u.added || 0, 'task added', 'tasks added'),
      pluralise(u.removed || 0, 'task no longer in the file', 'tasks no longer in the file')
        + ' (hidden, not deleted)',
    ];
    if (u.date_shifted) {
      lines.push(pluralise(u.date_shifted, 'task moved', 'tasks moved')
        + ', by up to ' + u.max_shift_days + ' days');
    }
    if (u.archived_with_parent) {
      lines.push(pluralise(u.archived_with_parent, 'local subtask archived',
        'local subtasks archived') + ' with their parent');
    }
    var lm = (u.locally_modified_overwritten || []).length;
    if (lm) {
      lines.push(pluralise(lm, 'task you edited here', 'tasks you edited here')
        + ' will be overwritten by the file');
    }
    return lines;
  }

  /* Replace destroys work that Update would keep. A confirm dialog gets
     clicked through; typing the site name does not happen by accident. */
  function canCommit(mode, state) {
    if (mode !== 'replace') return true;
    return (state.typed || '') === (state.siteName || '');
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/programme-import-diff.test.js`
Expected: PASS, 6 tests. Then `node --test tests/*.test.js` for the full suite.

- [ ] **Step 5: Add the reconcile phase to the modal**

In `scripts/composites/programme-import-modal.js`:

- Extend the phase comment and state to `'pick' | 'mapping' | 'preview' | 'reconcile'`.
- Replace `handleConfirm` so that instead of calling `onImport` directly it
  calls `FS.api.programme.importProgramme(siteId, {dry_run: true, parents,
  leaves, filename})`, stores the response, and moves to `'reconcile'`.
- Render `ImportDiff` in the `reconcile` phase, preselecting
  `response.suggested_mode`.
- On commit, call `importProgramme` again with `{mode, confirm_replace,
  accept_renames}` and only then `onClose()`.

- [ ] **Step 6: Add the API function**

In `scripts/api/programme.js`:

```js
  async function importProgramme(orgSiteId, payload) {
    if (orgLive()) {
      return window.FS.api.orgRequest('/programme/import', {
        method: 'POST', params: { site: orgSiteId }, body: payload,
      });
    }
    await window.FS.api.delay();
    return { dry_run: !!payload.dry_run, suggested_mode: 'update',
             update_preview: { added: 0, removed: 0, updated: 0,
                               date_shifted: 0, max_shift_days: 0,
                               archived_with_parent: 0,
                               locally_modified_overwritten: [] },
             rename_candidates: [],
             replace_preview: { local_tasks_discarded: 0,
                                allocations_discarded: 0,
                                tasks_with_progress_discarded: 0 } };
  }
```

- [ ] **Step 7: Commit**

```bash
git add scripts/composites/programme-import-diff.js \
        scripts/composites/programme-import-modal.js \
        scripts/api/programme.js app-shell-preview.html \
        tests/programme-import-diff.test.js
git commit -m "feat(programme): show the import diff before committing a mode

The modal gains a reconcile phase: upload and parse, then a dry run, then the
diff, then the choice. The user never picks a mode blind.

Update and Replace describe different things on purpose. Update lists what
changes; Replace lists what it destroys, and deliberately omits the update
counts, which would soften a warning that should not be softened. Replace
stays blocked until the site name is typed exactly — a confirm dialog gets
clicked through, typing a name does not happen by accident."
```

---

## Task 6: Version history and rollback UI

**Files:**
- Create: `fieldsight-ui/scripts/composites/programme-version-history.js`
- Modify: `fieldsight-ui/scripts/pages/programme.js`

- [ ] **Step 1: Build the panel**

A drawer opened from the programme header listing versions newest-first, each
row showing version number, date, importer, filename and a one-line summary
built from `diff_summary` using `describeDiff` from Task 5 — the same
sentences the user saw when they committed the import, so history and the
moment of decision read identically.

Each row carries two actions:

- **Restore to this version** — confirm dialog naming the version, then
  `POST /programme/versions/{n}/restore`, then reload the programme.
- **Set as baseline** — `POST /programme/baseline`. The current baseline row
  is marked. Copy: "Lateness is measured against the baseline. Set it to the
  revision the client formally approved, which is not always the first one
  imported."

- [ ] **Step 2: Add the API functions**

`getVersions(orgSiteId)`, `restoreVersion(orgSiteId, versionNo)` and
`setBaseline(orgSiteId, versionNo)` in `scripts/api/programme.js`, following
the `orgLive()` pattern of the functions around them.

- [ ] **Step 3: Verify in the browser**

Import twice with different dates, open the history, confirm both versions
appear with correct summaries, restore to version 1, and confirm the task
dates revert and a third version row appears recording the restore.

- [ ] **Step 4: Commit**

```bash
git add scripts/composites/programme-version-history.js \
        scripts/pages/programme.js scripts/api/programme.js app-shell-preview.html
git commit -m "feat(programme): version history with rollback and baseline selection

Each row's summary is rendered with the same describeDiff used at import time,
so the history reads identically to the moment the decision was made.

Restoring records a new version rather than rewinding the log, so a rollback
is itself reversible. Baseline is explicit rather than pinned to version 1 —
the contractually approved revision is often not the first one imported, and
lateness measured against the wrong one is worse than not measuring it."
```

---

## Task 7: Verify on the test stack

- [ ] **Step 1: The survival test — the whole point of this plan**

1. Import a programme (v1).
2. Allocate a task to a site manager; record 40% progress on it.
3. Create a local subtask beneath it and allocate that too.
4. Edit one imported task's name in the UI.
5. Export a revised file: shift several dates, rename one task's text, drop
   one task, add one, and change one task's Activity ID.
6. Import it in **Update** mode.

Assert:

```sql
-- allocations survived
SELECT t.name, a.assignee FROM programme_tasks t
  JOIN programme_task_assignees a ON a.task_id = t.id
 WHERE t.programme_id = '<id>';

-- progress survived and was not zeroed by the file
SELECT name, progress_pct FROM programme_tasks
 WHERE programme_id = '<id>' AND progress_pct > 0;

-- the local subtask is untouched and still parented correctly
SELECT id, name, parent_id, origin FROM programme_tasks
 WHERE programme_id = '<id>' AND origin = 'local';

-- the dropped task is hidden, NOT deleted
SELECT name, removed_in_version FROM programme_tasks
 WHERE programme_id = '<id>' AND removed_in_version IS NOT NULL;
```

Any row missing rather than flagged is a stop.

- [ ] **Step 2: The rename repair**

The task whose Activity ID changed should appear under **rename candidates**
in the diff. Accept it, and confirm its allocation and progress are still
attached to the same row afterwards, and that no duplicate was created.

- [ ] **Step 3: Replace, then undo it**

Run an import in Replace mode (typing the site name). Confirm the local tasks
and allocations are gone. Then restore the previous version from the history
drawer and confirm they come back. If they do not, the archive is not doing
its job and this is a stop.

- [ ] **Step 4: Snapshot and matcher**

Re-read `programmes/<site_id>/programme.json` from S3 and confirm it reflects
the reconciled state, with soft-removed tasks absent. Run the matcher with
`{"dry_run": true}` and confirm it still produces candidates.

- [ ] **Step 5: Open the PR**

Title: `feat(programme): import reconciliation, version history and rollback`

Body must state which of the Step 1 assertions were run and their results.
Listing them as "should pass" rather than "passed" is a plan failure — this
plan exists because the current behaviour destroys user work, and the PR is
where that is proven fixed.

---

## Self-Review

**Spec coverage:**

| Spec §6 item | Task |
|---|---|
| Two-phase dry-run then commit | 4, 5 |
| Update / Replace / new-programme modes | 4, 5 |
| Suggested mode from id overlap | 1 (`suggest_mode`), 5 |
| Reconciliation matrix: present / gone / new | 1 |
| Rename in place (id is the join key) | 1 |
| Soft removal, never deleted | 1, 3 |
| Local subtree preserved; archived with a departing parent | 1 |
| `locally_modified` surfaced before being overwritten | 1, 5 |
| §4.2 rename-candidate repair | 1, 3 (`apply_rename`), 4, 7 |
| §6.4 local subtree rebase; invalidation above 20% | 2 |
| §6.5 change summary, rollback, baseline | 3, 4, 6 |
| Typed confirmation for Replace | 5 |

**One gap, stated rather than hidden:** `programme_rebase.rebase_children`
(Task 2) is written and tested but is **not yet called** by `apply_plan`.
Wiring it requires deciding where the invalidation flag is stored and how the
"re-plan breakdown" action behaves, and re-planning is a Project 3 concern
(AI breakdown). Task 2 is included here because the rules belong with
reconciliation and are cheap to get right now; leaving the call site for the
plan that builds the UI is deliberate. **Do not** wire it in silently — a
half-wired rebase that shifts dates with no way to see or undo the
invalidation is worse than not shifting them.

**Placeholders:** none in Tasks 1-5. Tasks 6 and 7 describe UI construction
and manual verification in prose because both are inherently interactive; each
step still names the exact endpoint, SQL or assertion involved.

**Type consistency:** `reconcile` returns `{insert, update, remove,
rename_candidates, summary}`; `apply_plan` reads exactly those keys and
Task 4's handler reads `plan["summary"]` and `plan["rename_candidates"]`.
`update` entries are `{id, source_task_id, fields}` in both the tests and
`apply_plan`. `remove` entries carry `removed_in_version` and
`archived_with_parent` in both. `rename_candidates` entries use
`existing_id` / `incoming_source_task_id`, matching `apply_rename`'s
parameters and the `accept_renames` body shape in Task 4.
`rebase_children` returns `{shift, invalidated, reason}` with `shift` entries
of `{id, start_date, end_date}`.

**A correctness trap worth naming for the reviewer:** accepting a rename
mid-commit invalidates the plan computed before it. Task 4 re-runs
`reconcile` after applying renames for exactly this reason. Removing that
re-run would soft-remove the very row the rename just repaired — and because
removal is soft, the failure would look like the task quietly vanishing from
the Gantt rather than like an error.
