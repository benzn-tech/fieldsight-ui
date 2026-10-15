/* ==========================================================================
   FieldSight · TemplateUploadModal — Sprint 10 B.2, reads the file since 2026-10-16
   --------------------------------------------------------------------------
   Add a template to the library. With a file attached -- a checklist form as
   a Word file, a PDF, or a photo of each page -- the file is uploaded, read on
   the server into a DRAFT, and shown on a review screen beside the form; it
   becomes a template only when the person presses Save
   (pipeline spec docs/superpowers/specs/2026-10-16-template-digitise-design.md).

   With no file, or when reading is switched off on the server (its routes
   answer 404), the template is created as before, from the starting sections
   for its report type -- and after the off fallback the library says that
   nothing was read from the file.

   History, kept on purpose: until 2026-10-16 this modal checked the file's
   extension and threw it away, behind a spinner reading "AI is extracting
   schema". tests/the-library-says-what-it-actually-does.test.js exists because
   of that.

   Props:
     scope       'org' | 'personal'   which library to add to
     onComplete  fn(row, how)         how = {digitised:true} | {readingOff:true} | undefined
     onCancel    fn

   Phases: idle → uploading → reading → review → saving → (closed)
           idle → creating → (closed)
           any → error

   CSS: §TEMPLATE-UPLOAD + §TEMPLATE-DIGITISE in styles/composites.css
   Exported to: window.FieldSight.TemplateUploadModal
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* The report types POST /templates accepts for a starter template. 'incident'
     used to be offered here and the server answers it with a 400 (_REPORT_TYPES
     in lambda_org_api.py has no such type), so it is not offered. */
  var REPORT_TYPES = ['daily', 'weekly', 'monthly'];
  var ACCEPT = '.pdf,.docx,.jpg,.jpeg,.png';

  function TemplateUploadModal(props) {
    var fs           = window.FieldSight;
    var ModalOverlay = fs.ModalOverlay;
    var Button       = fs.Button;
    var Review       = fs.TemplateDigitiseReview;
    var TD           = window.FS.api.templateDigitise;
    var templates    = window.FS.api.templates;

    var scope      = props.scope      || 'personal';
    var onComplete = props.onComplete || function () {};
    var onCancel   = props.onCancel   || function () {};
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};

    var s1 = React.useState('idle');  var phase = s1[0];   var setPhase = s1[1];
    var s2 = React.useState([]);      var files = s2[0];   var setFiles = s2[1];
    var s3 = React.useState('');      var errMsg = s3[0];  var setErr = s3[1];
    var s4 = React.useState('');      var title = s4[0];   var setTitle = s4[1];
    var s5 = React.useState('');      var desc = s5[0];    var setDesc = s5[1];
    var s6 = React.useState('daily'); var rt = s6[0];      var setRt = s6[1];
    var s7 = React.useState(null);    var draft = s7[0];   var setDraft = s7[1];
    var s8 = React.useState([]);      var sources = s8[0]; var setSources = s8[1];
    /* One number per completed read, used as the review's key: the review holds
       its Undo itself, and a fresh read must never be able to undo back into
       the previous draft. */
    var s9 = React.useState(0);       var readNo = s9[0];  var setReadNo = s9[1];

    /* A read takes half a minute and the person may press Close meanwhile. What
       comes back after that must not create a template nobody is waiting for
       (the off fallback creates one). */
    var alive = React.useRef(true);
    React.useEffect(function () {
      alive.current = true;
      return function () { alive.current = false; };
    }, []);

    function pickFiles(list) {
      var picked = Array.prototype.slice.call(list || []);
      var problem = TD.checkFiles(picked);
      if (problem) { setErr(problem); return; }
      setFiles(picked);
      setErr('');
      if (!title) setTitle(picked[0].name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
    }

    async function createFromStarter(readingOff) {
      setPhase('creating');
      try {
        var row = await templates.create({
          scope: scope, report_type: rt, title: title.trim(), description: desc.trim(),
          owner_user_id: caller.device_id || caller.sub || null,
        });
        onComplete(row, readingOff ? { readingOff: true } : undefined);
      } catch (e) {
        setPhase('error');
        setErr((e && e.message) || 'Creating the template failed — please try again.');
      }
    }

    async function handleSubmit() {
      if (!title.trim()) { setErr('Please enter a template title.'); return; }
      if (!files.length) return createFromStarter(false);
      setErr('');
      try {
        var result = await TD.digitise(files, title.trim(), {
          onPhase: function (p) { if (alive.current) setPhase(p); },
        });
        if (!alive.current) return;
        if (result.off) return createFromStarter(true);
        if (result.status !== 'done') {
          setPhase('error');
          setErr(result.reason || result.error || 'The form could not be read.');
          return;
        }
        setDraft(TD.fromResult(result));
        setSources(result.sources || []);
        setReadNo(function (n) { return n + 1; });
        setPhase('review');
      } catch (e) {
        if (!alive.current) return;
        setPhase('error');
        setErr((e && e.message) || 'Upload failed — please try again.');
      }
    }

    async function handleSave(current) {
      var body = TD.toTemplateBody(current);
      /* The server's checks, run here first. problemFor gives the same answer as
         TD.bodyProblem(body) but numbers the section the way the screen does
         (the body leaves out sections with no items). */
      var problem = TD.bodyProblem(body) && Review.problemFor(current);
      if (problem) { setErr(problem.message); return; }
      setErr('');
      setPhase('saving');
      try {
        var row = await templates.create({
          scope: scope, report_type: 'custom', title: title.trim(), description: desc.trim(),
          body: body, owner_user_id: caller.device_id || caller.sub || null,
        });
        onComplete(row, { digitised: true });
      } catch (e) {
        /* Back to the draft, edits intact: a name already taken (409) is fixed by
           renaming, not by reading the form again. */
        setPhase('review');
        setErr((e && e.message) || 'Saving failed — please try again.');
      }
    }

    var inputId = 'tpl-file-input-' + scope;

    function frame(children, wide) {
      var heading = wide ? 'Check your form' : 'New template';
      return React.createElement(ModalOverlay, {
        open: true, onClose: onCancel, ariaLabel: heading,
        size: wide ? 'xl' : 'md',
        /* A stray tap beside the review must not throw away the edits. */
        closeOnBackdrop: !wide,
      },
        React.createElement('div', { className: wide ? 'fs-tpl-upload fs-tpl-upload--wide' : 'fs-tpl-upload' },
          React.createElement('h2', { className: 'fs-tpl-upload__title' }, heading),
          children));
    }

    if (phase === 'review' || phase === 'saving') {
      return frame(React.createElement(Review, {
        key: 'read-' + readNo,
        draft: draft, sources: sources, error: errMsg, saving: phase === 'saving',
        onChange: function (next) { setDraft(next); setErr(''); },
        onSave: handleSave, onCancel: onCancel,
      }), true);
    }

    if (phase === 'uploading' || phase === 'reading' || phase === 'creating') {
      var label = phase === 'uploading' ? 'Uploading your form…'
                : phase === 'reading'   ? 'Reading your form… about half a minute'
                : 'Creating…';
      return frame([
        React.createElement('div', { key: 'p', className: 'fs-tpl-upload__progress' },
          React.createElement('div', { className: 'fs-tpl-upload__spinner' }),
          React.createElement('p', { className: 'fs-tpl-upload__phase-label', role: 'status' }, label)),
        React.createElement('div', { key: 'f', className: 'fs-tpl-upload__footer' },
          React.createElement(Button, { variant: 'ghost', onClick: onCancel }, 'Close')),
      ]);
    }

    if (phase === 'error') {
      return frame([
        React.createElement('p', { key: 'e', className: 'fs-tpl-upload__error', role: 'alert' }, errMsg || 'Something went wrong.'),
        React.createElement('div', { key: 'f', className: 'fs-tpl-upload__footer' },
          React.createElement(Button, { variant: 'ghost', onClick: function () { setPhase('idle'); setErr(''); } }, 'Try again'),
          React.createElement(Button, { variant: 'ghost', onClick: onCancel }, 'Cancel')),
      ]);
    }

    /* idle / dragging */
    var hasFiles = files.length > 0;
    return frame([
      React.createElement('p', { key: 'sub', className: 'fs-tpl-upload__subtitle' },
        'Attach your checklist form — a Word file, a PDF, or a photo of each page — to start '
        + 'from its items, or leave it empty for a starting set of sections for the report type.'),
      React.createElement('div', {
        key: 'drop',
        className: 'fs-tpl-upload__dropzone' + (phase === 'dragging' ? ' fs-tpl-upload__dropzone--active' : '')
                   + (hasFiles ? ' fs-tpl-upload__dropzone--filled' : ''),
        onDragOver:  function (e) { e.preventDefault(); setPhase('dragging'); },
        onDragLeave: function () { setPhase('idle'); },
        onDrop:      function (e) { e.preventDefault(); setPhase('idle'); pickFiles(e.dataTransfer.files); },
        onClick:     function () { document.getElementById(inputId).click(); },
        role: 'button', tabIndex: 0,
        onKeyDown:   function (e) { if (e.key === 'Enter' || e.key === ' ') document.getElementById(inputId).click(); },
      },
        React.createElement('input', {
          id: inputId, type: 'file', style: { display: 'none' }, accept: ACCEPT, multiple: true,
          onChange: function (e) { pickFiles(e.target.files); },
        }),
        hasFiles
          ? React.createElement('div', { className: 'fs-tpl-upload__file-row' },
              React.createElement('span', { className: 'fs-tpl-upload__file-icon' }, '📄'),
              React.createElement('span', { className: 'fs-tpl-upload__file-name' },
                files.length === 1 ? files[0].name : files.length + ' pages'),
              React.createElement('button', {
                type: 'button',
                className: 'fs-tpl-upload__file-clear',
                onClick: function (e) { e.stopPropagation(); setFiles([]); setTitle(''); },
                'aria-label': 'Remove file',
              }, '×'))
          : React.createElement('div', { className: 'fs-tpl-upload__drop-hint' },
              React.createElement('span', { className: 'fs-tpl-upload__drop-icon' }, '⬆'),
              React.createElement('span', null, 'Optional: your checklist form'),
              React.createElement('span', { className: 'fs-tpl-upload__drop-types' },
                'Word (.docx) · PDF · photos (.jpg, .png), up to 10 pages — max 20 MB each'))),
      React.createElement('div', { key: 'fields', className: 'fs-tpl-upload__fields' },
        React.createElement('label', { className: 'fs-tpl-upload__field' },
          React.createElement('span', { className: 'fs-tpl-upload__label' }, 'Title ',
            React.createElement('span', { 'aria-hidden': 'true', style: { color: 'var(--color-danger-600)' } }, '*')),
          React.createElement('input', {
            className: 'fs-tpl-upload__input', value: title,
            onChange: function (e) { setTitle(e.target.value); },
            placeholder: 'e.g. Site Inspection Checklist',
          })),
        hasFiles ? null : React.createElement('div', { className: 'fs-tpl-upload__field-row' },
          React.createElement('label', { className: 'fs-tpl-upload__field' },
            React.createElement('span', { className: 'fs-tpl-upload__label' }, 'Report type'),
            React.createElement('select', {
              className: 'fs-tpl-upload__select', value: rt,
              onChange: function (e) { setRt(e.target.value); },
            }, REPORT_TYPES.map(function (v) {
              return React.createElement('option', { key: v, value: v }, v.charAt(0).toUpperCase() + v.slice(1));
            })))),
        React.createElement('label', { className: 'fs-tpl-upload__field' },
          React.createElement('span', { className: 'fs-tpl-upload__label' }, 'Description (optional)'),
          React.createElement('textarea', {
            className: 'fs-tpl-upload__textarea', rows: 2, value: desc,
            onChange: function (e) { setDesc(e.target.value); },
            placeholder: 'Brief description of this template\'s use case',
          }))),
      errMsg ? React.createElement('p', { key: 'err', className: 'fs-tpl-upload__error', role: 'alert' }, errMsg) : null,
      React.createElement('div', { key: 'foot', className: 'fs-tpl-upload__footer' },
        React.createElement(Button, { variant: 'ghost', onClick: onCancel }, 'Cancel'),
        React.createElement(Button, { variant: 'primary', onClick: handleSubmit, disabled: !title.trim() },
          hasFiles ? 'Read the form' : 'Create template')),
    ]);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TemplateUploadModal = TemplateUploadModal;
})();
