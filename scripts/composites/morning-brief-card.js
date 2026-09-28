/* ==========================================================================
   FieldSight MorningBriefCard — Layer 5 composite
   --------------------------------------------------------------------------
   Renders the AI-generated overnight briefing as an elevated Card with
   a bullet list. Collapse / expand is local state by default; pass
   both `collapsed` + `onToggleCollapse` to drive it from the parent.

   The CTA to open the full daily report is intentionally NOT inside
   this card — it's lifted to the Today page header
   (`.fs-today__view-report-cta` banner) so the action stands on its
   own and the brief stays a focused summary.

   Props:
     brief             { bullets: [string], date?, userFolder? }
     collapsed         boolean — controlled mode (with onToggleCollapse)
     defaultCollapsed  boolean — initial state when uncontrolled
     onToggleCollapse  () => void — chevron handler (controlled mode)

   Exported to:
     window.FieldSight.MorningBriefCard
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* '21 Sep 2026' — the local idiom (site-card.js, activity.js and six other
     composites each carry this same six-line formatter). Built from the ISO
     parts rather than new Date('YYYY-MM-DD'), which parses as UTC and reads
     back a day early in NZ (BUG-19). */
  function fmtDate(yyyymmdd) {
    var p = String(yyyymmdd || '').split('-').map(Number);
    if (p.length !== 3 || p.some(isNaN)) return String(yyyymmdd || '');
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  /* What the subtitle may honestly say.

     It used to read 'Generated from overnight transcripts · 5:42 AM', where
     the time was a string literal in today-adapter.js — the same six
     characters on every card, on every day, for every user. The client has no
     generation timestamp to replace it with: the document's own
     `_report_metadata.generated_at` is not carried through the live shape,
     which sends `{source, version}` (lambda_org_api.py:6762).

     So the subtitle names the DAY the brief is about instead, which is the
     fact the card actually has — and the fact that explains why a brief read
     at 9am describes yesterday. */
  function briefSubtitle(brief) {
    var date = brief && brief.date;
    return date
      ? 'From your recordings on ' + fmtDate(date)
      : 'From your most recent recordings';
  }

  function MorningBriefCard(props) {
    var Card       = window.FieldSight.Card;
    var IconButton = window.FieldSight.IconButton;

    var brief             = props.brief || { bullets: [] };
    var bullets           = brief.bullets || [];
    var controlled        = typeof props.collapsed === 'boolean'
                         && typeof props.onToggleCollapse === 'function';

    var ref = React.useState(!!props.defaultCollapsed);
    var localCollapsed    = ref[0];
    var setLocalCollapsed = ref[1];

    var collapsed = controlled ? !!props.collapsed : localCollapsed;

    function handleToggle() {
      if (controlled) {
        props.onToggleCollapse();
      } else {
        setLocalCollapsed(function (c) { return !c; });
      }
    }

    var className = 'fs-morning-brief-card' +
      (collapsed ? ' fs-morning-brief-card--collapsed' : '');

    return React.createElement(Card, {
      variant:   'elevated',
      padding:   'md',
      className: className,
    },
      React.createElement(Card.Header, {
        title:    'Morning Brief',
        subtitle: briefSubtitle(brief),
        actions:  React.createElement(IconButton, {
          icon:      collapsed ? 'chevron-down' : 'chevron-up',
          ariaLabel: collapsed ? 'Expand brief'  : 'Collapse brief',
          size:      'sm',
          onClick:   handleToggle,
        }),
      }),

      /* An empty <ul> under a "Morning Brief" heading is what this card
         rendered every day before the date fix, and it reads as a broken
         feature rather than as a quiet day. The host (today.js) now only
         mounts the card when there are bullets; this says something true
         for any caller that does not. */
      !collapsed ? React.createElement(Card.Body, null,
        bullets.length
          ? React.createElement('ul', { className: 'fs-morning-brief-card__bullets' },
              bullets.map(function(b, i) {
                return React.createElement('li', {
                  key: i, className: 'fs-morning-brief-card__bullet',
                }, b);
              })
            )
          : React.createElement('p', { className: 'fs-morning-brief-card__empty' },
              'No recordings to brief from yet.'),
      ) : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.MorningBriefCard = MorningBriefCard;

  /* Expose the pure helper to Node's test runner only (CommonJS). No-op in
     the browser — mirrors composites/action-item-row.js's own guard. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { briefSubtitle: briefSubtitle };
  }
})();
