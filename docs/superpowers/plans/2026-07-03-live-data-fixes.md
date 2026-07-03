# Live-Data Mismatch Fix Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Fix the five live-data issues found in user testing: topic Ask failing, empty transcript UX, safety/quality flags impossible to close + broken source-report deep link, search not finding topics, range-picker highlight too subtle.

**Verified root causes (2026-07-03, all confirmed live):**
- Topic-level Ask uses `scope:'transcript'`; Feb/Mar transcripts NO LONGER EXIST in S3 (only Apr-Jun, under other users) → agent finds nothing. Report text DOES exist (report-scope ask answers fine with explicit user).
- Admin-without-`&user=` path ships `user: undefined` to /api/ask → backend resolves to the admin's own (empty) folder.
- Safety/Quality status is a hard-coded `'open'` literal (compliance-aggregator.js:226,251); no join with /api/actions exists; nothing can ever close. Deployed `toggle_action` accepts ARBITRARY `action_index` strings (SK f-string, no validation) → flags can piggyback the existing endpoint with `action_index:'flag_<idx>'`.
- Timeline deep-link parses `?topic=` via `parseInt` then `===` against report topic_ids; real ids may be strings → silent no-match (timeline.js:224-236,377-399,602).
- Search palette indexes only task/safety/site/user (TYPE_ORDER search-palette.js:31) — topics never indexed.
- Calendar dots WORK (verified live: March 2026 grid = 4 density + 1 safety dot) — no change needed.
- Range fill uses `color-mix(var(--surface-selected) 30%, transparent)` inline — too subtle.

## Global Constraints

- Repo conventions binding (fieldsight-ui/CLAUDE.md): no build step, IIFE, `node --check` every changed JS, cache-busters bumped at the end (final wiring task), tokens-only styling, hooks rule (React.createElement, never inline calls).
- Branch `claude/live-data-fixes` off `dev`. NEVER `git add -A`. Controller pushes.
- Action-key contract (existing, do not change): checked map from GET /api/actions is keyed `<topic_id>_<action_index>` (actions.js:35-37 actionKey). Flag rows extend the SAME namespace: topic flags → `action_index = 'flag_<idx>'`; report-level observations (topic_id -1) → `action_index = 'obs_<idx>'`.
- Deep-link matching must be STRING-based everywhere (`String(a) === String(b)`); never parseInt topic ids.
- Do not modify backend/Lambda anything — UI only.
- Recon anchors: timeline.js:224-236,240-243,377-399,602,622-633,645-657,690-699,920,928-933,944-984 · compliance-aggregator.js:226,237,251 (+_AUDIT-2 at 76-83) · safety.js:73,377,456-478,485-487,617-621 · quality.js analogous · search-palette.js:31,42-84,90-154,206-211,234-267,444-472 · transcript-list.js:57-79 · actions.js:35-46 · range-toolbar.js (inline range fill).

---

### Task 1: Ask reliability + deep-link string ids + transcript empty-state honesty

**Files:** Modify `scripts/pages/timeline.js`, `scripts/composites/transcript-list.js`.

1. Topic-level Ask tab (timeline.js:973-984): `scope: 'transcript'` → `'both'` (agent falls back to report text when transcripts are gone; keep `topic_id` so it stays topic-focused). Meeting Ask tab already 'both' — leave.
2. Report-level Ask card (timeline.js:645-657): `user: user` → `user: user || (report && report.user_name && window.FS.api.folderName(report.user_name))` (kills the admin-undefined path once a report is loaded).
3. Deep-link: timeline.js:224-236 stop `parseInt` for `params.topic` — keep raw string (`targetTopicId = params.topic || null`); `targetFlagIdx` stays numeric. Matching at :377-399 and :602: `String(t.topic_id) === String(targetTopicId)`.
4. transcript-list.js: in live mode, when the response has no segments, render the backend's `message` if present, else "No transcripts available for this date — recordings may have been archived." (tokens-only styling, match existing empty-state pattern in the file).

