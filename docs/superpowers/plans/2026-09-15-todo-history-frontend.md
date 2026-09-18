# To-do History, Save Feedback, Version Chip, Width and Stat Strip — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a to-do's provenance and version history where people edit it (Timeline action rows, Today detail panel), acknowledge every field save, keep open histories and a `vN` chip on Today's cards current, widen the middle column, and compact Timeline's stat strip.

**Architecture:** Pure helpers live beside their components and are exported through the existing `if (typeof module !== 'undefined' && module.exports)` guard so `node --test` can require the browser IIFEs with a minimal `global.window` stub. A new tiny pub/sub `FS.events` (`scripts/api/events.js`) carries `content:edited {table,id}`, emitted only by `FS.api.actions.settleSave`. A new composite `window.FieldSight.TodoHistory` fetches only while its host says `open`.

**Tech Stack:** Vanilla JS IIFEs, in-browser `React.createElement` (no build step), CSS BEM with tokens, `node --test tests/*.test.js` (Node 24).

**Spec:** `docs/specs/2026-09-15-todo-card-history-and-save-feedback.md` (primary), which builds on `docs/specs/2026-08-30-todo-history-card.md` (§2 provenance and §3 rules apply; its §3 numbering is REPLACED by the new spec §3.4). Executors read both.

## Global Constraints

- No build step, no npm dependencies. English only in code, comments, commit messages.
- Tokens only in CSS (`var(--…)`); semantic tokens (`--text-*`, `--surface-*`, `--border-*`) for foregrounds, never palette-scale tokens.
- `FS.api` is assigned wholesale by `scripts/api/index.js:87`. New `FS.api`-touching scripts load after it. `scripts/api/events.js` loads **after `api/index.js`** in every entry HTML (only `app-shell-preview.html` loads the api chain; `amplify.yml` copies it to `dist/index.html`).
- Missing `version` on an action item is treated as `1` (backend §8.1 ships separately). No chip below `v2`.
- Toast literal `{message: 'Saved', tone: 'success', duration: 2000}` exists only in `settleSave`.
- Middle column: default **420**, min **360**, max **560**; storage key **`fs.appshell.middleWidth.v2`**.
- Compact stat strip only on Timeline's `ReportKpis`; base `.fs-stat-card` rules untouched.
- No request of any kind while `TodoHistory` `open` is false.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd
  ```

### Windows CRLF trap (read before the first edit)

`core.autocrlf=true`: the index holds **LF**, the working tree **CRLF** (`git ls-files --eol` shows `i/lf w/crlf` for every file touched here). Editing tools can rewrite a whole file with one line-ending style, which then shows up as a whole-file diff. **Before every commit** run:

```bash
git diff --stat
```

Every touched file must show a line count close to what you actually changed (tens, not thousands). If a file shows its whole length changed, do not commit: restore it with `git checkout -- <file>` and re-apply the change with small, single-line-anchored edits. New files: create them with LF or CRLF, it doesn't matter (git normalises on add), but check `git diff --cached --stat` after `git add`. Never `git add -A`; add named paths only. Do not rewrite whole existing files.

## File Map

| File | Change | Task |
|---|---|---|
| `scripts/app-shell.js` | constants 15/764/765, key line 9, clamped initial read ~1156 | 1 |
| `styles/app-shell.css` | `.middle-column` min/max (51–52) | 1 |
| `tests/middle-column-width.test.js` | new, source scan | 1 |
| `scripts/composites/kpi-strip.js` | `compact` prop + module.exports | 2 |
| `styles/composites.css` | `.fs-kpi-strip--compact` (after ~829); later `.fs-todo-history`, `.fs-task-card__version`, `.fs-action-item-row__history-toggle` | 2, 9, 11, 14 |
| `scripts/pages/timeline.js` | ReportKpis `compact` (~825); sessions switch (~1791); EditableText commit (~3368); ContentHistoryPanel subscribe (~3460); assignTo (~3585); ActionItemRow props (~3744) | 2, 5, 6, 10, 11 |
| `tests/timeline-stat-strip.test.js` | new | 2 |
| `components-preview.html` | compact strip row; TodoHistory script + smoke | 2, 9 |
| `scripts/api/events.js` | new `FS.events` | 3 |
| `app-shell-preview.html` | events.js tag; todo-history.js tag; cache busters | 3, 9, 15 |
| `tests/events.test.js` | new | 3 |
| `scripts/api/actions.js` | `settleSave`; history mock serving fixture versions | 4, 7 |
| `tests/save-settlement.test.js` | new (tests 8, 9) | 4, 5 |
| `scripts/pages/today.js` | `commitTaskField` (~2759); provider bump (~1311–1398); detail-panel host (~2998) | 5, 13 |
| `scripts/pages/tasks.js` | `commitRowField` (~968) | 5 |
| `scripts/api/org.js` | `getSessionsCached` (~468, registry ~840) | 6 |
| `tests/sessions-cached.test.js` | new | 6 |
| `scripts/mock/daily-report.fixture.js` | `session_kind`, one `report` topic, `version` | 7 |
| `scripts/composites/todo-history.js` | new composite + pure helpers | 8, 9 |
| `tests/todo-history.test.js` | new (tests 1–7, 10, chip tests) | 8, 9, 10, 14 |
| `scripts/composites/action-item-row.js` | disclosure + TodoHistory beneath | 11 |
| `scripts/api/today-adapter.js` | `sessionId`, `sessionKind`, `version` (~437) | 12 |
| `scripts/composites/task-card.js` | `versionChipFor` + title prefix (~276) | 14 |

Task order: 1 and 2 are independent and can ship alone. 3→4→5 ship save feedback on their own. 6–13 build history. 14 is the chip. 15 is browser verification.

---

### Task 1: Middle column width 420 / 360 / 560 with a fresh storage key (spec §9)

**Files:**
- Modify: `scripts/app-shell.js:9` (key), `:15` (default), `:764-765` (min/max), `:1155-1157` (initial read)
- Modify: `styles/app-shell.css:51-52`
- Test: `tests/middle-column-width.test.js` (create)

**Interfaces:**
- Consumes: `window.FieldSight.DragDivider.read(key, fallback)`, `.clamp(n, min, max)` (`scripts/drag-divider.js:36-46,154-156`).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
/*
 * SOURCE SCAN, not a behaviour test. app-shell.js cannot be required under
 * Node (no module.exports, reads window.FS.tokens at load), so this pins the
 * two copies of the middle-column rule (JS constants + CSS limits) to each
 * other and to spec 2026-09-15 §9.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const js  = read('scripts', 'app-shell.js');
const css = read('styles', 'app-shell.css');

function jsConst(name) {
  const m = js.match(new RegExp('const ' + name + '\\s*=\\s*(\\d+)'));
  assert.ok(m, name + ' not found in app-shell.js');
  return Number(m[1]);
}
function cssMiddle(prop) {
  const block = css.match(/(^|\n)\.middle-column\s*\{([^}]*)\}/);
  assert.ok(block, '.middle-column block not found');
  const m = block[2].match(new RegExp(prop + ':\\s*(\\d+)px'));
  assert.ok(m, prop + ' not found in the first .middle-column block');
  return Number(m[1]);
}

test('middle column constants are 420 / 360 / 560', () => {
  assert.strictEqual(jsConst('MIDDLE_WIDTH_DEFAULT'), 420);
  assert.strictEqual(jsConst('MIDDLE_WIDTH_MIN'), 360);
  assert.strictEqual(jsConst('MIDDLE_WIDTH_MAX'), 560);
});

test('default lies within [min, max]', () => {
  const d = jsConst('MIDDLE_WIDTH_DEFAULT');
  assert.ok(d >= jsConst('MIDDLE_WIDTH_MIN') && d <= jsConst('MIDDLE_WIDTH_MAX'));
});

test('CSS limits equal the JS limits', () => {
  assert.strictEqual(cssMiddle('min-width'), jsConst('MIDDLE_WIDTH_MIN'));
  assert.strictEqual(cssMiddle('max-width'), jsConst('MIDDLE_WIDTH_MAX'));
});

test('storage key is versioned .v2 so old saved widths are ignored', () => {
  const m = js.match(/middleWidth:\s*'([^']+)'/);
  assert.ok(m);
  assert.ok(m[1].endsWith('.v2'), 'key was ' + m[1]);
});

test('initial read is clamped (DragDivider.read does not clamp)', () => {
  assert.match(js, /dd\.clamp\(\s*dd\.read\(\s*STORAGE_KEYS\.middleWidth/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/middle-column-width.test.js`
Expected: FAIL — `320 !== 420`, key is `fs.appshell.middleWidth`, clamp regex does not match.

- [ ] **Step 3: Implement**

`scripts/app-shell.js` line 9:
```js
  middleWidth:  'fs.appshell.middleWidth.v2',
```
Line 15:
```js
const MIDDLE_WIDTH_DEFAULT = 420;
```
Lines 764–765:
```js
const MIDDLE_WIDTH_MIN     = 360;
const MIDDLE_WIDTH_MAX     = 560;
```
Lines 1155–1157:
```js
  const [middleWidth, setMiddleWidth] = React.useState(function() {
    /* .v2 key: widths saved inside the old 280-480 range are not a preference
       about the new one (spec 2026-09-15 §9.2). read() does not clamp, so a
       hand-edited out-of-range value is clamped here on first paint. */
    if (!dd) return MIDDLE_WIDTH_DEFAULT;
    return dd.clamp(dd.read(STORAGE_KEYS.middleWidth, MIDDLE_WIDTH_DEFAULT), MIDDLE_WIDTH_MIN, MIDDLE_WIDTH_MAX);
  });
```
`styles/app-shell.css` lines 51–52:
```css
  min-width: 360px;
  max-width: 560px;
```
Check that nothing else reads the key: `grep -rn "fs.appshell.middleWidth" scripts *.html` should match only `app-shell.js:9`.

- [ ] **Step 4: Run tests**

Run: `node --check scripts/app-shell.js && node --test tests/middle-column-width.test.js`
Expected: PASS (5 tests). Mutation check: set `MIDDLE_WIDTH_MAX` to 640. The constants and the CSS-equals-JS tests should go red. Then revert.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # app-shell.js ~8 lines, app-shell.css 2 lines
git add scripts/app-shell.js styles/app-shell.css tests/middle-column-width.test.js
git commit -m "Widen the middle column to 420 (360-560) under a fresh storage key

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 2: Compact stat strip on Timeline (spec §10)

**Files:**
- Modify: `scripts/composites/kpi-strip.js:19-26`
- Modify: `scripts/pages/timeline.js:825` (inside `ReportKpis`, defined at 787; mounted at 1420 and 2435)
- Modify: `styles/composites.css` right after `.fs-kpi-strip { … }` (~823-827)
- Modify: `components-preview.html` `<Section title="StatCard / KpiStrip">` (~1092)
- Test: `tests/timeline-stat-strip.test.js` (create)

**Interfaces:**
- Produces: `KpiStrip({compact?: boolean, children})` renders `div.fs-kpi-strip`, plus `.fs-kpi-strip--compact` when `compact` is set; `module.exports = { KpiStrip }` under Node.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = { FieldSight: {} };
global.React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };

const { KpiStrip } = require('../scripts/composites/kpi-strip.js');

test('KpiStrip without compact keeps the base class only', () => {
  assert.strictEqual(KpiStrip({ children: [] }).props.className, 'fs-kpi-strip');
});

test('KpiStrip compact appends the modifier class', () => {
  assert.strictEqual(KpiStrip({ compact: true, children: [] }).props.className,
    'fs-kpi-strip fs-kpi-strip--compact');
});

/* SOURCE SCAN (wiring pin). Both ReportKpis mounts render through the single
   KpiStrip call inside ReportKpis, which must pass compact. No other KpiStrip
   mount under scripts/ passes it. */
const root = path.join(__dirname, '..', 'scripts');
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const timeline = src('pages/timeline.js');

