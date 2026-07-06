/* ==========================================================================
   FS.siteContext — global active-project context (batch A2, Task 1)
   --------------------------------------------------------------------------
   One selection scopes the data pages (Timeline/Safety/Quality/Tasks/
   Evidence/Activity). Strategic pages (Insights/Portfolio/Regional/
   Executive), Today, Team/Sites and Ask are exempt BY DESIGN — they and
   the shared aggregators must NEVER read this module internally; scoping
   is passed as an explicit opts.site parameter by scoped pages only.

   Mirrors the Set-subscriber pub/sub shape of actions-bus.js, backed by
   localStorage instead of an in-memory-only bus:

     window.FS.siteContext.get()        → current site id (string) or null
     window.FS.siteContext.set(siteId)  → persist + emit (null → clear)
     window.FS.siteContext.onChange(cb) → subscribe, returns unsubscribe fn

   Storage key `fs.settings.activeSite`, stored shape `{ site: '<site_id>' }`.

   One-time legacy adoption: the first time get() runs, if `activeSite` is
   absent but the earlier per-page key `fs.settings.timelineSite` (Sprint
   2.5/Batch A, see scripts/pages/timeline.js) already holds a value, that
   value is adopted into `activeSite` (written once) so upgrading users
   don't lose their last-picked project. The legacy key itself is left
   untouched — timeline.js still owns its read/write until Task 2 migrates
   it onto this module.
   ========================================================================== */

(function () {
  'use strict';

  var STORAGE_KEY = 'fs.settings.activeSite';
  var LEGACY_TIMELINE_SITE_KEY = 'fs.settings.timelineSite';

  var subscribers = new Set();
  var cache = null;
  var cached = false;

  function readLegacyTimelineSite() {
    try {
      var v = JSON.parse(localStorage.getItem(LEGACY_TIMELINE_SITE_KEY) || 'null');
      return (v && v.site) || null;
    } catch (_) { return null; }
  }

  function readStored() {
    try {
      var v = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return (v && v.site) || null;
    } catch (_) { return null; }
  }

  function persist(siteId) {
    try {
      if (siteId) localStorage.setItem(STORAGE_KEY, JSON.stringify({ site: siteId }));
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function emit(siteId) {
    subscribers.forEach(function (cb) {
      try { cb(siteId); }
      catch (e) { console.error('[siteContext]', e); }
    });
  }

  function get() {
    if (cached) return cache;
    cached = true;

    var stored = readStored();
    if (stored === null) {
      var legacy = readLegacyTimelineSite();
      if (legacy) {
        persist(legacy);
        stored = legacy;
      }
    }

    cache = stored;
    return cache;
  }

  function set(siteId) {
    var v = siteId || null;
    persist(v);
    cache = v;
    cached = true;
    emit(v);
  }

  function onChange(cb) {
    subscribers.add(cb);
    return function () { subscribers.delete(cb); };
  }

  if (!window.FS) window.FS = {};
  window.FS.siteContext = { get: get, set: set, onChange: onChange };

})();