Verify: `node --check` both; grep shows no `parseInt(params.topic`. Commit: `fix(live): topic ask scope both + admin user fallback + string topic ids + honest transcript empty state`

### Task 2: Safety/Quality close-the-loop (resolve/reopen on flags)

**Files:** Modify `scripts/api/compliance-aggregator.js`, `scripts/pages/safety.js`, `scripts/pages/quality.js`.

1. compliance-aggregator: during fanout, for each date also fetch `FS.api.actions.getActions({date})` (parallel with the timeline call; tolerate failure → empty map). Join per row instead of the literal:
   - topic flag rows (:251): `status: checkedMap[t.topic_id + '_flag_' + idx] && checkedMap[...].checked ? 'resolved' : 'open'` (+ carry `resolved_by/resolved_at` from checked_by/checked_at when present)
   - observation rows (:226): same with key `'-1_obs_' + idx` (match however the row's topic_id/-1 convention is expressed at that site — read the code, keep the row `id` format unchanged).
2. safety.js detail panel (near statusBadge :485-487): add a primary action button "Mark resolved" / "Reopen" (per current status) calling `FS.api.actions.toggleAction({date: sel.date, topic_id: sel.topic_id, action_index: (sel.source === 'topic_flag' ? 'flag_' : 'obs_') + <idx from sel.id>, checked: <true|false>, action_text: sel.observation || sel.text})`, optimistic-update the row status, revert on reject (mirror action-item-row.js's optimistic pattern). Live mode only gate NOT needed — toggleAction has a mock fallback.
3. quality.js: identical treatment for its flag rows.
4. `totalsFromRows` (safety.js:73) then counts resolved rows naturally — verify it reads `'resolved'`.

Note: checking a report ACTION ITEM does not and cannot auto-close a safety flag — no data link exists between the two arrays. This adds explicit flag-level resolve, which is the honest capability.

Verify: `node --check` all three. Commit: `feat(compliance): flag resolve/reopen via actions-toggle piggyback + status join`

### Task 3: Search palette topic index + range highlight visibility

**Files:** Modify `scripts/composites/search-palette.js`, `scripts/composites/range-toolbar.js`, `scripts/composites/date-picker.js`, `styles/composites.css`.

1. Palette: add `'topic'` to TYPE_ORDER (:31); in `_loadCache` (:42-84) fan out `FS.api.window.getSpan()` dates (hasReport only) × `FS.api.timeline.getTimeline({date, user})` — non-admin: own folder; admin: skip fan-out when >30 date×user pairs (cap; log to console.debug) — collect `{title: topic.title, snippet: (topic.summary||'').slice(0,80), date, user, topic_id}`; `_search` matches title+summary; result routes to `/timeline?date=<date>&user=<user>&topic=<topic_id>` (STRING id untouched). Cache stays session-once; tolerate per-date fetch failures.
2. Range highlight: replace the inline `color-mix` fill in date-picker.js range mode with class `fs-date-picker__cell--in-range`; add to composites.css: background `var(--color-accent-100)`, and `[data-theme="dark"]` override with a visible dark-mode tint + `color: var(--color-neutral-900)` per the yellow-background rule if the accent ramp is used. Endpoints keep the existing selected styling. Bump composites.css `?v=` in the FINAL wiring step, not here.
3. range-toolbar.js: if it duplicates the fill inline, switch to the same class.

Verify: `node --check` the three JS. Commit: `feat(search): topic index in palette + visible range highlight`

### Task 4 (controller): wire + deploy + in-browser verification

Bump cache-busters for all changed files (+composites.css), merge to dev, push, wait Amplify SUCCEED, verify in Chrome: topic Ask answers from report text on 2026-03-02; deep link from a Safety flag opens+flashes the right topic; Mark resolved persists across reload and shows in totals; palette finds "concrete"/"defects" topics; range fill clearly visible. Then hand to user.
