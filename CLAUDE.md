# FieldSight UI — Claude Memory

## What this is

FieldSight is a field-management app for construction sites (Procore/Aconex
lineage, NZ context). This repo is the **UI prototype**: pure HTML + CSS +
browser-side React (Babel transpiled in-browser, no build step). Open the
preview HTMLs directly or via `python3 -m http.server`.

The prototype's job is to validate visual language, component shape, and
interaction patterns before any backend wiring.

## Architecture · Layer Model

The codebase is organised into 7 layers, lower layers know nothing about
higher ones:

| Layer | Name | Lives in | Status |
|---|---|---|---|
| **L1** | Design tokens | `styles/tokens.css` (CSS custom properties) + `fs-globals.js` (JS mirror) | ✅ Sprint 0 |
| **L2** | Visual language | Color palette, typography, spacing decisions — embodied in L1 | ✅ Sprint 0 |
| **L3** | App shell | `scripts/app-shell.js` + `styles/app-shell.css` (3-pane layout, drag divider, role-based nav) | ✅ Sprint 1 |
| **L4** | Base components | `scripts/components/` + `styles/components.css` — Button, Input, Card, Badge, Avatar | ✅ Sprint 1 |
| **L5** | Composite components | `scripts/composites/` — TaskCard, StatCard, Timeline, MorningBriefCard, etc. | 🟡 Sprint 2 |
| **L6** | Pages | `scripts/pages/` — Today registered; Tasks/Safety/Sites/etc. coming | 🟡 Sprint 1 partial / Sprint 3+ |
| **L7** | Interactions | Inline within components/pages — task check-off animation, micro-interactions | 🟡 Sprint 2 + Sprint 5 |

## File Structure

```
.
├── CLAUDE.md                           ← this file
├── PLAN.md                             single-source action ledger (completed/pending/traps/questions)
├── README.md                           (placeholder)
├── tokens-reference.html               L1 token doc with live demos
├── components-preview.html             L4 + L5 component showcase
├── app-shell-preview.html              L3 + L6 full-app preview (also `?dev=1`, `?demo=1`, `?mocks=0`)
├── styles/
│   ├── tokens.css                      L1 — CSS custom properties (single source of truth)
│   ├── components.css                  L4 — `.fs-{name}` BEM
│   └── app-shell.css                   L3 — shell + utility + popover + bottom-nav + print
└── scripts/
    ├── fs-globals.js                   L1 mirror to JS — tokens + roles + nav + canSeeNav
    ├── theme.js                        Sprint 7 — Light / Dark / Auto persistence
    ├── density.js                      Sprint 7.6 — Comfortable / Compact persistence
    ├── router.js                       hash routing + Sprint 8.4.4 swipe-back
    ├── auth-mock.js                    mock current-user
    ├── auth/                           Sprint 8.0 — Cognito + session
    ├── roles.js                        7 hierarchy + 3 specialist roles, perms, canDo
    ├── api/                            backend-shaped data layer (Sprint 2 onwards)
    ├── mock/                           fixtures: sites · daily-report · dates · programme · media · …
    ├── drag-divider.js                 middle-column resize
    ├── left-nav.js                     L3 — sidebar with sections/subgroups
    ├── app-shell.js                    L3 — shell, MiddleColumn, RightDetail, BottomNav, Weather, offline banner
    ├── dev-role-switcher.js            dev-only role switcher (?dev=1) + MOCK/LIVE badge
    ├── components/                     L4 — button, input, card, badge, avatar
    ├── composites/                     L5 — task-card, urgent-card, kpi-strip, topic-card, gantt-row,
    │                                       safety-flag-row, action-item-row, modal-overlay, right-drawer,
    │                                       date-picker, photo-grid, evidence-tabs, programme-task-editor,
    │                                       programme-import-modal, programme-kanban-board, demo-tour,
    │                                       error-banner, over-allocation-banner, tooltip, toast,
    │                                       safety-create-modal, quality-create-modal, search-palette,
    │                                       onboarding-overlay, …
    └── pages/
        ├── _page-registry.js           route → { Provider, Middle, Right }
        └── today / timeline / tasks / sites / programme / safety / quality / reports / evidence /
            activity / team / settings
```

