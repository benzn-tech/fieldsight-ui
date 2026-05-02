/* ==========================================================================
   FieldSight ModalOverlay — Layer 5 composite (Sprint 5.0 / 5.7.1)
   --------------------------------------------------------------------------
   Centred modal primitive used by Programme task editor (5.1) and import
   modal (5.4). Architecturally a sibling of `RightDrawer`: same backdrop +
   ESC + always-mounted-while-open pattern, but the panel sits centred
   in the viewport instead of pinned to the right edge.

   Why a separate primitive (not a RightDrawer variant): drawers are for
   resident detail panels that benefit from coexisting with the page;
   modals are transient, blocking, focus-stealing surfaces that exit
   through OK/Cancel. Different lifetime, different layering (modals
   above drawers via --z-modal=500 vs drawer's z=50).

   Sprint 5.7.1 — uses `ReactDOM.createPortal` to mount at document.body.
   Without the portal, when the editor is mounted from inside RightDrawer
   (which has `overflow: hidden` + `transform: translateX(...)` creating
   its own stacking context), the modal got clipped to the drawer's
   bounds AND its z-index was scoped relative to the drawer — making
   the centred panel render off-centre and partially hidden. Portaling
   to the body lifts the entire modal subtree out of every parent
   stacking context, restoring true viewport-centred positioning and
   correct z-layer ordering against the drawer.

   Props:
     open              boolean
     onClose           () => void
     title             string?    — rendered in the modal header (h2)
     ariaLabel         string?    — fallback when title isn't set
     size              'sm'|'md'|'lg' (default 'md')
     closeOnBackdrop   boolean (default true) — set false for forms with
                        unsaved input (5.1 editor passes false)
     children          modal body content

   Exported to:
     window.FieldSight.ModalOverlay
   ========================================================================== */

/* global React, ReactDOM, window, document */

(function () {
  'use strict';

  function ModalOverlay(props) {
    var open    = !!props.open;
    var onClose = props.onClose || function () {};
    var title   = props.title || null;
    var size    = props.size || 'md';
    var closeOnBackdrop = props.closeOnBackdrop !== false;

    React.useEffect(function () {
      if (!open) return undefined;
      function onKey(e) {
        if (e.key === 'Escape') {
          /* stopPropagation: a Programme RightDrawer may also be open
             behind us — without this both layers would react to the
             same Escape and double-close the user out of context. */
          e.stopPropagation();
          onClose();
        }
      }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, [open, onClose]);

    var titleId = React.useMemo(function () {
      return 'fs-modal-title-' + Math.random().toString(36).slice(2, 8);
    }, []);

    function onBackdropClick() {
      if (closeOnBackdrop) onClose();
    }

    var tree = React.createElement(React.Fragment, null,
      React.createElement('div', {
        className:     'fs-modal__backdrop' + (open ? ' fs-modal__backdrop--open' : ''),
        onClick:       onBackdropClick,
        'aria-hidden': !open,
      }),
      React.createElement('div', {
        className:           'fs-modal' + (open ? ' fs-modal--open' : '') + ' fs-modal--' + size,
        role:                'dialog',
        'aria-modal':        true,
        'aria-labelledby':   title ? titleId : undefined,
        'aria-label':        !title ? (props.ariaLabel || 'Dialog') : undefined,
        'aria-hidden':       !open,
        onClick: function (e) { e.stopPropagation(); },
      },
        title
          ? React.createElement('header', { className: 'fs-modal__header' },
              React.createElement('h2', { id: titleId, className: 'fs-modal__title' }, title),
              React.createElement('button', {
                type:        'button',
                className:   'fs-modal__close',
                'aria-label': 'Close',
                onClick:     onClose,
              }, '×'),
            )
          : null,
        React.createElement('div', { className: 'fs-modal__body' }, props.children),
      ),
    );

    /* Portal lift — see Sprint 5.7.1 note in the file header. Falls back
       to in-tree rendering only when ReactDOM/document.body aren't
       available (e.g. node smoke tests where document is stubbed). */
    if (typeof ReactDOM !== 'undefined' && ReactDOM.createPortal
        && typeof document !== 'undefined' && document.body) {
      return ReactDOM.createPortal(tree, document.body);
    }
    return tree;
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ModalOverlay = ModalOverlay;
})();
