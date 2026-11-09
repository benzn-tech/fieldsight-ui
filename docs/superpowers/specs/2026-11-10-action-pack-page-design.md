# Action pack page — design

Date: 2026-11-10. Status: rev 2.

Rev 2 applies two things:

- the backend line's answer on the UI contract;
- the Fable review, which approved with changes.

§14 lists what changed.

Facts and sources:

- Backend facts come from `fieldsight-pipeline` `origin/develop`. They were read at `11b13981`
  and re-checked at `0e97467c`; no action-pack file changed between the two.
- Frontend facts come from `fieldsight-ui` `origin/dev` at `ed8b6a8`.
- Backend paths are relative to `fieldsight-pipeline/`.
- The backend's UI hand-off is `docs/handoffs/2026-11-01-action-packs-ui.md` ("the
  hand-off"). This spec relies on it for exact error strings.
- Where the code differs from the hand-off, the code wins (§4.6).

---

## 1. Intent

An action pack is the stored result of one background run (spec
`docs/superpowers/specs/2026-11-01-background-action-agent-design.md` §1). A person gives an
instruction. The run reads the records, then writes:

- a **reading**;
- **sub-tasks**, each marked done, partly or not done;
- a cited **conclusion**;
- **actions**: proposed changes to Tasks, plus drafts.

A second model then labels each element.

The owner wants to see, per instruction, **what the agent did, what it did not do and why**.
From that, the owner decides whether to trust it and act on it. The page answers three
questions at a glance:

1. **Did it understand me?** The reading and the sub-tasks answer this.
2. **Which parts did it do, and why not the rest?** The sub-task checklist and its reasons
   answer this.
3. **Can I believe each line and act on it?** These answer it:
   - the verifier badge and its reason;
   - ref chips that lead to the evidence;
   - an Apply button, shown only where the backend says this viewer may apply.

Nothing changes in Tasks until a person applies one action
(`src/lambda_org_api.py:1239-1294`).

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. A list of the viewer's packs, and a detail view of one pack.
- G2. A "New pack" form. It creates the pack, opens it, and polls until the run finishes.
- G3. The sub-task checklist and the verifier detail, rendered as in §6.
- G4. Apply, Edit-and-apply, Dismiss, Apply-all and the stale dialog, all on real data. The
  backend supports every one of them (§4.3).
- G5. Every piece of model and user text renders as plain text.

**Non-goals (follow-ups)**

- The entry points on other pages (hand-off §10): Ask "Do this in the background", Day view
  "Review this day", and Tasks "Tidy open items".
- Changes on the Tasks side:
  - `#task_no` (hand-off §8);
  - the "Agent" badge (hand-off §9);
  - including agent topics in `compliance-aggregator.js`;
  - the "Added from action pack" row in task history.

  Until the Agent badge lands, a task created by Apply shows the label derived from
  `is_live === false`, which is "nightly" today. That is acceptable on TEST, where only
  platform admins see packs. It must be fixed before the flag is `on`.
- A `.docx` export. The backend answers 400 on purpose in v1
  (`src/lambda_org_api.py:1045-1047`).
- Rerun with changes, chat refinement, and standing or nightly packs (backend spec §1.3).

**Anti-goals**

- AG1. Showing Apply on an action whose `applicable` is not `true`.
- AG2. Rendering model text as HTML or Markdown.
- AG3. Re-sending a create after a timeout.
- AG4. Rendering, counting or mentioning any action with `verifier == "unsupported"` (§4.6.2).
- AG5. Any "apply anyway" path past a stale result (backend spec A3).
- AG6. Reading an error envelope as success. A 403 or 404 resolves to an object; it does not
  throw (§7.1).

## 3. Who sees it

| `ACTION_PACKS` | Routes | Page |
|---|---|---|
| `off` (also unset or unknown) | Every route answers 404, as if it did not exist (`src/action_pack_view.py:104-122`, `src/lambda_org_api.py:734-740`) | Hidden from everyone except platform admins, who see the "not switched on" state |
| `internal` (TEST) | `platform_admin` only (`src/action_pack_view.py:120-121`) | Nav item for platform admins |
| `on` | Everyone, filtered per pack by reader | Needs the probe in §5.4 first |

**Under `internal`, a platform admin reads only the packs it created.** A platform admin has
only the creator reader role, not the others (`src/repositories/action_packs.py:78-82`,
`:183-195`; `_reader_clause`, `:453-473`). The other reader roles only matter at `on`:

- the creator, while the site is in their scope;
- an admin or GM of the site's company;
- the site's pm or site manager.

**Apply rights belong to whoever applies, checked at apply time.** A platform admin counts as
a company admin for apply (`_is_company_admin_of`, `src/lambda_org_api.py:13307-13311`, used
by `may_create_item_on_site`, `:963-981`). The page never decides this itself; it reads
`applicable` (§6.5).

**`company_inactive` never fires for a platform admin in v1.** The write gate exempts
platform admins (`_write_refused`, `src/lambda_org_api.py:436-443`). The
`failure === "company_inactive"` copy (§6.2) is for other roles at `on`.

## 4. Backend contract (as built)

All routes sit under `/api/org` and are dispatched at `src/lambda_org_api.py:1599-1602`; the
route regex is at `:710-712`.

- Every error body is `{"error": "..."}`.
- A malformed id, a wrong method, or a pack the caller may not read always gets 404
  `not found` (`:734-776`).

### 4.1 Routes

