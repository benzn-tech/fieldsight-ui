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

  /* Org API live gate (batch 2b Task 3): mirrors api/org.js's own orgLive()
     check. LIVE → window.FS.api.org.*; MOCK → keep window.FS.api.sites.*
     path unchanged (mock + org fixtures differ; never swap them). */
  function orgLive() {
    return !!(window.FS && window.FS.api && !window.FS.api.useMocks
      && window.FS.api.orgBaseUrl && window.FS.api.org);
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

    /* batch 2c Task 5 — "Show archived" toggle (live + user:manage only).
       Mock sites.getSites() never receives the flag — mock fixtures have
       no archived dimension, so the toggle stays hidden in mock mode. */
    var refShowArchived = React.useState(false);
    var showArchived    = refShowArchived[0];
    var setShowArchived = refShowArchived[1];

    React.useEffect(function () {
      var cancelled = false;
      setState({ status: 'loading' });

      Promise.all([
        (orgLive() ? window.FS.api.org.getOrgSites({ includeArchived: showArchived }) : window.FS.api.sites.getSites()),
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

        /* batch 2c: org-assets icon keys aren't directly renderable —
           resolve each to a presigned display URL and patch them in.
           Sites without an org-assets icon (or whose resolve fails) are
           left as-is; Avatar falls back to initials for those. */
        if (orgLive()) {
          var toResolve = sites.filter(function (s) { return s.icon && /^org-assets\//.test(s.icon); });
          if (toResolve.length) {
            Promise.all(toResolve.map(function (s) {
              return window.FS.api.org.resolveAssetUrl(s.icon).then(function (url) { return { site_id: s.site_id, url: url }; });
            })).then(function (resolved) {
              if (cancelled) return;
              var byId = {};
              resolved.forEach(function (r) { if (r.url) byId[r.site_id] = r.url; });
              if (!Object.keys(byId).length) return;
              setState(function (st) {
                if (!st.sites) return st;
                return Object.assign({}, st, {
                  sites: st.sites.map(function (s) { return byId[s.site_id] ? Object.assign({}, s, { icon: byId[s.site_id] }) : s; }),
                });
              });
            });
          }
        }
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load sites', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });

      return function () { cancelled = true; };
    }, [depKey, retryCount, showArchived]);

    var ctx = {
      state: state,
      caller: caller,
      showArchived:    showArchived,
      setShowArchived: setShowArchived,
      refetch: function () { setRetry(function (n) { return n + 1; }); },
      addSite: function (site) { setState(function (s) { return Object.assign({}, s, { sites: [site].concat(s.sites || []) }); }); },
      /* Kept for the (unlikely) case something still calls it directly —
         onArchive below now refetches instead so archived-list toggling
         self-resolves the right-detail staleness (batch 2c Task 5). */
      removeSite: function (siteId) {
        setState(function (s) {
          if (!s.sites) return s;
          return Object.assign({}, s, { sites: s.sites.filter(function (x) { return x.site_id !== siteId; }) });
        });
      },
      setSiteIcon: function (siteId, icon) {
        setState(function (s) {
          if (!s.sites) return s;
          return Object.assign({}, s, { sites: s.sites.map(function (x) { return x.site_id === siteId ? Object.assign({}, x, { icon: icon }) : x; }) });
        });
        var f = (window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.sites);
        if (f && f.sites) { var fx = f.sites.filter(function (x) { return x.site_id === siteId; })[0]; if (fx) fx.icon = icon; }
        if (window.FS.toast) window.FS.toast.show({ message: icon ? 'Project image updated' : 'Project image removed', tone: 'success' });
      },
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

  /* Debounced Photon type-ahead. On pick: calls onPick({ address, latitude,
     longitude }) so the parent form fills the address text AND stashes coords.
     On error/no-result it stays a plain free-text input (coords left null ->
     backfilled later). Keyless; browser-direct (not via org API). */
  function AddressAutocomplete(props) {
    var refOpen = React.useState(false); var isOpen = refOpen[0], setOpen = refOpen[1];
    var refList = React.useState([]); var list = refList[0], setList = refList[1];
    var timer = React.useRef(null);
    function onType(v) {
      props.onText(v);
      if (timer.current) clearTimeout(timer.current);
      if (!v || !v.trim() || !(window.FS.api.org && window.FS.api.org.geocodeAddress)) {
        setList([]); setOpen(false); return;
      }
      timer.current = setTimeout(function () {
        window.FS.api.org.geocodeAddress(v).then(function (results) {
          setList(results); setOpen(results.length > 0);
        }).catch(function () {
          setList([]); setOpen(false);
        });
      }, 350);
    }
    function pick(item) {
      setOpen(false); setList([]);
      props.onPick({ address: item.formatted, latitude: item.lat, longitude: item.lng });
    }
    return React.createElement('div', { style: { position: 'relative' } },
      React.createElement('input', {
        type: 'text', className: 'fs-settings__input', value: props.value || '',
        placeholder: 'Start typing an address…',
        onChange: function (e) { onType(e.target.value); },
      }),
      isOpen ? React.createElement('ul', {
        className: 'fs-address-suggest',
        style: { position: 'absolute', zIndex: 20, left: 0, right: 0, margin: 0,
                 padding: '4px 0', listStyle: 'none',
                 background: 'var(--surface-panel)', border: '1px solid var(--border-subtle)',
                 borderRadius: '6px', maxHeight: '180px', overflowY: 'auto' },
      }, list.map(function (item, i) {
        return React.createElement('li', {
          key: i, style: { padding: '6px 10px', cursor: 'pointer' },
          onMouseDown: function (e) { e.preventDefault(); pick(item); },
        }, item.formatted);
      })) : null);
  }

  /* ---------- NewProjectModal (Phase B — admin create project) --------- */
  function NewProjectModal(props) {
    var Modal = window.FieldSight && window.FieldSight.ModalOverlay;
    /* batch 2c: NewProjectModal is rendered as a descendant of SitesProvider
       (Middle → this modal, same as SitesMiddleColumn), so SitesContext is
       reachable directly via useContext — simpler than prop-drilling
       setSiteIcon down through onCreated. */
    var ctx = React.useContext(SitesContext);
    var refForm = React.useState({ name: '', location: '', region: 'south-island', client: '', project_value_nzd: '', planned_completion: '', address: '', latitude: null, longitude: null });
    var form = refForm[0], setForm = refForm[1];
    var refBusy = React.useState(false); var busy = refBusy[0], setBusy = refBusy[1];
    var iconRef = React.useRef(null);
    var Avatar = window.FieldSight && window.FieldSight.Avatar;
    function set(k, v) { setForm(function (f) { var n = Object.assign({}, f); n[k] = v; return n; }); }
    function onPickIcon(e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { set('icon', r.result); };
      r.readAsDataURL(f);
      if (orgLive()) {
        window.FS.api.org.uploadImage('site_icon', f).then(function (key) {
          if (key) set('_iconKey', key);
        }).catch(function () {
          if (window.FS.toast) window.FS.toast.show({ message: 'Could not upload image — use JPEG, PNG or WebP', tone: 'error' });
        });
      }
    }
    function submit() {
      if (!form.name.trim() || busy) return;
      setBusy(true);
      var live = orgLive();
      var creating = live
        ? window.FS.api.org.createOrgSite({ name: form.name, location: form.location, client: form.client, address: form.address || undefined, latitude: form.latitude, longitude: form.longitude, icon_s3_key: form._iconKey || undefined })
        : window.FS.api.sites.createSite(form);
      creating.then(function (site) {
        setBusy(false);
        if (live) site = window.FS.api.org._toPageSite(site);
        if (window.FS.toast) window.FS.toast.show({ message: 'Project "' + site.name + '" created', tone: 'success' });
        if (props.onCreated) props.onCreated(site);
        if (props.onClose) props.onClose();
        /* Card renders with initials fallback (Avatar degrades gracefully
           on the unresolved org-assets key) until this resolves, then
           swaps in the real URL via context — same path the right-detail
           swap uses. */
        if (live && site.icon && /^org-assets\//.test(site.icon)) {
          window.FS.api.org.resolveAssetUrl(site.icon).then(function (url) {
            if (url && ctx && ctx.setSiteIcon) ctx.setSiteIcon(site.site_id, url);
          });
        }
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
          React.createElement('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', ref: iconRef, onChange: onPickIcon, style: { display: 'none' } }),
          React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm', onClick: function () { if (iconRef.current) iconRef.current.click(); } }, 'Upload icon')
        )),
        fFieldRow('Location', fText(form.location, function (v) { set('location', v); })),
        fFieldRow('Address', React.createElement(AddressAutocomplete, {
          value: form.address,
          onText: function (v) { setForm(function (f) { return Object.assign({}, f, { address: v, latitude: null, longitude: null }); }); },
          onPick: function (p) { setForm(function (f) { return Object.assign({}, f, { address: p.address, latitude: p.latitude, longitude: p.longitude }); }); },
        })),
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

  /* ---------- EditProjectModal (admin edit an existing project) -------- */
  function EditProjectModal(props) {
    var Modal = window.FieldSight && window.FieldSight.ModalOverlay;
    var site  = props.site || {};
    var refForm = React.useState({
      name:      site.name || '',
      location:  site.location || '',
      client:    site.client || '',
      address:   site.address || '',
      latitude:  site.latitude != null ? site.latitude : null,
      longitude: site.longitude != null ? site.longitude : null,
    });
    var form = refForm[0], setForm = refForm[1];
    var refBusy = React.useState(false); var busy = refBusy[0], setBusy = refBusy[1];
    function set(k, v) { setForm(function (f) { var n = Object.assign({}, f); n[k] = v; return n; }); }
    function submit() {
      if (!form.name.trim() || busy) return;
      setBusy(true);
      window.FS.api.org.updateOrgSite(props.site.site_id, {
        name: form.name, location: form.location, client: form.client, address: form.address,
        latitude: form.latitude, longitude: form.longitude,
      }).then(function (updated) {
        setBusy(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Project "' + ((updated && updated.name) || form.name) + '" updated', tone: 'success' });
        if (props.onSaved) props.onSaved();
        if (props.onClose) props.onClose();
      }).catch(function () {
        setBusy(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Could not update project', tone: 'error' });
      });
    }
    if (!Modal) return null;
    return React.createElement(Modal, { open: true, size: 'md', title: 'Edit project', onClose: props.onClose },
      React.createElement('div', { className: 'fs-settings__pw-form' },
        fFieldRow('Project name *', fText(form.name, function (v) { set('name', v); })),
        fFieldRow('Location', fText(form.location, function (v) { set('location', v); })),
        fFieldRow('Client', fText(form.client, function (v) { set('client', v); })),
        fFieldRow('Address', React.createElement(AddressAutocomplete, {
          value: form.address,
          onText: function (v) { setForm(function (f) { return Object.assign({}, f, { address: v, latitude: null, longitude: null }); }); },
          onPick: function (p) { setForm(function (f) { return Object.assign({}, f, { address: p.address, latitude: p.latitude, longitude: p.longitude }); }); },
        })),
        React.createElement('div', { className: 'fs-settings__actions' },
          React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--md', onClick: props.onClose }, 'Cancel'),
          React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--primary fs-btn--md', disabled: busy, onClick: submit }, busy ? 'Saving…' : 'Save changes')
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
    /* batch 2c Task 5 — toggle is live-only (mock fixtures carry no
       archived dimension) and gated the same as the archive action itself. */
    var canToggleArchived = orgLive() && !!(window.FS && window.FS.can && window.FS.can(ctx.caller, 'user:manage'));

    /* batch 2c review fix — header (toggle + New project) must render even
       when the filtered list is empty: with showArchived=false, archiving
       the LAST active site would otherwise hide the toggle with the early
       return, leaving no UI path to reveal or restore archived sites. */
    var header = React.createElement('div', { className: 'fs-sites__header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' } },
      React.createElement('div', null,
        React.createElement('h2', { className: 'fs-sites__title' }, 'Sites'),
        React.createElement('div', { className: 'fs-sites__subtitle' },
          sites.length + ' ' + (sites.length === 1 ? 'site' : 'sites') + ' visible to your role'),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        canToggleArchived ? React.createElement('button', {
          type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm',
          onClick: function () { ctx.setShowArchived(!ctx.showArchived); },
        }, ctx.showArchived ? 'Hide archived' : 'Show archived') : null,
        canCreate ? React.createElement('button', {
          type: 'button', className: 'fs-btn fs-btn--primary fs-btn--sm',
          onClick: function () { setNewOpen(true); },
        }, '+ New project') : null,
      ),
    );
    var modal = newOpen ? React.createElement(NewProjectModal, {
      onClose:   function () { setNewOpen(false); },
      onCreated: function (site) { ctx.addSite(site); },
    }) : null;

    if (sites.length === 0) {
      return React.createElement('div', { className: 'fs-sites' },
        header,
        React.createElement('div', { className: 'fs-sites__empty' },
          ctx.showArchived ? 'No sites yet — including archived.' : 'No sites visible to your role.'),
        modal,
      );
    }

    return React.createElement('div', { className: 'fs-sites' },

      header,

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

      modal,
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
    var iconRef = React.useRef(null);
    var Avatar = fs.Avatar;

    /* Per-site users state — fetched lazily on selection. */
    var refUsers = React.useState({ status: 'idle', users: [] });
    var usersS   = refUsers[0];
    var setUsers = refUsers[1];

    var refArchiving = React.useState(false);
    var archiving    = refArchiving[0];
    var setArchiving = refArchiving[1];

    var refEditOpen = React.useState(false);
    var editOpen    = refEditOpen[0];
    var setEditOpen = refEditOpen[1];

    /* batch 2c: local-only instant preview while the live upload/swap is
       in flight. Deliberately NOT pushed through ctx.setSiteIcon until the
       swap resolves (success, or confirmed writes-off) — on a hard failure
       we just drop this and real state (and the fixture mirror) stay
       untouched. */
    var refIconPreview = React.useState(null);
    var iconPreview    = refIconPreview[0];
    var setIconPreview = refIconPreview[1];

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
    if (ctx && ctx.state && ctx.state.sites) {
      var liveSite = ctx.state.sites.filter(function (s) { return s.site_id === sel.site_id; })[0];
      if (liveSite) site = liveSite;
    }
    function onPickIcon(e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var dataUrl = r.result;
        if (!orgLive()) {
          if (ctx && ctx.setSiteIcon) ctx.setSiteIcon(sel.site_id, dataUrl);
          return;
        }
        setIconPreview(dataUrl);
        window.FS.api.org.uploadImage('site_icon', f).then(function (key) {
          if (!key) {
            /* writes-off (org live, org writes disabled): no real upload
               ran — keep the local preview as the final value, same
               convention as mock mode / settings.js avatar upload. */
            setIconPreview(null);
            if (ctx && ctx.setSiteIcon) ctx.setSiteIcon(sel.site_id, dataUrl);
            return;
          }
          return window.FS.api.org.updateOrgSite(sel.site_id, { icon_s3_key: key }).then(function (res) {
            return window.FS.api.org.resolveAssetUrl(res && res.icon_s3_key);
          }).then(function (url) {
            setIconPreview(null);
            if (ctx && ctx.setSiteIcon) ctx.setSiteIcon(sel.site_id, url || null);
          });
        }).catch(function () {
          setIconPreview(null);
          if (window.FS.toast) window.FS.toast.show({ message: 'Could not update project image', tone: 'error' });
        });
      };
      r.readAsDataURL(f);
    }
    var rows = (ctx && ctx.state && ctx.state.reportsBySite && ctx.state.reportsBySite[sel.site_id]) || [];
    var topReports = rows.slice(0, 5);

    /* Archive (batch 2b Task 3) — live-only write, gated on user:manage.
       Restore/"view archived" is out of scope here (batch 2c follow-up). */
    var caller = (ctx && ctx.caller) || (window.AuthMock && window.AuthMock.currentUser) || {};
    var canArchive = orgLive() && !!(window.FS && window.FS.can && window.FS.can(caller, 'user:manage'));
    function onArchive() {
      if (archiving) return;
      setArchiving(true);
      window.FS.api.org.archiveSite(sel.site_id).then(function () {
        setArchiving(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Project archived', tone: 'success' });
        if (ctx && ctx.refetch) ctx.refetch();
        /* batch 2c Task 5 — with showArchived=false (the default) the
           just-archived site drops out of the refetched list, so the
           `liveSite` lookup below misses and this panel would otherwise
           keep rendering the pre-archive `sel.site` snapshot (stale name/
           icon, and an "Archive project" button offered again on an
           already-archived site). props.onClose is AppShell's
           setSelectedItem(null) (see RightDetail in app-shell.js) — the
           same handler the header's × button uses — so calling it here
           clears the selection and falls back to the "Select a site"
           placeholder instead of showing stale data. */
        if (props.onClose) props.onClose();
      }).catch(function () {
        setArchiving(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Could not archive project', tone: 'error' });
      });
    }
    function onUnarchive() {
      if (archiving) return;
      setArchiving(true);
      window.FS.api.org.unarchiveSite(sel.site_id).then(function () {
        setArchiving(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Project restored', tone: 'success' });
        if (ctx && ctx.refetch) ctx.refetch();
      }).catch(function () {
        setArchiving(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Could not restore project', tone: 'error' });
      });
    }

    /* Task 4 (batch A) — deliberately does NOT forward sel.site_id as
       ?site=. In live mode sel.site_id comes from org.getOrgSites()'s
       _toPageSite() (api/org.js), i.e. the ORG identity system's site
       UUID — a different space from the report-side site slug that
       /timeline's ?site= / loadTimelineSite() / getDates({site}) /
       getSiteUsers(site) all key off (window.FS.api.sites.getSites(),
       used unconditionally by timeline.js, org-live-gate or not).
       Forwarding the UUID here would silently mismatch and break the
       timeline's site selector/AggregatedDayView. Parked as an
       identity-systems gap for the device-mgmt batch; don't "fix" this
       without a folder/UUID bridge like org.js's folderName(). */
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
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' } },
            Avatar ? React.createElement(Avatar, { name: site.name || site.site_id, src: iconPreview || site.icon || undefined, size: 'lg', shape: 'square' }) : null,
            React.createElement('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', ref: iconRef, onChange: onPickIcon, style: { display: 'none' } }),
            React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm', onClick: function () { if (iconRef.current) iconRef.current.click(); } }, site.icon ? 'Change image' : 'Upload image'),
            /* live: backend PATCH ignores null icon_s3_key (no clear support yet —
               backend backlog: explicit-null icon clear), so hide Remove entirely
               rather than offer a button that silently no-ops. Mock keeps it. */
            (!orgLive() && site.icon) ? React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--tertiary fs-btn--sm', onClick: function () { if (ctx && ctx.setSiteIcon) ctx.setSiteIcon(sel.site_id, null); } }, 'Remove') : null,
            canArchive ? React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm', onClick: function () { setEditOpen(true); } }, 'Edit') : null,
            (canArchive && site.archived) ? React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--tertiary fs-btn--sm', disabled: archiving, onClick: onUnarchive }, archiving ? 'Restoring…' : 'Restore project') : null,
            (canArchive && !site.archived) ? React.createElement('button', { type: 'button', className: 'fs-btn fs-btn--tertiary fs-btn--sm', disabled: archiving, onClick: onArchive }, archiving ? 'Archiving…' : 'Archive project') : null,
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

      editOpen ? React.createElement(EditProjectModal, {
        site:     site,
        onClose:  function () { setEditOpen(false); },
        onSaved:  function () { if (ctx && ctx.refetch) ctx.refetch(); },
      }) : null,
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
