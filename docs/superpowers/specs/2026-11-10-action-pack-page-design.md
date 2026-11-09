# Action pack page — design

Date: 2026-11-10. Status: draft for owner review.

Backend facts were read from `fieldsight-pipeline` `origin/develop` at `11b13981`. Frontend
facts were read from `fieldsight-ui` `origin/dev` at `ed8b6a8`. Backend paths are relative to
`fieldsight-pipeline/`. The backend's UI hand-off is
`docs/handoffs/2026-11-01-action-packs-ui.md` ("the hand-off" below). This spec relies on it
for exact error strings. Where the code on `develop` now differs from the hand-off, §4.6 lists
the differences, and the code wins.

---

## 1. Intent

An action pack is the stored result of one background run (spec
`docs/superpowers/specs/2026-11-01-background-action-agent-design.md` §1). A person gives an
instruction. The run reads the records, then writes:

- a **reading**: how it understood the instruction;
- **sub-tasks**: the instruction split into asks, each marked done, partly done or not done;
- a **conclusion**: cited findings;
- **actions**: proposed changes to Tasks, plus drafts;
- **sources**.

A second model labels each element.

The owner wants to see, for each instruction, **what the agent did, what it did not do and
why**. The owner then decides whether to trust it and act on it. The page has to answer three
questions at a glance:

1. Did it understand me? (reading and sub-tasks)
2. Which parts of my instruction did it do, and why not the rest? (sub-task checklist with
   reasons)
3. Can I believe each line and act on it? (verifier badge and reason, ref chips to the
   evidence, and Apply only where the backend says this viewer may)

Nothing changes in Tasks until a person applies one action
(`src/lambda_org_api.py:1239-1294`). The page is where that happens.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. A list of the viewer's packs and a detail view of one pack. Both read only what the
  backend returns.
- G2. A "New pack" form on the page: an instruction plus a site. It creates a pack, opens it,
  and polls until the pack finishes.
- G3. The sub-task checklist (#1252) and the verifier detail (#1254), rendered as §6 says.
- G4. Apply, Dismiss and Apply-all on real data, with the stale dialog. The backend supports
  all of them (§4.3).
- G5. Every piece of model and user text renders as plain text.

**Non-goals (follow-ups, named so they are not lost)**

- The three entry points in other pages: Ask "Do this in the background", Day view "Review
  this day" and Tasks "Tidy open items" (hand-off §10).
- Tasks-side changes:
  - `#task_no` in Tasks (hand-off §8);
  - the "Agent" source badge (hand-off §9);
  - the `compliance-aggregator.js` fix that includes agent topics;
  - the "Added from action pack" history row.

  **Consequence:** until the Agent badge lands, a task created by Apply shows in Tasks under
  whatever label the UI derives from `is_live === false`, which is "nightly" today. On TEST,
  with platform_admin only, this is acceptable. It must be fixed before the flag goes `on`.
- The `.docx` export. The backend answers 400 to it (`src/lambda_org_api.py:1045-1047`).
- "Rerun with changes", chat refinement, standing or nightly packs (backend spec §1.3).

**Anti-goals: a failure even if the page "works"**

- AG1. Showing Apply on an action the backend did not mark `applicable: true`.
- AG2. Rendering model text (reading, conclusion, rationale, reason, excerpt, snapshot, draft
  body) as HTML or Markdown.
- AG3. Re-sending a create after a timeout. That could start a second run.
- AG4. A weak or unchecked action that looks the same as a supported one.
- AG5. An "apply anyway" path past a stale result. The person's change always wins (backend
  spec A3).

## 3. Who sees it

| Backend flag `ACTION_PACKS` | Routes | Page |
|---|---|---|
| `off` (also the value for unset or unknown) | Every route answers 404, as if unknown (`src/action_pack_view.py:104-122`, `src/lambda_org_api.py:734-740`) | The nav item is hidden for non-platform-admins. A platform admin sees the empty state "Action packs are not switched on in this environment." |
| `internal` (TEST today) | Only `global_role == "platform_admin"` reaches the routes (`src/action_pack_view.py:120-121`) | Nav item for platform_admin only |
| `on` | Everyone. Readers are filtered per pack (below) | Needs the probe in §5.4 first |

**Under `internal`, a platform admin reads only the packs it created.** The repository's reader
rule has no platform-admin arm except "creator" (`cross_company`):

- `src/repositories/action_packs.py:78-82`;
- `src/repositories/action_packs.py:183-195`;
- `_reader_clause`, `src/repositories/action_packs.py:453-473`.

So the list is "my packs". The other reader arms only matter at `on`:

- creator, while the site is in their scope;
- admin or GM of the site's company;
- pm or site_manager of the site.

These are the same lines in `src/repositories/action_packs.py`.

**Apply rights are the applier's, checked at apply time.** A platform admin counts as a
company admin for apply (`_is_company_admin_of` returns true for cross-company callers,
`src/lambda_org_api.py:13307-13311`, used by `may_create_item_on_site` at `:963-981`). So on
TEST the owner can apply on any site. The page never decides this itself. It reads
`applicable` (§6.4).

## 4. Backend contract (as built)

