# UI Phase 1 — Batch-select, Resolved sorting/styling, Audit display, Timeline readability, Safety/Quality button fix

**Date:** 2026-07-14
**Repo:** fieldsight-ui (branch `dev`; no-build browser-React prototype)
**Scope:** FRONTEND-ONLY slice of the 7-task spec. Backend audit-history / manual-observation operator stamping / Aurora resolve endpoints are explicitly **Phase 2** (see §Deferred).

## Why Phase 1 is frontend-only

Exploration (2026-07-14) found the spec was written against the running UI, but the audit/resolve backend is mostly absent:
- The **only** working status audit is the DynamoDB report action check-off (`toggle_action`, `lambda_fieldsight_api.py:609`) — it already records `checked_by`/`checked_at` **and returns them** to the frontend (`scripts/api/actions.js:115-116, 156-161`). The frontend currently **discards** them on the safety resolve path.
- Manual observations (`org.updateObservation`), Aurora `action_items`/`safety_observations`, and status **history/reopen** have **no** operator stamping and (for Aurora) no status endpoint at all. Those are Phase 2.
- So Phase 1 = everything achievable by reading data the backend **already returns** + pure CSS/interaction, covering the majority of the visible spec (P0 T3, P1 T1/T6-display/T7, P2 T2/T4) with zero backend risk.

## Global principles (Phase 1 interpretation)

- **G1 (audit display):** DISPLAY operator + timestamp wherever the backend already returns them (`checked_by`/`checked_at` from `toggleAction`). No new recording in Phase 1 — recording already happens for check-off. Manager visibility = show the operator/time inline on resolved rows. Manual-obs / Aurora recording = Phase 2.
- **G2 (Resolved sinks to bottom):** every list that displays both open and resolved items sorts Resolved to the end; unfinished items keep their existing relative order. Implemented as a stable sort comparator applied before render. (Today/Leftover behavior — see T7 open question.)

## Deferred to Phase 2 (NOT in this spec)

- Backend status-change **history table** + `GET .../history` read endpoint (T6 "full history incl Reopen").
- **Manual observation** operator stamping (`org.updateObservation` → `closed_by`/`closed_at`) — no backend column today.
- **Aurora** `action_items`/`safety_observations` status/resolve endpoints (none exist) — and the nightly 05:00 PROVISIONAL cascade-delete makes persistent audit of live items depend on authority-flip #27.
- Reading back the write-only DynamoDB `AUDIT#{date}` log (true per-toggle history).

---

## Tasks

### T3 — Timeline topic highlight readability (P0)
**Files:** `styles/tokens.css:354,673` (`--surface-selected`), `styles/composites.css:873-907` (`.fs-topic-card--selected`, `.fs-topic-card--flash`), `scripts/composites/topic-card.js:147-150` (className builder).
**Current:** the OPEN/selected topic gets `.fs-topic-card--selected { background: var(--surface-selected) }`. Dark mode `--surface-selected = rgba(255,217,102,0.15)` (semi-transparent yellow) with near-white `--text-primary` = unreadable. Always-on while selected (not hover). Deep-link `--flash` under `prefers-reduced-motion` pins a permanent pale-yellow bg (`--color-accent-100`, not theme-flipped) — same readability trap.
**Change (per approved "readable selected style"):**
- Selected state no longer uses a yellow fill. Give `.fs-topic-card--selected` a **readable** indicator: a left accent border (e.g. `border-left: 3px solid var(--color-accent-500)`) + a very subtle NEUTRAL surface tint (`--surface-selected-neutral`, theme-aware, NOT yellow), keeping `--text-primary` legible in both themes.
- Show the semi-transparent yellow ONLY on `:hover` (`.fs-topic-card:hover`), and ensure hover text stays readable (pin foreground if needed, per the CLAUDE.md not-theme-flipped trap).
- Fix the `--flash` reduced-motion branch to a readable static (neutral tint + readable text), not permanent pale-yellow-under-white.
**Test:** open a topic in dark + light mode → title/body readable; hover a non-selected card → yellow hover, still readable; reduced-motion deep-link → readable.

