# The days the calendar cannot see

**Date:** 2026-09-08
**Status:** design, SECOND draft. Review found three blocking defects; all
three are recorded in §10 with what changed, because two of them make the
first draft's change a **no-op** and the third makes it a trap.
**Scope:** frontend only. Every field this needs has been on the wire since
pipeline #762/#775; the backend endpoint that serves it documents its own
reason for existing and is waiting for a client to ask.

---

## 1. What this is

`hasReport` is read as "does this day exist". It does not mean that. It means
"extraction produced topics for this day", and it is the only thing the
calendar, the date span, Evidence's day list and Timeline's landing date will
look at.

The user said it in one sentence: *"我们的内容不能被 report 表达时间限制了，时效性太差。"*

The endpoint already agrees. `get_org_dates` (`lambda_org_api.py:4528`) takes
`?uploads=1` and returns `hasUploads` / `sessions` / `photos` per day, and its
comment names the day this was found on:

> *On 2026-09-02 the LLM provider's account went into arrears and a day holding
> 53 photos and 5 recordings became indistinguishable from a day nobody
> switched the device on. There was no dot to click, so no later screen could
> be reached — which is why this endpoint, not the day view, is the first thing
> that has to know.*

**`hasUploads` is read in zero places in `scripts/`, and `uploads=1` is never
sent.** The whole feature is dark.

## 2. Measured, on prod Aurora

| | |
|---|---|
| distinct capture days in `recordings` | **42** |
| of those, with **no** row in `topics` | **18 (43 %)** |
| photos on those days | **166** |
| audio/video sessions on those days | **83** |

**What this number is, precisely.** It is the *company-wide, tombstone-blind*
count of `recordings` key-dates with no `topics` row anywhere, folding sessions
by `sid` the way `upload_date_counts` does. It is **not** what any one caller's
`/dates?uploads=1` returns, and it differs in both directions: the endpoint
scopes by `_allowed_site_ids` and `_author_filter` and drops tombstoned
sessions (fewer), while a day whose topics were all deleted is "has topics"
here but `hasReport:false` there, because `report_date_counts` applies
`visible_topics_predicate` (more). Nothing below rests on the exact figure —
it establishes an order of magnitude and a set of days to hand-test.

The 18, newest first (folder · photos · sessions):

```
2026-09-07  Neil_Blunden        0   2      2026-07-27  James_Alcock      0   1
2026-09-06  Neil_Blunden        0   1      2026-07-24  Neil_Blunden      3   1
2026-08-29  Ben_UCPK            0   3      2026-07-21  Travis_Brown      1   4
2026-08-26  Ben_UCPK2           1   0      2026-07-19  Ben_UCPK          0   3
2026-08-25  Neil_Blunden       32   0      2026-07-19  Ben_UCPK2         1   1
2026-08-24  Neil_Blunden       20   0      2026-07-14  Ben_Lin           3   8
2026-08-21  Neil_Blunden       13   0      2026-07-14  Jarley_Trainor    0   4
2026-08-20  Neil_Blunden       56   0      2026-07-13  Jarley_Trainor    7  17
2026-08-06  Sam_Yu              0   1      2026-07-12  Jarley_Trainor    4   9
2026-08-05  Sam_Yu             17   0      2026-07-11  Jarley_Trainor    8  28
```

Two things this list settles:

**It is not one bad night.** The 2026-09-02 arrears incident is not in this
table at all — that day HAS topics. These 18 are spread over three months and
include a run of four consecutive Neil_Blunden photo days in August (121
photos, no recordings) and the **two most recent capture days in the system**
(09-06, 09-07). A customer opening the app today lands on a calendar whose
newest dot is two days older than their newest content.

**Photo-only days are the largest group.** Seven of the 18 have zero
recordings. There was never any audio to extract from, so no amount of
extraction reliability brings them back. `hasReport` will be false for these
days forever, by construction.

## 3. What already works, and what the review proved does not

`NoReportState` (`pages/timeline.js:813-845`) already reads the 404 envelope's
`uploads`, `transcripts`, `day_state` and `photo_filenames`, renders "56
photos, 2 recordings arrived on this day" and mounts a `PhotoGrid` from
`facts.photo_filenames`. `_day_upload_facts` (`lambda_org_api.py:6189`)
supplies all of it.