| Route | Handler | Body / query | Success |
|---|---|---|---|
| POST `/action-packs` | `create_action_pack` `:794-841` | exactly `{instruction, site_id?}` | 202 `{id, state:"queued"}` |
| GET `/action-packs` | `list_action_packs` `:844-868` | `?state=queued\|running\|ready\|failed\|cancelled&site_id=<uuid>&archived=false\|true\|all` | 200 `{packs:[row]}`, newest first, at most 50, no paging |
| GET `/action-packs/{id}` | `get_action_pack` `:1030-1038`, view `:984-1027` | — | 200, the pack (§6) |
| GET `/action-packs/{id}/export` | `:1041-1054` | `?format=md` only | 200 `{format, filename, content_type, content}` |
| GET `/action-packs/{id}/sources/{ref}/snapshot` | `:1057-1087` | — | 200 `{ref, url, fetched_at, text, truncated}` (`text` at most 200 kB) |
| POST `/action-packs/{id}/cancel` | `:1090-1116` | `{}` | 200 `{id, state:"cancelled"}` |
| POST `/action-packs/{id}/archive` | `:1119-1127` | exactly `{archived: bool}` | 200 `{id, archived}` |
| POST `/action-packs/{id}/actions/{aid}/dismiss` | `:1130-1157` | empty `{}` | 200 `{id, state:"dismissed"}` |
| POST `/action-packs/{id}/actions/{aid}/apply` | `:1239-1294`, `_apply_locked` `:1297-1317` | `{}` or `{fields:{...}}` | 200 `{id, state:"applied", applied_result}` |

**Who may call the write routes, and their refusals**

- **Cancel:** only the creator or a company admin; anyone else gets 403. A platform admin can
  cancel only as the creator (`:1100-1105`). A pack that has already finished answers 409
  `{state}`.
- **Archive:** any reader.
- **Dismiss:**
  - 409 `pack is archived`;
  - 409 `{error:"action is ‹state›", state}` when the action is already final
    (`:1153-1154`).

**Create rules** (`src/action_pack_view.py:125-144`, `src/lambda_org_api.py:802-841`):

- `instruction` is 1 to 2000 characters after trimming.
- `site_id` is required when the caller sees more than one site, which is always true for a
  platform admin. A site the caller cannot see, or that does not exist, gets 404
  `site not found`.
- One queued or running pack per person. A second create gets 409
  `you already have a pack in progress` (`:824-825`).
- 503 `the pack could not be started` means the row is already marked `failed`
  (`:830-839`).

**List rows** (`src/action_pack_view.py:613-619`) have the fields `{id, title, instruction,
state, failure, site_id, site_name, created_at, archived, action_counts}`.

- `action_counts` holds all five action states (`src/repositories/action_packs.py:95`).
- Those counts come from the stored rows, so they include unsupported actions. The list
  therefore shows no action counts (§5.2).

**GET sweeps dead runs first.** A run whose worker has been silent for 20 minutes becomes
`failed/internal` (`:779-791`, `:1034`; `src/action_pack_view.py:91`). Polling therefore
always ends.

### 4.2 How packs are created today

POST `/action-packs` is the only way in. `create_queued` has one caller in `src/`
(`src/lambda_org_api.py:822`). The only other user of the route is the TEST eval harness
(`scripts/action_pack_eval/live.py:74`).

There is no device, voice or Ask path. The web is the intended entry point (backend spec §10),
and this page's form is the first one.

### 4.3 Apply exists

All line numbers below are in `src/lambda_org_api.py`.

- **Pre-checks** (`:1253-1277`). None of these writes anything.
  - The pack must be readable (404), not archived (409) and `ready` (409 `{state}`).
  - The action must be visible (404 `action not found`), of an apply type (409 for drafts),
    and not `unsupported` (409).
  - The body must pass validation (400, `src/action_pack_view.py:374-393`).
  - Then the company-exit gate.
- **Idempotent replay.** If the action is already `applied`, the route returns 200 with the
  stored `applied_result` and writes nothing (`:1303-1305`).
- **Stale: the person's edit wins.** Nothing is written when:
  - a field the action touches has changed;
  - any edit was made after `as_of`;
  - the target is gone or has moved.

  The action becomes `stale` and the route answers 409
  `{error:"action is stale", state:"stale", live, snapshot}` (`:1181-1203`, `:1320-1330`).
  - Both `live` and `snapshot` are null when the caller cannot see the task.
  - Applying a stale action again re-reads `live` and returns the same 409 (`:1306-1309`).
- **The write.**
  - Close and update use the PATCH route's ACL, validators and `content_edits` audit, in one
    savepoint together with the action state (`:1160-1165`).
  - Create inserts the item under a per-pack "agent" topic (`:1167`).
  - The editable fields per type come from `APPLY_EDIT_FIELDS`
    (`src/action_pack_view.py:355-359`):

    | Type | Editable fields |
    |---|---|
    | close | `status`: `done` or `closed` |
    | update | `deadline` (null allowed), `responsible`, `priority`, `status` |
    | create | `text`, `responsible`, `deadline`, `priority` |

  - Edits are merged over the proposal (`:396-428`).
- **Server fault.** The savepoint rolls back, the action becomes `failed` with
  `{error:"internal"}`, and the route returns 500 `{error:"apply failed", code:"internal"}`
  (`:1285-1291`). A `failed` action can be applied again (`src/action_pack_view.py:90`).
- **`applied_result` shapes:**
  - close/update: `{action_item_id, content_edit_ids}`;
  - `{noop:true, action_item_id}` when the change was already made;
  - create: `{action_item_id, task_no, content_edit_ids}`, where `task_no` may be null;
  - stale: `{reason: changed|target_gone|target_moved}`;
  - failed: `{error}`.

