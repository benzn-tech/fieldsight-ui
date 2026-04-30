/* ==========================================================================
   FieldSight MorningBriefCard — Layer 5 composite
   --------------------------------------------------------------------------
   Renders the AI-generated overnight briefing as an elevated Card with
   a bullet list and a "Read full brief" link.

   M-5 (post-merge review) wires the previously-stubbed actions:
     • Collapse / expand is now real local state (controlled mode is
       still supported by passing both `collapsed` + `onToggleCollapse`,
       in which case the card defers to the parent).
     • "Read full brief" navigates to the canonical `/timeline?date=…
       &user=…` view by default — the brief is a derived summary of
       that day's report, so the deep-dive surface is timeline. Parents
       can override with `onOpenFull` if they want a custom destination.

   Props:
     brief             { generatedAt, bullets: [string],
                         date?, userFolder? }   ← date / userFolder
                         enable the default "Read full brief" link
     collapsed         boolean — controlled mode (with onToggleCollapse)
     defaultCollapsed  boolean — initial state when uncontrolled
     onToggleCollapse  () => void — chevron handler (controlled mode)
     onOpenFull        () => void — overrides the default navigation

   Exported to:
     window.FieldSight.MorningBriefCard
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function MorningBriefCard(props) {
    var Card       = window.FieldSight.Card;
    var Button     = window.FieldSight.Button;
    var IconButton = window.FieldSight.IconButton;

    var brief             = props.brief || { bullets: [] };
    var controlled        = typeof props.collapsed === 'boolean'
                         && typeof props.onToggleCollapse === 'function';

    /* Local collapse state for the uncontrolled case (the default).
       Tracked even when controlled to keep the hook order stable. */
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

    function handleOpen() {
      if (typeof props.onOpenFull === 'function') {
        props.onOpenFull();
        return;
      }
      /* Default: navigate to the timeline view scoped to the brief's
         (date, user). When those aren't supplied (older callers), fall
         back to the parameter-less /timeline route which auto-resolves
         the most recent report. */
      var Router = window.FS && window.FS.Router;
      if (!Router) return;
      var qs = '';
      if (brief.date) qs += '?date=' + encodeURIComponent(brief.date);
      if (brief.userFolder) qs += (qs ? '&' : '?') + 'user=' + encodeURIComponent(brief.userFolder);
      Router.navigate('/timeline' + qs);
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
        subtitle: 'Generated from overnight transcripts · ' + (brief.generatedAt || ''),
        actions:  React.createElement(IconButton, {
          icon:      collapsed ? 'chevron-down' : 'chevron-up',
          ariaLabel: collapsed ? 'Expand brief'  : 'Collapse brief',
          size:      'sm',
          onClick:   handleToggle,
        }),
      }),

      !collapsed ? React.createElement(Card.Body, null,
        React.createElement('ul', { className: 'fs-morning-brief-card__bullets' },
          (brief.bullets || []).map(function(b, i) {
            return React.createElement('li', {
              key: i, className: 'fs-morning-brief-card__bullet',
            }, b);
          })
        ),
      ) : null,

      !collapsed ? React.createElement(Card.Footer, { align: 'start' },
        React.createElement(Button, {
          variant: 'tertiary', size: 'sm', rightIcon: 'arrow-right',
          onClick: handleOpen,
        }, 'Read full brief'),
      ) : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.MorningBriefCard = MorningBriefCard;
})();