**But only the explicit single-user path reaches it** (`timeline.js:2142-2156`).
The two paths a site-anchored manager actually takes do not:

- **Site bootstrap** (`:1779-1786`) resolves a landing date, navigates with
  `site && !user`, sets `aggregated: true` (`:1815-1820`), and
  `AggregatedDayView` filters `_notFound` out at `:1154-1155` and renders
  `NoReportState` at `:1220-1223` **with no `facts` prop**. The uploads never
  reach the screen that knows how to draw them.
- **Self-defaulted** (`:1875`): `canFallBackToTeam && !hasReport && !hasMeeting`
  hands a PM/site_manager to that same aggregated view.

So the first draft's claim that "the day view already renders these days
correctly" was true of one path out of three. Drawing dots without fixing this
would put a clickable dot in front of *"No reports for this project on Mon 7
Sep"* — the same dead end the dot was added to remove, wearing a different
hat.

## 4. The ten reads, and which of them are the same question

### 4a. "Can the user get to this day?" — CHANGE these

| site | what it decides |
|---|---|
| `composites/date-picker.js:89` (`intensity`) + a new glyph | whether the calendar cell shows anything at all — see §5(3) |
| `composites/date-picker.js:135` | the aria-label, currently the literal string "no report" |
| `pages/timeline.js:559` (`findLatestReportDate`) | which day the app lands on when today is empty |
| `pages/evidence.js:205` | which days Evidence enumerates |
| `api/data-window.js:45` (`computeSpan`) | `earliest`/`latest` — the bounds of the 'All' preset |

`date-picker.js:110` is **not** in this list. It is the orange safety dot, and
`safety` is 0 on every upload-only day by construction, so flipping its
predicate changes nothing. Leave it.

### 4b. "Is there a report to fetch for this day?" — LEAVE these alone

| site | what it fans out |
|---|---|
| `api/compliance-aggregator.js:313` | `getTimeline` per day |
| `api/tasks-aggregator.js:169` | `getTimeline` per day |
| `api/user-activity-aggregator.js:125` | `getTimeline` per (day × user) |
| `api/actions.js:584` | `getActions` (audit), **not** `getTimeline` |
| `pages/today.js:1071` | builds (date, folder) pairs to fetch reports from |

The first three filter the map and fan out report requests; an upload-only day
returns `_notFound`, which each already skips, so widening them buys nothing
and costs up to 18 × folders extra requests on 'All'.

`actions.js` is the odd one and the first draft described it wrongly. It reads
`if (reportDays.length) dates = reportDays;` — a range containing **zero**
report days keeps the full day-by-day enumeration rather than narrowing. Under
`resolve('all')` the range always contains report days so behaviour is
unchanged, but the sentence "every one of them already skips `_notFound`" is
not what that function does, and §9's request-count test must therefore be
written over a range with at least one report day.

Each of these five gets a one-line comment saying the predicate is `hasReport`
on purpose, because the next person to grep will otherwise assume it was
missed.

### 4c. The one that has no filter and must gain one

`today.js:413` `_fallbackCandidates` takes `Object.keys(getDates({months:1}))`
with **no predicate at all** and probes the newest 5 with `org.getSessions`.

It works today only because the map it reads contains report days and nothing
else. Making `uploads=1` unconditional (§5(1)) changes that, and
`get_org_sessions` (`lambda_org_api.py:6668-6671`) builds its sessions from
`topics.list_topics_for_source_prefix` — so an upload-only day returns
`sessions: []`. The five probes would be spent first on 2026-09-07 and
2026-09-06, both upload-only, hiding the most recent day that actually has
sessions.

**It gains an explicit `hasReport` filter.** The first draft argued the
opposite — that upload-only days have sessions so the wider map helps — and
called the endpoint's own warning out of date. The endpoint was right; §10
records it.

## 5. The change

**(1) Ask for the wider index.** `api/dates.js` sends `uploads: 1` on the
aurora branch only. The legacy branch keeps its exact params — `get_dates`
(`lambda_fieldsight_api.py:558`) ignores unknown params, so sending it there
would be a silent no-op that reads like a feature.