There is no bulk endpoint; Apply-all is a loop in the UI (backend spec §5.3).

### 4.4 Existing web UI

There is none. `git grep -i "action-pack\|actionPack\|action_pack"` on `fieldsight-ui`
`origin/dev` finds nothing.

### 4.5 Frontend facts this spec builds on

**Routing.** The router uses hash routes with query params and no path params
(`scripts/router.js:12-24`). Pages are keyed by exact path. For reading params, see
`scripts/pages/timeline.js:38-39`.

**`FS.api.orgRequest`** (`scripts/api/_fetch.js`):

- Some failures **resolve** instead of throwing:
  - 403 → `{_accessDenied:true, status:403, error}` (`:342-347`);
  - 404 → `{_notFound:true, status:404, raw: body}` (`:349-350`);
  - a non-JSON answer of any status → `{_notFound:true, status}` (`:335-337`).
- Any other non-2xx **throws**, with `err.status` and `err.body` (`:352-370`).
- A thrown error carries `err.waking`, and the waking banner shows, when every failure was a
  timeout or a 502, 503 or 504 (`:236`, `:249-251`, `:366-369`). This holds even with
  `retry:false`, so a single backend 503 also sets `waking`.
- A non-GET is not repeated after a wake-shaped failure. A plain 5xx is repeated unless the
  call passes `retry:false` (`:186-235`).
- A successful non-GET clears the read cache (`:382-385`).

**Building blocks to copy or reuse**

| What | Where |
|---|---|
| Envelope-to-words pattern | `envelopeMessage`, `scripts/pages/decision-review.js:158-169` |
| Platform-admin-only nav item | `NAV_ITEMS.decisionReview` with `platformAdminOnly: true` (`scripts/fs-globals.js:405-410`), checked by `canSeeNav` (`:466-473`). MANAGEMENT section: `scripts/left-nav.js:28`, `:68` |
| Page and API pattern | `scripts/pages/decision-review.js` + `scripts/api/decisions.js`: live means `!useMocks && orgBaseUrl`, with no `orgWrite()` gate; in-memory mocks when not live; a body whitelist (`decisions.js:35-47`) |
| Modal | `scripts/composites/modal-overlay.js` |
| Dates | `FS.api.nzDateTime` and `nzDate` (`scripts/api/index.js:162-170`, `:223-227`) |
| Sites | `getOrgSites` (`scripts/api/org.js:84-95`). Rows carry `company_id` and `company_name` (backend `src/lambda_org_api.py:6610-6613`) |
| Site members | `getSiteMembers` (`scripts/api/org.js:669`) |

**Script order.** API modules load after `api/index.js` (`app-shell-preview.html:219`,
`:249`). Pages load as `text/babel` (`:411`).

**CI.** `node --test "tests/**/*.test.js"` with `TZ=Pacific/Auckland`
(`.github/workflows/tests.yml`).

### 4.6 The UI contract (backend line's answer, checked at `0e97467c`)

1. **Sub-tasks.** `sub_tasks` is null, or a list in plan order of
   `{id, ask, kind, status, actions, conclusion, reason_code, reason}`
   (`src/action_pack_stages.py:2156-2161`, `src/action_pack_view.py:508-529`).
   - `status` is `done`, `partly` or `not_done`.
   - `actions` holds the visible `seq` values.
   - `conclusion` holds 0-based indexes into the conclusion of this same response, already
     remapped for this reader.
   - **`reason_code` is the contract.** Its values are `not_answered`, `dropped_by_checks`,
     `no_evidence`, `not_found`, `ambiguous_target`, `out_of_scope`, `already_done` and
     `other` (`src/action_pack_stages.py:627-629`, `:1790-1792`, `:1808-1810`).
   - `listed` is not returned and will not be. The UI never reads it.
2. **Unsupported actions are never rendered.** This covers any action with
   `verifier == "unsupported"`, whatever its `reason_code` (not supported, `contradicted`,
   `not_checked`), in both hide modes. The quality-fixes spec
   `docs/superpowers/specs/2026-11-05-action-pack-quality-fixes-design.md:768` says
   "`unsupported` stays non-applicable and not shown".
   - GET returns these actions for eval and audit only.
   - The page filters them out first and shows nothing about them: no group, no badge, no
     count.
   - Unsupported conclusion lines are already hidden by the server
     (`src/action_pack_view.py:492-505`).
3. **Badges.**
   - Actions key on `verifier` (`supported` or `weak`) plus `verifier_detail.reason_code` and
     `verifier_detail.reason`.
   - Conclusion lines key on `confidence` (`supported` or `uncertain`) plus their own
     `verifier_detail`.
   - `verifier_detail` may be null or absent (old packs, uncited lines), so test it with
     `== null`.
   - `served` is stripped on purpose (`src/action_pack_view.py:532-545`).
4. **Export** is `.md` only.

## 5. Pages and routes

### 5.1 One route: `#/action-packs`

The page registers as
`window.FieldSight.PAGES['/action-packs'] = { Middle, layout: 'full-width' }`.

| Hash | Shows |
|---|---|
| `#/action-packs` | The list |
| `#/action-packs?id=<uuid>` | The detail view, with a "← All packs" link |
| `#/action-packs?new=1` | The New pack form, which a button on the list also opens |

**My call: the detail is a page, not a window.** A pack is a durable record. People link to
it, come back to it while it runs, and act on it over several minutes. The router has no path
params, so the id goes in a query param.

`document.title` is set as plain text: "‹title or instruction› · Action packs" on the detail,
"Action packs" on the list. The previous title is restored on unmount.

### 5.2 List

**Header**