All routes live under `/api/org` and are dispatched at `src/lambda_org_api.py:1599-1602`.
Every error body is `{"error": "..."}`. A malformed id, a wrong method, or a pack this caller
may not read is always 404 `not found` (`src/lambda_org_api.py:734-776`). The route regex is at
`:710-712`.

### 4.1 Routes

| Route | Handler | Body / query | Success |
|---|---|---|---|
| POST `/action-packs` | `create_action_pack` `:794-841` | exactly `{instruction, site_id?}` | 202 `{id, state:"queued"}` |
| GET `/action-packs` | `list_action_packs` `:844-868` | `?state=queued\|running\|ready\|failed\|cancelled&site_id=<uuid>&archived=false\|true\|all` | 200 `{packs:[row]}`, newest first, at most 50, no paging |
| GET `/action-packs/{id}` | `get_action_pack` `:1030-1038`, view `:984-1027` | — | 200 the pack (§6) |
| GET `/action-packs/{id}/export` | `:1041-1054` | `?format=md` only | 200 `{format, filename, content_type, content}` |
| GET `/action-packs/{id}/sources/{ref}/snapshot` | `:1057-1087` | — | 200 `{ref, url, fetched_at, text, truncated}` (text at most 200 kB) |
| POST `/action-packs/{id}/cancel` | `:1090-1116` | `{}` | 200 `{id, state:"cancelled"}`. 403 unless the caller is the creator or a company admin. 409 `{state}` if the pack already finished |
| POST `/action-packs/{id}/archive` | `:1119-1127` | exactly `{archived: bool}` | 200 `{id, archived}`. Any reader |
| POST `/action-packs/{id}/actions/{aid}/dismiss` | `:1130-1157` | must be empty: `{}` | 200 `{id, state:"dismissed"}` |
| POST `/action-packs/{id}/actions/{aid}/apply` | `:1239-1294`, `_apply_locked` `:1297-1317` | `{}` or `{fields:{...}}` | 200 `{id, state:"applied", applied_result}` |

Create rules (`src/action_pack_view.py:125-144`, `src/lambda_org_api.py:802-841`):

- `instruction`: 1 to 2000 characters after trimming.
- `site_id`: required when the caller sees more than one site. A platform admin sees many, so
  the form always sends it. An unseen or unknown site is 404 `site not found`.
- One queued or running pack per person: otherwise 409 `you already have a pack in progress`
  (`:824-825`).
- 503 `the pack could not be started`: the pack is already marked `failed` (`:830-839`).

The list row (`src/action_pack_view.py:613-619`) is
`{id, title, instruction, state, failure, site_id, site_name, created_at, archived, action_counts}`.
`action_counts` has all five action states (`src/repositories/action_packs.py:95`).

GET runs a sweep first. A run whose worker has been silent for 20 minutes becomes
`failed/internal` (`src/lambda_org_api.py:779-791`, `:1034`; `STALE_SWEEP_MINUTES`,
`src/action_pack_view.py:91`). So polling always ends.

### 4.2 How packs are created today

The only creator is POST `/action-packs`. Nothing else calls `create_queued`: a grep of
`src/` shows only `src/lambda_org_api.py:822`. Apart from that route, the only caller is the
TEST eval harness (`scripts/action_pack_eval/live.py:74`). There is no device or voice path
and no Ask path. **The web should create packs.** It is the only intended human entry point
(backend spec §10), and this page's form is its first one.

### 4.3 Apply exists

The semantics, all from `src/lambda_org_api.py`:

- **Pre-checks**, each answering without writing (`:1253-1277`). The pack must be:
  - readable (404);
  - not archived (409);
  - `ready` (409 `{state}`).

  The action must be:
  - visible to this reader (404 `action not found`);
  - an apply type (409 for drafts);
  - not `unsupported` (409).

  The body must pass `validate_apply_body` (400s, `src/action_pack_view.py:374-393`). Finally,
  the company-exit gate.
- **Idempotent replay.** An already-`applied` action returns 200 with its stored
  `applied_result` and writes nothing (`:1303-1305`).
- **Stale: the human wins.**
  - If a field the action touches changed since the run, or any edit was recorded after
    `as_of`, or the target is gone or moved, nothing is written. The action becomes `stale`
    and the answer is 409 `{error:"action is stale", state:"stale", live, snapshot}`
    (`:1181-1203`, `:1320-1330`).
  - `live` and `snapshot` are both null when the caller cannot see the task.
  - Applying a stale action again re-reads `live` and gives the same 409 (`:1306-1309`).
- **The write.**
  - close and update go through PATCH's own ACL, validators and `content_edits` audit, inside
    one savepoint with the action's state change (`:1160-1165`).
  - create inserts the item under a per-pack synthetic "agent" topic (`:1167`).
  - Editable fields per type (`APPLY_EDIT_FIELDS`, `src/action_pack_view.py:355-359`):
    - close: `status`, which must be `done` or `closed`;
    - update: `deadline`, `responsible`, `priority`, `status`;
    - create: `text`, `responsible`, `deadline`, `priority`.

    Edits merge over the proposal (`:396-428`).
- **Server fault.** The savepoint rolls back, the action becomes `failed` with
  `{error:"internal"}`, and the answer is 500 `{error:"apply failed", code:"internal"}`
  (`:1285-1291`). `failed` can be applied again (`APPLICABLE_STATES`,
  `src/action_pack_view.py:90`).
