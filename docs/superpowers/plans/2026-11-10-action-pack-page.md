# Action Pack Page — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship `#/action-packs`, a page for platform admins on TEST (`ACTION_PACKS=internal`).
On it a person can:

- list their packs;
- start a pack;
- watch a pack run;
- read the pack, including the reading, the sub-task checklist, the conclusion, the actions
  with verifier badges, and the sources;
- act on each action: Apply, Edit and apply, Dismiss, Apply-all, and the stale dialog.

**Architecture:** The page has three parts:

- **API module** — `scripts/api/action-packs.js` registers `window.FS.api.actionPacks`.
  - It whitelists every request body.
  - It maps every response to an outcome object. Envelopes are checked first. It never throws.
  - It falls back to in-memory mocks when the app is not live.
- **Page module** — `scripts/pages/action-packs.js` registers `PAGES['/action-packs']`.
  - It holds pure helpers, `createPoller` (chained `setTimeout`, timer injected), and the
    React components (`React.createElement`, no JSX).
  - It exports everything through the `module.exports` guard so `node --test` can require it.
- **Stylesheet** — `styles/action-packs.css`, its own file. This keeps
  `composites.css ?v` untouched, so the merge with the parallel `feat/player-speaker-bar`
  stays trivial.

**Tech Stack:**

- Vanilla JS IIFEs.
- In-browser React through `React.createElement`.
- CSS BEM with tokens.
- `node --test` on Node 24 with `TZ=Pacific/Auckland`.

**Spec:** `docs/superpowers/specs/2026-11-10-action-pack-page-design.md` rev 2. Section
numbers below (§) refer to it.

## Global Constraints

- Never render an action whose `verifier === 'unsupported'`, and never count one (§4.6.2).
- Never read `sub_tasks[].listed`.
- All model or user text is a React text child. No `dangerouslySetInnerHTML`, no `innerHTML`,
  no Markdown component.
- Every write passes `retry:false`. Poll GETs pass `retry:false` too.
- Check envelopes (`_accessDenied`, `_notFound`) before treating anything as a 200.
- Tokens only in CSS.
- In `app-shell-preview.html`, change only three things: add the new link and the two script
  tags, and bump the `?v=` of `fs-globals.js` and `left-nav.js`. Change nothing else.
- Use explicit `git add <paths>`. Never `git add -A`. Never stash.
- After every full test run: `git checkout -- tests/fixtures/editor-to-prompt.body.json`.
- `core.autocrlf=true`: check `git diff --stat` before each commit. A whole-file diff on an
  existing file means it was rewritten. Redo it with anchored edits.
