# UI Phase 1 — Batch-select / Resolved sort+style / Audit display / Timeline readability / Button fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the frontend-only slice of the 7-task UI spec: timeline readability, safety/quality create-button fix, Leftover batch-select refactor + reusable multi-select, safety resolve operator display, resolved sort-to-bottom + styling, and equal-width Today buttons.

**Architecture:** Pure client-side changes to the no-build browser-React prototype (React.createElement, tokens.css/composites.css, per-page JS in `scripts/pages/`, composites in `scripts/composites/`). No backend calls added; T6 only READS `checked_by`/`checked_at` the existing `toggleAction` response already returns. New reusable multi-select composite extracted from Leftover and reused by Safety/Quality.

**Tech Stack:** Browser React (Babel-in-browser), CSS custom properties (`styles/tokens.css` + JS mirror `scripts/fs-globals.js`), BEM CSS in `styles/composites.css`.

## Global Constraints (from CLAUDE.md — every task honors these)

- **BEM** `.fs-{block}__{element}--{modifier}`; **tokens only** — never hardcode color/spacing/font; read tokens via CSS `var(--...)` (in React `style={{}}` use string literals like `'var(--surface-panel)'`, never JS `t.surface.X` which is baked light-mode hex).
- **Token sync:** if you touch `styles/tokens.css`, mirror the same token in `scripts/fs-globals.js` (and vice-versa).
- **`node --check`** every touched `.js` file before commit.
- **Cache-busters:** bump `?v=N` for every loaded `.js`/`.css` you change, in `app-shell-preview.html` (and `components-preview.html` if that loads it).
- **New L5 composite** → register + smoke-render in `components-preview.html`.
- **Reduced motion:** every `@keyframes` needs a `@media (prefers-reduced-motion: reduce)` override.
- **Status color tokens are NOT theme-flipped** — when a bg uses `--color-*-{50,100}`, pin the foreground so dark-mode text stays readable.
- **`:focus-visible`** (not `:focus`) for inset outlines; unified selection token is `--surface-selected`.
- **No test runner exists** — "tests" here = `node --check` + grep pre-checks + the per-task **Manual verification** checklist. Real browser verification: `python3 -m http.server 8765` → `http://localhost:8765/app-shell-preview.html` (append `?dev=1` for the role switcher, `?mocks=0` for live).
- **Owner ≠ caller:** operator-for-display = the API response's `checked_by`/`checked_at`, NEVER a local `AuthMock.currentUser`/`session` read. Never derive `user_folder` from the current user.
- Decisions locked: Today/Leftover keep DROP behavior (sink is safety/quality/timeline only); audit = the batch RESOLVE (already logged), not transient selection; T5 = visible-button-click-noop → modal-mount debug.

---

### Task 1: T3 — Timeline topic selected-state readability + hover-only yellow (P0)

**Files:**
- Modify: `styles/tokens.css:354` (light `--surface-selected`), `styles/tokens.css:673` (dark `--surface-selected`) — add a NEW neutral selected token; do NOT repurpose `--surface-selected` (used elsewhere as the canonical selected-row bg).
- Modify: `scripts/fs-globals.js` (mirror any new token).
- Modify: `styles/composites.css:873-876` (`.fs-topic-card--selected`), `:878-907` (`.fs-topic-card--flash` reduced-motion branch), add `.fs-topic-card:hover`.
- Modify: `scripts/composites/topic-card.js:147-150` only if a className toggle is needed (prefer CSS-only).

**Interfaces:**
- Produces: token `--surface-topic-selected` (theme-aware, NEUTRAL, readable with `--text-primary`). Consumed only by `.fs-topic-card--selected`.

- [ ] **Step 1: Pre-check the hooks exist**
Run: `grep -n "surface-selected" styles/tokens.css; grep -n "fs-topic-card--selected\|fs-topic-card--flash" styles/composites.css`
Expected: `--surface-selected` at ~354 (light) + ~673 (dark); the two `.fs-topic-card--*` rules present. Read those exact rules before editing.

