/* ==========================================================================
   FieldSight ProgrammeTodoList — Layer 5 composite (Sprint 4.4)
   --------------------------------------------------------------------------
   Jira / MS Planner-style breakdown of programme tasks by time bucket.
   Renders three sections:

     • This Week    — tasks active any time within Mon–Sun of `today`
     • Next Week    — tasks active any time within the following Mon–Sun
     • Later        — everything beyond next week

   Past-completed tasks are hidden by default (only "active or future"
   are interesting from a TO-DO perspective).

   Each row reuses TaskCard's visual rhythm via inline-rendering — we
   don't reuse TaskCard directly because Programme tasks carry a
   different field shape and we want compact rows here. Click → page
   selects the task and the right pane drills in.

   Props:
     tasks        full leaf tasks array (already worker-scoped)
     today        ISO 'YYYY-MM-DD'
     onSelect     (task) => void
     selectedId   string | null
     criticalSet  Set<task_id> — for highlighting

   Exported to:
     window.FieldSight.ProgrammeTodoList
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function startOfWeekISO(iso) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    var dow = d.getUTCDay();           /* 0 = Sun, 1 = Mon, ... */
    var shift = dow === 0 ? 6 : dow - 1;
    return window.FS.api.addDaysISO(iso, -shift);
  }

  function endOfWeekISO(iso) {
    var sow = startOfWeekISO(iso);
    return window.FS.api.addDaysISO(sow, 6);
  }

  function rangeOverlap(task, from, to) {
    return !(task.end < from || task.start > to);
  }

  function fmtRange(start, end) {
    var p1 = start.split('-').map(Number);
    var p2 = end.split('-').map(Number);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p1[2] + ' ' + months[p1[1] - 1]
        + ' → ' + p2[2] + ' ' + months[p2[1] - 1];
  }

  function ProgrammeTodoList(props) {
    var fs    = window.FieldSight;
    var Badge = fs.Badge;

    var tasks       = props.tasks       || [];
    var today       = props.today       || '';
    var criticalSet = props.criticalSet || new Set();
    var selectedId  = props.selectedId  || null;

    var thisWeekStart = startOfWeekISO(today);
    var thisWeekEnd   = endOfWeekISO(today);
    var nextWeekStart = window.FS.api.addDaysISO(thisWeekEnd, 1);
    var nextWeekEnd   = window.FS.api.addDaysISO(nextWeekStart, 6);

    var buckets = {
      thisWeek: [],
      nextWeek: [],
      later:    [],
    };
    tasks.forEach(function (t) {
      if (t.status === 'group') return;
      if (t.status === 'completed' && t.end < today) return;
      if (rangeOverlap(t, thisWeekStart, thisWeekEnd)) {
        buckets.thisWeek.push(t);
      } else if (rangeOverlap(t, nextWeekStart, nextWeekEnd)) {
        buckets.nextWeek.push(t);
      } else if (t.start > nextWeekEnd) {
        buckets.later.push(t);
      }
    });

    function renderBucket(label, key, items, sublabel) {
      if (items.length === 0) {
        return React.createElement('div', { className: 'fs-prog-todo__bucket' },
          React.createElement('div', { className: 'fs-prog-todo__bucket-header' },
            React.createElement('span', { className: 'fs-prog-todo__bucket-title' }, label),
            sublabel ? React.createElement('span', {
              className: 'fs-prog-todo__bucket-sub',
            }, sublabel) : null,
            React.createElement('span', {
              className: 'fs-prog-todo__bucket-count',
            }, '0'),
          ),
          React.createElement('div', { className: 'fs-prog-todo__empty' },
            'Nothing scheduled.'),
        );
      }
      return React.createElement('div', { className: 'fs-prog-todo__bucket' },
        React.createElement('div', { className: 'fs-prog-todo__bucket-header' },
          React.createElement('span', { className: 'fs-prog-todo__bucket-title' }, label),
          sublabel ? React.createElement('span', {
            className: 'fs-prog-todo__bucket-sub',
          }, sublabel) : null,
          React.createElement('span', {
            className: 'fs-prog-todo__bucket-count',
          }, items.length),
        ),
        React.createElement('div', { className: 'fs-prog-todo__items' },
          items.map(function (t) {
            var isCritical = criticalSet.has(t.task_id);
            var isSelected = selectedId === t.task_id;
            return React.createElement('div', {
              key:       t.task_id,
              className: 'fs-prog-todo__item'
                         + (isCritical ? ' fs-prog-todo__item--critical' : '')
                         + (isSelected ? ' fs-prog-todo__item--selected' : ''),
              role:      'button',
              tabIndex:  0,
              onClick:   function () { if (props.onSelect) props.onSelect(t); },
            },
              React.createElement('div', { className: 'fs-prog-todo__item-main' },
                React.createElement('div', { className: 'fs-prog-todo__item-name' },
                  t.wbs ? React.createElement('span', {
                    className: 'fs-prog-todo__item-wbs',
                  }, t.wbs) : null,
                  t.name),
                React.createElement('div', { className: 'fs-prog-todo__item-meta' },
                  React.createElement('span', null, fmtRange(t.start, t.end)),
                  (t.assignees || []).length
                    ? React.createElement('span', null,
                        (t.assignees[0] || '').replace(/_/g, ' ')
                          + (t.assignees.length > 1 ? ' +' + (t.assignees.length - 1) : ''))
                    : null,
                ),
              ),
              React.createElement('div', { className: 'fs-prog-todo__item-side' },
                isCritical
                  ? React.createElement(Badge, {
                      tone: 'danger', size: 'sm', variant: 'subtle',
                    }, 'Critical')
                  : null,
                React.createElement(Badge, {
                  tone:    t.status === 'completed'  ? 'success'
                         : t.status === 'in_progress'? 'info'
                         : t.status === 'blocked'    ? 'danger'
                         : t.status === 'delayed'    ? 'warning'
                         : 'neutral',
                  size:    'sm', variant: 'subtle',
                }, ({
                  not_started: 'Not started',
                  in_progress: 'In progress',
                  completed:   'Done',
                  blocked:     'Blocked',
                  delayed:     'Delayed',
                })[t.status] || t.status),
              ),
            );
          }),
        ),
      );
    }

    return React.createElement('div', { className: 'fs-prog-todo' },
      renderBucket('This week', 'thisWeek', buckets.thisWeek,
        fmtRange(thisWeekStart, thisWeekEnd)),
      renderBucket('Next week', 'nextWeek', buckets.nextWeek,
        fmtRange(nextWeekStart, nextWeekEnd)),
      renderBucket('Later', 'later', buckets.later, null),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ProgrammeTodoList = ProgrammeTodoList;
})();