test('ReportKpis passes compact:true to KpiStrip, and ReportKpis is mounted twice', () => {
  const start = timeline.indexOf('function ReportKpis(');
  const end = timeline.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start);
  assert.match(timeline.slice(start, end), /createElement\(KpiStrip,\s*\{\s*compact:\s*true\s*\}/);
  assert.strictEqual((timeline.match(/createElement\(ReportKpis,/g) || []).length, 2);
});

test('no other KpiStrip mount in scripts/ passes compact', () => {
  const offenders = fs.readdirSync(root, { recursive: true })
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.js') && f !== 'composites/kpi-strip.js')
    .filter((f) => {
      const n = (src(f).match(/createElement\(KpiStrip,\s*\{[^}]*compact/g) || []).length;
      return f === 'pages/timeline.js' ? n !== 1 : n > 0;
    });
  assert.deepStrictEqual(offenders, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/timeline-stat-strip.test.js`
Expected: FAIL — `KpiStrip` is undefined (no module.exports), and the ReportKpis regex does not match.

- [ ] **Step 3: Implement**

`scripts/composites/kpi-strip.js`: add `compact   boolean, optional — one-line variant, Timeline day header only` to the Props header, then replace the function and footer with:
```js
  function KpiStrip(props) {
    return React.createElement('div', {
      className: 'fs-kpi-strip' + (props.compact ? ' fs-kpi-strip--compact' : ''),
    }, props.children);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.KpiStrip = KpiStrip;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KpiStrip: KpiStrip };
  }
```
`scripts/pages/timeline.js:825`:
```js
    return React.createElement(KpiStrip, { compact: true },
```
`styles/composites.css`, directly after the `.fs-kpi-strip { … }` rule:
```css
/* Compact strip: Timeline day header only (spec 2026-09-15 §10). Value and
   label share one baseline. Scoped here so the base .fs-stat-card rules (and
   Insights / strategic dashboards) are unchanged. Tone colours still apply. */
.fs-kpi-strip--compact { gap: 6px; }
.fs-kpi-strip--compact .fs-stat-card {
  flex-direction: row;
  align-items: baseline;
  gap: 6px;
  padding: 6px 10px;
}
.fs-kpi-strip--compact .fs-stat-card__value { font-size: 15px; }
```
The phone-width rule at ~8166 (`.fs-kpi-strip .fs-stat-card { flex: 1 1 calc(50% - 4px) }`) still wraps the compact tiles two per row.

`components-preview.html`: in the StatCard/KpiStrip section, add this after the "3-up KPI" `Row`:
```jsx
            <Row label="compact (Timeline day header)">
              <KpiStrip compact>
                <StatCard label="Topics"     value="4" />
                <StatCard label="Safety"     value="1" tone="danger" />
                <StatCard label="Recordings" value="21" />
                <StatCard label="Recorded"   value="9m 29s" />
              </KpiStrip>
            </Row>
```
`demo-tour.js:31` highlights `.fs-kpi-strip`, and that selector still matches.

- [ ] **Step 4: Run tests**

Run: `node --check scripts/composites/kpi-strip.js && node --check scripts/pages/timeline.js && node --test tests/timeline-stat-strip.test.js tests/timeline-recording-kpis.test.js`
Expected: PASS. Mutation check: remove `{ compact: true }` from timeline.js. The wiring pin should go red. Then revert.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # timeline.js 1, kpi-strip.js ~10, composites.css ~11, components-preview.html ~8
git add scripts/composites/kpi-strip.js scripts/pages/timeline.js styles/composites.css components-preview.html tests/timeline-stat-strip.test.js
git commit -m "Compact one-line stat strip on the Timeline day header

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 3: `FS.events` transport (spec §5)

**Files:**
- Create: `scripts/api/events.js`
- Modify: `app-shell-preview.html` — add a tag right after `scripts/api/actions-bus.js?v=2` (line 238), i.e. after `api/index.js` (line 194)
- Test: `tests/events.test.js` (create)

**Interfaces:**
- Produces:
  - `window.FS.events.on(name: string, fn: (payload) => void) → off: () => void`
  - `window.FS.events.emit(name: string, payload: any) → void` (subscriber exceptions are caught and logged)
  - `window.FS.events.onContentEdited(table: string, id: string, fn: (payload) => void) → off` — subscribes to `content:edited` and calls `fn` only when `payload.table === table && String(payload.id) === String(id)`. This is the single matching rule used by `TodoHistory` (Task 9) and `ContentHistoryPanel` (Task 10).
  - Under Node: `module.exports = { createEvents }`, where `createEvents()` returns a fresh `{on, emit, onContentEdited}`.

Why not `FS.actionsBus`: every existing subscriber assumes the check-off payload (`today.js` ~1384 and `tasks.js` ~271 bail on `!payload.checked`; `timeline.js` ~1159/2033/4063 key on `payload.date`).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = { FS: {} };
const { createEvents } = require('../scripts/api/events.js');

test('require registers window.FS.events', () => {
  assert.strictEqual(typeof window.FS.events.on, 'function');
  assert.strictEqual(typeof window.FS.events.emit, 'function');
});

test('on/emit delivers payloads by name, off unsubscribes', () => {
  const ev = createEvents();
  const got = [];
  const off = ev.on('a', (p) => got.push(p));
  ev.on('b', () => got.push('wrong'));
  ev.emit('a', 1);
  off();
  ev.emit('a', 2);
  assert.deepStrictEqual(got, [1]);
});

test('a throwing subscriber does not stop the others', () => {
  const ev = createEvents();
  const got = [];
  const origError = console.error; console.error = () => {};
  ev.on('a', () => { throw new Error('x'); });
  ev.on('a', (p) => got.push(p));
  ev.emit('a', 'ok');
  console.error = origError;
  assert.deepStrictEqual(got, ['ok']);
});

test('onContentEdited fires only for the same table and id', () => {
  const ev = createEvents();
  let n = 0;
  ev.onContentEdited('action_items', 'ai-1', () => { n++; });
  ev.emit('content:edited', { table: 'action_items', id: 'ai-1' });
  ev.emit('content:edited', { table: 'action_items', id: 'ai-2' });
  ev.emit('content:edited', { table: 'topics', id: 'ai-1' });
  ev.emit('content:edited', null);
  assert.strictEqual(n, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/events.test.js`
Expected: FAIL — `Cannot find module '../scripts/api/events.js'`.

- [ ] **Step 3: Implement** `scripts/api/events.js`

```js
/* ==========================================================================
   FieldSight · FS.events — named pub/sub (spec 2026-09-15 §5)
   --------------------------------------------------------------------------
   Separate from FS.actionsBus on purpose: every actionsBus subscriber assumes
   the check-off payload shape. Events published here:
     content:edited  { table, id }  — emitted only by FS.api.actions.settleSave

   Public API:
     FS.events.on(name, fn)                 -> off()
     FS.events.emit(name, payload)
     FS.events.onContentEdited(table, id, fn) -> off()
   Loaded after api/index.js in app-shell-preview.html.
   ========================================================================== */

(function () {
  'use strict';

  function createEvents() {
    var byName = {};

    function on(name, fn) {
      if (!byName[name]) byName[name] = new Set();
      byName[name].add(fn);
      return function off() { byName[name].delete(fn); };
    }

    function emit(name, payload) {
      var subs = byName[name];
      if (!subs) return;
      Array.from(subs).forEach(function (fn) {
        try { fn(payload); }
        catch (e) { console.error('[FS.events]', name, e); }
      });
    }

    function onContentEdited(table, id, fn) {
      return on('content:edited', function (p) {
        if (!p || p.table !== table || String(p.id) !== String(id)) return;
        fn(p);
      });
    }

    return { on: on, emit: emit, onContentEdited: onContentEdited };
  }

  if (!window.FS) window.FS = {};
  window.FS.events = createEvents();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createEvents: createEvents };
  }
})();
```

`app-shell-preview.html`, after line 238 (`actions-bus.js`):
```html
  <!-- FS.events — content:edited after a save (spec 2026-09-15 §5). After api/index.js. -->
  <script src="scripts/api/events.js?v=1"></script>
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/api/events.js && node --test tests/events.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git diff --stat
git add scripts/api/events.js app-shell-preview.html tests/events.test.js
git commit -m "Add FS.events named pub/sub for content:edited

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 4: `settleSave` — one function decides a save's outcome (spec §4, test 8)

**Files:**
- Modify: `scripts/api/actions.js` — add the function before `window.FS.api.actions = {` (line 627), register it there, and export it in `module.exports` (line 661)
- Test: `tests/save-settlement.test.js` (create)

**Interfaces:**
- Consumes: `window.FS.toast.show(opts)`, `window.FS.events.emit(name, payload)` (Task 3), both read at call time and both optional.
- Produces: `FS.api.actions.settleSave(res, {table, id}) → {ok: boolean}`. `ok` is true only when `res` is truthy with no `_accessDenied`, `_notFound` or `error`. When `ok` is true it shows the `Saved` toast and emits `content:edited {table, id}`; otherwise it does nothing.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

let toasts, emits;
function load() {
  toasts = []; emits = [];
  global.window = {
    FieldSight: { fixtures: { actions: {} } },
    FS: {
      api: { useMocks: true, writeMocks: true, delay: () => Promise.resolve() },
      toast:  { show: (t) => toasts.push(t) },
      events: { emit: (name, p) => emits.push({ name, p }) },
    },
  };
  delete require.cache[require.resolve('../scripts/api/actions.js')];
  return require('../scripts/api/actions.js');
}

const TARGET = { table: 'action_items', id: 'ai-1' };

test('8a: a resolved row settles ok, one Saved toast, one content:edited', () => {
  const { settleSave } = load();
  assert.deepStrictEqual(settleSave({ id: 'ai-1', deadline: '2026-09-19' }, TARGET), { ok: true });
  assert.deepStrictEqual(toasts, [{ message: 'Saved', tone: 'success', duration: 2000 }]);
  assert.deepStrictEqual(emits, [{ name: 'content:edited', p: { table: 'action_items', id: 'ai-1' } }]);
});

for (const [label, res] of [
  ['_accessDenied', { _accessDenied: true, error: 'nope' }],
  ['_notFound',     { _notFound: true }],
  ['{error}',       { error: 'bad' }],
  ['undefined',     undefined],
]) {
  test('8b: ' + label + ' settles not ok, no toast, no emit', () => {
    const { settleSave } = load();
    assert.deepStrictEqual(settleSave(res, TARGET), { ok: false });
    assert.strictEqual(toasts.length, 0);
    assert.strictEqual(emits.length, 0);
  });
}

test('8c: settleSave works when toast and events are not loaded', () => {
  const { settleSave } = load();
  delete window.FS.toast; delete window.FS.events;
  assert.deepStrictEqual(settleSave({ row: {} }, TARGET), { ok: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/save-settlement.test.js`
Expected: FAIL — `settleSave is not a function`.

- [ ] **Step 3: Implement** in `scripts/api/actions.js`, before `window.FS.api.actions = {`

```js
  /* spec 2026-09-15 §4 — the ONE place a field-editor save is judged.
     Returns {ok}. ok === true only for a resolved, non-denied, non-error
     envelope. On ok: shows the 'Saved' toast and emits content:edited
     {table, id} (FS.events). On !ok: does nothing, and the caller keeps its
     own existing failure handling. A thrown save never reaches here (callers'
     .catch paths are unchanged). Call pattern:
       if (!api.settleSave(res, {table, id}).ok) { ...existing failure... } */
  function settleSave(res, target) {
    var ok = !!res && !res._accessDenied && !res._notFound && !res.error;
    if (!ok) return { ok: false };
    var toast = window.FS && window.FS.toast;
    if (toast) toast.show({ message: 'Saved', tone: 'success', duration: 2000 });
    var events = window.FS && window.FS.events;
    if (events && target) events.emit('content:edited', { table: target.table, id: target.id });
    return { ok: true };
  }
```
Register it in the object, after `getContentHistory: getContentHistory,`:
```js
    settleSave:      settleSave,
```
Export it in `module.exports`:
```js
      settleSave:               settleSave,
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/api/actions.js && node --test tests/save-settlement.test.js tests/checkoff-org-api.test.js`
Expected: PASS. Mutation check: change `!res._accessDenied` to `true`. Test 8b `_accessDenied` should go red. Then revert.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # actions.js ~20 lines
git add scripts/api/actions.js tests/save-settlement.test.js
git commit -m "Add settleSave: one Saved toast and content:edited per successful save

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 5: Call `settleSave` at exactly four sites, plus an `assignTo` error toast (spec §4, test 9)

**Files:**
- Modify: `scripts/pages/timeline.js` `EditableText.commit` (~3372-3386); `assignTo` (~3585-3601)
- Modify: `scripts/pages/today.js` `commitTaskField` (~2777-2788)
- Modify: `scripts/pages/tasks.js` `commitRowField` (~968-979)
- Test: append to `tests/save-settlement.test.js`

**Interfaces:**
- Consumes: `window.FS.api.actions.settleSave` (Task 4).

- [ ] **Step 1: Write the failing wiring pin** (append to `tests/save-settlement.test.js`)

```js
/* ---- 9: SOURCE SCAN (wiring pin), not a behaviour test --------------------
   The four field-editor save sites each call settleSave(; Today's title
   editor mounts timeline.js's EditableText and must NOT add its own call
   (that would double the toast). */
const fs = require('node:fs');
const path = require('node:path');
const page = (f) => fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', f), 'utf8').replace(/\r\n/g, '\n');

function block(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, 'marker not found: ' + startMarker);
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, 'end marker not found after: ' + startMarker);
  return src.slice(s, e);
}

test('9: timeline EditableText.commit calls settleSave before the glossary early return', () => {
  const b = block(page('timeline.js'), 'function EditableText(', 'function cancel()');
  const call = b.indexOf('settleSave(');
  assert.ok(call > 0);
  assert.ok(call < b.indexOf('props.showGlossaryConfirm && res.candidates'));
});

test('9: timeline assignTo calls settleSave', () => {
  assert.match(block(page('timeline.js'), 'function assignTo(', 'var rosterRef'), /settleSave\(/);
});

test('9: today commitTaskField calls settleSave', () => {
  assert.match(block(page('today.js'), 'function commitTaskField(', 'var fieldsEditable'), /settleSave\(/);
});

test('9: tasks commitRowField calls settleSave', () => {
  assert.match(block(page('tasks.js'), 'function commitRowField(', '\n    }\n'), /settleSave\(/);
});

test('9: today title editor block does not call settleSave', () => {
  const b = block(page('today.js'), 'feat/today-title-edit — mounts window.FieldSight.EditableText', "item.kind === 'urgent'");
  assert.doesNotMatch(b, /settleSave\(/);
});

test('9: exactly these four call sites exist in pages/', () => {
  const n = ['timeline.js', 'today.js', 'tasks.js']
    .map((f) => (page(f).match(/settleSave\(/g) || []).length)
    .reduce((a, b) => a + b, 0);
  assert.strictEqual(n, 4);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/save-settlement.test.js`
Expected: the five `9:` site tests FAIL (no `settleSave(`); the title-editor test passes.

- [ ] **Step 3: Implement the four sites**

Site 1, `timeline.js` `EditableText.commit`: replace
```js
        if (!res || res._accessDenied || res._notFound) {
          setValue(props.value || '');
```
with
```js
        /* spec 2026-09-15 §4 site 1 — also covers Today's title editor, which
           mounts this same component (no call in today.js for the title). */
        if (!window.FS.api.actions.settleSave(res, { table: props.table, id: props.id }).ok) {
          setValue(props.value || '');
```
(Leave the rest of the failure block and the glossary branch unchanged. The call now runs before `props.showGlossaryConfirm && res.candidates`.)

Site 4, `timeline.js` `assignTo`: replace the `.then(…)` and `.catch(…)` bodies with
```js
      api.updateAction(a.id, { responsible: name }).then(function (res) {
        /* 403/404 resolve to envelopes rather than throwing (org.js write
           convention). spec 2026-09-15 §4 site 4: Saved on ok, error toast
           (site 2's shape) on refusal, never a silent revert. */
        if (!api.settleSave(res, { table: 'action_items', id: a.id }).ok) {
          setOwners(function (m) { var n = Object.assign({}, m); n[a.id] = before; return n; });
          var toast = window.FS && window.FS.toast;
          if (toast) toast.show({ message: (res && res.error) || 'Could not update task', tone: 'error', duration: 5000 });
        }
      }).catch(function (err) {
        setOwners(function (m) { var n = Object.assign({}, m); n[a.id] = before; return n; });
        var toast = window.FS && window.FS.toast;
        if (toast) toast.show({ message: (err && err.error) || 'Could not update task', tone: 'error', duration: 5000 });
      });
```

Site 2, `today.js` `commitTaskField` (~2777): replace
```js
        if (!res || res._accessDenied || res._notFound) {
```
with
```js
        if (!api.settleSave(res, { table: 'action_items', id: item.actionItemId }).ok) {
```

Site 3, `tasks.js` `commitRowField` (~968): replace
```js
        if (!res || res._accessDenied || res._notFound) {
```
with
```js
        if (!api.settleSave(res, { table: 'action_items', id: row.actionItemId }).ok) {
```

Replace only the single-line condition at sites 2 and 3, to keep the CRLF diff small.

- [ ] **Step 4: Run tests**

Run: `node --check scripts/pages/timeline.js && node --check scripts/pages/today.js && node --check scripts/pages/tasks.js && node --test tests/*.test.js`
Expected: full suite PASS. Mutation check: delete the site-3 call. `9: tasks commitRowField` and `exactly these four` should go red. Then revert.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # timeline.js ~15, today.js 1, tasks.js 1, test ~50
git add scripts/pages/timeline.js scripts/pages/today.js scripts/pages/tasks.js tests/save-settlement.test.js
git commit -m "Acknowledge field saves via settleSave at the four editor sites

Timeline assignTo now also toasts on refusal instead of silently reverting.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 6: `getSessionsCached` and the Timeline day fetch switched to it (spec §3.1)

**Files:**
- Modify: `scripts/api/org.js` — add after `getSessions` (starts at 468), register in `window.FS.api.org` (after `getSessions: getSessions,` at 840)
- Modify: `scripts/pages/timeline.js:1791`
- Test: `tests/sessions-cached.test.js` (create)

**Interfaces:**
- Consumes: `window.FS.api.cache.cached(key, ttlMs, fetchFn)` (`scripts/api/_cache.js`, loaded before org.js at `app-shell-preview.html:197`).
- Produces: `FS.api.org.getSessionsCached(date: string, folder: string) → Promise<{sessions: [...]} | envelope>`, cache key `'sessions:' + date + ':' + folder`.

Today's `_sessionsFor(date)` (`today.js:415`) calls `getSessions({date})` with no user. That is a different key; leave it unchanged.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let requests;
function load() {
  requests = [];
  global.window = {
    FieldSight: {},
    FS: {
      api: {
        useMocks: false, timelineSource: 'aurora', orgBaseUrl: 'https://org.example/api',
        delay: () => Promise.resolve(),
        orgRequest: (p, opts) => {
          requests.push({ path: p, params: opts && opts.params });
          return Promise.resolve({ sessions: [{ session_id: 'S1', started_at: '2026-09-03T09:00:00+12:00', title: 'Site meeting' }] });
        },
      },
    },
  };
  for (const m of ['../scripts/api/_cache.js', '../scripts/api/org.js']) {
    delete require.cache[require.resolve(m)];
    require(m);
  }
  return window.FS.api.org;
}
const sessionCalls = () => requests.filter((r) => r.path === '/sessions').length;

test('getSessionsCached: same (date, folder) twice -> one /sessions request', async () => {
  const org = load();
  const [a, b] = await Promise.all([
    org.getSessionsCached('2026-09-03', 'Ben_UCPK2'),
    org.getSessionsCached('2026-09-03', 'Ben_UCPK2'),
  ]);
  await org.getSessionsCached('2026-09-03', 'Ben_UCPK2');
  assert.strictEqual(sessionCalls(), 1);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(requests[0].params, { date: '2026-09-03', user: 'Ben_UCPK2' });
});

test('getSessionsCached: a different owner is a different key', async () => {
  const org = load();
  await org.getSessionsCached('2026-09-03', 'Ben_UCPK2');
  await org.getSessionsCached('2026-09-03', 'Sarah_Chen');
  assert.strictEqual(sessionCalls(), 2);
});

/* SOURCE SCAN (wiring pin): Timeline's day-level sessions fetch uses the
   cached read, so expanding a card after the day loaded makes zero requests. */
test('timeline day fetch uses getSessionsCached(date, folder)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'timeline.js'), 'utf8');
  assert.match(src, /org\.getSessionsCached\(date, folder\)/);
  assert.doesNotMatch(src, /org\.getSessions\(\{ date: date, user: folder \}\)/);
});
```

If `require('../scripts/api/org.js')` throws at load because of a missing stub, add that stub to `window.FS.api` (org.js only defines functions at load; `api` is captured at line 18).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/sessions-cached.test.js`
Expected: FAIL — `org.getSessionsCached is not a function`; wiring pin fails.

- [ ] **Step 3: Implement**

`scripts/api/org.js`, directly after the closing `}` of `getSessions`:
```js
  /* spec 2026-09-15 §3.1 — ONE cached sessions read per (date, owner folder),
     shared by Timeline's day view and every TodoHistory card, so expanding a
     card on a day that already loaded sessions issues zero requests. */
  function getSessionsCached(date, folder) {
    return api.cache.cached('sessions:' + date + ':' + folder, undefined, function () {
      return getSessions({ date: date, user: folder });
    });
  }
```
Register it: after `getSessions: getSessions,` add
```js
    getSessionsCached: getSessionsCached,
```
`scripts/pages/timeline.js:1791`:
```js
      window.FS.api.org.getSessionsCached(date, folder).then(function (res) {
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/api/org.js && node --check scripts/pages/timeline.js && node --test tests/sessions-cached.test.js tests/session-picker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # org.js ~10, timeline.js 1
git add scripts/api/org.js scripts/pages/timeline.js tests/sessions-cached.test.js
git commit -m "Share one cached sessions read per day and owner

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 7: Fixture `session_kind`, a report-sourced topic, `version`, and a history mock that agrees (spec §3.3, §8.1)

**Files:**
- Modify: `scripts/mock/daily-report.fixture.js` — topic 3 of `REPORT_2026_04_29_JARLEY` (literal at ~254); action items `cd155836…` (~148) and `55c48cd4…` (~155); stamping loop (640-651)
- Modify: `scripts/api/actions.js` `getContentHistory` mock branch (523-524)
- Test: `tests/fixture-provenance-and-version.test.js` (create)

**Interfaces:**
- Produces (mock data): every fixture topic has `session_kind` (`'extraction'`, or `'report'` with `session_id: null`); every action item has a numeric `version` (default 1; `cd155836-49f7-44d7-8b7e-e36505140733` is 2, `55c48cd4-b3e5-43d8-8a5e-7991fbc1998f` is 3).
- Produces (mock API): under mocks, `getContentHistory('action_items', id)` returns `version - 1` synthetic edits for a fixture item, so the §3.4 rule "history wins" does not reset the offline chip to `v1`. This follows CLAUDE.md: a read stub should serve the day's own fixture.

Topic choice: topic 3 on 2026-04-29 (`topic_row_id 7d0c0003-…`) has two action items, so the report provenance state is visible on a to-do. Before editing, run `grep -n "2026-04-29" tests/*.js`. The tests that load this fixture (`day-photos-are-not-only-the-bound-ones`, `programme-mentions-contract`, `mentioned-dates`) read photos and topics, not sessions, and the full suite in Step 4 confirms this.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = { FieldSight: {}, FS: { api: { useMocks: true, writeMocks: true, delay: () => Promise.resolve() } } };
require('../scripts/mock/daily-report.fixture.js');
const actions = (() => { require('../scripts/api/actions.js'); return window.FS.api.actions; })();

const reports = window.FieldSight.fixtures.reports;
const allTopics = Object.values(reports).flatMap((byUser) => Object.values(byUser)).flatMap((r) => r.topics || []);

test('every fixture topic carries a session_kind', () => {
  for (const t of allTopics) assert.ok(['extraction', 'report'].includes(t.session_kind), JSON.stringify(t.topic_title));
});

test('exactly the report-kind topics have a null session_id, and there is at least one', () => {
  const report = allTopics.filter((t) => t.session_kind === 'report');
  assert.ok(report.length >= 1);
  for (const t of report) assert.strictEqual(t.session_id, null);
  for (const t of allTopics.filter((x) => x.session_kind === 'extraction')) assert.ok(t.session_id);
});

test('action items carry version: default 1, one 2, one 3', () => {
  const items = allTopics.flatMap((t) => t.action_items || []);
  for (const a of items) assert.strictEqual(typeof a.version, 'number');
  assert.strictEqual(items.filter((a) => a.version === 2).length, 1);
  assert.strictEqual(items.filter((a) => a.version === 3).length, 1);
});

test('mock history for a fixture action item returns version-1 edits, newest first', async () => {
  const res = await actions.getContentHistory('action_items', '55c48cd4-b3e5-43d8-8a5e-7991fbc1998f');
  assert.strictEqual(res.edits.length, 2);
  assert.ok(res.edits[0].created_at > res.edits[1].created_at);
  assert.deepStrictEqual((await actions.getContentHistory('action_items', 'not-in-fixture')).edits, []);
  assert.deepStrictEqual((await actions.getContentHistory('topics', '7d0c0000-0429-4a29-9b00-000000000000')).edits, []);
});
```

If the fixture file needs `window.FieldSight.fixtures` pre-created, copy the harness lines from `tests/day-photos-are-not-only-the-bound-ones.test.js`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/fixture-provenance-and-version.test.js`
Expected: FAIL — `session_kind` is undefined; `version` is not a number; the mock returns `[]`.

- [ ] **Step 3: Implement**

Fixture, topic 3 literal (after `topic_row_id: '7d0c0003-0429-4a29-9b00-000000000003',`):
```js
        /* Report-sourced topic (spec 2026-09-15 §3.3): no session, no time. */
        session_id:   null,
        session_kind: 'report',
```
Action item `cd155836-…`: add `version:     2,` after its `priority`. Action item `55c48cd4-…`: add `version:     3,`.

Stamping loop body (replace lines 644-649):
```js
      (rep.topics || []).forEach(function (t) {
        if (t.session_kind === 'report') return;        // report-sourced: never gets a session
        if (!t.session_id) {
          var start = String(t.time_range || '').split(EN)[0].trim() || '00:00';
          t.session_id = (rep.device || 'Benl1') + '_' + (rep.report_date || date)
            + '_' + start.replace(/:/g, '-') + '-00';
        }
        if (!t.session_kind) t.session_kind = 'extraction';
        /* spec §8.1 — version = 1 + content_edits rows; mocks default to 1. */
        (t.action_items || []).forEach(function (a) { if (a.version == null) a.version = 1; });
      });
```
`scripts/api/actions.js`, replace the mock tail of `getContentHistory`:
```js
    await window.FS.api.delay(40);
    return { edits: table === 'action_items' ? mockActionEdits(id) : [] };
  }

  /* Mock read serves the fixture's own data (CLAUDE.md "a read stub should
     serve the day's own fixture"): an item stamped version N gets N-1
     priority edits, newest first, so opening it under mocks agrees with its
     chip instead of resetting it to v1 (spec 2026-09-15 §3.4/§8.3). */
  function mockActionEdits(id) {
    var reports = (((window.FieldSight || {}).fixtures || {}).reports) || {};
    var version = 1;
    Object.keys(reports).forEach(function (d) {
      Object.keys(reports[d]).forEach(function (f) {
        (reports[d][f].topics || []).forEach(function (t) {
          (t.action_items || []).forEach(function (a) { if (a.id === id && a.version) version = a.version; });
        });
      });
    });
    var edits = [];
    for (var k = version - 1; k >= 1; k--) {
      edits.push({
        id: 'mock-edit-' + id + '-' + k, field: 'priority',
        before_text: k % 2 ? 'medium' : 'high', after_text: k % 2 ? 'high' : 'medium',
        actor_name: 'Jack Gibson', created_at: '2026-04-29T0' + k + ':00:00+00:00',
      });
    }
    return edits;
```
(The closing `}` of `mockActionEdits` is the one that previously closed `getContentHistory`. Check with `node --check`.)

- [ ] **Step 4: Run tests**

Run: `node --check scripts/mock/daily-report.fixture.js && node --check scripts/api/actions.js && node --test tests/*.test.js`
Expected: full suite PASS. If a session-count assertion on 2026-04-29 fails, move `session_kind: 'report'` to a topic whose day has no such assertion, and record which in the commit message.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # fixture ~15, actions.js ~25
git add scripts/mock/daily-report.fixture.js scripts/api/actions.js tests/fixture-provenance-and-version.test.js
git commit -m "Fixture: session_kind, a report-sourced topic, and action item versions

Mock content history serves version-1 edits so offline chips stay consistent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 8: TodoHistory pure helpers — provenance, numbering, request decisions (spec §3.2–§3.4, tests 1–7)

**Files:**
- Create: `scripts/composites/todo-history.js` (helpers only in this task; the component is added in Task 9)
- Test: `tests/todo-history.test.js` (create)

**Interfaces:**
- Consumes: `FS.api.org.getSessionsCached` (Task 6), `FS.api.actions.getContentHistory`.
- Produces (all on `module.exports`, and attached to `window.FieldSight.TodoHistory` in Task 9):
  - `formatWhen(iso) → string` — `'Wed 7:00 am'`, NZ time for zoned ISO, wall-clock for a naive ISO, `''` when unparseable
  - `formatDeadline(v) → string` — `'2026-09-18'` → `'Fri 18 Sep'`; non-ISO passes through
  - `provenanceFor({sessionId, sessionKind, sessionTitle?}, sessions) → null | {kind: 'extraction'|'report', text, time: string|null, sessionId: string|null}` (`sessionId` non-null only when the session is in `sessions`, i.e. linkable)
  - `fieldSentence(edit) → string` — `'deadline changed to Fri 18 Sep'`, `'status changed to done'`, `'responsible changed to Aaron'`, `'<field> cleared'`
  - `editedBy(edit) → 'edited by <name>' | 'edited by someone'`
  - `versionsFor(edits, currentText) → Array<{version, heading, body, isText, who, when}>` (`[]` when there are no edits)
  - `loadTodoHistory(props, deps?) → null | Promise<{sessions, edits}>` — `null` (and no calls) unless `props.open && props.actionItemId`
  - `modelFor(props, loaded) → {provenance, versions}`

- [ ] **Step 1: Write the failing tests** (`tests/todo-history.test.js`)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = { FieldSight: {}, FS: {} };
global.React = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Fragment: 'Fragment' };
const H = require('../scripts/composites/todo-history.js');

const SESSIONS = [{ session_id: 'Benl1_2026-04-29_07-00-00', started_at: '2026-04-29T07:00:00', ended_at: '2026-04-29T07:30:00', title: 'Morning Safety Briefing', topic_count: 1 }];

/* ---- 1: card spec acceptance 1-4 ---------------------------------------- */
test('1.1 extraction item: provenance shows title and start time, linkable', () => {
  assert.deepStrictEqual(
    H.provenanceFor({ sessionId: 'Benl1_2026-04-29_07-00-00', sessionKind: 'extraction' }, SESSIONS),
    { kind: 'extraction', text: 'From Morning Safety Briefing', time: 'Wed 7:00 am', sessionId: 'Benl1_2026-04-29_07-00-00' });
});
test('1.2 report item: From the daily report, no time, no link', () => {
  assert.deepStrictEqual(H.provenanceFor({ sessionId: null, sessionKind: 'report' }, SESSIONS),
    { kind: 'report', text: 'From the daily report', time: null, sessionId: null });
});
test('1.2b extraction id missing from sessions: no time, no link', () => {
  const p = H.provenanceFor({ sessionId: 'gone', sessionKind: 'extraction' }, SESSIONS);
  assert.strictEqual(p.time, null);
  assert.strictEqual(p.sessionId, null);
});
test('1.3 no edits: no version block', () => {
  assert.deepStrictEqual(H.versionsFor([], 'Order boards'), []);
});
test('1.4 history 404 loads identically to an empty list', async () => {
  const deps = (hist) => ({ org: { getSessionsCached: async () => ({ sessions: SESSIONS }) }, actions: { getContentHistory: async () => hist } });
  const props = { open: true, actionItemId: 'ai-1', sessionId: 'Benl1_2026-04-29_07-00-00', sessionKind: 'extraction', date: '2026-04-29', folder: 'Jarley_Trainor', currentText: 'Order boards' };
  const a = H.modelFor(props, await H.loadTodoHistory(props, deps({ _notFound: true })));
  const b = H.modelFor(props, await H.loadTodoHistory(props, deps({ edits: [] })));
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a.versions, []);
});

/* ---- 2: fourth provenance state ----------------------------------------- */
test('2 unknown or absent kind with a null id: no provenance line', () => {
  assert.strictEqual(H.provenanceFor({ sessionId: null, sessionKind: 'unknown' }, SESSIONS), null);
  assert.strictEqual(H.provenanceFor({ sessionId: null }, SESSIONS), null);
  assert.strictEqual(H.provenanceFor({}, []), null);
});

/* ---- 3: open:false makes no request ------------------------------------- */
test('3 open:false for N hosts: neither getSessions nor getContentHistory called', () => {
  let calls = 0;
  const deps = { org: { getSessionsCached: () => { calls++; return Promise.resolve({}); } },
                 actions: { getContentHistory: () => { calls++; return Promise.resolve({}); } } };
  for (let i = 0; i < 35; i++) {
    assert.strictEqual(H.loadTodoHistory({ open: false, actionItemId: 'ai-' + i, sessionId: 's', date: 'd', folder: 'f' }, deps), null);
  }
  assert.strictEqual(H.loadTodoHistory({ open: true, actionItemId: null }, deps), null, 'legacy row: nothing');
  assert.strictEqual(calls, 0);
});

/* ---- 4: one sessions request per (date, folder), zero after Timeline ---- */
function loadRealApi() {
  const requests = [];
  global.window = { FieldSight: {}, FS: { api: {
    useMocks: false, timelineSource: 'aurora', orgBaseUrl: 'https://org.example/api', delay: () => Promise.resolve(),
    orgRequest: (p) => { requests.push(p); return Promise.resolve(p === '/sessions' ? { sessions: SESSIONS } : { edits: [] }); },
  } } };
  for (const m of ['../scripts/api/_cache.js', '../scripts/api/org.js']) { delete require.cache[require.resolve(m)]; require(m); }
  const deps = { org: window.FS.api.org, actions: { getContentHistory: () => { requests.push('/history'); return Promise.resolve({ edits: [] }); } } };
  return { requests, deps };
}
const OPEN = { open: true, actionItemId: 'ai-1', sessionId: 'Benl1_2026-04-29_07-00-00', sessionKind: 'extraction', date: '2026-04-29', folder: 'Jarley_Trainor' };

test('4a two opens with the same (date, folder): one sessions request', async () => {
  const { requests, deps } = loadRealApi();
  await H.loadTodoHistory(OPEN, deps);
  await H.loadTodoHistory(Object.assign({}, OPEN, { actionItemId: 'ai-2' }), deps);
  assert.strictEqual(requests.filter((r) => r === '/sessions').length, 1);
  assert.strictEqual(requests.filter((r) => r === '/history').length, 2, 'history is not cached');
});
test('4b after the Timeline day fetch populated the key, an open makes zero sessions requests', async () => {
  const { requests, deps } = loadRealApi();
  await window.FS.api.org.getSessionsCached('2026-04-29', 'Jarley_Trainor');   // what timeline.js:1791 now does
  const before = requests.filter((r) => r === '/sessions').length;
  await H.loadTodoHistory(OPEN, deps);
  assert.strictEqual(requests.filter((r) => r === '/sessions').length - before, 0);
});

/* ---- 5: {_notFound} = empty, no toast ------------------------------------ */
test('5 {_notFound} history: same output as empty, no toast', async () => {
  const toasts = [];
  global.window = { FieldSight: {}, FS: { toast: { show: (t) => toasts.push(t) } } };
  const deps = { org: {}, actions: { getContentHistory: async () => ({ _notFound: true }) } };
  const loaded = await H.loadTodoHistory({ open: true, actionItemId: 'ai-1' }, deps);
  assert.deepStrictEqual(loaded, { sessions: [], edits: [] });
  assert.strictEqual(toasts.length, 0);
});

/* ---- 6: NULL actor_name ------------------------------------------------- */
test('6 NULL actor_name renders edited by someone', () => {
  assert.strictEqual(H.editedBy({ actor_name: null }), 'edited by someone');
  assert.strictEqual(H.editedBy({ actor_name: 'Ben_UCPK2' }), 'edited by Ben_UCPK2');
  assert.strictEqual(H.versionsFor([{ field: 'status', after_text: 'done', actor_name: null }], 'x')[0].who, 'edited by someone');
});

/* ---- 7: §3.4 numbering -------------------------------------------------- */
test('7a edits [text, deadline, status] newest first -> v4..v2 then v1 as recorded', () => {
  const edits = [
    { field: 'text',     before_text: 'Book crane Wed', after_text: 'Book crane Thu', actor_name: 'A', created_at: '2026-09-15T03:00:00+00:00' },
    { field: 'deadline', before_text: null, after_text: '2026-09-18', actor_name: 'A', created_at: '2026-09-15T02:00:00+00:00' },
    { field: 'status',   before_text: 'open', after_text: 'done', actor_name: 'A', created_at: '2026-09-15T01:00:00+00:00' },
  ];
  const v = H.versionsFor(edits, 'Book crane Thu');
  assert.deepStrictEqual(v.map((x) => [x.heading, x.body]), [
    ['v4', 'Book crane Thu'],
    ['v3', 'deadline changed to Fri 18 Sep'],
    ['v2', 'status changed to done'],
    ['v1 · as recorded', 'Book crane Wed'],
  ]);
});
test('7b no text edit: v1 shows the current text', () => {
  const v = H.versionsFor([{ field: 'priority', after_text: 'high', actor_name: 'A' }], 'Order boards');
  assert.deepStrictEqual(v.map((x) => [x.heading, x.body]), [['v2', 'priority changed to high'], ['v1 · as recorded', 'Order boards']]);
});
test('7c v1 uses the OLDEST text edit before_text when there are several', () => {
  const v = H.versionsFor([
    { field: 'text', before_text: 'B', after_text: 'C' },
    { field: 'text', before_text: 'A', after_text: 'B' },
  ], 'C');
  assert.strictEqual(v[v.length - 1].body, 'A');
});
test('7d responsible edits from either endpoint read the same', () => {
  assert.strictEqual(H.fieldSentence({ field: 'responsible', after_text: 'Aaron' }), 'responsible changed to Aaron');
  assert.strictEqual(H.fieldSentence({ field: 'deadline', after_text: null }), 'deadline cleared');
});
test('formatWhen: zoned ISO is shown in NZ time', () => {
  assert.strictEqual(H.formatWhen('2026-09-15T22:23:00Z'), 'Wed 10:23 am');   // NZST +12
  assert.strictEqual(H.formatWhen(''), '');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/todo-history.test.js`
Expected: FAIL — `Cannot find module '../scripts/composites/todo-history.js'`.

- [ ] **Step 3: Implement** `scripts/composites/todo-history.js` (helpers plus the export footer; Task 9 adds the components above the footer)

```js
/* ==========================================================================
   FieldSight TodoHistory — Layer 5 composite
   --------------------------------------------------------------------------
   A to-do's provenance line and version list (docs/specs/2026-08-30-todo-
   history-card.md §2-3, numbering REPLACED by docs/specs/2026-09-15-todo-
   card-history-and-save-feedback.md §3.4). Not the CURRENT line — each host
   already renders that.

   Props:
     actionItemId  durable action_items.id; absent -> render/fetch nothing
     sessionId, sessionKind  from the owning topic
     date, folder  the report OWNER's day and folder (never the caller's)
     open          host-owned; NO request of any kind while false
     currentText   the to-do's current text (v1 when text was never edited)
     onVersion     (n) => void, optional — authoritative 1 + edits.length

   Exported to window.FieldSight.TodoHistory (helpers attached as statics).
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var NZ = 'Pacific/Auckland';

  function partsOf(fmt, d) {
    var p = {};
    fmt.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }

  /* 'Wed 7:00 am'. A zoned ISO is converted to NZ time; a naive ISO (the mock
     sessions) is already NZ wall-clock and is formatted as-is. */
  function formatWhen(iso) {
    if (!iso) return '';
    var s = String(iso).replace(' ', 'T');
    var zoned = /(Z|[+-]\d\d:?\d\d)$/.test(s);
    var d;
    if (zoned) {
      d = new Date(s);
    } else {
      var m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
      if (!m) return '';
      d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    }
    if (isNaN(d.getTime())) return '';
    var p = partsOf(new Intl.DateTimeFormat('en-NZ', {
      timeZone: zoned ? NZ : 'UTC', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    }), d);
    return p.weekday + ' ' + p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toLowerCase();
  }

  /* '2026-09-18' -> 'Fri 18 Sep' (calendar date, no time zone involved). */
  function formatDeadline(v) {
    var m = String(v).match(/^(\d{4})-(\d\d)-(\d\d)/);
    if (!m) return String(v);
    var p = partsOf(new Intl.DateTimeFormat('en-NZ', {
      timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
    }), new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
    return p.weekday + ' ' + p.day + ' ' + p.month;
  }

  /* Four states (spec §3.3): extraction found / extraction not in sessions /
     report / unknown-or-absent with a null id (-> null, no line at all). */
  function provenanceFor(topic, sessions) {
    topic = topic || {};
    var id = topic.sessionId || null;
    if (topic.sessionKind === 'report') {
      return { kind: 'report', text: 'From the daily report', time: null, sessionId: null };
    }
    if (!id) return null;
    var s = (sessions || []).filter(function (x) { return x && x.session_id === id; })[0];
    if (s) {
      return { kind: 'extraction', text: 'From ' + (s.title || 'a recording'),
               time: formatWhen(s.started_at) || null, sessionId: id };
    }
    /* Never fall back to time_range: it is LLM free text (card spec §2). */
    return { kind: 'extraction', text: topic.sessionTitle ? 'From ' + topic.sessionTitle : 'From a recording',
             time: null, sessionId: null };
  }

  function fieldSentence(edit) {
    var after = edit && edit.after_text;
    if (after == null || after === '') return edit.field + ' cleared';
    return edit.field + ' changed to ' + (edit.field === 'deadline' ? formatDeadline(after) : after);
  }

  function editedBy(edit) {
    return 'edited by ' + ((edit && edit.actor_name) || 'someone');
  }

  /* spec §3.4: version = 1 + number of content_edits rows, any field.
     Server order is newest first. */
  function versionsFor(edits, currentText) {
    var list = (edits || []).filter(Boolean);
    if (!list.length) return [];
    var n = list.length;
    var out = list.map(function (e, i) {
      var isText = e.field === 'text';
      return {
        version: n + 1 - i,
        heading: 'v' + (n + 1 - i),
        body:    isText ? (e.after_text || '') : fieldSentence(e),
        isText:  isText,
        who:     editedBy(e),
        when:    formatWhen(e.created_at),
      };
    });
    var oldestText = null;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].field === 'text') { oldestText = list[i]; break; }
    }
    out.push({
      version: 1, heading: 'v1 · as recorded',
      body: oldestText ? (oldestText.before_text || '') : (currentText || ''),
      isText: true, who: null, when: null,
    });
    return out;
  }

  function defaultDeps() {
    var api = window.FS && window.FS.api;
    return { org: api && api.org, actions: api && api.actions };
  }

  /* The request decision. Returns null — having called NOTHING — unless the
     host says open and the row has a durable id. History is never cached;
     sessions go through the shared cached read. 404/403 read as empty. */
  function loadTodoHistory(props, deps) {
    if (!props || !props.open || !props.actionItemId) return null;
    deps = deps || defaultDeps();
    if (!deps.actions || !deps.actions.getContentHistory) return null;
    var wantSessions = !!(props.sessionId && props.date && props.folder
                          && deps.org && deps.org.getSessionsCached);
    var sessionsP = wantSessions
      ? Promise.resolve(deps.org.getSessionsCached(props.date, props.folder)).then(function (r) {
          return (r && !r._accessDenied && !r._notFound && r.sessions) || [];
        }, function () { return []; })
      : Promise.resolve([]);
    var historyP = Promise.resolve(deps.actions.getContentHistory('action_items', props.actionItemId))
      .then(function (r) {
        return (r && !r._notFound && !r._accessDenied && Array.isArray(r.edits)) ? r.edits : [];
      }, function () { return []; });
    return Promise.all([sessionsP, historyP]).then(function (v) {
      return { sessions: v[0], edits: v[1] };
    });
  }

  function modelFor(props, loaded) {
    loaded = loaded || { sessions: [], edits: [] };
    return {
      provenance: provenanceFor({ sessionId: props.sessionId, sessionKind: props.sessionKind }, loaded.sessions),
      versions:   versionsFor(loaded.edits, props.currentText),
    };
  }

  /* ---- components are added here in Task 9 ---- */

  var helpers = {
    formatWhen: formatWhen, formatDeadline: formatDeadline, provenanceFor: provenanceFor,
    fieldSentence: fieldSentence, editedBy: editedBy, versionsFor: versionsFor,
    loadTodoHistory: loadTodoHistory, modelFor: modelFor,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
})();
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/composites/todo-history.js && node --test tests/todo-history.test.js`
Expected: PASS. If `formatWhen` returns `'Wed 7:00 am'` with a different `dayPeriod` casing or spacing on this ICU, fix the formatter rather than the expected string.
Mutation checks (revert each one):
- Remove `!props.open ||` from `loadTodoHistory`. Test 3 should go red.
- In `versionsFor`, count only `field === 'text'` edits. Test 7a should go red.

- [ ] **Step 5: Commit**

```bash
git add scripts/composites/todo-history.js tests/todo-history.test.js
git diff --cached --stat
git commit -m "TodoHistory helpers: four provenance states and any-field version numbering

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 9: TodoHistory component, refresh on `content:edited`, registration and showcase (spec §2, §5, test 10a)

**Files:**
- Modify: `scripts/composites/todo-history.js` (replace the `/* ---- components are added here in Task 9 ---- */` marker and the footer)
- Modify: `styles/composites.css` — new block after the ActionItemRow block (~after 940)
- Modify: `app-shell-preview.html` — tag before `action-item-row.js?v=9` (line 82)
- Modify: `components-preview.html` — tag after `kpi-strip.js` (line 99); add `TodoHistory` to the destructure (~line 152); new `<Section title="TodoHistory">` before the closing `</React.Fragment>` of the showcase (~1682)
- Test: append to `tests/todo-history.test.js`

**Interfaces:**
- Consumes: helpers from Task 8; `FS.events.onContentEdited` (Task 3); `FS.Router.navigate`.
- Produces: `window.FieldSight.TodoHistory(props)` (props as in the file header), with statics `TodoHistory.View({provenance, versions, onOpenMeeting?})`, `TodoHistory.provenanceFor`, `TodoHistory.versionsFor`, `TodoHistory.loadTodoHistory`.

- [ ] **Step 1: Write the failing tests** (append)

```js
/* ---- 10a: TodoHistory refreshes on a matching content:edited ------------- */
const fsx = require('node:fs');
const pathx = require('node:path');
const todoSrc = fsx.readFileSync(pathx.join(__dirname, '..', 'scripts', 'composites', 'todo-history.js'), 'utf8').replace(/\r\n/g, '\n');

test('10a SOURCE SCAN: TodoHistory subscribes via onContentEdited on its own id while open', () => {
  const b = todoSrc.slice(todoSrc.indexOf('function TodoHistory('));
  assert.match(b, /onContentEdited\('action_items', props\.actionItemId,/);
  assert.match(b, /if \(!props\.open \|\| !props\.actionItemId/);
});

test('10a matching id re-runs the loader, a different id does not (real FS.events)', async () => {
  const { createEvents } = require('../scripts/api/events.js');
  const ev = createEvents();
  let loads = 0;
  const reload = () => { loads++; };
  ev.onContentEdited('action_items', 'ai-1', reload);          // exactly what TodoHistory registers
  ev.emit('content:edited', { table: 'action_items', id: 'ai-2' });
  assert.strictEqual(loads, 0);
  ev.emit('content:edited', { table: 'action_items', id: 'ai-1' });
  assert.strictEqual(loads, 1);
});

test('TodoHistory statics exist on the window registration', () => {
  global.window = { FieldSight: {}, FS: {} };
  delete require.cache[require.resolve('../scripts/composites/todo-history.js')];
  require('../scripts/composites/todo-history.js');
  const T = window.FieldSight.TodoHistory;
  assert.strictEqual(typeof T, 'function');
  assert.strictEqual(typeof T.View, 'function');
  assert.strictEqual(typeof T.provenanceFor, 'function');
});

test('TodoHistory closed renders nothing without FS.api (components-preview posture)', () => {
  global.window = { FieldSight: {}, FS: {} };
  delete require.cache[require.resolve('../scripts/composites/todo-history.js')];
  require('../scripts/composites/todo-history.js');
  assert.strictEqual(window.FieldSight.TodoHistory({ open: false, actionItemId: 'x' }), null);
  assert.strictEqual(window.FieldSight.TodoHistory({ open: true }), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/todo-history.test.js`
Expected: the new tests FAIL — `function TodoHistory(` is not found, and `window.FieldSight.TodoHistory` is undefined.

- [ ] **Step 3: Implement**

Replace the Task 8 marker with:
```js
  function TodoHistoryView(props) {
    var h = React.createElement;
    var prov = props.provenance;
    var versions = props.versions || [];
    if (!prov && !versions.length) return null;
    return h('div', { className: 'fs-todo-history' },
      prov ? h('div', { className: 'fs-todo-history__provenance' },
        prov.text,
        prov.time ? ' · ' + prov.time : null,
        prov.sessionId && props.onOpenMeeting ? h(React.Fragment, null, ' · ',
          h('button', {
            type: 'button', className: 'fs-todo-history__link',
            onClick: function (e) { e.preventDefault(); e.stopPropagation(); props.onOpenMeeting(prov.sessionId); },
          }, 'open the meeting')) : null,
      ) : null,
      versions.length ? h('ol', { className: 'fs-todo-history__versions' },
        versions.map(function (v) {
          return h('li', { key: v.version, className: 'fs-todo-history__version' },
            h('div', { className: 'fs-todo-history__heading' },
              h('span', { className: 'fs-todo-history__tag' }, v.heading),
              v.when ? h('span', { className: 'fs-todo-history__when' }, v.when) : null),
            h('div', { className: 'fs-todo-history__body' + (v.isText ? '' : ' fs-todo-history__body--field') }, v.body),
            v.who ? h('div', { className: 'fs-todo-history__who' }, v.who) : null);
        })) : null,
    );
  }

  function TodoHistory(props) {
    var dataRef = React.useState({ status: 'idle', sessions: [], edits: [] });
    var data = dataRef[0], setData = dataRef[1];
    var tickRef = React.useState(0);
    var tick = tickRef[0], setTick = tickRef[1];
    var onVersionRef = React.useRef(props.onVersion);
    onVersionRef.current = props.onVersion;

    /* Fetch on each transition to open, and again after a matching save.
       Never append optimistically (card spec §5). */
    React.useEffect(function () {
      var p = loadTodoHistory(props);
      if (!p) { setData({ status: 'idle', sessions: [], edits: [] }); return undefined; }
      var alive = true;
      setData(function (d) { return d.status === 'ok' ? d : { status: 'loading', sessions: [], edits: [] }; });
      p.then(function (r) {
        if (!alive) return;
        setData({ status: 'ok', sessions: r.sessions, edits: r.edits });
        if (onVersionRef.current) onVersionRef.current(1 + r.edits.length);
      });
      return function () { alive = false; };
    }, [props.open, props.actionItemId, props.sessionId, props.date, props.folder, tick]);

    React.useEffect(function () {
      var events = window.FS && window.FS.events;
      if (!props.open || !props.actionItemId || !events || !events.onContentEdited) return undefined;
      return events.onContentEdited('action_items', props.actionItemId, function () {
        setTick(function (n) { return n + 1; });
      });
    }, [props.open, props.actionItemId]);

    if (!props.open || !props.actionItemId) return null;
    if (data.status !== 'ok') {
      return React.createElement('div', { className: 'fs-todo-history fs-todo-history--loading' }, 'Loading history…');
    }
    var model = modelFor(props, data);
    return React.createElement(TodoHistoryView, {
      provenance: model.provenance,
      versions:   model.versions,
      onOpenMeeting: function (sessionId) {
        var router = window.FS && window.FS.Router;
        if (!router) return;
        router.navigate('/timeline?date=' + encodeURIComponent(props.date)
          + '&user=' + encodeURIComponent(props.folder)
          + '&session=' + encodeURIComponent(sessionId));
      },
    });
  }
```
Important: the no-fetch guarantee lives in `loadTodoHistory` (tested by test 3). The hooks run before the `!props.open` return, so the hook order stays stable.

Note: the 10a source scan looks for `if (!props.open || !props.actionItemId` inside `TodoHistory`. The subscription effect contains `if (!props.open || !props.actionItemId || !events …`, which matches.

Replace the footer with:
```js
  var helpers = {
    formatWhen: formatWhen, formatDeadline: formatDeadline, provenanceFor: provenanceFor,
    fieldSentence: fieldSentence, editedBy: editedBy, versionsFor: versionsFor,
    loadTodoHistory: loadTodoHistory, modelFor: modelFor,
  };

  TodoHistory.View = TodoHistoryView;
  Object.keys(helpers).forEach(function (k) { TodoHistory[k] = helpers[k]; });

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TodoHistory = TodoHistory;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({ TodoHistory: TodoHistory, TodoHistoryView: TodoHistoryView }, helpers);
  }
```

`styles/composites.css` (semantic tokens only, no animation):
```css
/* =========================================================================
   TodoHistory — provenance + version list (spec 2026-09-15 §2)
   ========================================================================= */
.fs-todo-history {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.fs-todo-history--loading { color: var(--text-tertiary); }
.fs-todo-history__link {
  background: none; border: 0; padding: 0; font: inherit;
  color: var(--text-link, var(--text-primary));
  text-decoration: underline; cursor: pointer;
}
.fs-todo-history__link:focus-visible { outline: 2px solid var(--border-focus, currentColor); outline-offset: 2px; }
.fs-todo-history__versions {
  list-style: none; margin: 0; padding: 0 0 0 10px;
  border-left: 2px solid var(--border-subtle);
  display: flex; flex-direction: column; gap: 8px;
}
.fs-todo-history__heading { display: flex; gap: 8px; align-items: baseline; }
.fs-todo-history__tag { font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.fs-todo-history__when { color: var(--text-tertiary); }
.fs-todo-history__body { color: var(--text-primary); word-break: break-word; }
.fs-todo-history__body--field { color: var(--text-secondary); font-style: italic; }
.fs-todo-history__who { color: var(--text-tertiary); }
```
Before committing, check that `--text-link` and `--border-focus` exist: `grep -n "\-\-text-link\|\-\-border-focus" styles/tokens.css`. If one is missing, replace it with the fallback shown and drop the `var()` wrapper.

`app-shell-preview.html`, before line 82:
```html
  <!-- To-do provenance + version list (spec 2026-09-15 §2). Hosts: ActionItemRow, Today detail panel. -->
  <script type="text/babel" src="scripts/composites/todo-history.js?v=1"></script>
```
`components-preview.html`, after the `kpi-strip.js` tag:
```html
  <script type="text/babel" src="scripts/composites/todo-history.js?v=1"></script>
```
Add `TodoHistory,` to the destructure after `StatCard, KpiStrip,`. Add the section:
```jsx
          {/* spec 2026-09-15 §2 — no api chain here, so the live component
              renders its closed state; the View shows fixture shapes. */}
          <Section title="TodoHistory">
            <Row label="extraction · three versions">
              <div style={{ flex: 1, minWidth: 0, maxWidth: '520px' }}>
                {TodoHistory && <TodoHistory.View
                  provenance={TodoHistory.provenanceFor(
                    { sessionId: 'Benl1_2026-04-29_07-00-00', sessionKind: 'extraction' },
                    [{ session_id: 'Benl1_2026-04-29_07-00-00', title: 'Morning Safety Briefing', started_at: '2026-04-29T07:00:00' }])}
                  versions={TodoHistory.versionsFor([
                    { field: 'deadline', after_text: '2026-05-01', actor_name: 'Jack Gibson', created_at: '2026-04-29T03:00:00+00:00' },
                    { field: 'text', before_text: 'Order boards', after_text: 'Order replacement scaffold boards from supplier', actor_name: null, created_at: '2026-04-29T02:00:00+00:00' },
                  ], 'Order replacement scaffold boards from supplier')}
                  onOpenMeeting={(id) => alert('open ' + id)} />}
              </div>
            </Row>
            <Row label="report-sourced · never edited">
              <div style={{ flex: 1, minWidth: 0, maxWidth: '520px' }}>
                {TodoHistory && <TodoHistory.View
                  provenance={TodoHistory.provenanceFor({ sessionId: null, sessionKind: 'report' }, [])}
                  versions={[]} />}
              </div>
            </Row>
            <Row label="closed (open=false) renders nothing">
              {TodoHistory && <TodoHistory open={false} actionItemId="cd155836-49f7-44d7-8b7e-e36505140733" />}
            </Row>
          </Section>
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/composites/todo-history.js && node --test tests/todo-history.test.js tests/events.test.js`
Expected: PASS. Mutation check: change the subscription to `onContentEdited('topics', …`. The 10a source scan should go red. Then revert.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # composites.css ~30, app-shell-preview.html 2, components-preview.html ~30
git add scripts/composites/todo-history.js styles/composites.css app-shell-preview.html components-preview.html tests/todo-history.test.js
git commit -m "TodoHistory composite: fetch while open, refresh on content:edited

Registered in app-shell-preview.html and showcased in components-preview.html.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 10: ContentHistoryPanel re-reads on `content:edited` (spec §5, test 10b)

**Files:**
- Modify: `scripts/pages/timeline.js` `ContentHistoryPanel` (3460-3470)
- Test: append to `tests/save-settlement.test.js`

**Interfaces:**
- Consumes: `FS.events.onContentEdited(table, id, fn)`.
- `ContentHistoryPanel` is used by Tasks History (`tasks.js:1149`) and Timeline topic History, and those hosts pick up the refresh with no further changes. Its `No edits yet.` copy stays.

- [ ] **Step 1: Write the failing test** (append)

```js
/* ---- 10b: SOURCE SCAN (wiring pin) — ContentHistoryPanel re-fetches on a
   matching content:edited; the matching rule itself is FS.events.onContentEdited,
   covered behaviourally in tests/events.test.js. */
test('10b ContentHistoryPanel subscribes with its own table and id and re-fetches on tick', () => {
  const src = page('timeline.js');
  const b = block(src, 'function ContentHistoryPanel(', 'function OverviewTab(');
  assert.match(b, /onContentEdited\(props\.table, props\.id,/);
  assert.match(b, /\[props\.table, props\.id, reloadTick\]/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/save-settlement.test.js`
Expected: `10b` FAIL.

- [ ] **Step 3: Implement** — replace the start of `ContentHistoryPanel`, up to and including its first `useEffect`:

```js
  function ContentHistoryPanel(props) {
    var dataRef = React.useState({ status: 'loading' });
    var data = dataRef[0], setData = dataRef[1];
    var tickRef = React.useState(0);
    var reloadTick = tickRef[0], setReloadTick = tickRef[1];
    React.useEffect(function () {
      var alive = true;
      window.FS.api.actions.getContentHistory(props.table, props.id).then(function (res) {
        if (!alive) return;
        setData({ status: 'ok', edits: (res && res.edits) || [] });
      }).catch(function () { if (alive) setData({ status: 'error', edits: [] }); });
      return function () { alive = false; };
    }, [props.table, props.id, reloadTick]);
    /* spec 2026-09-15 §5 — a save to THIS row re-reads the trail (the server
       assigns created_at/actor_name; never append optimistically). */
    React.useEffect(function () {
      var events = window.FS && window.FS.events;
      if (!events || !events.onContentEdited) return undefined;
      return events.onContentEdited(props.table, props.id, function () {
        setReloadTick(function (n) { return n + 1; });
      });
    }, [props.table, props.id]);
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/pages/timeline.js && node --test tests/save-settlement.test.js tests/content-edit-format.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # timeline.js ~15
git add scripts/pages/timeline.js tests/save-settlement.test.js
git commit -m "ContentHistoryPanel re-reads its trail after a save to the same row

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 11: Timeline host — ActionItemRow history disclosure (spec §2 Timeline)

**Files:**
- Modify: `scripts/composites/action-item-row.js` — Props header; hooks near line 146; meta row (~274-311); return (~263); `module.exports` (330-336)
- Modify: `scripts/pages/timeline.js` OverviewTab `ActionItemRow` mount (3744-3757)
- Modify: `styles/composites.css` ActionItemRow block (~936)
- Test: `tests/action-item-row-history.test.js` (create)

**Interfaces:**
- Consumes: `window.FieldSight.TodoHistory` (Task 9), read at render time.
- Produces: `ActionItemRow` new props `withHistory` (boolean), `sessionId`, `sessionKind`. Exported pure `historyEnabled(props) → boolean` = `!!props.withHistory && !!(props.action && props.action.id)`.

Design notes:
- The row root is a `<label>`. A click inside the label would toggle the checkbox, so `TodoHistory` renders **outside** the label, in a wrapper `div.fs-action-item-row-wrap`. The disclosure button calls `preventDefault()` and `stopPropagation()`.
- The wrapper only exists when `historyEnabled(props)` is true. The middle-column mount (`topic-card.js:329`) does not pass `withHistory` and keeps rendering the bare `<label>`, byte-identical.
- `.fs-topic-detail__editable-row > *:first-child { flex: 1 }` (`composites.css:1922`) applies to the wrapper just as it did to the label.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = { FieldSight: {}, FS: {} };
global.React = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
const { historyEnabled } = require('../scripts/composites/action-item-row.js');

test('historyEnabled needs both the host flag and a durable id', () => {
  assert.strictEqual(historyEnabled({ withHistory: true, action: { id: 'ai-1' } }), true);
  assert.strictEqual(historyEnabled({ withHistory: true, action: {} }), false, 'legacy row');
  assert.strictEqual(historyEnabled({ action: { id: 'ai-1' } }), false, 'host did not ask');
  assert.strictEqual(historyEnabled({}), false);
});

/* SOURCE SCAN (wiring pin). */
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'scripts', ...p), 'utf8').replace(/\r\n/g, '\n');

test('OverviewTab mount passes withHistory and the topic session props', () => {
  const src = read('pages', 'timeline.js');
  const s = src.indexOf('React.createElement(ActionItemRow, {', src.indexOf('function OverviewTab('));
  const b = src.slice(s, src.indexOf('}),', s));
  assert.match(b, /withHistory:\s*true/);
  assert.match(b, /sessionId:\s*topic\.session_id/);
  assert.match(b, /sessionKind:\s*topic\.session_kind/);
});

test('topic-card mount does not opt in', () => {
  assert.doesNotMatch(read('composites', 'topic-card.js'), /withHistory/);
});

test('history renders outside the label and the toggle blocks label activation', () => {
  const src = read('composites', 'action-item-row.js');
  assert.match(src, /'fs-action-item-row-wrap'/);
  const t = src.slice(src.indexOf('fs-action-item-row__history-toggle'));
  assert.match(t.slice(0, 600), /preventDefault\(\)/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/action-item-row-history.test.js`
Expected: FAIL — `historyEnabled` is not a function; the pins fail.

- [ ] **Step 3: Implement**

Props header additions (after `onToggled`):
```
     withHistory   boolean (optional) — host opts in to the History disclosure
                   (spec 2026-09-15 §2; Timeline OverviewTab only). Needs
                   action.id; absent -> row renders exactly as before.
     sessionId, sessionKind  the owning topic's session_id / session_kind,
                   forwarded to TodoHistory for the provenance line.
```
Pure helper next to `isColumnDone`:
```js
  function historyEnabled(props) {
    return !!(props && props.withHistory && props.action && props.action.id);
  }
```
Hook, unconditional, directly after `var pendingRef = React.useRef(false);`:
```js
    var historyRef  = React.useState(false);
    var historyOpen = historyRef[0];
    var setHistoryOpen = historyRef[1];
    var withHistory = historyEnabled(props);
```
In the meta row, after the `mention_count` element:
```js
          withHistory
            ? React.createElement('button', {
                type: 'button',
                className: 'fs-action-item-row__meta-item fs-action-item-row__history-toggle',
                'aria-expanded': historyOpen,
                onClick: function (e) {
                  /* Inside a <label>: without preventDefault the click would
                     also toggle the checkbox. */
                  e.preventDefault();
                  e.stopPropagation();
                  setHistoryOpen(function (v) { return !v; });
                },
              }, historyOpen ? 'Hide history' : 'History')
            : null,
```
Change `return React.createElement('label', { className: className },` to `var row = React.createElement('label', { className: className },`, keeping the whole existing element and ending it with `);`. Then add:
```js
    if (!withHistory) return row;
    var TodoHistory = window.FieldSight.TodoHistory;
    return React.createElement('div', { className: 'fs-action-item-row-wrap' },
      row,
      TodoHistory ? React.createElement(TodoHistory, {
        open:         historyOpen,        /* no request while collapsed */
        actionItemId: action.id,
        sessionId:    props.sessionId || null,
        sessionKind:  props.sessionKind || null,
        date:         date,
        folder:       userFolder,         /* report OWNER's folder */
        currentText:  action.action,
      }) : null,
    );
```
Add `historyEnabled: historyEnabled,` to `module.exports`.

`timeline.js` OverviewTab mount, after `checkedAt: state.checked_at,`:
```js
                    /* spec 2026-09-15 §2 — History disclosure; TodoHistory
                       joins the provenance on the topic's own session. */
                    withHistory:    true,
                    sessionId:      topic.session_id || null,
                    sessionKind:    topic.session_kind || null,
```
The pin regex expects `sessionId:\s*topic\.session_id`, and `topic.session_id || null` matches.

CSS after `.fs-action-item-row__priority`:
```css
.fs-action-item-row__history-toggle {
  background: none; border: 0; padding: 0; font: inherit;
  color: var(--text-secondary); text-decoration: underline; cursor: pointer;
}
.fs-action-item-row__history-toggle:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.fs-action-item-row-wrap > .fs-todo-history { margin: 0 10px 8px 36px; }
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/composites/action-item-row.js && node --check scripts/pages/timeline.js && node --test tests/action-item-row-history.test.js tests/closed-by-display.test.js tests/todo-history.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # action-item-row.js ~40, timeline.js ~4, composites.css ~8
git add scripts/composites/action-item-row.js scripts/pages/timeline.js styles/composites.css tests/action-item-row-history.test.js
git commit -m "Timeline action rows: History disclosure showing provenance and versions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 12: Today adapter stamps `sessionId`, `sessionKind`, `version` (spec §2 Today, §8.4 adapter)

**Files:**
- Modify: `scripts/api/today-adapter.js` — task object literal, right after `actionItemId: a.id || null,` (line 437)
- Test: `tests/today-adapter-history-fields.test.js` (create)

**Interfaces:**
- Produces on every Today task item: `sessionId: string|null`, `sessionKind: string|null` (from the topic), and `version: number >= 1` (from the action item, default 1).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

/* Same harness as tests/q1-today-adapter-tiers.test.js. */
global.window = {
  FieldSight: {},
  FS: { api: {
    folderName: (n) => String(n || '').replace(/ /g, '_'),
    actions: { lookupAction: () => undefined },
  } },
};
global.React = {};
global.document = { addEventListener() {}, removeEventListener() {} };
require('../scripts/api/mine-team.js');
require('../scripts/api/today-adapter.js');
const adapt = global.window.FS.api.todayAdapter.adapt;

function tasksOf(topic) {
  const out = adapt({
    report_date: '2026-09-03', site: 'UC PK', user_name: 'Jane Doe',
    executive_summary: [], safety_observations: [], topics: [topic],
  }, { currentUserName: 'Jane Doe', nowMinutes: 16 * 60 });
  return out.myTasks.concat(out.teamTasks);
}

test('session id and kind come from the topic', () => {
  const [t] = tasksOf({ topic_id: 0, session_id: 'S1', session_kind: 'extraction',
    action_items: [{ id: 'ai-1', action: 'x', responsible: 'Jane Doe' }] });
  assert.strictEqual(t.sessionId, 'S1');
  assert.strictEqual(t.sessionKind, 'extraction');
});

test('report topic: null id, report kind', () => {
  const [t] = tasksOf({ topic_id: 0, session_id: null, session_kind: 'report',
    action_items: [{ id: 'ai-1', action: 'x', responsible: 'Jane Doe' }] });
  assert.strictEqual(t.sessionId, null);
  assert.strictEqual(t.sessionKind, 'report');
});

test('version copies from the action item and defaults to 1', () => {
  const ts = tasksOf({ topic_id: 0, action_items: [
    { id: 'a', action: 'x', responsible: 'Jane Doe', version: 3 },
    { id: 'b', action: 'y', responsible: 'Jane Doe' },
    { id: 'c', action: 'z', responsible: 'Jane Doe', version: 0 },
    { id: 'd', action: 'w', responsible: 'Jane Doe', version: '2' },
  ] });
  const byId = Object.fromEntries(ts.map((t) => [t.actionItemId, t]));
  assert.strictEqual(byId.a.version, 3);
  assert.strictEqual(byId.b.version, 1, 'missing version (backend §8.1 not deployed) is 1');
  assert.strictEqual(byId.c.version, 1);
  assert.strictEqual(byId.d.version, 1, 'only a number counts');
  assert.strictEqual(ts[0].sessionId, null);
  assert.strictEqual(ts[0].sessionKind, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/today-adapter-history-fields.test.js`
Expected: FAIL — `undefined !== 'S1'`.

- [ ] **Step 3: Implement** — after `actionItemId: a.id || null,`:

```js
          /* spec 2026-09-15 §2/§8 — TodoHistory joins provenance on the
             topic's session; the card chip reads version (1 + content_edits
             rows, backend §8.1). A missing version is 1: no chip. */
          sessionId:   t.session_id || null,
          sessionKind: t.session_kind || null,
          version:     (typeof a.version === 'number' && a.version >= 1) ? a.version : 1,
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/api/today-adapter.js && node --test tests/today-adapter-history-fields.test.js tests/q1-today-adapter-tiers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # today-adapter.js ~7
git add scripts/api/today-adapter.js tests/today-adapter-history-fields.test.js
git commit -m "Today adapter: carry session id/kind and action item version

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 13: Today host — detail-panel TodoHistory, and the provider keeps `version` current (spec §2 Today, §8.3)

**Files:**
- Modify: `scripts/pages/today.js`
  - new pure helpers `versionBumpFor`, `authoritativeVersionPatch` next to `titleEditable` (~1700)
  - `useTodayState`: a subscription before `return { state: state, removeMyTask: removeMyTask, patchTask: patchTask };` (~1398)
  - `TodayRightDetail`: mount after `renderDetailRows(rows),` (~2998)
  - `module.exports` (3136)
- Test: `tests/today-version-refresh.test.js` (create)

**Interfaces:**
- Consumes: `FS.events.on` (Task 3), `fs.TodoHistory` (Task 9), task fields from Task 12, `patchTask(taskId, patch)` (`today.js:1311`, keyed by the composite `t.id`).
- Produces:
  - `versionBumpFor(data, payload) → null | {taskId, patch: {version}}` — finds the item by **`t.actionItemId === payload.id`** (never `t.id`) in `data.myTasks` / `data.teamTasks`, for `payload.table === 'action_items'` only
  - `authoritativeVersionPatch(item, n) → null | {version: n}` — null when `n` is not a number >= 1 or already equals `item.version || 1`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = { FieldSight: {}, FS: { api: {} } };
global.React = {
  useState: (v) => [v, () => {}], useContext: () => null,
  createContext: (d) => ({ Provider: 'Provider', _def: d }), Fragment: 'Fragment',
};
global.document = { addEventListener() {}, removeEventListener() {} };
const { versionBumpFor, authoritativeVersionPatch } = require('../scripts/pages/today.js');

const DATA = {
  myTasks:   [{ id: '2026-09-03__Ben_UCPK2_action_0_0', actionItemId: 'ai-1', version: 2 }],
  teamTasks: [{ id: '2026-09-03__Ben_UCPK2_action_1_0', actionItemId: 'ai-2' }],
};

test('a matching content:edited bumps only that item, keyed by actionItemId', () => {
  assert.deepStrictEqual(versionBumpFor(DATA, { table: 'action_items', id: 'ai-1' }),
    { taskId: '2026-09-03__Ben_UCPK2_action_0_0', patch: { version: 3 } });
  assert.deepStrictEqual(versionBumpFor(DATA, { table: 'action_items', id: 'ai-2' }),
    { taskId: '2026-09-03__Ben_UCPK2_action_1_0', patch: { version: 2 } }, 'missing version counts as 1');
});

test('no bump for another table, an unknown id, the composite id, or no data', () => {
  assert.strictEqual(versionBumpFor(DATA, { table: 'topics', id: 'ai-1' }), null);
  assert.strictEqual(versionBumpFor(DATA, { table: 'action_items', id: 'ai-9' }), null);
  assert.strictEqual(versionBumpFor(DATA, { table: 'action_items', id: '2026-09-03__Ben_UCPK2_action_0_0' }), null);
  assert.strictEqual(versionBumpFor(null, { table: 'action_items', id: 'ai-1' }), null);
  assert.strictEqual(versionBumpFor(DATA, null), null);
});

test('history read is authoritative: patch only when it differs', () => {
  assert.deepStrictEqual(authoritativeVersionPatch({ version: 3 }, 2), { version: 2 }, 'optimistic bump ran one ahead');
  assert.strictEqual(authoritativeVersionPatch({ version: 2 }, 2), null);
  assert.strictEqual(authoritativeVersionPatch({}, 1), null);
  assert.strictEqual(authoritativeVersionPatch({ version: 2 }, undefined), null);
});

/* SOURCE SCAN (wiring pins). */
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'today.js'), 'utf8').replace(/\r\n/g, '\n');
test('useTodayState subscribes to content:edited and applies versionBumpFor via patchTask', () => {
  const b = src.slice(src.indexOf('function useTodayState('), src.indexOf('return { state: state, removeMyTask: removeMyTask, patchTask: patchTask };'));
  assert.match(b, /events\.on\('content:edited'/);
  assert.match(b, /versionBumpFor\(/);
  assert.match(b, /patchTask\(hit\.taskId, hit\.patch\)/);
});
test('TodayRightDetail mounts TodoHistory with the item and an onVersion correction', () => {
  const b = src.slice(src.indexOf('function TodayRightDetail('));
  assert.match(b, /React\.createElement\(fs\.TodoHistory, \{/);
  assert.match(b, /authoritativeVersionPatch\(item, n\)/);
});
```

Check the name first: `grep -n "function useTodayState" scripts/pages/today.js`. If the hook has a different name, use the function whose body ends with `return { state: state, removeMyTask: removeMyTask, patchTask: patchTask };` (~1399) in both the pin and this step.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/today-version-refresh.test.js`
Expected: FAIL — `versionBumpFor is not a function`.

- [ ] **Step 3: Implement**

Pure helpers, next to `titleEditable`:
```js
  /* spec 2026-09-15 §8.3 — which Today card a content:edited belongs to.
     Matched on the DURABLE actionItemId, never t.id (the composite
     date__folder_action_t_i key patchTask uses). Optimistic +1; the open
     panel's history read then corrects it (authoritativeVersionPatch). */
  function versionBumpFor(data, payload) {
    if (!data || !payload || payload.table !== 'action_items' || !payload.id) return null;
    var lists = [data.myTasks || [], data.teamTasks || []];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        var t = lists[i][j];
        if (t && t.actionItemId === payload.id) {
          return { taskId: t.id, patch: { version: (t.version || 1) + 1 } };
        }
      }
    }
    return null;
  }

  /* spec §3.4 — the history read wins over the list's version. */
  function authoritativeVersionPatch(item, n) {
    if (typeof n !== 'number' || n < 1 || !item) return null;
    return (item.version || 1) === n ? null : { version: n };
  }
