/* ==========================================================================
   FieldSight · waking-notice — "the backend is coming back, not broken"
   --------------------------------------------------------------------------
   Aurora is configured to pause when idle (MinCapacity 0,
   SecondsUntilAutoPause 600). A resume after a long pause can outlast API
   Gateway's 29 s ceiling, so the first request of a quiet Monday morning can
   fail while nothing at all is wrong. `scripts/api/_fetch.js` already retries
   3x on a 1s/2s/4s ladder, which usually covers a resume on its own; this
   module is what the person sees when it does not.

   It deliberately says nothing a reader has to act on and shows no status
   code: "504" tells a site manager to call someone. One line of plain
   language, and it retracts itself the moment any request answers.

   Contract with _fetch.js: it looks for `window.FS.wakingNotice` with BOTH
   `show()` and `hide()`, calls them inside try/catch, and works fine when
   this file is not loaded at all (previews, node). So nothing here may throw
   and nothing here may assume a framework -- no React, no build step.

   show() is idempotent: a page that fires six parallel reads through
   FS.api.pooledAll would otherwise stack six bars.
   ========================================================================== */

(function () {
  'use strict';

  var ID = 'fs-waking-notice';
  var TEXT = 'Waking the service up — the first visit after a quiet spell ' +
             'takes a little longer. This will clear on its own.';

  function doc() {
    return (typeof document !== 'undefined' && document.body) ? document : null;
  }

  function show() {
    var d = doc();
    if (!d || d.getElementById(ID)) return;

    var bar = d.createElement('div');
    bar.id = ID;
    bar.setAttribute('role', 'status');
    /* polite, not assertive: this is not an error and must not interrupt a
       screen-reader user mid-sentence (ACCESSIBILITY.md, live regions). */
    bar.setAttribute('aria-live', 'polite');

    /* Inline styles rather than a tokens.css rule: this element exists for a
       few seconds on a page whose stylesheet may itself still be loading, and
       an unstyled full-width bar is worse than none. Colours are the token
       VALUES, mirrored deliberately -- see the token-sync note in CLAUDE.md. */
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:9999',
      'padding:12px 16px', 'font-size:14px', 'line-height:1.4',
      'text-align:center', 'background:#1f2933', 'color:#f5f7fa',
      'box-shadow:0 -2px 8px rgba(0,0,0,0.18)',
    ].join(';');
    bar.textContent = TEXT;

    d.body.appendChild(bar);
  }

  function hide() {
    var d = doc();
    if (!d) return;
    var bar = d.getElementById(ID);
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  function isShown() {
    var d = doc();
    return !!(d && d.getElementById(ID));
  }

  if (!window.FS) window.FS = {};
  window.FS.wakingNotice = { show: show, hide: hide, isShown: isShown, ID: ID, TEXT: TEXT };
}());