- "Action packs" and a "New pack" button.
- Tabs: **Active** (the default, `archived=false`) and **Archived** (`archived=true`).
- A state select: All, Running, Ready, Failed, Cancelled.

**Rows.** Each row links to `?id=` and shows:

- `title`, or `instruction` cut to one line when there is no title;
- `site_name`;
- a state chip;
- `nzDateTime(created_at)`;
- "Failed (‹failure copy›)" when the run failed.

**No action counts on the list.** `action_counts` includes unsupported actions (AG4). The
detail view computes its own counts from the visible actions (§6.5).

**Envelopes**

| Response | Shows |
|---|---|
| `_notFound` with `status === 404` | "Action packs are not switched on in this environment." |
| `_notFound`, any other status | "Could not load (HTTP ‹status›)." |
| `_accessDenied` | its `error` |

**Polling.** Only while some row is queued or running, using the same chained timer as §6.2:
15 s while visible, 60 s while hidden.

At 50 rows, show "Showing the newest 50."

### 5.3 New pack form

The form is a `ModalOverlay` with `closeOnBackdrop:false`. It has two fields:

- **Site:** a select from `getOrgSites`. Required, with no default.
- **Instruction:** a textarea of 1 to 2000 characters, with a live count.

Submit sends exactly `{instruction, site_id}` with `retry:false` (AG3). `createOutcome`
(§7.1) maps the result in this order:

| Result | UI |
|---|---|
| 202 body with `id` | Close the form and go to `?id=<id>` |
| `_accessDenied` | Its `error`, shown inline |
| `_notFound`, status 404 | `raw.error` (e.g. "site not found"). If missing, "Action packs are not switched on in this environment." |
| `_notFound`, other status | "Could not reach the server (HTTP ‹status›)." |
| thrown 409, `body.error` "you already have a pack in progress" | That text, plus a link to the running pack (list with `state=running`, then `state=queued`) |
| thrown 409, `body.error` "company_inactive" | "This project's company is suspended or has left FieldSight." |
| thrown 400, or any other 409 | `body.error`, shown inline |
| thrown 503 with `body.error === "the pack could not be started"` | "The pack could not be started. Try again." The form keeps its contents |
| any other thrown error (waking, network, timeout, 5xx without that body) | "We could not tell whether the pack started. Check the list before trying again." Link to the list; the waking banner may also show. Never re-send automatically |

### 5.4 Nav and the flag

**v1 (`internal`).** Add this nav item after `decisionReview` in the MANAGEMENT section, with
an existing `left-nav.js` icon:

```js
NAV_ITEMS.actionPacks = { permission: P('settings','view'), label: 'Action packs',
  path: '/action-packs', platformAdminOnly: true }
```

Wherever the flag is off, including prod today, a platform admin sees the item and lands on
the "not switched on" state (§13).

**Before `on` (follow-up).** Replace the role check with a probe:

1. Call `GET /action-packs?state=running` once per session and cache the answer.
2. On 200, show the nav item.
3. On `_notFound` with status 404, hide it.

**My call:** the probe is deferred, because under `internal` the role check gives the same
answer with no extra request.

## 6. Detail view: field → UI

Sections, top to bottom: header, reading, sub-tasks, conclusion, actions, sources, run
details. Every text node is a React text child (§8).

**Visible actions** means `actions.filter(a => a.verifier !== 'unsupported')`. Every count,
group, link and plan below uses only this list (AG4).

### 6.1 Header

- **Title:** `title`, or `instruction` when there is no title.
- **Instruction:** shown in full in a muted block, prefixed "You asked:".
- **Facts line:**
  - `site_name`;
  - the state chip;
  - "Started ‹nzDateTime(created_at)›";
  - "Read as of ‹nzDateTime(as_of)›", once the pack is ready;
  - "Archived", when archived;
  - "Another company's project · ‹company_name›", when the viewer is a platform admin and the
    pack's `site_id` appears in `getOrgSites` with a `company_name`. A platform admin's home
    company owns no customer sites, so every such site counts. Omit it if the site is not
    found.
- **Buttons:**
  - **Cancel**, while queued or running and `is_creator` is true.
  - **Archive** / **Unarchive**.
  - **Export .md**, once the pack is ready. It downloads `content` as `filename` through a
    Blob and a temporary `<a download>`.

### 6.2 States and polling

| State | Body |
|---|---|
| loading | "Loading…" |
| `_notFound`, status 404 | "This pack does not exist or you cannot see it." with a link back |
| `_notFound`, other status | "Could not load (HTTP ‹status›)." with Retry |
| `_accessDenied` | its `error` |
| `queued` | "Waiting to start…" |
| `running` | "Working… this usually takes 1–5 minutes." Once `reading` or `title` exists, show it under "I read this as:", so the person can cancel early |
| `ready` | the full view |
| `failed` | the failure copy (below) and "Run again", which opens the form prefilled with the same instruction and site |
| `cancelled` | "Cancelled.", plus the reading if there is one |
| fetch error thrown | its message, with Retry |

**Failure copy**

| `failure` | Copy |
|---|---|
| `company_inactive` | "This project's company is suspended or has left FieldSight, so the run stopped." |
| anything else (`budget`, `model`, `tools`, `verifier`, `internal`, …) | "The run could not finish (‹failure›). Try again." |

**Polling: a chained timer, never `setInterval`**

- The next GET is scheduled only after the previous one has settled, so requests never
  overlap.
- Poll GETs pass `retry:false`.
- The delay is 4 s when `document.visibilityState === 'visible'` and 15 s when hidden. When
  the tab becomes visible again, poll once at once.