- **`applied_result` shapes:**
  - close/update applied: `{action_item_id, content_edit_ids}`;
  - `{noop:true, action_item_id}`: someone already did it by hand;
  - create: `{action_item_id, task_no, content_edit_ids}`;
  - stale: `{reason: changed|target_gone|target_moved}`;
  - failed: `{error}`.

  See hand-off §3.3. The response shapes are listed there, and the code above writes them.

There is no bulk endpoint. Apply-all is a UI loop (backend spec §5.3).

### 4.4 Existing web UI

None. `git grep -i "action-pack\|actionPack\|action_pack"` on `fieldsight-ui` `origin/dev`
finds nothing. No `task_no` or `source === 'agent'` handling exists either.

### 4.5 Frontend facts this spec builds on

- **Router.** Hash routes with query params and no path params (`scripts/router.js:12-24`).
  Pages are keyed by exact path. Reading params: `scripts/pages/timeline.js:38-39`.
- **Requests.** `FS.api.orgRequest` resolves a 404 to `{_notFound:true}` and a 403 to
  `{_accessDenied:true, error}`. It **throws** on any other non-2xx, with `err.status` and
  `err.body` (`scripts/api/_fetch.js:325-375`, `:399-408`).
- **Retries.** Non-GET requests are retried on a plain 5xx, on the 1/2/4 s ladder, unless they
  pass `retry:false`. A wake-shaped failure on a non-GET stops after one try
  (`scripts/api/_fetch.js:186-235`).
- **Platform-admin-only nav.** `NAV_ITEMS.decisionReview` with `platformAdminOnly: true`
  (`scripts/fs-globals.js:405-410`), checked by `canSeeNav` (`:466-473`), placed in the
  MANAGEMENT section (`scripts/left-nav.js:28`, `:68`).
- **Closest page and API pattern.** `scripts/pages/decision-review.js` and
  `scripts/api/decisions.js`:
  - live-only writes, no `orgWrite()` gate;
  - in-memory mocks when not live;
  - body whitelist (`decisions.js:35-47`);
  - the 404 envelope means "flag off" (`decision-review.js:11-13`, `:262-263`).
- **Modals.** `scripts/composites/modal-overlay.js` handles focus in and out, ESC and the
  portal.
- **Dates.** `FS.api.nzDateTime` parses the backend's space-separated datetimes
  (`scripts/api/index.js:162-170`, `:223-227`).
- **Sites and members.** `getOrgSites` (`scripts/api/org.js:84`) and `getSiteMembers`
  (`scripts/api/org.js:669`).
- **Script order.** `api/index.js` replaces `FS.api` wholesale, so API modules load after it
  (`app-shell-preview.html:219`, `:249`). Pages load as `text/babel` (`:411`).
- **CI.** CI runs `node --test "tests/**/*.test.js"` with `TZ=Pacific/Auckland` on PRs to
  `dev` and `main` (`.github/workflows/tests.yml`).

### 4.6 Where `develop` differs from the hand-off and from the contract wording

1. **`sub_tasks[].listed` is not returned.** `account_sub_tasks` computes it in the worker
   (`src/action_pack_stages.py:1797-1815`). The store payload sends only
   `id, ask, kind, status, actions, conclusion, reason_code, reason`
   (`src/action_pack_stages.py:2156-2161`). `visible_sub_tasks` copies and remaps
   (`src/action_pack_view.py:508-529`). **The UI must not depend on `listed`.** It reads
   `listed === false` if the field ever arrives. Until then it uses the reason codes, which
   say the same thing:
   - `not_answered`: the writer skipped this sub-task (`src/action_pack_stages.py:1808-1810`);
   - `dropped_by_checks`: the writer answered it, and code checks removed what it proposed
     (`:1790-1792`).
2. **`not_checked` is not a verifier label.** Action labels are only
   `supported | weak | unsupported` (`src/action_pack_stages.py:124`,
   `src/action_pack_verify.py:158`).
   - A check that failed or timed out is stored as `verifier: "unsupported"` with
     `verifier_detail.reason_code: "not_checked"` (`src/action_pack_verify.py:682-716`).
   - **Unsupported actions are returned, not hidden.** Only unsupported conclusion lines are
     hidden server-side (`hidden: true`, filtered at `src/action_pack_view.py:492-505`).
   - Conclusion lines carry `confidence: supported | uncertain`, not `verifier`
     (`src/action_pack_verify.py:723-732`).
   - An unchecked conclusion line is hidden (`:682-687`, `:724-728`).
   - An uncited line kept as uncertain has a `verifier_detail` whose fields are all null
     (`:660-661`).
3. **`verifier_detail.served` is stripped on GET.** GET returns
   `{model, attempt, reason_code, reason}` (`src/action_pack_view.py:532-545`, `:587`).
4. **`format=docx` is 400** (`src/lambda_org_api.py:1045-1047`). The hand-off already says
   this. Backend spec §5.1 still offers `.docx`.
5. `verifier_detail` is null on packs stored before migration 0097, and `sub_tasks` is null on
   those packs and on plans without sub-tasks (`src/action_pack_view.py:532-537`, `:604-609`).

