# Today's open items: an order you can name

**Date:** 2026-09-07
**Status:** design, second draft. The first was written against the database
and is corrected in §9.
**Scope:** frontend only.

---

## 1. What was asked

> open items 的 sorting 还没有解决，这种内容排序还非常混乱，我没有看懂它是怎么排序的。
> 我们希望…提供几个 sorting 按钮吧…按 Today 什么时候创建的。另外，什么时候创建的是一种
> 方法，还有什么时候 due date 又是另外一个排序方法，这个怎么去安排到 sorting 逻辑呢？

Two requests. The second is the design question: **how a created-time order
and a due-date order fit together.**

## 2. There is an order. It cannot be read off the screen.

`api/today-ordering.js` sorts on seven lexicographic tiers: aged-demotion,
safety, times-raised, priority, age, mine-first, title.

Nothing is wrong with it as a rule and its reasoning is real — the aged
demotion exists because 61 % of open items were older than 90 days, and
sorting purely by age filled the top of the page with February.

**The problem is that no tier is a property the reader can see.** Two `High`
safety items sit at opposite ends because one is 89 days old and the other 91.
Tier 3 outranks priority and sorts on a number the page never renders. The
order is defensible and unreadable, which is the worst pair: it looks
arbitrary, so it gets distrusted.

## 3. What the FRONTEND actually has

This is the section the first draft got wrong, so it is measured against
`today-adapter.js` and `today.js` rather than against the table.

| what the spec wants | what the item carries | where |
|---|---|---|
| a creation timestamp | **`date`** — `'YYYY-MM-DD'`, day-granular, nothing finer | `today-adapter.js:521`, re-stamped `today.js:1104` |
| a due date | **`deadline`** — the RAW free text, e.g. `"Today 08:30"` | `today-adapter.js:469` |
| a resolved due date | only via `FS.api.resolveDeadline(deadline, date).absolute` | `today-adapter.js:203`, exported `:611` |
| `deadline_text` | **does not exist on the item** | it is a column on the PATCH response only |
| priority | `priority`, but **capitalised** — `'High'`/`'Medium'`/`'Low'` | `priorityLabel`, `today-adapter.js:83` |
| a stable id | `id`, made date-unique by the rolling loader | `today.js:1109` |
| age | `ageDays`, always stamped | `today.js:1111` |

**There is no timestamp in the frontend at all.** Prod's `created_at` — 64
distinct values across 349 open items, one of them carrying 26 — is invisible
here. The finest creation key available is the report **day**, and merged
across folders a day holds more than 26.

The prod numbers that survive, because they describe the *content* rather than
the field: **349 open items, 58 with a resolvable date, 169 (48 %) `High`.**

Three consequences, each of which kills an obvious design:

**Due date cannot be the only key.** Roughly three quarters of items resolve to
no date. A plain due-date sort leaves them in an undefined pile, and whatever
silently happens to that pile *is* the feature.

**"When it was said" is day-granular.** It orders the page into days, not into
positions. It is still the right default — it is the only key that covers
everything and the only one a person can check against their own memory — but
it needs a real tiebreak, and `title` is not one (§4.1).

**Priority is spent as a primary key.** 48 % `High`. It stays a badge. Whether
it stays a *tiebreak* is §4.3.

## 4. The design

**Two named buttons, and the page says which is on.** The current order's real
failure is that it is unnamed and unpickable — a reader who cannot name the
order cannot decide whether to trust it.

```
Order:  [ When it was said ]  [ Due date ]
```

### 4.1 When it was said — the default

`date` descending, then `priority` rank, then `id`.

- **`date` descending** — newest day first. The aged pile sinks on its own, so
  the aged tier is not needed.
- **`priority` rank** — inside one day, `High` before `Medium` before `Low`,
  comparing case-insensitively because the adapter capitalises. It is a weak
  signal (§3) but it is a signal, and the alternative for a 26-row day is
  alphabetical, which is not more legible — it is just less useful.
- **`id`** — the final tiebreak, and it must be there. Two items can share a
  day AND a title: re-extraction of one meeting produces duplicate action text,
  which is the whole reason `todo_collapse` exists on the backend. Without an
  id tiebreak the sort is not total and the order changes between reloads.

### 4.2 Due date — with the undated handled in the open

Key is `resolveDeadline(item.deadline, item.date).absolute`. Items that resolve
to a date sort ascending; everything else falls to a labelled divider and then
the default order.

**The first draft tried to separate "a real date" from "a parsed guess" and
that distinction does not exist here.** `resolveDeadline` is the only source of
a date, its doc calls an embedded date *authoritative*, and the draft's own
example of an unpromotable guess — `"Week after next Tuesday (2026-07-28
approx.)"` — is exactly the case it resolves confidently. So: whatever
`resolveDeadline` returns is the date, and there is no second class.

The divider is the point:

```
  Fri 11 Sep   Pod 3 brief — finalize draft
  Mon 14 Sep   Preliminary claim discussion
  ──────────  No due date · 14  ──────────
               Recording devices — deploy to James
```

Dropping the undated items, or letting them trail silently, turns "sorted by
due date" into "hid most of your work" — the shape this repo shipped a month
ago when a collapse's merged rows vanished instead of merging. **The count is
on the divider so a reader can see how much of the list the sort did not
order.**

### 4.3 The divider lives inside each project group

`renderMaybeGrouped` (`today.js:712`) **always** wraps rows in project-headed
groups — its own comment says project is a high-level header even for a single
project. A page-level divider has nowhere to go, and a globally-sorted sequence
re-bucketed by project is no longer globally sorted.

So the sort and the divider are **per project group**, and each divider carries
its own count. That is also the more useful answer: a site manager reading one
project's rows does not want another project's Sep-11 item above their own
Sep-14 one.

Mine and Team are two separately sorted lists (`today.js:1988, 2312, 2368`), so
in the general case there are several dividers on the page. Each is correct
about its own group.

### 4.4 Overdue is not a third sort

An overdue item is the soonest-due item and is already at the top. It gets no
tier of its own — and note there is no existing overdue treatment to reuse on a
to-do card: `today.js:96-99` records that overdue framing for action items is
out of scope because the deadlines are free text. This spec does not change
that.

### 4.5 What stops deciding the order

Aged demotion, safety-first, times-raised, and mine-before-theirs. They remain
as **filters and badges**, which is where they are legible and where the page
already offers them.

Safety-first in particular: its own docstring records that running it on real
data put nine items aged 148–176 days in the top ten, headed by *"Vacuum dust
off finished carpet"*. The category is noisy and the tier amplified it.

## 5. Where the choice lives

Component state in `TodayMiddleColumn`, threaded into `visibleTasks` — which
today takes `(list, hideAged)` and will need the mode as a third argument.

Not persisted, deliberately, and this diverges from the page's own precedent:
the aged filter *is* persisted (`fs.settings.todayHideAged`, `today.js:180`).
The difference is that hiding old work is a standing preference, while a
reading order is a per-visit question — somebody who sorted by due date
yesterday to plan a week should not find the page that way tomorrow morning
when they are looking at what came out of a meeting.

## 6. Testing

`tests/today-ordering.test.js` pins the tiers being removed, so it is
rewritten rather than extended.

- **The default is total and stable.** Shuffle the input, assert identical
  output. Include two items sharing day AND title — the case `id` exists for.
- **The undated pile is counted, not dropped.** Sort by due date; assert every
  input item appears in the output and each divider count equals the rows below
  it *in its own group*. This is the assertion that would have caught the
  collapse defect.
- **`priority` comparison is case-insensitive.** Feed `'High'` — the shape the
  adapter actually produces — and assert it outranks `'medium'`. A test using
  lowercase would pass against code that only works on lowercase.
- **`AGED_AFTER_DAYS` keeps its cross-file guard.** The existing test asserts
  it matches `today.js`'s `LEFTOVER_THRESHOLD_DAYS`; the constant still drives
  the chip and its filter even though it stops driving the order, so that
  assertion is carried over rather than deleted with the tiers.
- **`tests/leftover-inline-filter.test.js` calls the real `visibleTasks`**,
  which calls the real orderer — its fixtures have to survive the new
  comparator. Run it, do not assume.
- **Revert-check.** Remove the `id` tiebreak → the stability test fails. Remove
  a divider count → the completeness test fails.

## 7. Verification in the browser

Open Today, switch the button, read the DOM:

- the caption names the order actually applied
- **every** project group has its own divider, and each count equals the rows
  below it in that group
- switching back restores the default
- `hideAged` still works in both modes — an aged item with a near deadline
  rises above the divider wearing its 90-day chip, which is correct and worth
  looking at once
- both themes: divider `--border-*`, caption `--text-*`

## 8. Open

1. **Should the aged pile be hidden rather than sunk?** Newest-first sinks it
   and the page already has a filter. Hiding is a filter decision, not a sort
   one, and it is the user's.
2. **`/tasks` is not touched.** It has its own table with its own column sort.

## 9. What the first draft got wrong

Kept because the pattern repeats: it was written against the **database
schema** and never checked the object the list actually receives — the same
mistake the external-corroboration spec made against the call graph.

| claim | reality |
|---|---|
| sorts on `created_at` | that field does not exist in the frontend; the key is `date`, day-granular |
| `deadline` is a real date and `deadline_text` a separate field | `deadline` is raw free text; `deadline_text` is not on the item at all |
| a "real date" can be told from "a parsed guess" | `resolveDeadline` is the only source of either, and the draft's own example of a guess is one it treats as authoritative |
| `priority` is lowercase | the adapter capitalises it |
| one divider, page-level | the list is always project-grouped, so a page-level divider has nowhere to render |
| `title` is a sufficient tiebreak | two items can share day and title; the sort would not be total |