- Stop on `ready`, `failed` or `cancelled`, and on any envelope (`_notFound` or
  `_accessDenied`), which then renders its state.
- Stop on unmount and when the `id` changes. Drop any response that arrives after that.
- If a poll throws, keep the last good view, show "Could not refresh — retrying", and carry on
  at the next tick.

### 6.3 Sub-tasks: checklist under the reading

The checklist shows only when `sub_tasks` is a non-empty array; null renders nothing. Rows
follow plan order.

**Each row has:**

- **Status chip:** an icon and a word.
  - `done`: "Done", ok tone;
  - `partly`: "Partly", warn tone;
  - `not_done`: "Not done", muted tone.
- **`ask`.**
- **`kind` label** (`src/action_pack_stages.py:623`).
- **Reason line**, only for `partly` and `not_done`. `reasonLine` decides it, where "empty"
  means null, undefined or whitespace only:

  | `reason` | `reason_code` | Reason line |
  |---|---|---|
  | non-empty | `not_answered` or `dropped_by_checks` | `reason`, then the code text in muted style |
  | non-empty | any other | `reason` only |
  | empty | a known code | the code text |
  | empty | `other`, or unknown | none |

- **Links:** "Actions: Action 1, Action 3" and "Findings: 1, 2". Findings are numbered from 1
  over this response's conclusion. Indexes that do not resolve are ignored.

**Code text** (`src/action_pack_stages.py:627-629`)

| Code | Text |
|---|---|
| `no_evidence` | No evidence found in the records |
| `not_found` | Could not find what this refers to |
| `ambiguous_target` | More than one item could be meant |
| `out_of_scope` | Outside what this pack may change |
| `already_done` | Already done |
| `not_answered` | The agent did not answer this part |
| `dropped_by_checks` | What the agent proposed was removed by checks |
| `other` | — |

**Linking and keyboard**

- Rows are focusable (`tabIndex=0`).
- Hover or focus on a row highlights the action cards and conclusion lines it links to.
- Clicking "Action 3" scrolls to that card and focuses it.
- A `seq` that is not in the visible actions is ignored. This happens, for example, when that
  action is unsupported.

### 6.4 Conclusion

Each line is `{text, refs, confidence, verifier_detail}`, numbered from 1.

- **Text:** `text`, as plain text.
- **Ref chips:** one per ref (§6.6).
- **`confidence: "uncertain"`:** an **"Uncertain"** badge. If `verifier_detail != null` and
  its `reason` is non-empty, show the reason as muted plain text below the line.
- **`confidence: "supported"`:** no badge.
- **Web-only:** "Web source, not your project's documents" when **every** ref resolves to a
  `provenance: "web"` source. A line with no refs never gets this label (hand-off §5).

### 6.5 Actions

**Groups.** Group the visible actions by state only, each group in `seq` order:

| Group | States |
|---|---|
| **To review** | `proposed`, `failed` |
| **Changed since read** | `stale` |
| **Done** | `applied`, `dismissed` |

An unknown state goes into Done. The section heading counts the visible actions only, for
example "3 to review · 1 applied", and leaves out zero counts.

**Card head**

- "Action ‹seq›".
- The type label: Close task, Update task, New task, Draft RFI, Draft email or Note
  (`src/action_pack_view.py:624-625`).
- For close and update: "#‹target_task_no›" when it is non-null, then `target_snapshot.text`.
- When `target_snapshot == null` on a close or update, show **"Task not visible to you, or no
  longer exists"** and no Apply. The snapshot is null both when the live item is gone and when
  the reader cannot see it (`src/lambda_org_api.py:993-997`,
  `src/action_pack_view.py:585-586`).

**What the action changes**

| Type | Shown |
|---|---|
| close | "Status: ‹snapshot.status› → ‹proposed.status›" |
| update | before → after for each key of `proposed`, with "before" taken from `target_snapshot` |
| create | `text`, `responsible`, `deadline` and `priority` from `proposed` |
| draft | `subject`, `body` and `to`, or `text`, in a `pre-wrap` block with **Copy**. Drafts are never applied |

Deadlines are `YYYY-MM-DD` and are shown as dates.

**Rationale and evidence.** Show `rationale` as plain text, then the ref chips. Actions get no
derived web label: the verifier reason already covers web-only evidence
(`src/action_pack_verify.py:349-354`).

**Verifier badge**

| `verifier` | Badge | Reason line |
|---|---|---|
| `supported` | none | none |
| `weak` | **Uncertain** | `verifier_detail.reason` as plain text, when `verifier_detail != null` and the reason is non-empty. A code cap writes fixed text, e.g. "Deadline assumed: date raised." |
| anything else | not rendered: filtered out before grouping (AG4) | — |

**State line**

| State | Line |
|---|---|
| `applied` | "Applied ‹nzDateTime(applied_at)›". If `applied_result.noop`: "Already done". For a create with a `task_no`: "Created #‹task_no›"; without one: "Created", never "#null". Links to `#/tasks` |
| `dismissed` | "Dismissed" |
| `stale` | "Changed since the pack read it", plus a "Why?" button that opens the stale dialog (§7.2) |
| `failed` | "Last apply failed — you can retry". The Apply button reads "Retry" |

**Buttons.** None show while Apply-all runs (§7.3) or on an archived pack. Otherwise:

| Button | Shown when |
|---|---|
| **Apply** | `applicable === true` (AG1) |
| **Edit and apply** | `applicable === true`, or `applicable_reason === "responsible_not_member"` |
| **Dismiss** | state is `proposed`, `failed` or `stale` |

When `applicable_reason === "responsible_not_member"`, the card also says "Assignee is not on
this project", and Edit and apply is the only way to apply it.