```
Subscription in `useTodayState`, directly before its `return { state: … }`:
```js
    /* spec 2026-09-15 §8.3 — keep a card's version chip current after a save
       from anywhere (Today panel, Timeline row, Tasks), with no day refetch. */
    var latestStateRef = React.useRef(state);
    latestStateRef.current = state;
    React.useEffect(function () {
      var events = window.FS && window.FS.events;
      if (!events || !events.on) return undefined;
      return events.on('content:edited', function (payload) {
        var s = latestStateRef.current;
        var hit = versionBumpFor(s && s.status === 'ok' ? s.data : null, payload);
        if (hit) patchTask(hit.taskId, hit.patch);
      });
    }, []);
```
Mount in `TodayRightDetail`, directly after `renderDetailRows(rows),`:
```js
      /* spec 2026-09-15 §2 — Today host, beneath the field rows (mirrors
         Tasks' History tab). open = this panel is showing this to-do.
         date/folder are the report OWNER's (item.date / item.folder). */
      item.kind === 'task' && item.actionItemId && fs.TodoHistory
        ? React.createElement(fs.TodoHistory, {
            key:          item.actionItemId,
            open:         true,
            actionItemId: item.actionItemId,
            sessionId:    item.sessionId || null,
            sessionKind:  item.sessionKind || null,
            date:         item.date,
            folder:       item.folder,
            currentText:  item.title,
            onVersion: function (n) {
              var patch = authoritativeVersionPatch(item, n);
              if (patch && ctx && ctx.patchTask) ctx.patchTask(item.id, patch);
            },
          })
        : null,
