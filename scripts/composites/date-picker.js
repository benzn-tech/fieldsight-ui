/* ==========================================================================
   FieldSight DatePicker — Layer 5 composite (Sprint 2.5 / PLAN Phase E)
   --------------------------------------------------------------------------
   Heat-mapped date picker for the Timeline page. Two surfaces:

     [Strip]   compact 7-day window centred on the selected date, each
               cell shows a topic-density dot and a safety-flag dot.
               Click to navigate.

     [Modal]   full-month grid behind a popover, opened from the
               "More dates" button. Same per-day glyphs, plus headings.
               Close on outside click, Escape, or after navigation.

   Heat-map intensity buckets (BACKEND-CONTEXT §4.3):
       0          → no report
       1–5 topics → low
       6–10       → medium
       11+        → high
       safety > 0 → orange dot overlay

   All date math runs through FS.api.addDaysISO (UTC arithmetic) to dodge
   BUG-19 (NZDT off-by-one when calling new Date('YYYY-MM-DD').toISO()).

   Props:
     date        'YYYY-MM-DD' selected date
     onChange    (yyyymmdd) => void
     monthsRange optional months parameter for /api/dates
                 (default FS.api.window.MONTHS_LOOKBACK, fallback 24)
     site        optional site filter for /api/dates

     Range mode (date-range batch — Task A) — backward compatible, opt-in:
     range          true => range-selection mode (MonthGrid click-click:
                    first click sets `from`, second sets `to`; a click
                    before `from` restarts the selection; same-day
                    ranges are allowed)
     from           'YYYY-MM-DD' range start (range mode)
     to             'YYYY-MM-DD' range end (range mode)
     onRangeChange  (from, to) => void — fired only once BOTH ends are
                    chosen (not after the first click)

   Exported to:
     window.FieldSight.DatePicker
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var DAY_NAMES_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var DAY_NAMES_HDR   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']; /* NZ-style header */
  var MONTH_NAMES     = ['January','February','March','April','May','June',
                         'July','August','September','October','November','December'];
  var MONTH_SHORT     = ['Jan','Feb','Mar','Apr','May','Jun',
                         'Jul','Aug','Sep','Oct','Nov','Dec'];

  function parseISO(yyyymmdd) {
    if (!yyyymmdd) return null;
    var p = yyyymmdd.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  function toISO(d) {
    return d.toISOString().slice(0, 10);
  }

  function shift(yyyymmdd, days) {
    return window.FS.api.addDaysISO(yyyymmdd, days);
  }

  function intensity(meta) {
    if (!meta || !meta.hasReport) return 0;
    var t = meta.topics || 0;
    if (t >= 11) return 3;
    if (t >= 6)  return 2;
    if (t >= 1)  return 1;
    return 0;
  }

  /* Day-cell glyph used by both surfaces. */
  function DayCell(props) {
    var iso  = props.iso;
    var meta = props.meta || null;
    var label = props.label;          /* e.g. '29' for grid, 'Wed 29' for strip */
    var caption = props.caption;       /* e.g. 'Apr' under strip cells */
    var selected = props.selected;
    var inRange  = props.inRange;      /* range mode: strictly between from/to */
    var muted    = props.muted;        /* for prev/next-month bleed in grid */
    var disabled = props.disabled;     /* future dates if you want to lock — not used yet */

    var i  = intensity(meta);
    var hasSafety = meta && meta.hasReport && (meta.safety || 0) > 0;

    var className = 'fs-date-picker__cell'
      + ' fs-date-picker__cell--i' + i
      + (selected ? ' fs-date-picker__cell--selected' : '')
      + (muted    ? ' fs-date-picker__cell--muted'    : '')
      + (props.variant === 'strip' ? ' fs-date-picker__cell--strip' : ' fs-date-picker__cell--grid');

    /* In-range days (strictly between the two chosen endpoints) get a
       light --surface-selected fill. Endpoints reuse the existing
       --selected class above instead — this is only for the days
       between them, so it stays visually subordinate. */
    var style = (inRange && !selected)
      ? { background: 'color-mix(in srgb, var(--surface-selected) 30%, transparent)' }
      : undefined;

    return React.createElement('button', {
      type:      'button',
      className: className,
      style:     style,
      disabled:  disabled,
      onClick:   function () { if (props.onSelect) props.onSelect(iso); },
      'aria-label': iso + (meta && meta.hasReport
        ? ', ' + meta.topics + ' topics' + (hasSafety ? ', ' + meta.safety + ' safety' : '')
        : ', no report'),
      'aria-pressed': selected,
    },
      React.createElement('span', { className: 'fs-date-picker__cell-label' }, label),
      caption ? React.createElement('span', {
        className: 'fs-date-picker__cell-caption',
      }, caption) : null,
      React.createElement('span', { className: 'fs-date-picker__cell-dots' },
        i > 0 ? React.createElement('span', {
          className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--i' + i,
        }) : null,
        hasSafety ? React.createElement('span', {
          className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--safety',
        }) : null,
      ),
    );
  }

  /* ---------- Compact 7-day strip ---------------------------------------- */
  function DateStrip(props) {
    var date  = props.date;
    var dates = props.dates || {};
    var d = parseISO(date);
    if (!d) return null;

    var cells = [];
    /* Show -3..+3 days. */
    for (var off = -3; off <= 3; off++) {
      var iso = shift(date, off);
      var meta = dates[iso];
      var dt = parseISO(iso);
      var dayName = DAY_NAMES_SHORT[dt.getUTCDay()];
      var dayNum  = dt.getUTCDate();

      cells.push(React.createElement(DayCell, {
        key:      iso,
        iso:      iso,
        meta:     meta,
        label:    dayName + ' ' + dayNum,
        caption:  MONTH_SHORT[dt.getUTCMonth()],
        selected: iso === date,
        variant:  'strip',
        onSelect: props.onChange,
      }));
    }

    return React.createElement('div', { className: 'fs-date-picker__strip' },
      React.createElement('button', {
        type:      'button',
        className: 'fs-date-picker__nudge',
        'aria-label': 'Previous day',
        onClick:   function () { props.onChange(shift(date, -1)); },
      }, '‹'),
      React.createElement('div', { className: 'fs-date-picker__strip-cells' },
        cells,
      ),
      React.createElement('button', {
        type:      'button',
        className: 'fs-date-picker__nudge',
        'aria-label': 'Next day',
        onClick:   function () { props.onChange(shift(date, 1)); },
      }, '›'),
    );
  }

  /* ---------- Month grid (modal body) ----------------------------------- */
  function MonthGrid(props) {
    var date  = props.date;
    var month = props.month;          /* { year, month0 } visible month */
    var dates = props.dates || {};

    /* Range mode (opt-in, backward compatible — props.range is undefined
       for every existing single-date caller, so this whole block is a
       no-op for them). */
    var range     = !!props.range;
    var rangeFrom = props.rangeFrom || null;
    var rangeTo   = props.rangeTo   || null;

    /* First day of the visible month, shifted to a Monday-start week. */
    var firstOfMonth = new Date(Date.UTC(month.year, month.month0, 1));
    var dayIdxMonStart = (firstOfMonth.getUTCDay() + 6) % 7; /* Mon=0..Sun=6 */
    var gridStart = new Date(Date.UTC(month.year, month.month0, 1 - dayIdxMonStart));

    var cells = [];
    for (var i = 0; i < 42; i++) {
      var d = new Date(gridStart);
      d.setUTCDate(gridStart.getUTCDate() + i);
      var iso = toISO(d);
      var inMonth = d.getUTCMonth() === month.month0;
      var meta = dates[iso];

      var selected = range
        ? (iso === rangeFrom || iso === rangeTo)
        : (iso === date);
      var inRange = range && !!rangeFrom && !!rangeTo && iso > rangeFrom && iso < rangeTo;

      cells.push(React.createElement(DayCell, {
        key:      iso,
        iso:      iso,
        meta:     meta,
        label:    String(d.getUTCDate()),
        selected: selected,
        inRange:  inRange,
        muted:    !inMonth,
        variant:  'grid',
        onSelect: range ? props.onRangeSelect : props.onSelect,
      }));
    }

    return React.createElement('div', { className: 'fs-date-picker__grid' },
      DAY_NAMES_HDR.map(function (n) {
        return React.createElement('div', {
          key: n, className: 'fs-date-picker__grid-hdr',
        }, n);
      }),
      cells,
    );
  }

  /* ---------- DatePicker root ------------------------------------------- */
  function DatePicker(props) {
    var date = props.date;
    var isRange = !!props.range;
    var monthsRange = props.monthsRange
      || (window.FS.api.window && window.FS.api.window.MONTHS_LOOKBACK)
      || 24;
    var site = props.site || null;

    var refDates = React.useState({ status: 'loading', map: {} });
    var datesS    = refDates[0];
    var setDatesS = refDates[1];

    var refOpen = React.useState(false);
    var open    = refOpen[0];
    var setOpen = refOpen[1];

    /* Range-selection state (Task A). Mirrors the controlled from/to
       props but also tracks an in-progress (from-only) click that
       hasn't been reported to the parent yet — onRangeChange only
       fires once both ends are chosen, so this local state is the only
       place a lone first click lives. */
    var refRange = React.useState({ from: props.from || null, to: props.to || null });
    var rangeSel    = refRange[0];
    var setRangeSel = refRange[1];

    React.useEffect(function () {
      if (!isRange) return;
      setRangeSel({ from: props.from || null, to: props.to || null });
    }, [isRange, props.from, props.to]);

    /* Visible month for the modal — driven by selected date but
       independent so prev/next nav works inside the modal. */
    var initial = parseISO(isRange ? (props.from || rangeSel.from) : date) || new Date();
    var refMonth = React.useState({
      year: initial.getUTCFullYear(), month0: initial.getUTCMonth(),
    });
    var month    = refMonth[0];
    var setMonth = refMonth[1];

    React.useEffect(function () {
      var cancelled = false;
      window.FS.api.dates.getDates({ months: monthsRange, site: site }).then(function (res) {
        if (cancelled) return;
        setDatesS({ status: 'ok', map: res.dates || {} });
      }).catch(function () {
        if (cancelled) return;
        setDatesS({ status: 'error', map: {} });
      });
      return function () { cancelled = true; };
    }, [monthsRange, site]);

    /* When the selected date (or, in range mode, the range start)
       changes externally, follow it in the modal. */
    React.useEffect(function () {
      var anchor = isRange ? props.from : date;
      var d = parseISO(anchor);
      if (!d) return;
      setMonth({ year: d.getUTCFullYear(), month0: d.getUTCMonth() });
    }, [isRange, date, props.from]);

    React.useEffect(function () {
      if (!open) return;
      function onKey(e) { if (e.key === 'Escape') setOpen(false); }
      document.addEventListener('keydown', onKey);
      return function () { document.removeEventListener('keydown', onKey); };
    }, [open]);

    function onSelect(iso) {
      props.onChange(iso);
      setOpen(false);
    }

    /* Range click-click: first click sets `from`; second click sets
       `to` and fires onRangeChange; a click before `from` (or a click
       once a full range is already selected) restarts the selection.
       Same-day ranges are allowed. */
    function onRangeSelect(iso) {
      setRangeSel(function (prev) {
        var next;
        if (!prev.from || (prev.from && prev.to) || iso < prev.from) {
          next = { from: iso, to: null };
        } else {
          next = { from: prev.from, to: iso };
        }
        if (next.from && next.to) {
          if (props.onRangeChange) props.onRangeChange(next.from, next.to);
          setOpen(false);
        }
        return next;
      });
    }

    function shiftMonth(delta) {
      setMonth(function (m) {
        var d = new Date(Date.UTC(m.year, m.month0 + delta, 1));
        return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
      });
    }

    /* Inline mode (Sprint 6.6.1) — skips the 7-day strip and renders
       just the month grid + month-nav header inline, not as a modal.
       Used by /safety and /quality where the goal is "browse and pick"
       (commit only on cell click). The default mode keeps timeline.js's
       "step-through" UX (strip arrows shift AND commit by ±1 day). */
    if (props.inline) {
      return React.createElement('div', {
        className: 'fs-date-picker fs-date-picker--inline',
      },
        React.createElement('div', { className: 'fs-date-picker__inline-header' },
          React.createElement('button', {
            type: 'button', onClick: function () { shiftMonth(-1); },
            className: 'fs-date-picker__month-nav',
            'aria-label': 'Previous month',
          }, '‹'),
          React.createElement('div', { className: 'fs-date-picker__month-label' },
            MONTH_NAMES[month.month0] + ' ' + month.year),
          React.createElement('button', {
            type: 'button', onClick: function () { shiftMonth(1); },
            className: 'fs-date-picker__month-nav',
            'aria-label': 'Next month',
          }, '›'),
        ),
        React.createElement(MonthGrid, {
          date:     date,
          month:    month,
          dates:    datesS.map,
          range:      isRange,
          rangeFrom:  rangeSel.from,
          rangeTo:    rangeSel.to,
          onSelect:      function (iso) { props.onChange(iso); },
          onRangeSelect: onRangeSelect,
        }),
        React.createElement('div', { className: 'fs-date-picker__legend' },
          React.createElement('span', null,
            React.createElement('span', { className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--i1' }), ' light'),
          React.createElement('span', null,
            React.createElement('span', { className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--i2' }), ' busy'),
          React.createElement('span', null,
            React.createElement('span', { className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--i3' }), ' heavy'),
          React.createElement('span', null,
            React.createElement('span', { className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--safety' }), ' safety'),
        ),
      );
    }

    return React.createElement('div', { className: 'fs-date-picker' },
      isRange ? null : React.createElement(DateStrip, {
        date:  date,
        dates: datesS.map,
        onChange: props.onChange,
      }),

      React.createElement('button', {
        type:      'button',
        className: 'fs-date-picker__more',
        onClick:   function () { setOpen(function (o) { return !o; }); },
        'aria-expanded': open,
      }, open ? 'Close' : 'Browse month'),

      open ? React.createElement('div', {
        className: 'fs-date-picker__modal',
        role:      'dialog',
        'aria-label': 'Pick a date',
      },
        React.createElement('div', { className: 'fs-date-picker__modal-overlay',
          onClick: function () { setOpen(false); },
        }),
        React.createElement('div', { className: 'fs-date-picker__modal-card' },
          React.createElement('div', { className: 'fs-date-picker__modal-header' },
            React.createElement('button', {
              type: 'button', onClick: function () { shiftMonth(-1); },
              className: 'fs-date-picker__month-nav',
              'aria-label': 'Previous month',
            }, '‹'),
            React.createElement('div', { className: 'fs-date-picker__month-label' },
              MONTH_NAMES[month.month0] + ' ' + month.year),
            React.createElement('button', {
              type: 'button', onClick: function () { shiftMonth(1); },
              className: 'fs-date-picker__month-nav',
              'aria-label': 'Next month',
            }, '›'),
          ),
          React.createElement(MonthGrid, {
            date:     date,
            month:    month,
            dates:    datesS.map,
            range:      isRange,
            rangeFrom:  rangeSel.from,
            rangeTo:    rangeSel.to,
            onSelect:      onSelect,
            onRangeSelect: onRangeSelect,
          }),
          React.createElement('div', { className: 'fs-date-picker__legend' },
            React.createElement('span', null,
              React.createElement('span', { className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--i1' }), ' light'),
            React.createElement('span', null,
              React.createElement('span', { className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--i2' }), ' busy'),
            React.createElement('span', null,
              React.createElement('span', { className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--i3' }), ' heavy'),
            React.createElement('span', null,
              React.createElement('span', { className: 'fs-date-picker__cell-dot fs-date-picker__cell-dot--safety' }), ' safety'),
          ),
        ),
      ) : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.DatePicker = DatePicker;
})();