**Edit and apply form.** It shows exactly the fields in `APPLY_EDIT_FIELDS[type]`.

- **Prefill:**
  - create: `proposed`;
  - update: `proposed` over `target_snapshot`;
  - close: `proposed.status`, or `done` if there is none.
- **`responsible`** is a select of display names from `getSiteMembers(site_id)`.
- **An update's `deadline`** may be cleared, which sends `null`.
- **Submit** sends in `fields` only the keys whose value differs from `proposed`. A key absent
  from `proposed` counts as different when it is non-empty, or when it is set to null. If no
  key differs, the body is `{}`.

### 6.6 Ref chips and sources

A chip shows the ref (`R2`, `D1`, `W1`). It is looked up in `sources[]` by `ref`, never by
position: sources sort as text, so `R10` comes before `R2` (hand-off §2, §5).

| Source | The chip opens (all plain text) |
|---|---|
| missing, or `removed: true` | nothing: a greyed "Source removed" chip that cannot be clicked |
| `provenance: "records"` | a card with `title`, `nzDate(date)`, `who`, and `excerpt` as a quote. When `site_id` and `date` are present, an "Open day" link to `#/timeline?site=‹site_id›&date=‹date›` |
| `provenance: "documents"` | a card with `title`, "rev ‹revision›, p. ‹page_from›–‹page_to›" and `excerpt`. No deep link |
| `kind: "web_source"` with `snapshot_s3_key` | the snapshot modal (below) |
| `kind: "web_source"` without a snapshot | `title`, `url` as a link, and "Page not stored" |
| `kind: "web_answer"` | `excerpt` in a popover |

**Snapshot modal.** GET the snapshot, then show:

- "Snapshot of ‹url› taken ‹fetched_at›";
- `text` in a `pre-wrap` block, with "(truncated)" when `truncated` is true;
- a link to the live page.

On `_notFound`, show "Snapshot not available".

**My call: the page has its own `SourceCard`.** Ask's `citationTarget`
(`scripts/composites/ask-chat.js:61-65`) parses an S3 report key, which pack sources do not
carry. A collapsed **Sources** section at the end lists every source using the same card.

### 6.7 Run details

A collapsed "Run details" section shows these as plain key: value text, from `run_trace` and
`models`:

- rounds;
- tokens and `token_cap`;
- refs gathered and refs cited;
- `ms.total`, in seconds;
- the planner, writer and verifier models.

A trace of `{"dropped":"size"}` shows "Too large to show".

## 7. Acting on a pack

### 7.1 API module: `scripts/api/action-packs.js` → `window.FS.api.actionPacks`

The module follows `decisions.js`: live means `!useMocks && orgBaseUrl`, and there is no
`orgWrite()` gate.

When not live, an in-memory set of packs answers. It holds:

- one ready pack with sub-tasks, a weak action, an unsupported action (to prove the filter
  works), a stale action, and two actions on the same target;
- one running pack.

Every write builds its body from named fields only.

| Function | Request | Body | Options |
|---|---|---|---|
| `list({state, siteId, archived, poll})` | GET `/action-packs` | — | `retry:false` when `poll` |
| `get(id, {poll})` | GET `/action-packs/{id}` | — | `retry:false` when `poll` |
| `create({instruction, siteId})` | POST `/action-packs` | `{instruction, site_id}` | `retry:false` |
| `cancel(id)` | POST `/cancel` | `{}` | `retry:false` |
| `archive(id, archived)` | POST `/archive` | `{archived: !!archived}` | `retry:false` |
| `dismiss(id, aid)` | POST `.../dismiss` | `{}` | `retry:false` |
| `apply(id, aid, type, fields)` | POST `.../apply` | `{}`, or `{fields}` with only the keys in `APPLY_EDIT_FIELDS[type]` | `retry:false` |
| `exportMd(id)` | GET `/export` | — | `params:{format:'md'}` |
| `snapshot(id, ref)` | GET `.../sources/{ref}/snapshot` | — | — |

Ids and refs go through `encodeURIComponent`.

**My call: every write uses `retry:false`, so nothing is ever repeated behind the person's
back.** After any write that is not a clean success, the page re-GETs the pack, and that GET
is the truth. Replaying an apply is idempotent, so the person may press Retry safely.

**Outcome mapping.** Each write returns an outcome object and never throws. The pure helpers
are `applyOutcome`, `writeOutcome` and `createOutcome`. They check in this order:

1. **Envelopes first:**
   - `_accessDenied` → `{kind:'refused', status:403, message: res.error}`;
   - `_notFound` with `status === 404` →
     `{kind:'refused', status:404, message: res.raw && res.raw.error}`;
   - `_notFound` with any other status → `{kind:'unknown', status}`.
2. **An object with no envelope** is a 200.
3. **A thrown error**, mapped per write:

| Write | 200 | Thrown |
|---|---|---|
| apply | `{kind:'noop'}` if `applied_result.noop`, otherwise `{kind:'applied', result}` | `body.state === 'stale'` → `{kind:'stale', live, snapshot}` (branch on the body, not the status code); status 500 → `{kind:'failed'}`; any other 4xx with a body → `{kind:'refused', status, message: body.error}`; anything else (502, 503, 504, timeout, network, no body) → `{kind:'unknown'}`: show "Could not confirm — refreshing", then re-GET |
| dismiss | `{kind:'ok'}` | 409 with `body.state === 'dismissed'` → `{kind:'ok'}`, because a second dismiss counts as success; other 4xx → refused; else unknown |
| cancel | `{kind:'ok'}` | 409 with a `body.state` → `{kind:'finished', state}`, then refresh; other 4xx → refused; else unknown |
| archive | `{kind:'ok'}` | 4xx → refused; else unknown |
| create | see §5.3 | see §5.3 |

