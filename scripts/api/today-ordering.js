/* ==========================================================================
   api/today-ordering.js — the orders Today's open items can be read in.
   --------------------------------------------------------------------------
   Two orders, both nameable, because the previous one was neither.

   ## What was here before, and why it went

   Seven lexicographic tiers: aged-demotion, safety, times-raised, priority,
   age, mine-first, title. Nothing was wrong with it as a rule — it was built
   by looking at prod, and the aged demotion existed because 61 % of open items
   were older than 90 days and sorting purely by age filled the top of the page
   with February.

   The problem was that NO TIER WAS A PROPERTY THE READER COULD SEE. Two `High`
   safety items sat at opposite ends because one was 89 days old and the other
   91. Tier 3 outranked priority and sorted on a number the page never renders.
   Defensible and unreadable is the worst pair: it looks arbitrary, so it gets
   distrusted, so the page does.

   Reported as 排序还非常混乱，我没有看懂它是怎么排序的 — and "I cannot see how
   this is ordered" is a complete description of the defect.

   ## What the frontend actually has

   Checked against today-adapter.js, not against the table — an earlier draft
   of this design was written from the database schema and specified a sort on
   fields that do not exist here:

     date       'YYYY-MM-DD', DAY granularity. There is no timestamp anywhere
                in the frontend. Prod's created_at (64 distinct values over 349
                open items, one carrying 26) is invisible from here.
     deadline   the RAW free text — "Today 08:30", "Week after next Tuesday".
                NOT a date. `deadline_text` does not exist on the item at all.
     priority   CAPITALISED by the adapter: 'High' / 'Medium' / 'Low'.
                A naive === 'high' fails; priorityRank lowercases.
     id         date-unique, stamped by today.js's rolling loader.
     ageDays    number, always present on the rolling path.

   ## Why priority is a tiebreak and not a tier

   169 of 349 open items on prod are `High` — 48 %. A field that calls half the
   list the most important thing on it cannot rank the list. It stays a badge,
   and it breaks ties inside one day, where the alternative is alphabetical —
   which is not more legible, only less useful.

   Registers as FS.api.orderOpenItems / FS.api.orderOpenItemsBy.
   ========================================================================== */