```
Add to `module.exports`:
```js
      /* spec 2026-09-15 §8.3 — version chip refresh. */
      versionBumpFor:            versionBumpFor,
      authoritativeVersionPatch: authoritativeVersionPatch,
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/pages/today.js && node --test tests/*.test.js`
Expected: full suite PASS. Mutation check: match on `t.id === payload.id`. The first test should go red. Then revert.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # today.js ~60
git add scripts/pages/today.js tests/today-version-refresh.test.js
git commit -m "Today: to-do history in the detail panel; version stays current after saves

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 14: Version chip as a title prefix on TaskCard (spec §8.2, §8.4)

**Files:**
- Modify: `scripts/composites/task-card.js` — Props header; new `versionChipFor` above `TaskCard` (~111); title element (276-277); add a `module.exports` guard at the end
- Modify: `styles/composites.css` — after `.fs-task-card__title` (~119)
- Test: `tests/task-card-version-chip.test.js` (create)

**Interfaces:**
- Consumes: `task.version` (Task 12, kept current by Task 13).
- Produces: `versionChipFor(task) → null | {text: 'vN', title: string, ariaLabel: string}`.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

function Card() {} Card.Body = function CardBody() {};
function Badge() {} function Avatar() {}
global.window = { FieldSight: { Card, Badge, Avatar }, FS: {} };
global.document = { getElementById: () => null };
global.React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [v, () => {}],
};
const { versionChipFor, TaskCard } = require('../scripts/composites/task-card.js');

test('no chip for missing or v1', () => {
  assert.strictEqual(versionChipFor(undefined), null);
  assert.strictEqual(versionChipFor({}), null);
  assert.strictEqual(versionChipFor({ version: 1 }), null);
});

test('v2: singular copy', () => {
  assert.deepStrictEqual(versionChipFor({ version: 2 }), {
    text: 'v2',
    title: 'Edited 1 time — open to see history',
    ariaLabel: 'Version 2, edited 1 time',
  });
});

test('v3: plural copy', () => {
  const c = versionChipFor({ version: 3 });
  assert.strictEqual(c.title, 'Edited 2 times — open to see history');
  assert.strictEqual(c.ariaLabel, 'Version 3, edited 2 times');
});

function find(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  for (const c of node.children || []) { const r = find(c, pred); if (r) return r; }
  return null;
}
const titleOf = (task) => find(TaskCard({ task }), (n) => n.props && n.props.className === 'fs-task-card__title');

test('chip renders inside the title, before the text, as a quiet neutral outline sm Badge', () => {
  const title = titleOf({ id: 't', title: 'Roofing price', version: 2, status: 'Open', statusTone: 'info' });
  const chip = title.children[0];
  assert.strictEqual(chip.type, Badge);
  assert.deepStrictEqual([chip.props.tone, chip.props.variant, chip.props.size], ['neutral', 'outline', 'sm']);
  assert.strictEqual(chip.props['aria-label'], 'Version 2, edited 1 time');
  assert.deepStrictEqual(chip.children, ['v2']);
  assert.strictEqual(title.children[title.children.length - 1], 'Roofing price');
  assert.strictEqual(chip.props.onClick, undefined, 'no separate handler: the card click opens the panel');
});

test('v1 title renders the text alone', () => {
  assert.deepStrictEqual(titleOf({ id: 't', title: 'Light poles', version: 1 }).children.filter(Boolean), ['Light poles']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/task-card-version-chip.test.js`
Expected: FAIL — `versionChipFor is not a function`.

- [ ] **Step 3: Implement**

Props header, under `task`:
```
                    `version` (spec 2026-09-15 §8) — 1 + content_edits rows;
                    >= 2 renders a quiet `vN` prefix inside the title.
```
Above `function TaskCard(props)`:
```js
  /* spec 2026-09-15 §8.2 — the title prefix is the only position with a fixed
     left edge at every middle-column width (the meta row wraps beside a
     variable-width title between 420 and 560). null below v2. */
  function versionChipFor(task) {
    var v = task && task.version;
    if (typeof v !== 'number' || v < 2) return null;
    var times = (v - 1) === 1 ? '1 time' : (v - 1) + ' times';
    return {
      text:      'v' + v,
      title:     'Edited ' + times + ' — open to see history',
      ariaLabel: 'Version ' + v + ', edited ' + times,
    };
  }
