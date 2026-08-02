# Programme Render Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/programme` scroll smoothly with a few thousand tasks by removing the per-render O(parents × leaves) row rebuild, the unthrottled scroll re-render, and the missing memoization on row composites.

**Architecture:** Extract the row-model arithmetic out of `GanttView` into a pure, Node-testable module (`scripts/api/programme-rows.js`), then have `GanttView` consume it through `React.useMemo`. Scrolling becomes rAF-throttled and only re-renders when the visible row slice actually changes. Row composites get `React.memo`, which requires stabilising the per-row callbacks currently created inline on every render.

**Tech Stack:** Plain ES2017+ browser JS, React (global, via Babel standalone in `app-shell-preview.html`), `node:test` + `node:assert` for unit tests. No build step, no package.json, no linter.

## Global Constraints

- This is Plan A of two for Project 1. Spec: `docs/superpowers/specs/2026-08-02-programme-foundation-design.md` §8. Plan B (Aurora storage, per-task REST, import reconciliation, time-window view) is separate and lands after this.
- **Frontend only.** No backend, schema, or endpoint changes in this plan.
- **No behaviour changes.** Same rows, same order, same visuals. This plan is pure performance. Any rendered difference is a bug.
- `main` is production and auto-deploys on merge (`CLAUDE.md`). Work on a feature branch; never commit to `main`.
- Repo has no test runner configured. Tests run with `node --test tests/<file>.test.js`. Syntax check with `node --check scripts/<file>.js`.
- Browser modules are IIFEs registering onto `window.FieldSight` / `window.FS.api`. Modules that need Node tests use the dual-export idiom from `scripts/api/content-hash.js:...` (register on `window` when defined, `module.exports` when defined).
- New `<script>` tags in `app-shell-preview.html` need a `?v=N` cache-buster, matching the surrounding convention.
- Acceptance target: 5,000-leaf programme, sustained scroll, no frame over 50 ms.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/api/programme-rows.js` (**create**) | Pure row model: child index, group rollup, visible-row list, virtual slice arithmetic. No React, no DOM. |
| `tests/programme-rows.test.js` (**create**) | Unit tests for the above, including a structural guard that proves no per-parent full scan. |
| `scripts/pages/programme.js` (**modify**) | `GanttView` consumes the pure module through `useMemo`; scroll handler rAF-throttled; per-row callbacks hoisted to `useCallback`. |
| `scripts/composites/task-tree-cell.js` (**modify**) | `React.memo`; `onToggle` receives the task id so the page can pass one stable handler. |
| `scripts/composites/gantt-row.js` (**modify**) | `React.memo`. |
| `scripts/composites/gantt-strip.js` (**modify**) | `React.memo` + marker list computed via `useMemo`. |
| `styles/composites.css` (**modify**) | Tie `.fs-gantt-tree__cell` / `.fs-gantt-row` and the virtualizer's `ROW_H` to the same number. **Corrected during implementation** — see Task 6. |
| `app-shell-preview.html` (**modify**) | Load the new module before `scripts/pages/programme.js`. |

Why a separate module rather than helpers inside `programme.js`: `programme.js` is 1,733 lines and the row arithmetic is the part that must be provably O(n) and provably memo-stable. Pulling it out is what makes it testable under Node at all — the page file is a Babel-transformed browser IIFE that cannot be `require`d.

---

## Task 1: Pure row model module

**Files:**
- Create: `scripts/api/programme-rows.js`
- Test: `tests/programme-rows.test.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces, on `window.FS.api.programmeRows` and via `module.exports`:
  - `buildChildIndex(leaves) -> { [parentId: string]: Array<Task> }`
  - `rollupFromChildren(children) -> { start: string|null, end: string|null, progress: number }`
  - `buildRows(parents, leaves, collapsedSet) -> Array<Row>` where
    `Row = { kind: 'group', task: Task, parent: Task, indent: 0 } | { kind: 'leaf', task: Task, indent: 1 }`
  - `visibleSlice(scrollTop, viewportH, rowCount, rowH, overscan) -> { first: number, last: number, topSpc: number, botSpc: number }`

`collapsedSet` is any object with a `.has(id)` method (the page passes a real `Set`).

- [ ] **Step 1: Write the failing test**

Create `tests/programme-rows.test.js`:

```js
'use strict';

/*
 * Unit tests for scripts/api/programme-rows.js — the pure row model behind
 * the Gantt.
 *
 * This module exists because GanttView used to rebuild its row list inline on
 * every render, calling a full `leaves.filter(...)` twice per parent
 * (programme.js:802-817 before this change). With 200 groups over 5,000
 * leaves that is ~2M iterations, paid again on every scroll event. The fix is
 * a single child index built once, so the structural guard below — which makes
 * `leaves.filter` throw — is the test that actually protects the performance
 * property. Correctness tests alone would not catch a regression back to
 * per-parent scanning.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  buildChildIndex,
  rollupFromChildren,
  buildRows,
  visibleSlice,
} = require('../scripts/api/programme-rows.js');

function leaf(id, parentId, start, end, days, pct) {
  return {
    task_id: id, parent_id: parentId, name: 'Task ' + id,
    start: start, end: end, duration_days: days, progress_pct: pct,
  };
}

const PARENTS = [
  { task_id: 'g1', wbs: '1', name: 'Foundations' },
  { task_id: 'g2', wbs: '2', name: 'Superstructure' },
];
const LEAVES = [
  leaf('t1', 'g1', '2026-04-01', '2026-04-10', 10, 100),
  leaf('t2', 'g1', '2026-04-05', '2026-04-20', 16, 50),
  leaf('t3', 'g2', '2026-05-01', '2026-05-08', 8, 0),
];

const noneCollapsed = new Set();

/* ---- buildChildIndex ----------------------------------------------------- */

test('buildChildIndex groups leaves under their parent_id', () => {
  const idx = buildChildIndex(LEAVES);
  assert.deepStrictEqual(idx.g1.map((t) => t.task_id), ['t1', 't2']);
  assert.deepStrictEqual(idx.g2.map((t) => t.task_id), ['t3']);
});

test('buildChildIndex preserves source order within a parent', () => {
  const idx = buildChildIndex([LEAVES[1], LEAVES[0]]);
  assert.deepStrictEqual(idx.g1.map((t) => t.task_id), ['t2', 't1']);
});

/* ---- rollupFromChildren -------------------------------------------------- */

test('rollupFromChildren spans min start to max end', () => {
  const r = rollupFromChildren([LEAVES[0], LEAVES[1]]);
  assert.strictEqual(r.start, '2026-04-01');
  assert.strictEqual(r.end, '2026-04-20');
});

test('rollupFromChildren weights progress by duration, not by task count', () => {
  /* t1: 10 days @ 100% = 10 done; t2: 16 days @ 50% = 8 done.
     18 / 26 = 69%. An unweighted mean would give 75%. */
  const r = rollupFromChildren([LEAVES[0], LEAVES[1]]);
  assert.strictEqual(r.progress, 69);
});

test('rollupFromChildren returns the empty shape for no children', () => {
  assert.deepStrictEqual(rollupFromChildren([]),
    { start: null, end: null, progress: 0 });
});

test('rollupFromChildren does not divide by zero when every duration is 0', () => {
  const r = rollupFromChildren([leaf('x', 'g1', '2026-04-01', '2026-04-01', 0, 50)]);
  assert.strictEqual(r.progress, 0);
});

/* ---- buildRows ----------------------------------------------------------- */

test('buildRows emits each group followed by its own leaves, in parent order', () => {
  const rows = buildRows(PARENTS, LEAVES, noneCollapsed);
  assert.deepStrictEqual(rows.map((r) => r.kind + ':' + r.task.task_id),
    ['group:g1', 'leaf:t1', 'leaf:t2', 'group:g2', 'leaf:t3']);
});

test('buildRows indents groups at 0 and leaves at 1', () => {
  const rows = buildRows(PARENTS, LEAVES, noneCollapsed);
  assert.strictEqual(rows[0].indent, 0);
  assert.strictEqual(rows[1].indent, 1);
});

test('buildRows keeps a collapsed group row but drops its leaves', () => {
  const rows = buildRows(PARENTS, LEAVES, new Set(['g1']));
  assert.deepStrictEqual(rows.map((r) => r.kind + ':' + r.task.task_id),
    ['group:g1', 'group:g2', 'leaf:t3']);
});

test('buildRows stamps the group row with rolled-up dates, status and zero duration', () => {
  const g1 = buildRows(PARENTS, LEAVES, noneCollapsed)[0];
  assert.strictEqual(g1.task.start, '2026-04-01');
  assert.strictEqual(g1.task.end, '2026-04-20');
  assert.strictEqual(g1.task.progress_pct, 69);
  assert.strictEqual(g1.task.status, 'group');
  assert.strictEqual(g1.task.duration_days, 0);
});

test('buildRows exposes the untouched parent alongside the derived group task', () => {
  const g1 = buildRows(PARENTS, LEAVES, noneCollapsed)[0];
  assert.strictEqual(g1.parent, PARENTS[0], 'parent must be the original object');
  assert.notStrictEqual(g1.task, PARENTS[0], 'task must be a derived copy');
  assert.strictEqual(PARENTS[0].status, undefined, 'the parent must not be mutated');
});

test('buildRows emits a group with no children and skips orphan leaves', () => {
  const rows = buildRows(
    [{ task_id: 'g9', wbs: '9', name: 'Empty' }],
    [leaf('orphan', 'nosuchgroup', '2026-04-01', '2026-04-02', 1, 0)],
    noneCollapsed,
  );
  assert.deepStrictEqual(rows.map((r) => r.task.task_id), ['g9']);
  assert.strictEqual(rows[0].task.start, null);
});

/* ---- the structural guard ------------------------------------------------ */

test('buildRows never scans the full leaf array per parent', () => {
  const parents = [];
  for (let i = 0; i < 200; i++) parents.push({ task_id: 'g' + i, wbs: String(i), name: 'G' + i });
  const leaves = [];
  for (let i = 0; i < 5000; i++) {
    leaves.push(leaf('t' + i, 'g' + (i % 200), '2026-04-01', '2026-04-10', 10, 0));
  }

  /* A per-parent `leaves.filter(...)` — the shape this module replaces — is
     what makes the row build O(parents x leaves) and therefore unaffordable
     inside a scroll handler. Make it detonate. */
  leaves.filter = function () {
    throw new Error('buildRows must not scan all leaves per parent — use the child index');
  };

  const rows = buildRows(parents, leaves, noneCollapsed);
  assert.strictEqual(rows.length, 200 + 5000);
});

/* ---- visibleSlice -------------------------------------------------------- */

test('visibleSlice covers the viewport plus overscan on both sides', () => {
  const s = visibleSlice(4400, 600, 1000, 44, 200);
  assert.strictEqual(s.first, Math.floor((4400 - 200) / 44));   // 95
  assert.strictEqual(s.last, Math.ceil((4400 + 600 + 200) / 44)); // 114
});

test('visibleSlice clamps to the first and last row', () => {
  const top = visibleSlice(0, 600, 10, 44, 200);
  assert.strictEqual(top.first, 0);
  assert.strictEqual(top.topSpc, 0);

  const bottom = visibleSlice(999999, 600, 10, 44, 200);
  assert.strictEqual(bottom.last, 9);
  assert.strictEqual(bottom.botSpc, 0);
});

test('visibleSlice spacers plus rendered rows always total the full height', () => {
  const rowCount = 1000, rowH = 44;
  const s = visibleSlice(4400, 600, rowCount, rowH, 200);
  const rendered = (s.last - s.first + 1) * rowH;
  assert.strictEqual(s.topSpc + rendered + s.botSpc, rowCount * rowH);
});

test('visibleSlice returns an empty slice for an empty programme', () => {
  assert.deepStrictEqual(visibleSlice(0, 600, 0, 44, 200),
    { first: 0, last: -1, topSpc: 0, botSpc: 0 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/programme-rows.test.js`
