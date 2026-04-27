/* ==========================================================================
   FieldSight Router — hash-based, no build step
   window.FS.Router
   ========================================================================== */

(function () {
  'use strict';

  const subscribers = new Set();

  /** Parse location.hash into { path, params } */
  function parse() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const path = '/' + (pathPart || '').replace(/^\//, '');
    const params = {};
    if (queryPart) {
      queryPart.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
    }
    return { path, params };
  }

  function notify() {
    const route = parse();
    subscribers.forEach(cb => { try { cb(route); } catch (e) { console.error('[Router]', e); } });
  }

  window.addEventListener('hashchange', notify);

  const Router = {
    /** @returns {{ path: string, params: Record<string,string> }} */
    getCurrentRoute() { return parse(); },

    /** Navigate to a path (e.g. '/today') */
    navigate(path) {
      const next = '#' + path;
      if (location.hash !== next) {
        location.hash = next;
      } else {
        // Same route — still notify so components can refresh
        notify();
      }
    },

    /** Subscribe to route changes. Callback called immediately with current route. */
    subscribe(callback) {
      subscribers.add(callback);
      callback(parse());           // emit current route immediately
      return () => subscribers.delete(callback);
    },

    /** Unsubscribe */
    unsubscribe(callback) { subscribers.delete(callback); },
  };

  // Attach to window.FS (may be extended later)
  if (!window.FS) window.FS = {};
  window.FS.Router = Router;

})();