- End every commit message with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019SGmVTP9UGd3P8KsLW6UHG
  ```

## Review Focus

- Outcome mapping per write, especially:
  - the 403 and 404 envelopes;
  - stale detection from `body.state`;
  - a backend 503 told apart from a waking 503;
  - a second dismiss treated as success.
- No unsupported action leaks into any count, group, plan or link.
- Polling never overlaps, and it stops on envelopes, on unmount, and on `id` change.
- Apply-all: `seq` order, no `fields`, actions on the same target skipped, other controls
  disabled while it runs.

## File Map

| File | Status |
|---|---|
| `scripts/api/action-packs.js` | new |
| `scripts/pages/action-packs.js` | new |
| `styles/action-packs.css` | new |
| `scripts/fs-globals.js` | add `NAV_ITEMS.actionPacks` |
| `scripts/left-nav.js` | add the icon and the MANAGEMENT entry |
| `app-shell-preview.html` | add 1 link and 2 scripts; bump 2 `?v` keys |
| `tests/action-packs-api.test.js` | new |
| `tests/action-packs-page.test.js` | new |
| `tests/action-packs-poll.test.js` | new |
| `tests/action-packs-wiring.test.js` | new |
| `tests/decision-review.test.js` | the MANAGEMENT items regex now allows `'actionPacks'` |

Verification for every task:

```bash
TZ=Pacific/Auckland node --test tests/<file>.test.js
git checkout -- tests/fixtures/editor-to-prompt.body.json
```

---

## Task 1 — API module: requests and body whitelist

**Files:** `scripts/api/action-packs.js`, `tests/action-packs-api.test.js`

Signatures, all on `window.FS.api.actionPacks`:

```js
list({ state, siteId, archived, poll })      // GET /action-packs
get(id, { poll })                            // GET /action-packs/{id}
create({ instruction, siteId })              // -> createOutcome
cancel(id)                                   // -> writeOutcome('cancel')
archive(id, archived)                        // -> writeOutcome('archive')
dismiss(id, aid)                             // -> writeOutcome('dismiss')
apply(id, aid, type, fields)                 // -> applyOutcome
exportMd(id)                                 // GET /export, params {format:'md'}
snapshot(id, ref)                            // GET .../sources/{ref}/snapshot
APPLY_EDIT_FIELDS                            // {close_item:[status], update_item:[...], create_item:[...]}
applyBody(type, fields) -> {} | { fields }   // drops keys outside APPLY_EDIT_FIELDS[type]
```

Live means `!api.useMocks && !!api.orgBaseUrl`. Paths are relative to `orgRequest`, for
example `/action-packs/<enc id>/actions/<enc aid>/apply`.

The `list` query parameters skip null values: `state`, `site_id`, and `archived` (only
`'true'` or `'all'`). `list` and `get` pass `retry:false` only when `poll` is set.

**Tests:**

- [ ] `create sends exactly {instruction, site_id} with retry:false`. Extra caller keys are
  dropped, and `site_id` comes from `siteId`.
- [ ] `cancel, archive, dismiss and apply pass retry:false`. Each call is recorded, and
  `opts.retry === false`.
- [ ] `archive sends {archived: boolean}`. `archive('p', 1)` sends `{archived:true}`.
- [ ] `dismiss and cancel send {}`.
- [ ] `apply keeps only the editable fields of its type`.
  - `apply('p','a','close_item',{status:'closed', text:'x'})` sends
    `{fields:{status:'closed'}}`.
  - With no fields, or with `{}`, it sends `{}`.
- [ ] `ids and refs are URL-encoded`. Id `'a/b'` produces `/action-packs/a%2Fb`.
- [ ] `poll GETs pass retry:false, plain GETs do not`.
- [ ] Commit: `feat(action-packs): api module with body whitelist`.

## Task 2 — API module: outcome mapping and mocks

**Files:** same as Task 1.

Pure helpers, all exported:

```js
envelopeOutcome(res) -> null | { kind:'refused', status, message } | { kind:'unknown', status }
applyOutcome({ res, err }) -> { kind: 'applied'|'noop'|'stale'|'refused'|'failed'|'unknown', ... }
writeOutcome(verb, { res, err }) -> { kind: 'ok'|'finished'|'refused'|'unknown', ... }
createOutcome({ res, err }) -> { kind: 'created', id } | { kind: 'refused', status, message, code }
                              | { kind: 'not_started' } | { kind: 'unknown', status }