Expected: FAIL — `Cannot find module '../scripts/api/programme-rows.js'`

- [ ] **Step 3: Write the implementation**

Create `scripts/api/programme-rows.js`:

```js
/* ==========================================================================
   FieldSight Programme Rows — pure row model for the Gantt
   --------------------------------------------------------------------------
   Extracted from GanttView (scripts/pages/programme.js), where the visible
   row list was rebuilt inline on every render and cost O(parents x leaves):
   each parent ran `rollupGroup(parent, leaves)` — a full scan — and then a
   second full `leaves.filter(...)` for its children. On a 200-group /
   5,000-leaf programme that is ~2M iterations, and the scroll handler
   re-rendered on every scrolled pixel, so it was paid ~60x a second.

   Everything here is pure: no React, no DOM, no window access. That is what
   lets the page memoize it on [parents, leaves, collapsed] and what lets it
   be tested under Node.

   Exported to:
     window.FS.api.programmeRows   (browser)
     module.exports                (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Bucket leaves by parent_id in ONE pass. Built once per task-set change;
     every parent then reads its children in O(children) instead of O(leaves). */
  function buildChildIndex(leaves) {
    var idx = {};
    var list = leaves || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var pid = t.parent_id;
      if (pid == null) continue;
      if (!idx[pid]) idx[pid] = [];
      idx[pid].push(t);
    }
    return idx;
  }

  /* Date span + duration-weighted progress for a group row. Weighting by
     duration (not task count) is deliberate: a 40-day task at 0% and a 1-day
     task at 100% is not "50% done". */
  function rollupFromChildren(children) {
    if (!children || !children.length) return { start: null, end: null, progress: 0 };
    var start = null, end = null, totalDays = 0, doneDays = 0;
    for (var i = 0; i < children.length; i++) {
      var t = children[i];
      if (t.start && (start === null || t.start < start)) start = t.start;
      if (t.end   && (end   === null || t.end   > end))   end   = t.end;
      var d = t.duration_days || 0;
      totalDays += d;
      doneDays  += d * (t.progress_pct || 0) / 100;
    }
    return {
      start:    start,
      end:      end,
      progress: totalDays > 0 ? Math.round(doneDays / totalDays * 100) : 0,
    };
  }

  /* The visible row list in WBS order: each group, then its leaves unless the
     group is collapsed. Leaves whose parent_id matches no parent are not
     emitted — same as the behaviour this replaced. */
  function buildRows(parents, leaves, collapsed) {
    var idx  = buildChildIndex(leaves);
    var rows = [];
    var list = parents || [];
    for (var i = 0; i < list.length; i++) {
      var parent   = list[i];
      var children = idx[parent.task_id] || [];
      var roll     = rollupFromChildren(children);

      var groupTask = Object.assign({}, parent, {
        start:         roll.start,
        end:           roll.end,
        duration_days: 0,
        progress_pct:  roll.progress,
        status:        'group',
      });
      rows.push({ kind: 'group', task: groupTask, parent: parent, indent: 0 });

      if (collapsed && collapsed.has(parent.task_id)) continue;
      for (var j = 0; j < children.length; j++) {
        rows.push({ kind: 'leaf', task: children[j], indent: 1 });
      }
    }
    return rows;
  }

  /* Which rows the virtualizer should mount, plus the spacer heights that
     stand in for the ones it does not. Pure arithmetic so the page can
     compare two slices and skip a re-render when they are identical. */
  function visibleSlice(scrollTop, viewportH, rowCount, rowH, overscan) {
    if (!rowCount) return { first: 0, last: -1, topSpc: 0, botSpc: 0 };
    var first = Math.max(0, Math.floor((scrollTop - overscan) / rowH));
    var last  = Math.min(rowCount - 1, Math.ceil((scrollTop + viewportH + overscan) / rowH));
    return {
      first:  first,
      last:   last,
      topSpc: first * rowH,
      botSpc: Math.max(0, (rowCount - 1 - last) * rowH),
    };
  }

  var api = {
    buildChildIndex:     buildChildIndex,
    rollupFromChildren:  rollupFromChildren,
    buildRows:           buildRows,
    visibleSlice:        visibleSlice,
  };

  /* Browser: register onto the shared api namespace. */
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeRows = api;
  }

  /* Node test runner (CommonJS). No-op in the browser. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/programme-rows.test.js`
Expected: PASS, 17 tests.

If `visibleSlice` spacer arithmetic fails the "spacers plus rendered rows total the full height" assertion, the bug is in `botSpc`: it must be `(rowCount - 1 - last) * rowH`, not `(rowCount - last) * rowH`, because `last` is an inclusive index.

