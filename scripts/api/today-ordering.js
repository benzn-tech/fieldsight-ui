/* ==========================================================================
   api/today-ordering.js — the order Today's open items are read in.
   --------------------------------------------------------------------------
   Today's Mine/Team lists had NO order at all. They came out in whatever
   sequence the topics happened to be flattened in, which is transcript
   order — the order things were SAID, which has nothing to do with the
   order they should be done. The reported symptom was not being able to
   tell what mattered.

   What the ordering can be built on was settled by looking at the data,
   not by choosing a textbook rule. Of 183 action items in prod:

     • deadline is set on 6 of them, and on ZERO of the 175 still open.
       So earliest-due-date — Jackson's rule, the obvious answer for a
       list like this — has nothing to sort by and is not implementable
       here. Neither is anything else that needs a due date: slack time,
       critical ratio, lateness minimisation.
     • priority IS populated and does discriminate: 77 high, 83 medium,
       15 low.
     • category discriminates too, though safety is rare: 110 progress,
       54 quality, 11 safety.
     • age spans six months, and 106 of the 175 open items — 61% — are
       more than LEFTOVER_THRESHOLD_DAYS old.

   That last number is why age is a TIER and not just a tiebreak, and why
   it is the FIRST tier. Sorting purely by "oldest first" would fill the
   top of every band with items nobody has touched since February;
   sorting purely by "newest first" would bury work that is genuinely
   slipping. So the aged set is demoted as a group — the page already
   marks it with its own chip and offers a filter for it — and within
   each group the oldest comes first, because among items that are all
   still live, the one that has waited longest is the one closest to
   being forgotten.

   Safety sits BELOW that demotion, which is not where it started.
   Safety-first was the intuitive order, and running the real open items
   through it refuted the intuition: nine of the top ten were 148-176
   days old, and reading them showed why. The extractor's `safety`
   category is noisy — the head of the list was "Vacuum dust off
   finished carpet" and "Provide key for door access". Stale mislabelled
   housekeeping presented as the most important thing on the page is the
   exact failure this ordering exists to fix.

   The rules are lexicographic and unweighted on purpose. A weighted
   score would need numbers nobody can defend and would reshuffle the
   list in ways nobody can predict; each rule below can be stated in one
   sentence and argued with on its own.

   Registers as FS.api.orderOpenItems (and exports for node --test).
   ========================================================================== */
(function () {
  'use strict';

  /* Mirrors today.js's LEFTOVER_THRESHOLD_DAYS. Duplicated rather than
     imported because today.js is a browser-only page module with no export;
     the pair is asserted in tests/today-ordering.test.js so a change to one
     without the other fails loudly instead of silently splitting the tier
     boundary from the chip that advertises it. */
  var AGED_AFTER_DAYS = 90;

  var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

  function priorityRank(item) {
    var p = item && item.priority;
    var r = PRIORITY_RANK[String(p || '').toLowerCase()];
    /* Unknown or missing sorts WITH medium, not last: an item the
       extractor did not label is not thereby less important, and pushing
       it to the bottom would hide exactly the items with the least
       metadata. */
    return r === undefined ? PRIORITY_RANK.medium : r;
  }

  /* Safety is the parent topic's category, threaded onto each action item
     by today-adapter. A topic carrying safety flags counts even when its
     category is something else — the flag is the stronger statement. */
  function isSafety(item) {
    if (!item) return false;
    if (String(item.category || '').toLowerCase() === 'safety') return true;
    return !!item.hasSafetyFlags;
  }

  function isAged(item) {
    return !!item && item.ageDays > AGED_AFTER_DAYS;
  }

  /* Missing age sorts as 0 — a brand new item, which is what an item with
     no report date behind it effectively is. It must not sort as older
     than everything, which is what a null would do under a bare compare. */
  function age(item) {
    var n = item && item.ageDays;
    return typeof n === 'number' && isFinite(n) ? n : 0;
  }

  function cmp(a, b) {
    /* 1. Live work before the aged pile. 61% of open items are older than
          the threshold; without this tier they ARE the list.

          This sits above safety, which is not where it started. Safety-first
          was the intuitive order and the real data refuted it: ranking the
          open items that way put nine 148-to-176-day-old rows at the top,
          and reading them showed why — the extractor's `safety` category is
          noisy, so the head of the list was "Vacuum dust off finished
          carpet" and "Provide key for door access". Stale mislabelled
          housekeeping presented as the most important thing on the page is
          the exact failure this ordering exists to fix. Demoting age first
          puts the one recent safety item on top, then the actual
          outstanding engineering work. */
    var ga = isAged(a) ? 1 : 0, gb = isAged(b) ? 1 : 0;
    if (ga !== gb) return ga - gb;

    /* 2. Safety first WITHIN a group — the domain's own hierarchy, applied
          where the items are all still live enough to act on. */
    var sa = isSafety(a) ? 0 : 1, sb = isSafety(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;

    /* 3. Priority — the one extraction field that is both populated and
          discriminating. */
    var pa = priorityRank(a), pb = priorityRank(b);
    if (pa !== pb) return pa - pb;

    /* 4. Oldest first WITHIN a group: among items that are all still
          live and equally urgent, the one that has waited longest is the
          one closest to being forgotten. */
    var aa = age(a), ab = age(b);
    if (aa !== ab) return ab - aa;

    /* 5. Ownership breaks a tie; it never outranks safety or priority.
          Someone else's high-priority safety item still beats my own
          low-priority one, which is the whole point of showing both. */
    var ma = a && a.isMine ? 0 : 1, mb = b && b.isMine ? 0 : 1;
    if (ma !== mb) return ma - mb;

    /* 6. A stable, content-derived last resort, so the list does not
          reshuffle between renders of identical data. Never store this —
          an order nobody stated must not become data. */
    return String((a && a.title) || '').localeCompare(String((b && b.title) || ''));
  }

  /* Returns a NEW ordered array; the caller's list is not mutated (the
     same list object is held in React state and sorting in place would
     mutate state behind React's back). */
  function orderOpenItems(list) {
    return (list || []).slice().sort(cmp);
  }

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.orderOpenItems = orderOpenItems;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      orderOpenItems: orderOpenItems,
      compareOpenItems: cmp,
      AGED_AFTER_DAYS: AGED_AFTER_DAYS,
    };
  }
})();