```

`code` is one of `in_progress`, `company_inactive`, or undefined. Each write wraps its request
in try/catch and passes `{res}` or `{err}` to its helper.

**Tests** (in `tests/action-packs-api.test.js`):

- [ ] `a 403 envelope is refused with its error, for every write`.
- [ ] `a 404 envelope is refused with raw.error, for every write`.
- [ ] `a non-404 _notFound is unknown, for every write`.
- [ ] `apply: 200 is applied, noop is noop`.
- [ ] `apply: a thrown body.state stale is stale with live and snapshot, whatever the status`.
- [ ] `apply: 500 is failed; another 4xx is refused; 502/504/no body/timeout is unknown`.
- [ ] `dismiss: a 409 with state dismissed is ok`.
- [ ] `cancel: a 409 with a state is finished`.
- [ ] `create: 202 is created`.
- [ ] `create: 409 in-progress and company_inactive carry their codes`.
- [ ] `create: 503 "the pack could not be started" is not_started; a waking 503 or a 503 without
  that body is unknown`.
- [ ] `mocks answer when not live, with no orgRequest call`. The mock pack must include:
  - `sub_tasks`;
  - an unsupported action;
  - a weak action with a `verifier_detail.reason`;
  - a stale action;
  - two supported, applicable actions on the same `target_stable_id`.
- [ ] Commit: `feat(action-packs): outcome mapping and mock packs`.

## Task 3 — Page pure helpers

**Files:** `scripts/pages/action-packs.js` (helpers and exports only),
`tests/action-packs-page.test.js`

```js
visibleActions(actions) -> actions without verifier 'unsupported'
actionGroups(visible) -> { review:[], stale:[], done:[] }   // seq order; unknown state -> done
actionCounts(visible) -> [{ key, n, text }]                 // zero counts omitted
actionBadge(action) -> null | { text:'Uncertain', reason: string|null }
conclusionBadge(line) -> null | { text:'Uncertain', reason: string|null }
reasonLine(sub) -> null | { main: string|null, muted: string|null }
subTaskView(sub, conclusionLen, visibleSeqs) -> { id, ask, kind, status, statusText, reason, actionSeqs:[], findings:[] }
chipTarget(ref, sources) -> { kind:'removed'|'records'|'documents'|'snapshot'|'web_link'|'web_answer', source }
isWebOnly(refs, sources) -> boolean
applyAllPlan(visible) -> { run:[action], skipped:[{action, text}], weakCount }
editFields(action) -> { fields: string[], values: {} }      // prefill
editDiff(action, values) -> {}                              // only keys differing from proposed
failureText(failure) -> string
createdText(result) -> string
staleReasonText(reason) -> string|null
envelopeState(res) -> null | { kind:'off'|'gone'|'denied'|'error', text }   // §5.2/§6.2
safeHref(url) -> string|null                                // http(s) only
```

**Tests:**

- [ ] `unsupported actions are dropped whatever their reason_code`. Cover `not_checked`,
  `contradicted` and `null`. They must also be absent from `actionCounts` and `applyAllPlan`.
- [ ] `actions group by state: proposed/failed review, stale, applied/dismissed done, unknown
  done; seq order`.
- [ ] `action badge: supported none; weak with reason; weak with null and missing detail gives
  reason null`.
- [ ] `conclusion badge: uncertain with reason, null reason, no detail; supported none`.
- [ ] `reason line follows the spec table`. Cover all four rows, plus whitespace counted as
  empty.
- [ ] `sub-task view maps conclusion indexes to 1-based findings and ignores unknown or
  unsupported seqs`. The source must not contain `.listed`.
- [ ] `chips look sources up by ref, not order`. Cover R10 vs R2, removed, missing, and each
  provenance or kind.
- [ ] `web-only only when every ref is web; no refs is false`.
- [ ] `apply-all plan`:
  - only supported and applicable actions, in seq order;
  - a second action on the same target is skipped with "Another action changes this task";
  - creates are never skipped;
  - the weak count is applicable weak actions.
- [ ] `edit fields`:
  - create prefill comes from `proposed`;
  - update prefill is `proposed` over the snapshot;
  - close defaults to `done`;
  - the diff carries only changed keys;
  - a cleared deadline is `null`.
- [ ] `failure text: company_inactive has its own copy; others name the code`.
- [ ] `created text never says #null`.
- [ ] `stale reasons map to text`.
- [ ] `envelope state: 404 not switched on vs Could not load (HTTP n)`.
- [ ] `safeHref allows only http and https`.
- [ ] Commit: `feat(action-packs): pure view helpers`.

## Task 4 — Poller

**Files:** `scripts/pages/action-packs.js`, `tests/action-packs-poll.test.js`

```js
createPoller({ fetch, onData, isDone, delay: { visible, hidden },
               visibility: () => 'visible'|'hidden',
               setTimer: (fn, ms) => handle, clearTimer: (handle) => void })
  -> { start(), stop(), kick() }
```

- `fetch()` returns a promise.
- After it settles, the poller calls `onData({res})` or `onData({err})`.
- If `isDone(res)` is true, or `res` is an envelope, it stops.
- Otherwise it schedules the next fetch with `delay[visibility()]`.
- `kick()` polls now, but only when no fetch is in flight. The page calls it on
  `visibilitychange` to visible.
- After `stop()`, no `onData` call fires.

**Tests:**

