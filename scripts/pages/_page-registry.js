/* ==========================================================================
   FieldSight Page Registry — route → { Provider, Middle, Right, Footer }
   --------------------------------------------------------------------------
   Each page module attaches itself to window.FieldSight.PAGES.<key>
   AFTER this registry loads. The registry just defines the mapping.

   Footer is optional: a route with none renders nothing there (spec
   2026-09-16 §3 — the docked Ask lives here for /timeline).

   Exported to:
     window.FieldSight.getPageForRoute(routePath) → { Provider, Middle, Right, Footer } | null
   ========================================================================== */

(function () {
  'use strict';

  /* Pages register themselves via this object after load */
  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};

  /* Resolve a route to { Provider, Middle, Right, Footer } components */
  function getPageForRoute(routePath) {
    var pages = window.FieldSight.PAGES || {};
    /* Direct match */
    if (pages[routePath]) return pages[routePath];
    /* No match — fall through to placeholder */
    return null;
  }

  window.FieldSight.getPageForRoute = getPageForRoute;
})();
