/* ==========================================================================
   FieldSight ProgrammeTaskEditor — Layer 5 composite (Sprint 5.1)
   --------------------------------------------------------------------------
   Modal form for editing a Programme leaf task. Mounted inside
   `ProgrammeRightDetail` and triggered by an Edit button next to the
   detail close (×). Commits via `ProgrammeProvider.editTask({task_id,
   patch})` (Sprint 5.1 reducer) — mock-only, mutates the in-memory
   leaves[] and re-publishes state.

   Form fields:
     • name                  (Input)
     • status                (Select; 5 enum values)
     • progress_pct          (Input type=number, 0–100)
     • start / end           (Input type=date)
     • assignees             (Input, comma-separated underscore folders)
     • tags                  (Input, comma-separated)
     • depends_on            (checkbox grid grouped by WBS parent)

   Why a plain `Input type="date"` rather than `DatePicker`: the existing
   DatePicker is wired to the report-day fixture (it queries
   /api/dates and only enables days that have reports). Programme task
   dates are independent of report days — using DatePicker would
   surface the wrong availability hints. Native date input is correct
   and lighter-weight here. (5.4 import flow can revisit if needed.)

   Pure validatePatch(patch, taskId) — exported for node tests:
     - name non-empty
     - start <= end
     - depends_on must not contain taskId (1-step cycle; full DAG
       check lives in 5.6 cascade engine)
     - progress_pct in [0, 100]

   Exported to:
     window.FieldSight.ProgrammeTaskEditor
     window.FieldSight._programmeEditor.validatePatch     (testing hook)
     window.FieldSight._programmeEditor.diffDays          (testing hook)
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var STATUS_OPTIONS = [
    { value: 'not_started', label: 'Not started' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'completed',   label: 'Done' },
    { value: 'blocked',     label: 'Blocked' },
    { value: 'delayed',     label: 'Delayed' },
  ];

  /* ---------- Pure helpers (node-testable) ----------------------------- */

  function diffDays(a, b) {
    var ms = new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime();
    return Math.round(ms / 86400000);
  }

  function validatePatch(patch, taskId) {
    var errors = {};
    if (patch.name !== undefined && !String(patch.name).trim()) {
      errors.name = 'Name is required.';
    }
    if (patch.start && patch.end && patch.start > patch.end) {
      errors.end = 'End must be on or after start.';
    }
    if (patch.depends_on && taskId && patch.depends_on.indexOf(taskId) !== -1) {
      errors.depends_on = 'A task cannot depend on itself.';
    }
    if (patch.progress_pct !== undefined) {
      var n = Number(patch.progress_pct);
      if (Number.isNaN(n) || n < 0 || n > 100) {
        errors.progress_pct = 'Progress must be 0–100.';
      }
    }
    if (Object.keys(errors).length === 0) {
      var normalized = Object.assign({}, patch);
      if (patch.start && patch.end) {
        normalized.duration_days = diffDays(patch.start, patch.end) + 1;
      }
      return { ok: true, errors: {}, normalized: normalized };
    }
    return { ok: false, errors: errors, normalized: null };
  }

  /* ---------- ProgrammeTaskEditor -------------------------------------- */

  function ProgrammeTaskEditor(props) {
    var fs           = window.FieldSight;
    var Modal        = fs.ModalOverlay;
    var Input        = fs.Input;
    var Select       = fs.Select;
    var Button       = fs.Button;

    var open    = !!props.open;
    var task    = props.task || null;
    var leaves  = props.leaves || [];
    var parents = props.parents || [];
    var onClose = props.onClose || function () {};
    var onSubmit = props.onSubmit || function () {};

    /* Form state — string-only, mirrored from props.task on each open. */
    var initial = React.useMemo(function () {
      if (!task) return null;
      return {
        name:         task.name || '',
        status:       task.status || 'not_started',
        progress_pct: String(task.progress_pct == null ? 0 : task.progress_pct),
        start:        task.start || '',
        end:          task.end   || '',
        assignees:    (task.assignees || []).join(', '),
        tags:         (task.tags || []).join(', '),
        depends_on:   (task.depends_on || []).slice(),
      };
    }, [task && task.task_id, open]);

    var refForm = React.useState(initial);
    var form    = refForm[0];
    var setForm = refForm[1];

    var refErrors = React.useState({});
    var errors    = refErrors[0];
    var setErrors = refErrors[1];

    React.useEffect(function () { setForm(initial); setErrors({}); }, [initial]);

    if (!open || !task || !form) {
      /* Always render the modal so backdrop animates; no task = bail. */
      if (Modal) {
        return React.createElement(Modal, {
          open: false, onClose: onClose, title: 'Edit task',
        });
      }
      return null;
    }

    function set(field, value) {
      setForm(Object.assign({}, form, (function () { var o = {}; o[field] = value; return o; })()));
    }

    function toggleDep(depId) {
      var has = form.depends_on.indexOf(depId) !== -1;
      var next = has
        ? form.depends_on.filter(function (x) { return x !== depId; })
        : form.depends_on.concat([depId]);
      set('depends_on', next);
    }

    function commit() {
      var patch = {
        name:         form.name.trim(),
        status:       form.status,
        progress_pct: Number(form.progress_pct),
        start:        form.start,
        end:          form.end,
        assignees:    splitCsv(form.assignees),
        tags:         splitCsv(form.tags),
        depends_on:   form.depends_on.slice(),
      };
      var result = validatePatch(patch, task.task_id);
      if (!result.ok) { setErrors(result.errors); return; }
      onSubmit({ task_id: task.task_id, patch: result.normalized });
    }

    /* Group leaves by parent WBS for the depends_on checkbox grid. */
    var depGroups = parents.map(function (p) {
      return {
        parent: p,
        items:  leaves.filter(function (t) {
          return t.parent_id === p.task_id && t.task_id !== task.task_id;
        }),
      };
    }).filter(function (g) { return g.items.length > 0; });

    return React.createElement(Modal, {
      open:            true,
      onClose:         onClose,
      title:           'Edit task · ' + task.task_id,
      size:            'lg',
      closeOnBackdrop: false,           /* protect unsaved input */
    },
      React.createElement('div', { className: 'fs-task-editor' },

        React.createElement('div', { className: 'fs-task-editor__row' },
          React.createElement(Input, {
            label:    'Name', required: true, fullWidth: true,
            value:    form.name,
            error:    errors.name,
            onChange: function (e) { set('name', e.target.value); },
          }),
        ),

        React.createElement('div', { className: 'fs-task-editor__row fs-task-editor__row--split' },
          React.createElement(Select, {
            label:    'Status',
            value:    form.status,
            options:  STATUS_OPTIONS,
            onChange: function (e) { set('status', e.target.value); },
          }),
          React.createElement(Input, {
            label:    'Progress (%)', type: 'number',
            value:    form.progress_pct,
            error:    errors.progress_pct,
            onChange: function (e) { set('progress_pct', e.target.value); },
          }),
        ),

        React.createElement('div', { className: 'fs-task-editor__row fs-task-editor__row--split' },
          React.createElement(Input, {
            label:    'Start', type: 'date',
            value:    form.start,
            onChange: function (e) { set('start', e.target.value); },
          }),
          React.createElement(Input, {
            label:    'End', type: 'date',
            value:    form.end,
            error:    errors.end,
            onChange: function (e) { set('end', e.target.value); },
          }),
        ),

        React.createElement('div', { className: 'fs-task-editor__row' },
          React.createElement(Input, {
            label:    'Assignees', fullWidth: true,
            hint:     'Comma-separated (e.g. Jarley_Trainor, Ben_Lin)',
            value:    form.assignees,
            onChange: function (e) { set('assignees', e.target.value); },
          }),
        ),
        React.createElement('div', { className: 'fs-task-editor__row' },
          React.createElement(Input, {
            label:    'Tags', fullWidth: true,
            hint:     'Comma-separated (e.g. safety_critical, milestone)',
            value:    form.tags,
            onChange: function (e) { set('tags', e.target.value); },
          }),
        ),

        /* Depends-on checkbox grid */
        React.createElement('div', { className: 'fs-task-editor__deps' },
          React.createElement('div', { className: 'fs-task-editor__deps-label' },
            'Depends on'),
          errors.depends_on
            ? React.createElement('div', { className: 'fs-task-editor__deps-error' },
                errors.depends_on)
            : null,
          depGroups.length === 0
            ? React.createElement('div', { className: 'fs-task-editor__deps-empty' },
                'No other tasks available.')
            : depGroups.map(function (g) {
                return React.createElement('div', {
                  key:       g.parent.task_id,
                  className: 'fs-task-editor__deps-group',
                },
                  React.createElement('div', { className: 'fs-task-editor__deps-group-label' },
                    g.parent.wbs + ' · ' + g.parent.name),
                  React.createElement('div', { className: 'fs-task-editor__deps-grid' },
                    g.items.map(function (t) {
                      var checked = form.depends_on.indexOf(t.task_id) !== -1;
                      return React.createElement('label', {
                        key:       t.task_id,
                        className: 'fs-task-editor__dep' + (checked ? ' fs-task-editor__dep--on' : ''),
                      },
                        React.createElement('input', {
                          type:     'checkbox',
                          checked:  checked,
                          onChange: function () { toggleDep(t.task_id); },
                        }),
                        React.createElement('span', { className: 'fs-task-editor__dep-id' },
                          t.task_id),
                        React.createElement('span', { className: 'fs-task-editor__dep-name' },
                          t.name),
                      );
                    }),
                  ),
                );
              }),
        ),

        /* Footer */
        React.createElement('div', { className: 'fs-task-editor__footer' },
          React.createElement(Button, {
            variant: 'ghost', onClick: onClose,
          }, 'Cancel'),
          React.createElement(Button, {
            variant: 'primary', onClick: commit,
          }, 'Save'),
        ),
      ),
    );
  }

  function splitCsv(s) {
    return String(s || '')
      .split(',')
      .map(function (x) { return x.trim(); })
      .filter(Boolean);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ProgrammeTaskEditor = ProgrammeTaskEditor;
  window.FieldSight._programmeEditor = {
    validatePatch: validatePatch,
    diffDays:      diffDays,
  };
})();
