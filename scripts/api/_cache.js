/* ==========================================================================
   FieldSight API · _cache — module-level TTL read-cache
   --------------------------------------------------------------------------
   A tiny get-or-fetch cache for SESSION-STABLE reads only (reports, the
   date index, the report span) — data that's generated server-side and not
   edited in-app during a session. Never wrap mutable/write calls with this.

   window.FS.api.cache.cached(key, ttlMs, fetchFn)
     Returns a Promise resolving to fetchFn()'s resolved value. Repeat calls
     with the same key inside `ttlMs` (default 3 min) return the cached
     value without invoking fetchFn again. Concurrent calls with the same
     key while a fetch is in flight share the SAME promise (coalesced) —
     a fan-out that requests the same key twice makes one network call.
     A rejected fetch is never cached (the next call retries).

   window.FS.api.cache.clear()
     Drops all cached values and in-flight promises. Not wired to any UI
     yet — available for future "force refresh" affordances / tests.
   ========================================================================== */

(function () {
  'use strict';

  var store = {};              // key -> { at: <ms>, value: <resolved> }
  var inflight = {};           // key -> Promise (dedupe concurrent identical fetches)
  var DEFAULT_TTL = 180000;    // 3 min

  function cached(key, ttlMs, fetchFn) {
    var ttl = (typeof ttlMs === 'number') ? ttlMs : DEFAULT_TTL;
    var now = Date.now();
    var hit = store[key];
    if (hit && (now - hit.at) < ttl) return Promise.resolve(hit.value);
    if (inflight[key]) return inflight[key];           // coalesce parallel callers
    var p = Promise.resolve(fetchFn()).then(function (v) {
      store[key] = { at: Date.now(), value: v };
      delete inflight[key];
      return v;
    }).catch(function (e) {
      delete inflight[key];                            // never cache a rejection
      throw e;
    });
    inflight[key] = p;
    return p;
  }
  function clear() { store = {}; inflight = {}; }

  window.FS = window.FS || {}; window.FS.api = window.FS.api || {};
  window.FS.api.cache = { cached: cached, clear: clear };
})();