- [ ] **Step 2: Add a neutral, readable selected token**
In `styles/tokens.css` add under `:root` (light) and `[data-theme="dark"]` a new token, e.g.:
```css
/* light :root */  --surface-topic-selected: var(--surface-selected-neutral, #EEF2F7);
/* dark  */        --surface-topic-selected: rgba(255,255,255,0.06);
```
(Pick neutral values consistent with the file's existing neutral surfaces; NOT yellow.) Mirror the token name in `scripts/fs-globals.js` if that file enumerates surface tokens.

- [ ] **Step 3: Selected state = readable (border + neutral tint), not yellow**
Replace `.fs-topic-card--selected { background: var(--surface-selected); }` with a readable indicator:
```css
.fs-topic-card--selected {
  background: var(--surface-topic-selected);
  border-left: 3px solid var(--color-accent-500);
}
```
Ensure title/body still use `var(--text-primary)` (they do). No yellow fill in the selected state.

- [ ] **Step 4: Yellow only on hover, readable**
Add:
```css
.fs-topic-card:hover { background: var(--surface-selected); }   /* existing yellow token, hover-only */
[data-theme="dark"] .fs-topic-card:hover .fs-topic-card__title,
[data-theme="dark"] .fs-topic-card:hover { color: var(--text-primary); }  /* pin fg readable on yellow */
```
(Selected + hover: selected border wins; keep hover from clobbering readability.)

- [ ] **Step 5: Fix the reduced-motion flash to a readable static**
In `.fs-topic-card--flash` `@media (prefers-reduced-motion: reduce)` branch (composites.css:900-906), replace the pinned `--color-accent-100` (pale-yellow-under-white trap) background with `var(--surface-topic-selected)` (readable neutral) so deep-link spotlight is legible without animation.

- [ ] **Step 6: Syntax + cache-bust**
Run: `node --check scripts/composites/topic-card.js` (if touched) `&&` `node --check scripts/fs-globals.js`.
Bump `?v=N` for `styles/composites.css`, `styles/tokens.css`, `scripts/fs-globals.js` in `app-shell-preview.html`.

- [ ] **Step 7: Manual verification**
Serve, open `/timeline`. In BOTH light + dark: click a topic → selected shows accent left-border + neutral tint, title/body **clearly readable** (no yellow-on-white). Hover a non-selected card → yellow hover, text still readable. Deep-link from `/safety` "Open in timeline" with `prefers-reduced-motion` → target readable (not pale-yellow-under-white).

- [ ] **Step 8: Commit**
```bash
git add styles/tokens.css styles/composites.css scripts/fs-globals.js app-shell-preview.html
git commit -m "fix(timeline): readable selected topic (accent border + neutral tint); yellow only on hover; reduced-motion flash legible (T3)"
```

---

### Task 2: T5 — Safety/Quality create button click no-op → modal mount debug (P0)

**Files:**
- Modify: `scripts/pages/safety.js:206-219,308-320` and `scripts/pages/quality.js:208-218,306-318` (button onClick + modal mount).
- Modify: `scripts/composites/safety-create-modal.js` / `quality-create-modal.js` (only if the render throws).

**Interfaces:**
- Consumes: `ctx.setShowCreate` / the `showCreate` state; `window.FS.api.getSites` / `FS.siteContext`.

- [ ] **Step 1: Reproduce + instrument**
Serve with `?dev=1&mocks=0` (and try `?mocks=1`). Click "+ Raise Observation" (safety) / "+ Log Item" (quality). Open devtools Console. Add a temporary `console.log('[T5] raise click')` at the button onClick and `console.log('[T5] modal render', {siteId})` at the top of `SafetyCreateModal`/`QualityCreateModal` render.
Expected: determine which fires — (a) neither → onClick not bound / stale `ctx`; (b) click logs but modal-render never logs → `setShowCreate` not flipping state or modal not mounted; (c) modal-render logs but nothing visible → CSS/portal invisibility or an in-render throw.

- [ ] **Step 2: Read the mount + state wiring**
Run: `grep -n "showCreate\|setShowCreate\|SafetyCreateModal\|ModalOverlay" scripts/pages/safety.js`. Confirm the modal is `showCreate ? React.createElement(FieldSight.SafetyCreateModal, {...}) : null` and that `ctx`/`setShowCreate` comes from the SAME state instance the button closes over (no stale closure from a memoized child).

- [ ] **Step 3: Fix the identified root cause**
- If (a) stale `ctx`/closure: pass `setShowCreate` directly (not via a stale `ctx`) or ensure the handler is recreated when state deps change.
- If (b) modal not mounting: correct the conditional mount / ensure `FieldSight.SafetyCreateModal` is defined at call time (script load order in `app-shell-preview.html`).
- If (c) invisible/throwing: fix `ModalOverlay` visibility (z-index/portal), and wrap the modal body so an internal throw (e.g. `getSites()` failing → siteId='') renders an `ErrorBanner` instead of silently no-rendering (`safety-create-modal.js:100-109` currently swallows the sites error into `[]`).

- [ ] **Step 4: Remove instrumentation + syntax**
Delete the temporary `console.log`s. Run: `node --check scripts/pages/safety.js scripts/pages/quality.js scripts/composites/safety-create-modal.js scripts/composites/quality-create-modal.js`.

- [ ] **Step 5: Cache-bust + manual verify**
Bump `?v=N` for the touched JS in `app-shell-preview.html`. Serve; click both buttons (as admin and as a site_manager via `?dev=1`) → a visible, interactable modal opens each time; force a modal-internal error (e.g. temporarily break `getSites`) → an ErrorBanner shows instead of a silent no-op.

- [ ] **Step 6: Commit**
```bash
git add scripts/pages/safety.js scripts/pages/quality.js scripts/composites/safety-create-modal.js scripts/composites/quality-create-modal.js app-shell-preview.html
git commit -m "fix(safety,quality): create buttons open the modal on click; surface modal errors instead of silent no-op (T5)"
```

---

### Task 3: T2 — Today/Timeline button equal width (P2)

**Files:** Modify `styles/composites.css:169-170` (`.fs-today__timeline-link`), `:1052` (`.fs-timeline-page__back`).

- [ ] **Step 1: Pre-check** `grep -n "fs-today__timeline-link\|fs-timeline-page__back" styles/composites.css` and read both width rules (50%/min-220px vs 100%).
- [ ] **Step 2: Unify** — set both to the SAME rule so they read as one button family. Recommended: give `.fs-timeline-page__back` the same `width: 50%; min-width: 220px;` as `.fs-today__timeline-link` (compact block), OR both `width:100%` — pick one and apply to both. Keep the shared skin (`--color-primary-900`, padding, font) untouched.
- [ ] **Step 3: Cache-bust** bump `?v=N` for `styles/composites.css` in `app-shell-preview.html`.
- [ ] **Step 4: Manual verify** — "Open Task List" (Today) and "Back to Today" (Timeline, arrive via a Today→topic link) render visibly equal width + aligned.
- [ ] **Step 5: Commit**
```bash
git add styles/composites.css app-shell-preview.html
git commit -m "fix(today): equal width for Open Task List / Back to Today buttons (T2)"
```

---

### Task 4: T7+G2 — Resolved sinks to bottom + gray/strikethrough (safety, quality, timeline) (P1)

**Files:**
- Modify: `styles/composites.css` (new shared `.fs-row--resolved`), `scripts/fs-globals.js` (new `--surface-resolved` token if added to tokens.css).
- Modify: `styles/tokens.css` (add `--surface-resolved` theme-aware).
- Modify: `scripts/pages/safety.js:56-65,358-388`, `scripts/pages/quality.js:45-54,349-398`, `scripts/composites/topic-card.js:245-259` (timeline topic action items).

**Interfaces:**
- Produces: token `--surface-resolved` (theme-aware low-contrast gray); CSS class `.fs-row--resolved` (muted bg + `text-decoration: line-through` on primary text). Reused by all three lists.
- Consumes: each row's resolved/closed flag (`row.status === 'resolved'|'closed'` for safety/quality; `a.checked` for timeline action items).

- [ ] **Step 1: Pre-check** grep the three sort/render sites (`groupByDate` in safety.js/quality.js; `topic.action_items.map` in topic-card.js) and the reference comparator `tasks.js:332-336`.
- [ ] **Step 2: Add token + shared class**
`styles/tokens.css`: `--surface-resolved: #F1F3F5;` (light) / `[data-theme="dark"] --surface-resolved: rgba(255,255,255,0.04);`. Mirror in `fs-globals.js`.
`styles/composites.css`:
```css
.fs-row--resolved { background: var(--surface-resolved); }
.fs-row--resolved .fs-row__title,
.fs-row--resolved .fs-safety-flag-row__title,
.fs-row--resolved .fs-quality-row__title { text-decoration: line-through; color: var(--text-tertiary); }
```
(Match the actual title element classes each list uses — read them first.)
- [ ] **Step 3: Stable sink comparator (reuse tasks.js shape)**
In safety.js `groupByDate` (and quality.js), after date-grouping, sort each group's rows so resolved/closed sink last while preserving relative order: `rows = rows.slice().sort((a,b)=> (isResolved(a)===isResolved(b)) ? 0 : (isResolved(a)?1:-1));` where `isResolved(r)` = `r.status==='resolved'||r.status==='closed'`. (`Array.prototype.sort` is stable in evergreen browsers, so equal items keep order.)
For timeline (`topic-card.js:245-259`), sort `topic.action_items` copy so `a.checked` sink last before `.map`.
- [ ] **Step 4: Apply `.fs-row--resolved`** to each resolved row's className in the three render sites.
- [ ] **Step 5: Syntax + cache-bust** `node --check` safety.js quality.js topic-card.js fs-globals.js; bump `?v=N` for those + composites.css + tokens.css.
- [ ] **Step 6: Manual verify** — in `/safety`, `/quality`, and `/timeline` (open a topic with checked + unchecked action items): resolved/checked rows sink to the bottom of their group, shown grayed + struck-through; unfinished rows keep their order; light + dark both readable.
- [ ] **Step 7: Commit**
```bash
git add styles/tokens.css styles/composites.css scripts/fs-globals.js scripts/pages/safety.js scripts/pages/quality.js scripts/composites/topic-card.js app-shell-preview.html
git commit -m "feat(lists): resolved items sink to bottom + gray/strikethrough in safety/quality/timeline (T7,G2)"
```

---

### Task 5: T6 — Safety resolve operator display (report-derived rows) (P1)

**Files:** Modify `scripts/pages/safety.js:429-474` (`toggleResolve`), `:648-684` (detail `DetailRow` list). Reference pattern: `scripts/composites/action-item-row.js:191-198`.

**Interfaces:**
- Consumes: `toggleAction(...)` response fields `checked_by` (string) + `checked_at` (ISO string) — already returned by `scripts/api/actions.js` (live 115-116, mock 156-161).
- Produces: on `sel`/row state, `resolvedBy` + `resolvedAt`; a new "Resolved by" detail row.

- [ ] **Step 1: Pre-check** read `toggleResolve` (safety.js:429-474) — confirm it calls `toggleAction` and the `.then()` at ~466 discards `res`. Read `action-item-row.js:191-198` for the display format (`'Checked by ' + checkedBy + ' · ' + fmtCheckedAt(checkedAt)`).
- [ ] **Step 2: Capture the response**
In the `toggleResolve` `.then(res => ...)`, when resolving (`nextStatus === 'resolved'`), set on local state: `resolvedBy: res && res.checked_by, resolvedAt: res && res.checked_at`. When reopening, CLEAR them (`resolvedBy: null, resolvedAt: null`) — spec: show only the latest Resolved.
- [ ] **Step 3: Render the "Resolved by" detail row**
In the `DetailRow` list (safety.js:648-684), when `sel.status === 'resolved' && sel.resolvedBy`, add a row: label "Resolved by", value `sel.resolvedBy + ' · ' + fmtTime(sel.resolvedAt)` — reuse/borrow the `fmtCheckedAt` formatter from `action-item-row.js` (extract to a shared helper if cleaner, else inline the same format). Localized copy: "由 {name} 于 {time} 解决".
- [ ] **Step 4: Manual observations note** — the manual-observation path (`toggleManualStatus` → `org.updateObservation`) carries no operator; leave it showing no resolver (Phase 2). Do NOT fabricate an operator from `AuthMock.currentUser`.
- [ ] **Step 5: Syntax + cache-bust** `node --check scripts/pages/safety.js`; bump `?v=N`.
- [ ] **Step 6: Manual verify** — resolve a report-derived safety flag → detail shows "由 <name> 于 <time> 解决"; Reopen → the line disappears; a manual observation → no resolver line (expected).
- [ ] **Step 7: Commit**
```bash
git add scripts/pages/safety.js app-shell-preview.html
git commit -m "feat(safety): show resolver + time on report-derived resolves (reads existing checked_by/checked_at); clear on reopen (T6 frontend)"
```

---

### Task 6: T1 — Leftover batch-select refactor (drop square checkbox, keep round, Batch Select + Shift/Ctrl) (P1)

**Files:** Modify `scripts/pages/today.js:1073-1075,1204-1226,1240-1301,1501-1549`, `scripts/composites/task-card.js:92-120,131-148,158-181`, `styles/composites.css:418-465` (`.fs-task-card__select` removal / `.fs-task-card__check` reuse).

**Interfaces:**
- Produces: Leftover `batchMode` state + `anchorId` (last-clicked) for range selection; the round `.fs-task-card__check` doubles as a multi-select toggle when `batchMode` is on.
- Consumes: existing `selectedIds`/`toggleLeftoverSelect`/`bulkResolveLeftover` (today.js:1073-1301).

- [ ] **Step 1: Pre-check** read the TaskCard render (task-card.js:158-181): the square `.fs-task-card__select` at :180 (guarded by `props.selectable`) and the round `.fs-task-card__check` at :181 (guarded by `props.checkable`). Read today.js Leftover section props (1547-1549) + bulk bar (1501-1526).
- [ ] **Step 2: Remove the square checkbox**
Delete the `.fs-task-card__select` render (task-card.js:158-169,180) and stop passing `selectable`/`onSelectToggle` from the Leftover section (today.js:1547-1549). Remove `.fs-task-card__select` CSS (composites.css:454-465).
- [ ] **Step 3: Add Batch Select toggle**
Add a "Batch Select" button at the top of the Leftover list (near the bulk bar, today.js ~1501). It toggles `batchMode`. When OFF: round selector = single resolve (`startCheckOff`, unchanged). When ON: round selector becomes a multi-select toggle (calls `toggleLeftoverSelect` and does NOT resolve), the bulk bar (Select all / Resolve N / Clear) shows.
- [ ] **Step 4: Wire round selector for batch mode + keyboard**
In `task-card.js`, the round check's onClick (currently `startCheckOff`, :92-120) branches on a new `props.batchMode`: if batchMode, call `props.onBatchToggle(task, evt)` (pass the click event) instead of `startCheckOff`. In today.js `onBatchToggle(task, evt)`:
  - `evt.shiftKey` → range-select from `anchorId` to `task.id` across the current rendered `leftoverItems` order (select the contiguous slice).
  - `evt.ctrlKey || evt.metaKey` → toggle only `task.id`.
  - plain → toggle `task.id` and set `anchorId = task.id`.
Show selected state on the round selector (e.g. `.fs-task-card__check--selected` filled ring) when `selectedIds[task.id]`.
- [ ] **Step 5: Batch resolve = the audited action**
`Resolve N` calls the existing `bulkResolveLeftover()` (today.js:1240-1301) unchanged — each item's `toggleAction` already records `checked_by`/`checked_at` server-side (this is the G1 audit; transient selection is NOT logged).
- [ ] **Step 6: Syntax + cache-bust + composite showcase**
`node --check scripts/pages/today.js scripts/composites/task-card.js`; bump `?v=N`; if TaskCard's showcase in `components-preview.html` demonstrates selection, update it for the new batchMode prop.
- [ ] **Step 7: Manual verify** — Leftover shows NO square checkbox. "Batch Select" off → round button resolves single item (with animation). Batch Select on → round selectors multi-select; Shift+Click selects a contiguous range; Ctrl/Cmd+Click toggles one; "Resolve N" resolves all selected (each leaves the list, toast summary). Toggle Batch Select off → back to single-resolve.
- [ ] **Step 8: Commit**
```bash
git add scripts/pages/today.js scripts/composites/task-card.js styles/composites.css app-shell-preview.html components-preview.html
git commit -m "feat(leftover): Batch Select mode on the round selector (Shift/Ctrl range+toggle); remove square checkbox; batch resolve stays audited (T1)"
```

---

### Task 7: T4 — Extract reusable multi-select + apply to Safety/Quality lists (P2)

**Files:** Create `scripts/composites/multi-select-list.js` (a `useMultiSelect` hook + optional bulk-bar); Modify `scripts/pages/safety.js`, `scripts/pages/quality.js` (middle-column lists), and refactor `scripts/pages/today.js` Leftover to consume it (DRY with Task 6); register in `components-preview.html`.

**Interfaces:**
- Consumes: Task 6's batch interaction (mode toggle + Shift/Ctrl selection + bulk bar).
- Produces: `window.FieldSight.useMultiSelect({ items, getId })` → `{ batchMode, setBatchMode, selectedIds, onItemClick(item, evt), selectedItems, clear }` — the ONE implementation of the mode+Shift/Ctrl+anchor logic. Consumed by Leftover (Task 6 refactor), Safety, Quality.

- [ ] **Step 1: Extract** — move Task 6's `batchMode`/`anchorId`/Shift-Ctrl logic into `useMultiSelect` (a hook attached to `window.FieldSight`). Keep behavior identical.
- [ ] **Step 2: Refactor Leftover to use it** — replace today.js's inline batch state with `useMultiSelect`; verify Task 6's manual checklist still passes (no behavior change).
- [ ] **Step 3: Apply to Safety** — add a "Multi-Select" toggle to the `/safety` middle-column list; in batch mode, list rows become selectable (Shift/Ctrl), and a bulk bar offers "Mark Resolved" for the selected **report-derived** rows via the existing `toggleAction` (skip manual observations — no batch backend). Reuse `.fs-row--resolved` styling from Task 4.
- [ ] **Step 4: Apply to Quality** — same for `/quality` (batch Mark-Resolved for report-derived rows).
- [ ] **Step 5: Register + syntax + cache-bust** — register `multi-select-list.js` load in `app-shell-preview.html` + a smoke render in `components-preview.html`; `node --check` all touched; bump `?v=N`.
- [ ] **Step 6: Manual verify** — Leftover unchanged (regression check). Safety + Quality each gain a "Multi-Select" toggle reusing the same interaction; batch Mark-Resolved works on report-derived rows and they sink (Task 4).
- [ ] **Step 7: Commit**
```bash
git add scripts/composites/multi-select-list.js scripts/pages/today.js scripts/pages/safety.js scripts/pages/quality.js app-shell-preview.html components-preview.html
git commit -m "feat(lists): reusable useMultiSelect; batch Mark-Resolved on safety/quality report rows; Leftover uses shared impl (T4)"
```

---

## Deferred to Phase 2 (NOT in this plan)
Backend status-change history table + `GET .../history`; manual-observation operator stamping (`org.updateObservation` → closed_by/at); Aurora `action_items`/`safety_observations` resolve endpoints (none exist; live items are same-day-volatile pending authority-flip #27); reading back the write-only DynamoDB `AUDIT#{date}` log.

## Risks
- **No test runner** → all verification is manual; be rigorous with the per-task browser checklist in BOTH themes and (where relevant) `?dev=1` role switching.
- **T5 is a genuine bug hunt** — if Step 1 instrumentation doesn't localize it in-browser, escalate rather than guessing (systematic-debugging).
- **T4 depends on T1** (extraction) — keep the Leftover refactor behavior-identical (Step 2 regression check).
- Sort stability relies on evergreen `Array.prototype.sort` being stable (it is) — do not add a secondary tiebreaker that reorders unfinished items.