After any apply, dismiss, archive or cancel, re-GET the pack.

**My call: no `content:edited` event.** `FS.events` documents `content:edited` as emitted only
by `FS.api.actions.settleSave` (`scripts/api/events.js:6`). Its only listener bumps a version
chip on Today (`scripts/pages/today.js:1366-1374`, `:1688-1700`). Today is not mounted while
this full-width page is, and both Today and Tasks refetch when you navigate to them.

### 7.2 Stale dialog (ModalOverlay)

The title is "This task changed since the pack read it". The dialog shows, in this order:

1. **The stored reason, when `applied_result.reason` exists:**
   - `changed`: "Someone changed this task after the pack read it."
   - `target_gone`: "The task no longer exists."
   - `target_moved`: "The task moved to another project."
2. **The comparison.**
   - It shows at once when the dialog opens from a fresh 409 that carries `live` and
     `snapshot`.
   - Otherwise a **"Compare with now"** button calls `apply()` once, to fetch the 409 with
     the live values. That is safe, because a stale action writes nothing
     (`src/lambda_org_api.py:1306-1309`).
   - The button is hidden on an archived pack, because apply refuses there before it reaches
     the stale branch (`:1256-1257`).

**The comparison table** has two columns, **Now** (`live`) and **When the pack read it**
(`snapshot`). Its rows are status, deadline, responsible, priority, text, and "last changed"
(`updated_at`).

- Rows that differ carry a "changed" label, not colour alone.
- The fields the action wanted to change are in bold.
- When `live` and `snapshot` are both null, show "This task changed or is no longer visible
  to you."

**Buttons:** "Open Tasks" (`#/tasks`) and "Dismiss action". There is no apply anyway (AG5).

### 7.3 Apply-all

**The plan.** `applyAllPlan(visibleActions)` takes the actions with
`verifier === 'supported' && applicable === true`, in `seq` order.

- **Same target (my call).** When more than one planned action shares a
  `target_stable_id`, only the first is applied; the second would go stale by design. Each
  later one is listed as skipped with "Another action changes this task", and can still be
  applied on its own. Creates have no target and are never skipped.
- The plan also counts the applicable weak actions, for the note "‹k› uncertain not
  included".

**The button.** "Apply all supported (n)", where n counts only the actions the plan will
apply. It shows when n > 0.

**On confirm:**

- Apply the actions **one after another**, never with `fields`.
- Never stop on a failure.
- While it runs, disable every per-card Apply, Edit and Dismiss button, and Apply-all itself.
- On unmount, finish the current request, then stop.

**Report.** One row per action: applied, already done, stale (with a link to the dialog),
refused (with its message), failed (with Retry), not confirmed, or skipped (with its text).
Re-GET the pack at the end.

**My call: Apply-all is in v1.** The owner's TEST hand-test includes "Apply-all skips weak
actions" (`docs/runbooks/2026-11-01-action-packs-rollout.md:221-230`, pipeline repo).

## 8. Plain-text rendering

Every string from a model or a user renders as a React text child:

- the instruction, title and reading;
- `ask`, `reason`, and the conclusion `text`;
- `rationale`, plus every value in `proposed` and `target_snapshot`;
- `verifier_detail.reason`;
- a source's `title`, `who` and `excerpt`;
- the snapshot `text`.

Export `content` is downloaded, never rendered. Long text uses
`white-space: pre-wrap; overflow-wrap: anywhere`.

**Never used:** `dangerouslySetInnerHTML`, `innerHTML`, and `composites/markdown.js`.

**Links:**

- A URL goes into an `href` only if it starts with `http:` or `https:`.
- Any other URL is shown as text.
- External links use `rel="noopener noreferrer"`.

## 9. Accessibility basics

- Chips and badges always pair text with colour.
- Sub-task rows and ref chips can be reached by keyboard, and focus highlights the same things
  hover does.
- A chip is a `button` with an `aria-label`, e.g. "Source R2: L3 slab pour, 10 Oct 2026". A
  removed chip is `aria-disabled`.
- The running status is an `aria-live="polite"` region. It announces the change to ready,
  failed or cancelled once.
- Modals use `ModalOverlay`.
- Busy buttons keep their text and get `disabled` and `aria-busy`.
- Colours come from tokens only, enforced by
  `tests/every-colour-names-a-token-that-exists.test.js`.
- Light and dark themes are checked in the browser.

## 10. Files

| File | Change |
|---|---|
| `scripts/api/action-packs.js` | new (§7.1); exports the outcome helpers for tests |
| `scripts/pages/action-packs.js` | new; registers `PAGES['/action-packs']` and exports the pure helpers |
| `styles/action-packs.css` | new: the `.fs-pack__*` block, tokens only |
| `scripts/fs-globals.js` | `NAV_ITEMS.actionPacks` |
| `scripts/left-nav.js` | the icon and the MANAGEMENT entry |
| `app-shell-preview.html` | the stylesheet link and two script tags; bump the `?v=` keys of the changed files only (`fs-globals.js`, `left-nav.js`) |

## 11. Test strategy (node:test, as in `tests/decision-review.test.js`)

**API — `tests/action-packs-api.test.js`**