## Conventions

- **BEM**: `.fs-{block}__{element}--{modifier}` (e.g. `.fs-card__header`,
  `.fs-task-row--mine`).
- **Tokens only**: never hardcode color/spacing/font; use CSS custom
  properties from `tokens.css`. JS code reads from `window.FS.tokens`.
- **Token sync**: `tokens.css` and `fs-globals.js` are mirrored manually.
  When you edit one, edit the other.
- **Component export**: each component file IIFEs and attaches to
  `window.FieldSight.{Name}` (e.g. `window.FieldSight.Card`).
- **Pages register**: `window.FieldSight.PAGES['/route'] = { Middle, Right }`.
  AppShell looks up via `window.FieldSight.getPageForRoute(route)`.
- **Babel in-browser**: `<script type="text/babel">` is fine; JSX optional.
  Most files use `React.createElement` directly to avoid Babel parse cost.
- **Reduced motion**: respected globally via `@media (prefers-reduced-motion:
  reduce)` in `tokens.css` (~line 627). Any new animation must check too.
- **Cache busters**: the `?v=N` numbers exist for `file://` and dev servers —
  bump one when you change the file it loads, so a local preview picks the
  change up. They are NOT what protects deployed users: `amplify.yml` rewrites
  every `?v=` in `dist/*.html` to the build's commit id, so a deploy can never
  serve a stale asset regardless of what anyone remembered to bump. Forgetting
  a bump now costs a local reload, not a customer stuck on old code.
- **No build step**: don't introduce npm/webpack/vite. The whole point of the
  prototype is to stay editable in any text editor.

## Commands

```bash
# Local preview (any of the 3)
python3 -m http.server 8765
# then open http://localhost:8765/app-shell-preview.html

# Syntax-check JS
node --check scripts/path/to/file.js

# All-in-one syntax check
for f in scripts/**/*.js; do node --check "$f"; done
```

No tests, no linter, no formatter configured. JS is plain ES2017+ (browsers
supported are evergreen).

## Design System Quick Reference

- **Primary navy** `#102A43` (Procore/Aconex lineage), **safety orange**
  `#FF6B35` accent (hi-vis construction norm).
- **Status colors split intentionally**: `blocked = magenta` (functional
  "halt") vs `overdue = red` (temporal urgency) — never reuse one for the
  other.
- **Touch targets**: 44 / 48 / 56 px (field default 48 — gloved-hand safe).
- **Typography**: Inter (sans), JetBrains Mono (code/technical IDs).
  `.type-stat` has `font-variant-numeric: tabular-nums` for KPI alignment.
- **Dark mode**: blue-tinted near-black surfaces; defined in `tokens.css`
  under `[data-theme="dark"]`. Sprint 6 polishes.

## Sprint Roadmap

