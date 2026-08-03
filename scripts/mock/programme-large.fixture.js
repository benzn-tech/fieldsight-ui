/* ==========================================================================
   FieldSight Programme — large synthetic fixture (perf verification only)
   --------------------------------------------------------------------------
   200 groups x 25 leaves = 5,000 leaves over ~3 years, which is the shape
   this plan's acceptance target is stated against: sustained scroll with no
   frame over 50ms.

   Not loaded by default. Enable by appending ?bigprogramme=1 to the preview
   URL. Never referenced by product code.

   See docs/superpowers/plans/2026-08-02-programme-render-performance.md
   ========================================================================== */

(function () {
  'use strict';

  function iso(dayOffset) {
    var d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + dayOffset);
    return d.toISOString().slice(0, 10);
  }

  var parents = [];
  var leaves  = [];
  for (var g = 0; g < 200; g++) {
    parents.push({ task_id: 'G' + g, wbs: String(g + 1), name: 'Zone ' + (g + 1) });
    for (var i = 0; i < 25; i++) {
      var startDay = g * 5 + i * 2;
      leaves.push({
        task_id:       'G' + g + '-T' + i,
        parent_id:     'G' + g,
        wbs:           (g + 1) + '.' + (i + 1),
        name:          'Activity ' + (i + 1) + ' in zone ' + (g + 1),
        start:         iso(startDay),
        end:           iso(startDay + 9),
        duration_days: 10,
        progress_pct:  (i * 4) % 101,
        status:        'not_started',
        assignees:     [],
        depends_on:    i > 0 ? ['G' + g + '-T' + (i - 1)] : [],
        linked_action_items: [],
      });
    }
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.PROGRAMME_LARGE_FIXTURE = {
    name:       'Synthetic 5k programme',
    start_date: iso(0),
    end_date:   iso(1120),
    parents:    parents,
    leaves:     leaves,
  };
})();
