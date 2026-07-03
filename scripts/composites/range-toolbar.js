/* ==========================================================================
   FieldSight RangeToolbar — Layer 5 composite (date-range batch — Task B)
   --------------------------------------------------------------------------
   Shared preset-chip toolbar for aggregate surfaces (Safety / Quality /
   Evidence / Insights) that need a {from, to} window instead of a single
   date. Sits on top of Task A's FS.api.window (getSpan/resolve) + the
   DatePicker's range mode.

   Controlled component: the caller owns `value` and re-renders with the
   next value on `onChange`. RangeToolbar itself only handles:
     - resolving a clicked preset chip into concrete {from, to} (sync via
       FS.api.window.resolve() for today/7d/30d, async via
       FS.api.window.getSpan() for 'all')
     - the 'Custom' chip's range-picker: DatePicker in range+inline mode,
       wrapped in our own ModalOverlay (DatePicker's own internal
       open/close plumbing is for its non-inline single surface; inline
       mode skips that entirely, so we own the modal lifecycle and close
       it ourselves once DatePicker's onRangeChange fires — which, per
       Task A, only fires once BOTH ends are picked, never after the
       first click)
     - persisting/restoring `{preset, from, to}` to localStorage[storageKey],
       tolerating the legacy safety/quality `{mode, day}` shape that
       predates this component

   Props:
     value       { preset, from, to } — currently active range
     onChange    (next) => void — next is { preset, from, to }
     presets     string[]? subset/order of
                 ['today','7d','30d','all','custom'] (default: all five)
     storageKey  string? localStorage key for persistence (omit to opt
                 out of persistence entirely)

   Exported to:
     window.FieldSight.RangeToolbar
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var DEFAULT_PRESETS = ['today', '7d', '30d', 'all', 'custom'];
  var PRESET_LABELS = {
    today:  'Today',
    '7d':   'Last 7 days',
    '30d':  'Last 30 days',
    all:    'All',
    custom: 'Custom',
  };

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  /* ---------- localStorage (tolerant of legacy safety/quality shape) --- */

  function loadStored(storageKey) {
    if (!storageKey) return null;
    try {
      var raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;

      /* Current RangeToolbar shape. */
      if (typeof v.preset === 'string') {
        return { preset: v.preset, from: v.from || null, to: v.to || null };
      }
      /* Legacy fs.settings.safetyView / qualityView shape (pre-Task B):
         { mode: 'week'|'today'|'day', day: 'YYYY-MM-DD' }. */
      if (typeof v.mode === 'string') {
        if (v.mode === 'week')  return { preset: '7d',    from: null,   to: null };
        if (v.mode === 'today') return { preset: 'today', from: null,   to: null };
        if (v.mode === 'day' && v.day) return { preset: 'custom', from: v.day, to: v.day };
      }
    } catch (_) {}
    return null;
  }

  function saveStored(storageKey, value) {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        preset: value.preset, from: value.from || null, to: value.to || null,
      }));
    } catch (_) {}
  }

  /* ---------- Chip — its own component (hover needs its own hook; per
     CLAUDE.md, sub-components with hooks must render via
     React.createElement, never be called inline) ----------------------- */

  function Chip(props) {
    var refHover = React.useState(false);
    var hover    = refHover[0];
    var setHover = refHover[1];
    var active   = props.active;

    var style = {
      display:      'inline-flex',
      alignItems:   'center',
      gap:          '6px',
      padding:      '6px 10px',
      font:         'inherit',
      fontSize:     '12px',
      border:       '1px solid ' + (active ? 'var(--color-accent-400)' : 'var(--border-subtle)'),
      background:   active ? 'var(--surface-selected)'
                    : (hover ? 'var(--surface-panel-muted)' : 'var(--surface-panel)'),
      borderRadius: 'var(--radius-full)',
      cursor:       'pointer',
      color:        active ? 'var(--text-primary)' : 'var(--text-secondary)',
      transition:   'background var(--duration-fast) var(--ease-out), '
                   + 'border-color var(--duration-fast) var(--ease-out)',
    };

    return React.createElement('button', {
      type:           'button',
      style:          style,
      onClick:        props.onClick,
      onMouseEnter:   function () { setHover(true); },
      onMouseLeave:   function () { setHover(false); },
      'aria-pressed': active,
    }, props.children);
  }

  /* ---------- RangeToolbar root ----------------------------------------- */

  function RangeToolbar(props) {
    var value      = props.value || { preset: 'today', from: null, to: null };
    var onChange   = props.onChange || function () {};
    var presets    = props.presets || DEFAULT_PRESETS;
    var storageKey = props.storageKey || null;

    var refOpen = React.useState(false);
    var open    = refOpen[0];
    var setOpen = refOpen[1];

    /* Draft range while the custom-picker modal is open, kept separate
       from `value` — an abandoned pick (modal closed via backdrop/Escape
       before both ends are chosen) must never commit a half-formed
       range. */
    var refDraft = React.useState({ from: null, to: null });
    var draft    = refDraft[0];
    var setDraft = refDraft[1];

    /* ModalOverlay keeps its children always-mounted (only visually
       hidden while closed — see its own file header), so DatePicker's
       *internal* range-selection state (an abandoned first click, before
       onRangeChange ever fires) would otherwise survive a close/reopen
       and could get silently paired with a later, unrelated click.
       Bumping this key on every open forces a clean remount so each
       custom-picker session starts from `draft` with no leftover
       in-progress selection. */
    var refPickerKey = React.useState(0);
    var pickerKey     = refPickerKey[0];
    var setPickerKey  = refPickerKey[1];

    var restoredRef = React.useRef(false);

    function commit(next) {
      onChange(next);
      saveStored(storageKey, next);
    }

    function resolvePreset(preset) {
      if (preset === 'all') {
        window.FS.api.window.getSpan().then(function (span) {
          commit({ preset: 'all', from: span.earliest, to: span.latest });
        }).catch(function () {
          commit({ preset: 'all', from: null, to: null });
        });
        return;
      }
      var r = window.FS.api.window.resolve(preset, null, {});
      commit({ preset: preset, from: r.from, to: r.to });
    }

    /* On mount: resolve whichever value should be active — a persisted
       preference if one exists (tolerating the legacy shape), otherwise
       the caller's initial `value` (pages hand RangeToolbar an
       unresolved default like {preset:'all', from:null, to:null} since
       resolving 'all' needs the async span). Either way this is the
       one place from/to get populated for the very first render. */
    React.useEffect(function () {
      if (restoredRef.current) return;
      restoredRef.current = true;
      var stored  = loadStored(storageKey);
      var initial = stored || value;
      if (initial.preset === 'custom' && initial.from && initial.to) {
        commit({ preset: 'custom', from: initial.from, to: initial.to });
      } else if (initial.preset && initial.preset !== 'custom') {
        resolvePreset(initial.preset);
      } else {
        resolvePreset('today');
      }
      // Mount-only: intentionally ignores `value`/`storageKey` churn after
      // the first render — this effect exists purely to seed the initial
      // range once.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function onChipClick(preset) {
      if (preset === 'custom') {
        setDraft({
          from: value.preset === 'custom' ? value.from : null,
          to:   value.preset === 'custom' ? value.to   : null,
        });
        setPickerKey(function (n) { return n + 1; });
        setOpen(true);
        return;
      }
      resolvePreset(preset);
    }

    function onRangeChange(from, to) {
      commit({ preset: 'custom', from: from, to: to });
      setOpen(false);
    }

    var chips = presets.map(function (p) {
      var active = value.preset === p;
      var label  = PRESET_LABELS[p] || p;
      if (p === 'custom' && active && value.from) {
        label = value.from === value.to
          ? fmtDate(value.from)
          : fmtDate(value.from) + ' → ' + fmtDate(value.to);
      }
      return React.createElement(Chip, {
        key: p, active: active, onClick: function () { onChipClick(p); },
      }, label);
    });

    var DatePicker   = window.FieldSight.DatePicker;
    var ModalOverlay = window.FieldSight.ModalOverlay;

    return React.createElement('div', { className: 'fs-range-toolbar' },
      React.createElement('div', {
        style: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
        role:  'group', 'aria-label': 'Date range',
      }, chips),

      (ModalOverlay && DatePicker)
        ? React.createElement(ModalOverlay, {
            open:    open,
            onClose: function () { setOpen(false); },
            title:   'Pick a date range',
            size:    'md',
          },
            React.createElement(DatePicker, {
              key:           'range-picker-' + pickerKey,
              range:         true,
              inline:        true,
              from:          draft.from,
              to:            draft.to,
              onRangeChange: onRangeChange,
            }),
          )
        : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.RangeToolbar = RangeToolbar;
})();