- Each write sends exactly its whitelisted body.
- `create`, `cancel`, `archive`, `dismiss` and `apply` pass `retry:false`.
- Paths encode their ids.
- Outcome mapping for every write:
  - each envelope case: 403, 404 with `raw.error`, `_notFound` with a status other than 404;
  - 200;
  - apply: stale, 500, other 4xx, 502/504/no body as unknown, noop;
  - dismiss: a 409 with state `dismissed` counts as ok;
  - cancel: a 409 means finished;
  - create: a 503 carrying the start-failed body is told apart from a waking 503 or a 503
    with no body.

**Pure helpers — `tests/action-packs-page.test.js`**

| Helper | Cases |
|---|---|
| `visibleActions` | drops `unsupported` for every `reason_code`; counts exclude them |
| `actionGroups` | `applied`, `dismissed`, `stale`, `proposed`, `failed` and an unknown state, each in `seq` order |
| `actionBadge` | supported; weak with a reason; weak with a null detail; weak with no detail |
| `conclusionBadge` | uncertain with a reason; with a null reason; with no detail |
| `reasonLine` | every row of the §6.3 table; whitespace counts as empty |
| `subTaskView` | conclusion indexes become 1-based numbers; out-of-range indexes are ignored; unknown or unsupported seqs are ignored; `listed` is never read; null renders nothing |
| `chipTarget` | missing; removed; each provenance/kind row; `R10` vs `R2` |
| `isWebOnly` | conclusion lines |
| `applyAllPlan` | supported and applicable only, in `seq` order; same-target duplicates skipped, creates not; the weak count |
| `editFields` | prefill per type; `fields` holds only the diff; a deadline can be cleared to null |
| `failureText` | including `company_inactive` |
| `createdText` | with a null `task_no` |
| `staleReasonText` | the three reasons |
| `envelopeState` | 404 → not switched on; any other status → "Could not load (HTTP n)" |

**Polling — `tests/action-packs-poll.test.js`**

`createPoller({fetch, onData, isDone, delay, visibility})`, driven by an injected timer:

- no second fetch starts before the first settles;
- it stops on `ready`, `failed` and `cancelled`;
- it stops on an envelope;
- it uses the hidden delay while hidden;
- `stop()` cancels the next tick and drops a late response.

**Wiring (source scan)**

- `app-shell-preview.html` has the API tag after `api/index.js`, the page tag with
  `type="text/babel"`, and the stylesheet link.
- `NAV_ITEMS.actionPacks` has `platformAdminOnly: true`.
- `canSeeNav` returns false for a company admin and true for a platform admin.
- `left-nav.js` lists `actionPacks`.

**Plain text (source scan).** The new files contain no `dangerouslySetInnerHTML`, no
`innerHTML`, and no Markdown component.

**Manual check on TEST** (runbook `:221-230`), as a platform admin:

1. Create a pack.
2. Watch the reading appear while it runs.
3. Open an R, a D and a W chip.
4. Apply one close.
5. Force a stale action.
6. Run Apply-all and check that it skips weak actions.

## 12. Decisions made on the owner's behalf (my call)

1. One route, `#/action-packs`, with `?id=` and `?new=1`. The detail is a page, not a window.
2. Apply, Edit-and-apply, Dismiss, the stale dialog and Apply-all are all in v1.
3. The New pack form lives on this page. The entry points on other pages and the Tasks-side
   items are follow-ups.
4. The nav item is `platformAdminOnly` under `internal`. The probe comes before `on`.
5. Unsupported actions are never rendered or counted, and the list shows no action counts.
6. Every write uses `retry:false`. Any other outcome leads to a re-GET, which is the truth.
7. Apply-all applies only the first action per target and lists the rest as skipped.
8. No `content:edited` event (§7.1).
9. The page has its own `SourceCard`, and documents get no deep link in v1.
10. Polling uses a chained timer: on the detail, 4 s visible and 15 s hidden; on the list,
    15 s and 60 s.

## 13. Open questions (owner only)

1. **On prod `internal`, may a platform admin apply on a customer's site?** The backend allows
   it, because a cross-company caller counts as a company admin for apply
   (`src/lambda_org_api.py:13307-13311`). On prod, that means FieldSight staff could close a
   customer's tasks.
   - Default: the page follows `applicable`, as on TEST, and the prod flag stays off until you
     decide.
2. **Note, not a question.** On prod the flag is off, so a platform admin sees the "Action
   packs" nav item and lands on the "not switched on" state. Say if you want it hidden there;
   hiding it needs the probe in §5.4.

## 14. Changes in rev 2

**From the backend line's answer:**

- Unsupported actions are never rendered. The "not shown as reliable" group and the
  not_checked badge are removed.
- `listed` is removed; `reason_code` is the contract.
- The badge keys are as in §4.6.3.
- No docx export, by design.
- Cross-company apply stays an open question.

**From the Fable review:**

1. Every write checks envelopes before anything else (§7.1).
2. A backend 503 is told apart from a waking 503, and apply gains an `unknown` outcome.
3. Polling uses a chained timer, passes `retry:false`, and stops on an envelope.
4. The null-snapshot text is now "not visible to you, or no longer exists".
5. Apply-all skips the second action on the same target.
6. Groups are by state only.
7. The sub-task reason line is deterministic.
8. Edit-and-apply prefills, and sends only the keys that changed.
9. The `content:edited` event is dropped.
10. "Not switched on" shows only for a 404 `_notFound`.
11. The facts line shows "Another company's project".
12. Nits:
    - the null check is `== null`;
    - cards say "Action 3";
    - actions get no web label;
    - the retry policy is set per write;
    - `company_inactive` has its own copy;
    - "Created" is null-safe;
    - controls are disabled during Apply-all;
    - the stale dialog shows the stored reason before "Compare with now";
    - `document.title` is plain text;
    - the prod nav note.
