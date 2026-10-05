/* ==========================================================================
   FieldSight · CreateTaskModal — feat/editable-tasks-ui
   --------------------------------------------------------------------------
   Modal form for creating a new standalone task. Opened by the
   "+ New task" button on /tasks (TasksMiddleColumn toolbar).

   Props:
     open       boolean       — the page only mounts this component while
                                 true (same conditional-mount pattern as
                                 QualityCreateModal — see tasks.js wiring),
                                 forwarded straight through to ModalOverlay.
     onClose    fn()          — dismiss without persisting (Cancel /
                                 backdrop / ESC).
     onCreated  fn(newAction) — called after a successful create, BEFORE
                                 onClose. Mock mode only (see below).
     siteId     string        — current site context, kept for prop-shape
                                 parity with quality/safety create-modals.
                                 Unused today — standalone tasks have no
                                 site-scoped backend yet.

   Fields:
     Task        Input, required (Submit disabled while empty)
     Priority    Select: low | medium | high, default medium
     Due date    Input[type=date] — BUG-19: native date input value is
                 already 'YYYY-MM-DD' text; never `new Date(str)` it
     Due time    Input[type=time] — value 'HH:MM', optional
     (Assignee intentionally SKIPPED this round — would need a member-list
     fetch like QualityCreateModal's Project select; out of scope to keep
     this modal tight. `responsible` defaults to the current caller below.)

   Submit combines due date + due time into a single free-text `deadline`
   (the shape FS.api.resolveDeadline already parses elsewhere):
     both      -> 'YYYY-MM-DD HH:MM'
     date only -> 'YYYY-MM-DD'
     neither   -> omitted from the payload entirely

   *** LIVE SUBMIT IS UNAVAILABLE — read before wiring this modal up ***
   There is no backend that creates a standalone task. The only writer this
   modal ever had was POST /actions on the legacy gateway, which has no
   handler for it (it never worked in live mode) and which is being retired
   along with the rest of that gateway. No org endpoint creates an
   action_items row from a bare form (PATCH /action-items/{id} edits an
   existing one; programme.createTask makes a programme task, a different
   model). So in live mode the form says so and Create is disabled; nothing
   is sent. Mock mode (useMocks or writeMocks) still demos end-to-end —
   toast + onCreated + close — but writes nothing anywhere, and the new task
   never shows up in /tasks or /today, which read action items off the
   daily-report topics. A real standalone-task data model is backend work.

   Mirrors scripts/composites/quality-create-modal.js's structure/idiom:
   ModalOverlay body, raw <input>/<select> elements + .fs-create-task-
   modal__* BEM classes (styles/composites.css), form state via
   React.useState, toast + onCreated + close on success.

   Exported to: window.FieldSight.CreateTaskModal
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var PRIORITIES = ['low', 'medium', 'high'];

  function CreateTaskModal(props) {
    var fs           = window.FieldSight;
    var ModalOverlay = fs.ModalOverlay;
    var Button       = fs.Button;

    var open      = !!props.open;
    var onClose   = props.onClose   || function () {};
    var onCreated = props.onCreated || function () {};
    /* Reserved for when standalone tasks get real site scoping. */
    var siteId    = props.siteId    || '';

    /* Live submit is unavailable (see the header note); only the mock demo
       can complete. */
    var api = window.FS && window.FS.api;
    var canSubmit = !!(api && (api.useMocks || api.writeMocks));
    var UNAVAILABLE_MSG = 'Creating a task from here is not available yet. '
      + 'Tasks come from your recordings.';

    var refForm = React.useState({
      task_text: '',
      priority:  'medium',
      due_date:  '',
      due_time:  '',
    });
    var form    = refForm[0];
    var setForm = refForm[1];

    var refStatus = React.useState('idle');
    var status    = refStatus[0];
    var setStatus = refStatus[1];

    var refError = React.useState('');
    var errorMsg = refError[0];
    var setError = refError[1];

    function set(field, value) {
      setForm(function (f) { return Object.assign({}, f, { [field]: value }); });
    }

    /* Combine due date + due time into the single free-text deadline
       string the action-item model expects. BUG-19: both fields are
       native <input type=date|time> values, already 'YYYY-MM-DD' /
       'HH:MM' text — never re-parse either one through `new Date()`. */
    function combineDeadline(date, time) {
      if (date && time) return date + ' ' + time;
      if (date) return date;
      return undefined;
    }

    async function handleSubmit(e) {
      e.preventDefault();
      var text = form.task_text.trim();
      if (!canSubmit) { setError(UNAVAILABLE_MSG); return; }
      if (!text) { setError('Task is required.'); return; }

      setStatus('submitting');
      setError('');

      var caller   = (window.AuthMock && window.AuthMock.currentUser) || {};
      var deadline = combineDeadline(form.due_date, form.due_time);

      /* Mock demo only. topic_id -1 never denotes a real topic so this can't
         collide with genuine report-derived action rows. */
      var payload = {
        action_text:  text,
        priority:     form.priority,
        date:         window.FS.api.todayNZDT(),
        topic_id:     -1,
        action_index: 0,
        user_folder:  caller.name ? window.FS.api.folderName(caller.name) : undefined,
        responsible:  caller.name || undefined,
      };
      if (deadline !== undefined) payload.deadline = deadline;

      try {
        await window.FS.api.delay(80);
        var res = { id: 'mock-task-' + Date.now() };

        var toast = window.FS && window.FS.toast;
        if (toast) toast.show({ message: 'Task created.', tone: 'success' });

        onCreated(Object.assign({ id: res && res.id }, payload));
        onClose();
      } catch (fetchErr) {
        setStatus('error');
        setError((fetchErr && fetchErr.message) || 'Failed to create task. Please try again.');
        var toast2 = window.FS && window.FS.toast;
        if (toast2) toast2.show({ message: (fetchErr && fetchErr.message) || 'Failed to create task', tone: 'error' });
      }
    }

    var isSubmitting   = status === 'submitting';
    var submitDisabled = isSubmitting || !canSubmit || !form.task_text.trim();

    var content = React.createElement('form', {
      className: 'fs-create-task-modal',
      onSubmit:  handleSubmit,
    },
      React.createElement('h2', { className: 'fs-create-task-modal__title' }, 'New Task'),

      /* Task */
      React.createElement('label', { className: 'fs-create-task-modal__field' },
        React.createElement('span', { className: 'fs-create-task-modal__label' },
          'Task ', React.createElement('span', { className: 'fs-create-task-modal__required' }, '*')),
        React.createElement('input', {
          type:        'text',
          className:   'fs-create-task-modal__input',
          value:       form.task_text,
          onChange:    function (e) { set('task_text', e.target.value); },
          placeholder: 'What needs to happen…',
          required:    true,
          disabled:    isSubmitting,
        }),
      ),

      /* Priority */
      React.createElement('label', { className: 'fs-create-task-modal__field' },
        React.createElement('span', { className: 'fs-create-task-modal__label' }, 'Priority'),
        React.createElement('select', {
          className: 'fs-create-task-modal__select',
          value:     form.priority,
          onChange:  function (e) { set('priority', e.target.value); },
          disabled:  isSubmitting,
        },
          PRIORITIES.map(function (p) {
            return React.createElement('option', { key: p, value: p },
              p.charAt(0).toUpperCase() + p.slice(1));
          }),
        ),
      ),

      /* Due date + due time */
      React.createElement('div', { className: 'fs-create-task-modal__row' },
        React.createElement('label', { className: 'fs-create-task-modal__field' },
          React.createElement('span', { className: 'fs-create-task-modal__label' }, 'Due date'),
          React.createElement('input', {
            type:      'date',
            className: 'fs-create-task-modal__input',
            value:     form.due_date,
            onChange:  function (e) { set('due_date', e.target.value); },
            disabled:  isSubmitting,
          }),
        ),
        React.createElement('label', { className: 'fs-create-task-modal__field' },
          React.createElement('span', { className: 'fs-create-task-modal__label' }, 'Due time'),
          React.createElement('input', {
            type:      'time',
            className: 'fs-create-task-modal__input',
            value:     form.due_time,
            onChange:  function (e) { set('due_time', e.target.value); },
            disabled:  isSubmitting,
          }),
        ),
      ),

      errorMsg || !canSubmit
        ? React.createElement('div', { className: 'fs-create-task-modal__error', role: 'alert' },
            errorMsg || UNAVAILABLE_MSG)
        : null,

      React.createElement('div', { className: 'fs-create-task-modal__actions' },
        Button
          ? React.createElement(Button, {
              type:     'button',
              variant:  'secondary',
              size:     'md',
              disabled: isSubmitting,
              onClick:  onClose,
            }, 'Cancel')
          : React.createElement('button', { type: 'button', onClick: onClose }, 'Cancel'),
        Button
          ? React.createElement(Button, {
              type:     'submit',
              variant:  'primary',
              size:     'md',
              disabled: submitDisabled,
            }, isSubmitting ? 'Creating…' : 'Create task')
          : React.createElement('button', { type: 'submit', disabled: submitDisabled },
              isSubmitting ? 'Creating…' : 'Create task'),
      ),
    );

    if (ModalOverlay) {
      return React.createElement(ModalOverlay, { open: open, onClose: onClose }, content);
    }
    return open ? React.createElement('div', { className: 'fs-modal-overlay__backdrop' }, content) : null;
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.CreateTaskModal = CreateTaskModal;

})();
