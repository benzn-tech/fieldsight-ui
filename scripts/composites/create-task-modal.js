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
                                 onClose.
     siteId     string        — current site context, kept for prop-shape
                                 parity with quality/safety create-modals.
                                 NOT sent to createAction today — standalone
                                 tasks have no site-scoped backend yet, see
                                 the TOPIC-SCOPING NOTE below.

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

   *** TOPIC-SCOPING NOTE — read before wiring this modal up further ***
   window.FS.api.actions.createAction(payload) (scripts/api/actions.js) is
   built around the report/topic-scoped action-item model: the real
   POST /actions body is { date, topic_id, action_index, action_text,
   responsible, ... } (BACKEND-CONTEXT §4.10) and its MOCK branch keys the
   write as actionKey(user_folder, topic_id, action_index) into
   state[date]. A standalone task (this modal) has no real topic to scope
   to, so this file fabricates placeholder keys — topic_id: -1 (mirrors
   quality-create-modal.js's manual/no-topic rows, which use the same -1
   sentinel), action_index: 0, and date: today (NZDT) — purely so
   createAction has somewhere to land the write.

   On the dev site (writeMocks=true) this demos end-to-end (toast +
   onCreated + close), but the new task will NOT show up in /tasks or
   /today's lists: both read action items OFF the daily-report topics
   returned by getTimeline / getActionsResolvedRange, not off this
   standalone actions.state map — there is no code path that surfaces a
   topic_id:-1 phantom row anywhere. Wiring that up is real backend +
   aggregator work (a genuine standalone-task data model), intentionally
   out of scope here.

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
    /* Reserved for when standalone tasks get real site scoping — see the
       TOPIC-SCOPING NOTE above. Not sent to createAction yet. */
    var siteId    = props.siteId    || '';

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
      if (!text) { setError('Task is required.'); return; }

      setStatus('submitting');
      setError('');

      var caller   = (window.AuthMock && window.AuthMock.currentUser) || {};
      var deadline = combineDeadline(form.due_date, form.due_time);

      /* See TOPIC-SCOPING NOTE above — topic_id/action_index/date are
         placeholders so createAction's mock write path has somewhere to
         land; topic_id -1 never denotes a real topic so this can't
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
        var res = await window.FS.api.actions.createAction(payload);
        if (res && (res._accessDenied || res._notFound)) {
          throw new Error(res.error || 'Could not create task — please retry');
        }

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
    var submitDisabled = isSubmitting || !form.task_text.trim();

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

      errorMsg
        ? React.createElement('div', { className: 'fs-create-task-modal__error', role: 'alert' }, errorMsg)
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