(function () {
  'use strict';

  /* Mirrors today.js's LEFTOVER_THRESHOLD_DAYS. Duplicated rather than
     imported because today.js is a browser-only page module with no export;
     the pair is asserted in tests/today-ordering.test.js so a change to one
     without the other fails loudly instead of silently splitting the tier
     boundary from the chip that advertises it.

     It NO LONGER DRIVES THE ORDER — newest-first sinks the aged pile without a
     tier — but it still drives the chip and the "Hide older" filter, so the
     constant and its cross-file guard both stay. */
  var AGED_AFTER_DAYS = 90;

  var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

  function priorityRank(item) {
    var p = item && item.priority;
    var r = PRIORITY_RANK[String(p || '').toLowerCase()];
    /* Unknown or missing sorts WITH medium, not last: an item the extractor
       did not label is not thereby less important, and pushing it to the
       bottom would hide exactly the items with the least metadata. */
    return r === undefined ? PRIORITY_RANK.medium : r;
  }

  /* Lexicographic on the ISO string. Correct because the format is fixed-width
     'YYYY-MM-DD', and deliberately NOT via Date(): BUG-19 — `new Date('2026-09-07')`
     parses as UTC and drifts a day in NZ, which would reorder the two ends of
     a month. Missing sorts last under descending: an item with no date is not
     the newest thing on the page. */
  function dayKey(item) {
    var d = item && item.date;
    return (typeof d === 'string' && d) ? d : '';
  }

  /* The ONLY source of a date in this frontend. `deadline` is free text and
     `resolveDeadline` is what turns it into one — its own doc calls an
     embedded date authoritative and it never guesses a wrong one, returning
     {absolute: null} instead.

     An earlier draft tried to separate "a real date" from "a parsed guess" and
     sort only the former. That distinction does not exist here: there is no
     other date field, and the draft's own example of an unpromotable guess
     ("Week after next Tuesday (2026-07-28 approx.)") is a case this resolver
     handles confidently. */
  function dueKey(item) {
    if (!item || !item.deadline) return null;
    var api = window.FS && window.FS.api;
    if (!api || !api.resolveDeadline) return null;
    var r = api.resolveDeadline(item.deadline, item.date);
    if (!r || !r.absolute) return null;

    /* `absolute` is DAY-ONLY; `display` carries the time when the text had
       one ('2026-04-29 14:00'). Both are fixed-width, so lexicographic order
       is chronological order on either — but only display can separate two
       items due the same afternoon.

       This mattered in the browser, not in a test: six fixture items all due
       2026-04-29 rendered 09:00 below two 14:00s, because everything after
       the day tied and fell through to the default order. THE CARD SHOWS THE
       TIME, so an order that ignores it reads as broken no matter what the
       sort key technically promised.

       `absolute` is still what decides dated-vs-undated (checked above), and
       still the fallback: display is the raw text when nothing resolved, and
       sorting on that would place an invention among facts. */
    var d = r.display;
    if (typeof d === 'string' && d.slice(0, 10) === r.absolute) return d;
    return r.absolute;
  }

  function hasDue(item) { return !!dueKey(item); }

  /* The final tiebreak, and it is load-bearing rather than defensive.

     Two items can share a day AND a title: re-extraction of one meeting
     produces duplicate action text, which is the entire reason todo_collapse
     exists on the backend. Without this the comparator is not total, and a
     non-total comparator reorders itself between renders — the list would
     shuffle on every redraw for no visible reason. */
  function idKey(item) {
    return String((item && item.id) || '');
  }

  function cmpSaid(a, b) {
    /* Newest day first. This is what replaces the aged tier: six-month-old
       items sink on their own, and the page already carries a chip and a
       filter for them. */
    var da = dayKey(a), db = dayKey(b);
    if (da !== db) return da < db ? 1 : -1;

    var pa = priorityRank(a), pb = priorityRank(b);
    if (pa !== pb) return pa - pb;

    var ia = idKey(a), ib = idKey(b);
    return ia < ib ? -1 : (ia > ib ? 1 : 0);
  }

  function cmpDue(a, b) {
    /* Dated before undated. The undated are NOT dropped and NOT silently
       trailed — the caller renders a counted divider between the two halves
       (see partitionByDue). Hiding them would turn "sorted by due date" into
       "hid most of your work", which is the shape this repo shipped when a
       collapse's merged rows vanished instead of merging. */
    var ha = hasDue(a) ? 0 : 1, hb = hasDue(b) ? 0 : 1;
    if (ha !== hb) return ha - hb;

    if (ha === 0) {
      var ka = dueKey(a), kb = dueKey(b);
      if (ka !== kb) return ka < kb ? -1 : 1;   /* soonest first */
    }
    /* Same date, or both undated — fall through to the default order so the
       two modes agree wherever the due date has nothing to say. */
    return cmpSaid(a, b);
  }

  var COMPARATORS = { said: cmpSaid, due: cmpDue };

  /* Does this item have the key the mode actually sorts on? Not the same
     question in the two modes, which is why the direction flip below has to
     ask it per mode rather than reversing the array. */
  function hasKeyFor(mode) {
    return mode === 'due'
      ? hasDue
      : function (it) { return !!dayKey(it); };
  }

  /* `dir` is 'desc' (the shipped order, and the default) or 'asc'.
     OMITTED IS UNCHANGED — every existing caller keeps its exact order.

     Ascending is the same list read backwards WITH ONE EXCEPTION: items the
     mode has no key for stay at the end. Both comparators deliberately sink
     them ('dated before undated' in cmpDue; a missing dayKey sorting last in
     cmpSaid), and a plain `.reverse()` would open the list with the "No due
     date · N" pile — roughly three quarters of prod's open items — which is
     the one group nobody asked to see first. Flipping the order of the work
     that HAS a date is the whole point of the control; promoting the work
     that has none is not. */
  function orderOpenItemsBy(list, mode, dir) {
    var cmp = COMPARATORS[mode] || cmpSaid;
    var sorted = (list || []).slice().sort(cmp);
    if (dir !== 'asc') return sorted;

    var keyed = hasKeyFor(mode);
    var withKey = [], without = [];
    sorted.forEach(function (it) { (keyed(it) ? withKey : without).push(it); });
    return withKey.reverse().concat(without);
  }

  /* Back-compat: the previous single-order entry point. Same default. */
  function orderOpenItems(list) {
    return orderOpenItemsBy(list, 'said');
  }

  /* Split an ALREADY-ORDERED list at the first undated item, so a caller can
     render the divider between them and put the real count on it.

     Returns {dated, undated}. The count belongs on the divider because a
     reader has to be able to see how much of the list the sort did not order —
     roughly three quarters of prod's open items resolve to no date. */
  function partitionByDue(ordered) {
    var dated = [], undated = [];
    (ordered || []).forEach(function (it) {
      (hasDue(it) ? dated : undated).push(it);
    });
    return { dated: dated, undated: undated };
  }

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.orderOpenItems   = orderOpenItems;
    window.FS.api.orderOpenItemsBy = orderOpenItemsBy;
    window.FS.api.partitionByDue   = partitionByDue;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      orderOpenItems: orderOpenItems,
      orderOpenItemsBy: orderOpenItemsBy,
      partitionByDue: partitionByDue,
      compareOpenItems: cmpSaid,
      compareByDue: cmpDue,
      AGED_AFTER_DAYS: AGED_AFTER_DAYS,
    };
  }
})();
