# Programme Critical Path & Overview — Design

Date: 2026-08-03
Status: Draft — needs a real client spreadsheet before §5 is settled
Scope: Project 2 of 3
Repos: `fieldsight-ui` (frontend), `fieldsight-pipeline` (baseline lateness)

Follows `2026-08-02-programme-foundation-design.md`, whose §14 deferred this.

---

## 1. What was asked for

From the design conversation, verbatim in intent:

> 一个关键路径的列表，最好是有一条路线，根据时间线画出一条红色的 highlight。
> 整体的推进进度，带上当前落后多少天，这个很重要。

Four things, and they are not equally easy:

| # | Ask | Difficulty |
|---|---|---|
| 1 | A **list** of critical-path tasks | Easy — the engine already computes it |
| 2 | A **red highlighted route** along the timeline | Moderate — rendering, not logic |
| 3 | Overall **progress** | Easy |
| 4 | **How many days behind** | Hard — needs a baseline *and* honest arithmetic |

Plus the Overview modal from Project 1's §14, so the whole programme can be
read without giving up the working view.

---

## 2. The thing that decides everything else

**Critical path requires dependencies, and most of the files we accept do not
carry any.**

- **MSPDI XML** — `PredecessorLink` is parsed today
  (`scripts/api/programme-import.js:426`), so these programmes have a real
  dependency graph.
- **CSV / XLSX** — a `depends_on` column exists in the contract but is
  effectively never filled. These programmes have **no graph at all**.

`computeCriticalPath` (`scripts/api/programme-schedule.js:153`) runs a real
CPM forward/backward pass. On a dependency-less programme it will still return
*something* — every task has zero slack when nothing constrains it — and that
something is meaningless.

Rendering that as a red route would be the worst possible outcome: a PM
sequences work off a path that is an artefact of missing data. **A missing
critical path is a visible gap; a fabricated one is a silent error.**

So the feature is defined in tiers, and which tier a programme gets is derived
from its data, not chosen by the user.

---

## 3. Three tiers

| Tier | Condition | What the user sees |
|---|---|---|
| **1 — Critical path** | dependency coverage ≥ 60% of schedulable leaves, graph acyclic | Real CPM. Red route on the timeline, float pills, lateness against baseline, the critical-task list. |
| **2 — Deadline pressure** | below that | **No critical path anywhere in the UI.** Tasks ranked by deadline pressure, in amber, labelled "At risk". A persistent banner explains why and offers the two remedies. |
| **3 — Author dependencies** | user links tasks in-app | Links stored in `programme_task_deps` between our UUIDs, so they **survive re-import**. Crossing the threshold promotes the programme to tier 1 on its own. |

### Why 60%, and why a threshold at all

Below it, CPM finds a path through whichever small subset happens to be
connected and presents it with the same visual weight as a real one. Partial
coverage is reported explicitly — *"dependencies cover 34% of tasks — not
enough to calculate a critical path"* — rather than silently degraded.

The number is a judgement call, not a derivation. It should be revisited once
we have seen real client files; if typical MSPDI exports come in at 45%, the
threshold is wrong, not the programmes.

### Explicitly rejected

**Inferring finish-to-start chains from row order.** Spreadsheet programmes
are usually written top-to-bottom in rough sequence, which makes this cheap
and tempting. Parallel trades on different levels would read as a chain, and
a PM would sequence real work on the result.

**Shipping LLM-inferred dependencies as data.** If Project 3 explores AI
dependency suggestion, each link must arrive as a *proposal a human accepts*
and be stored as user-authored — never applied automatically.

---

## 4. Lateness — the part that is easy to get wrong

"落后多少天" has no single honest definition. Three candidates:

1. **Finish-date slip** — current projected finish minus baseline finish.
   One number for the whole programme, which is what a PM reports upward.
2. **Critical-path slip** — the same, but only along the critical path. Equal
   to (1) when the graph is complete, and undefined without one.
