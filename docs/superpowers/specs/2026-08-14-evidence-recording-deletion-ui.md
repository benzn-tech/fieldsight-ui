# Spec — customer deletes recordings from Evidence

**Status:** backend is LIVE on test and prod; UI does not exist.
**Author:** backend session, 2026-08-14. Written for a frontend session to implement.
**Backend runbook:** `fieldsight-pipeline/docs/runbooks/user-deletion-prod.md`

---

## 0. What the customer asked for

> 他们能在 evidence 里面 batch 选择把 evidence 删掉，一旦删掉，这个人相关的所有内容都从页面移除…
> 但是不能真的把 S3 删了，我要留着继续做分析，客人和其他层级不再能看到相关内容。

So: **multi-select in Evidence → delete → it disappears everywhere, for everyone.** Nothing
is actually destroyed; the raw data stays for analysis and the delete is reversible.

## 1. Backend state — this is already done and switched on

Both endpoints are deployed and `ENABLE_USER_DELETION` is `true` on **test and prod**
(verified by reading the live Lambda environment, not the deploy record). The read-side
filtering is live everywhere: topics, actions, tasks, search, Ask/RAG, media, presigned
URLs, the daily report page, and the nightly report email.

**The only missing piece is the UI.** Nothing in the app currently offers a way to delete.

### 1.1 Delete

```
POST {orgBaseUrl}/recordings/delete
{
  "recordings": [
    { "folder": "Ben_UCPK2", "date": "2026-08-14", "sessionBase": "sid9f8c1e2a…" }
  ],
  "reason": "optional free text, stored in the audit row"
}
```

Response `200`:

```json
{
  "batch_id": "e3c1…",
  "results": [
    { "recording": {…}, "topics_hidden": 7 },
    { "recording": {…}, "topics_hidden": 0, "error": "not permitted to delete this user's recordings" }
  ]
}
```

### 1.2 Undelete

```
POST {orgBaseUrl}/recordings/undelete
{ "batchId": "e3c1…" }
```

Response `200`: `{ "batch_id": "e3c1…", "restored": 8 }`

- `404` — the batch does not exist, or the caller's company cannot see it.
- `403 "not permitted to restore this batch"` — the batch exists but the caller does not hold
  §3 authority over every folder in it. **A worker cannot undo an admin's delete of a
  colleague's recordings, even inside their own company.** Handle it distinctly from 404;
  "not found" would be a lie and would send someone hunting for a missing batch id.

`restored` counts **redaction rows** — one per hidden topic, plus the recording tombstone,
plus the day's report-rollup rows. It is not a count of recordings. Do not render
"8 recordings restored"; either say nothing numeric or count the recordings you sent.

### 1.3 There is no read endpoint for deletions — plan around it

There is no `GET` that lists tombstones or batches. Two consequences the UI has to be
designed around, not discovered:

- **The list self-updates, so refetch rather than splicing.** Once a session's topics are
  hidden, `build_day_sessions` drops the whole session, so `getSessions` simply stops
  returning it. Refetch after a successful delete and the row disappears on its own.
  Removing rows locally will drift from the server the moment a delete is partially refused.
- **`batch_id` exists only in the delete response.** Nothing can look it up afterwards. If
  undo is to survive a page reload, persist it yourself (localStorage keyed by folder+date
  is enough). Otherwise say plainly in the UI that undo is available "for now" — because
  once that value is gone, recovery is a DB query by a human, per the backend runbook.
- A "Deleted items" / recycle-bin screen is **not buildable today**. It needs a new backend
  endpoint; ask for one rather than faking it.

---

## 2. The identifier — `sessionBase` is `session_id`, and you already have it

`sessionBase` is exactly the `session_id` field returned by

```
GET {orgBaseUrl}/sessions?date=YYYY-MM-DD&user={folder}
```

which `scripts/api/org.js:getSessions` already wraps. Backend-side both come from the same
parse of `topics.source_s3_key`, so no new lookup and no string surgery is needed — pass
`session.session_id` straight through.

**`folder`** is the user folder (`window.FS.api.folderName(user)`), the same value
`getSessions` takes as `user`.

### 2.1 Every `getSessions` row is deletable — the other states show up as ABSENCE

`session_ref` has three states, but `build_day_sessions` `continue`s past everything that
is not an extraction key, so **`GET /sessions` never returns a row with `session_id: null`**:

| backend state | what `GET /sessions` does |
|---|---|
| extraction | returns the row, `session_id` = the session base — **deletable** |
| report (a whole-day rollup, no session granularity exists) | **omits it** |
| unknown / unrecognised key | **omits it** |

So the consequence is not a row to disable, it is a day that looks empty. A day whose topics
are all report-sourced returns **zero sessions** while the customer can plainly see photos
and audio on the other tabs. Say why — "this day has no per-recording breakdown" — rather
than rendering an empty checklist, which reads as a bug.

(If you build the list from `/timeline` instead of `/sessions`, null-session rows *do* exist
there and must not get a checkbox. The endpoint requires `sessionBase`: an omitted one used
to widen the tombstone prefix to the whole day, hiding recordings the customer never
selected while reporting success. Never send a recording without one.)

---

## 3. Authorization — partial success is the normal case, not an error case

The caller may delete a recording only if it is in **their own folder**, or they are
**admin / gm / platform_admin** (the roles whose user scope is `ALL`). A `pm`,
`regional_manager` or `site_manager` who can legitimately *view* a worker's day is
**refused** — deleting is stronger than viewing.

Authorization is **per recording**. One refused entry does not fail the request: it comes
back `200` with `"error"` on that entry and the others go through.

**So the UI must render the `results` array, not just the status code.** A selection of six
where two were refused is a real outcome that must be shown as such. Treating `200` as
"all deleted" would tell someone their colleague's recordings are gone when they are not.

---

## 4. Semantics the UI copy has to get right

These are the ones where the obvious wording is wrong.

**"Deleted" is honest; "permanently deleted" is not.** No S3 object is removed and no
database row is dropped. The content stops being visible at every tier. Say something like
*"Removed from FieldSight"* or *"Deleted"*, and offer undo — do not promise destruction the
system deliberately does not perform. Equally, do not undersell it as "hidden": to the
customer and to everyone else in the org it is gone.

**Undo is a real, first-class action, not a support ticket.** Keep the returned `batch_id`
and offer *"Undo"* for the session (a toast/snackbar with the batch id behind it is enough).
One undelete restores exactly what one delete hid — no more, no less.

**Deletion is not instant on every surface.** The database-backed surfaces (Evidence,
search, Ask, timeline, media) filter immediately. The nightly report generator and the
report email have no database and read an S3 mirror written straight after the delete
commits — so a report *email already sent* still contains the content. Do not claim
"removed everywhere instantly"; "removed from FieldSight" is accurate, and already-delivered
email is worth one line in the confirm dialog.

**A repeat delete returns `topics_hidden: 0`, and that is success.** The write is idempotent
(`ON CONFLICT DO NOTHING`). If a user retries after a network error, zero means "already
hidden", not "failed". Do not render zero as an error on a recording the user just deleted.

**A first-time delete returning `topics_hidden: 0` is worth surfacing though.** It means the
recording produced no topics — possible, but also what a wrong identifier looks like.

**A media link issued BEFORE the delete keeps working for up to 15 minutes.** Presigned URLs
are signed S3 links; the object is deliberately not deleted, so an already-handed-out URL
plays until it expires (`PRESIGNED_URL_EXPIRY = 900`). What the delete stops is *issuing new
ones*: the presign endpoint answers `404` for a deleted session's key. If anyone is likely to
be watching a clip at the moment it is deleted, one line in the confirm dialog is honest.

**`reason` is stored but not readable back.** It lands in the audit row and no endpoint
returns it. Collect it if you want the audit trail; do not build UI that expects to display
it later.

**There is no server-side cap on `recordings[]`,** which means the real limit is the API
Gateway 29-second timeout. Each recording costs a topic query plus inserts. Chunk a large
selection into requests of ~20, or cap the selection — a batch UI that lets someone select
200 days of recordings will time out and report failure for work the server actually did.

---

## 5. Suggested shape — decide freely, these are the constraints not the design

The unit of deletion is a **recording (session)**, not a photo or an audio file. Evidence's
current tabs (Photos / Audio / Video / Transcripts) are per-file, so there is no existing
row that maps 1:1 to what gets deleted.

The straightforward option is a **"Recordings" tab** on Evidence: per-day sections listing
that day's sessions from `getSessions`, each with a checkbox, a select-all per day, and a
"Delete selected (n)" action in the toolbar. That keeps "batch 选择" literal and puts the
control on the page the customer named.

