/* ==========================================================================
   FieldSight · PhotoChoiceDialog — leave photographs out of a day's reports
   --------------------------------------------------------------------------
   Opened from the bell's photograph notice (event `fs:open-photo-choice`,
   detail: {date, folder}). The same choice the day report dialog offers past
   120 photographs (FieldSight.PhotoChoiceStep), reachable before anyone
   generates anything -- so the nightly report follows it too (owner,
   2026-10-01). Mounted once beside the bell; renders nothing until opened.

   Exposed as window.FieldSight.PhotoChoiceDialog
   ========================================================================== */
(function () {
  'use strict';

  function PhotoChoiceDialog() {
    var h = React.createElement;
    var s_open = React.useState(null); var open = s_open[0], setOpen = s_open[1];
    var s_sel = React.useState(null); var sel = s_sel[0], setSel = s_sel[1];
    var s_out = React.useState({}); var out = s_out[0], setOut = s_out[1];
    var s_err = React.useState(null); var err = s_err[0], setErr = s_err[1];
    var s_busy = React.useState(false); var busy = s_busy[0], setBusy = s_busy[1];

    React.useEffect(function () {
      function onOpen(e) {
        var d = (e && e.detail) || {};
        if (!d.date) return;
        setOpen({ date: d.date, folder: d.folder || null });
      }
      window.addEventListener('fs:open-photo-choice', onOpen);
      return function () { window.removeEventListener('fs:open-photo-choice', onOpen); };
    }, []);

    React.useEffect(function () {
      if (!open) return undefined;
      var alive = true;
      var org = ((window.FS || {}).api || {}).org || {};
      setSel(null); setOut({}); setErr(null);
      if (!org.getPhotoSelection) return undefined;
      Promise.resolve(org.getPhotoSelection({ date: open.date, user: open.folder }))
        .then(function (res) {
          if (!alive) return;
          if (!res || !Array.isArray(res.photos)) {
            setErr((res && res.error) || 'Could not load the photographs.');
            return;
          }
          setSel(res);
          var o = {};
          res.photos.forEach(function (p) { if (p.excluded) o[p.filename] = true; });
          setOut(o);
        }, function () { if (alive) setErr('Could not load the photographs.'); });
      return function () { alive = false; };
    }, [open]);

    var ModalOverlay = (window.FieldSight || {}).ModalOverlay;
    var Step = (window.FieldSight || {}).PhotoChoiceStep;
    if (!open || !ModalOverlay || !Step) return null;

    var total = sel ? sel.photos.length : 0;
    var included = total - Object.keys(out).filter(function (k) { return out[k]; }).length;
    var max = sel ? sel.limits.max : 0;

    function close() { setOpen(null); }

    function save() {
      var org = ((window.FS || {}).api || {}).org || {};
      setBusy(true); setErr(null);
      Promise.resolve(org.putPhotoSelection({
        date: open.date, user: open.folder,
        excluded: Object.keys(out).filter(function (k) { return out[k]; }),
      })).then(function (res) {
        setBusy(false);
        if (!res || res.error || res._accessDenied) {
          setErr((res && res.error) || 'Could not save the choice of photographs.');
          return;
        }
        if (window.FS && window.FS.photoNotice) window.FS.photoNotice.refresh();
        close();
      }, function () { setBusy(false); setErr('Could not save the choice of photographs.'); });
    }

    return h(ModalOverlay, {
      open: true, onClose: close, closeOnBackdrop: false, size: 'lg',
      title: 'Photographs for ' + open.date + ' reports',
    },
      h('div', { className: 'fs-modal__body' },
        sel ? h(Step, { selection: sel, out: out, max: max, included: included, error: err,
          onToggle: function (name) {
            setOut(function (o) { var n = Object.assign({}, o); n[name] = !o[name]; return n; });
          } })
          : h('p', { className: err ? 'fs-field__hint fs-field__hint--error' : 'fs-srm__hint' },
              err || 'Loading the photographs…'),
        h('footer', { className: 'fs-srm__footer' },
          h('button', { type: 'button', className: 'fs-btn fs-btn--md fs-btn--secondary', onClick: close }, 'Cancel'),
          h('button', {
            type: 'button', className: 'fs-btn fs-btn--md fs-btn--primary',
            disabled: !sel || included > max || busy,
            title: sel && included > max ? 'Leave out ' + (included - max) + ' more' : undefined,
            onClick: save,
          }, busy ? 'Saving…' : 'Save'))));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.PhotoChoiceDialog = PhotoChoiceDialog;
})();
