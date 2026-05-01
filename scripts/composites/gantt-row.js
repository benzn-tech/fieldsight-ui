/* ==========================================================================
   FieldSight GanttRow — Layer 5 composite (Sprint 4.4)
   --------------------------------------------------------------------------
   One timeline-side row: a horizontal bar at (start - programmeStart)
   pixels offset, of width (duration_days × pixelsPerDay). Click selects
   the task.

   Bar visual:
     • Status colour (completed / in_progress / blocked / delayed /
       not_started / group)
     • Critical-path tasks get a danger-tone stripe
     • Progress fills the bar from the left as a darker overlay
     • Group rows render a thinner summary bar with rolled-up dates

   Props:
     task            { task_id, start, end, duration_days,
                        progress_pct, status, ... }
     programmeStart  ISO date — origin
     pixelsPerDay    number
     critical        boolean
     selected        boolean
     onSelect        (task) => void

   Exported to:
     window.FieldSight.GanttRow
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function diffDays(fromISO, toISO) {
    var a = new Date(fromISO + 'T00:00:00Z').getTime();
    var b = new Date(toISO   + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
  }

  function GanttRow(props) {
    var t        = props.task;
    var origin   = props.programmeStart;
    var ppd      = props.pixelsPerDay || 24;
    var critical = !!props.critical;
    var selected = !!props.selected;

    if (!t || !t.start || !t.end) {
      return React.createElement('div', { className: 'fs-gantt-row' });
    }

    var startOffset = Math.max(0, diffDays(origin, t.start)) * ppd;
    var widthDays   = diffDays(t.start, t.end) + 1;
    var width       = Math.max(ppd * 0.5, widthDays * ppd);
    var progress    = Math.max(0, Math.min(100, t.progress_pct || 0));

    var isGroup = t.status === 'group';
    var barClass = 'fs-gantt-bar'
      + ' fs-gantt-bar--' + (t.status || 'not_started')
      + (critical ? ' fs-gantt-bar--critical' : '')
      + (selected ? ' fs-gantt-bar--selected' : '')
      + (isGroup  ? ' fs-gantt-bar--group'    : '');

    return React.createElement('div', {
      className: 'fs-gantt-row',
      onClick:   function () { if (props.onSelect) props.onSelect(t); },
    },
      React.createElement('div', {
        className: barClass,
        style:     { left: startOffset + 'px', width: width + 'px' },
        title:     t.name + '  (' + t.start + ' → ' + t.end + ')',
      },
        progress > 0 && !isGroup ? React.createElement('div', {
          className: 'fs-gantt-bar__progress',
          style:     { width: progress + '%' },
        }) : null,

        width > 60 ? React.createElement('span', {
          className: 'fs-gantt-bar__label',
        }, t.name) : null,
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.GanttRow = GanttRow;
})();
