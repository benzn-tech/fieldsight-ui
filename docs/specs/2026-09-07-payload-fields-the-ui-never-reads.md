# Every field the payload carries, and whether the UI reads it

**Date:** 2026-09-07
**Status:** measurement, not a proposal. Two of the gaps it found are already
fixed (#254, #255); the rest are listed with a recommendation and left alone.
**Method:** every key in `render_report_shape`'s topic dict
(`lambda_org_api.py:5841-5905`), grepped against `scripts/` with `scripts/mock/`
excluded, then each zero-hit field measured against real prod data.

---

## 1. Why this exists

Four questions were asked about the UI in one sitting. Three had the same
answer:

> **The backend selected the field. The payload carried it. The render dropped
> it.**

- Today's open items looked unsorted — the sort key was `resolveDeadline()
  .absolute`, which is day-only, while the card displayed the time. (#253)
- `findings` looked purposeless — `domain` and `severity` both arrive and
  neither was rendered, so forty MAJOR findings looked like fifty-five
  severity-`none` ones. (#254)
- `raised 4×` carried no scale — `first_seen` / `last_raised` / `open_items`
  all arrive inside `topic.thread` and only `times_raised` was read. (#255)

Three instances is a pattern, and a pattern is worth sweeping for rather than
waiting on. This document is the sweep.

## 2. The distinction that makes the list readable

A field with no reader is not automatically a defect. There are three cases and
only one of them is:

| | meaning |
|---|---|
| **dropped** | the field carries data on prod and nothing renders it |
| **empty** | nothing reads it and there is nothing to read — the producing feature is off |
| **audit** | never intended for display |

Telling them apart requires measuring prod, not reading code. `is_mixed` looked
identical to `severity` until it was counted.

## 3. The sweep

Read by the frontend: `topic_id`, `topic_row_id`, `session_id`, `session_kind`,
`time_range`, `topic_title`, `category`, `participants`, `summary`,
`key_decisions`, `action_items` (+ `id`/`action`/`responsible`/`deadline`/
`priority`/`status`/`mention_count`), `findings`, `safety_flags`,
`safety_observations`, `related_photos`, `redacted`, `redaction_id`, `thread`,
`times_raised`, `work_class`, `work_confidence`, `executive_summary`,
`quality_and_compliance`.

Zero readers:

| field | prod reality | verdict |
|---|---|---|
| `thread.first_seen` | populated | **dropped** → fixed in #255 |
| `thread.last_raised` | populated | **dropped** → fixed in #255 |
| `thread.open_items` | populated | **dropped** → fixed in #255 |
| `findings[].severity` | 40 major / 88 minor / 55 none | **dropped** → fixed in #254 |
| `findings[].domain` | progress 141 / quality 53 / safety 25 | **dropped** → fixed in #254 |
| `critical_dates_and_deadlines` | **239 entries across 62 of 279 report files** | **dropped** — §4 |
| `is_mixed` | **NULL on all 428 prod topics** | empty — §5 |
| `collapsed_ids` | todo-collapse audit trail | audit — no action |
| `impact_note` / `impact_task_name` / `impact_severity` | **zero rows carry one** | empty — §6 |

## 4. `critical_dates_and_deadlines` — real content, no surface

The largest genuine gap left. Measured across the 279 report artifacts in the
prod lake:

- **239 entries, 227 of them distinct** — almost no internal repetition
- shape: `{date_mentioned, context, who_mentioned, urgency, type}`
- type: deadline 107 · meeting 52 · other 41 · delivery 15 · inspection 15 ·
  weather 9
- urgency: **high 115** · medium 93 · low 31
- only **63 (26 %)** carry an explicit ISO date; the rest are `"Wednesday"`,
  `"Tomorrow"`, `"This afternoon"`
- only **15 (6 %)** repeat an action item's text

Real examples: *"Carpet installation to be ready in Building 2"* (Wednesday,
high) · *"Water tower cut-off work to be completed"* (Tomorrow, high).

**Two things constrain any design here, and both come from the numbers:**

`urgency` cannot rank the list. 115 of 239 are `high` — 48 %, the same
proportion that made `priority` unusable as a sort key for Today's open items
(169 of 349). A field that calls half the list urgent is a badge, not an order.

It is not a due-date list. Three quarters resolve to no date. It is *"dates the
site talked about"*, which is a different and more honest thing to call it.

**Recommendation: do not build a surface for this without a product decision.**
It is a whole new section on a page the owner has recently made *smaller* on
purpose — the activity feed was cut outright and an aggressive restructure was
rejected. Making an existing surface legible (#254, #255) and adding a new one
are different acts, and only the first is safe to do unprompted.

## 5. `is_mixed` — nothing to read

`is_mixed` and `work_class` are **NULL on all 428 prod topics**: the
life-conversation separation feature is live on TEST and off on prod. The
frontend reads `work_class` in seven files, so the "Possibly personal" badge is
wired and simply never fires on prod.

This is the entry that justifies the whole method. On a code read it looks
exactly like `severity` did — a real column, a real payload key, no reader.
Counting it is the only thing that tells them apart, and building a UI for it
would have shipped a surface for data that does not exist.

## 6. The programme-impact columns — a different failure

`programme_task_id` / `impact_severity` / `impact_note` / `impact_task_name`
are zero rows on prod, but NOT because the feature is unbuilt. Diagnosed the
same night:

- `fieldsight-prod-programme-matcher` — **272 invocations in 30 days**
- `fieldsight-prod-suggestion-writer` (the only thing that persists) — **0**
- 45 days of logs: **1569 × `no programme/leaves for site=… — skipping`**,
  two site ids, not one successful match

`repositories/programme.read_programme` reads
`programmes/{site_id}/programme.json`, and that prefix **does not exist in the
prod bucket**. Write and read agree on the bucket (org-api's `S3_BUCKET` and
the matcher's `PROGRAMME_BUCKET` are both the lake), so the competing
"misconfigured bucket" explanation is ruled out.

**No customer site has ever had a programme uploaded.** The chain is built,
deployed and running; it is starved. This is onboarding, not engineering —
import a programme and links begin appearing with no code change, subject to
the matcher's `LEAD_DAYS=7` / `LAG_DAYS=14` window.

## 7. How to re-run this

```bash
# every key the topic payload carries
sed -n '5841,5905p' src/lambda_org_api.py | grep -oE '^\s+"[a-z_]+":' | tr -d ' ":' | sort -u

# for each, does anything outside the fixtures read it
grep -rl "\bFIELD\b" scripts/ --include=*.js | grep -v '^scripts/mock/' | wc -l

# then MEASURE the zero-hit ones against prod before calling any of them a defect
aws s3 cp s3://fieldsight-data-509194952652/reports/ . --recursive --quiet
```

The third step is the one that cannot be skipped. Two of the nine zero-hit
fields turned out to have nothing behind them.