## 5. Pages and routes

### 5.1 One route: `#/action-packs`

`window.FieldSight.PAGES['/action-packs'] = { Middle, layout: 'full-width' }`.

- `#/action-packs` shows the list. `?state=` and `?archived=` act as filters.
- `#/action-packs?id=<uuid>` shows the detail of one pack, with a "← All packs" link.
- `#/action-packs?new=1` opens the "New pack" form. The form also opens from a button on the
  list.

**My call: detail is a page, not a window.** A pack is a durable record (backend spec G5).
People share its link, come back to it while it runs, and act on it for minutes. That fits a
page better than the Settings-style window, which suits transient tasks. A query param is used
because the router has no path params (§4.5).

### 5.2 List

- **Header.** "Action packs", a "New pack" button, and filter tabs: **Active** (default, the
  list with `archived=false`) and **Archived** (`archived=true`). A state select offers All,
  Running, Ready, Failed and Cancelled. "Running" sends `state=running`. Queued packs show
  under All.
- **Row.**
  - `title`, or the `instruction` cut to one line when `title` is null;
  - `site_name`;
  - a state chip;
  - `nzDateTime(created_at)`;
  - counts from `action_counts`: "3 proposed · 1 applied · 1 stale", hiding zeros;
  - a failed pack shows "Failed (‹failure›)".

  The whole row is a link to `?id=`.
- **Polling.** While any row is queued or running, the list polls every 15 s, and every 60 s
  when the tab is hidden.
- **Cap note.** When the list shows 50 rows: "Showing the newest 50."

### 5.3 New pack form

ModalOverlay with `closeOnBackdrop:false`:

- A site select from `getOrgSites`, required, with no default. A platform admin sees many
  sites.
- An instruction textarea, 1 to 2000 characters, with a live count.
- Submit sends exactly `{instruction, site_id}` with `retry:false` (AG3).

| Response | UI |
|---|---|
| 202 | Close the form and navigate to `?id=<id>` |
| 409 `you already have a pack in progress` | Inline message plus a link to the running pack (GET list `state=running`, then `state=queued`) |
| 409 `company_inactive` | "This project's company is suspended or has left FieldSight." |
| 400 / 404 | The backend's `error` text, shown inline |
| 503 | "The pack could not be started. Try again." Keep the form filled |
| Network error or wake-shaped failure | "We could not tell whether the pack started." Link to the list. No automatic resend |

### 5.4 Nav and the flag

- **v1 (`internal`).** Add `NAV_ITEMS.actionPacks` = `{ permission: P('settings','view'),
  label: 'Action packs', path: '/action-packs', platformAdminOnly: true }`. Add it to the
  MANAGEMENT items next to `decisionReview`, with a `left-nav.js` icon such as `'sparkles'`,
  or any existing icon. A 404 from the list renders the "not switched on" empty state, the
  same pattern as decision-review.
- **Before `on` (follow-up).** Replace `platformAdminOnly` with a probe. Call
  `GET /action-packs?state=running` once per session and cache the answer. On 200, show the
  nav. On a 404 envelope, hide it. This is the hand-off §1 recommendation. **My call:** it is
  deferred because under `internal` the role check gives the same answer with no extra
  request, and the probe needs a new nav hook that the other nav items do not have.

## 6. Detail view: field → UI

Sections appear top to bottom in this order: header, reading, sub-tasks, conclusion, actions,
sources, run details. All text nodes are React text children (§8).

### 6.1 Header

- **Title.** `title`, or `instruction` when `title` is null.
- **Instruction.** Shown in full under the title, in a muted quote block, prefixed "You
  asked:".
- **Facts line.**
  - `site_name` · state chip · "Started ‹nzDateTime(created_at)›";
  - "Read as of ‹nzDateTime(as_of)›" when the pack is ready;
  - "Archived" when `archived` is true.
- **Buttons.**
  - **Cancel**: shown while queued or running when `is_creator` is true. A company admin may
    also cancel, but `is_creator` is the only signal the backend gives. A 403 shows the
    backend's text.
  - **Archive / Unarchive**: always shown.
  - **Export .md**: shown when the pack is ready. GET export, then download `content` as
    `filename`.

### 6.2 States

| `state` | Body |
|---|---|
| loading (no response yet) | "Loading…" |
| 404 envelope | "This pack does not exist or you cannot see it." with a link back. The backend never says which |
| `queued` | "Waiting to start…" and the instruction. Poll |
| `running` | "Working… this usually takes 1–5 minutes." Show `reading` and `title` as soon as they are non-null, under "I read this as:" (hand-off §4), so the person can cancel early. Poll |
| `ready` | Full view |
| `failed` | "The run could not finish (‹failure›). Try again." `failure` is one of `budget, model, tools, verifier, internal, company_inactive`. A "Run again" button opens the New pack form pre-filled with the same instruction and site. No actions are shown |
| `cancelled` | "Cancelled." Show the reading if present |
| fetch error (thrown) | Error text with a "Retry" button. Polling keeps going at its interval |

**Polling.** Poll GET `/action-packs/{id}` every 4 s while the pack is queued or running. Poll
every 15 s while the tab is hidden: read `document.visibilityState` and poll once when the tab
becomes visible again. Stop on ready, failed or cancelled. Polling stops on unmount and on a
change of `id`.