**(2) One predicate, one place.** Export `FS.api.dates.hasContent(meta)`:

```js
function hasContent(meta) {
  return !!(meta && (meta.hasReport || meta.hasUploads));
}
```

`hasUploads` absent (legacy path, mock fixture, a backend predating #775) →
falls through to `hasReport` → **byte-identical old behaviour**. No flag, no
migration; the field's absence is the fallback.

**(3) The date-picker needs a new glyph, not a flipped predicate.**

This is the finding that makes the first draft a no-op.
`intensity()` (`date-picker.js:88-95`) returns 0 whenever `topics < 1`
*regardless of which predicate guards it*, the only dot is rendered under
`i > 0` (`:145-147`), and `styles/composites.css:2795-2804` has no `--i0`
rule. An upload-only day carries `topics: 0` (`lambda_org_api.py:4566`), so
after a pure predicate flip the cell is byte-identical to today.

So:

- `intensity()` keeps `hasReport` and keeps meaning *how much was said*.
- A second, independent glyph renders when `hasContent(meta) && intensity === 0`
  — proposed `fs-date-picker__cell-dot--content`, a hollow/outline dot, with
  its own CSS rule and a legend entry wherever the density legend is drawn.
- The aria-label (`:135`) stops saying "no report" for these days and says what
  arrived, from the fields the map already carries: `photos` and `sessions`
  (`lambda_org_api.py:4567-4568`) — e.g. `"2026-08-20, 56 photos"`.

This also settles the first draft's §9 open question. A visual distinction is
not a design preference to be weighed; it is the only way anything renders at
all.

**(4) The aggregated day view must surface what arrived.**

`AggregatedDayView`'s zero-sections branch (`:1219-1223`) renders
`NoReportState` with no `facts`. It already has the per-folder results in
hand. It collects those that are `_notFound` **and** carry
`raw.uploads || raw.photo_filenames`, and renders one `NoReportState` per such
folder — passing `facts: x.report.raw`, which is the exact prop shape
`NoReportState` already consumes (`:816-843`, including `facts.user` for the
photo key). No new rendering code; the component is reused as-is.

The `:1875` `canFallBackToTeam` hand-over then lands somewhere that shows
content instead of a dead end, so it needs no change of its own.

**(5) Evidence must read the day it can now see.**

`evidence.js:299` drops `_notFound` reports before building rows. An
upload-only day *is* one, and its photos live in `report.raw.photo_filenames`.
Without this, the 18 days appear in Evidence with **zero photos each** —
worse than not appearing.

The envelope was verified: `_fetch.js:213` yields `{_notFound, status:404, raw}`,
`orgRequest` goes through the same `request` so aurora 404s carry `raw`, and
the body (`lambda_org_api.py:6104-6112`) has `user` (the folder, as a field)
and `photo_filenames` (`:6256`). The other two 404s (`:6091`, `:6101`) carry
`user` but deliberately no filenames, so they keep being dropped.

**Do not pass `raw` straight to `photosForReport`.** It reads
`report.photo_filenames` *and* `report.user_name` (`evidence-grouping.js:117-146`),
and `raw` has `user`, not `user_name` — every row would get
`userDisplayName: undefined` and `PhotoGrid` builds its key from that
(`photo-grid.js:6-17`). Build `{photo_filenames: raw.photo_filenames,
user_name: raw.user}` and pass that. `folderName()` is idempotent on a folder
string (`api/index.js:33-35`), so the existing `user_folder` derivation is fine.

**Out of scope, stated rather than discovered later:** Evidence's *second*
fan-out (`evidence.js:381-436`, the Audio/Video tabs) is keyed on
`org.getSessions`, which returns `[]` for these days (§4c). None of the 83
sessions will appear there. Fixing that means sourcing sessions from
`recordings` — a backend change, not this one.

**(6) Mock mode must be able to reach all of it.**
`scripts/mock/dates.fixture.js` has no `hasUploads` and no `2026-04-27`, while
`api/timeline.js:97-105` special-cases exactly that date for the raw facts.
Add a fixture entry for it (`hasReport:false, hasUploads:true, topics:0,
photos:3, sessions:0`) so the new dot and the Evidence branch are both visible
in the preview without prod credentials.

## 6. What the user will see

- An outline dot on 2026-09-06 and 2026-09-07 — the newest content in the
  system — labelled with what arrived.
- Clicking it, as a site-anchored manager or as themselves, lands on "No
  report yet · 2 recordings arrived on this day" instead of "No reports for
  this project".
- Evidence 'All' reaching back past 2026-07-11 and showing the 166 photos it
  has never shown, including 2026-08-20's 56.
- No density shade on those cells, because `topics` is genuinely 0. The
  outline dot says *something is here*; the shade says *this much was talked
  about*. They are different facts and stay different glyphs.
- The Audio/Video tabs on those days stay empty (§5(5)).

## 7. Risks

**More requests.** The map grows by ≤18 keys over 24 months. §4b does not
widen, so the only new fan-out is Evidence's photos leg, bounded by the days
in range.

**The 'All' span widening pulls other pages' ranges with it.** `resolve('all')`
uses `span.earliest`. Tasks/compliance ranges get wider nominally, but they
filter on `hasReport` inside, so the same requests are issued over a wider
window — no new fetches and no new rows. Verified against all three.

**Cache.** `dates.js`'s key includes `datesSource()` but not the uploads
opt-in. The opt-in becomes unconditional on the aurora path so there is no
mixed state to collide; a stale 3-minute entry from before deploy simply lacks
`hasUploads` and behaves as today until it expires. Noted so it is not
mistaken for a bug during self-test — as is the `?v=` bump, without which the
browser runs the old bundle and the whole change looks inert.

## 8. Session picker

`timeline.js:1699-1700` gates `getSessions` on `hasReportNow`, so on an
upload-only day the single-user view shows `NoReportState` with photos and no
session list. That is consistent with §4c and §5(5) and is correct as it
stands; recorded so it is not read as a regression during hand-test.

## 9. Tests

- `hasContent` truth table: report-only, uploads-only, both, neither, and
  `hasUploads` **absent** — the last is the one that guarantees no behaviour
  change where the field is missing.
- `dates.js` sends `uploads: 1` on the aurora path and **not** on the legacy
  path. Drive it and inspect the request; do not grep the source.
- `computeSpan` widens `earliest` to an uploads-only day.
- **The date-picker renders a cell glyph for a day with `hasUploads` and
  `topics: 0`** — assert on the rendered output, not on `intensity()`'s return
  value. A test that only checks the predicate passes against the no-op the
  first draft would have shipped.
- `AggregatedDayView` with all folders `_notFound` and one carrying
  `raw.uploads` renders the arrival line and the photo grid.
- `_fallbackCandidates` skips an uploads-only day even when it is the newest.
- Evidence builds a row from a `_notFound` report whose `raw.photo_filenames`
  is populated, with a defined `userDisplayName`, and still drops
  `_accessDenied` / `available_users`.
- The §4b five do not fan out to an uploads-only day — assert request counts,
  over a range containing at least one report day (§4b).

## 10. What the review changed

Recorded because two of the three would have shipped as a no-op that tested
green, and this repo has a standing note about exactly that shape.

1. **The dot does not exist.** `intensity()` gates on `topics`, not on the
   predicate, so flipping line 89 renders nothing. The first draft's §4a, §6
   and §7 all assumed two independent glyphs. → §5(3), and it answers the
   first draft's open question in the process.
2. **`org.getSessions` is built from topics.** The first draft argued
   `_fallbackCandidates` would benefit from the wider map and called the
   backend's warning out of date. It was the draft that was wrong; the probe
   budget would have been spent on days that return `[]`. → §4c.
3. **Two of three landing paths discard the facts.** "The day view already
   renders these days correctly" held only for explicit `?user=`. Dots without
   §5(4) would have produced a clickable dot leading to *"No reports for this
   project"*. → §3 and §5(4).

Also corrected: `actions.js`'s fallback is not a filter (§4b); the §2 numbers
are company-wide and tombstone-blind, not what any caller's endpoint returns
(§2); `raw` cannot be handed to `photosForReport` directly (§5(5));
`date-picker.js:110` is the safety dot and stays (§4a); the recordings tab and
the mock fixture were both unaddressed (§5(5), §5(6)).
