# Programme Breakdown, Allocation & Site-Speech Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an imported programme into work that can be given to people — mentions visible on the tasks they are about, contract tasks splittable into zones with an owner each, and a subtask ticked off on site moving the programme.

**Architecture:** Every decision that can be got quietly wrong lives in a pure module with a contract test, and the pages are thin. Three such modules already exist (Tasks 0.1–0.3 below, all merged); the remaining tasks wire them into pages and add the two backend pieces. Nothing is written to `programme_tasks` before a human accepts it, and nothing inferred is ever stored as data.

**Tech Stack:** Plain ES2017+ browser JS, React 18 via Babel standalone, `node:test`. Backend: Python 3.10+ / psycopg 3, Aurora PostgreSQL, `pytest`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-03-programme-breakdown-allocation-design.md`. This is the only plan for Project 3.
- **Project 1 must be released to prod first.** `fieldsight-pipeline#209` (develop→main) is open and unmerged. Every task here depends on `programme_tasks` existing in prod.
- **An inferred order is never stored as data.** Applies to AI-generated sequence (§3) and to zone splits (§4). A proposal a human accepts is fine; a value the system wrote because it seemed likely is not.
- **Nothing is written before acceptance**, and nothing is indexed before it is written (§5.5).
- **Do not build a second review queue.** The matcher's suggestion queue exists; breakdown proposals converge on it.
- **Tasks 5 and 6 additionally depend on `fieldsight-ui#152`** (`feat/programme-autosave`), which is where the org-api per-task write lives. It is stacked behind ui#150 and blocked on a scroll frame-rate measurement.
- **`updateTask` and `createTask` mean different things on different branches.** On `main` today, `updateTask(programmeId, taskId, patch)` PATCHes the legacy `/programmes/{id}/tasks/{taskId}` route. On `feat/programme-autosave`, `updateTask(orgSiteId, taskId, patch)` PATCHes org-api's `/programme/tasks/{id}` and carries `row_version`. Same names, different signature, different endpoint, different backend. Check which one is in the tree before calling either.
- **Load order:** any new `scripts/api/*.js` module must be registered in `app-shell-preview.html` *after* `scripts/api/index.js`, which assigns `window.FS.api` wholesale and silently wipes anything registered earlier.
- **Cache-busters:** bump the `?v=` on every edited script tag, or the browser serves the old file and the change looks like it did nothing.
- `fieldsight-ui`'s `main` is production and auto-deploys on merge. `fieldsight-pipeline` merges to `develop` (test) and releases via `develop`→`main`.

---

## Task 0: Already done — pure layers

Recorded so nobody rebuilds them. All merged to `main`, none wired to a page.