- [ ] **Step 5: Syntax-check and commit**

```bash
node --check scripts/api/programme-rows.js
git add scripts/api/programme-rows.js tests/programme-rows.test.js
git commit -m "feat(programme): pure row model with a single-pass child index

Extracts the Gantt's row arithmetic out of GanttView, where it ran inline on
every render at O(parents x leaves) — a full leaf scan per parent for the
rollup and a second one for the children.

The structural test makes leaves.filter throw, so a regression back to
per-parent scanning fails the suite rather than quietly costing frames."
```

---

## Task 2: GanttView consumes the pure row model

**Files:**
- Modify: `scripts/pages/programme.js:801-817` (the inline `rows` build)
- Modify: `app-shell-preview.html` (add the `<script>` tag)

**Interfaces:**
- Consumes: `window.FS.api.programmeRows.buildRows(parents, leaves, collapsed)` from Task 1.
- Produces: `rows` is now referentially stable across renders that do not change `[s.parents, s.leaves, ctx.collapsed]`. Task 3 depends on that stability.

- [ ] **Step 1: Load the module before the page**

In `app-shell-preview.html`, immediately after the `programme-schedule.js` line (currently line 233):

```html
  <!-- Programme foundation (Plan A) — pure row model behind the Gantt -->
  <script src="scripts/api/programme-rows.js?v=1"></script>
```

- [ ] **Step 2: Replace the inline row build**

In `scripts/pages/programme.js`, replace this block (currently at 801-817):

```js
    /* Build the visible rows in WBS order: each parent followed by its
       leaves (unless collapsed). */
    var rows = [];
    s.parents.forEach(function (parent) {
      var roll = rollupGroup(parent, s.leaves);
      var groupTask = Object.assign({}, parent, {
        start: roll.start, end: roll.end, duration_days: 0,
        progress_pct: roll.progress, status: 'group',
      });
      rows.push({ kind: 'group', task: groupTask, parent: parent, indent: 0 });
      if (!ctx.collapsed.has(parent.task_id)) {
        s.leaves
          .filter(function (t) { return t.parent_id === parent.task_id; })
          .forEach(function (leaf) {
            rows.push({ kind: 'leaf', task: leaf, indent: 1 });
          });
      }
    });
```

with:

```js
    /* Build the visible rows in WBS order: each parent followed by its
       leaves (unless collapsed).

       Memoized because this used to run on every render — including every
       scroll event — at O(parents x leaves). See scripts/api/programme-rows.js.
       The identity stability also matters downstream: the virtual slice
       (below) and the memoized row composites both key off it. */
    var rows = React.useMemo(function () {
      return window.FS.api.programmeRows.buildRows(s.parents, s.leaves, ctx.collapsed);
    }, [s.parents, s.leaves, ctx.collapsed]);
```

- [ ] **Step 3: Confirm `ctx.collapsed` is replaced, never mutated**

The memo above is only correct if collapsing a group produces a **new** `Set`. Find `toggleGroup` in `ProgrammeProvider` and verify it does `setCollapsed(next)` with a freshly constructed `Set`, e.g.:

```js
    function toggleGroup(taskId) {
      setCollapsed(function (prev) {
        var next = new Set(prev);
        if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
        return next;
      });
    }
```

If it mutates the existing Set in place (`collapsed.add(...)` then `setCollapsed(collapsed)`), rewrite it to the copy-on-write form above. A mutated Set keeps the same identity, so the memo would never invalidate and collapsing would visibly stop working.

- [ ] **Step 4: Remove the now-unused helper**

`rollupGroup` (`scripts/pages/programme.js:124-135`) has no remaining callers. Confirm with:

```bash
grep -n "rollupGroup" scripts/pages/programme.js
```

Expected: only the definition. Delete it. If any other caller appears, leave it and note the caller in the commit message.

- [ ] **Step 5: Verify in the browser**

```bash
python3 -m http.server 8765
# open http://localhost:8765/app-shell-preview.html → /programme
```

Check, against the fixture programme: group rows appear with their leaves under them in the same order as before; collapsing and expanding a group still works; group bars still show rolled-up dates and progress.

- [ ] **Step 6: Commit**

```bash
node --check scripts/pages/programme.js
git add scripts/pages/programme.js app-shell-preview.html
git commit -m "perf(programme): memoize the Gantt row list

GanttView rebuilt its row list inline on every render, so every scroll event
paid a full O(parents x leaves) rebuild. It now calls the pure row model and
memoizes on [parents, leaves, collapsed]."
```

---

## Task 3: rAF-throttle scrolling and re-render only when the slice changes

**Files:**
- Modify: `scripts/pages/programme.js:833-863` (virtualizer state and scroll effect)

**Interfaces:**
- Consumes: `window.FS.api.programmeRows.visibleSlice` from Task 1; the stable `rows` from Task 2.
- Produces: `slice` (`{first, last, topSpc, botSpc}`) used by the render body in place of the previous `first` / `last` / `topSpc` / `botSpc` locals.

Two separate defects are being fixed here. `setSTop(el.scrollTop)` fires on every scrolled pixel — 60+ state updates a second — and most of those updates do not change which rows are mounted, so the re-render is pure waste. Throttling to one frame fixes the rate; comparing slices fixes the waste.

- [ ] **Step 1: Replace the virtualizer state and effect**

Replace this block (currently 837-863):

