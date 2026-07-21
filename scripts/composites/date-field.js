/* ==========================================================================
   FieldSight DateField — Layer 5 composite (fix/english-date-field)
   --------------------------------------------------------------------------
   Compact, English, theme-aware replacement for a native
   `<input type="date">`. Chrome's native date-picker POPUP (calendar grid
   + placeholder) renders in the OS locale and cannot be forced to English
   via HTML/CSS — `lang="en"` on the <input> only fixes the typed text, not
   the popup (see scripts/components/input.js's existing `lang` attempt).
   DateField sidesteps the native control entirely: a small trigger button
   showing the value in a fixed English format, opening an in-page popover
   that hosts DatePicker in `inline plain` mode (month grid + prev/next
   nav, no /api/dates density dots, no legend — see date-picker.js's
   `plain` prop doc).

   All date math is UTC-based (BUG-19: never `new Date('YYYY-MM-DD')` —
   parses as UTC internally but toString()/getMonth() etc. read it back in
   local time, drifting a day in NZDT). fmtDate below mirrors the exact
   idiom already used by reports.js / insights.js / library.js.

   Props:
     value       'YYYY-MM-DD' | '' | null — selected date
     onChange    (isoOrNull) => void — fired on cell click (a date) or
                 Clear (null)
     size        'sm' | 'md' | 'lg' (default 'md') — mirrors Input's sizes
     placeholder shown when value is empty (default 'Set date')
     disabled    true => trigger is inert, popover can't open

   Close-on-outside-click / Escape mirrors the existing WeatherIndicator
   popover pattern in app-shell.js (wrapRef + document 'mousedown' /
   'keydown' listeners, added only while open).

   Exported to:
     window.FieldSight.DateField
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];

  /* 'YYYY-MM-DD' -> '20 Jul 2026'. UTC-only parse (BUG-19 safe) — never
     new Date(iso). Malformed/empty input falls back to '' or the raw
     string rather than throwing. */
  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).split('-').map(Number);
    if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return String(iso);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCDate() + ' ' + MONTH_SHORT[d.getUTCMonth()] + ' ' + p[0];
  }

  function DateField(props) {
    var value       = props.value || null;
    var onChange    = props.onChange || function () {};
    var size        = props.size || 'md';
    var placeholder = props.placeholder || 'Set date';
    var disabled    = !!props.disabled;

    var refOpen = React.useState(false);
    var open    = refOpen[0];
    var setOpen = refOpen[1];

    var wrapRef = React.useRef(null);

    /* Close on outside click — mirrors app-shell.js's WeatherIndicator. */
    React.useEffect(function () {
      if (!open) return undefined;
      function onDocMouseDown(e) {
        if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
      }
      document.addEventListener('mousedown', onDocMouseDown);
      return function () { document.removeEventListener('mousedown', onDocMouseDown); };
    }, [open]);

    /* Close on Escape — same pattern. */
    React.useEffect(function () {
      if (!open) return undefined;
      function onKey(e) { if (e.key === 'Escape') setOpen(false); }
      document.addEventListener('keydown', onKey);
      return function () { document.removeEventListener('keydown', onKey); };
    }, [open]);

    function commit(iso) {
      onChange(iso);
      setOpen(false);
    }

    var DatePicker = window.FieldSight && window.FieldSight.DatePicker;
    var NavIcon     = window.FieldSight && window.FieldSight.NavIcon;

    /* BUG-19: todayNZDT() does its own UTC-safe "today" derivation — never
       new Date() here either. Only used to anchor the popover's visible
       month when no value is set yet. */
    var todayISO = (window.FS && window.FS.api && window.FS.api.todayNZDT)
      ? window.FS.api.todayNZDT() : null;
    var anchorDate = value || todayISO;

    return React.createElement('div', {
      ref:       wrapRef,
      className: 'fs-date-field fs-date-field--' + size + (disabled ? ' fs-date-field--disabled' : ''),
    },
      React.createElement('button', {
        type:      'button',
        className: 'fs-date-field__trigger',
        disabled:  disabled,
        onClick:   function () { setOpen(function (o) { return !o; }); },
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': value ? ('Due date, ' + fmtDate(value) + '. Click to change.') : placeholder,
      },
        NavIcon ? React.createElement(NavIcon, {
          name: 'calendar', size: size === 'sm' ? 14 : 16,
        }) : null,
        React.createElement('span', {
          className: 'fs-date-field__trigger-label'
            + (value ? '' : ' fs-date-field__trigger-label--placeholder'),
        }, value ? fmtDate(value) : placeholder),
      ),

      (open && !disabled && DatePicker) ? React.createElement('div', {
        className: 'fs-date-field__popover',
        role:      'dialog',
        'aria-label': 'Pick a date',
      },
        React.createElement(DatePicker, {
          inline:   true,
          plain:    true,
          date:     anchorDate,
          onChange: function (iso) { commit(iso); },
        }),
        React.createElement('div', { className: 'fs-date-field__popover-footer' },
          React.createElement('button', {
            type:      'button',
            className: 'fs-date-field__clear',
            disabled:  !value,
            onClick:   function () { commit(null); },
          }, 'Clear'),
        ),
      ) : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.DateField = DateField;
})();
