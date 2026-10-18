# The button nobody built

**Date:** 2026-08-31
**Status:** design, awaiting review
**Scope:** frontend only. The backend is complete, deployed, and switched on in TEST.

---

## 1. The finding this exists to fix

`speaker_turn_names` in TEST:

```
correction_propagation   107
label_inheritance         75
correction                33
voiceprint_match           0
```

prod: the table is empty.

**Cross-meeting speaker recognition has never happened once, on either stack.**
Not because it is inaccurate, not because a threshold is too tight, and not
because the re-bind is broken — an earlier reading of this said all three and
each was wrong.

It has never happened because **nothing asks for it.**

```
POST /api/org/sessions/{session}/speaker-match     lambda_org_api.py:631    exists
  → voiceprint_requests/{company}/{session}/match-{id}.json                 exists
speaker-embed  _from_match_artifact                                         exists
  → invoke writer  op=match_names                                           exists
voiceprint_writer  _match_names → source='voiceprint_match'                 exists
  → speaker_turn_names                                                      0 rows
```

`grep -rin "speaker-match" scripts/` returns nothing. No automatic pipeline
writes that artifact either — `lambda_item_writer` writes only `rebind.json`.

A complete feature, deployed, with no entry point.

## 2. Why a button and not a schedule

The endpoint's own docstring settles it, and it was written before this design:

> Doing it on demand is what makes it usable on the sessions that ALREADY
> exist: automatic naming at finalize only ever helps future meetings, and the
> reason to want this at all is the archive.

Three more reasons, in the order they matter here:

**The archive is the point.** Automatic-at-finalize does nothing for the 148
sessions already recorded. The person who wants this wants it for the meeting
they are looking at.

**Running voiceprint comparison over every recording by default is a different
product.** It turns biometric matching from something a person asked for into
something that happens to everyone. That is a decision with a legal shape, and
it is not one a frontend should make by choosing a trigger.

**A refusal has to be legible.** `SPEAKER_IDENTITY_MODE=shadow` computes,
logs, and writes nothing; `on` writes names. The endpoint answers 202 either
way and returns `willWriteNames` precisely so those two are distinguishable.
A background job discards that distinction; a button can show it.

## 3. Where it goes

`/timeline`, on the session header — beside the existing transcript controls,
not inside the per-turn chip menu. The unit of this action is **the session**,
and the chip is already spoken for by naming one turn.

It is offered only when all of:

- `sn.featureAvailable(res)` — the transcripts payload carries the
  `unmatchedNames` key, which is this repo's established feature-detect and is
  absent when `SPEAKER_IDENTITY_MODE=off`. **prod is `off`, so nothing renders
  there** until that changes.
- `sn.roleMayName(role)` — the endpoint requires admin / gm / pm /
  site_manager / platform_admin. Offering a control whose only outcome is 403
  is worse than not offering it.
- the session has a `sid` — `sn.sessionRefForSegment` already refuses legacy
  RealPTT filenames, and the endpoint 400s without one.

## 4. What it says

Three states, and the middle one is the reason for the design.

| | copy | when |
|---|---|---|
| idle | **Identify speakers** | ready |
| queued | Matching against N stored voices… | 202 received |
| shadow | **Ran, and wrote nothing** — this environment is in shadow mode | `willWriteNames: false` |
| nothing found | No stored voice matched this meeting | polled, no new names |
| done | N turns named | new `voiceprint_match` rows appeared |

**"Ran and deliberately wrote nothing" and "ran and found nobody" must not
share a message.** The backend went out of its way to make them
distinguishable and returning `willWriteNames`; collapsing them here throws
that away and turns a configuration state into an apparent failure of the
matcher.

A queued state that never resolves is the fourth case, and it is the one this
repo has shipped before: after the poll budget is spent the control says
**Still working — reload to check**, never silence.

## 5. Polling, and the number that decides it

The response is `202` with `requestIds`, `turnsQueued`, `runs`. There is no
status endpoint for a match request.

So the poll is the transcripts refetch already wired for corrections
(`transcript-list.js`, backoff `[4000, 3000, 4000, 6000, 10000, 15000, 20000]`
— measured, 4.4–10.7 s for the embedder on a correction). A match is heavier
than a correction: it embeds every turn in the session, and `_split_for_budget`
may divide it into several runs.

**That backoff is therefore an assumption here, not a measurement.** The first
implementation task after the button works is to time a real match on TEST and
report the figure. If it is a minute, the polling shape is wrong and the answer
is a "come back later" notice rather than a longer backoff.

## 6. What this must not do

- **Not auto-fire on page load.** Same reason as §2: a page visit is not a
  request for biometric matching.
- **Not confirm names it did not confirm.** Matched names arrive as
  `voiceprint_match` with a state of `confirmed` or `tentative`; a `tentative`
  one renders through the existing tentative treatment (`?` + tooltip). This
  is the same rule the positional-guess fix just established, and it applies
  more strongly here because a matched name looks more authoritative.
- **Not offer itself on prod while `SPEAKER_IDENTITY_MODE=off`.** The feature
  detect handles this, and there is a test for it rather than a comment.

## 7. Verification

- **The DOM at every mount**, not the diff. `/timeline` renders three
  `AskChat`s and the transcript panel is reached through a tab — a control
  wired to the wrong one of several is a defect this repo has shipped.
- **Feature-detect off → no control.** Assert the absence, then remove the
  guard and confirm the test fails. A guard that passes because its input never
  arrived is not a guard.
- **All four states render**, including shadow. The shadow case needs a
  fixture, because TEST is `on` and will not produce it naturally.
- **A worker role sees nothing.** `roleMayName` excludes them; assert it here
  rather than trusting the shared helper, because the helper's other caller
  has a second arm (own-recording) that this endpoint does not honour.

## 8. Open — and one of them is the user's

1. **Should prod's `SPEAKER_IDENTITY_MODE` be turned on at all?** Not a
   frontend decision. The button is inert on prod until it is, which is the
   right default and also means shipping this changes nothing for customers.
2. **How long does a real match take?** §5. Measure before trusting the poll.
3. **What happens to a matched name the person disputes?**
   `DELETE /sessions/{s}/speaker-names?name=…` exists for exactly this and is
   already wired in `org.js:732`. Whether the button's result surface should
   offer it inline is a second design, not this one.