```js
    var scrollRef  = React.useRef(null);
    var refSTop    = React.useState(0);
    var sTop       = refSTop[0]; var setSTop = refSTop[1];
    var refVpH     = React.useState(600);
    var vpH        = refVpH[0];  var setVpH  = refVpH[1];

    React.useEffect(function () {
      if (!DO_VIRT) return;
      var el = scrollRef.current;
      if (!el) return;
      setVpH(el.clientHeight || 600);
      function onScroll() { setSTop(el.scrollTop); }
      function onResize() { setVpH(el.clientHeight || 600); }
      el.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onResize);
      return function () {
        el.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
      };
    }, [DO_VIRT]);

    var first   = DO_VIRT ? Math.max(0, Math.floor((sTop - OVERSCAN) / ROW_H)) : 0;
    var last    = DO_VIRT ? Math.min(rows.length - 1, Math.ceil((sTop + vpH + OVERSCAN) / ROW_H)) : rows.length - 1;
    var vRows   = DO_VIRT ? rows.slice(first, last + 1) : rows;
    var topSpc  = DO_VIRT ? first * ROW_H : 0;
    var botSpc  = DO_VIRT ? Math.max(0, (rows.length - 1 - last) * ROW_H) : 0;
```

with:

```js
    var scrollRef = React.useRef(null);

    /* The mounted window, as row indices. Scrolling only sets state when the
       window actually moves: a scroll event that shifts the viewport by a few
       pixels usually leaves `first`/`last` unchanged, and re-rendering for it
       is pure cost. Combined with the rAF gate below, a fast flick produces at
       most one render per frame, and often far fewer. */
    var sliceHook = React.useState({ first: 0, last: -1, topSpc: 0, botSpc: 0 });
    var slice     = sliceHook[0];
    var setSlice  = sliceHook[1];

    /* Read inside the scroll handler without re-subscribing on every change. */
    var rowCountRef = React.useRef(rows.length);
    rowCountRef.current = rows.length;

    React.useEffect(function () {
      var el = scrollRef.current;
      if (!el) return;

      var frame = 0;

      function measure() {
        frame = 0;
        var node = scrollRef.current;
        if (!node) return;
        var next = window.FS.api.programmeRows.visibleSlice(
          node.scrollTop, node.clientHeight || 600,
          rowCountRef.current, ROW_H, OVERSCAN,
        );
        setSlice(function (prev) {
          return (prev.first === next.first && prev.last === next.last) ? prev : next;
        });
      }

      /* One measurement per animation frame, no matter how many scroll
         events the browser delivers in between. */
      function schedule() {
        if (frame) return;
        frame = window.requestAnimationFrame(measure);
      }

      measure();
      el.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
      return function () {
        if (frame) window.cancelAnimationFrame(frame);
        el.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
      };
    }, [rows]);

    var first  = DO_VIRT ? slice.first : 0;
    var last   = DO_VIRT ? Math.min(slice.last, rows.length - 1) : rows.length - 1;
    var vRows  = DO_VIRT ? rows.slice(first, last + 1) : rows;
    var topSpc = DO_VIRT ? slice.topSpc : 0;
    var botSpc = DO_VIRT ? Math.max(0, (rows.length - 1 - last) * ROW_H) : 0;
```

Note the effect depends on `[rows]`, not `[DO_VIRT]`: when the programme changes, the slice must be re-measured against the new row count. `rows` is referentially stable after Task 2, so this does not re-subscribe on every render.

- [ ] **Step 2: Verify scrolling still mounts the right rows**

Serve the app and open `/programme` with the fixture. Scroll to the bottom and confirm the last task is reachable and rendered, and that the scrollbar length does not jump while scrolling (a jump means the spacer arithmetic is wrong).

- [ ] **Step 3: Verify the re-render rate dropped**

In DevTools → Performance, record a 3-second sustained scroll. Before this task, expect a React commit per scroll event. After, expect at most one per frame, with gaps where the slice did not move.

- [ ] **Step 4: Commit**

```bash
node --check scripts/pages/programme.js
git add scripts/pages/programme.js
git commit -m "perf(programme): rAF-throttle Gantt scrolling, re-render only on slice change

The scroll handler called setState with the raw scrollTop on every scrolled
pixel. Measurement is now gated to one animation frame, and the slice is only
committed when the mounted row window actually moves."
```

---

## Task 4: Memoize the row composites

**Files:**
- Modify: `scripts/composites/task-tree-cell.js`
- Modify: `scripts/composites/gantt-row.js`
- Modify: `scripts/pages/programme.js:964-980` (tree cell props) and `:1003-1043` (gantt row props)

**Interfaces:**
- Consumes: stable `rows` (Task 2), stable `slice` (Task 3).
- Produces: `TaskTreeCell` and `GanttRow` are `React.memo`-wrapped; `TaskTreeCell.onToggle` now receives the task id.

`React.memo` alone would do nothing here: the page currently creates a fresh `onToggle` and `onSelect` closure for every row on every render, so props never compare equal. The callbacks must be hoisted first.

- [ ] **Step 1: Pass the task id out of TaskTreeCell's chevron**

In `scripts/composites/task-tree-cell.js`, change the chevron handler:

```js
            onClick:   function (e) {
              e.stopPropagation();
              if (props.onToggle) props.onToggle(t.task_id);
            },
```

and update the props doc comment near the top of the file:

```js
     onToggle     (taskId) => void — chevron click (only when isGroup)
```

`onSelect` already receives the task (`props.onSelect(t)`), so it needs no change.

- [ ] **Step 2: Wrap both composites in React.memo**

At the bottom of `scripts/composites/task-tree-cell.js`, replace the registration:

```js
  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TaskTreeCell = React.memo(TaskTreeCell);
```

At the bottom of `scripts/composites/gantt-row.js`, likewise:

```js
  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.GanttRow = React.memo(GanttRow);
```

Default shallow comparison is correct for both: every prop is a primitive, `null`, a task object from state, or (after step 3) a stable callback.

- [ ] **Step 3: Hoist the per-row callbacks in GanttView**

Add these near the top of `GanttView`, before the render body:

```js
    /* Stable across renders so React.memo on the row composites can actually
       short-circuit. Each row previously got a freshly-created closure, which
       made every memo comparison fail. */
    var handleToggle = React.useCallback(function (taskId) {
      ctx.toggleGroup(taskId);
    }, [ctx.toggleGroup]);

    var handleSelect = React.useCallback(function (task) {
      if (task.status === 'group') return;
      props.onSelect({
        kind:    'programme_task',
        id:      'task_' + task.task_id,
        task_id: task.task_id,
        task:    task,
      });
    }, [props.onSelect]);

    var handleKeyboardMove = React.useCallback(function (opts) {
      ctx.updateTask(opts);
    }, [ctx.updateTask]);
```

The group guard moved from the call site into `handleSelect`. It keys off `task.status === 'group'`, which `buildRows` stamps on every group row (Task 1) — so it is exactly equivalent to the `r.kind === 'group'` check it replaces.

- [ ] **Step 4: Use the hoisted callbacks at both call sites**

In the tree-cell mapping, replace the inline `onToggle` / `onSelect`:

```js
              onToggle:   handleToggle,
              onSelect:   handleSelect,
```

In the Gantt row mapping, replace the inline `onSelect` and `onKeyboardMove`:

```js
                onKeyboardMove: r.kind === 'leaf' ? handleKeyboardMove : null,
                onSelect:       handleSelect,
```

- [ ] **Step 5: Stabilise the drag callbacks**

`onDragStart` / `onDragMove` / `onDragEnd` pass `dragStart` / `dragMove` / `dragEnd`. Find their definitions in `GanttView` and wrap each in `React.useCallback` with its real dependencies. If any of them reads mutable drag state, it should already be reading it through the drag `useRef` — in which case its dependency array is `[]`. Verify that before setting `[]`; a stale closure here silently breaks dragging.

- [ ] **Step 6: Verify behaviour is unchanged**

In the browser: clicking a leaf row still opens the right detail; clicking a group row still does nothing; the chevron still collapses and expands; dragging a bar still moves it and persists; keyboard move (arrow keys on a focused bar) still commits.

- [ ] **Step 7: Verify the memo actually engages**

DevTools → Profiler, record a scroll. Rows that stay mounted should show as "Did not render". If every row still re-renders, one prop is unstable — check the drag callbacks from step 5 first.

- [ ] **Step 8: Commit**

```bash
node --check scripts/composites/task-tree-cell.js
node --check scripts/composites/gantt-row.js
node --check scripts/pages/programme.js
git add scripts/composites/task-tree-cell.js scripts/composites/gantt-row.js scripts/pages/programme.js
git commit -m "perf(programme): memoize Gantt row composites

GanttRow and TaskTreeCell re-reconciled on every frame during a scroll. They
are now React.memo-wrapped, and the per-row onToggle/onSelect closures the page
recreated on every render are hoisted to useCallback so the comparison can
succeed. TaskTreeCell's onToggle now receives the task id."
```

---

## Task 5: Stop rebuilding the date strip every render

**Files:**
- Modify: `scripts/composites/gantt-strip.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GanttStrip` is `React.memo`-wrapped and its marker list is memoized.

At day tier the strip emits one absolutely-positioned div per calendar day — roughly 1,100 for a three-year programme — and rebuilds all of them on every render because the component is not memoized. The marker count itself is tolerable to mount once; rebuilding it 60 times a second is not.

- [ ] **Step 1: Memoize the marker computation**

In `scripts/composites/gantt-strip.js`, replace the body's marker construction with a `useMemo`:

```js
    var strip = React.useMemo(function () {
      var dates = dateRangeISO(from, to);
      var out = [];
      if (tier === 'day') {
        dates.forEach(function (d, i) {
          out.push({ iso: d, label: formatDay(d), x: i * ppd });
        });
      } else if (tier === 'week') {
        dates.forEach(function (d, i) {
          if (isMonday(d) || i === 0) out.push({ iso: d, label: formatWeek(d), x: i * ppd });
        });
      } else {
        dates.forEach(function (d, i) {
          if (isFirstOfMonth(d) || i === 0) out.push({ iso: d, label: formatMonth(d), x: i * ppd });
        });
      }
      return { markers: out, totalWidth: dates.length * ppd };
    }, [from, to, ppd, tier]);

    var markers    = strip.markers;
    var totalWidth = strip.totalWidth;
```

The rest of the render body is unchanged.

- [ ] **Step 2: Wrap the component**

```js
  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.GanttStrip = React.memo(GanttStrip);
```

- [ ] **Step 3: Verify**

In the browser, switch tier between Day / Week / Month and confirm the strip relabels correctly each time, and that the today marker still lines up with the bars.

- [ ] **Step 4: Commit**

```bash
node --check scripts/composites/gantt-strip.js
git add scripts/composites/gantt-strip.js
git commit -m "perf(programme): memoize the Gantt date strip

At day tier the strip builds one marker per calendar day across the whole
programme, and rebuilt all of them on every render. The marker list is now
memoized on [from, to, pixelsPerDay, tier] and the component is React.memo'd.

First-paint cost at day tier over a multi-year programme is unchanged; the
time-window view in Plan B is what bounds that span."
```

---

## Task 6: Pin the row height the virtualizer assumes