### 6.3 Sub-tasks (#1252): checklist under the reading

- **When it shows.** Only when `sub_tasks` is a non-empty array. Null means an old pack or a
  plan without sub-tasks: render nothing.
- **Order.** Plan order, as returned.
- **Row content.**
  - **Status chip.** `done` reads "Done" (ok tone). `partly` reads "Partly" (warn tone).
    `not_done` reads "Not done" (muted tone). The chip pairs an icon with the word, never
    colour alone.
  - **`ask`.** Plain text.
  - **`kind`.** A small label: close, update, create, review, standards, draft or other
    (`SUB_TASK_KINDS`, `src/action_pack_stages.py:623`).
  - **Reason.** For `partly` and `not_done`, a reason line. Show `reason` as text when it is
    non-null. Otherwise show the reason-code text from the table below. When `reason` is
    present, append the code text in muted style if it adds information. For example,
    `not_answered` always shows its text.
  - **Links.** "Actions: #1, #3" (the `seq` values) and "Findings: 1, 2". These are the
    1-based display numbers of `conclusion[i]`.

| `reason_code` | Text |
|---|---|
| `no_evidence` | No evidence found in the records |
| `not_found` | Could not find what this refers to |
| `ambiguous_target` | More than one item could be meant |
| `out_of_scope` | Outside what this pack may change |
| `already_done` | Already done |
| `other` | — (show `reason` only) |
| `not_answered` | The agent did not answer this part |
| `dropped_by_checks` | What the agent proposed was removed by checks |

Codes come from `src/action_pack_stages.py:627-629`. An unknown code shows nothing extra.

- **Linking.**
  - `actions` holds visible `seq` values. `conclusion` holds 0-based indexes into **this
    response's** `conclusion` array. The backend already remapped both for this reader
    (`src/action_pack_view.py:508-529`).
  - Hovering or focusing a row adds a highlight class to the linked action cards and
    conclusion lines. Leaving the row removes it.
  - Clicking "Actions: #3" scrolls to and focuses that action card.
  - An index or seq that is not found is ignored. The UI never throws on it.
- **Keyboard.** Each row is focusable (`tabIndex=0`), and focus triggers the same highlight as
  hover.
- **`listed`.** If `listed === false` ever appears, the row shows "Skipped by the agent" next
  to the chip. Today the field is absent (§4.6.1), and `not_answered` carries the same
  meaning.

### 6.4 Conclusion

Each element of `conclusion` is `{text, refs, confidence, verifier_detail}`. Lines are
numbered 1..n so sub-tasks can refer to them.