### T5 — Safety/Quality create buttons diagnose + fix (P0)
**Files:** `scripts/pages/safety.js:206-219` (`canCreate`, `+ Raise Observation`), `scripts/pages/quality.js:208-218` (`+ Log Item`), `scripts/composites/safety-create-modal.js:100-109,129-134` (sites load + validate).
**Confirmed symptom (user, 2026-07-14):** the button IS visible, but **clicking does nothing** — so this is NOT the role-gating/hidden-button case. The failure is on the `setShowCreate(true)` → modal-mount/render path: the modal never appears on click.
**Current:** real buttons are "+ Raise Observation" (safety.js:213) / "+ Log Item" (quality.js:213); onClick is `ctx.setShowCreate(true)`; the modal is conditionally mounted (`showCreate ? SafetyCreateModal/QualityCreateModal : null`) at safety.js:308-320 / quality.js:306-318.
**Change:** debug the click→modal path in the browser (console + React state): candidates — (a) `setShowCreate` state update not firing / `ctx` stale-closure so state never flips; (b) modal mounts but is invisible (z-index / portal / `display` / offscreen — check `ModalOverlay` styling); (c) a JS error inside `SafetyCreateModal`/`QualityCreateModal` render (e.g. `getSites()` throwing, siteId='') aborts the mount silently. Instrument with a console log at the onClick + at the modal's top render to localize, fix the root cause, and ensure a JS error inside the modal surfaces (ErrorBanner) instead of silently no-rendering.
**Test:** clicking "+ Raise Observation" / "+ Log Item" opens a visible, interactable create modal; a forced modal-internal error shows an ErrorBanner rather than a silent no-op.