```
Title element, replacing lines 276–277:
```js
            React.createElement('div', { className: 'fs-task-card__title' },
              chip ? React.createElement(Badge, {
                tone: 'neutral', variant: 'outline', size: 'sm',
                className: 'fs-task-card__version',
                title: chip.title,
                'aria-label': chip.ariaLabel,
              }, chip.text) : null,
              chip ? ' ' : null,
              task.title),
```
with `var chip = versionChipFor(task);` declared next to `var batchMode = !!props.batchMode;`.
End of the IIFE, after `window.FieldSight.TaskCard = TaskCard;`:
```js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TaskCard: TaskCard, versionChipFor: versionChipFor };
  }
```
CSS after the `.fs-task-card__title { … }` rule:
```css
/* "This to-do has been changed" — quieter than status (spec 2026-09-15 §8.2). */
.fs-task-card__version { vertical-align: 1px; }
```

- [ ] **Step 4: Run tests**

Run: `node --check scripts/composites/task-card.js && node --test tests/task-card-version-chip.test.js tests/check-off-removes-the-row.test.js tests/batch-select-row-target.test.js`
Expected: PASS. Mutation check: change `v < 2` to `v < 1`. `no chip for missing or v1` should go red. Then revert.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # task-card.js ~30, composites.css 2
git add scripts/composites/task-card.js styles/composites.css tests/task-card-version-chip.test.js
git commit -m "Today cards: vN chip before the title for edited to-dos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

### Task 15: Cache busters, full checks, and browser verification (spec §7, §9.3, §10.3)

**Files:**
- Modify: `app-shell-preview.html`, `components-preview.html` — `?v=` for changed files only

- [ ] **Step 1: Bump cache busters for every changed loaded file**

List the changed files: `git diff --name-only origin/dev...HEAD -- scripts styles`. For each one, find its tag and add 1 to the current number: `grep -n "<file>?v=" app-shell-preview.html components-preview.html`. Values at plan time:

| Tag | app-shell-preview.html | components-preview.html |
|---|---|---|
| `scripts/composites/task-card.js` | 17 → 18 | 8 → 9 |
| `scripts/composites/kpi-strip.js` | 1 → 2 | 1 → 2 |
| `scripts/composites/action-item-row.js` | 9 → 10 | — |
| `scripts/api/org.js` | 22 → 23 | — |
| `scripts/api/actions.js` | 13 → 14 | — |
| `scripts/mock/daily-report.fixture.js` | 4 → 5 | — |
| `scripts/api/today-adapter.js` | 15 → 16 | — |
| `scripts/pages/today.js` | 59 → 60 | — |
| `scripts/pages/timeline.js` | 63 → 64 | — |
| `scripts/pages/tasks.js` | 20 → 21 | — |
| `scripts/app-shell.js`, `styles/app-shell.css`, `styles/composites.css` | current +1 (grep) | current +1 if loaded (grep) |

New tags (`events.js`, `todo-history.js`) already carry `?v=1`. Do not touch any other number.

- [ ] **Step 2: Full checks**

```bash
for f in $(git diff --name-only origin/dev...HEAD -- '*.js'); do node --check "$f" || echo "FAIL $f"; done
node --test tests/*.test.js
grep -n "api/index.js\|api/events.js\|composites/todo-history.js" app-shell-preview.html
```
Expected: no FAIL lines. All tests pass. `events.js` line number > `index.js` line number, and `todo-history.js` sits in the composites block.

- [ ] **Step 3: Local mock preview**

`python3 -m http.server 8765`, then open `http://localhost:8765/app-shell-preview.html?dev=1`. Check the console has no errors.
- Today, 2026-04-29 as Jarley Trainor: "Order replacement scaffold boards…" shows `v2`, and "Reroute hose at gate 2" shows `v3`. Select the `v3` card. The panel shows `From Morning Safety Briefing · Wed 7:00 am · open the meeting` above `v3 / v2 / v1 · as recorded`, and the chip stays `v3`.
- A to-do of topic 3 (report-sourced) shows `From the daily report` with no time or link.
- Timeline, the same day, open a topic, then History on an action row. It shows the same entries. In DevTools Network there is no new request on expand (mocks make no network calls, so check via a `console.count` breakpoint on `getSessionsCached` if needed).
- Timeline stat strip is one short row. Insights tiles look the same. At 390px width the strip wraps two per row.
- `components-preview.html`: the compact strip and the three TodoHistory rows render.

- [ ] **Step 4: Dev (TEST) verification per spec §7 — needs the user**

`main` is production and deploys on merge. Never merge to `main`. Ask the user before pushing this branch to `dev`, and confirm that backend §8.1 (`version` on `/timeline`) is on TEST. Without it, steps 2 and 7 below cannot show `v2` after a reload. As Ben_UCPK2 (UC PK, 2026-09-03), with the Network panel open:
1. Today: select a never-edited to-do. The panel shows provenance and no version block, and the card has no chip. There is exactly one `sessions` and one `history` request, and none before selecting.
2. Change its deadline. One `Saved` toast. The panel shows `v2 · deadline changed to …` over `v1 · as recorded`. The middle card shows `v2` without a reload.
3. Timeline, same day, same to-do row, expand. The same two entries, and no `sessions` request on expand.
4. Edit a topic summary: one `Saved` toast. Edit Today's title: exactly one `Saved` toast.
5. OverviewTab: reassign a to-do → `Saved`. As a user without rights → error toast, and the select reverts.
6. Tick a to-do done: no `Saved` toast.
7. Reload Today: the edited to-do still shows `v2`.
8. With `localStorage['fs.appshell.middleWidth']='320'`, reload: the middle column is 420. Drag: it stops at 360 and 560. At a 1040px viewport with the middle at max, Today's field editors are still usable in the right panel.
9. Timeline day header: the four stats sit on one short row above Topics.

Report which steps were verified and which were deferred, with the reason.

- [ ] **Step 5: Commit**

```bash
git diff --stat   # only ?v= digits in the two HTML files
git add app-shell-preview.html components-preview.html
git commit -m "Bump cache busters for the to-do history change set

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012vJF6RLXaUEWuai8RrFknd"
```

---

## Self-Review

**Spec coverage**

| Spec | Task |
|---|---|
| §1 Out: check-off / bulk / propagate / Restore emit nothing, Tasks rendering unchanged | 5 (exactly four `settleSave(` sites, test 9), 10 (Tasks copy untouched) |
| §2 composite, props, hosts, registration, showcase | 8, 9, 11, 13 |
| §3.1 `getSessionsCached`, Timeline switch, Today `_sessionsFor` left alone | 6 |
| §3.2 history on each open, `_notFound` = empty, NULL actor | 8 (tests 1.4, 5, 6) |
| §3.3 four provenance states, fixture `session_kind` | 7, 8 (tests 1, 2) |
| §3.4 numbering | 8 (test 7), 13 (history wins) |
| §4 `settleSave` + four sites + `assignTo` toasts | 4, 5 |
| §5 `FS.events`, subscribers | 3, 9, 10 |
| §6 tests 1–10 + mutation checks | 3–11 (mutation steps in 1, 2, 4, 5, 8, 9, 13, 14) |
| §7 manual | 15 |
| §8.1 frontend side (missing = 1, fixture versions) | 7, 12 |
| §8.2 chip placement/copy | 14 |
| §8.3 bump by actionItemId + authoritative correction | 13 |
| §8.4 chip / adapter / provider tests | 12, 13, 14 |
| §9 width, key, clamp, source scan | 1 |
| §10 compact strip, both mounts, pin, preview | 2 |

**Decisions not stated verbatim in the spec (flag in review):**
- `TodoHistory` takes an extra `currentText` prop (needed for §3.4 `v1` when text was never edited) and an optional `onVersion` (the §8.3 correction path).
- `ActionItemRow` needs an explicit `withHistory` flag so the middle-column `TopicCard` mount stays byte-identical.
- `FS.events.onContentEdited` is a convenience on top of the spec's `on`/`emit`, so the matching rule is written once.
- The history mock serves `version - 1` synthetic priority edits, so offline chips don't reset to `v1` when opened.
- A `_accessDenied` history read also renders as empty (no toast), like `_notFound`.
- Provenance for an extraction id missing from sessions reads `From a recording` (no time, no link) unless the topic carries a session title.

**Placeholder scan:** no TBD or "similar to". Every code step has code, and every run step has a command and an expected result.

**Name consistency:** `settleSave`, `getSessionsCached`, `onContentEdited`, `loadTodoHistory`, `provenanceFor`, `versionsFor`, `modelFor`, `historyEnabled`, `versionBumpFor`, `authoritativeVersionPatch`, `versionChipFor` are used with the same signatures in every task that consumes them.
