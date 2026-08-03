/* ==========================================================================
   FieldSight Programme Window — presets and overlap arithmetic
   --------------------------------------------------------------------------
   The time window is the programme page's LOAD boundary, not a filter over an
   already-loaded programme. A ten-week range is a few hundred rows whether the
   programme has 500 tasks or 30,000, which is why programme size stopped being
   a rendering problem — see the spec, §7.

   Presets are weeks back / weeks forward rather than absolute dates. That is
   how the work gets discussed on site ("the last fortnight and the next
   month"), and it keeps the window anchored to today without the user
   re-picking it every morning.

   Pure: no React, no DOM, no fetch. The page owns the request and the
   preference write; this module owns the arithmetic.

   Exported to:
     window.FS.api.programmeWindow   (browser)
     module.exports                  (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Server caps a window at 400 days (lambda_org_api._MAX_WINDOW_DAYS); every
     preset here stays inside it, and a test asserts that so the two cannot
     drift apart into a 400 that only fails in production. */
  var PRESETS = [
    { key: '2-4',  label: '2 weeks back · 4 ahead',  backWeeks: 2, forwardWeeks: 4, default: true },
    { key: '2-8',  label: '2 weeks back · 8 ahead',  backWeeks: 2, forwardWeeks: 8 },
    { key: '4-4',  label: '4 weeks back · 4 ahead',  backWeeks: 4, forwardWeeks: 4 },
    { key: '4-12', label: '4 weeks back · 12 ahead', backWeeks: 4, forwardWeeks: 12 },
    { key: '8-8',  label: '8 weeks back · 8 ahead',  backWeeks: 8, forwardWeeks: 8 },
  ];

  var DEFAULT_PRESET_KEY = '2-4';

  /* Falls back to the default rather than returning undefined: a stored
     preference can outlive the preset that produced it, and an undefined here
     would throw on the next page load with no way for the user to clear it. */
  function presetByKey(key) {
    var fallback = null;
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].key === key) return PRESETS[i];
      if (PRESETS[i].key === DEFAULT_PRESET_KEY) fallback = PRESETS[i];
    }
    /* Not recursive on purpose: a lookup of the default key would loop
       forever the day someone edits DEFAULT_PRESET_KEY without adding the
       matching preset. */
    return fallback || PRESETS[0];
  }

  function addDays(iso, n) {
    var p = String(iso).split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /* Accepts a preset object or a preset key. */
  function resolveWindow(preset, todayISO) {
    var p = (preset && typeof preset === 'object') ? preset : presetByKey(preset);
    return {
      from: addDays(todayISO, -p.backWeeks * 7),
      to:   addDays(todayISO,  p.forwardWeeks * 7),
    };
  }

  /* Overlap, matching the server's rule exactly. Containment would hide the
     long tasks, which are the ones worth watching — and a client that
     disagreed with the server would hide rows the server had just decided to
     send, which reads as data loss rather than as a filter.

     Reads both key shapes: the window endpoint returns Aurora column names
     (start_date/end_date), the legacy snapshot document uses start/end. */
  function isInWindow(task, window) {
    var start = task.start || task.start_date;
    var end   = task.end   || task.end_date;
    if (!start || !end) return false;
    return start <= window.to && end >= window.from;
  }

  var api = {
    PRESETS:            PRESETS,
    DEFAULT_PRESET_KEY: DEFAULT_PRESET_KEY,
    presetByKey:        presetByKey,
    resolveWindow:      resolveWindow,
    isInWindow:         isInWindow,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeWindow = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
