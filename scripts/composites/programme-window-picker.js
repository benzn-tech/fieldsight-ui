/* ==========================================================================
   FieldSight ProgrammeWindowPicker — the time-range control
   --------------------------------------------------------------------------
   The window is the programme page's LOAD boundary, not a filter over an
   already-loaded programme (spec §7), so changing it here re-fetches rather
   than re-filters. The component is deliberately dumb about that: it reports
   the chosen preset and the page decides what to do with it.

   The chosen preset lives in the user's server-side prefs, not localStorage,
   so it follows someone from the office desktop to the site tablet. That
   makes reading it the fragile part — it has to survive a caller with no
   prefs, a prefs blob written by surfaces that have never heard of this one,
   and a stored key that no longer matches any preset after a release.

   Writing sends ONE key. Sending the whole prefs object back would clobber
   every other surface's settings with whatever this page happened to be
   holding; the server merges with `prefs || %s`.

   readWindowPref / windowPrefPatch are pure so they can be tested under Node.

   Exported to:
     window.FieldSight.ProgrammeWindowPicker   (browser)
     module.exports                            (node:test)
   ========================================================================== */

(function () {
  'use strict';

  var PREF_KEY = 'programmeWindow';

  function windowApi() {
    if (typeof window !== 'undefined' && window.FS && window.FS.api
        && window.FS.api.programmeWindow) {
      return window.FS.api.programmeWindow;
    }
    /* Node (tests) — the module is a sibling on disk. */
    return require('../api/programme-window.js');
  }

  /* The caller's chosen preset, or the default. Never throws and never
     returns undefined: a stored value outlives the release that produced it,
     and an undefined here would break the next page load with no way for the
     user to clear it. */
  function readWindowPref(me) {
    var pw = windowApi();
    var raw = me && me.prefs ? me.prefs[PREF_KEY] : null;
    if (typeof raw !== 'string') return pw.presetByKey(pw.DEFAULT_PRESET_KEY);
    return pw.presetByKey(raw);   /* falls back internally when unrecognised */
  }

  /* PATCH /me body. Normalises before storing, so an unrecognised value is
     never persisted for the next reader to cope with. */
  function windowPrefPatch(presetOrKey) {
    var pw = windowApi();
    var key = (presetOrKey && typeof presetOrKey === 'object')
      ? presetOrKey.key : presetOrKey;
    var patch = {};
    patch[PREF_KEY] = pw.presetByKey(key).key;
    return { prefs: patch };
  }

  /* ---- component ------------------------------------------------------- */

  function ProgrammeWindowPicker(props) {
    var pw = windowApi();
    var current = props.preset || pw.presetByKey(pw.DEFAULT_PRESET_KEY);
    var onChange = props.onChange || function () {};
    var disabled = !!props.disabled;

    var win = props.today ? pw.resolveWindow(current, props.today) : null;

    return React.createElement('div', { className: 'fs-prog-window' },
      React.createElement('label', {
        className: 'fs-prog-window__label',
        htmlFor: 'fs-prog-window-select',
      }, 'Range'),
      React.createElement('select', {
        id: 'fs-prog-window-select',
        className: 'fs-prog-window__select',
        value: current.key,
        disabled: disabled,
        'aria-label': 'Programme time range',
        onChange: function (e) { onChange(pw.presetByKey(e.target.value)); },
      }, pw.PRESETS.map(function (p) {
        return React.createElement('option', { key: p.key, value: p.key }, p.label);
      })),
      /* The resolved dates, so it is obvious the range is anchored on today
         rather than on the programme's own start. */
      win
        ? React.createElement('span', { className: 'fs-prog-window__dates' },
            win.from + ' → ' + win.to)
        : null,
    );
  }

  var api = {
    ProgrammeWindowPicker: ProgrammeWindowPicker,
    readWindowPref:        readWindowPref,
    windowPrefPatch:       windowPrefPatch,
    PREF_KEY:              PREF_KEY,
  };

  if (typeof window !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.ProgrammeWindowPicker = ProgrammeWindowPicker;
    window.FieldSight.programmeWindowPref = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
