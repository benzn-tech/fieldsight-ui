/* ==========================================================================
   FieldSight SearchPalette — Sprint 8.6
   --------------------------------------------------------------------------
   Full-screen search overlay opened via Cmd/Ctrl+K or the search icon
   button in the middle-column header.

   Search scope:
     Tasks    — action_items[].text across last 14 days (client-side, cached)
     Safety   — safety_flags + safety_observations (client-side, cached)
     Sites    — sites[].name + sites[].location (client-side, cached)
     People   — users derived from sites[].users (client-side, cached)
     Topics   — server-side semantic search via window.FS.api.search.topics
                (POST /api/search), debounced 250ms, results grouped by
                report_date; shown once the request settles

   Tasks/safety/sites/people are loaded once on first open and cached in
   module scope for the rest of the session (survives palette close/reopen).

   Keyboard:
     ArrowUp / ArrowDown  — navigate result list
     Enter                — open selected result's canonical page
     Escape               — close

   Recent searches stored in sessionStorage (max 5).

   Exported to: window.FieldSight.SearchPalette
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var TYPE_ORDER  = ['task', 'safety', 'site', 'user', 'topic'];
  var TYPE_LABELS = { task: 'Tasks', safety: 'Safety', site: 'Sites', user: 'People', topic: 'Topics' };
  var TYPE_ICONS  = { task: 'check-square', safety: 'shield-alert', site: 'building-2', user: 'user', topic: 'file-text' };

  /* Bucket topic result items by report date, most-recent first. */
  function _groupTopicsByDate(items) {
    var by = {};
    items.forEach(function (it) { (by[it._date] = by[it._date] || []).push(it); });
    return Object.keys(by).sort().reverse().map(function (d) {
      return { date: d, items: by[d] };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Module-level data cache — survives palette close/reopen in a session    */
  /* ---------------------------------------------------------------------- */

  var _cache = { loaded: false, loading: false,
                 tasks: [], safety: [], sites: [], users: [] };

  function _isAdminCaller() {
    var c = (window.AuthMock && window.AuthMock.currentUser) || {};
    return c.role === 'admin' || c.role === 'gm' || !!c.isAdmin;
  }

  async function _loadCache() {
    if (_cache.loaded || _cache.loading) return;
    _cache.loading = true;
    try {
      var today = window.FS.api.todayNZDT();
      /* Task C — widen the cache window from a trailing 14 days to the
         full report span (FS.api.window.getSpan(), shared/cached with
         every other widened call site) so Search can actually find the
         historic Feb/Mar report data instead of an empty last-14-days
         slice. Falls back to `today` (i.e. no widening) if the span
         lookup fails or no report has ever existed. */
      var span  = await window.FS.api.window.getSpan().catch(function () {
        return { earliest: null, latest: null, dates: {} };
      });
      var from  = span.earliest || today;

      var results = await Promise.all([
        window.FS.api.sites.getSites()
          .catch(function () { return { sites: [] }; }),
        window.FS.api.tasks.getActionsResolvedRange({ from: from, to: today })
          .catch(function () { return { rows: [] }; }),
        window.FS.api.compliance.getSafetyRange({ from: from, to: today })
          .catch(function () { return { rows: [] }; }),
      ]);

      _cache.sites  = (results[0] && results[0].sites) || [];
      _cache.tasks  = (results[1] && results[1].rows)  || [];
      _cache.safety = (results[2] && results[2].rows)  || [];

      /* Derive unique users from sites */
      var usersMap = {};
      _cache.sites.forEach(function (site) {
        (site.users || []).forEach(function (u) {
          if (u.name && !usersMap[u.name]) usersMap[u.name] = u;
        });
      });
      _cache.users  = Object.keys(usersMap).map(function (k) { return usersMap[k]; });
      _cache.loaded = true;
    } catch (e) {
      console.warn('[SearchPalette] cache preload failed', e);
    }
    _cache.loading = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Client-side search — synchronous, runs against cache                    */
  /* ---------------------------------------------------------------------- */

  function _search(q) {
    var ql = q.toLowerCase();
    var byType = { task: [], safety: [], site: [], user: [] };

    _cache.tasks.forEach(function (row) {
      if (byType.task.length >= 5) return;
      if (row.action && row.action.toLowerCase().indexOf(ql) !== -1) {
        byType.task.push({
          type:     'task',
          id:       row.id,
          title:    row.action,
          subtitle: row.responsible ? 'Owner: ' + row.responsible : row.date,
          route:    '/tasks',
        });
      }
    });

    _cache.safety.forEach(function (row) {
      if (byType.safety.length >= 5) return;
      var obs = row.observation || '';
      if (obs.toLowerCase().indexOf(ql) !== -1) {
        byType.safety.push({
          type:     'safety',
          id:       row.id,
          title:    obs.length > 80 ? obs.slice(0, 80) + '…' : obs,
          subtitle: 'Risk: ' + (row.risk_level || 'unknown') + ' \xb7 ' + row.date,
          route:    '/safety',
        });
      }
    });

    _cache.sites.forEach(function (site) {
      if (byType.site.length >= 5) return;
      var match = (site.name && site.name.toLowerCase().indexOf(ql) !== -1)
               || (site.location && site.location.toLowerCase().indexOf(ql) !== -1);
      if (match) {
        byType.site.push({
          type:     'site',
          id:       site.site_id || site.name,
          title:    site.name,
          subtitle: site.location || '',
          route:    '/sites',
        });
      }
    });

    _cache.users.forEach(function (u) {
      if (byType.user.length >= 5) return;
      var match = (u.name && u.name.toLowerCase().indexOf(ql) !== -1)
               || (u.role && u.role.toLowerCase().indexOf(ql) !== -1);
      if (match) {
        byType.user.push({
          type:     'user',
          id:       u.name,
          title:    u.name,
          subtitle: u.role || '',
          route:    '/team',
        });
      }
    });

    var out = [];
    /* byType no longer has a 'topic' key (server-side now) — guard so the
       TYPE_ORDER walk doesn't concat(undefined) into the result list. */
    TYPE_ORDER.forEach(function (t) { if (byType[t]) out = out.concat(byType[t]); });
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Ask hand-off — which report user's Timeline the "Ask FieldSight" row    */
  /* routes to. Worker/site_manager: own folder (server would force this     */
  /* anyway). Admin/gm: no personal report folder, so fall back to the       */
  /* seeded default site_manager, matching compliance-aggregator.js's        */
  /* resolveUser() (:107-116) parity convention.                             */
  /* ---------------------------------------------------------------------- */

  var ADMIN_ASK_FOLDER = 'Jarley_Trainor';

  function _resolveAskFolder() {
    var caller  = (window.AuthMock && window.AuthMock.currentUser) || {};
    var isAdmin = caller.role === 'admin' || caller.role === 'gm' || caller.isAdmin;
    if (!isAdmin && caller.name) return window.FS.api.folderName(caller.name);
    return ADMIN_ASK_FOLDER;
  }

  /* ---------------------------------------------------------------------- */
  /* SearchPalette component                                                  */
  /* ---------------------------------------------------------------------- */

  function SearchPalette(props) {
    var NavIcon = window.FieldSight && window.FieldSight.NavIcon;
    var onClose = props.onClose || function () {};

    var refQ    = React.useState('');
    var query   = refQ[0]; var setQuery = refQ[1];

    var refRes  = React.useState([]);
    var results = refRes[0]; var setResults = refRes[1];

    var refIdx  = React.useState(0);
    var selIdx  = refIdx[0]; var setSelIdx = refIdx[1];

    var refRecent = React.useState(function () {
      try { return JSON.parse(sessionStorage.getItem('fs.search.recent') || '[]'); }
      catch (_) { return []; }
    });
    var recent  = refRecent[0]; var setRecent = refRecent[1];

    /* F1 — inline RAG Ask hand-off. null = normal search list; { question }
       swaps the results body for an inline AskChat (no navigation). Local
       state only — closing the palette unmounts SearchPalette and this
       resets for free, no explicit cleanup needed. */
    var refAsk  = React.useState(null);
    var askMode = refAsk[0]; var setAskMode = refAsk[1];

    /* Mechanism 1 — server-side semantic topic search (replaces the old
       client fan-out). Async + debounced; results merged with the client-side
       task/safety/site/people matches below. */
    var refTopics = React.useState([]);
    var topicRows = refTopics[0]; var setTopicRows = refTopics[1];
    var refTLoad  = React.useState(false);
    var topicLoading = refTLoad[0]; var setTopicLoading = refTLoad[1];

    var inputRef = React.useRef(null);
    var listRef  = React.useRef(null);

    /* Auto-focus + kick off data preload on open */
    React.useEffect(function () {
      if (inputRef.current) inputRef.current.focus();
      _loadCache();
    }, []);

    /* Re-run client search + kick a debounced server topic search on query
       change. A stale-guard token drops out-of-order responses. */
    var reqSeq = React.useRef(0);
    React.useEffect(function () {
      var q = query.trim();
      setSelIdx(0);
      if (!q) { setResults([]); setTopicRows([]); setTopicLoading(false); return; }
      setResults(_search(q));                 /* tasks/safety/sites/people, sync */
      if (q.length < 2) { setTopicRows([]); setTopicLoading(false); return; }
      var mine = ++reqSeq.current;
      setTopicLoading(true);
      var t = setTimeout(function () {
        window.FS.api.search.topics({ q: q })
          .then(function (r) {
            if (mine !== reqSeq.current) return;       /* superseded */
            setTopicRows((r && r.results) || []);
            setTopicLoading(false);
          })
          .catch(function () {
            if (mine !== reqSeq.current) return;
            setTopicRows([]);
            setTopicLoading(false);
          });
      }, 250);
      return function () { clearTimeout(t); };
    }, [query]);

    /* Scroll the focused result into view */
    React.useEffect(function () {
      if (!listRef.current) return;
      var el = listRef.current.querySelector('[data-selected="true"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }, [selIdx]);

    /* Minor A (Fable review) — global Escape, works even when focus has
       moved off the search input (e.g. into AskChat's own input).
       Mirrors the document-level Escape pattern in app-shell.js
       WeatherIndicator. askMode → back to search; else → close palette. */
    React.useEffect(function () {
      function onKey(e) {
        if (e.key !== 'Escape') return;
        if (askMode) setAskMode(null);
        else onClose();
      }
      document.addEventListener('keydown', onKey);
      return function () { document.removeEventListener('keydown', onKey); };
    }, [askMode, onClose]);

    var trimmedQuery = query.trim();

    /* Client-side groups (task/safety/site/user) */
    var groups = [];
    TYPE_ORDER.forEach(function (type) {
      if (type === 'topic') return;  /* topics come from the server now */
      var items = results.filter(function (r) { return r.type === type; });
      if (items.length) groups.push({ type: type, items: items });
    });

    /* Server topic rows → result items, grouped by report_date */
    var topicItems = topicRows.map(function (row) {
      return {
        type:     'topic',
        id:       row.route,
        title:    row.title,
        subtitle: (row.site_name ? row.site_name + ' · ' : '') + row.report_date,
        route:    row.route,
        _date:    row.report_date,
      };
    });

    var flatItems = groups.reduce(function (acc, g) { return acc.concat(g.items); }, [])
                          .concat(topicItems);

    /* Mechanism 2 — Ask is a FALLBACK: only when nothing matched and we're
       not still waiting on the server topic search. */
    var nothingFound = flatItems.length === 0;
    var askItem = (trimmedQuery && nothingFound && !topicLoading)
      ? { type: 'ask', id: '__ask__', title: 'Ask FieldSight: “' + trimmedQuery + '”' }
      : null;
    if (askItem) flatItems = flatItems.concat([askItem]);

    function saveRecent(q) {
      if (!q) return;
      var next = [q].concat(recent.filter(function (r) { return r !== q; })).slice(0, 5);
      setRecent(next);
      try { sessionStorage.setItem('fs.search.recent', JSON.stringify(next)); } catch (_) {}
    }

    /* F1 — inline RAG Ask hand-off. Starts AskChat right inside the palette
       (global scope: no date/user/topic_id, so backend Phase 5 grounds
       across the caller's whole ACL rather than one report). Does NOT call
       onClose — the palette stays open showing the answer.
       Guard: if AskChat isn't loaded (script missing/load-order issue),
       fall back to the original Task C behaviour — stash the query for
       Timeline's report-level AskChat to prefill-and-clear, then route to
       the latest report date for the resolved user folder. getSpan() is
       already warm by the time this fires (kicked off by _loadCache on
       palette open), so the async hop is imperceptible in practice; still
       tolerate a slow/failed span lookup by falling back to today. */
    function doAsk(q) {
      if (!q) return;
      saveRecent(q);

      if (!(window.FieldSight && window.FieldSight.AskChat)) {
        try { sessionStorage.setItem('fs.ask.prefill', q); } catch (_) {}
        var folder = _resolveAskFolder();
        function go(dateStr) {
          window.FS.Router.navigate('/timeline?date=' + encodeURIComponent(dateStr)
            + '&user=' + encodeURIComponent(folder));
        }
        window.FS.api.window.getSpan().then(function (span) {
          go((span && span.latest) || window.FS.api.todayNZDT());
        }).catch(function () {
          go(window.FS.api.todayNZDT());
        });
        onClose();
        return;
      }

      setAskMode({ question: q });
    }

    function doSelect(item) {
      if (!item) return;
      if (item.type === 'ask') {
        doAsk(trimmedQuery);
        return;
      }
      saveRecent(trimmedQuery);
      window.FS.Router.navigate(item.route);
      onClose();
    }

    function onKeyDown(e) {
      /* F1 (Fable review) — askMode swaps the results body for the inline
         AskChat panel; short-circuit here so Enter/Arrow keys don't drive
         the now-hidden results list (Enter could re-select an invisible
         row, or re-set askMode without re-sending — AskChat's
         initialQuestion is mount-only). Escape isn't handled here either:
         it bubbles to the document-level effect below, which backs out of
         askMode instead of closing the whole palette. */
      if (askMode) return;

      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelIdx(function (i) { return Math.min(i + 1, flatItems.length - 1); });
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelIdx(function (i) { return Math.max(i - 1, 0); });
          break;
        case 'Enter':
          doSelect(flatItems[selIdx]);
          break;
        default:
          break;
      }
    }

    return React.createElement('div', {
      className:    'fs-search-palette',
      role:         'dialog',
      'aria-modal': 'true',
      'aria-label': 'Search',
    },
      /* Backdrop — clicking closes */
      React.createElement('div', {
        className:   'fs-search-palette__backdrop',
        onClick:     onClose,
        'aria-hidden': 'true',
      }),

      /* Panel */
      React.createElement('div', { className: 'fs-search-palette__panel' },

        /* ---- Input row -------------------------------------------------- */
        React.createElement('div', { className: 'fs-search-palette__input-row' },
          NavIcon && React.createElement(NavIcon, {
            name:  'search',
            size:  18,
            color: 'var(--text-tertiary)',
          }),
          React.createElement('input', {
            ref:          inputRef,
            type:         'text',
            className:    'fs-search-palette__input',
            placeholder:  'Search tasks, sites, people, safety, topics…',
            value:        query,
            onChange:     function (e) { setQuery(e.target.value); },
            onKeyDown:    onKeyDown,
            'aria-label': 'Search',
            autoComplete: 'off',
            spellCheck:   false,
          }),
          query
            ? React.createElement('button', {
                type:         'button',
                className:    'fs-search-palette__clear',
                onClick:      function () {
                  setQuery('');
                  if (inputRef.current) inputRef.current.focus();
                },
                'aria-label': 'Clear search',
              }, '\xd7')
            : null,
          React.createElement('kbd', { className: 'fs-search-palette__esc-hint' }, 'Esc'),
        ),

        /* ---- Results list ------------------------------------------------
           F1 — when askMode is set, this whole body is swapped for the
           inline AskChat panel (below); everything else (no-match/grouped/
           recent/hint + the "Ask FieldSight" row) only renders when
           askMode is null. */
        React.createElement('div', {
          ref:          listRef,
          className:    'fs-search-palette__results',
          role:         askMode ? 'region' : 'listbox',
          'aria-label': askMode ? 'Ask FieldSight' : 'Search results',
        },
          askMode
            ? React.createElement('div', { className: 'fs-search-palette__ask' },
                React.createElement('button', {
                  type:         'button',
                  className:    'fs-search-palette__ask-back',
                  onClick:      function () { setAskMode(null); },
                },
                  NavIcon && React.createElement(NavIcon, {
                    name:  'chevron-left',
                    size:  14,
                    color: 'var(--text-tertiary)',
                  }),
                  'Back to search',
                ),
                React.createElement('div', { className: 'fs-search-palette__ask-question' },
                  askMode.question),
                React.createElement(window.FieldSight.AskChat, {
                  /* F1 (Fable review) — key on the question so a second
                     Ask from search (different question, same mounted
                     panel) remounts AskChat instead of reusing the old
                     instance; initialQuestion is mount-only and wouldn't
                     otherwise re-send. */
                  key:             askMode.question,
                  compact:         true,
                  initialQuestion: askMode.question,
                  scope:           'both',
                }),
              )
            :
          /* No match */
          query.trim() && results.length === 0 && !topicItems.length && !topicLoading
            ? React.createElement('div', { className: 'fs-search-palette__empty' },
                'No results for “' + query.trim() + '”')

            /* Grouped results */
            : query.trim() && results.length > 0
            ? groups.map(function (group) {
                return React.createElement('div', {
                  key:       group.type,
                  className: 'fs-search-palette__group',
                },
                  React.createElement('div', {
                    className: 'fs-search-palette__group-label',
                    role:      'presentation',
                  }, TYPE_LABELS[group.type] || group.type),
                  group.items.map(function (item) {
                    var idx   = flatItems.indexOf(item);
                    var isSel = idx === selIdx;
                    return React.createElement('button', {
                      key:             item.type + '_' + item.id,
                      type:            'button',
                      role:            'option',
                      'aria-selected': isSel,
                      'data-selected': String(isSel),
                      className:       'fs-search-palette__result'
                                        + (isSel ? ' fs-search-palette__result--active' : ''),
                      onClick:         function () { doSelect(item); },
                      onMouseEnter:    function () { setSelIdx(idx); },
                    },
                      NavIcon && React.createElement(NavIcon, {
                        name:  TYPE_ICONS[item.type] || 'file',
                        size:  15,
                        color: 'var(--text-tertiary)',
                      }),
                      React.createElement('div', { className: 'fs-search-palette__result-body' },
                        React.createElement('span', { className: 'fs-search-palette__result-title' },
                          item.title),
                        item.subtitle
                          ? React.createElement('span', { className: 'fs-search-palette__result-sub' },
                              item.subtitle)
                          : null,
                      ),
                    );
                  }),
                );
              })

            /* Recent searches (shown when input is empty) */
            : !query.trim() && recent.length > 0
            ? React.createElement('div', { className: 'fs-search-palette__group' },
                React.createElement('div', {
                  className: 'fs-search-palette__group-label',
                  role:      'presentation',
                }, 'Recent searches'),
                recent.map(function (r) {
                  return React.createElement('button', {
                    key:       r,
                    type:      'button',
                    className: 'fs-search-palette__result',
                    onClick:   function () { setQuery(r); },
                  },
                    NavIcon && React.createElement(NavIcon, {
                      name:  'clock',
                      size:  15,
                      color: 'var(--text-tertiary)',
                    }),
                    React.createElement('div', { className: 'fs-search-palette__result-body' },
                      React.createElement('span', {
                        className: 'fs-search-palette__result-title',
                      }, r),
                    ),
                  );
                }),
              )

            /* Empty prompt (only when the query itself is empty — a non-empty
               query with zero client matches but pending/found server topics
               is covered by the Topics block below, not this hint). */
            : !query.trim()
            ? React.createElement('div', { className: 'fs-search-palette__hint' },
                'Type to search across tasks, safety flags, sites, people, and topics')
            : null,

          /* Server topic results, sub-grouped by report date. Gated on
             !askMode too — the search input stays editable while the Ask
             panel is showing, so topicItems/topicLoading can otherwise
             change underneath it. */
          (!askMode && query.trim() && (topicItems.length || topicLoading))
            ? React.createElement('div', { className: 'fs-search-palette__group', key: '__topics__' },
                React.createElement('div', {
                  className: 'fs-search-palette__group-label', role: 'presentation',
                }, 'Topics'),
                topicLoading && !topicItems.length
                  ? React.createElement('div', { className: 'fs-search-palette__hint' }, 'Searching topics…')
                  : _groupTopicsByDate(topicItems).map(function (bucket) {
                      return React.createElement('div', { key: bucket.date },
                        React.createElement('div', {
                          className: 'fs-search-palette__group-label',
                          role: 'presentation',
                          style: { opacity: 0.7, fontSize: '11px', paddingLeft: '4px' },
                        }, bucket.date),
                        bucket.items.map(function (item) {
                          var idx = flatItems.indexOf(item);
                          var isSel = idx === selIdx;
                          return React.createElement('button', {
                            key: item.id, type: 'button', role: 'option',
                            'aria-selected': isSel, 'data-selected': String(isSel),
                            className: 'fs-search-palette__result'
                              + (isSel ? ' fs-search-palette__result--active' : ''),
                            onClick: function () { doSelect(item); },
                            onMouseEnter: function () { setSelIdx(idx); },
                          },
                            NavIcon && React.createElement(NavIcon, {
                              name: 'file-text', size: 15, color: 'var(--text-tertiary)' }),
                            React.createElement('div', { className: 'fs-search-palette__result-body' },
                              React.createElement('span', { className: 'fs-search-palette__result-title' }, item.title),
                              item.subtitle ? React.createElement('span', {
                                className: 'fs-search-palette__result-sub' }, item.subtitle) : null));
                        }));
                    }))
            : null,

          /* ---- "Ask FieldSight" hand-off (Task C) -------------------------
             Distinct final row, appended whenever the query is non-empty —
             whether or not any of the client-side result types matched.
             Selecting it stashes the query for Timeline's report-level
             AskChat to prefill and routes there. Styled inline (border +
             accent tint, tokens-only) rather than via composites.css so
             this stays a JS-only change — no new CSS class needed.
             Hidden while askMode is active (F1) — the ask panel above
             replaces it. */
          !askMode && askItem
            ? React.createElement('button', {
                type:            'button',
                role:            'option',
                'aria-selected': flatItems.indexOf(askItem) === selIdx,
                'data-selected': String(flatItems.indexOf(askItem) === selIdx),
                className:       'fs-search-palette__result'
                                  + (flatItems.indexOf(askItem) === selIdx ? ' fs-search-palette__result--active' : ''),
                style: {
                  borderTop:  '1px solid var(--border-subtle)',
                  marginTop:  '4px',
                  paddingTop: '10px',
                },
                onClick:         function () { doSelect(askItem); },
                onMouseEnter:    function () { setSelIdx(flatItems.indexOf(askItem)); },
              },
                NavIcon && React.createElement(NavIcon, {
                  name:  'message-circle',
                  size:  15,
                  color: 'var(--color-accent-700)',
                }),
                React.createElement('div', { className: 'fs-search-palette__result-body' },
                  React.createElement('span', {
                    className: 'fs-search-palette__result-title',
                    style:     { color: 'var(--color-accent-800)', fontWeight: 600 },
                  }, askItem.title),
                ),
              )
            : null,
        ),
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.SearchPalette = SearchPalette;
})();
