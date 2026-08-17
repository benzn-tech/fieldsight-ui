# Speaker naming in the transcript viewer

**Status:** spec, ready to implement. The backend half is built, deployed to TEST, and
verified end-to-end with real corrections. There is no UI for it.

**Date:** 2026-08-14
**Backend counterpart:** `fieldsight-pipeline`, PRs #487–#496

> This spec was adversarially reviewed against both repos on 2026-08-14. The review found
> two claims that would have made **every write return 400**, and several that would have
> sent an implementer looking for bugs that were not there. Sections marked **⚠** are the
> corrected versions. Trust the line citations here over your memory of how this works.

---

## What the user asked for

> A sentence is currently attributed to `spk_1`. I change it to "Ben L". Every passage by
> that person in this meeting becomes "Ben L" — and future meetings recognise him too.

The first half works on TEST. The second half is **not built** (see *Out of scope*).

---

## What already works, so you do not build it

The backend clusters the meeting by voiceprint, finds which cluster the corrected passage
belongs to, and names the other turns in that cluster — not just the one that was clicked.
Verified on TEST: one correction on a 92-segment session produced 4 named turns, exactly 1
`confirmed`, `unmatchedNames: 0`.

Names are **not baked into the transcript**. They are laid over the response at read time
(`lambda_org_api.py:6216`), so a removal takes effect immediately and re-running extraction
does not resurrect anything.

**⚠ Propagation returning only the one turn you clicked is a normal outcome, not a
failure.** `lambda_speaker_embed.py:273-373` returns nothing to propagate — still 202, still
one `confirmed` turn — in four ordinary cases:

- the session has fewer than 2 turns of ≥ 3.0 s (`voiceprint_utils.DEFAULT_MIN_TURN_S`);
- **the turn the user clicked is itself under 3 s** — the backend's own comment says roughly
  a fifth of turns are;
- that voice spoke only once in the meeting;
- the margin to the next-nearest cluster is under 0.15 — "between voices", a deliberate
  refusal.

Do not present any of these as an error. **Prefer not to offer the naming control at all on
a turn whose `duration < 3`**, so the user is not invited to make a gesture the backend will
decline.

---

## The endpoints

### 1. Read — names arrive on the transcript you already fetch

`GET /api/org/transcripts?date=&user=&start=&end=`

**⚠ This route is NOT gated on the feature switch and NOT restricted to manager roles.** The
mode check lives inside the overlay helper and returns the payload unchanged when the
feature is off (`lambda_org_api.py:6216-6217`); the route authorises through
`_resolve_org_media_folder`, which admits workers for their own media. Only the two *write*
routes carry 404/403. Do not build a feature-detect that expects this call to fail.

Each entry of `speaker_segments` may carry:

```js
{
  speaker:         "spk_0",
  text:            "...",
  start:           29672.5,   // absolute seconds since midnight — DISPLAY ONLY
  end:             29684.1,   // absolute — DISPLAY ONLY
  duration:        11.6,      // in-file span  ← use this for writing back
  source_filename: "Benl1_2026-04-29_11-49-00_sid<32 hex>_c0000_srcwav.json",
  chunk_start:     41.203,    // offset WITHIN that file  ← use this for writing back
  speaker_name:    "Ben L",   // only when this turn has been named
  speaker_state:   "confirmed" | "tentative"
}
```

and the payload carries `unmatchedNames: <int>` at the top level (`:6237`).

`source_filename`, `chunk_start` and `duration` are **already returned today**
(`lambda_org_api.py:5877-5883`) but are **absent from `BACKEND-CONTEXT.md` §4.5**
(lines 130-143). Document them as part of this work — an undocumented field is one refactor
away from being deleted as dead weight.

**⚠ Feature detection:** the only observable signal is the **presence of the
`unmatchedNames` key**, which appears only when the mode is not `off` *and* there is at
least one speaker segment (`:6218-6237`). Use that to decide whether to show the naming
control at all.