A confirm dialog before the call, stating: how many recordings, whose, that everything
derived from them stops being visible to everyone, that nothing is destroyed and it can be
undone, and that already-sent emails are unaffected.

If you would rather hang selection off the Audio tab or a dedicated page, that is your call —
the constraints in §2–§4 are what actually matter.

One more thing the shape has to account for: **the other tabs self-clean, but only on
refetch.** Photos / Audio / Video / Transcripts all filter deleted sessions server-side, so
they come back correct — but each composite fetches lazily and independently, so a tab the
user already had open still shows the old list. Either refetch the sibling tabs after a
delete or make them refetch on activation.

## 6. Mock mode

`window.FS.api.useMocks` must **refuse** both calls rather than fake a `batch_id`. A write
stub that returns success makes an unverifiable feature look finished.

Follow the **threads** pattern in `org.js` — `return { status: 'unavailable', _notAvailable:
true }` — not the `createOrgSite` / `updateOrgSite` / `updateProfile` pattern, which
synthesises a plausible object off the gate. (An earlier draft of this spec claimed org.js
refuses on every write; it does not. Only the threads family does, and it is the right one
to copy here.)

---

## 7. After it is built — verify on six surfaces, not one

Every one of these is a separate backend code path. Covering five is how a leak ships, and
two of them (search and Ask) were genuinely returning deleted content until an adversarial
review caught it.

1. Evidence list and the topic detail
2. **Search** — search a phrase you know is in that recording
3. **Ask / RAG** — ask a question only that recording answers
4. The **daily report** page for that day
5. **Media playback** — ask for a *new* presigned URL for the deleted session's key: the
   endpoint must answer `404`, not `403` (a 403 would confirm the object exists). A URL
   issued *before* the delete is a signed S3 link and keeps working for up to 15 minutes —
   that is expected, not a leak, so do not use an already-open tab as the test.
6. The **nightly report email** for that day

Then prove nothing was destroyed:

```bash
aws s3 ls s3://fieldsight-data-509194952652/audio_segments/<Folder>/<date>/ | grep <base>
```

Then undelete and re-check the same six — what comes back must be exactly what went away.

## 8. Environments

| | `orgBaseUrl` (what `env.js` holds) |
|---|---|
| test | `https://wdsgobb7b0.execute-api.ap-southeast-2.amazonaws.com/prod/api` |
| prod | `https://ys94qy2tk0.execute-api.ap-southeast-2.amazonaws.com/prod/api` |

**The stage is named `prod` on BOTH gateways** — the test gateway has no `/test/` stage.
`orgRequest` prefixes `/org` itself, so `orgBaseUrl` stops at `/api`. Both reject an
unauthenticated call with `401 {"message":"Unauthorized"}`.

(An earlier draft of this spec gave the test base as `…/test/api/org` and reported a `403`
there as "test's authorizer rejection style". That 403 was API Gateway saying the *stage*
does not exist. It fooled me because I checked it against `/me` on the same wrong stage —
a control that shared the defect. A frontend session pointed at `/test/` would get 403 on
everything and could spend hours "fixing" auth headers.)

Both new paths route through the existing `/api/org/{proxy+}` resource, so no gateway change
was needed and none is needed for yours.

### 8.1 Two env gates that will make this look dead on `dev`

Check these on the branch you are testing, or the feature will appear broken for reasons
that have nothing to do with your code:

- **`timelineSource` must be `'aurora'`** — `getSessions` only calls the real backend when
  `api.timelineSource === 'aurora' && api.orgBaseUrl`. The default in `env.example.js` is
  `'report'`, which silently serves fixtures. You would be deleting mock sessions.
- **`orgWrites` must be `true`** if you route the new calls through the repo's `orgWrite()`
  convention — it defaults to `false`, which turns writes into no-ops.

Test the flow on **test** first; `ENABLE_USER_DELETION` is on there.

## 9. If the endpoints ever answer `403` with `ENABLE_USER_DELETION` in the body

The feature flag is off in that environment. That is an ops action
(`gh variable set {TEST,PROD}_ENABLE_USER_DELETION --body "true"` then deploy), not a bug in
the UI. Surface the message rather than a generic failure.

Note for whoever reads this later: turning that flag **off does not un-hide anything**, by
design — that would republish content a customer was told was gone. Rollback is undelete.