3. **Earned-value schedule variance** — progress-weighted. Rigorous, and
   unexplainable to a site manager.

**Decision: (1), stated as a projection, with (2) shown per-task as float.**

- Programme-level: *"Projected finish 14 days later than baseline (rev B)"*.
- Task-level: the existing float pill — 0 float is on the critical path.

Two honesty constraints:

- **Lateness needs a baseline.** Project 1 built `programmes.baseline_version`
  and a UI to set it, defaulting to version 1. Where no baseline is set, show
  *"No baseline set"* and a link to set one — never silently measure against
  the first import and call it the plan.
- **Never show lateness on a tier-2 programme.** Without dependencies there is
  no projected finish, only the latest end date, and the difference between
  those is exactly the thing that makes the number meaningful.

---

## 5. Dependency-less programmes — **assumption, not observation**

No real client spreadsheet has been examined yet. This section is what tier 2
should do; it must be checked against a sample before implementation.

Assumed shape of a typical Excel construction programme: activity name, start,
finish, sometimes duration and % complete, sometimes indentation or dotted WBS
numbering, occasionally a responsible party — and **no predecessor column**.

**Deadline pressure** ranks a task by how far its elapsed time has run ahead
of its progress:

```
pressure = (elapsed_fraction - progress_fraction)   clamped to [0, 1]
elapsed_fraction = (today - start) / (end - start)
```

A task half-elapsed and 10% done scores 0.4; one 90% elapsed and 90% done
scores 0. Overdue-and-open sorts above everything.

Rendered **amber and labelled "At risk"** — never red, never "critical". The
visual vocabulary has to make it obvious this is a different, weaker claim.

---

## 6. The Overview modal

Project 1's §7 made the time window the load boundary. Overview is how the
whole programme stays reachable.

- Opens from the Programme header. Loads the full tree via `GET /programme`
  (not the window endpoint).
- Deliberately coarse: month tier, groups collapsed, no per-day grid, no drag.
  The coarseness is what keeps it affordable at 30,000 tasks — **it is not a
  second Gantt**.
- Shows the critical route (tier 1) or the at-risk ranking (tier 2), plus the
  lateness line.
- Clicking a task closes the modal and moves the main view's window to contain
  it. That is the modal's real job: navigation, not analysis.

---

## 7. Where the work lands

| Piece | Repo | Notes |
|---|---|---|
| Dependency coverage + tier selection | ui | Pure module, testable |
| Deadline-pressure ranking | ui | Pure module, testable |
| Red route rendering | ui | `programme.js` — **after** #150 lands |
| Float pills | ui | Already exist (`gantt-row.js`, Sprint 8.3.1) |
| Lateness computation | ui | Pure; needs the baseline version's task set |
| `GET /programme/versions/{n}/tasks` | pipeline | **New** — lateness needs the baseline's dates, and nothing returns them yet |
| Overview modal | ui | New composite + `programme.js` hook |
| In-app dependency authoring | ui + pipeline | `programme_task_deps` write endpoints — **defer to a second pass** |

The only genuinely new backend surface is reading a historical version's task
set. Everything else is frontend on top of what Project 1 shipped.

---

## 8. Open questions

1. **A real client Excel programme.** Blocks §5. Everything else can proceed.
2. **Is 60% the right threshold?** Needs one real MSPDI export to sanity-check.
3. **Should tier 3 (in-app dependency authoring) be in this project or the
   next?** It is the difference between "we tell you we cannot compute this"
   and "we give you a way to fix it". My inclination is to ship tiers 1–2
   first and let real usage say whether anyone would actually draw the links.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A fabricated critical path on dependency-less data | The tier threshold, and a hard rule that tier 2 renders no path at all |
| Lateness measured against the wrong baseline | Baseline is explicit and settable; absent baseline shows "not set", never a silent default |
| Overview becomes a second Gantt and inherits its costs | Coarse by construction: month tier, collapsed, no interaction |
| The threshold is wrong for real files | Named as an open question, checked against a sample before build |