| Sprint | Theme | Status |
|---|---|---|
| **0** | L1 tokens + L2 visual language + `tokens-reference.html` | ✅ done |
| **1** | L4 atoms + L3 AppShell + Today lo-fi (1.5–1.6 hotfixes) | ✅ done |
| **2** | Backend-shaped data layer (Phase A–I); Today derived from real `DailyReport`; Ask agent | ✅ done |
| **3** | Polish backlog after Phase-I review (P-01 … P-12) | ✅ done |
| **4** | Core operational pages — Sites, Programme MVP, Tasks aggregator, Reports, Evidence, Activity, Weather UI | ✅ done |
| **5** | Programme operability — drag/edit, kanban, CSV/MS-Project XML import, role gates | ✅ done (PR #15) |
| **6** | Compliance pair — `/safety` + `/quality` + deep-link spotlight + photo carousel | ✅ done (PR #16) |
| **7** | `/team` + `/settings` + dark-mode polish (theme + density + default-landing prefs) | ✅ done (PR #17) |
| **8** | Backend integration foundation, write flows, programme deep features, mobile bottom-nav, a11y, search, error/offline, performance, fixture expansion, demo tour, print/share, onboarding | ✅ done (PR #18) |
| **9** | Insights dashboard (PM-facing safety/quality analytics) + PM-scoped Team page + Strategic dashboards (Portfolio / Regional / Executive) | ✅ done (PR #19) |
| **10** | Library / Template UI (B.0–B.6) + 3-panel → 2-panel migration + /library polish (Test render scroll/modal, tab reorder, Favourites shelf, drag-nest editor) | 🟡 on `claude/sprint10-prep` (Sprint 10 + follow-up fixes) |
| **11** | A11y hardening (axe-core gate + contrast + SR checklist) + XLSX column-mapper partial mapping + Tasks cross-day audit (Q-1: weekly KPI + history drawer) | 🟡 on `claude/sprint11` (rebased onto latest sprint10-prep) |

Detailed completed/pending/next-phase tracking lives in **`PLAN.md`**.

## Current State

- **`main` IS PRODUCTION.** Amplify app `d2fssznicvuckr`: branch `main` =
  PRODUCTION (`main.d2fssznicvuckr.amplifyapp.com`, autoBuild ON, prod org
  gateway `ys94qy2tk0`, `FS_USEMOCKS=false`); branch `dev` = DEVELOPMENT.
  **Merging to `main` deploys to the customer site within ~1-2 min** — there
  is no approval gate. Env is injected at build time by `amplify.yml` into
  `/env.js` (root, not `scripts/`).
- **Shipped 2026-07-31/08-01**: QR terminal sign-in (PR #141 — Settings →
  "Log in a terminal" mints a one-time code the F2SP scans; QR is **prod-only**
  because the backend code table is prod-gated, so it cannot be exercised on
  `dev`). Login-screen dark-theme contrast fixes + the "Sight" brand-accent
  wordmark (PRs #144/#146/#147).
- **Active branches**:
  - `claude/sprint10-prep` — Sprint 10 + Sprint 10 follow-up fixes (library
    drag/promote, today CTA + 3-panel revert, activity width cap, insights
    warning hue, onboarding route-gate). HEAD `3ecdd49`.
  - `claude/sprint11` — fast-forwarded onto `sprint10-prep` HEAD so it now
    carries **both** the Sprint 11 work (A11y axe-core gate + contrast
    tokens, XLSX partial column-mapping, Tasks cross-day audit Q-1) **and**
    every Sprint 10 follow-up fix above. The two branches currently point
    at the same tree; future Sprint 11.x work continues on `sprint11`.
- **Open PRs**: none — Sprint 10 follow-ups + Sprint 11 ready to PR when
  the user calls them. (Sprint 11's original sub-sprint commits already
  landed on `sprint10-prep` via PR #20.)
- **Next**: see `PLAN.md` §6 Next phase candidates

## Known traps & guardrails

Mirrors `PLAN.md` §3. Each is a real bug that shipped and got fixed;
re-introducing one is the most common way to break the prototype.

### Registration & load order

Both of these pass every unit test and fail only in the browser. A green
`node --test` run says nothing about whether a module is reachable at runtime.

- **`FS.api` is assigned WHOLESALE by `scripts/api/index.js:87`**
  (`window.FS.api = { … }`). Any module registering onto `FS.api` from a
  `<script>` tag placed *before* that line is **silently wiped** — no error at
  load, just `Cannot read properties of undefined` from the first consumer.
  Load new `FS.api` modules in the api block, after `api/index.js`. Registering
  onto `window.FieldSight` instead is unaffected (composites do that).

- **`scripts/roles.js` is NOT loaded by `app-shell-preview.html`.** It is an ES
  module; the registry the nav actually renders from is `NAV_ITEMS` in
  **`scripts/fs-globals.js`**, which also carries each item's `path`. Adding a
  nav entry to `roles.js` alone produces no error and no nav item — and if the
  `left-nav.js` group already lists the key, the group looks correct while the
  item simply never exists.

### Date math

- **BUG-19 NZDT**: never `new Date('YYYY-MM-DD')` (parses as UTC,
  drifts a day in NZ). Use `FS.api.todayNZDT()` /
  `FS.api.addDaysISO()` / `FS.api.folderName()`.

### Network

- **BUG-20 CloudFront SPA fallback**: a 200 with `text/html` body is
  the SPA shell, not JSON. `_fetch.js:isJsonResponse()` guards it;
  never bypass.
- **BUG-21 audio paused-ref**: don't read `audioRef.current.paused`
  — track play state in React state.

### Theming

- **JS-mirrored hex tokens bypass `[data-theme]`**. `t.surface.X` /
  `t.border.X` / `t.text.X` from `fs-globals.js` are baked
  light-mode hex. In React `style={{ ... }}` use string literals:
  `style={{ background: 'var(--surface-panel)' }}` — never
  `t.surface.panel`.
- **Palette-scale tokens are not theme-flipped either** —
  `--color-{primary,accent,success,danger}-{50…900}` are fixed hex. Only
  the *semantic* tokens (`--text-*`, `--surface-*`, `--border-*`) flip.
  Using a scale token as a foreground silently breaks one theme:
  - 2026-08-01, login screen: the wordmark used `--color-primary-900`
    (#102A43) which sits on `--surface-app` (#0A1018) in dark at **~1.15:1**
    — invisible. Same screen, `.fs-login__success` paired `--text-success`
    (which *does* flip, to a light green) with `--color-success-50`
    (#F0FDF4, which does not) → light-on-near-white.
  - **Remedy** (used there): keep the light rule and add a
    `[data-theme="dark"] .fs-X { color: … }` override.
  - **Yellow is a special case**: `--color-accent-500` (#FFD966) is
    ~1.4:1 on white — `tokens.css` says so inline. It can only be a
    foreground on dark surfaces; on light, step down the ramp
    (`accent-800`/`-900`). The login wordmark's "Sight" does exactly
    this — brand yellow in dark, amber in light.
- **NavIcon SVG `var()` resolution**: `svg.setAttribute('stroke',
  'var(...)')` does **not** resolve. Use `svg.style.stroke = color`.
- **Status colour tokens are not theme-flipped** (`--color-{success,
  info, warning, danger}-{50,100}`). On dark mode their light-pastel
  backgrounds with global white text are unreadable. Pin
  foreground via `[data-theme="dark"] .fs-X { color:
  var(--color-neutral-900) }`.
- **SAFETY = red, QUALITY = blue** is the canonical semantic
  pairing across the app (`/safety`, `/quality`, `/insights`
  insights tags, badges, KPI tiles). Don't break it by re-paletting
  one of those domains. Specifically:
  - All safety-domain chart fills + tag colours pull from
    `--color-danger-700` (light) / `--color-danger-300` (dark)
    via the `--fs-tag-{slug}` and `--fs-chart-danger` tokens.
  - All quality-domain chart fills + tag colours pull from
    `--color-info-700` / `--color-info-300`.
  - **Never pair red with deep-orange in the same chart** — they
    fail at `<= 1024px` widths and confuse colour-blind viewers.
    Sprint 9.5.7's 12-hue categorical experiment failed this and
    was reverted in 9.5.8.
  - "Other" categories (subcontractors, projects, regions,
    programme tasks) are free to use varied hues from the
    `--fs-chart-{tone}` token family, since they aren't bound
    to safety/quality semantics.

### Selection / focus

- **`:focus` paints on mouse click**; produces "double-border" with
  `--selected`. Use `:focus-visible` for inset outlines.
- **`.fs-card--clickable:focus-visible` halo + `--selected`** also
  stack. Suppress halo when also selected.
- **Unified selection token**: `--surface-selected` (theme-aware) is
  the canonical "selected row bg". Don't reach for
  `--color-accent-50` directly — it reads as salmon on dark.

### Persistence / mocks

- **Don't ship UI write actions before the matching backend exists**
  (Sprint 5 lesson). Mocks lie; integration bites. Sprint 8 gates
  writes on `useMocks` and ships real PATCH/POST/DELETE shapes.

### Token / cache hygiene

- **Token sync**: `tokens.css` and `fs-globals.js` are mirrored
  manually. Edit one → edit the other.
- **Cache busters**: bump `?v=N` in preview HTMLs whenever a loaded
  `.js` / `.css` changes — this is for LOCAL previews only. Deploys are
  stamped with the commit id by `amplify.yml`; the hand-maintained numbers
  never reach a customer's browser. Before that stamping existed, a missed
  bump left users on cached code that survived even a hard reload (Babel
  fetches `type="text/babel"` scripts by XHR, which the reload's cache
  bypass does not reliably reach) — the only cure was closing the browser.

### Mobile-only floating UI clusters

- **Wrap a React.Fragment of `position: fixed` siblings in a single
  portal `<div>`** (`display: none` desktop, `display: contents`
  mobile). BottomNav was a Fragment of backdrop + sheet + nav;
  hiding only the `<nav>` left the sheet visibly leaking into the
  desktop sidebar. One container = one toggle = no gaps.

### Admin permission flow

- **Aggregator pages must explicitly fan out across all users when
  the caller is admin.** `getTimeline(date, user=null)` for
  admin returns the `available_users` disambiguation envelope, NOT
  data — naive `.map(date => getTimeline(date, null))` then drops
  every report. Pattern lives in `compliance-aggregator.fanoutDates`
  and `tasks-aggregator.getActionsResolvedRange`: when admin + no
  user, build `(date × fixtures.sites.users)` cross-product.
- **Modal `siteId` falls back to `fixtures.sites.sites[0].site_id`**
  when `state.user` is null (admin path), otherwise the modal mounts
  with `siteId=''` and silently no-ops on submit.
- **Site-aggregated timeline must union non-member contributors.**
  `AggregatedDayView` fans out `getSiteUsers × getTimeline` — folders
  enumerated by site MEMBERSHIP only. A recording site-tagged via
  pipeline G5b (`recordings.site_id`) to a non-member recorder — e.g. an
  admin who walked a site they don't belong to — is attributed to the
  site yet absent from memberships, so its topics vanish from the site
  view even though `?user=<folder>` still shows them. Fix: also fetch
  `org.getSiteContributors(site, date)`
  (`GET /api/org/sites/{id}/contributors`) and fan out over
  `members ∪ contributors`, deduped by folder. The contributors call
  degrades to members-only on failure, so a stale backend is a no-op,
  not a regression.

### Showcase

- **`components-preview.html` lag**: every new L5 composite must be
  registered there with at least a smoke render or trigger button.
  Easy to forget; check before claiming a sprint complete.

### Animation

- **Reduced motion is non-negotiable**. Every `@keyframes` needs a
  `@media (prefers-reduced-motion: reduce)` override — field workers
  with vestibular disorders are a real audience.

## How to verify (read before trusting a green test run)

Every entry below is a real defect from one session, and the point of the
section is the pattern rather than the list: **a green suite is evidence
about the code you wrote, not about the code that runs.** Eight defects were
caught that session; none was caught by reading a diff.

### Three things that actually find bugs

1. **Open the page and look at what rendered.** Not the diff, not the test
   output — the DOM. A zone split shipped whose rows were invisible because
   `buildRows` only emitted leaves parented to a WBS group; every test
   passed. A topic-to-programme link shipped wired to one of *three*
   `AskChat` mounts; the route under test rendered a different one.

2. **Run the SQL against a real database.** Test doubles do not enforce
   foreign keys, and that is where the expensive ones hide. A fix written to
   *preserve* local rows would have **deleted** them, because `parent_id` is
   `ON DELETE CASCADE` and scoping the `DELETE` to `origin='imported'` is not
   enough on its own. 1598 unit tests passed both before and after that fix.
   Also caught this way: `ORDER BY ... DESC` needs `NULLS LAST` or a NULL
   comparison sorts ahead of an exact match.

3. **Re-check your own claims.** The most expensive defect of the session was
   the sentence *"the guard is now redundant but harmless"* in a commit
   message. It was not harmless — it still refused every save, which made the
   fix behind it unreachable. Treat anything you asserted in a comment, a
   commit message or a PR body as a proposition to verify, not a fact.

### Measure the right thing

- **Frame rate cannot be measured in an automated browser tab.** It is
  always `visibilityState: hidden`, so rAF is throttled to ~1fps. Measure
  **main-thread blocking** instead: swap `requestAnimationFrame` for a
  synchronous shim, stop the clock on a real `MutationObserver` commit, and
  record `PerformanceObserver({entryTypes:['longtask']})`.
- **A measurement that detects nothing also reports zero.** Always run a
  control that should fail. Forcing 1,200 rows produced 1,294ms of blocking,
  which is what made the quiet 174/180 result meaningful.
- **Stop the clock after the commit, not after a microtask.** `await
  Promise.resolve()` gave a median of 0.1ms; waiting for the DOM mutation
  gave 33ms. The first number measured the scroll handler and nothing else.
- **Read the rendered node, not `textContent`.** It strips markup by
  definition. A "markdown does not render" bug was reported that way and did
  not exist.

### Fixtures lie in specific ways

- **Feed real output into the real consumer.** Twenty-two unit tests passed
  on invented task objects while the module could read only one of the two
  shapes it is actually given (`{task_id, start}` from `GET /programme`
  versus `{id, source_task_id, start_date}` from the window endpoint).
- **When a fixture keeps producing the wrong result, read the classifier.**
  Three CSV fixtures in a row produced parents and no leaves. The module was
  right every time; the idea of its input was wrong.
- **Every fixture had uids under 1000**, which is why a task id built with
  `('000' + uid).slice(-3)` — padding that also truncates — survived until a
  real 849-task programme arrived, collided 420 tasks, fabricated a
  dependency cycle and stopped the critical path from drawing.
- **A module that cannot be `require`d has no coverage at all.** Guard the
  `window` attach and add `module.exports`, or the parser behind every import
  is untested and nobody notices.
- **An empty mock is not a neutral default — it is a claim that the feature
  is finished and the data is absent.** `org.getSessions` and
  `getSessionReportPreview` both returned `{sessions: []}` / `{topics: []}`.
  Between them that silently removed the meeting picker, Today's meeting
  groups, the `?session=` deep link and the whole Generate-report entry
  point: four surfaces that looked complete-and-empty rather than
  unverifiable, so none of them could be checked locally and two of them
  shipped bugs. The rule that came out of it: a **read** stub has nothing to
  refuse and should serve the day's own fixture. Only a **write** stub is
  right to refuse offline, because there the alternative is faking a result
  that will never exist.
- **A join needs both halves in the fixture.** The timeline filters topics on
  `topic.session_id`; no fixture topic carried one, so picking any meeting
  filtered the day to zero and the feature read as broken when only the
  fixture was. Derive the id in ONE place and let both sides read it, the way
  the backend derives sessions from the topics' own `source_s3_key`.
- **Known remaining gap (2026-08-05):** on prod a session usually holds
  SEVERAL topics — one real recording covered three. The fixture stamps a
  distinct session per topic, so multi-topic grouping (`topic_count`, block
  merging, a session report spanning topics) is never exercised locally.
  Fixing it means adding a topic that shares a session with an existing one;
  it was left alone the night before a manual test because it moves the
  per-day topic counts other suites assert on.

### Design rules these produced

- **Return a status, never a bare number, when the answer might be unknown.**
  `0` renders as "on programme"; `[]` renders as "nothing is neglected".
  Both are claims. `programme-lateness` and `programme-mentions` refuse
  instead.
- **`null` means "no restriction"; `[]` means "restrict to nothing."**
  Conflating them once handed every user's reports to an account that should
  have seen none.
- **Silence is not consent.** A review batch starts every item pending and
  blocks commit while any remain — scrolling past twenty proposals is not
  reviewing them.
- **Never store an inferred order as data.** A sequence nobody stated lands
  on real people's dates.

## Working with this Project

- The user issues **specs in markdown** for each sub-sprint — patch-by-patch
  with grep-based pre-checks and a manual verification checklist. Follow
  that format when proposing new specs.
- **Ask before making architectural changes** (build tooling, framework,
  major restructure). The "no build step" constraint is intentional.
- **Don't auto-bump cache busters in SOURCE** unless changes touch the loaded
  file — churning 168 numbers makes every diff unreadable and collides across
  branches. The deployed artifact is stamped automatically by `amplify.yml`;
  that is a build step, not a source edit, and needs no bookkeeping.
- When delivering, run `node --check` on every modified JS, `grep` the spec
  pre-checks, and confirm script load order in `app-shell-preview.html`.
- Real browser verification isn't always possible from this environment;
  state explicitly when it's done vs deferred to the user.