- `text` as plain text.
- Ref chips for `refs` (§6.6).
- `confidence: "uncertain"` shows an **"Uncertain"** badge. When `verifier_detail.reason` is
  non-null, it shows below the line as muted plain text (#1254). When `verifier_detail` is
  null, or its reason is null, the badge shows with no reason. An uncited uncertain line falls
  in this case.
- `confidence: "supported"` shows no badge.
- Unsupported lines never arrive (hidden server-side, §4.6.2).
- **"Web source, not your project's documents."** This label shows when **every** ref of the
  line resolves to a `provenance: "web"` source. It is derived from `sources`, and the backend
  stores no flag for it (hand-off §5).

### 6.5 Actions

Actions arrive in `seq` order. There are three groups:

- **Proposed**: state `proposed` or `failed`, with verifier `supported` or `weak`;
- **Done**: state `applied`, `dismissed` or `stale`, any verifier;
- **"Not shown as reliable"**: verifier `unsupported`, any state. This group is collapsed by
  default and shows a count.

Each card shows:

- **Head.**
  - `#seq`;
  - a type label: Close task, Update task, New task, Draft RFI, Draft email or Note
    (`_ACTION_LABEL`, `src/action_pack_view.py:624-625`);
  - for close and update, the target: "#‹target_task_no›" when it is non-null, followed by
    `target_snapshot.text`.

  When `target_snapshot` is null on a close or update, show **"Task not visible to you"** and
  no Apply (hand-off §3.3).
- **Change.**
  - Close: "Status: ‹snapshot.status› → ‹proposed.status›".
  - Update: one row per key of `proposed`, before → after. The before value comes from
    `target_snapshot`.
  - Create: the `text`, `responsible`, `deadline` and `priority` of `proposed`.
  - Drafts: `subject` and `body` (and `to`), or `text`. Shown in a `pre-wrap` block with a
    **Copy** button. Drafts are never applied.
  - Dates are `YYYY-MM-DD` strings and are formatted as dates, not datetimes.
- **Rationale.** `rationale` as plain text.
- **Ref chips** (§6.6).
- **Verifier**, keyed on `verifier` and `verifier_detail.reason_code`:

| `verifier` | `reason_code` | Badge | Reason line |
|---|---|---|---|
| `supported` | any | none | none |
| `weak` | any | **Uncertain** | `verifier_detail.reason` as plain text when non-null, otherwise nothing. The code caps write fixed text here, e.g. "Deadline assumed: date raised." (`src/action_pack_verify.py:349-354`) |
| `unsupported` | `not_checked` | **Not checked** | none (#1254: like weak, without the reason) |
| `unsupported` | `contradicted` | **Contradicted by evidence** | reason when non-null |
| `unsupported` | other or null | **Not supported by evidence** | reason when non-null. A null `verifier_detail` means an old pack, where this label meant "not supported or not checked" |
| `not_checked` (not sent today) | — | **Not checked** | none. Forward-compatible with the #1254 wording |
| any other value | — | **Unverified** | none |

- **State line.**

| `state` | Display |
|---|---|
| `proposed` | none |
| `applied` | "Applied ‹nzDateTime(applied_at)›". When `applied_result.noop` is set: "Already done". For a create with `applied_result.task_no`: "Created #‹task_no›" with a link to `#/tasks` |
| `dismissed` | "Dismissed" |
| `stale` | "Changed since the pack read it". Plus "Why?", which opens the stale dialog (§7.2) |
| `failed` | "Last apply failed, you can retry". The Apply button reads "Retry" |

- **Buttons**, shown only when the backend allows them:
  - **Apply** when `applicable === true` (AG1).
  - **Edit and apply** when `applicable === true`, or when
    `applicable_reason === "responsible_not_member"`. It opens a form with exactly
    `APPLY_EDIT_FIELDS[type]` (§4.3). `responsible` is a select from `getSiteMembers(site_id)`
    display names.
  - **Dismiss** when the state is `proposed`, `failed` or `stale` and the pack is not
    archived.
  - With `applicable_reason === "responsible_not_member"`: show "Assignee is not on this
    project" and offer Edit and apply only.
  - No buttons on an archived pack. The backend refuses with 409.

### 6.6 Ref chips and sources

A chip shows the ref text (`R2`, `D1`, `W1`). It is routed by **looking the ref up in
`sources[]`** by `ref`. The routing never relies on order: sources sort as text, so R10 comes
before R2 (hand-off §2, §5).

| Source | Chip opens (popover or modal, all plain text) |
|---|---|
| not found in `sources`, or `removed: true` | Greyed chip, "Source removed", not clickable |
| `provenance: "records"` | Card: `title`, `nzDate(date)`, `who`, `excerpt` as a quote. When `site_id` and `date` are present: "Open day" → `#/timeline?site=‹site_id›&date=‹date›` (pattern at `scripts/app-shell.js:862`) |
| `provenance: "documents"` | Card: `title` ("‹doc› · ‹heading›"), "rev ‹revision›, p. ‹page_from›–‹page_to›", `excerpt`. No deep link in v1 (my call: the document page has no page anchor today) |
| `kind: "web_source"` with `snapshot_s3_key` | Snapshot viewer modal. GET `.../sources/{ref}/snapshot`, then show "Snapshot of ‹url› taken ‹fetched_at›", `text` in a `pre-wrap` block, "(truncated)" when `truncated` is true, and a link to the live `url` with `rel="noopener noreferrer"` and `target="_blank"`. A 404 envelope shows "Snapshot not available" |
| `kind: "web_source"` without snapshot | `title`, `url` as a link, "Page not stored" |
| `kind: "web_answer"` | `excerpt` in a popover |

**My call: no reuse of Ask's evidence card.** Ask's only reusable helper is `citationTarget`
(`scripts/composites/ask-chat.js:61-65`). It parses an S3 report key, and pack sources do not
carry one. A small `SourceCard` inside the page is simpler than adapting it.

A collapsed **Sources** section at the bottom lists every source with the same card, so the
person can read the evidence without hunting chips.

### 6.7 Run details

`run_trace` and `models` go in a collapsed "Run details" disclosure. Show these fields as
plain key: value text:

- rounds;
- tokens / token_cap;
- refs gathered / cited;
- `ms.total` as seconds;
- planner, writer and verifier model ids.

`{"dropped":"size"}` reads "Too large to show". This disclosure is useful for the owner's
trust question ("what did it look at"). It is not needed for acting.

## 7. Acting on a pack

### 7.1 API module: `scripts/api/action-packs.js` → `window.FS.api.actionPacks`

The module follows `decisions.js`: live means `!useMocks && orgBaseUrl`, with no `orgWrite()`
gate. When not live, a small in-memory set of packs answers: one ready pack with sub-tasks,
weak, unsupported/not_checked and stale actions, plus one running pack. This lets the page
render without a backend.

The module is **the body whitelist**: every write builds its body from named fields only.

| Function | Request | Body sent |
|---|---|---|
| `list({state, siteId, archived})` | GET `/action-packs` | — (params skip null) |
| `get(id)` | GET `/action-packs/{id}` | — |
| `create({instruction, siteId})` | POST, `retry:false` | `{instruction, site_id}` |
| `cancel(id)` | POST `/cancel`, `retry:false` | `{}` |
| `archive(id, archived)` | POST `/archive` | `{archived: !!archived}` |
| `dismiss(id, aid)` | POST `.../dismiss` | `{}` |
| `apply(id, aid, fields?)` | POST `.../apply`, `retry:false` | `{}`, or `{fields}` filtered to `APPLY_EDIT_FIELDS[type]` (the caller passes `type`) |
| `exportMd(id)` | GET `/export`, `params:{format:'md'}` | — |
| `snapshot(id, ref)` | GET `.../sources/{ref}/snapshot` | — |

Ids and refs go through `encodeURIComponent`.

**My call: apply uses `retry:false`.** Replaying an apply is safe (it returns 200 when already
applied), but the automatic retry would run under a spinner the person cannot see. A 500
already marks the action `failed`, and the page offers Retry. Apply-all reports per action.

**My call: apply is a single function that returns an outcome object, and never throws on a
409.**

- It catches the thrown error.
- `err.body.state === "stale"` becomes `{kind:'stale', live, snapshot}`. It branches on
  `body.state`, not on the status code (hand-off §3.9).
- Any other 4xx becomes `{kind:'refused', status, message}`.
- A 500 becomes `{kind:'failed'}`.
- 200 becomes `{kind:'applied', result}`, or `{kind:'noop'}` when `result.noop` is set.

### 7.2 Stale dialog (ModalOverlay)

Title: "This task changed since the pack read it". The table has two columns: **Now** (`live`)
and **When the pack read it** (`snapshot`). The rows are status, deadline, responsible,
priority, text and "last changed" (`updated_at`). Rows that differ are marked with a "changed"
text label, not colour alone. The fields this action wanted to change are bold.

- Buttons: "Open Tasks" (`#/tasks`) and "Dismiss action". There is no "apply anyway" (AG5).
- When both `live` and `snapshot` are null: "This task changed or is no longer visible to
  you." The only button is Dismiss.
- When the dialog opens from an action already in state `stale`, the values are unknown until
  the person applies again. The dialog calls `apply()` once to fetch the 409 with live values.
  This is safe: a stale action writes nothing (`src/lambda_org_api.py:1306-1309`). On an
  archived pack, apply refuses with 409 before it reaches the stale branch (`:1256-1257`).
  In that case the dialog shows `applied_result.reason` as text instead: "changed", "task
  gone" or "task moved to another project". It shows no comparison.

### 7.3 Apply-all

The button reads "Apply all supported (n)". It shows when n > 0, where n counts
`actions.filter(a => a.verifier === 'supported' && a.applicable)`.

- The note "‹k› uncertain not included" counts weak actions with `applicable` set.
- On confirm, apply each action **sequentially** in `seq` order, never with `fields`, and
  never stop on a failure.
- Show a per-action result list: applied, already done, stale (with a link to the dialog),
  refused (with the message), or failed (with Retry).
- Re-GET the pack at the end. This follows backend spec §5.3 and hand-off §6.

**My call: Apply-all is in v1.** It is a short loop over the single apply, and the owner's
TEST hand-test checklist includes "Apply-all skips weak actions"
(`docs/runbooks/2026-11-01-action-packs-rollout.md:221-230`, in the pipeline repo).

After any apply, dismiss, archive or cancel, re-GET the pack. `orgRequest` already clears the
read cache on a successful non-GET (`scripts/api/_fetch.js:382-385`). Then emit
`FS.events` `content:edited` so an open Tasks view refreshes, if the bus is loaded.

## 8. Plain-text rendering

Every model- or user-originated string renders as a React text child:

- instruction, title, reading;
- `ask`, `reason`, conclusion `text`;
- `rationale`, every value in `proposed` and `target_snapshot`;
- `verifier_detail.reason`;
- source `title`, `who`, `excerpt`;
- snapshot `text`;
- export `content`, which is downloaded, never rendered.

Long text uses `white-space: pre-wrap; overflow-wrap: anywhere`. Hard rules:

- no `dangerouslySetInnerHTML`;
- no `innerHTML`;
- no `composites/markdown.js`;
- URLs only in `href`, and only when they start with `http:` or `https:`. Otherwise show the
  URL as text.

## 9. Accessibility basics

- Chips and badges pair text with tone. Colour is never the only signal (sub-task status,
  verifier, changed rows).
- Sub-task rows and ref chips are reachable by keyboard. The highlight follows focus as well
  as hover.
- A chip is a `button` with `aria-label`, e.g. "Source R2: L3 slab pour, 10 Oct 2026". Removed
  chips are `aria-disabled`.
- The running status is an `aria-live="polite"` region. It announces the change to ready,
  failed or cancelled once, not on every poll.
- Modals use ModalOverlay, which handles focus trap and focus return.
- Buttons keep their text while busy, and are disabled with `aria-busy`.
- Tokens only: no hard-coded colours. The repo test
  `tests/every-colour-names-a-token-that-exists.test.js` enforces this.
- Light and dark themes are checked in the browser, not from the CSS (memory note "measure the
  browser, don't trust CSS").

## 10. Files

| File | Change |
|---|---|
| `scripts/api/action-packs.js` | new (§7.1) |
| `scripts/pages/action-packs.js` | new. Registers `PAGES['/action-packs']`. Exports pure helpers for tests: `badgeFor(element)`, `subTaskView(sub, conclusion, actions)`, `chipTarget(ref, sources)`, `isWebOnly(refs, sources)`, `actionGroups(actions)`, `applyAllPlan(actions)` |
| `styles/` (the page's block in the components or app-shell stylesheet, as decision-review does) | `.fs-pack__*` BEM |
| `scripts/fs-globals.js` | `NAV_ITEMS.actionPacks` (§5.4) |
| `scripts/left-nav.js` | icon and MANAGEMENT items |
| `app-shell-preview.html` | `scripts/api/action-packs.js?v=1` after `api/index.js` (next to `decisions.js`, `:249`). `scripts/pages/action-packs.js?v=1` as `text/babel` next to `decision-review.js` (`:411`) |

## 11. Test strategy (node:test, in the style of `tests/decision-review.test.js`)

New file: `tests/action-packs.test.js`.

**API**

- Each write sends exactly its whitelisted body. Extra keys from the caller are dropped.
  `apply` with `fields` keeps only `APPLY_EDIT_FIELDS[type]`.
- `create` and `apply` pass `retry:false`.
- Paths encode ids.
- `apply` maps outcomes:
  - a thrown 409 with `body.state === 'stale'` becomes `stale` with live and snapshot;
  - any other 409 becomes `refused`;
  - 500 becomes `failed`;
  - 200 with `noop` becomes `noop`;
  - 200 becomes `applied`.
- The 404 envelope from `list` reaches the page as "not switched on".

**Pure helpers**

- `badgeFor` covers every row of the §6.5 table, including `verifier_detail: null`, the
  forward-compatible `verifier: "not_checked"` value, and an unknown value.
- Conclusion `uncertain` with a reason, with a null reason, and with a null detail.
- `subTaskView`:
  - maps conclusion indexes to the 1-based numbers of this response;
  - ignores out-of-range indexes and unknown seqs;
  - picks the reason text from `reason`, falling back to the code;
  - copes with `listed` absent, `true` and `false`;
  - `sub_tasks: null` renders nothing.
- `chipTarget`:
  - a ref missing from sources means removed;
  - `removed: true`;
  - each provenance and kind row;
  - `R10` vs `R2` lookup by ref, not by order.
- `isWebOnly`: all-web gives true, mixed gives false, no refs gives false.
- `applyAllPlan`: supported and applicable only, in `seq` order, with the weak count reported.
- Apply shows only when `applicable === true`. A close with null `target_snapshot` shows "Task
  not visible to you".

**Wiring (source scan)**

- `app-shell-preview.html` has both script tags, the API tag after `api/index.js`, and the
  page tag as `text/babel`.
- `NAV_ITEMS.actionPacks` has `platformAdminOnly: true`.
- `canSeeNav('actionPacks', {role:'admin', isAdmin:true})` is false, and true for
  `platform_admin`.
- `left-nav.js` lists `actionPacks`.

**Plain text (source scan)**

- `scripts/pages/action-packs.js` and `scripts/api/action-packs.js` contain no
  `dangerouslySetInnerHTML`, no `innerHTML`, and no reference to `FieldSight.Markdown` or
  `markdown`.

**Polling**

- With fake timers or an injected clock, the poll stops on ready, failed and cancelled.
- The poll backs off when `document.visibilityState === 'hidden'`.

**Manual check on TEST**, after merge to `dev`, as platform_admin:

- create a pack;
- see the reading while running;
- open R, D and W chips;
- apply one close;
- force a stale by editing the task by hand, then applying;
- Apply-all skips weak.

This is the runbook's hand-test (`docs/runbooks/2026-11-01-action-packs-rollout.md:221-230`).
Use an owner-alias test user: TEST sends real email.

## 12. Decisions made on the owner's behalf (my call)

1. One route `#/action-packs`, with `?id=` for detail and `?new=1` for the form. The detail is
   a page, not a window (§5.1).
2. Apply, Edit-and-apply, Dismiss, the stale dialog and Apply-all are all in v1. The backend
   supports them fully (§4.3), and the runbook's TEST hand-test needs them.
3. The New pack form lives on this page. The Ask, Day view and Tasks entry points, and the
   Tasks-side items (task_no, Agent badge, compliance-aggregator, history), are follow-ups
   (§2).
4. The nav uses `platformAdminOnly` under `internal`. The 404 probe comes before `on` (§5.4).
5. Unsupported actions are shown collapsed and split into "Not checked", "Contradicted" and
   "Not supported" by `reason_code`, never hidden. The owner's question includes "what did it
   not do".
6. `listed` is not relied on. `not_answered` and `dropped_by_checks` carry the meaning until
   the backend returns `listed` (§4.6.1).
7. `retry:false` on create, cancel and apply. No automatic resend after a timeout.
8. Own `SourceCard`, no reuse of Ask's citation code. Documents get no deep link in v1.
9. Polling: 4 s while visible and 15 s while hidden on detail; 15 s and 60 s on the list.

## 13. Open questions (owner only)

1. **Prod `internal`: may a platform admin apply on a customer's site?** The backend allows
   it, because cross-company counts as company admin for apply
   (`src/lambda_org_api.py:13307-13311`). On TEST this is what we want. On prod it means
   FieldSight staff could close a customer's tasks. The default if unanswered: the page
   follows `applicable` as on TEST, and the prod flag stays off until you say otherwise.
2. **Should the backend add `listed` to the GET `sub_tasks`?** It is in the #1252 contract
   wording but not stored (§4.6.1). The default if unanswered: no. The reason codes are
   enough, and the UI reads `listed` if it ever arrives.
