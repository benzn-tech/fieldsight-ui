/* ==========================================================================
   FieldSight SiteCard — Layer 5 composite (Sprint 4.0)
   --------------------------------------------------------------------------
   Renders one site as a clickable Card row on the /sites page:

     Header   : site name + location + client
     KPI strip: users · open action items · last activity date

   Mirrors the visual pattern of TaskCard / UrgentCard so the Sites
   page feels consistent with the rest of the prototype.

   Props:
     site       { site_id, name, location, client, user_count, company_name }
     kpi        { open?, lastActivity? } — derived in the page from the
                item-store portfolio rollup (open_actions / last_activity_at)
     selected   boolean — applies a selected style to the card
     onSelect   (site) => void — click handler

   Exported to:
     window.FieldSight.SiteCard
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '—';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  function SiteCard(props) {
    var Card   = window.FieldSight.Card;
    var Badge  = window.FieldSight.Badge;
    var Avatar = window.FieldSight.Avatar;

    var site     = props.site || {};
    var kpi      = props.kpi  || {};
    var selected = !!props.selected;
    var onSelect = props.onSelect;

    var className = 'fs-site-card' + (selected ? ' fs-site-card--selected' : '');

    return React.createElement(Card, {
      padding:   'sm',
      onClick:   onSelect ? function () { onSelect(site); } : undefined,
      className: className,
    },
      React.createElement(Card.Body, null,
        React.createElement('div', { className: 'fs-site-card__header' },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
            Avatar ? React.createElement(Avatar, { name: site.name || site.site_id, src: site.icon || undefined, size: 'sm', shape: 'square' }) : null,
            React.createElement('div', { className: 'fs-site-card__main' },
              React.createElement('div', { className: 'fs-site-card__name' },
                site.name || site.site_id),
              React.createElement('div', { className: 'fs-site-card__sub' },
                [site.location, site.client].filter(Boolean).join(' · ')),
              /* #2 company tag — which company owns this site. Cross-company
                 platform_admin sees varied companies; a single-company admin
                 sees their own. Only rendered when the API supplies it. */
              (Badge && site.company_name) ? React.createElement('div', { style: { marginTop: '4px' } },
                React.createElement(Badge, { tone: 'info', size: 'sm', variant: 'subtle' },
                  site.company_name)
              ) : null,
            ),
          ),
          site.archived ? React.createElement(Badge, {
            tone: 'neutral', size: 'sm', variant: 'subtle',
          }, 'Archived') : null,
          React.createElement('div', { className: 'fs-site-card__chev' }, '›'),
        ),

        React.createElement('div', { className: 'fs-site-card__kpis' },
          React.createElement(Kpi, {
            label: 'Users',
            value: site.user_count != null ? site.user_count : '—',
          }),
          React.createElement(Kpi, {
            label: 'Open',
            value: kpi.open != null ? kpi.open : 0,
          }),
          React.createElement(Kpi, {
            label: 'Last activity',
            value: fmtDate(kpi.lastActivity),
            mono:  true,
          }),
        ),
      ),
    );
  }

  function Kpi(props) {
    return React.createElement('div', { className: 'fs-site-card__kpi' },
      React.createElement('span', {
        className: 'fs-site-card__kpi-value' + (props.mono ? ' fs-site-card__kpi-value--mono' : ''),
      }, props.value),
      React.createElement('span', { className: 'fs-site-card__kpi-label' },
        props.label),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.SiteCard = SiteCard;
})();
