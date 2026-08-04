/* ==========================================================================
   FieldSight GanttStrip — Layer 5 composite (Sprint 4.4)
   --------------------------------------------------------------------------
   Date strip header at the top of the Gantt timeline. Three tiers:
     day   — every date (compact, scrolls horizontally)
     week  — Monday markers only ("Mon 4 May")
     month — first-of-month markers ("May 2026")

   Width = (totalDays × pixelsPerDay). Today's marker rendered as a
   thin accent line via an absolutely-positioned element (rendered
   by the page, not this composite — it just provides the strip).

   Props:
     from           ISO date — programme start
     to             ISO date — programme end
     pixelsPerDay   number   — set by the page (24 / 6 / 2 typical)
     tier           'day' | 'week' | 'month'

   --------------------------------------------------------------------------
   WHY `from`/`to` ARE VALIDATED RATHER THAN TRUSTED

   This component took the whole app down on prod. The page handed it
   `from = null, to = null` for a site with no programme, and `dateRangeISO`
   walked into `addDaysISO(null, 1)` → `null.split('-')` → TypeError. There is
   no error boundary above it, so React unmounted the entire tree: white
   screen, no nav, no way back.

   The coercion that made it reachable is worth stating, because it is the
   opposite of the intuition. `while (c <= to)` with ONE null operand is
   false — the loop never runs and the function returns [] quietly. With BOTH
   null, `null <= null` compares 0 <= 0 and is TRUE, so it enters the loop and
   throws on the first step. The half-broken input was safe; the fully broken
   one crashed.

   So the range is checked for what it must be — two ISO dates in order —
   rather than for truthiness, and an invalid range renders nothing instead of
   throwing. Rendering nothing is not the fix for the page's problem (a page
   with no dates should say so, and `pages/programme.js` now does); it is the
   guarantee that a bad range can never again take the app with it.

   Exported to:
     window.FieldSight.GanttStrip   (browser)
     module.exports                 (node:test — the strip's date maths had no
                                     coverage at all before this, because the
                                     file could not be required)
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  /* A range is usable only if BOTH ends are ISO dates and they are in order.
     Anything else — null, undefined, '', a Date object, a timestamp, or an
     end before its start — is not a range this component can walk. */
  function isUsableRange(from, to) {
    return typeof from === 'string' && ISO_DATE.test(from)
        && typeof to === 'string'   && ISO_DATE.test(to)
        && from <= to;
  }

  function dateRangeISO(from, to) {
    if (!isUsableRange(from, to)) return [];
    var dates = [];
    var c = from;
    var addDays = (window.FS && window.FS.api && window.FS.api.addDaysISO) || null;
    if (!addDays) return [];
    /* Bounded by construction: `c` strictly increases and `to` is a fixed ISO
       string, so the loop terminates. The guard above is what makes that
       true — it was not true when `from` and `to` could both be null. */
    while (c <= to) {
      dates.push(c);
      c = addDays(c, 1);
    }
    return dates;
  }

  function formatDay(d) {
    var p = d.split('-').map(Number);
    return String(p[2]);
  }
  function formatWeek(d) {
    var p = d.split('-').map(Number);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1];
  }
  function formatMonth(d) {
    var p = d.split('-').map(Number);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[p[1] - 1] + ' ' + p[0];
  }

  function isMonday(iso) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCDay() === 1;
  }
  function isFirstOfMonth(iso) {
    return iso.endsWith('-01');
  }

  function GanttStrip(props) {
    var from = props.from;
    var to   = props.to;
    var ppd  = props.pixelsPerDay || 24;
    var tier = props.tier || 'day';

    /* Memoized: at day tier this builds one marker per calendar day across
       the whole programme — ~1,100 for a three-year run — and it used to be
       rebuilt on every render of the page, including every scroll frame. */
    var strip = React.useMemo(function () {
      var dates = dateRangeISO(from, to);
      var out = [];
      if (tier === 'day') {
        dates.forEach(function (d, i) {
          out.push({ iso: d, label: formatDay(d), x: i * ppd });
        });
      } else if (tier === 'week') {
        dates.forEach(function (d, i) {
          if (isMonday(d) || i === 0) {
            out.push({ iso: d, label: formatWeek(d), x: i * ppd });
          }
        });
      } else {
        /* month */
        dates.forEach(function (d, i) {
          if (isFirstOfMonth(d) || i === 0) {
            out.push({ iso: d, label: formatMonth(d), x: i * ppd });
          }
        });
      }
      return { markers: out, totalWidth: dates.length * ppd };
    }, [from, to, ppd, tier]);

    var markers    = strip.markers;
    var totalWidth = strip.totalWidth;

    /* After the hook, never before it — a conditional return above useMemo
       changes the hook order between renders, which is the bug #179 already
       had to fix once in ProgrammeRightDetail. */
    if (!isUsableRange(from, to)) return null;

    return React.createElement('div', {
      className: 'fs-gantt-strip',
      style:     { width: totalWidth + 'px' },
    },
      markers.map(function (m, i) {
        return React.createElement('div', {
          key:       m.iso + '_' + i,
          className: 'fs-gantt-strip__marker'
                     + (tier !== 'day' ? ' fs-gantt-strip__marker--label' : ''),
          style:     { left: m.x + 'px' },
        }, m.label);
      }),
    );
  }

  /* Guarded, so the date maths above can be required under node:test. The
     unconditional attach this replaced is why none of it had coverage. */
  if (typeof window !== 'undefined' && typeof React !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.GanttStrip = React.memo(GanttStrip);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { dateRangeISO: dateRangeISO, isUsableRange: isUsableRange };
  }
})();
