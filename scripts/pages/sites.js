/* ==========================================================================
   FieldSight Sites Page — Sprint 4.0
   --------------------------------------------------------------------------
   /sites — site-level dashboard.

   Middle column:
     • Header (title + total-sites count)
     • List of SiteCard rows, each with users/reports/latest KPI mini-strip
     • Click a site → right pane populates

   Right detail:
     • Selected site header (name, client, location)
     • Recent reports list (filter from /api/reports/history by site,
       top 5)
     • Users on site (from /api/site-users)
     • Click a user → navigate to /timeline?date=<latest>&user=<folder>

   Architecture:
     • SitesProvider owns the page state via SitesContext (mirrors
       TodayProvider from Sprint 3 P-07). AppShell wraps Middle +
       Right in this Provider via the page registry's Provider slot.
     • Worker role: site list reduced to the user's primary_site only
       (matches BACKEND-CONTEXT §3 worker-forced-self semantics).

   Registers as window.FieldSight.PAGES['/sites']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* ---------- Helpers --------------------------------------------------- */

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function unfolder(folder) {
    return (folder || '').replace(/_/g, ' ');
  }

  /* Bucket a flat reports[] array by site_id, sorted desc by date. */
  function bucketReportsBySite(reports) {
    var bucket = {};
    (reports || []).forEach(function (r) {
      var siteId = guessSiteIdFromReport(r);
      if (!siteId) return;
      (bucket[siteId] = bucket[siteId] || []).push(r);
    });
    Object.keys(bucket).forEach(function (k) {
      bucket[k].sort(function (a, b) {
        return (b.generated_at || '').localeCompare(a.generated_at || '');
      });
    });
    return bucket;
  }

  /* Reports carry a `site` field that holds the human site name
     (e.g. "SB1108 Ellesmere College"). Map it to a site_id by
     trying common shapes; gracefully degrades to no-bucket if the
     backend ever drops the field. */
  function guessSiteIdFromReport(r) {
    if (!r || !r.site) return null;
    var fixtures = (window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.sites) || { sites: [] };
    var hit = (fixtures.sites || []).filter(function (s) { return s.name === r.site; })[0];
    return hit ? hit.site_id : null;
  }

  /* ---------- SitesContext --------------------------------------------- */

  var SitesContext = React.createContext(null);

  function SitesProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var depKey = (caller.name || '') + '|' + (caller.role || '') + '|' + (caller.isAdmin ? 'admin' : '');

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    React.useEffect(function () {
      var cancelled = false;
      setState({ status: 'loading' });

      Promise.all([
        window.FS.api.sites.getSites(),
        window.FS.api.reports.getReportsHistory(50),
      ]).then(function (results) {
        if (cancelled) return;
        var sitesRes  = results[0];
        var reportsRes = results[1];

        if (sitesRes && sitesRes._accessDenied) {
          setState({ status: 'access_denied', message: sitesRes.error });
          return;
        }
        if (reportsRes && reportsRes._accessDenied) {
          setState({ status: 'access_denied', message: reportsRes.error });
          return;
        }

        /* Worker rule (§3): scope sites list to caller's primary site.
           Mock api doesn't enforce this; do it here so role rotation
           via the dev switcher behaves correctly in preview. */
        var allSites = (sitesRes && sitesRes.sites) || [];
        var sites    = allSites;
        if (caller.role === 'worker') {
          var fixtures = (window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.sites) || { users: [] };
          var match    = (fixtures.users || []).filter(function (u) { return u.name === caller.name; })[0];
          var primary  = match ? match.primary_site : null;
          if (primary) sites = sites.filter(function (s) { return s.site_id === primary; });
        }

        var reportsBySite = bucketReportsBySite((reportsRes && reportsRes.reports) || []);

        setState({
          status:        'ok',
          sites:         sites,
          reportsBySite: reportsBySite,
          role:          (sitesRes && sitesRes.role) || caller.role || '',
        });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load sites', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });

      return function () { cancelled = true; };
    }, [depKey, retryCount]);

    var ctx = {
      state: state,
      caller: caller,
      addSite: function (site) { setState(function (s) { return Object.assign({}, s, { sites: [site].concat(s.sites || []) }); }); },
    };
    return React.createElement(SitesContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- Shared form helpers (Phase B modals) --------------------- */
  function fFieldRow(label, control) {
    return React.createElement('div', { className: 'fs-settings__field-row' },
      React.createElement('label', { className: 'fs-settings__label' }, label),
      control);
  }
  function fText(value, onChange, type) {
    return React.createElement('input', {
      type: type || 'text', className: 'fs-settings__input', value: value || '',
      onChange: function (e) { onChange(e.target.value); },
    });
  }
  function fSelect(value, options, onChange) {
    return React.createElement('select', { className: 'fs-settings__select', value: value, onChange: function (e) { onChange(e.target.value); } },
      options.map(function (o) { return React.createElement('option', { key: o.v, value: o.v }, o.l); }));
  }

  /* ---------- NewProjectModal (Phase B — admin create project) --------- */
  function NewProjectModal(props) {
    var Modal = window.FieldSight && window.FieldSight.ModalOverlay;
    var refForm = React.useState({ name: '', location: '', region: 'south-island', client: '', project_value_nzd: '', planned_completion: '' });
    var form = refForm[0], setForm = refForm[1];
    var refBusy = React.useState(false); var busy = refBusy[0], setBusy = refBusy[1];
    var iconRef = React.useRef(null);
    var Avatar = window.FieldSight && window.FieldSight.Avatar;
    function set(k, v) { setForm(function (f) { var n = Object.assign({}, f); n[k] = v; return n; }); }
    function onPickIcon(e) { var f = e.target.files && e.target.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { set('icon', r.result); }; r.readAsDataURL(f); }
    function submit() {
      if (!form.name.trim() || busy) return;
      setBusy(true);
      window.FS.api.sites.createSite(form).then(function (site) {
        setBusy(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Project "' + site.name + '" created', tone: 'success' });
        if (props.onCreated) props.onCreated(site);
        if (props.onClose) props.onClose();
      }).catch(function () {
        setBusy(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Could not create project', tone: 'error' });
      });
    }
    if (!Modal) return null;
    return React.createElement(Modal, { open: true, size: 'md', title: 'New project', onClose: props.onClose },
      React.createElement('div', { className: 'fs-settings__pw-form' },
        fFieldRow('Project name *', fText(form.name, function (v) { set('name', v); })),
        fFieldRow('Project icon', React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          Avatar ? React.createElement(Avatar, { name: form.name || 'Project', src: form.icon || undefined, size: 'md', shape: 'square' }) : null,
          React.createElement('input', { type: 'file', accept: 'image/*', ref: iconRef, onChange: onPickIcon, style: { display: 'none' } }),
          React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm', onClick: function () { if (iconRef.current) iconRef.current.click(); } }, 'Upload icon')
        )),
        fFieldRow('Location', fText(form.location, function (v) { set('location', v); })),
        fFieldRow('Region', fSelect(form.region, [{ v: 'south-island', l: 'South Island' }, { v: 'north-island', l: 'North Island' }], function (v) { set('region', v); })),
        fFieldRow('Client', fText(form.client, function (v) { set('client', v); })),
        fFieldRow('Project value (NZD)', fText(form.project_value_nzd, function (v) { set('project_value_nzd', v); }, 'number')),
        fFieldRow('Planned completion', fText(form.planned_completion, function (v) { set('planned_completion', v); }, 'date')),
        React.createElement('div', { className: 'fs-settings__actions' },
          React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--md', onClick: props.onClose }, 'Cancel'),
          React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--primary fs-btn--md', disabled: busy, onClick: submit }, busy ? 'Creating…' : 'Create project')
        )
      )
    );
  }

  /* ---------- SitesMiddleColumn ---------------------------------------- */

  function SitesMiddleColumn(props) {
    var fs       = window.FieldSight;
    var SiteCard = fs.SiteCard;
    var onSelect = props.onSelect || function () {};

    var ctx = React.useContext(SitesContext);
    var nmRef = React.useState(false);
    var newOpen = nmRef[0], setNewOpen = nmRef[1];
    if (!ctx) {
      console.warn('[SitesMiddleColumn] SitesContext missing — was the page Provider mounted?');
      return null;
    }
    var state = ctx.state;

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-sites' },
        React.createElement('div', { className: 'fs-sites__loading' },
          'Loading sites…'),
      );
    }

    if (state.status === 'error') {
      var ErrorBanner = window.FieldSight.ErrorBanner;
      return React.createElement('div', { className: 'fs-sites' },
        ErrorBanner
          ? React.createElement(ErrorBanner, {
              message:   (state.error && state.error.message) || 'Could not load sites',
              retryable: true,
              onRetry:   state.retry,
            })
          : React.createElement('div', { className: 'fs-sites__empty' },
              (state.error && state.error.message) || 'Could not load sites'),
      );
    }

    if (state.status === 'access_denied') {
      var AccessDenied = fs.AccessDenied;
      return React.createElement('div', { className: 'fs-sites' },
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   'the sites directory',
              message: state.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    var sites         = state.sites || [];
    var reportsBySite = state.reportsBySite || {};
    var selectedId    = props.selectedItem && props.selectedItem.kind === 'site'
      ? props.selectedItem.site_id
      : null;
    var canCreate = ctx.caller && (ctx.caller.isAdmin || (window.FS && window.FS.can && window.FS.can(ctx.caller, 'user:manage')));

    if (sites.length === 0) {
      return React.createElement('div', { className: 'fs-sites' },
        React.createElement('div', { className: 'fs-sites__empty' },
          'No sites visible to your role.'),
      );
    }

    return React.createElement('div', { className: 'fs-sites' },

      React.createElement('div', { className: 'fs-sites__header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' } },
        React.createElement('div', null,
          React.createElement('h2', { className: 'fs-sites__title' }, 'Sites'),
          React.createElement('div', { className: 'fs-sites__subtitle' },
            sites.length + ' ' + (sites.length === 1 ? 'site' : 'sites') + ' visible to your role'),
        ),
        canCreate ? React.createElement('button', {
          type: 'button', className: 'fs-btn fs-btn--primary fs-btn--sm',
          onClick: function () { setNewOpen(true); },
        }, '+ New project') : null,
      ),

      React.createElement('div', { className: 'fs-sites__list' },
        sites.map(function (site) {
          var rows = reportsBySite[site.site_id] || [];
          var kpi = {
            reports:    rows.length,
            latestDate: rows.length ? rows[0].date : null,
          };
          return React.createElement(SiteCard, {
            key:      site.site_id,
            site:     site,
            kpi:      kpi,
            selected: selectedId === site.site_id,
            onSelect: function () {
              onSelect({
                kind:    'site',
                id:      'site_' + site.site_id,
                site_id: site.site_id,
                site:    site,
              });
            },
          });
        }),
      ),

      newOpen ? React.createElement(NewProjectModal, {
        onClose:   function () { setNewOpen(false); },
        onCreated: function (site) { ctx.addSite(site); },
      }) : null,
    );
  }

  /* ---------- SitesRightDetail ----------------------------------------- */

  function SitesRightDetail(props) {
    var fs      = window.FieldSight;
    var Card    = fs.Card;
    var Badge   = fs.Badge;
    var IconBtn = fs.IconButton;

    var ctx = React.useContext(SitesContext);
    var sel = props.selectedItem;

    /* Per-site users state — fetched lazily on selection. */
    var refUsers = React.useState({ status: 'idle', users: [] });
    var usersS   = refUsers[0];
    var setUsers = refUsers[1];

    React.useEffect(function () {
      if (!sel || sel.kind !== 'site') {
        setUsers({ status: 'idle', users: [] });
        return undefined;
      }
      var cancelled = false;
      setUsers({ status: 'loading', users: [] });
      window.FS.api.sites.getSiteUsers(sel.site_id).then(function (res) {
        if (cancelled) return;
        if (res && res._accessDenied) {
          setUsers({ status: 'access_denied', message: res.error, users: [] });
          return;
        }
        setUsers({ status: 'ok', users: (res && res.users) || [] });
      }).catch(function (err) {
        if (cancelled) return;
        setUsers({ status: 'error', error: err, users: [] });
      });
      return function () { cancelled = true; };
    }, [sel && sel.site_id]);

    if (!sel || sel.kind !== 'site') {
      return React.createElement('div', { className: 'fs-sites-detail__placeholder' },
        React.createElement('div', { className: 'fs-sites-detail__placeholder-title' },
          'Select a site'),
        React.createElement('div', { className: 'fs-sites-detail__placeholder-body' },
          'Pick any site to see its users and recent reports.'),
      );
    }

    var site = sel.site;
    var rows = (ctx && ctx.state && ctx.state.reportsBySite && ctx.state.reportsBySite[sel.site_id]) || [];
    var topReports = rows.slice(0, 5);

    function openTimeline(folderName, dateOpt) {
      var qs = '?date=' + encodeURIComponent(dateOpt || (rows[0] && rows[0].date) || '');
      qs += '&user=' + encodeURIComponent(folderName);
      window.FS.Router.navigate('/timeline' + qs);
    }

    return React.createElement('div', { className: 'fs-sites-detail' },

      React.createElement('div', { className: 'fs-sites-detail__header' },
        React.createElement('div', { className: 'fs-sites-detail__header-main' },
          React.createElement('h2', { className: 'fs-sites-detail__title' },
            site.name || site.site_id),
          React.createElement('div', { className: 'fs-sites-detail__metaline' },
            site.client ? React.createElement('span', null, site.client) : null,
            site.location ? React.createElement('span', null, site.location) : null,
          ),
        ),
        IconBtn ? React.createElement(IconBtn, {
          icon: 'x', ariaLabel: 'Close detail', size: 'sm',
          onClick: function () { if (props.onClose) props.onClose(); },
        }) : null,
      ),

      /* Recent reports */
      React.createElement('div', { className: 'fs-sites-detail__section' },
        React.createElement('div', { className: 'fs-sites-detail__section-label' },
          'Recent reports'),
        topReports.length === 0
          ? React.createElement('div', { className: 'fs-sites-detail__empty' },
              'No reports yet for this site.')
          : React.createElement('div', { className: 'fs-sites-detail__reports' },
              topReports.map(function (r) {
                var folder = r.author ? window.FS.api.folderName(r.author) : null;
                return React.createElement('button', {
                  key:       r.key,
                  type:      'button',
                  className: 'fs-sites-detail__report',
                  onClick:   function () {
                    if (folder) openTimeline(folder, r.date);
                  },
                  disabled:  !folder || r.type !== 'daily',
                  title:     folder && r.type === 'daily'
                              ? 'Open in timeline'
                              : 'Aggregate report — open from /reports',
                },
                  React.createElement(Badge, {
                    tone:    r.type === 'daily'   ? 'info'
                          : r.type === 'weekly'  ? 'success'
                          : r.type === 'monthly' ? 'accent'
                          : 'neutral',
                    size:    'sm', variant: 'subtle',
                  }, (r.type || '').charAt(0).toUpperCase() + (r.type || '').slice(1)),
                  React.createElement('div', { className: 'fs-sites-detail__report-main' },
                    React.createElement('div', { className: 'fs-sites-detail__report-date' },
                      fmtDate(r.date)),
                    React.createElement('div', { className: 'fs-sites-detail__report-meta' },
                      (r.author || '—') + ' · ' + fmtSize(r.size)),
                  ),
                );
              }),
            ),
      ),

      /* Users on site */
      React.createElement('div', { className: 'fs-sites-detail__section' },
        React.createElement('div', { className: 'fs-sites-detail__section-label' },
          'Users on site'),
        usersS.status === 'loading'
          ? React.createElement('div', { className: 'fs-sites-detail__empty' },
              'Loading users…')
          : usersS.status === 'error'
          ? React.createElement('div', { className: 'fs-sites-detail__empty' },
              'Could not load users.')
          : usersS.status === 'access_denied'
          ? React.createElement('div', { className: 'fs-sites-detail__empty' },
              usersS.message || 'You don’t have access to this site’s users.')
          : usersS.users.length === 0
          ? React.createElement('div', { className: 'fs-sites-detail__empty' },
              'No users on this site.')
          : React.createElement('div', { className: 'fs-sites-detail__users' },
              usersS.users.map(function (u) {
                return React.createElement('button', {
                  key:       u.device_id,
                  type:      'button',
                  className: 'fs-sites-detail__user',
                  onClick:   function () { openTimeline(u.folder_name); },
                  title:     'Open ' + u.name + '’s timeline',
                  disabled:  !u.folder_name,
                },
                  React.createElement('div', { className: 'fs-sites-detail__user-main' },
                    React.createElement('div', { className: 'fs-sites-detail__user-name' },
                      u.name),
                    React.createElement('div', { className: 'fs-sites-detail__user-meta' },
                      [u.role, u.device_id].filter(Boolean).join(' · ')),
                  ),
                  React.createElement('span', { className: 'fs-sites-detail__user-arrow' },
                    '→'),
                );
              }),
            ),
      ),
    );
  }

  /* ---------- Register --------------------------------------------------- */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/sites'] = {
    Middle:   SitesMiddleColumn,
    Right:    SitesRightDetail,
    /* AppShell wraps Middle + Right with this so they share the
       SitesContext snapshot (Sprint 3 P-07 pattern). */
    Provider: SitesProvider,
  };

})();
