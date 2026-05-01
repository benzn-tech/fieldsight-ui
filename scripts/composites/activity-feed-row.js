/* ==========================================================================
   FieldSight ActivityFeedRow — Layer 5 composite (Sprint 4.1)
   --------------------------------------------------------------------------
   Multi-day variant of ActivityCard for the /activity page. The
   difference: feed rows span days, so they don't carry a "12m ago"
   relative time — they carry a clock time (HH:MM) and the date is
   rendered as a section header upstream by the Activity page.

   This composite is intentionally narrow — it doesn't own date
   grouping. The page groups rows by date and renders a header
   between groups; each row inside a group only shows the time.

   Props:
     row         { id, time_label, speaker, snippet, category,
                   topic_id, user_folder, user_name }
     selected    boolean — applies a selected style
     onSelect    (row) => void — click handler

   Exported to:
     window.FieldSight.ActivityFeedRow
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function ActivityFeedRow(props) {
    var Card          = window.FieldSight.Card;
    var Avatar        = window.FieldSight.Avatar;
    var CategoryBadge = window.FieldSight.CategoryBadge;

    var row      = props.row || {};
    var onSelect = props.onSelect;
    var selected = !!props.selected;

    var className = 'fs-activity-feed-row'
      + (selected ? ' fs-activity-feed-row--selected' : '');

    return React.createElement(Card, {
      padding:   'sm',
      onClick:   onSelect ? function () { onSelect(row); } : undefined,
      className: className,
    },
      React.createElement(Card.Body, null,
        React.createElement('div', { className: 'fs-activity-feed-row__layout' },

          React.createElement('div', { className: 'fs-activity-feed-row__time' },
            row.time_label || '—'),

          React.createElement(Avatar, { name: row.speaker || '—', size: 'sm' }),

          React.createElement('div', { className: 'fs-activity-feed-row__main' },
            row.snippet
              ? React.createElement('div', {
                  className: 'fs-activity-feed-row__snippet',
                }, row.snippet)
              : null,
            React.createElement('div', { className: 'fs-activity-feed-row__meta' },
              React.createElement('span', null, row.speaker || '—'),
              row.user_name && row.user_name !== row.speaker
                ? React.createElement('span', null, row.user_name)
                : null,
            ),
          ),

          row.category && CategoryBadge
            ? React.createElement('div', { className: 'fs-activity-feed-row__badge' },
                React.createElement(CategoryBadge, { category: row.category }))
            : null,
        ),
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ActivityFeedRow = ActivityFeedRow;
})();