### 2. Write — name a passage

```
POST /api/org/sessions/{sessionRef}/speaker-corrections
{
  "user":            "Jarley_Trainor",       // media folder, required
  "source_filename": segment.source_filename,
  "start_sec":       segment.chunk_start,
  "end_sec":         segment.chunk_start + segment.duration,   // ⚠ see below
  "display_name":    "Ben L",
  "consent_given":   false,
  "consented_by":    null
}
→ 202 { requestId, propagation: {...}, enrolment: {...} }
```

**⚠ `{sessionRef}` is not the session list's `session_id`.** Both write endpoints locate the
session by *searching the path segment* for tokens, and the POST needs **two** of them:

| endpoint | needs a date `YYYY-MM-DD` | needs `sid<32 hex>` |
|---|---|---|
| POST speaker-corrections | **yes** (`:1383`) | **yes** (`:1391`) |
| DELETE speaker-names | no | **yes** (`:1275`) |

The session list returns `session_id` = `sid<32 hex>` alone for a chunk session
(`lambda_extract_session.py:569`) — **no date**, so posting it returns 400 every time.
Legacy sessions return `{device}_{date}_{time}` — no sid, also 400.

Build the ref yourself:

```js
const sessionRef = date + '_' + session.session_id;   // "2026-04-29_sid<32 hex>"
```

Verified: that string satisfies both gates and normalises to the same canonical key the
backend stores under. `segment.source_filename` also works, and is the fallback when you
only have a segment in hand.

**⚠ `end_sec` must be `chunk_start + duration`, NOT `chunk_start + (end - start)`.**
`start`/`end` are absolute clock seconds resolved per batch member through the batch map
(`:5661-5676`), which re-inserts silence that batching removed. For a turn straddling a
batch seam, `end - start` is larger than the real in-file span by that whole gap, and the
backend then analyses the wrong audio window. **Nothing validates `end_sec`** — the request
returns 202 and writes a row either way. The backend's own producer of this pair uses
`chunk_start + duration` (`:1248-1249`); match it.

**202 means queued, not done.** Clustering runs outside the VPC, typically a few seconds.
Re-fetch the transcript to see the result; there is no push.

### 3. Write — take a name off this meeting

```
DELETE /api/org/sessions/{sessionRef}/speaker-names?name=Ben%20L
→ 200 { sessionBase, name, turnsUnnamed: 3 }
```

Scoped to **one meeting**, and it does not touch the stored voiceprint — a person who wants
their name off one transcript has not asked for their profile to be destroyed. `sessionBase`
in the response is the *normalised* sid, not the string you sent.

Both write routes require role `admin` / `gm` / `pm` / `site_manager` / `platform_admin`
(403 otherwise) and return **404** when `SPEAKER_IDENTITY_MODE=off` — which is PROD today.
404 there means "not enabled here", not "bug".

---

## ⚠ This only works on chunk-session recordings

The feature is keyed on `sid<32 hex>` in the filename. A legacy RealPTT-era transcript
(`Benl1_2026-04-29_08-14-32_off0.5_to612.0_srcwav.json`) has no sid,
`turn_name_overlay.session_base()` returns `None` for it, and both the overlay and the write
endpoints decline. **Pick a recent chunk-session recording to develop against**, or you will
spend the evening reading a correct refusal as a bug.

---

## What to build

**⚠ The insertion point is already occupied.** `scripts/composites/transcript-list.js:228`
renders `nameHint || s.speaker`, where `nameHint` comes from `participantHint`
(`:195-200`) — a positional guess built from `props.participants`. Two consequences:

- **Define the precedence explicitly: `speaker_name` wins over `participantHint`.** The
  first is something a person asserted; the second is guesswork. If the guess wins, a real
  correction is invisible.
- **The speaker chip is already a `<button>` wired to `props.onJump` (`:219-225`).** Naming
  must not steal that gesture. Put it behind a secondary affordance — a caret, a
  right-click/long-press menu, or a hover action — and leave click-to-jump alone.

