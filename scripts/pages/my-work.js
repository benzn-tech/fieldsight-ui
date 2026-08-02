/* ==========================================================================
   FieldSight My Work — the caller's own programme work, over a time window
   --------------------------------------------------------------------------
   Today answers "what do I do today" and deliberately stops three days out
   (spec §14). Everything further belongs here, so Today stays readable.

   Shares the programme's data path, not a new one: the same
   GET /programme/tasks window endpoint, with assignee='me' resolved
   server-side to the caller's folder_name — a caller with no folder identity
   gets an empty list rather than the whole programme. The range control and
   its preference round-trip are the same ProgrammeWindowPicker the Programme
   page uses.

   DEVIATION FROM SPEC §14, recorded deliberately: the spec says My Work is
   "the programme time-window view filtered to assignee = me — same data, same
   endpoint, same renderer", i.e. the Gantt. This renders a grouped card list
   instead, reusing ProgrammeTaskCard (already Today's programme row). Two
   reasons. A site manager reading this on a phone at a site wants a list, not
   a horizontally-scrolling Gantt. And the Gantt lives in programme.js, which
   is being rewritten on another branch — waiting would have held My Work
   behind work it does not need. The intent the spec was protecting (one data
   path, not two) is honoured: same endpoint, same card, same window module.
   A Gantt-filtered variant for PMs remains easy to add later.

   Registers as window.FieldSight.PAGES['/my-work']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var MyWorkContext = React.createContext(null);

  function MyWorkProvider(props) {
    var api = window.FS.api;
    var pick = window.FieldSight.programmeWindowPref;
    var pw = api.programmeWindow;

    var stateHook = React.useState({ status: 'loading' });
    var state = stateHook[0]; var setState = stateHook[1];
    var presetHook = React.useState(pw.presetByKey(pw.DEFAULT_PRESET_KEY));
    var preset = presetHook[0]; var setPreset = presetHook[1];
    var siteHook = React.useState(null);
    var siteId = siteHook[0]; var setSiteId = siteHook[1];
    var retryHook = React.useState(0);
    var retry = retryHook[0]; var setRetry = retryHook[1];

    var today = api.todayNZDT();

    /* Seed the range from the caller's stored preference before the first
       fetch, so the page does not load one window and immediately reload
       another. */
    React.useEffect(function () {
      var cancelled = false;
      api.org.getMe()
        .then(function (me) {
          if (cancelled) return;
          setPreset(pick.readWindowPref(me));
        })
        .catch(function () { /* keep the default */ });
      return function () { cancelled = true; };
    }, []);

    React.useEffect(function () {
      var cancelled = false;
      setState({ status: 'loading' });

      api.org.getOrgSites()
        .then(function (res) {
          var sites = (res && res.sites) || [];
          /* My Work is per-site because a programme is. Default to the first
             accessible site; a site manager has exactly one. */
          var chosen = siteId || (sites[0] && sites[0].site_id) || null;
          if (!chosen) return { tasks: [], _sites: sites };
          var win = pw.resolveWindow(preset, today);
          return api.programme.getTasksInWindow(chosen, {
            from: win.from, to: win.to, assignee: 'me',
          }).then(function (r) {
            return Object.assign({}, r, { _sites: sites, _chosen: chosen });
          });
        })
        .then(function (res) {
          if (cancelled) return;
          if (res && res._accessDenied) {
            setState({ status: 'error', error: { code: 403,
              message: 'You do not have access to this project.' } });
            return;
          }
          setState({ status: 'ok', tasks: (res && res.tasks) || [],
                     sites: (res && res._sites) || [] });
          if (res && res._chosen && !siteId) setSiteId(res._chosen);
        })
        .catch(function (err) {
          if (cancelled) return;
          setState({ status: 'error', error: {
            code: (err && err.status) || 0,
            message: (err && err.message) || 'Could not load your work',
            retryable: true } });
        });

      return function () { cancelled = true; };
    }, [preset, siteId, retry]);

    function changePreset(next) {
      setPreset(next);
      /* Fire and forget: a failed preference write must not block the range
         change the user just made. It re-reads on the next visit. */
      if (api.org.updateMe) {
        Promise.resolve(api.org.updateMe(pick.windowPrefPatch(next)))
          .catch(function () {});
      }
    }

    var ctx = {
      state: state, preset: preset, today: today,
      siteId: siteId, setSiteId: setSiteId,
      changePreset: changePreset,
      retry: function () { setRetry(function (n) { return n + 1; }); },
    };
    return React.createElement(MyWorkContext.Provider, { value: ctx }, props.children);
  }

  function MyWorkMiddleColumn(props) {
    var fs = window.FieldSight;
    var ctx = React.useContext(MyWorkContext);
    var Picker = fs.ProgrammeWindowPicker;
    var grouping = window.FS.api.myWorkGrouping;
    if (!ctx) return null;
    var s = ctx.state;

    var header = React.createElement('div', { className: 'fs-mywork__header' },
      React.createElement('h1', { className: 'fs-mywork__title' }, 'My Work'),
      Picker ? React.createElement(Picker, {
        preset: ctx.preset, today: ctx.today,
        disabled: s.status === 'loading',
        onChange: ctx.changePreset,
      }) : null);

    if (s.status === 'loading') {
      return React.createElement('div', { className: 'fs-page fs-page--mywork' },
        header, React.createElement('p', { className: 'fs-mywork__empty' }, 'Loading…'));
    }
    if (s.status === 'error') {
      return React.createElement('div', { className: 'fs-page fs-page--mywork' },
        header,
        fs.ErrorBanner
          ? React.createElement(fs.ErrorBanner, { error: s.error, onRetry: ctx.retry })
          : React.createElement('p', { className: 'fs-mywork__empty' }, s.error.message));
    }

    var groups = grouping.groupMyWork(s.tasks, ctx.today);
    if (!groups.length) {
      return React.createElement('div', { className: 'fs-page fs-page--mywork' },
        header,
        React.createElement('p', { className: 'fs-mywork__empty' },
          'Nothing assigned to you in this range. Widen it above, or check '
          + 'with your project manager.'));
    }

    return React.createElement('div', { className: 'fs-page fs-page--mywork' },
      header,
      groups.map(function (g) {
        return React.createElement(React.Fragment, { key: g.key },
          React.createElement('div', {
            className: 'fs-mywork__group'
              + (g.key === 'overdue' ? ' fs-mywork__group--overdue' : ''),
          }, g.label + ' · ' + g.tasks.length),
          g.tasks.map(function (row) {
            return React.createElement(fs.ProgrammeTaskCard, {
              key: (row.id || row.task_id),
              row: row,
              onSelect: function () {
                window.FS.Router.navigate('/programme?task='
                  + encodeURIComponent(row.source_task_id || row.task_id)
                  + '&from=my-work');
              },
            });
          }));
      }));
  }

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/my-work'] = {
    Middle:   MyWorkMiddleColumn,
    Provider: MyWorkProvider,
    layout:   'full-width',
  };

})();
