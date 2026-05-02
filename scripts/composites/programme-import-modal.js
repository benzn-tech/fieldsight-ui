/* ==========================================================================
   FieldSight — ProgrammeImportModal  (Sprint 5.4)
   --------------------------------------------------------------------------
   File-picker modal for CSV programme imports. Opens via an "Import…"
   button in the Programme header; wraps ModalOverlay and the native
   programme-import parser (window.FS.api.programmeImport.parseCSV).

   Flow:
     pick  →  preview (validation report + task table)  →  confirm
                                                     ↓
                              calls onImport(parents, leaves) on success

   Props:
     open       boolean
     onClose    () => void
     onImport   (parents, leaves) => void   — called only if no errors

   Exported to:  window.FieldSight.ProgrammeImportModal
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var STATUS_LABELS = {
    not_started: 'Not started',
    in_progress:  'In progress',
    completed:    'Completed',
    delayed:      'Delayed',
    blocked:      'Blocked',
    group:        'Group',
  };

  /* ---- helpers ------------------------------------------------------------ */

  function pluralise(n, singular, plural) {
    return n === 1 ? n + ' ' + singular : n + ' ' + (plural || singular + 's');
  }

  function fmtDate(s) {
    if (!s) return '—';
    var d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  /* ---- DropZone ----------------------------------------------------------- */

  function DropZone(props) {
    var onFile = props.onFile || function () {};
    var refDrag = React.useState(false);
    var dragOver = refDrag[0];
    var setDragOver = refDrag[1];

    var inputRef = React.useRef(null);

    function handleFiles(fileList) {
      var f = fileList && fileList[0];
      if (f) onFile(f);
    }

    function onDragOver(e) {
      e.preventDefault();
      setDragOver(true);
    }
    function onDragLeave() { setDragOver(false); }
    function onDrop(e) {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer && e.dataTransfer.files);
    }
    function onInputChange(e) {
      handleFiles(e.target.files);
      /* reset so re-picking the same file fires again */
      e.target.value = '';
    }

    return React.createElement('div', {
      className: 'fs-prog-import__drop' + (dragOver ? ' fs-prog-import__drop--over' : ''),
      onDragOver:  onDragOver,
      onDragLeave: onDragLeave,
      onDrop:      onDrop,
      onClick:     function () { inputRef.current && inputRef.current.click(); },
      role:        'button',
      tabIndex:    0,
      'aria-label': 'Select a CSV file to import',
      onKeyDown: function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current && inputRef.current.click(); }
      },
    },
      React.createElement('input', {
        ref:      inputRef,
        type:     'file',
        accept:   '.csv,text/csv',
        style:    { display: 'none' },
        onChange: onInputChange,
      }),
      React.createElement('div', { className: 'fs-prog-import__drop-icon' }, '📂'),
      React.createElement('div', { className: 'fs-prog-import__drop-title' },
        dragOver ? 'Drop to import' : 'Drag & drop a CSV file here'),
      React.createElement('div', { className: 'fs-prog-import__drop-sub' },
        'or click to browse · .csv only'),
      React.createElement('div', { className: 'fs-prog-import__drop-cols' },
        React.createElement('code', null,
          'task_id, wbs, parent_id, name, start, end, progress_pct, status, depends_on, assignees')),
    );
  }

  /* ---- ValidationReport -------------------------------------------------- */

  function ValidationReport(props) {
    var errors   = props.errors   || [];
    var warnings = props.warnings || [];
    if (errors.length === 0 && warnings.length === 0) return null;

    return React.createElement('div', { className: 'fs-prog-import__report' },
      errors.length > 0 && React.createElement('div', { className: 'fs-prog-import__report-section fs-prog-import__report-section--error' },
        React.createElement('div', { className: 'fs-prog-import__report-header' },
          React.createElement('span', { className: 'fs-prog-import__report-badge fs-prog-import__report-badge--error' },
            pluralise(errors.length, 'error')),
          ' — import blocked until resolved'),
        React.createElement('ul', { className: 'fs-prog-import__report-list' },
          errors.map(function (e, i) {
            return React.createElement('li', { key: i }, e.message);
          }),
        ),
      ),
      warnings.length > 0 && React.createElement('div', { className: 'fs-prog-import__report-section fs-prog-import__report-section--warn' },
        React.createElement('div', { className: 'fs-prog-import__report-header' },
          React.createElement('span', { className: 'fs-prog-import__report-badge fs-prog-import__report-badge--warn' },
            pluralise(warnings.length, 'warning')),
          ' — import allowed, review before confirming'),
        React.createElement('ul', { className: 'fs-prog-import__report-list' },
          warnings.map(function (w, i) {
            return React.createElement('li', { key: i }, w.message);
          }),
        ),
      ),
    );
  }

  /* ---- PreviewTable ------------------------------------------------------- */

  function PreviewTable(props) {
    var parents = props.parents || [];
    var leaves  = props.leaves  || [];
    var MAX_ROWS = 20;

    var allRows = [];
    /* Interleave: each parent, then its children — matches Gantt WBS order */
    parents.forEach(function (p) {
      allRows.push({ isGroup: true, task: p });
      leaves
        .filter(function (l) { return l.parent_id === p.task_id; })
        .forEach(function (l) { allRows.push({ isGroup: false, task: l }); });
    });
    /* Orphaned leaves (unknown parent_id) go at the end */
    var parentIds = parents.map(function (p) { return p.task_id; });
    leaves
      .filter(function (l) { return parentIds.indexOf(l.parent_id) === -1; })
      .forEach(function (l) { allRows.push({ isGroup: false, task: l }); });

    var shown    = allRows.slice(0, MAX_ROWS);
    var overflow = allRows.length - shown.length;

    return React.createElement('div', { className: 'fs-prog-import__table-wrap' },
      React.createElement('table', { className: 'fs-prog-import__table' },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', null, 'WBS'),
            React.createElement('th', null, 'Task ID'),
            React.createElement('th', null, 'Name'),
            React.createElement('th', null, 'Start'),
            React.createElement('th', null, 'End'),
            React.createElement('th', null, 'Status'),
            React.createElement('th', null, '%'),
          ),
        ),
        React.createElement('tbody', null,
          shown.map(function (row, i) {
            var t = row.task;
            return React.createElement('tr', {
              key: t.task_id || i,
              className: row.isGroup ? 'fs-prog-import__table-group' : '',
            },
              React.createElement('td', { className: 'fs-prog-import__td-mono' }, t.wbs || '—'),
              React.createElement('td', { className: 'fs-prog-import__td-mono' }, t.task_id),
              React.createElement('td', { style: row.isGroup ? { fontWeight: 600 } : {} }, t.name),
              React.createElement('td', null, row.isGroup ? '—' : fmtDate(t.start)),
              React.createElement('td', null, row.isGroup ? '—' : fmtDate(t.end)),
              React.createElement('td', null,
                React.createElement('span', {
                  className: 'fs-prog-import__status-pill fs-prog-import__status-pill--' + t.status,
                }, STATUS_LABELS[t.status] || t.status),
              ),
              React.createElement('td', null, row.isGroup ? '—' : (t.progress_pct + '%')),
            );
          }),
          overflow > 0 && React.createElement('tr', { key: '__overflow' },
            React.createElement('td', { colSpan: 7, className: 'fs-prog-import__table-overflow' },
              '+ ' + overflow + ' more rows not shown'),
          ),
        ),
      ),
    );
  }

  /* ---- ProgrammeImportModal ----------------------------------------------- */

  function ProgrammeImportModal(props) {
    var open     = !!props.open;
    var onClose  = props.onClose  || function () {};
    var onImport = props.onImport || function () {};

    var ModalOverlay = window.FieldSight && window.FieldSight.ModalOverlay;
    var Button       = window.FieldSight && window.FieldSight.Button;

    /* phase: 'pick' | 'preview' */
    var phaseHook  = React.useState('pick');
    var phase      = phaseHook[0];
    var setPhase   = phaseHook[1];

    var fileNameHook = React.useState('');
    var fileName     = fileNameHook[0];
    var setFileName  = fileNameHook[1];

    var resultHook = React.useState(null);
    var result     = resultHook[0];
    var setResult  = resultHook[1];

    /* Reset state when modal is opened fresh */
    React.useEffect(function () {
      if (open) { setPhase('pick'); setFileName(''); setResult(null); }
    }, [open]);

    function handleFile(f) {
      setFileName(f.name);
      var reader = new FileReader();
      reader.onload = function (e) {
        var text   = e.target.result;
        var parsed = window.FS.api.programmeImport.parseCSV(text);
        setResult(parsed);
        setPhase('preview');
      };
      reader.readAsText(f, 'utf-8');
    }

    function handleConfirm() {
      if (result && result.errors.length === 0) {
        onImport(result.parents, result.leaves);
        onClose();
      }
    }

    var hasErrors = result && result.errors.length > 0;
    var taskCount = result ? (result.parents.length + result.leaves.length) : 0;

    var summary = result && phase === 'preview'
      ? pluralise(result.parents.length, 'group') + ', ' + pluralise(result.leaves.length, 'task')
      : '';

    return ModalOverlay
      ? React.createElement(ModalOverlay, {
          open:            open,
          onClose:         onClose,
          title:           phase === 'pick' ? 'Import programme from CSV' : 'Preview import — ' + fileName,
          size:            'lg',
          closeOnBackdrop: phase === 'pick',
        },
          phase === 'pick'
            ? React.createElement(DropZone, { onFile: handleFile })
            : React.createElement('div', { className: 'fs-prog-import__preview' },

                /* Summary bar */
                React.createElement('div', { className: 'fs-prog-import__summary' },
                  React.createElement('span', { className: 'fs-prog-import__summary-count' }, taskCount),
                  ' rows parsed — ',
                  summary,

                  /* Pick a different file */
                  React.createElement('button', {
                    type:      'button',
                    className: 'fs-prog-import__summary-change',
                    onClick:   function () { setPhase('pick'); setResult(null); },
                  }, 'Change file'),
                ),

                /* Errors + warnings */
                React.createElement(ValidationReport, {
                  errors:   result.errors,
                  warnings: result.warnings,
                }),

                /* Preview table */
                result.parents.length + result.leaves.length > 0
                  ? React.createElement(PreviewTable, {
                      parents: result.parents,
                      leaves:  result.leaves,
                    })
                  : null,

                /* Warning about full replace */
                !hasErrors && React.createElement('p', { className: 'fs-prog-import__replace-note' },
                  'Confirming will replace the entire programme with the imported data. ' +
                  'This cannot be undone (mock mode — reload resets to fixture).'),

                /* Footer actions */
                React.createElement('div', { className: 'fs-prog-import__footer' },
                  Button
                    ? React.createElement(Button, {
                        variant: 'secondary',
                        size:    'sm',
                        onClick: onClose,
                      }, 'Cancel')
                    : React.createElement('button', { type: 'button', onClick: onClose }, 'Cancel'),
                  Button
                    ? React.createElement(Button, {
                        variant:  'primary',
                        size:     'sm',
                        disabled: !!hasErrors || taskCount === 0,
                        onClick:  handleConfirm,
                      }, hasErrors ? 'Fix errors to import' : 'Import ' + taskCount + ' rows')
                    : React.createElement('button', {
                        type:     'button',
                        disabled: !!hasErrors || taskCount === 0,
                        onClick:  handleConfirm,
                      }, 'Import'),
                ),
              ),
        )
      : null; /* ModalOverlay not yet loaded */
  }

  /* --- export -------------------------------------------------------------- */
  window.FieldSight = window.FieldSight || {};
  window.FieldSight.ProgrammeImportModal = ProgrammeImportModal;

}());