**⚠ `unmatchedNames` is discarded before render.** The response is narrowed into state at
`:120-130` (only `speaker_segments`, `speakers`, `message`, three counts). Widen that object
first, or item 5 below has nothing to read.

1. **Show the name that is there.** When `speaker_name` is present, show it instead of
   `spk_N`. Keep the position-based colour keyed on `s.speaker` — the colour tracks the
   diarisation label, and naming someone must not reshuffle every colour in the view.

2. **`tentative` must never look like a fact.** It is the system's guess, not the user's
   assertion. Render it visibly unresolved — greyed, italic, with a marker — never in a form
   a reader would quote. This is the most important visual decision here: a wrong confident
   name is the failure the whole backend layer is shaped to avoid, and the UI is the last
   place it can still be introduced.

3. **Let the user set a name.** Secondary affordance on the speaker chip → small input,
   prefilled with the current name, offering names already used in this session. Submit →
   POST → optimistic label on that turn → re-fetch after ~2 s → replace with the server's
   answer. Suppress the affordance when `duration < 3`.

4. **Let the user remove a name.** Same menu, "Remove this name" → DELETE → re-fetch.
   Confirm first, and say what it does: *"Remove 'Ben L' from this meeting. Other meetings
   are not affected."*

5. **Surface `unmatchedNames > 0`.** One quiet line: *"N names no longer match any
   passage."* It means somebody set a name and it is no longer shown. Silence there reads as
   "nobody ever named this", which is a different and wrong statement.

---

## Consent — do not add a checkbox without reading this

`consent_given: true` is a **different act** from naming a passage:

- naming propagates within **this** meeting, using audio the company already holds;
- consent stores a **voiceprint**, so the person is recognisable in **future** meetings.

That is biometric data, and the consent required is from **the person whose voice it is** —
not the wearer, not the employer, and not whoever is at the keyboard. `consented_by` is
mandatory whenever `consent_given` is true (400 otherwise, `:1411-1413`), and it records
*whose voice this is*, not who clicked.

**Recommendation: ship phase 1 with no consent UI** — always send `consent_given: false`.
Naming within a meeting is what the user asked for and carries no storage obligation.
Enrolment deserves its own deliberate surface with real wording.

The 202 response reports `propagation` and `enrolment` **separately** for exactly this
reason. Do not collapse them into one "Saved".

---

## ⚠ Three environment facts, all three required

Verified on 2026-08-14 by reading the deployed Lambda config and the Amplify branch
variables, not from documentation.

| variable | `dev` today | needed |
|---|---|---|
| `FS_TIMELINE_SOURCE` | `aurora` ✓ | **must be `aurora`** — `transcripts.js:41` routes to org-api only then; otherwise line 44 hits the legacy gateway, whose segments carry none of these fields. Repo default is `report` (`scripts/api/index.js:99`). |
| `FS_ORG_BASEURL` | `wdsgobb7b0…` = TEST ✓ | TEST org-api runs `SPEAKER_IDENTITY_MODE=shadow`. |
| `FS_ORGWRITES` | **`false`** ✗ | `org.js:21` makes `orgWrite()` return false, so **every org write is a silent no-op**. Set `true` and re-release `dev`. |

Failure mode if `FS_TIMELINE_SOURCE` is wrong: everything looks wired, names never appear,
nothing errors.

---

## Out of scope

- Voiceprint enrolment UI and the admin list of stored profiles.
- Withdrawing a profile (`DELETE /api/org/voiceprints/{id}`) — an admin surface, not this one.
- **Automatic naming of new meetings from stored voiceprints.** That is backend Phase 5 and
  it is **not built** — `lambda_speaker_embed.py:488`'s `match` op has no caller anywhere.
  Do not imply it in copy.
- Backfilling names onto already-processed sessions.

---

## Acceptance

On `dev`, against TEST, with `FS_ORGWRITES=true`, using a **chunk-session** recording:

1. Open a transcript with several speakers. Labels read `spk_0`, `spk_1`, …
2. Name a passage of **≥ 3 s**. Within a few seconds and one re-fetch, other passages by the
   same voice in the same meeting carry that name.
3. At most one reads as confirmed; the rest are visibly tentative.
4. Remove the name. All of them revert to `spk_N`.
5. A second meeting by the same person is unaffected, by both the naming and the removal.
6. Naming a passage under 3 s is not offered.
7. Against PROD (`FS_ORG_BASEURL` → prod), no `unmatchedNames` key arrives, the naming
   affordance is absent, and nothing errors in the console.

---

## Known backend defect, filed here so it is not rediscovered as a UI bug

For a **non-batched** segment whose filename carries `_off{T}` with `T > 0`, the embedder
reads the device's whole upload and then slices it at `chunk_start` **without adding the
segment's own offset** (`lambda_speaker_embed.py:110-115`, `:160-162`). The batched path
compensates; this one does not, so it would analyse the wrong audio — silently. It requires
a filename carrying **both** `sid` and `_off`, which whole-chunk transcription does not
currently produce. Raised with the backend owner on 2026-08-14; if a correction ever names
an obviously wrong set of turns, start here.

---

## Addendum, 2026-08-17 — two things shipped after this spec was written

Both change what the viewer must render. Neither changes an endpoint.

### 1. Short turns get named now, and they are the ones you were told not to offer the control on

The section above says to prefer not offering the naming control on a turn whose
`duration < 3`, because the backend will decline to propagate from it. **That advice stands
for the control.** What changed is what happens to those turns afterwards.

A tier called *label inheritance* now runs after propagation. It groups the session's turns
by the transcriber's own speaker label, and for any group that already holds a name from a
stronger source, it names the group's remaining turns — including the ones under three
seconds, which propagation cannot reach because they are too short to embed. On the live
example that produced the change (`Ivy`), one correction named 2 turns directly, propagated
to 6, and inherited to **22**.

For the viewer:

- **A turn with `duration < 3` may carry `speaker_name`.** Render it. Offering no control
  there and rendering no name would drop three quarters of the effect of the user's gesture.
- Inherited names always arrive as **`speaker_state: "tentative"`**, never `confirmed`. The
  rule at §"tentative must never look like a fact" applies to them unchanged, and it is
  doing most of its work here: a transcriber label is a weaker claim than a voice match.
- The transcript payload still exposes only `speaker_name` and `speaker_state`. There is no
  `source` field on a turn and you do not need one — `state` is the whole confidence signal.

### 2. A profile can exist, be named, and hold nothing — and now says why

`GET /api/org/voiceprints` (manager roles; 404 when the feature switch is `off`) returns per
profile:

```
{ id, displayName, status, userId, linkedOn, consentAt,
  samples, humanSamples,
  lastAttemptAt, lastAttemptOutcome, lastAttemptDetail }
```

`samples: 0` is the state that matters: **a named profile with zero samples names nobody in
any future meeting.** Until tonight that was indistinguishable from a profile whose enrolment
crashed, which is why the last-attempt fields exist —
`lastAttemptOutcome: "refused"` with `lastAttemptDetail: "this window does not hold one
voice"` is a complete explanation, written for a person.

**This is currently the normal outcome, not an edge case.** The enrolment guard is calibrated
on read speech and refuses essentially every window of real site audio; that is an open
backend problem
(`docs/superpowers/specs/2026-08-17-homogeneity-threshold-measured.md`, pipeline repo).
So the honest thing for the UI to say after a correction is that the name was applied to this
meeting — which is true and verifiable in the transcript — and **not** that the person will be
recognised next time, which is currently false. If you show a profile surface at all, show
`samples` and the refusal reason rather than a green tick.

`humanSamples` counts only what a person vouched for, as against what the clustering
suggested; a profile made only of inference is meant to stay tentative, so the two numbers are
not interchangeable.