- [ ] `no second fetch starts before the first settles`.
- [ ] `stops when isDone is true`.
- [ ] `stops on a _notFound or _accessDenied envelope`.
- [ ] `uses the hidden delay while hidden`.
- [ ] `a thrown fetch keeps polling`.
- [ ] `stop cancels the next tick and drops a late response`.
- [ ] Commit: `feat(action-packs): chained-timeout poller`.

## Task 5 — Components

**Files:** `scripts/pages/action-packs.js`, `tests/action-packs-page.test.js`

The components are:

| Component | Purpose |
|---|---|
| `ActionPacksMiddle` | Route switch on `getCurrentRoute().params`: `id`, `new` |
| `PackList` | The pack list |
| `NewPackForm` | ModalOverlay form for a new pack |
| `PackDetail` | One pack |
| `SubTaskList` | Sub-task checklist |
| `ConclusionList` | Conclusion lines |
| `ActionCard` | One action |
| `EditApplyForm` | Edit-then-apply form |
| `StaleDialog` | Stale-action dialog |
| `ApplyAllPanel` | Apply-all |
| `RefChip` | Source reference chip |
| `SourceCard` | Source detail |
| `SnapshotDialog` | Snapshot viewer |
| `RunDetails` | Run details |

Behaviour comes from spec §5 to §7. Two rules apply throughout:

- `document.title` is set in an effect and restored on cleanup.
- The `aria-live` status region holds only the state word.

**Tests**, using the tiny hook runtime from `tests/decision-review.test.js`:

- [ ] `list: a 404 envelope says not switched on; a non-404 _notFound says Could not load (HTTP
  502)`.
- [ ] `detail: no unsupported action text appears anywhere in the rendered tree`.
- [ ] `detail: weak action shows Uncertain and its reason as text`.
- [ ] `detail: a close with null target_snapshot says "Task not visible to you, or no longer
  exists" and has no Apply`.
- [ ] `detail: Apply only where applicable === true`.
- [ ] `detail: sub-task with not_answered shows the code text`.
- [ ] `the page source has no innerHTML, dangerouslySetInnerHTML or Markdown`. This is a
  source scan over both new files.
- [ ] Commit: `feat(action-packs): list, detail, form and dialogs`.

## Task 6 — Wiring, nav, styles

**Files:**

- `scripts/fs-globals.js`
- `scripts/left-nav.js`
- `app-shell-preview.html`
- `styles/action-packs.css`
- `tests/action-packs-wiring.test.js`
- `tests/decision-review.test.js`

**Changes:**

- `NAV_ITEMS.actionPacks = { permission: P('settings','view'), label: 'Action packs',
  path: '/action-packs', platformAdminOnly: true }`.
- In `left-nav.js`:
  - add `actionPacks: 'sparkles'`;
  - set the MANAGEMENT `items` to
    `['sites', 'team', 'trace', 'decisionReview', 'actionPacks']`.
- In `app-shell-preview.html`:
  - add `<link rel="stylesheet" href="styles/action-packs.css?v=1" />` after `composites.css`;
  - add `scripts/api/action-packs.js?v=1` after `decisions.js`;
  - add the page as `text/babel` after `decision-review.js`;
  - bump `fs-globals.js` and `left-nav.js` by one.

**Tests:**

- [ ] `only the platform admin sees Action packs`. A company admin is false, a platform admin
  is true, and a bare string is false.
- [ ] `script tags: api after api/index.js, page as text/babel, stylesheet linked`.
- [ ] `left nav lists actionPacks with an icon`.
- [ ] `the page registers PAGES['/action-packs']`.
- [ ] Update the MANAGEMENT regex in `decision-review.test.js`.
- [ ] Full suite:

  ```bash
  TZ=Pacific/Auckland node --test "tests/**/*.test.js"
  git checkout -- tests/fixtures/editor-to-prompt.body.json
  ```

  The suite must report 0 failures.
- [ ] Commit: `feat(action-packs): nav, styles and script tags`.

## Needs a browser (parent agent)

- Render in light and dark themes, and at phone width.
- The ModalOverlay focus trap.
- Hover and focus highlighting from sub-tasks.
- Real TEST data: the runbook hand-test (spec §11).
