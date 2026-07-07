/* ==========================================================================
   FieldSight SearchPalette — Sprint 8.6
   --------------------------------------------------------------------------
   Full-screen search overlay opened via Cmd/Ctrl+K or the search icon
   button in the middle-column header.

   Search scope (client-side, against cached API data):
     Tasks    — action_items[].text across last 14 days
     Safety   — safety_flags + safety_observations
     Sites    — sites[].name + sites[].location
     People   — users derived from sites[].users
     Topics   — topics[].topic_title + summary, fanned out across every
                hasReport date × user in scope (own folder only for
                non-admin; capped cross-product for admin/gm — see
                TOPIC_FANOUT_CAP)

   Data is loaded once on first open and cached in module scope for the
   rest of the session (survives palette close/reopen).

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

  /* Live-data fix batch (Task 3) — cross-day/cross-user cap on the topic
     fan-out below. Admin callers have no single "own folder", so indexing
     topics means walking a (date × user) cross-product; unbounded that's
     `hasReport dates × all known users` fetches, easily 100+ round trips.
     Cap at 30 pairs — beyond it, keep the most recent report dates (the
     ones someone is most likely searching for) and drop the older ones. */
  var TOPIC_FANOUT_CAP = 30;

  /* ---------------------------------------------------------------------- */
  /* Module-level data cache — survives palette close/reopen in a session    */
  /* ---------------------------------------------------------------------- */

  var _cache = { loaded: false, loading: false,
                 tasks: [], safety: [], sites: [], users: [], topics: [] };

  function _isAdminCaller() {
    var c = (window.AuthMock && window.AuthMock.currentUser) || {};
    return c.role === 'admin' || c.role === 'gm' || !!c.isAdmin;
  }

  /* Task 3 — topic index fan-out. Builds the (date × user) pairs to walk
     for GET /api/timeline, then flattens every report's topics[] into
     cache rows. Non-admin callers only ever have one folder (their own —
     matches every other aggregator's resolveUser() clamp); admin/gm fan
     out across every known user (CLAUDE.md "Admin permission flow" ·
     compliance-aggregator.fanoutDates parity), capped at
     TOPIC_FANOUT_CAP, most-recent dates kept first. */
  function _topicFanoutPairs(reportDates) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};

    if (!_isAdminCaller()) {
      var folder = caller.name ? window.FS.api.folderName(caller.name) : null;
      if (!folder) return [];
      return reportDates.map(function (d) { return { date: d, user: folder }; });
    }

    var fx = (window.FieldSight && window.FieldSight.fixtures
      && window.FieldSight.fixtures.sites) || {};
    var folders = (fx.users || []).map(function (u) { return u.folder_name; }).filter(Boolean);
    if (!folders.length) return [];

    var total = reportDates.length * folders.length;
    var sortedDates = reportDates.slice().sort().reverse(); /* most recent first */
    var pairs = [];
    for (var i = 0; i < sortedDates.length && pairs.length < TOPIC_FANOUT_CAP; i++) {
      for (var j = 0; j < folders.length && pairs.length < TOPIC_FANOUT_CAP; j++) {
        pairs.push({ date: sortedDates[i], user: folders[j] });
      }
    }
    if (total > TOPIC_FANOUT_CAP) {
      console.debug('[SearchPalette] topic fan-out capped at ' + TOPIC_FANOUT_CAP
        + ' date\xd7user pairs (of ' + total + ' possible) — keeping the most recent dates');
    }
    return pairs;
  }

  /* Fetch + flatten topics for every (date, user) pair. Each pair is
     independently tolerant of failure (denied/not-found/errored fetches
     just contribute nothing) so one bad date never blanks the whole
     topic index. */
  async function _loadTopics(pairs) {
    if (!pairs.length) return [];
    var settled = await Promise.allSettled(pairs.map(function (p) {
      return window.FS.api.timeline.getTimeline({ date: p.date, user: p.user })
        .then(function (r) { return { date: p.date, user: p.user, report: r }; });
    }));

    var topics = [];
    settled.forEach(function (s) {
      if (s.status !== 'fulfilled') return;
      var x = s.value;
      var r = x.report;
      if (!r || r._notFound || r._accessDenied || r.available_users) return;
      (r.topics || []).forEach(function (t) {
        topics.push({
          title:    t.topic_title,
          snippet:  (t.summary || '').slice(0, 80),
          date:     x.date,
          user:     x.user,
          topic_id: t.topic_id,
        });
      });
    });
    return topics;
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

      /* Task 3 — hasReport dates drive the topic fan-out; computed here
         (not inside _loadTopics) so the pair-count/cap decision stays
         visible at the call site. */
      var reportDates = Object.keys(span.dates || {}).filter(function (d) {
        return span.dates[d] && span.dates[d].hasReport;
      }).sort();
      var topicPairs = _topicFanoutPairs(reportDates);

      var results = await Promise.all([
        window.FS.api.sites.getSites()
          .catch(function () { return { sites: [] }; }),
        window.FS.api.tasks.getActionsResolvedRange({ from: from, to: today })
          .catch(function () { return { rows: [] }; }),
        window.FS.api.compliance.getSafetyRange({ from: from, to: today })
          .catch(function () { return { rows: [] }; }),
        _loadTopics(topicPairs)
          .catch(function () { return []; }),
      ]);

      _cache.sites  = (results[0] && results[0].sites) || [];
      _cache.tasks  = (results[1] && results[1].rows)  || [];
      _cache.safety = (results[2] && results[2].rows)  || [];
      _cache.topics = results[3] || [];

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
    var byType = { task: [], safety: [], site: [], user: [], topic: [] };

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

    _cache.topics.forEach(function (row) {
      if (byType.topic.length >= 5) return;
      var hay = ((row.title || '') + ' ' + (row.snippet || '')).toLowerCase();
      if (hay.indexOf(ql) !== -1) {
        byType.topic.push({
          type:     'topic',
          id:       row.date + '_' + row.user + '_' + row.topic_id,
          title:    row.title,
          subtitle: (row.snippet ? row.snippet + ' \xb7 ' : '') + row.date,
          /* topic_id routes as a raw string — never parseInt (timeline.js
             deep-link matching is String(a) === String(b) throughout). */
          route:    '/timeline?date=' + encodeURIComponent(row.date)
                     + '&user=' + encodeURIComponent(row.user)
                     + '&topic=' + encodeURIComponent(String(row.topic_id)),
        });
      }
    });

    var out = [];
    TYPE_ORDER.forEach(function (t) { out = out.concat(byType[t]); });
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

    var inputRef = React.useRef(null);
    var listRef  = React.useRef(null);

    /* Auto-focus + kick off data preload on open */
    React.useEffect(function () {
      if (inputRef.current) inputRef.current.focus();
      _loadCache();
    }, []);

    /* Re-run search whenever query changes */
    React.useEffect(function () {
      var q = query.trim();
      if (!q) { setResults([]); setSelIdx(0); return; }
      setResults(_search(q));
      setSelIdx(0);
    }, [query]);

    /* Scroll the focused result into view */
    React.useEffect(function () {
      if (!listRef.current) return;
      var el = listRef.current.querySelector('[data-selected="true"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }, [selIdx]);

    var trimmedQuery = query.trim();

    /* Group results by type for sectioned display. Computed ahead of
       doSelect/onKeyDown below so the "Ask FieldSight" row (Task C) can
       be folded into the same flat, arrow-key-navigable list as the
       ordinary results — it's appended as the final entry whenever the
       query is non-empty, whether or not any results matched. */
    var groups = [];
    TYPE_ORDER.forEach(function (type) {
      var items = results.filter(function (r) { return r.type === type; });
      if (items.length) groups.push({ type: type, items: items });
    });
    var flatItems = groups.reduce(function (acc, g) { return acc.concat(g.items); }, []);

    var askItem = trimmedQuery
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
                  compact:         true,
                  initialQuestion: askMode.question,
                  scope:           'both',
                }),
              )
            :
          /* No match */
          query.trim() && results.length === 0
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

            /* Empty prompt */
            : React.createElement('div', { className: 'fs-search-palette__hint' },
                'Type to search across tasks, safety flags, sites, people, and topics'),

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
