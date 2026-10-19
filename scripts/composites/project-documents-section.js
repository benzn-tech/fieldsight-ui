/* ==========================================================================
   FieldSight · composites/project-documents-section.js
   --------------------------------------------------------------------------
   "Documents" on the project page: the project's specs and documents, what
   state each is in (Indexing / Searchable / Not readable / Failed), and --
   for the project's managers (canWrite, decided by the server) -- upload,
   new revision, rename, delete and retry. Opening a document opens the
   original. Hidden entirely when the server says the feature is off.

   Rename and delete are confirmed inline in the row, never with a browser
   dialog (those block the page and look broken on an iPad).

   Exported to: window.FieldSight.ProjectDocumentsSection
   ========================================================================== */

(function () {
  'use strict';

  var h = React.createElement;
  function api() { return window.FS.api.projectDocuments; }
  function toast(message, tone) { if (window.FS && window.FS.toast) window.FS.toast.show({ message: message, tone: tone }); }
  function fmtDate(s) { var d = s ? new Date(s) : null; return d && !isNaN(d) ? d.toLocaleDateString() : ''; }
  var BTN = 'fs-btn fs-btn--sm ';
  function docVisibility() { return typeof document !== 'undefined' && document.visibilityState ? document.visibilityState : 'visible'; }

  function ProjectDocumentsSection(props) {
    var siteId = props.siteId;
    var refSt = React.useState({ status: 'loading', documents: [], canWrite: false });
    var st = refSt[0], setSt = refSt[1];
    var refTick = React.useState(0); var tick = refTick[0], setTick = refTick[1];
    var refBusy = React.useState(null); var busy = refBusy[0], setBusy = refBusy[1];
    var refHist = React.useState(null); var hist = refHist[0], setHist = refHist[1];
    /* { id, title } while a row's title is being edited inline */
    var refEdit = React.useState(null); var editing = refEdit[0], setEditing = refEdit[1];
    /* id of the row asking "Delete …?" inline */
    var refDel = React.useState(null); var confirming = refDel[0], setConfirming = refDel[1];
    var refVis = React.useState(function () { return docVisibility(); });
    var visibility = refVis[0], setVisibility = refVis[1];
    var fileRef = React.useRef(null);
    var revisionOf = React.useRef(null);

    React.useEffect(function () {
      var cancelled = false;
      api().list(siteId).then(function (res) {
        if (cancelled) return;
        if (res.off) { setSt({ status: 'off', documents: [], canWrite: false }); return; }
        setSt({ status: 'ok', documents: res.documents, canWrite: res.canWrite });
      }).catch(function (err) {
        if (!cancelled) setSt({ status: 'error', message: (err && err.message) || 'Could not load documents.', documents: [], canWrite: false });
      });
      return function () { cancelled = true; };
    }, [siteId, tick]);

    /* A hidden tab stops re-reading; coming back schedules the next read. */
    React.useEffect(function () {
      if (typeof document === 'undefined' || !document.addEventListener) return undefined;
      function onVis() { setVisibility(docVisibility()); }
      document.addEventListener('visibilitychange', onVis);
      return function () { document.removeEventListener('visibilitychange', onVis); };
    }, []);

    /* Only while something young is indexing (past 20 minutes only Retry moves it)
       and the tab is visible; never once everything has settled. */
    var polling = api().shouldPoll(st.documents, Date.now(), visibility);
    React.useEffect(function () {
      if (!polling) return undefined;
      var t = setTimeout(function () { setTick(function (n) { return n + 1; }); }, api().REFRESH_MS);
      return function () { clearTimeout(t); };
    }, [polling, tick]);

    if (st.status === 'off') return null;
    /* Nothing, not even the heading, until the first answer: a project with the
       feature off must not flash an empty "Documents" section. */
    if (st.status === 'loading') return null;

    function reload() { setTick(function (n) { return n + 1; }); }
    function run(label, fn, done) {
      if (busy) return;
      setBusy(label);
      fn().then(function (res) {
        setBusy(null);
        if (res && res.off) { setSt({ status: 'off', documents: [], canWrite: false }); return; }
        if (done) done();
        reload();
      }, function (err) {
        setBusy(null);
        toast((err && err.message) || 'Something went wrong — try again.', 'error');
      });
    }
    /* A new revision keeps the series' current title; a first upload is titled by its file. */
    function pick(d) {
      revisionOf.current = d ? { seriesId: d.seriesId, title: d.title } : null;
      if (fileRef.current) fileRef.current.click();
    }
    function onFile(e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      var rev = revisionOf.current; revisionOf.current = null;
      if (!f) return;
      var problem = api().checkFile(f);
      if (problem) { toast(problem, 'error'); return; }
      var opts = rev ? { seriesId: rev.seriesId, title: rev.title } : {};
      run('upload', function () { return api().upload(siteId, f, opts); }, function () {
        toast((rev ? 'New revision of "' + rev.title + '"' : f.name) + ' added — it will be searchable once indexed.', 'success');
      });
    }
    function startRename(d) { setConfirming(null); setEditing({ id: d.id, title: d.title || '' }); }
    function saveRename(d) {
      var title = ((editing && editing.title) || '').trim();
      if (!title || title === d.title) { setEditing(null); return; }
      run('rename', function () { return api().rename(siteId, d.id, title); }, function () { setEditing(null); });
    }
    function onDelete(d) {
      run('delete', function () { return api().remove(siteId, d.id); }, function () {
        setConfirming(null);
        if (hist && hist.seriesId === d.seriesId) setHist(null);
        toast('"' + d.title + '" deleted.', 'success');
      });
    }
    function onOpen(d) {
      api().open(siteId, d.id).catch(function (err) { toast((err && err.message) || 'Could not open the document.', 'error'); });
    }
    function onHistory(d) {
      if (hist && hist.seriesId === d.seriesId) { setHist(null); return; }
      api().history(siteId, d.seriesId).then(function (res) {
        if (res.off) { setSt({ status: 'off', documents: [], canWrite: false }); return; }
        setHist({ seriesId: d.seriesId, documents: res.documents || [] });
      }).catch(function (err) { toast((err && err.message) || 'Could not load the history.', 'error'); });
    }

    function titleOrEditor(d) {
      if (st.canWrite && editing && editing.id === d.id) {
        return h('div', { className: 'fs-project-docs__rename' },
          h('input', {
            type: 'text', className: 'fs-project-docs__input', value: editing.title, autoFocus: true,
            'aria-label': 'Document title', maxLength: 200,
            onChange: function (e) { setEditing({ id: d.id, title: e.target.value }); },
            onKeyDown: function (e) {
              if (e.key === 'Enter') { e.preventDefault(); saveRename(d); }
              if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
            },
          }),
          h('button', { type: 'button', className: BTN + 'fs-btn--primary', disabled: !!busy, onClick: function () { saveRename(d); } },
            busy === 'rename' ? 'Saving…' : 'Save'),
          h('button', { type: 'button', className: BTN + 'fs-btn--tertiary', onClick: function () { setEditing(null); } }, 'Cancel'));
      }
      return h('button', { type: 'button', className: 'fs-project-docs__title', onClick: function () { onOpen(d); }, title: 'Open ' + (d.filename || d.title) }, d.title);
    }

    function row(d) {
      var status = api().statusOf(d, Date.now());
      var asking = st.canWrite && confirming === d.id;
      return h('div', { key: d.id, className: 'fs-project-docs__row' },
        titleOrEditor(d),
        h('div', { className: 'fs-project-docs__meta' },
          ['Rev ' + d.revision, d.uploadedByName, fmtDate(d.createdAt)].filter(Boolean).join(' · '),
          h('span', { className: 'fs-project-docs__status fs-project-docs__status--' + status.tone, title: status.detail || '' }, status.label)),
        status.detail ? h('div', { className: 'fs-project-docs__reason' }, status.detail) : null,
        asking
          ? h('div', { className: 'fs-project-docs__confirm', role: 'alert' },
              h('span', null, 'Delete "' + d.title + '"? It will no longer be searched.'),
              h('button', { type: 'button', className: BTN + 'fs-btn--danger', disabled: !!busy, onClick: function () { onDelete(d); } },
                busy === 'delete' ? 'Deleting…' : 'Yes, delete'),
              h('button', { type: 'button', className: BTN + 'fs-btn--tertiary', onClick: function () { setConfirming(null); } }, 'Keep it'))
          : h('div', { className: 'fs-project-docs__actions' },
              d.revision > 1 ? h('button', { type: 'button', className: BTN + 'fs-btn--tertiary', onClick: function () { onHistory(d); } },
                hist && hist.seriesId === d.seriesId ? 'Hide history' : 'History') : null,
              status.canRetry && st.canWrite ? h('button', { type: 'button', className: BTN + 'fs-btn--secondary', disabled: !!busy, onClick: function () { run('retry', function () { return api().retry(siteId, d.id); }); } }, 'Retry') : null,
              st.canWrite ? h('button', { type: 'button', className: BTN + 'fs-btn--tertiary', disabled: !!busy, onClick: function () { pick(d); } }, 'New revision') : null,
              st.canWrite ? h('button', { type: 'button', className: BTN + 'fs-btn--tertiary', disabled: !!busy, onClick: function () { startRename(d); } }, 'Rename') : null,
              st.canWrite ? h('button', { type: 'button', className: BTN + 'fs-btn--tertiary', disabled: !!busy, onClick: function () { setEditing(null); setConfirming(d.id); } }, 'Delete') : null),
        hist && hist.seriesId === d.seriesId
          ? h('div', { className: 'fs-project-docs__history' }, hist.documents.map(function (r) {
              return h('div', { key: r.id, className: 'fs-project-docs__history-row' },
                'Rev ' + r.revision + ' · ' + fmtDate(r.createdAt) + ' · ' + api().statusOf(r, Date.now()).label
                + (r.supersededAt ? ' · replaced' : ''));
            }))
          : null);
    }

    return h('div', { className: 'fs-sites-detail__section fs-project-docs' },
      h('div', { className: 'fs-project-docs__head' },
        h('div', { className: 'fs-sites-detail__section-label' }, 'Documents'),
        st.canWrite ? h('button', { type: 'button', className: BTN + 'fs-btn--secondary', disabled: !!busy, onClick: function () { pick(null); } }, busy === 'upload' ? 'Uploading…' : 'Upload document') : null),
      h('input', { type: 'file', ref: fileRef, onChange: onFile, style: { display: 'none' },
        accept: '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown' }),
      st.status === 'error' ? h('div', { className: 'fs-sites-detail__empty' }, st.message)
        : st.documents.length === 0 ? h('div', { className: 'fs-sites-detail__empty' }, 'No documents yet. Specs and documents added here can be searched and asked about.')
        : h('div', { className: 'fs-project-docs__list' }, st.documents.map(row)));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ProjectDocumentsSection = ProjectDocumentsSection;
})();