**Files:**
- Modify: `styles/composites.css`

> **Corrected during implementation — this task was written backwards.**
>
> The plan assumed the rows rendered at 44 px and the risk was a wrapped task
> name making one taller. In fact `.fs-gantt-tree__cell` and `.fs-gantt-row`
> have **always** been `36px` (in `styles/composites.css`, not
> `app-shell.css`, and `box-sizing: border-box` is global so the 1px border is
> inside it), while the virtualizer hard-codes `ROW_H = 44`.
>
> Every spacer was therefore **8px per row too tall** — about 40,000px of
> drift over a 5,000-row programme — so the scrollbar never matched the
> content and scrolling jumped and overshot. This is a **pre-existing defect**
> and very likely the real cause of the scroll misbehaviour this plan set out
> to fix.
>
> The fix is the reverse of what is written below: set `ROW_H = 36` to match
> the CSS, not the CSS to match `ROW_H`. Also add `flex-shrink: 0` to both
> rules — `.fs-gantt__tree` is a flex column, so without it rows compress once
> content exceeds the container, at exactly the scale where the drift hurts
> most. The task name already truncates with ellipsis, so no wrapping fix is
> needed.
>
> Steps 1–4 below are kept as written for the record.

The virtualizer hard-codes `ROW_H = 44` (`scripts/pages/programme.js:834`) and derives every spacer height from it. If a long task name wraps to two lines, that row renders taller than 44 px, the spacers no longer match the real content height, and the scroll position drifts — which reads as jumpy scrolling on top of the lag. Pinning the height in CSS is the smaller and more predictable fix; measuring every row would mean a `ResizeObserver` per row.

- [ ] **Step 1: Find the row rules**

```bash
grep -n "fs-gantt-tree__cell\|fs-gantt-row" styles/app-shell.css | head -20
```

- [ ] **Step 2: Pin both to 44 px and stop the name from wrapping**

Add to the existing `.fs-gantt-tree__cell` rule:

```css
  height: 44px;          /* MUST match ROW_H in scripts/pages/programme.js */
  box-sizing: border-box;
  flex-shrink: 0;
```

Add to the existing `.fs-gantt-row` rule:

```css
  height: 44px;          /* MUST match ROW_H in scripts/pages/programme.js */
  box-sizing: border-box;
  flex-shrink: 0;
```

And make a long task name truncate rather than wrap:

```css
.fs-gantt-tree__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;          /* required for ellipsis inside a flex child */
}
```

- [ ] **Step 3: Verify**

In the browser, find (or temporarily rename) a task with a very long name. The tree cell must stay one line, ellipsised, and every row must measure exactly 44 px in the element inspector. Confirm the full name is still readable in the right-hand detail pane.

- [ ] **Step 4: Commit**

```bash
git add styles/app-shell.css
git commit -m "fix(programme): pin Gantt row height to the virtualizer's ROW_H

Spacer heights are derived from a hard-coded 44px. A wrapped task name made a
row taller than that, so the spacers stopped matching real content height and
the scroll position drifted. Rows are now pinned to 44px and long names
ellipsise; the full name is still shown in the detail pane."
```

---

## Task 7: Verify against a large programme and open the PR

**Files:**
- Create: `scripts/mock/programme-large.fixture.js`
- Modify: `app-shell-preview.html`

**Interfaces:**
- Consumes: everything above.
- Produces: the acceptance evidence for this plan. Nothing depends on it.

- [ ] **Step 1: Generate a 5,000-leaf fixture**

Create `scripts/mock/programme-large.fixture.js`:

```js
/* ==========================================================================
   FieldSight Programme — large synthetic fixture (perf verification only)
   --------------------------------------------------------------------------
   200 groups x 25 leaves = 5,000 leaves over ~3 years, which is the shape
   this plan's acceptance target is stated against: sustained scroll with no
   frame over 50ms.

   Not loaded by default. Enable by appending ?bigprogramme=1 to the preview
   URL. Never referenced by product code.
   ========================================================================== */

(function () {
  'use strict';

  function iso(dayOffset) {
    var d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + dayOffset);
    return d.toISOString().slice(0, 10);
  }

  var parents = [];
  var leaves  = [];
  for (var g = 0; g < 200; g++) {
    parents.push({ task_id: 'G' + g, wbs: String(g + 1), name: 'Zone ' + (g + 1) });
    for (var i = 0; i < 25; i++) {
      var startDay = g * 5 + i * 2;
      leaves.push({
        task_id:       'G' + g + '-T' + i,
        parent_id:     'G' + g,
        wbs:           (g + 1) + '.' + (i + 1),
        name:          'Activity ' + (i + 1) + ' in zone ' + (g + 1),
        start:         iso(startDay),
        end:           iso(startDay + 9),
        duration_days: 10,
        progress_pct:  (i * 4) % 101,
        status:        'not_started',
        assignees:     [],
        depends_on:    i > 0 ? ['G' + g + '-T' + (i - 1)] : [],
        linked_action_items: [],
      });
    }
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.PROGRAMME_LARGE_FIXTURE = {
    name:       'Synthetic 5k programme',
    start_date: iso(0),
    end_date:   iso(1120),
    parents:    parents,
    leaves:     leaves,
  };
})();
```

- [ ] **Step 2: Load it behind a query flag**

In `app-shell-preview.html`, next to the existing programme fixture (line 190):

```html
  <!-- Perf verification only; see docs/superpowers/plans/2026-08-02-programme-render-performance.md -->
  <script src="scripts/mock/programme-large.fixture.js?v=1"></script>
```

In `scripts/api/programme.js`, at the top of the function that returns the mock programme, add the opt-in:

```js
    /* Perf harness (Plan A Task 7). Opt-in only, never the default. */
    if (typeof window !== 'undefined'
        && window.location
        && window.location.search.indexOf('bigprogramme=1') !== -1
        && window.FieldSight.PROGRAMME_LARGE_FIXTURE) {
      return Promise.resolve(window.FieldSight.PROGRAMME_LARGE_FIXTURE);
    }
```

Place it inside the existing mock branch, so a real backend response is never intercepted.

- [ ] **Step 3: Measure**

```bash
python3 -m http.server 8765
# open http://localhost:8765/app-shell-preview.html?bigprogramme=1 → /programme
```

DevTools → Performance → record a 5-second sustained scroll through the Gantt at Day tier. Record:

- longest frame (ms) — **acceptance: no frame over 50 ms**
- number of React commits during the scroll
- scripting time as a share of the recording

Repeat at Week and Month tier.

- [ ] **Step 4: If the target is missed, profile before changing anything**

Read the flame chart and identify the actual top frame. Likely candidates, in order:

- `detectOverAllocations` (`scripts/api/programme-schedule.js:274`) walks every calendar day of every task; it is `useMemo`'d on `s.leaves` but any task edit re-runs it in full.
- `computeCriticalPath`'s `topoSort` (`scripts/api/programme-schedule.js:65`) re-scans all leaves inside its queue loop, making it O(V·E).

Both are outside this plan's scope. If either dominates, record the measurement in the PR description and raise it as a follow-up rather than expanding this branch.

- [ ] **Step 5: Commit and open the PR**

```bash
git add scripts/mock/programme-large.fixture.js app-shell-preview.html scripts/api/programme.js
git commit -m "test(programme): 5k-leaf fixture behind ?bigprogramme=1 for perf verification"
git push -u origin HEAD
gh pr create --base main --title "perf(programme): make the Gantt scroll at construction scale" --body "$(cat <<'BODY'
Plan A of Project 1. Spec: docs/superpowers/specs/2026-08-02-programme-foundation-design.md §8
Plan: docs/superpowers/plans/2026-08-02-programme-render-performance.md

Four defects made /programme lock up on a real programme:

- the row list was rebuilt inline on every render at O(parents x leaves) — a
  full leaf scan per parent for the rollup, a second one for the children
- the scroll handler called setState with the raw scrollTop on every scrolled
  pixel, so that rebuild was paid ~60x a second
- GanttRow, TaskTreeCell and GanttStrip had no memoization, and the page
  recreated their callbacks every render so memoizing them alone would not
  have helped
- rows were assumed to be exactly 44px while a wrapped task name made them
  taller, drifting the virtual spacers

No behaviour changes. Same rows, same order, same visuals.

## Measurements (5,000 leaves, 200 groups, sustained 5s scroll)

| Tier | Longest frame before | after |
|---|---|---|
| Day | TODO | TODO |
| Week | TODO | TODO |
| Month | TODO | TODO |

## Test plan

- `node --test tests/programme-rows.test.js` — 17 tests, including a
  structural guard that makes `leaves.filter` throw so a regression back to
  per-parent scanning fails the suite
- Manual: collapse/expand, leaf select, group select is still a no-op, bar
  drag, keyboard move, tier switching, long-name truncation

Note for review: main is production and auto-deploys on merge.
BODY
)"
```

Fill both TODO columns with the real numbers from step 3 before requesting review. Leaving them is a plan failure — the whole branch exists to move them.

---

## Self-Review

**Spec coverage** — spec §8 lists five rendering fixes:

| Spec item | Task |
|---|---|
| Memoize `rows`, precompute child index | 1, 2 |
| rAF-throttle the scroll handler, skip unchanged slices | 1 (`visibleSlice`), 3 |
| `React.memo` on `GanttRow`, `TaskTreeCell`, `GanttStrip` | 4, 5 |
| Render only visible ticks in `GanttStrip` | 5 — **deliberately narrowed.** The defect that costs frames is rebuilding the marker list every render, which memoization removes entirely. Horizontal virtualization would additionally reduce first-paint cost at day tier over a multi-year span, but the time-window view (Plan B §7) bounds that span to ~10 weeks, making it dead work. Recorded in the Task 5 commit message. |
| Measure row height, or enforce it in CSS | 6 — CSS chosen; a `ResizeObserver` per row costs more than it saves. |
| Acceptance: 5,000 rows, no frame over 50 ms | 7 |

**Placeholders** — the two `TODO`s in the PR body are measurement slots the implementer fills from step 3, and the step says so explicitly. No other placeholders.

**Type consistency** — `buildRows` / `visibleSlice` / `buildChildIndex` / `rollupFromChildren` are named identically in Task 1's implementation, Task 1's tests, and their call sites in Tasks 2 and 3. `visibleSlice` returns `{first, last, topSpc, botSpc}`; Task 3 destructures exactly those four. `Row` is `{kind, task, indent}` with `parent` on group rows only; Tasks 2 and 4 read `r.kind`, `r.task`, `r.indent` and never `r.parent`, which the previous code also did not.

**Two behaviour-preservation risks worth the reviewer's attention:**

1. Task 2 is only correct if `toggleGroup` replaces the collapsed `Set` rather than mutating it — step 3 checks this explicitly, because a mutating implementation would make collapsing stop working with no error.
2. Task 4 moves the group guard from `r.kind === 'group'` at the call site into `task.status === 'group'` inside the handler. These are equivalent only because `buildRows` stamps `status: 'group'` on every group row, which Task 1 asserts in a test.
