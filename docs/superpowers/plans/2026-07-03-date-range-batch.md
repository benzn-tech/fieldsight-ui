# Date-Range & Historic-Data UX Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Make every aggregate surface (Safety/Quality/Evidence/Insights/Today/Search) reach the REAL historic data (reports exist only 2026-02-09…2026-03-20 while "today" is July) via a shared data-span layer + hotel-style date-range selection, and give Search a hand-off into the live Ask agent.

**Root cause (verified):** `GET /api/dates?months=N` is a trailing lookback from today (`lambda:301-304`, no cap on N). Every UI surface calls it with months:1–3, so in July the Feb/Mar dates are never even fetched. The DatePicker itself (`monthsRange:3`) can't reach them either. Fix = widen data discovery once, then let pages select ranges.

**Non-goal:** performance優化 of the per-date fan-out — Phase 4's Postgres read model replaces it wholesale. Data is 5 report-days today; 'All' is cheap.

## Global Constraints

- Repo conventions binding (fieldsight-ui/CLAUDE.md): no build step, IIFE modules, `node --check` every changed JS, bump `?v=N` in app-shell-preview.html for every changed loaded file (final task batches bumps), tokens-only styling, reduced-motion respected, `React.createElement` style of surrounding code.
- Branch: `claude/date-range-batch` off `dev`. NEVER `git add -A`. CRLF warnings normal. Do not push (controller pushes).
- `MONTHS_LOOKBACK = 24` is the one wide-discovery constant (lives in the new data-window module). All widened call sites use it — no scattered magic numbers.
- Existing single-date DatePicker callers must keep working unchanged (backward-compatible props).
- localStorage keys for per-page range prefs: keep existing `fs.settings.safetyView` / `fs.settings.qualityView` keys but extend value shape `{mode, day, from, to}`; new pages use `fs.settings.evidenceView` / `fs.settings.insightsView`. Tolerate old stored shapes (missing fields → defaults).
- Recon anchors (verified 2026-07-03): today.js:125,155,198,204-233,497-506,550-565 · safety.js:33,93-140,227-237,391 · quality.js:24,98,133-140,379 · evidence.js:38,114,121-125,196 · insights.js:39-55,69,90-100,160-163 · insights-aggregator.js:203-206 · compliance-aggregator.js:136-186 (getDates months:3 at :137) · date-picker.js:24-28,92,114-199,202-205,226,267,311-358 · search-palette.js:42-75,46-47,81-145,202 · ask.js:14-27 · ask-chat.js:80-86 · timeline.js:625-637.

---

### Task A: data-window foundation + DatePicker range mode

**Files:**
- Create: `scripts/api/data-window.js` (`window.FS.api.window`)
- Modify: `scripts/composites/date-picker.js`
- Modify: `scripts/api/compliance-aggregator.js:137` (months:3 → MONTHS_LOOKBACK via FS.api.window)

**Interfaces produced:**
```js
FS.api.window.MONTHS_LOOKBACK            // 24
FS.api.window.getSpan()                  // Promise<{dates, earliest, latest}> — cached in-memory;
                                         // dates = getDates({months:24}) map; earliest/latest = min/max hasReport keys (null if none)
FS.api.window.resolve(preset, custom, span)  // pure: 'today'|'7d'|'30d'|'all'|'custom' → {from,to}
                                         // 'all' → {from: span.earliest, to: span.latest}; 'custom' → {from:custom.from,to:custom.to}
                                         // '7d'/'30d' → trailing from todayNZDT(); 'today' → single day
```
DatePicker (backward compatible): existing props unchanged; NEW props `range:true, from, to, onRangeChange(from,to)` — MonthGrid click-click (first click = from, second = to; click before from restarts; same-day allowed). Default `monthsRange` 3 → `FS.api.window.MONTHS_LOOKBACK` (date-picker.js:204) so the calendar reaches historic months (month grid must allow paging back across all months in span).

