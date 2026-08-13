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
`404` if the batch does not exist or the caller cannot see it.

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

### 2.1 A session with `session_id: null` cannot be deleted — do not offer the control

`session_ref` returns three states, and the UI is already required to tell them apart:

| backend state | `session_id` | what it means |
|---|---|---|
| extraction | the session base | a real recording — **deletable** |
| report | `null` | a day-level rollup, no session granularity exists in the data (the UI renders it as "Whole day") — **not deletable** |
| unknown | `null` | unrecognised key — **not deletable** |

The endpoint requires `sessionBase` and returns a per-item error without it. That guard
exists because an omitted `sessionBase` used to degrade the tombstone prefix to the whole
day, hiding recordings the customer never selected while reporting success. **Do not send
a recording without one**, and do not render a checkbox on a row that has no `session_id` —
show the row disabled with a short reason instead of letting the user select something the
server will refuse.

---

## 3. Authorization — partial success is the normal case, not an error case

The caller may delete a recording only if it is in **their own folder**, or they are
**admin / gm / platform_admin**. A `pm` who can legitimately *view* a worker's day is
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

## 6. Mock mode

`window.FS.api.useMocks` must **refuse** both calls rather than fake a `batch_id`. A write
stub that returns success makes an unverifiable feature look finished; the read stubs in
`org.js` return real-shaped data precisely because they are reads and this one is not.

---

## 7. After it is built — verify on six surfaces, not one

Every one of these is a separate backend code path. Covering five is how a leak ships, and
two of them (search and Ask) were genuinely returning deleted content until an adversarial
review caught it.

1. Evidence list and the topic detail
2. **Search** — search a phrase you know is in that recording
3. **Ask / RAG** — ask a question only that recording answers
4. The **daily report** page for that day
5. **Media playback**, and a presigned URL you had open before the delete → must `404`, not `403`
6. The **nightly report email** for that day

Then prove nothing was destroyed:

```bash
aws s3 ls s3://fieldsight-data-509194952652/audio_segments/<Folder>/<date>/ | grep <base>
```

Then undelete and re-check the same six — what comes back must be exactly what went away.

## 8. Environments

| | org gateway base | unauthenticated response |
|---|---|---|
| test | `https://wdsgobb7b0.execute-api.ap-southeast-2.amazonaws.com/test/api/org` | `403 {"message":"Forbidden"}` |
| prod | `https://ys94qy2tk0.execute-api.ap-southeast-2.amazonaws.com/prod/api/org` | `401` |

The two differ only in the authorizer's rejection style — both route through
`/api/org/{proxy+}`, so no gateway change was needed for the new paths and none is needed
for yours. Test the flow on **test** first; the flag is on there.

## 9. If the endpoints ever answer `403` with `ENABLE_USER_DELETION` in the body

The feature flag is off in that environment. That is an ops action
(`gh variable set {TEST,PROD}_ENABLE_USER_DELETION --body "true"` then deploy), not a bug in
the UI. Surface the message rather than a generic failure.

Note for whoever reads this later: turning that flag **off does not un-hide anything**, by
design — that would republish content a customer was told was gone. Rollback is undelete.
