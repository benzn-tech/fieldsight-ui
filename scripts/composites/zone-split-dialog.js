/* ==========================================================================
   FieldSight — split one contract task into zones
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-breakdown-allocation-design.md §4
   Plan: docs/superpowers/plans/2026-08-03-programme-breakdown-allocation.md Task 5

   "可能是按 level 来的，可能是按 area 或者是 Grades to Grades。把一个大的
   building 分成五块，分给五个不同的 Site Manager。"

   All of the judgement lives in window.FS.api.programmeZoneSplit.planZoneSplit.
   This component collects input, shows the plan it produces, and writes only
   what the user then accepts. It must not decide anything about dates.

   Two rules it exists to honour:

     Parallel is preselected. Five zones handed to five site managers run at
     the same time — that is what the five managers are for — and dividing
     the parent's span would invent a sequence nobody stated, on real
     people's dates. Sequential is offered, and labelled with what it does.

     Nothing is written until Split is pressed, and nothing at all is written
     when the plan is not `ok`. The check is on `ok`, never on
     children.length: a failed plan returns no children today, so checking
     the array happens to be safe, but that is an accident rather than a
     contract.

   Exported to window.FieldSight.ZoneSplitDialog
   ========================================================================== */

(function () {
  'use strict';

  function ZoneSplitDialog(props) {
    var React = window.React;
    var fs    = window.FieldSight;
    var Modal = fs.ModalOverlay;

    var task = props.task || {};

    var zonesRef   = React.useState('');
    var zonesText  = zonesRef[0];
    var setZones   = zonesRef[1];

    var distRef    = React.useState('parallel');
    var distribute = distRef[0];
    var setDist    = distRef[1];

    var busyRef    = React.useState(false);
    var busy       = busyRef[0];
    var setBusy    = busyRef[1];

    var errRef     = React.useState(null);
    var writeError = errRef[0];
    var setWriteError = errRef[1];

    /* One zone per line. A textarea rather than a repeater because the input
       is genuinely a list of names people paste from a schedule. */
    var zones = zonesText.split('\n').map(function (z) { return z.trim(); })
                         .filter(Boolean);

    var api  = window.FS.api.programmeZoneSplit;
    var plan = React.useMemo(function () {
      if (!api || !zones.length) return null;
      return api.planZoneSplit(task, { zones: zones, distribute: distribute });
    }, [zonesText, distribute, task && task.task_id]);

    var overrun = plan && plan.ok && api
      ? api.overrunDays(task, plan.children) : 0;

    function onSplit() {
      /* `ok`, not children.length — see the module header. */
      if (!plan || !plan.ok || busy) return;
      setBusy(true);
      setWriteError(null);
      Promise.resolve(props.onSplit(plan.children))
        .then(function () { setBusy(false); if (props.onClose) props.onClose(); })
        .catch(function (e) {
          setBusy(false);
          setWriteError((e && e.message) || 'Could not create the zones.');
        });
    }

    return React.createElement(Modal, {
      open:  !!props.open,
      title: 'Split into zones',
      onClose: props.onClose,
    },
      React.createElement('div', { className: 'fs-zone-split' },
        React.createElement('div', { className: 'fs-zone-split__task' },
          task.name || task.task_id),

        React.createElement('label', { className: 'fs-zone-split__label' },
          'Zones, one per line'),
        React.createElement('textarea', {
          className:   'fs-zone-split__zones',
          rows:        5,
          value:       zonesText,
          placeholder: 'Level 1\nLevel 2\nGrid A-E',
          onChange:    function (e) { setZones(e.target.value); },
        }),

        React.createElement('div', { className: 'fs-zone-split__modes' },
          React.createElement('label', null,
            React.createElement('input', {
              type: 'radio', name: 'fs-zone-dist', value: 'parallel',
              checked: distribute === 'parallel',
              onChange: function () { setDist('parallel'); },
            }),
            ' At the same time — every zone keeps the task’s dates'),
          React.createElement('label', null,
            React.createElement('input', {
              type: 'radio', name: 'fs-zone-dist', value: 'sequential',
              checked: distribute === 'sequential',
              onChange: function () { setDist('sequential'); },
            }),
            /* Named for what it DOES to the dates, because it is the option
               that invents an order. */
            ' One after another — divides the task’s dates between them'),
        ),

        /* Errors verbatim: planZoneSplit writes them for the person who
           typed the input, and rewording them here would lose that. */
        plan && !plan.ok
          ? React.createElement('ul', { className: 'fs-zone-split__errors' },
              plan.errors.map(function (e, i) {
                return React.createElement('li', { key: i }, e);
              }))
          : null,

        plan && plan.ok
          ? React.createElement('div', { className: 'fs-zone-split__preview' },
              React.createElement('div', { className: 'fs-zone-split__preview-head' },
                plan.children.length + ' zones will be created under this task'),
              React.createElement('ul', null,
                plan.children.map(function (c, i) {
                  return React.createElement('li', { key: i },
                    React.createElement('span', null, c.name),
                    React.createElement('span', { className: 'fs-zone-split__dates' },
                      c.start_date + ' → ' + c.end_date));
                })))
          : null,

        /* The parent is NOT recomputed from its children (Project 1 §5), so
           an internal plan running past the contract end is stated, never
           corrected. That divergence is the point. */
        overrun > 0
          ? React.createElement('div', { className: 'fs-zone-split__overrun' },
              'This runs ' + overrun + ' day' + (overrun === 1 ? '' : 's')
              + ' past the contract end date. The contract dates are left '
              + 'as the client issued them.')
          : null,

        writeError
          ? React.createElement('div', { className: 'fs-zone-split__errors' }, writeError)
          : null,

        React.createElement('div', { className: 'fs-zone-split__actions' },
          React.createElement('button', {
            type: 'button', className: 'fs-btn fs-btn--ghost',
            onClick: props.onClose, disabled: busy,
          }, 'Cancel'),
          React.createElement('button', {
            type: 'button', className: 'fs-btn fs-btn--primary',
            disabled: !plan || !plan.ok || busy,
            onClick: onSplit,
          }, busy ? 'Creating…' : 'Split')),
      ));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ZoneSplitDialog = ZoneSplitDialog;
})();