**Steps:** implement data-window.js (IIFE, uses FS.api.dates.getDates + todayNZDT/addDaysISO; cache promise so concurrent callers share one fetch) → `node --check` → extend date-picker.js (range selection state in MonthGrid; visual: reuse selected-day styling for endpoints + a light `--surface-selected` fill for in-between days; strip unchanged for single mode) → `node --check` → widen compliance-aggregator.js:137 to use `window.FS.api.window.MONTHS_LOOKBACK` (fallback 24 if module absent) → commit `feat(window): data-span layer + DatePicker range mode + wide discovery`.

---

### Task B: RangeToolbar + Safety/Quality/Evidence/Insights integration

**Files:**
- Create: `scripts/composites/range-toolbar.js` (`window.FieldSight.RangeToolbar`)
- Modify: `scripts/pages/safety.js`, `scripts/pages/quality.js`, `scripts/pages/evidence.js`, `scripts/pages/insights.js`

**RangeToolbar contract:** props `{value:{preset,from,to}, onChange(next), presets?:['today','7d','30d','all','custom'], storageKey}` — renders preset chips + for 'custom' opens the range DatePicker in a modal; persists to localStorage[storageKey]; on mount, restores stored value (tolerating legacy shapes); resolves 'all' via FS.api.window.getSpan(). Styling mirrors the existing safety toolbar chips (safety.js:227-237 vicinity).

**Page integrations (each: replace hand-rolled window with RangeToolbar-driven {from,to}):**
- safety.js/quality.js: default preset **'all'**; keep everything downstream (getSafetyRange/getQualityRange({from,to})) unchanged.
- evidence.js: replace `getDates({months:1})+slice(0,daysToLoad)` day-listing with: resolve {from,to} via toolbar (default 'all'), filter span dates to range, keep the existing 3-at-a-time load-more pagination WITHIN the selected range (evidence.js:38,114-125,196).
- insights.js: keep 'Last 7 days'/'Last 30 days' chips, ADD 'All'/'Custom' via RangeToolbar presets; prior-period delta only computed for 7d/30d (insights.js:48-55) — for all/custom pass no prior range and hide delta badges (guard where deltas render).

**Steps:** range-toolbar.js → node --check → integrate 4 pages one at a time, `node --check` each → commit `feat(range): RangeToolbar + safety/quality/evidence/insights on data-span windows`.

---

### Task C: Today empty-state CTA + Search→Ask handoff

**Files:**
- Modify: `scripts/pages/today.js` — (a) :198 `getDates({months:3})` → span via FS.api.window (so `findLatestReportDate` reaches Feb/Mar); (b) thread `latest` into the `status:'empty'` branch (:497-506) and render a "View latest report (<date>)" CTA reusing the OK-branch deep-link pattern (:550-565). Guard: only when latest exists.
- Modify: `scripts/composites/search-palette.js` — (a) cache window :46-47 from `today-14` → span.earliest..today; (b) when the query is non-empty, append a final result row `Ask FieldSight: "<query>"` which stores the query at `sessionStorage['fs.ask.prefill']` and routes to `/timeline?date=<span.latest>&user=<currentUserFolder>` (worker/site_manager: own folder; admin: Jarley_Trainor as the seeded default — read from the palette's existing user context if available).
- Modify: `scripts/pages/timeline.js` — at the report-level AskChat mount (:625-637), read-and-clear `sessionStorage['fs.ask.prefill']` and pass it as `initialQuestion` prop.
- Modify: `scripts/composites/ask-chat.js` — accept optional `initialQuestion` prop: prefill the input once on mount (do NOT auto-send).

**Steps:** today.js → palette → ask-chat/timeline → `node --check` all four → commit `feat(ask): Today latest-report CTA + search palette Ask handoff`.

---

### Task D (controller): cache-busters + merge + live browser verification

Bump `?v=N` for every JS changed in A-C (data-window.js & range-toolbar.js enter at v=1 with new tags — data-window after api/index.js & dates.js; range-toolbar with other composites, BEFORE the pages that use it). Merge to dev, push, wait Amplify SUCCEED, then verify in Chrome (controller): Safety default 'all' shows Feb/Mar flags; custom range narrows; Evidence photos for 2026-03-02; Insights 'All'; Today shows CTA; palette finds a task + Ask row prefills the Timeline ask box.
