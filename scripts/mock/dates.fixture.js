/* ==========================================================================
   FieldSight Fixtures · Calendar dates
   --------------------------------------------------------------------------
   Heat-map fixture for /api/dates (BACKEND-CONTEXT §4.3). Spans the trailing
   ~6 weeks ending on the today-fixture date 2026-04-29 — close enough for
   a 3-month dot-density preview without being noisy.

   Counts:
     - topics  = max across accessible users on that date
     - safety  = count of topics with category=='safety' OR
                 non-empty safety_flags[]

   Exported to window.FieldSight.fixtures.dates = { dates: { 'YYYY-MM-DD': {…} } }
   ========================================================================== */

(function () {
  'use strict';

  function addDays(yyyymmdd, days) {
    var p = yyyymmdd.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return d.toISOString().slice(0, 10);
  }

  /* Hand-tuned dot density — busy mid-week, lighter on weekends. */
  var BASE = '2026-04-29';
  var PROFILE = [
    /* offset back from BASE → { topics, safety } | null = no report */
    { d: 0,  topics: 11, safety: 2 }, /* today */
    { d: 1,  topics: 14, safety: 3 },
    { d: 2,  topics: 9,  safety: 1 },
    { d: 3,  topics: 12, safety: 2 },
    { d: 4,  topics: 10, safety: 0 },
    { d: 5,  topics: 5,  safety: 0 }, /* Sat */
    { d: 6,  null: true },             /* Sun */
    { d: 7,  topics: 13, safety: 4 },
    { d: 8,  topics: 11, safety: 1 },
    { d: 9,  topics: 8,  safety: 0 },
    { d: 10, topics: 12, safety: 2 },
    { d: 11, topics: 9,  safety: 1 },
    { d: 12, topics: 4,  safety: 0 },
    { d: 13, null: true },
    { d: 14, topics: 11, safety: 3 },
    { d: 15, topics: 13, safety: 2 },
    { d: 16, topics: 7,  safety: 1 },
    { d: 17, topics: 10, safety: 0 },
    { d: 18, topics: 12, safety: 1 },
    { d: 19, topics: 6,  safety: 0 },
    { d: 20, null: true },
    { d: 21, topics: 9,  safety: 2 },
    { d: 22, topics: 14, safety: 4 },
    { d: 23, topics: 8,  safety: 1 },
    { d: 24, topics: 11, safety: 0 },
    { d: 25, topics: 10, safety: 2 },
    { d: 27, null: true },
    { d: 28, topics: 12, safety: 3 },
  ];

  var dates = {};
  PROFILE.forEach(function (entry) {
    var key = addDays(BASE, -entry.d);
    if (entry.null) return;
    dates[key] = {
      hasReport: true,
      topics:    entry.topics,
      safety:    entry.safety,
    };
  });

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.fixtures) window.FieldSight.fixtures = {};
  window.FieldSight.fixtures.dates = { dates: dates };

})();
