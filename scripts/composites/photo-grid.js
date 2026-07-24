/* ==========================================================================
   FieldSight PhotoGrid — Layer 5 composite
   --------------------------------------------------------------------------
   Thumbnail grid for topic.related_photos (BACKEND-CONTEXT §5.1, §7).

   For each filename we build the S3 key
     users/{folder_name}/pictures/{date}/{filename}
   and resolve a presigned URL via FS.api.media.presignedUrl. URLs expire
   in 15 min (BUG §7) — we re-fetch on mount and don't cache; if the user
   closes and re-opens the modal/tab, this remounts and re-fetches.

   Click a thumb to open a lightbox-style overlay.

   Props:
     photos          string[] — filenames (NOT keys)
     userDisplayName string   — owner's display name (folder = name with
                                spaces → underscores)
     date            'YYYY-MM-DD'
     canEditContent  bool     — Q7: reviewer content-edit tier, threaded
                                from the mount site (timeline.js's
                                `canEditContent` = hasContentEditPerm ||
                                isOwnReport). Gates the delete affordance
                                on auto-generated keyframe photos ONLY;
                                mounts that omit it (safety/quality/
                                evidence — no equivalent signal in scope
                                there) simply never show delete, a no-op.

   Exported to:
     window.FieldSight.PhotoGrid
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* Q7 — auto-generated video keyframes are saved as normal photos whose
     basename carries a `_kf_s<HHMMSS>.jpg` marker (the seconds-since-
     midnight timestamp the frame was grabbed at). Mirrors the backend's
     own basename check verbatim (DELETE /api/org/media/keyframe rejects
     any key that doesn't match this). `photos[]` here are already bare
     filenames (see header), so testing the filename directly IS testing
     the basename — no path stripping needed. */
  var KEYFRAME_RE = /_kf_s\d{6}\.jpg$/;
  function isKeyframe(filename) {
    return KEYFRAME_RE.test(String(filename || ''));
  }

  function PhotoGrid(props) {
    var photos   = props.photos || [];
    var userName = props.userDisplayName;
    var date     = props.date;
    /* Sprint 6.6.3 — variant='carousel' switches the layout to a
       horizontal-scrolling row (default 2 cells visible, swipe/scroll
       for more). Used by /safety + /quality right panels where we
       embed photos inline as supporting context. variant='grid'
       (default) keeps the classic auto-fill grid used by topic-card. */
    var variant = props.variant === 'carousel' ? 'carousel' : 'grid';
    var canEditContent = !!props.canEditContent;

    var refLight = React.useState(null);
    var lightbox    = refLight[0];
    var setLightbox = refLight[1];

    /* Q7 — filenames removed via a confirmed keyframe delete, so the
       thumbnail disappears the moment the DELETE call resolves rather
       than waiting on a refetch (topic.related_photos is a point-in-time
       array off the report the parent fetched; there's no live refresh
       channel for it the way redactions have fs:timeline-refresh, so
       PhotoGrid tracks its own removals). Keyed by filename; reset
       whenever the incoming photo list identity changes (topic switch)
       so a removal from a different topic can never bleed into this
       one. */
    var refDeleted = React.useState({});
    var deletedMap    = refDeleted[0];
    var setDeletedMap = refDeleted[1];
    React.useEffect(function () { setDeletedMap({}); }, [props.photos]);

    var visiblePhotos = photos.filter(function (f) { return !deletedMap[f]; });

    if (visiblePhotos.length === 0) {
      return React.createElement('div', { className: 'fs-photo-grid__empty' },
        'No photos for this topic.');
    }

    return React.createElement(React.Fragment, null,
      React.createElement('div', {
        className: 'fs-photo-grid fs-photo-grid--' + variant,
      },
        visiblePhotos.map(function (filename) {
          var s3Key = window.FS.api.media.photoKey({
            userDisplayName: userName, date: date, filename: filename,
          });
          return React.createElement(PhotoCell, {
            key:       filename,
            s3Key:     s3Key,
            filename:  filename,
            canDelete: canEditContent && isKeyframe(filename),
            onOpen:    function (url) {
              setLightbox({ url: url, filename: filename });
            },
            onDeleted: function () {
              setDeletedMap(function (cur) {
                var next = Object.assign({}, cur);
                next[filename] = true;
                return next;
              });
              setLightbox(function (cur) {
                return (cur && cur.filename === filename) ? null : cur;
              });
            },
          });
        }),
      ),

      lightbox ? React.createElement(PhotoLightbox, {
        url:      lightbox.url,
        filename: lightbox.filename,
        onClose:  function () { setLightbox(null); },
      }) : null,
    );
  }

  /* ---------- single thumb ---------------------------------------------- */

  function PhotoCell(props) {
    var refUrl = React.useState(null);
    var url    = refUrl[0];
    var setUrl = refUrl[1];

    var refErr = React.useState(false);
    var errored    = refErr[0];
    var setErrored = refErr[1];

    React.useEffect(function () {
      var cancelled = false;
      window.FS.api.media.presignedUrl(props.s3Key).then(function (res) {
        if (!cancelled) setUrl(res.url);
      }).catch(function () {
        if (!cancelled) setErrored(true);
      });
      return function () { cancelled = true; };
    }, [props.s3Key]);

    function open() {
      if (url) props.onOpen(url);
    }

    /* Q7 — two-click inline delete confirmation for auto-generated
       keyframe photos. This codebase avoids window.confirm for
       destructive actions (see programme-task-editor.js's "Sprint 5.3 —
       two-click delete confirmation": arm on first click, a second click
       commits); mirrored here rather than a native dialog. First click
       arms (icon swaps to the danger-styled "confirm" state); a second
       click on the SAME cell within that armed state fires the delete.
       Any click elsewhere on the cell (opening the lightbox) disarms it. */
    var refConfirm = React.useState(false);
    var confirming    = refConfirm[0];
    var setConfirming = refConfirm[1];

    var refBusy = React.useState(false);
    var busy    = refBusy[0];
    var setBusy = refBusy[1];

    var refDelErr = React.useState(false);
    var deleteErrored    = refDelErr[0];
    var setDeleteErrored = refDelErr[1];

    function handleOpen() {
      if (confirming) setConfirming(false);
      open();
    }

    /* Handles the _accessDenied/_notFound error sentinels _fetch.js
       resolves (never thrown) AND a genuine rejection (network/5xx) —
       both surface a toast and leave the thumbnail in place so a failed
       delete never silently vanishes a photo the reviewer still has. */
    function handleDeleteClick(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      if (busy) return;
      if (!confirming) { setConfirming(true); return; }

      setBusy(true);
      setDeleteErrored(false);
      window.FS.api.media.deleteKeyframe(props.s3Key).then(function (res) {
        setBusy(false);
        if (!res || res._accessDenied || res._notFound) {
          setConfirming(false);
          setDeleteErrored(true);
          var toast = window.FS && window.FS.toast;
          if (toast) {
            toast.show({
              message:  (res && res.error) || 'Could not delete keyframe photo',
              tone:     'error',
              duration: 5000,
            });
          }
          return;
        }
        if (props.onDeleted) props.onDeleted();
      }).catch(function () {
        setBusy(false);
        setConfirming(false);
        setDeleteErrored(true);
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({ message: 'Could not delete keyframe photo', tone: 'error', duration: 5000 });
        }
      });
    }

    var IconBtn = window.FieldSight.IconButton;

    return React.createElement('div', { className: 'fs-photo-grid__cell' },
      React.createElement('button', {
        type:      'button',
        className: 'fs-photo-grid__open',
        onClick:   handleOpen,
        'aria-label': 'View ' + props.filename,
      },
        React.createElement('div', { className: 'fs-photo-grid__thumb' },
          url && !errored
            ? React.createElement('img', {
                src:       url,
                alt:       props.filename,
                loading:   'lazy',
                decoding:  'async',
                className: 'fs-photo-grid__img',
                onError:   function () { setErrored(true); },
              })
            : React.createElement('div', { className: 'fs-photo-grid__placeholder' },
                errored ? 'Preview unavailable' : 'Loading…'),
        ),
        React.createElement('div', { className: 'fs-photo-grid__caption' },
          props.filename),
      ),

      /* Delete affordance — ONLY rendered for keyframe photos AND only
         when the caller may edit content (props.canDelete already
         combines both upstream in PhotoGrid). Real user photos (no
         `_kf_` marker) get no delete control regardless of permission. */
      props.canDelete && IconBtn ? React.createElement('div', {
        className: 'fs-photo-grid__delete-wrap',
      },
        IconBtn && confirming
          ? React.createElement(IconBtn, {
              icon: 'trash-2', size: 'sm', variant: 'danger',
              disabled: busy, loading: busy,
              ariaLabel: 'Confirm delete keyframe photo',
              tooltip:   'Click again to delete',
              className: 'fs-photo-grid__delete fs-photo-grid__delete--confirm',
              onClick:   handleDeleteClick,
            })
          : React.createElement(IconBtn, {
              icon: 'trash-2', size: 'sm', variant: 'ghost',
              disabled: busy,
              ariaLabel: 'Delete auto-generated keyframe photo',
              tooltip:   'Delete keyframe',
              className: 'fs-photo-grid__delete',
              onClick:   handleDeleteClick,
            }),
        deleteErrored ? React.createElement('div', {
          className: 'fs-photo-grid__delete-error',
        }, 'Could not delete') : null,
      ) : null,
    );
  }

  /* ---------- lightbox -------------------------------------------------- */

  function PhotoLightbox(props) {
    React.useEffect(function () {
      function onKey(e) { if (e.key === 'Escape') props.onClose(); }
      document.addEventListener('keydown', onKey);
      return function () { document.removeEventListener('keydown', onKey); };
    }, [props.onClose]);

    return React.createElement('div', {
      className: 'fs-photo-lightbox',
      role:      'dialog',
      'aria-label': props.filename,
      onClick:   props.onClose,
    },
      React.createElement('div', {
        className: 'fs-photo-lightbox__inner',
        onClick:   function (e) { e.stopPropagation(); },
      },
        React.createElement('img', {
          src: props.url, alt: props.filename,
          className: 'fs-photo-lightbox__img',
        }),
        React.createElement('div', { className: 'fs-photo-lightbox__caption' },
          props.filename),
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.PhotoGrid = PhotoGrid;

  /* Expose the pure keyframe-detection helper to Node's test runner only
     (CommonJS) — mirrors timeline.js's own module.exports guard. No-op in
     the browser (Babel standalone leaves `module` undefined). */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isKeyframe: isKeyframe };
  }
})();
