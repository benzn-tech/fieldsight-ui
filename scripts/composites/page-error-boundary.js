/* ==========================================================================
   FieldSight PageErrorBoundary — Layer 5 composite
   --------------------------------------------------------------------------
   Keeps one page's crash from being the whole app's crash.

   WHY THIS EXISTS

   On prod, clicking Programme produced a white screen with no way back. The
   throw itself was small — `GanttStrip` received a null date range for a site
   with no programme and called `null.split('-')`. What turned a broken panel
   into a dead application was that React 18 unmounts the ENTIRE tree when an
   error reaches the root uncaught, and there was no boundary anywhere in the
   codebase (`grep -rn "componentDidCatch|getDerivedStateFromError"` → zero
   hits). The navigation went with it, which is why the user could not leave
   the page: there was nothing left on screen to click.

   So this wraps the page content only. `LeftNav` is mounted OUTSIDE it in
   `app-shell.js` and stays alive by construction — the recovery path is the
   nav the user already knows, not a button this component invents.

   WHAT IT DELIBERATELY DOES NOT DO

   It does not retry, and it does not swallow. A boundary that silently
   re-rendered would loop on a deterministic render error, and one that showed
   nothing would turn a crash into a blank panel that looks like "no data" —
   the same class of lie as reporting 0 for a number you could not compute.
   It says the page failed, names the error, and leaves.

   It is also not a substitute for handling the bad state. The programme page
   now refuses to draw a Gantt without a usable date range; this is the net
   under that, for the next bug rather than this one.

   RESETTING

   `app-shell.js` gives it `key={route}`, so navigating anywhere remounts it
   with a clean state. Without that, a caught error would persist across
   navigation and every subsequent page would render the failure notice.

   Exported to:
     window.FieldSight.PageErrorBoundary   (browser)
     module.exports                        (node:test)
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function makeBoundary(ReactRef) {
    function PageErrorBoundary(props) {
      ReactRef.Component.call(this, props);
      this.state = { error: null };
    }

    PageErrorBoundary.prototype = Object.create(ReactRef.Component.prototype);
    PageErrorBoundary.prototype.constructor = PageErrorBoundary;

    PageErrorBoundary.getDerivedStateFromError = function (error) {
      return { error: error };
    };

    /* Logged, not reported anywhere: the app has no error-reporting sink and
       inventing one here would be a bigger decision than this file. The
       console is where the prod stack was actually found. */
    PageErrorBoundary.prototype.componentDidCatch = function (error, info) {
      if (window.console && window.console.error) {
        window.console.error('[FieldSight] page crashed:',
          (this.props && this.props.route) || '(unknown route)', error,
          info && info.componentStack);
      }
    };

    PageErrorBoundary.prototype.render = function () {
      if (!this.state.error) return this.props.children;

      var message = (this.state.error && this.state.error.message)
        ? String(this.state.error.message)
        : 'Unknown error';

      return ReactRef.createElement('div', {
        className: 'fs-page-error',
        role:      'alert',
        style:     { padding: '32px', maxWidth: '640px' },
      },
        ReactRef.createElement('h2', {
          style: { margin: '0 0 8px', font: 'var(--type-h2, 600 20px/1.3 Inter, sans-serif)',
                   color: 'var(--text-primary)' },
        }, 'This page could not be displayed'),
        ReactRef.createElement('p', {
          style: { margin: '0 0 16px', color: 'var(--text-secondary)' },
        }, 'Something went wrong rendering '
           + ((this.props && this.props.route) || 'this page')
           + '. The rest of the app is still working — use the menu on the left '
           + 'to go somewhere else.'),
        ReactRef.createElement('pre', {
          style: { margin: 0, padding: '12px', overflowX: 'auto',
                   background: 'var(--surface-sunken, #f1f5f9)',
                   color: 'var(--text-secondary)',
                   font: '12px/1.5 "JetBrains Mono", monospace',
                   borderRadius: '6px' },
        }, message),
      );
    };

    return PageErrorBoundary;
  }

  if (typeof window !== 'undefined' && typeof React !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.PageErrorBoundary = makeBoundary(React);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { makeBoundary: makeBoundary };
  }
})();