### T1 — Leftover batch-select refactor (P1)
**Files:** `scripts/pages/today.js:1073-1075,1204-1226,1240-1301,1501-1549` (selection state, handlers, bulk bar, TaskCard props), `scripts/composites/task-card.js:92-120,131-148,158-181` (startCheckOff, circular check, square checkbox), `styles/composites.css:418-465` (`.fs-task-card__check` round / `.fs-task-card__select` square).
**Current:** Leftover TaskCards render BOTH a square bulk checkbox (`.fs-task-card__select`, only when `selectable`) and the round per-item resolve button (`.fs-task-card__check`). Bulk bar has Select-all / Resolve N / Clear.
**Change:**
- **Remove** the square checkbox UI (`.fs-task-card__select` render at task-card.js:180 + its prop plumbing); keep the round selector (`.fs-task-card__check`).
- Add a **"Batch Select"** toggle button at the top of the Leftover list. Off by default = normal (round button resolves the single item via `startCheckOff`). On = batch mode: the round selectors become multi-select toggles (selection map, not immediate resolve), the bulk bar appears with a batch action (Resolve N).
- **Keyboard:** `Shift+Click` = range-select from the last-clicked anchor to the clicked row (contiguous in the current rendered order); `Ctrl/Cmd+Click` = toggle just the clicked row. Plain click in batch mode = toggle the clicked row + set it as the new anchor.
- **Audit note:** the AUDIT requirement (G1) applies to the resulting **batch RESOLVE** (each item's `toggleAction` already logs `checked_by`/`checked_at` server-side) — NOT to transient selection/deselection (selection is UI-only state; logging every hover-toggle is out of scope/YAGNI). [Flag for spec review — see Open questions.]
**Test:** toggle Batch Select on → round selectors multi-select; Shift+Click selects a range; Ctrl+Click toggles one; Resolve N resolves all selected (each audited via existing check-off); square checkbox gone.

### T4 — Reusable multi-select for item lists (P2)
**Files:** new `scripts/composites/multi-select-list.js` (or a small hook `useMultiSelect`); consumers `scripts/pages/safety.js`, `quality.js` middle-column lists.
**Current:** No single reusable batch-select; T1 builds it ad-hoc in Today. Filtering is split across `TasksFilterChips` / `RangeToolbar` / `Select` — there is no unified "filter dropdown" to multi-select.
**Change:** extract T1's batch-select interaction (mode toggle + Shift/Ctrl selection + bulk action bar) into ONE reusable unit, and apply it to the Safety and Quality middle-column lists (a "Multi-Select" toggle + batch action, e.g. batch Mark-Resolved for report-derived rows via the existing `toggleAction`). SCOPE NOTE (YAGNI): Phase 1 covers **item lists** (Leftover/Safety/Quality) where batch status-ops are meaningful. **Filter-dropdown** multi-select (turning single-select filter chips into multi-select) is deferred unless requested — it changes filter semantics for little gain.
**Test:** Safety and Quality lists gain a Multi-Select toggle reusing the same component as Leftover; batch Mark-Resolved works for report-derived rows.

### T6 (Phase 1 slice) — Safety resolved operator display (P1)
**Files:** `scripts/pages/safety.js:429-474` (`toggleResolve` — currently discards response at 466-467), `safety.js:648-684` (detail `DetailRow` list — add a "Resolved by" row), `scripts/composites/safety-flag-row.js:76` (row shows only "raised by"); mirror the pattern at `scripts/composites/action-item-row.js:191-198` ("Checked by X · time").
**Current:** For report-derived flags, `toggleResolve` calls `toggleAction` which RETURNS `checked_by`/`checked_at`, but the `.then()` throws the response away. No "Resolved by/at" is shown anywhere on safety.
**Change (report-derived flags/observations only):**
- In `toggleResolve`, read `res.checked_by` / `res.checked_at` from the `toggleAction` response and store them on the local row/`sel` state.
- Render "由 [checked_by] 于 [checked_at] 解决" (localized "Resolved by X · <time>") in the safety detail panel (new `DetailRow`) and optionally on the resolved row in the list, mirroring `action-item-row.js:191-198`. On Reopen, clear the display (show nothing) — per spec "frontend shows only the latest Resolved operator".
- **Manual observations** (`toggleManualStatus` → `org.updateObservation`) carry no operator today → they show no resolver in Phase 1 (Phase 2 adds backend stamping). Explicitly documented, not silently blank.
**Test:** resolve a report-derived safety flag → detail shows "Resolved by <name> · <time>"; Reopen → display clears; manual observation → no resolver shown (documented).

### T7 + G2 — Resolved sort-to-bottom + visual distinction (P1)
**Files:** `scripts/pages/safety.js:56-65,358-388` (groupByDate + row render), `quality.js:45-54,349-398`, `scripts/composites/topic-card.js:245-259` (timeline action items), `scripts/pages/tasks.js:332-336` (already sinks — reference impl), `styles/composites.css` (new resolved-row style), `scripts/pages/today.js:619-621` (Leftover currently DROPS resolved — see Open questions).
**Current:** only `tasks.js` sinks done-to-bottom; `safety`/`quality`/`timeline` interleave; styling is at most a status Badge (quality/tasks), none on safety list; Today drops resolved entirely.
**Change:**
- **Sort (G2):** add a stable comparator to safety, quality, and timeline-topic-action lists: resolved/closed items sort AFTER unfinished ones; within each group, preserve existing order (date desc etc.). Reuse the tasks.js comparator shape (`if (a.resolved !== b.resolved) return a.resolved ? 1 : -1`).
- **Style (T7, do both):** resolved rows get (1) a muted background (theme-aware low-contrast gray, e.g. `--surface-resolved`) AND (2) strikethrough on the primary text (reuse `.fs-action-item-row--checked` line-through pattern, composites.css:791-794). One shared class `.fs-row--resolved` applied across lists.
**Test:** in safety/quality/timeline, resolved rows sink to the bottom, greyed + struck-through, unfinished order unchanged.

### T2 — Today button width unify (P2)
**Files:** `styles/composites.css:169-170` (`.fs-today__timeline-link { width:50%; min-width:220px }`), `composites.css:1052` (`.fs-timeline-page__back { width:100% }`).
**Current:** the two buttons share a skin but differ: 50%/min-220px vs 100%.
**Change:** unify to one width rule so they're visually equal. Recommended: both `width:100%` within their container (or both the compact 50%/min-220px) — pick whichever reads as one button family (the composites.css:156-158 comment says they should read as one family). Deliverable: equal width, aligned.
**Test:** "Open Task List" and "Back to Today" render the same width.

---

## Current-user identity & audit-source rules (must honor)

- Operator-for-display comes from the **API response** (`checked_by`/`checked_at`), NOT a local `AuthMock.currentUser`/`session` read — per the "owner ≠ caller" guardrail (CLAUDE.md; `scripts/api/actions.js:154`). Never derive `user_folder` from the current user.
- Live user: `window.FS.session.user`; mock: `window.AuthMock.currentUser`.

## Conventions (from CLAUDE.md — binding)

- BEM `.fs-{block}__{element}--{modifier}`; tokens only (no hardcoded color/spacing); `tokens.css` ↔ `fs-globals.js` mirrored; bump `?v=N` cache-busters in preview HTMLs for touched files; `node --check` every touched JS; register any new L5 composite in `components-preview.html`; every `@keyframes` needs a `prefers-reduced-motion` override; status color tokens are NOT theme-flipped (pin foregrounds).

## Resolved decisions (user-confirmed 2026-07-14)

1. **Today/Leftover resolved (G2):** DECISION (a) — Today/Leftover keep their current DROP behavior (resolved items leave the rolling list). The G2 sink-to-bottom applies only to the persistent lists: **safety, quality, timeline** (and tasks, already done). Today/Leftover are out of scope for the sink change.
2. **T1 selection logging:** confirmed — audit the resulting batch RESOLVE (each item's `toggleAction` already logs `checked_by`/`checked_at` server-side). Transient select/deselect UI state is NOT logged.
3. **T5 symptom:** confirmed — button visible, click does nothing → debug the `setShowCreate → modal mount/render` path (see T5).
