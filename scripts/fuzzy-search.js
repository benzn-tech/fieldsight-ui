/* ==========================================================================
   FieldSight fuzzySearch -- forgiving, instant filtering of a short list
   --------------------------------------------------------------------------
   For the report-module menu (owner, 2026-10-05): "safty" must still find
   "Safety". Each word typed must match some word of the item -- as a prefix,
   anywhere inside it, or within a small edit distance (one typo up to six
   letters, two beyond). Items whose TITLE matches rank above items matched
   only by their description. Pure, no dependencies; the lists are tens of
   items, so it runs on every keystroke without a debounce.

   Exported to: window.FieldSight.fuzzySearch  (and module.exports for tests)
   ========================================================================== */

(function () {
  'use strict';

  function words(text) {
    return String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  }

  /* Levenshtein distance, stopping early once it passes `max`. */
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [];
    for (var j = 0; j <= b.length; j++) prev.push(j);
    for (var i = 1; i <= a.length; i++) {
      var cur = [i];
      var best = i;
      for (var k = 1; k <= b.length; k++) {
        var v = Math.min(prev[k] + 1, cur[k - 1] + 1,
          prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
        cur.push(v);
        if (v < best) best = v;
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  /* 0 = exact/prefix, 1 = inside the word, 2 = close spelling, -1 = no. */
  function wordScore(q, w) {
    if (w.indexOf(q) === 0) return 0;
    if (q.length >= 3 && w.indexOf(q) > 0) return 1;
    if (q.length < 4) return -1;
    var max = q.length <= 6 ? 1 : 2;
    /* Against the whole word, and against its start (a word half typed). */
    if (distance(q, w, max) <= max) return 2;
    if (w.length > q.length && distance(q, w.slice(0, q.length), max) <= max) return 2;
    return -1;
  }

  function fieldScore(qs, ws) {
    var total = 0;
    for (var i = 0; i < qs.length; i++) {
      var best = -1;
      for (var j = 0; j < ws.length; j++) {
        var s = wordScore(qs[i], ws[j]);
        if (s >= 0 && (best < 0 || s < best)) best = s;
      }
      if (best < 0) return -1;
      total += best;
    }
    return total;
  }

  /* items: array; fields(item) -> [title, ...other text]. Returns the items
     that match, best first (title matches, then closer spellings, then the
     original order). An empty query returns the list unchanged. */
  function fuzzySearch(items, query, fields) {
    var qs = words(query);
    if (!qs.length) return items.slice();
    var scored = [];
    items.forEach(function (item, idx) {
      var f = fields(item);
      var title = fieldScore(qs, words(f[0]));
      var all = fieldScore(qs, words(f.join(' ')));
      if (title < 0 && all < 0) return;
      scored.push({ item: item, rank: title >= 0 ? title : 100 + all, idx: idx });
    });
    scored.sort(function (a, b) { return a.rank - b.rank || a.idx - b.idx; });
    return scored.map(function (s) { return s.item; });
  }

  if (typeof window !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.fuzzySearch = fuzzySearch;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { fuzzySearch: fuzzySearch, distance: distance };
  }
})();