- [x] **0.1 `scripts/api/programme-mentions.js`** (ui#168) — indexes suggestions by task and by topic; `mentionSummary` returns `mentioned` / `silent` / `unknown` and refuses to claim silence the loaded data cannot support. Owns `docIdOf`, the third and last home for the two-identifier-spaces rule.
- [x] **0.2 `scripts/api/programme-zone-split.js`** (ui#169) — plans N local children from a task and a zone list. Parallel by default; sequential on request. Refuses undated headers, duplicate zones, partial assignee lists.
- [x] **0.3 `scripts/api/programme-rollup.js`** (ui#170) — duration-weighted rollup with coverage; `applyRollup` returns null rather than lowering recorded progress or writing a partial breakdown.
- [x] **0.4 Backend prerequisites** — `fieldsight-pipeline#207` (confirm writes Aurora, not the derived document) and `#208` (a site manager can read suggestions raised from their own words). Both merged to `develop`, awaiting #209.

---

## Task 1: Complete the mock fixtures so the report-topic link can be built

**Files:**
- Modify: `scripts/mock/programme-suggestions.fixture.js`
- Modify: `scripts/mock/daily-report.fixture.js`
- Modify: `tests/programme-mentions-contract.test.js` (un-skip the recorded gap)

**Interfaces:**
- Consumes: `programme-mentions.indexByTopic`, `mentionsForTopic`
- Produces: fixtures where a suggestion's `topic_id` equals some report topic's `topic_row_id`

The report-topic placement (Task 3) cannot be demoed without this, and would read as "not built" rather than "fixture incomplete". There are two halves and both are needed.

- [ ] **Step 1: Read the skipped test that records the gap**

`tests/programme-mentions-contract.test.js`, the test named *"the report-topic placement cannot be demoed on the current fixtures"*. It states exactly what is missing and why it was left.

- [ ] **Step 2: Add `topic_row_id` to the daily-report fixture topics**

`scripts/mock/daily-report.fixture.js` topics carry only the per-report sequential `topic_id` (0, 1, 2…). Add a `topic_row_id` to each — a stable uuid-shaped string, e.g. `'topic-row-2026-04-29-0'`. Do NOT reuse `topic_id`: the whole point is that they are different identities.

- [ ] **Step 3: Point the suggestions fixture at those ids**

`scripts/mock/programme-suggestions.fixture.js` rows already claim (in the file header) to come from the 2026-04-29 report's topics 1, 2 and 3. Give each row a `topic_id` equal to the corresponding topic's new `topic_row_id`.

- [ ] **Step 4: Turn the skipped test into a real assertion**

The file's existing `loadFixtures()` helper loads two fixtures into a `vm`
sandbox; extend its list with `daily-report.fixture.js` and return the report
alongside the others.

```js
test('fixture suggestions link to fixture report topics', () => {
  const byTopic = indexByTopic(SUGGESTIONS);
  const topics = FIX.dailyReport.topics;   // whatever key that fixture publishes
  const linked = topics.filter(t => mentionsForTopic(t, byTopic).length);
  assert.ok(linked.length > 0,
            'no report topic resolved a suggestion — check that the '
            + "suggestion's topic_id equals the topic's topic_row_id, not "
            + 'its per-report topic_id');
});
```

Confirm the fixture's export key before writing the test (`grep 'fixtures\.'
scripts/mock/daily-report.fixture.js`) — the programme fixture publishes as
`fixtures.programme`, and guessing that kind of name is what made the first
version of this contract test assert against `undefined` and pass vacuously.

- [ ] **Step 5: Run the suite**

Run: `node --test tests/*.test.js`
Expected: PASS, and the skipped count drops to 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/mock/ tests/programme-mentions-contract.test.js
git commit -m "test(programme): let the fixtures express the topic-to-programme link"
```

---

## Task 2: Mentions inline on the Gantt row

**Files:**
- Modify: `scripts/pages/programme.js`
- Modify: `app-shell-preview.html` (cache-buster only)
- Test: `tests/programme-mentions.test.js` (already covers the data; this task adds no new pure logic)

**Interfaces:**
- Consumes: `window.FS.api.programmeMentions.{indexByTask, mentionSummary}`, `window.FS.api.programme.getSuggestions`
- Produces: nothing other modules consume

**Do not add matching logic here.** If this task starts computing a document id inline, stop — `docIdOf` exists precisely so that rule has one home.

- [ ] **Step 1: Fetch suggestions alongside the window**

One `getSuggestions({ site, state: 'all' })` per site, indexed once with `indexByTask`. `state: 'all'` matters: a pending-only fetch cannot support the silence states in Task 4.

- [ ] **Step 2: Render the newest mention on the row**

Date, speaker, the quoted line, and the suggested change. Accept/reject in place, calling the existing `confirmSuggestion` / `rejectSuggestion`.

- [ ] **Step 3: Hide the controls for non-managers**

Reading is open to everyone (#208); deciding is manager-only and the backend enforces it. Rendering buttons that 403 is worse than not rendering them.

- [ ] **Step 4: Verify in a browser**

This page is the one with a measured render budget. Confirm the row height is unchanged (`ROW_H = 36` must still match the CSS) and that scrolling a large programme is unaffected — the spacer arithmetic drifts by tens of thousands of pixels if a row grows.

- [ ] **Step 5: Commit**

---

## Task 3: The link on the report topic

**Files:**
- Modify: `scripts/pages/timeline.js`
- Modify: `app-shell-preview.html` (cache-buster only)

**Interfaces:**
- Consumes: `programmeMentions.{indexByTopic, mentionsForTopic}`

**Depends on Task 1.**

- [ ] **Step 1: Fetch and index suggestions for the report's site**

- [ ] **Step 2: Render "→ linked to programme: <task> (<zone>)" on the topic**

Use `mentionsForTopic(topic, byTopic)` — never `byTopic[topic.topic_id]`. The report side's `topic_id` is per-report sequential; the durable key is `topic_row_id`. This is the single most likely way to build this task and have it silently show nothing.

- [ ] **Step 3: Deep-link into the Gantt**

- [ ] **Step 4: Verify in a browser, in both mock and live modes**

Mock mode is what Task 1 unblocks; live mode is what actually matters.

- [ ] **Step 5: Commit**

---

## Task 4: What nobody is talking about

**Files:**
- Modify: `scripts/pages/programme.js`

**Interfaces:**
- Consumes: `programmeMentions.silentTasks`

The least obvious placement and the most useful: a task with no site mention for three weeks currently looks exactly like one going fine.

- [ ] **Step 1: Pass the real coverage**

`silentTasks(tasks, byTask, { today, coverage })` where `coverage` describes what was actually fetched. If the page fetched `state: 'all'` with no date bound, that is `{ states: 'all', from: null, to: null }`. Passing a coverage the fetch does not match is the one way to make this feature lie.

- [ ] **Step 2: Render the list, oldest first**

- [ ] **Step 3: Render nothing at all when the status is `unknown`**

An empty panel is correct when the data cannot support the claim. Do not fall back to "no silent tasks", which reads as good news.

- [ ] **Step 4: Verify in a browser**

- [ ] **Step 5: Commit**

---

## Task 5: Zone split UI

**Files:**
- Modify: `scripts/pages/programme.js`
- Create: `scripts/composites/zone-split-dialog.js`
- Modify: `app-shell-preview.html`

**Interfaces:**
- Consumes: `window.FS.api.programmeZoneSplit.{planZoneSplit, overrunDays}`, `programme.createTask`
- Produces: N `origin='local'` children under the imported parent

- [ ] **Step 1: Dialog — zone names, a person per zone, parallel/sequential**

Parallel is preselected. The sequential option needs a one-line explanation of what it does to the dates, because it is the one that invents a sequence.

- [ ] **Step 2: Show the plan before writing anything**

`planZoneSplit` returns `{ ok, errors, children }`. Render `errors` verbatim — they are written for the person who typed the input. Render the children as a preview.

- [ ] **Step 3: Never write when `ok` is false**

Check `ok`, not `children.length`. A failed plan returns no children, so a caller checking the array happens to be safe today — but that is an accident, not a contract.

- [ ] **Step 4: Surface the overrun**

`overrunDays(task, children) > 0` means the internal plan runs past the contract end. Say so; do not adjust anything. That divergence is the point (Project 1 §5).

- [ ] **Step 5: Write the children, then the assignees**

- [ ] **Step 6: Verify in a browser**

- [ ] **Step 7: Commit**

---

## Task 6: Rollup on child change

**Files:**
- Modify: `scripts/pages/programme.js` (or wherever a task PATCH is issued)

**Interfaces:**
- Consumes: `programmeRollup.{groupByParent, rollupProgress, applyRollup}`

- [ ] **Step 1: After a successful child PATCH, roll up its parent**

```js
const kids = groupByParent(tasks)[parentKey] || [];
const patch = applyRollup(parent, rollupProgress(parent, kids));
if (patch) {
  // ui#152's signature: (orgSiteId, taskId, patch), and the patch body
  // carries row_version. NOT main's updateTask, which is a different
  // function with the same name — see Global Constraints.
  await window.FS.api.programme.updateTask(
    orgSiteId, parent.id,
    Object.assign({}, patch, { row_version: parent.row_version }));
}
```

- [ ] **Step 2: Do nothing when `applyRollup` returns null**

Null is the common answer — a partial breakdown, or a rollup that would lower recorded progress. Treating it as `0` would be the exact bug the module exists to prevent.

- [ ] **Step 3: Handle the optimistic-lock 409**

The parent may have moved. Refetch and retry once; do not loop.

- [ ] **Step 4: Verify in a browser** — tick a subtask, watch the parent move, reload and confirm it persisted.

- [ ] **Step 5: Commit**

---

## Task 7: AI breakdown — BLOCKED

**Blocked on:** a real client programme (also blocking Project 2 §5).

Do not start this without one. The spec is explicit: a prompt tuned against invented programmes reads plausibly and is wrong in ways only a builder notices. The deterministic half (validating a proposal, converting it to local children, refusing to store inferred dependencies) is cheap to write once the prompt exists and pointless before.

When unblocked, three pieces in this order:

- **7a — the generator.** One non-VPC Lambda (in-VPC has no egress; the matcher's constraint), strict JSON out, 3–6 coarse steps, durations summing to the parent span.
- **7b — the review gate (spec §3.5).** Scope a range → generate → a person reads it → commit. Batch, not per task, which is the only way it is worth anyone's time across thirty tasks. **This extends the matcher's existing suggestion queue rather than becoming a second one** (Global Constraints). The one behavioural difference to preserve: a rejected suggestion changes nothing, while a rejected breakdown must leave no trace — which "nothing is written until accepted" already gives, provided nothing is indexed either (§5.5).
- **7c — re-plan on re-import.** Wire `programme_rebase.rebase_children` to the 20% parent-duration invalidation flag it was written and tested for, and has never been called from. A re-import that moves a broken-down parent must offer a re-plan, never silently re-plan.

The deterministic half of 7a — validating a proposal and converting it to local children, refusing to store any inferred dependency — is cheap to write once the prompt exists and pointless before it, because the shape of what needs validating is the shape of what the model returns.

---

## Task 8: Ask reaches the programme — DESIGN FIRST

**Open question (spec §7.6):** how a programme-shaped question gets routed. A bad router fails in both directions — sending "why is the slab late" to a table query, or "what do I do this week" to vector recall.

Write the examples before the code. Twenty real questions, hand-labelled, is the deliverable that makes this task startable; the query itself is easy and the endpoint already exists (`GET /programme/tasks?window=…&assignee=me`).

Task rows do **not** go into `report_chunks` (§5.5). Only the breakdown rationale is indexed, which means this task also cannot fully land before Task 7.

---

## Order

1, then 2–4 in any order (2 and 4 share a fetch, so doing them together saves
a round trip). 5 and 6 wait for ui#152. 7 and 8 are blocked as noted.

Nothing here can ship to users before `fieldsight-pipeline#209` releases
Project 1 to prod.

## BLOCKING ISSUE — Save converts local rows to imported

Found 2026-08-03 while checking whether a zone split survives a reload. It
does survive; what it does not survive is the next import, and the trigger is
the most ordinary action in the UI.

**The chain**

1. A PM splits a contract task into zones. The children are `origin='local'`
   in page state (Project 1 §5: they hang under the untouched imported row).
2. The PM presses **Save** — `doSaveProgramme` PUTs the whole
   `{parents, leaves}` document.
3. `put_programme` calls `programme_tasks.replace_all_tasks`, which
   `DELETE`s every row under the programme and re-inserts them all with
   `origin='imported'`.
4. The zone children survive as rows but are no longer local.
5. The next import's reconciliation sees them as file rows that are absent
   from the file, and soft-deletes them as departed.

The allocation is gone, and nothing warned anyone.

**Why it is nobody's bug and everybody's problem**

Both sides documented an assumption and neither enforced it:

- `put_programme`: *"Everything under the programme is discarded, including
  local rows. That is what replace means; the client confirms before calling
  it."* There is no server-side gate.
- `doSaveProgramme`: a plain Save button. No confirmation, and it does not
  distinguish local rows from imported ones.

Replace semantics are correct for a *replace*. The defect is that the only
save the UI offers **is** a replace.

**This blocks Tasks 5–7 in practice.** Zone splits and AI breakdowns both
produce local rows, so both are destroyed by the same path.

**Three fixes, needing a decision rather than a guess**

1. *Save becomes update-mode* — reconcile rather than replace, preserving
   local subtrees. Correct, and the largest change; update-mode
   reconciliation already exists for imports (`programme_reconcile`).
2. *Save refuses when local rows are present*, directing the user to import
   Update mode. Smallest, and honest, but leaves the PM with no way to save
   an ordinary edit once a split exists.
3. *Save confirms*, naming how many local rows it will convert. Cheapest;
   relies on people reading dialogs, which is what got us here.

My recommendation is 1, with 3 as an interim if 1 cannot land soon. Not
implemented: which of these is right is a product decision about what Save
means, and guessing it would risk the allocation data this project exists to
create.

---

## What is NOT in this plan

- **A backfill from S3 `programme.json` into `programme_tasks`.** Verified
  unnecessary on 2026-08-03: prod has no programmes at all
  (`aws s3 ls s3://fieldsight-data-509194952652/programmes/` is empty). If a
  programme is imported to prod before #209 merges, that changes, and #209
  must not be merged without one.
- **A stored `doc_id` column.** The suggestion→task join key is derived in
  three places now (Python, SQL, JS). It works and is tested in all three;
  collapsing it into one stored column is a cleanup, not a prerequisite.
- **Automatic status inference from daily-report action items.** Deferred in
  Project 1's plan for the same reason it stays deferred here: the programme
  UX has not been field-tested.
