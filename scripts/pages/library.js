/* ==========================================================================
   FieldSight /library — Sprint 10 B.1 + B.3
   --------------------------------------------------------------------------
   Per-company report template library. Each organisation maintains an
   Org library (admin/gm/director manage) and every user has a Personal
   library for their own formats. The All tab is a read-only union.

   Sprint 10 scope:
     B.0  Stores + permissions (template-store.js / roles.js)
     B.1  This page — route + scaffold + tabs + list + right detail
     B.2  TemplateUploadModal composite (template-upload-modal.js)
     B.3  Skip-edit primary path: source vs extracted schema side-by-side
          + Test render panel + "✓ Use this template" CTA

   Middle column:
     • Tab strip — Org / Personal / All
     • Template list rows: title, report_type badge, active indicator,
       extraction status
     • Permission-gated "+ Upload template" button

   Right detail (B.3 skip-edit primary path):
     • While extracting: spinner + progress note
     • Once ready: the template's sections, editable
       + Test-render panel (fills schema sections with sample content)
       + "✓ Use this template" CTA (activates in one click)

   Permission gate: template:manage:self  (all roles — see roles.js B.0)
   Upload button:   template:manage:org   (admin/gm/director for org scope)
                    template:manage:self  (anyone for personal scope)

   Registers as window.FieldSight.PAGES['/library']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────────────── */

  /* Sprint 10 follow-up — tab order changed to All / Organisation /
     Personal per user review. The tab `key` stays 'org' so the
     existing scope filter logic + persisted template.scope === 'org'
     records keep working; only the visible label is "Organisation". */
  var TABS = [
    { key: 'all',      label: 'All'          },
    { key: 'org',      label: 'Organisation' },
    { key: 'personal', label: 'Personal'     },
  ];

  var RT_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', incident: 'Incident' };
  var RT_TONE  = { daily: 'info', weekly: 'success', monthly: 'accent', incident: 'danger' };

  var KIND_LABEL = { narrative: 'Narrative', list: 'List', table: 'Table', kpi: 'KPIs', photos: 'Photos' };
  var KIND_ICON  = { narrative: '¶', list: '•', table: '⊞', kpi: '◆', photos: '🖼' };

  /* ── Helpers ───────────────────────────────────────────────────────── */

  function fmtDate(iso) {
    if (!iso) return '';
    var p = iso.slice(0, 10).split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + p[0];
  }

  /* How many sections a row should claim. The server counts it (one query for
     the whole list); a schema in hand is used when it is there. null means
     nobody could say, and the row then says nothing rather than "0 sections",
     which would be a claim about the template that nothing checked. */
  function sectionCount(tpl) {
    if (tpl && typeof tpl.section_count === 'number') return tpl.section_count;
    var schema = activeSchema(tpl);
    return schema && schema.sections ? schema.sections.length : null;
  }

  function activeSchema(tpl) {
    if (!tpl || !tpl.versions || !tpl.versions.length) return null;
    var vers = tpl.versions;
    return vers[vers.length - 1].schema;
  }

  /* Sample content for each section kind used in the Test Render panel */
  var SAMPLE = {
    narrative: 'Concrete pours for Grid C foundations completed ahead of schedule. Subcontractor coordination for electrical rough-in confirmed for tomorrow morning. Weather held — no delays.',
    list:      ['Agreed revised sequence for Block B roofing with Coastline Roofing — start Friday', 'Client approved variation VO-14 ($8,400) for additional drainage run', 'Defect list from 2 May inspection signed off by SM'],
    kpi:       { headcount: 24, subcontractors: 3, visitors: 1, completion_pct: '62%', days_variance: '+2', rfi_open: 4, budget_pct: '58%' },
    table:     [
      { action: 'Issue revised IFC drawings for Block B roof', owner: 'James Lamb',    due_date: '12 May 2026' },
      { action: 'Confirm crane availability w/c 18 May',        owner: 'Jarley Trainor', due_date: '10 May 2026' },
      { action: 'Submit VO-15 for approval',                    owner: 'James Lamb',    due_date: '15 May 2026' },
    ],
    photos:    ['Progress photo 1', 'Progress photo 2', 'Progress photo 3'],
  };

  /* ── Context ───────────────────────────────────────────────────────── */

  var LibraryContext = React.createContext(null);

  /* ── Provider ──────────────────────────────────────────────────────── */

  function LibraryProvider(props) {
    var caller    = (window.AuthMock && window.AuthMock.currentUser) || {};
    var canManageOrg = window.FS && window.FS.can && window.FS.can(caller, 'template:manage:org');

    var tabRef    = React.useState('all');   /* Sprint 10 follow-up — default 'all' */
    var tab       = tabRef[0]; var setTab = tabRef[1];

    /* Sprint 10 follow-up — favourites pin list (per-user, max 6). */
    var favRef    = React.useState([]);
    var favIds    = favRef[0]; var setFavIds = favRef[1];

    var stateRef  = React.useState({ status: 'loading', rows: [] });
    var state     = stateRef[0]; var setState = stateRef[1];

    var selRef    = React.useState(null);
    var sel       = selRef[0]; var setSel = selRef[1];

    /* OPENING A TEMPLATE FETCHES IT.
       Clicking a row selects the row, and a row comes from the LIST, which
       deliberately carries no bodies -- returning every version of every
       template to draw a list would be absurd. So the selected template has
       to be completed, and opening one is exactly the moment its sections are
       needed.

       This is the half that was missing when the API was fixed to return
       sections on `get`: nothing called `get`. The endpoint was correct and
       unreachable, the panel still had nothing to render, and the backend
       test passed the whole time because it asked the API a question the page
       never asked.

       Runs only when there is something to fetch: a template whose
       current_version is 0 has no body to complete, and one that already has
       its versions is whole -- which is also what stops this from looping,
       since the fetch replaces `sel` with a version-carrying copy. */
    React.useEffect(function () {
      if (!sel || !sel.id) return undefined;
      if (sel.versions && sel.versions.length) return undefined;
      if (!sel.current_version) return undefined;
      var api = window.FS && window.FS.api && window.FS.api.templates;
      if (!api || !api.get) return undefined;
      var alive = true;
      api.get(sel.id).then(function (full) {
        /* Only when it actually arrived with content. Replacing the selection
           with another empty copy would swap one silent failure for a loop. */
        if (alive && full && full.versions && full.versions.length) setSel(full);
      }).catch(function () {
        /* The panel says what it can see; it does not need a second voice. */
      });
      return function () { alive = false; };
    }, [sel && sel.id, sel && sel.versions && sel.versions.length]);

    var uploadRef = React.useState(null);  /* null | 'org' | 'personal' */
    var uploadFor = uploadRef[0]; var setUploadFor = uploadRef[1];

    var retryRef  = React.useState(0);
    var retry     = retryRef[0]; var setRetry = retryRef[1];

    function load() {
      setState(function (s) { return Object.assign({}, s, { status: 'loading' }); });
      var scope = (tab === 'org' || tab === 'personal') ? tab : 'all';
      window.FS.api.templates.list(scope === 'all' ? undefined : scope).then(function (res) {
        setState({ status: 'ok', rows: res.templates || [] });
      }).catch(function (err) {
        setState({ status: 'error', rows: [], error: (err && err.message) || 'Could not load templates.' });
      });
    }

    /* Initial load + re-load when tab or retry changes */
    React.useEffect(function () { load(); }, [tab, retry]);

    /* Sprint 10 follow-up — load favourites once + on retry */
    React.useEffect(function () {
      if (!window.FS.api.templates.getFavourites) return;
      window.FS.api.templates.getFavourites().then(function (ids) {
        setFavIds(ids || []);
      });
    }, [retry]);

    function toggleFavourite(id) {
      window.FS.api.templates.toggleFavourite(id).then(function (next) {
        setFavIds(next || []);
        if (window.FS && window.FS.toast) {
          var nowFav = (next || []).indexOf(id) >= 0;
          window.FS.toast.show({
            message: nowFav ? 'Added to Favourites' : 'Removed from Favourites',
            tone:    nowFav ? 'success' : 'info',
          });
        }
      }).catch(function () {
        if (window.FS && window.FS.toast) {
          window.FS.toast.show({ message: 'Favourites cap reached (6)', tone: 'warning' });
        }
      });
    }

    /* Listen for ADE extraction completions to auto-refresh */
    React.useEffect(function () {
      if (!window.FS.templateStore) return;
      var unsub = window.FS.templateStore.onExtracted(function () {
        /* Small delay so the store write settles before we re-read */
        setTimeout(function () { setRetry(function (n) { return n + 1; }); }, 100);
      });
      return unsub;
    }, []);

    function handleUploadComplete(stub) {
      setUploadFor(null);
      setRetry(function (n) { return n + 1; });
      setSel(stub);
      if (window.FS && window.FS.toast) {
        window.FS.toast.show({ message: 'Template created — edit its sections below', tone: 'info' });
      }
    }

    /* DELETE. The backend soft-deletes: the template leaves the library and
       every version it ever had is kept, because a withdrawn template is still
       the template that wrote last month's reports. The confirm says that --
       "delete" alone would suggest the reports go with it.

       The refusal that matters is 409, raised when a scheduled report still
       points at this template. It is shown verbatim, because the server knows
       which schedule and this page does not, and "could not delete" would send
       someone hunting for a permissions problem that is not there. */
    function handleDelete(tpl) {
      if (!tpl) return;
      var ok = window.confirm(
        'Delete "' + tpl.title + '"?' + String.fromCharCode(10, 10)
        + 'It is removed from the library. Reports already written to it keep '
        + 'their own copy of it, so nothing you have sent out changes.');
      if (!ok) return;
      window.FS.api.templates['delete'](tpl.id).then(function () {
        setSel(null);
        setRetry(function (n) { return n + 1; });
        if (window.FS && window.FS.toast) {
          window.FS.toast.show({ message: '"' + tpl.title + '" deleted', tone: 'success' });
        }
      }).catch(function (err) {
        if (window.FS && window.FS.toast) {
          window.FS.toast.show({
            message: (err && err.message) || 'Could not delete this template',
            tone: 'error',
          });
        }
      });
    }

    function handleActivate(tpl) {
      window.FS.api.templates.activate(tpl.id).then(function (updated) {
        setRetry(function (n) { return n + 1; });
        setSel(updated);
        if (window.FS && window.FS.toast) {
          window.FS.toast.show({ message: '"' + updated.title + '" set as active template', tone: 'success' });
        }
      }).catch(function () {
        if (window.FS && window.FS.toast) window.FS.toast.show({ message: 'Could not activate template', tone: 'error' });
      });
    }

    function reload() { setRetry(function (n) { return n + 1; }); }

    return React.createElement(LibraryContext.Provider, {
      value: {
        caller, canManageOrg, tab, setTab, state, sel, setSel, handleDelete,
        uploadFor, setUploadFor, handleUploadComplete, handleActivate, reload,
        /* Sprint 10 follow-up — favourites */
        favIds, toggleFavourite,
      },
    }, props.children);
  }

  /* ── Middle column ─────────────────────────────────────────────────── */

  function LibraryMiddle() {
    var ctx = React.useContext(LibraryContext);

    if (!ctx) return null;

    var tab          = ctx.tab;
    var setTab       = ctx.setTab;
    var state        = ctx.state;
    var sel          = ctx.sel;
    var setSel       = ctx.setSel;
    var canManageOrg = ctx.canManageOrg;
    var setUploadFor = ctx.setUploadFor;
    var caller       = ctx.caller;

    var Badge  = window.FieldSight.Badge;
    var Button = window.FieldSight.Button;
    var ErrorBanner = window.FieldSight.ErrorBanner;

    /* Can user upload to the current tab's scope? */
    var canUploadHere = tab === 'personal'
      ? !!(window.FS && window.FS.can && window.FS.can(caller, 'template:manage:self'))
      : (tab === 'org' && canManageOrg) || (tab === 'all' && canManageOrg);

    /* Group rows by report_type for the list */
    var rows = state.rows || [];

    return React.createElement('div', { className: 'fs-library__middle' },

      /* Header */
      React.createElement('div', { className: 'fs-library__header' },
        React.createElement('h1', { className: 'fs-library__title' }, 'Template Library'),
        canUploadHere && React.createElement(Button, {
          variant:  'primary',
          size:     'sm',
          onClick:  function () { setUploadFor(tab === 'personal' ? 'personal' : 'org'); },
        }, '+ Upload template'),
      ),

      /* Tab strip */
      React.createElement('div', { className: 'fs-library__tabs', role: 'tablist' },
        TABS.map(function (t) {
          return React.createElement('button', {
            key:           t.key,
            role:          'tab',
            'aria-selected': tab === t.key,
            className:     'fs-library__tab' + (tab === t.key ? ' fs-library__tab--active' : ''),
            onClick:       function () { setTab(t.key); setSel(null); },
          }, t.label);
        }),
      ),

      /* Sprint 10 follow-up — Favourites row (Heidi-style pin shelf) */
      React.createElement(FavouritesRow, { ctx: ctx }),

      /* Body */
      state.status === 'loading' && React.createElement('div', { className: 'fs-library__loading' },
        React.createElement('div', { className: 'fs-library__skeleton' }),
        React.createElement('div', { className: 'fs-library__skeleton' }),
        React.createElement('div', { className: 'fs-library__skeleton' }),
      ),

      state.status === 'error' && ErrorBanner
        ? React.createElement(ErrorBanner, { message: state.error || 'Failed to load templates.' })
        : null,

      state.status === 'ok' && rows.length === 0 && React.createElement('div', { className: 'fs-library__empty' },
        React.createElement('p', null, tab === 'personal'
          ? 'No personal templates yet. Create one to get started.'
          : 'No org templates yet.' + (canManageOrg ? ' Upload one to make it available to all users.' : '')
        ),
      ),

      state.status === 'ok' && rows.length > 0 && React.createElement('div', { className: 'fs-library__list', role: 'list' },
        rows.map(function (tpl) {
          var isSelected   = sel && sel.id === tpl.id;
          var isExtracting = tpl._status === 'extracting';
          var hasSchema    = tpl.versions && tpl.versions.length > 0;
          var isFav        = (ctx.favIds || []).indexOf(tpl.id) >= 0;

          return React.createElement('div', {
            key:          tpl.id,
            role:         'listitem',
            className:    'fs-library__row' + (isSelected ? ' fs-library__row--selected' : ''),
            onClick:      function () { setSel(tpl); },
            tabIndex:     0,
            onKeyDown:    function (e) { if (e.key === 'Enter' || e.key === ' ') setSel(tpl); },
            'aria-current': isSelected ? 'true' : undefined,
          },
            React.createElement('div', { className: 'fs-library__row-main' },
              React.createElement('span', { className: 'fs-library__row-title' }, tpl.title),
              tpl.active && React.createElement('span', { className: 'fs-library__active-badge' }, 'Active'),
            ),
            React.createElement('div', { className: 'fs-library__row-meta' },
              Badge && React.createElement(Badge, {
                tone:  RT_TONE[tpl.report_type] || 'neutral',
                label: RT_LABEL[tpl.report_type] || tpl.report_type,
                size:  'xs',
              }),
              tpl.scope === 'personal' && React.createElement('span', { className: 'fs-library__personal-tag' }, 'Personal'),
              isExtracting && React.createElement('span', { className: 'fs-library__extracting-tag' }, 'Extracting…'),
              /* From the server's count when it sent one, falling back to the
                 loaded schema. The list does not carry every template's body
                 -- that would hand back every version of every template to
                 draw one number -- so counting the schema alone showed
                 nothing at all on this page. */
              !isExtracting && sectionCount(tpl) !== null
                && React.createElement('span', { className: 'fs-library__sections-count' },
                  sectionCount(tpl) + ' section' + (sectionCount(tpl) === 1 ? '' : 's'),
                ),
            ),
            /* Sprint 10 follow-up — favourite toggle (right-aligned star). */
            React.createElement('button', {
              type:        'button',
              className:   'fs-library__row-fav' + (isFav ? ' fs-library__row-fav--on' : ''),
              onClick:     function (e) { e.stopPropagation(); ctx.toggleFavourite(tpl.id); },
              'aria-label': isFav ? 'Remove from favourites' : 'Add to favourites',
              'aria-pressed': isFav,
              title:       isFav ? 'Remove from favourites' : 'Add to favourites',
            }, isFav ? '★' : '☆'),
          );
        }),
      ),

      /* Upload modal */
      ctx.uploadFor && window.FieldSight.TemplateUploadModal && React.createElement(
        window.FieldSight.TemplateUploadModal,
        {
          scope:      ctx.uploadFor,
          onComplete: ctx.handleUploadComplete,
          onCancel:   function () { ctx.setUploadFor(null); },
        },
      ),

    );
  }

  /* ── Sprint 10 follow-up · Favourites row (Heidi-style pin shelf) ───── */

  function FavouritesRow(props) {
    var ctx = props.ctx;
    if (!ctx) return null;
    var Badge = window.FieldSight.Badge;
    var FAV_CAP = (window.FS.api.templates && window.FS.api.templates.FAVOURITES_CAP) || 6;

    /* Resolve favourite IDs against the loaded rows; templates not in
       the current tab still show (we union across scopes) so the pin
       shelf is stable as the user toggles between Org / Personal. */
    var allRows = ctx.state && ctx.state.rows ? ctx.state.rows : [];
    var pinned  = (ctx.favIds || [])
      .map(function (id) {
        return allRows.filter(function (r) { return r.id === id; })[0];
      })
      .filter(Boolean);

    /* Hide the row entirely on the All tab when nothing is favourited
       — feels less empty than showing 6 dotted slots before the user
       has started using the feature. */
    if (pinned.length === 0 && (ctx.favIds || []).length === 0) {
      /* Show one "empty hint" tile so the feature is discoverable. */
      return React.createElement('div', { className: 'fs-library__favs-row fs-library__favs-row--empty' },
        React.createElement('div', { className: 'fs-library__favs-label' }, 'Favourites'),
        React.createElement('div', { className: 'fs-library__favs-tiles' },
          React.createElement('div', { className: 'fs-library__favs-empty-hint' },
            'Tap the ☆ on any template to pin it here for one-click access.'
          ),
        ),
      );
    }

    var emptySlots = Math.max(0, FAV_CAP - pinned.length);

    return React.createElement('div', { className: 'fs-library__favs-row' },
      React.createElement('div', { className: 'fs-library__favs-label' }, 'Favourites'),
      React.createElement('div', { className: 'fs-library__favs-tiles' },
        pinned.map(function (tpl) {
          return React.createElement('button', {
            key:        tpl.id,
            type:       'button',
            className:  'fs-library__fav-tile',
            onClick:    function () { ctx.setSel(tpl); },
            title:      tpl.title + ' · ' + (RT_LABEL[tpl.report_type] || tpl.report_type),
          },
            React.createElement('span', { className: 'fs-library__fav-tile-name' },
              tpl.title),
            React.createElement('span', { className: 'fs-library__fav-tile-meta' },
              Badge && React.createElement(Badge, {
                tone:  RT_TONE[tpl.report_type] || 'neutral',
                label: RT_LABEL[tpl.report_type] || tpl.report_type,
                size:  'xs',
              }),
              tpl.scope === 'personal'
                ? React.createElement('span', { className: 'fs-library__personal-tag' }, 'Personal')
                : null,
            ),
            React.createElement('span', {
              className: 'fs-library__fav-tile-unpin',
              onClick:   function (e) { e.stopPropagation(); ctx.toggleFavourite(tpl.id); },
              role:      'button',
              tabIndex:  0,
              onKeyDown: function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); ctx.toggleFavourite(tpl.id); }
              },
              title:    'Remove from favourites',
              'aria-label': 'Remove from favourites',
            }, '×'),
          );
        }),
        /* Empty slots — visual rhythm + invitation to add more */
        Array.from({ length: emptySlots }).map(function (_, i) {
          return React.createElement('div', {
            key:       'empty-' + i,
            className: 'fs-library__fav-tile fs-library__fav-tile--empty',
            'aria-hidden': true,
          }, '+');
        }),
      ),
    );
  }

  /* ── Schema editor: add / describe / rename / reorder / delete ───────
     A blank section is added with empty fields on purpose. The alternative is
     seeding it with placeholder wording, and a section's `purpose` IS THE
     PROMPT -- "Describe this section" would be handed to the model as an
     instruction and dutifully written up. Empty and refused beats plausible
     and wrong.

     So the editor enforces the rule the server enforces: every section needs
     a title and a purpose. Checked here as well, not instead -- the server
     stays the authority -- because a save that bounces after a round trip
     makes the person hunt for which of nine sections it meant. */

  function SchemaEditor(props) {
    var templateId = props.templateId;
    var schema     = props.schema;
    var Button     = window.FieldSight && window.FieldSight.Button;

    /* Sprint 10 follow-up — sections now support 1-level nesting via
       a `children: []` array. Init preserves any existing children;
       backwards-compat with flat schemas (children defaults to []). */
    var secRef     = React.useState(function () {
      var counter = { n: 0 };
      function tagKeys(arr) {
        return (arr || []).map(function (s) {
          return {
            title:       s.title,
            kind:        s.kind,
            fields:      s.fields || [],
            prompt_hint: s.prompt_hint || '',
            children:    tagKeys(s.children || []),
            _key:        counter.n++,
          };
        });
      }
      return tagKeys(schema.sections || []);
    });
    var sections    = secRef[0]; var setSections = secRef[1];

    var noteRef     = React.useState('');
    var changeNote  = noteRef[0]; var setChangeNote = noteRef[1];

    var savingRef   = React.useState(false);
    var saving      = savingRef[0]; var setSaving = savingRef[1];

    var errRef      = React.useState(null);
    var saveErr     = errRef[0]; var setSaveErr = errRef[1];

    /* Drag state — current dragged path + current hover target +
       drop zone within target ('before' | 'into' | 'after'). */
    var dragRef    = React.useState(null);
    var dragPath   = dragRef[0]; var setDragPath = dragRef[1];

    var hoverRef   = React.useState(null);
    var hoverPath  = hoverRef[0]; var setHoverPath = hoverRef[1];

    var zoneRef    = React.useState('after');
    var dropZone   = zoneRef[0]; var setDropZone = zoneRef[1];

    /* ── Path helpers (path = 'i' or 'i.j') ──────────────────────────── */

    function pathToArr(p)      { return p.split('.').map(Number); }
    function pathEq(a, b)      { return a === b; }
    function pathStartsWith(child, parent) {
      return child === parent || child.indexOf(parent + '.') === 0;
    }
    function getAt(arr, p) {
      var idx = pathToArr(p);
      var cur = arr;
      var node = null;
      for (var i = 0; i < idx.length; i++) {
        node = cur[idx[i]];
        if (!node) return null;
        cur = node.children || [];
      }
      return node;
    }
    function removeAt(arr, p) {
      var idx = pathToArr(p);
      function rec(list, i) {
        var copy = list.slice();
        if (i === idx.length - 1) {
          copy.splice(idx[i], 1);
          return copy;
        }
        copy[idx[i]] = Object.assign({}, copy[idx[i]], {
          children: rec(copy[idx[i]].children || [], i + 1),
        });
        return copy;
      }
      return rec(arr, 0);
    }
    function insertAt(arr, p, position, item) {
      /* position: 'before' | 'after' | 'into' (last child of node at p) */
      var idx = pathToArr(p);
      function rec(list, i) {
        var copy = list.slice();
        if (i === idx.length - 1) {
          if (position === 'before')      copy.splice(idx[i], 0, item);
          else if (position === 'after')  copy.splice(idx[i] + 1, 0, item);
          else if (position === 'into') {
            /* Append into the target's children. Only allow nesting
               at top level (don't make grand-children → keeps 1-level
               cap) — if target is already a child, treat as 'after'. */
            if (i > 0) {
              copy.splice(idx[i] + 1, 0, item);
            } else {
              var withChildren = Object.assign({}, copy[idx[i]], {
                children: (copy[idx[i]].children || []).concat([item]),
              });
              copy[idx[i]] = withChildren;
            }
          }
          return copy;
        }
        copy[idx[i]] = Object.assign({}, copy[idx[i]], {
          children: rec(copy[idx[i]].children || [], i + 1),
        });
        return copy;
      }
      return rec(arr, 0);
    }

    /* ── Mutations ───────────────────────────────────────────────────── */

    /* One walker for every per-section edit. rename() had its own recursion;
       a second and third copy for the hint and the kind is three places to fix
       when the nesting rule changes. */
    function editAt(p, change) {
      setSections(function (prev) {
        var idx = pathToArr(p);
        function rec(list, i) {
          var copy = list.slice();
          if (i === idx.length - 1) {
            copy[idx[i]] = change(copy[idx[i]]);
            return copy;
          }
          copy[idx[i]] = Object.assign({}, copy[idx[i]], {
            children: rec(copy[idx[i]].children || [], i + 1),
          });
          return copy;
        }
        return rec(prev, 0);
      });
    }

    /* Both halves of a section are editable. `prompt_hint` was display-only,
       so a template's headings could be changed and what each heading was FOR
       could not -- and that sentence is the only part of a section the model
       actually reads. Adding sections without it would be adding empty ones. */
    function setHint(p, val) {
      editAt(p, function (sec) { return Object.assign({}, sec, { prompt_hint: val }); });
    }

    function setKind(p, val) {
      editAt(p, function (sec) { return Object.assign({}, sec, { kind: val }); });
    }

    var addedKey = React.useRef ? React.useRef(null) : { current: null };

    function blankSection() {
      var key = 'new-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      addedKey.current = key;
      return { title: '', kind: 'narrative', fields: [], prompt_hint: '',
               children: [], _key: key };
    }

    function addSection() {
      setSections(function (prev) { return prev.concat([blankSection()]); });
    }

    /* A sub-section, under a top-level one. The nesting cap is one level, the
       same cap dragging enforces, so this is offered on parents only. */
    function addChild(p) {
      editAt(p, function (sec) {
        return Object.assign({}, sec, {
          children: (sec.children || []).concat([blankSection()]),
        });
      });
    }

    function rename(p, val) {
      editAt(p, function (sec) { return Object.assign({}, sec, { title: val }); });
    }

    function del(p) {
      setSections(function (prev) {
        /* Promote children to the deleted node's level rather than
           dropping them — gives the user a recoverable result if they
           delete a parent by accident. */
        var node = getAt(prev, p);
        var children = (node && node.children) || [];
        var without  = removeAt(prev, p);
        if (children.length === 0) return without;
        /* Insert children at deleted parent's position. */
        var parts = pathToArr(p);
        if (parts.length === 1) {
          /* Top-level delete — splice children at idx */
          var copy = without.slice();
          copy.splice.apply(copy, [parts[0], 0].concat(children.map(function (c) {
            return Object.assign({}, c, { children: [] });
          })));
          return copy;
        }
        return without;
      });
    }

    function moveByDrag() {
      if (!dragPath || !hoverPath || dragPath === hoverPath) return;
      if (pathStartsWith(hoverPath, dragPath)) return;  /* prevent dropping onto self/descendant */
      setSections(function (prev) {
        var node = getAt(prev, dragPath);
        if (!node) return prev;
        /* 1-level nesting cap — if the dragged node has children and
           we're trying to nest it, drop those children at top level
           rather than silently turning them into invisible
           grand-children. */
        var effectiveZone = dropZone;
        if (effectiveZone === 'into' && node.children && node.children.length > 0) {
          effectiveZone = 'after';  /* refuse the nest, fall back to reorder */
        }
        var without  = removeAt(prev, dragPath);
        /* Recompute hover path after removal — if drop target's path
           drifts because the source was removed earlier in the tree.
           Simpler safe approach: re-insert relative to the original
           target by id, not path. Since _key is unique, find it: */
        function findPath(list, key, base) {
          for (var i = 0; i < list.length; i++) {
            var p = base ? base + '.' + i : '' + i;
            if (list[i]._key === key) return p;
            var inChild = findPath(list[i].children || [], key, p);
            if (inChild) return inChild;
          }
          return null;
        }
        var target = getAt(prev, hoverPath);
        var newHover = target ? findPath(without, target._key, '') : null;
        if (!newHover) return prev;
        return insertAt(without, newHover, effectiveZone, node);
      });
    }

    /* The server's rule, checked here as well and never instead: every section
       needs a title and a purpose, because render_prompt writes one heading
       per section and the purpose under it is the instruction. Returns the
       first offender by name so the message can point at it -- "a section is
       incomplete" across nine of them is a hunt. */
    function firstIncomplete(list, trail) {
      for (var i = 0; i < list.length; i += 1) {
        var sec = list[i];
        var where = (trail ? trail + ' › ' : '') + (sec.title || '').trim();
        if (!(sec.title || '').trim()) {
          return { what: 'a title', where: trail || 'the list', nth: i + 1 };
        }
        if (!(sec.prompt_hint || '').trim()) {
          return { what: 'a description', where: where, nth: i + 1 };
        }
        var inner = firstIncomplete(sec.children || [], where);
        if (inner) return inner;
      }
      return null;
    }

    function save() {
      var gap = firstIncomplete(sections, '');
      if (gap) {
        setSaveErr(gap.what === 'a title'
          ? ('Section ' + gap.nth + ' needs a title before this can be saved.')
          : ('“' + gap.where + '” needs a description — that sentence is '
             + 'what tells the report what belongs in the section.'));
        return;
      }
      setSaving(true); setSaveErr(null);
      function strip(arr) {
        return arr.map(function (s) {
          var out = { title: s.title, kind: s.kind, fields: s.fields, prompt_hint: s.prompt_hint };
          if (s.children && s.children.length) out.children = strip(s.children);
          return out;
        });
      }
      var newSchema = { sections: strip(sections) };
      window.FS.api.templates.updateSchema(templateId, newSchema, changeNote || 'Edited sections').then(function (updated) {
        setSaving(false);
        if (props.onSaved) props.onSaved(updated);
      }).catch(function (err) {
        setSaving(false);
        setSaveErr((err && err.message) || 'Could not save');
      });
    }

    /* ── Drag handlers ───────────────────────────────────────────────── */

    function onDragStart(p) {
      return function (e) {
        /* CRITICAL: <li>s are nested (parent contains child <ol> with
           more <li>s). Without stopPropagation, dragging a child fires
           the child's onDragStart, then bubbles up and the parent's
           handler overwrites dragPath to the parent's path — moving
           the parent (and all its children) instead of the child. The
           visible effect is "the parent disappears" because it gets
           folded as a child of the drop target. */
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', p);
        setDragPath(p);
      };
    }
    function onDragOver(p) {
      return function (e) {
        e.preventDefault();
        e.stopPropagation();  /* same nesting reason as onDragStart */
        e.dataTransfer.dropEffect = 'move';
        if (!dragPath) return;
        if (pathStartsWith(p, dragPath)) return;  /* skip self/descendants */
        var rect = e.currentTarget.getBoundingClientRect();
        var y    = e.clientY - rect.top;
        var h    = rect.height;
        var isChild = pathToArr(p).length > 1;
        /* On child targets, never compute 'into' (1-level nesting cap).
           On top-level targets, tighten 'into' to the middle 20% so
           reorder is the easy gesture and nest is deliberate. */
        var zone;
        if (isChild) {
          zone = (y < h * 0.5) ? 'before' : 'after';
        } else if (y < h * 0.40) {
          zone = 'before';
        } else if (y > h * 0.60) {
          zone = 'after';
        } else {
          zone = 'into';
        }
        setHoverPath(p);
        setDropZone(zone);
      };
    }
    function onDrop() {
      return function (e) {
        e.preventDefault();
        e.stopPropagation();
        moveByDrag();
        setDragPath(null); setHoverPath(null); setDropZone('after');
      };
    }
    function onDragEnd() {
      setDragPath(null); setHoverPath(null); setDropZone('after');
    }

    /* Promote a child back to top level — explicit escape hatch since
       drag-back-to-top is fiddly inside nested <ol>. Inserts the
       promoted node just after its current parent. */
    function promote(p) {
      var parts = pathToArr(p);
      if (parts.length < 2) return;  /* already top-level */
      setSections(function (prev) {
        var node = getAt(prev, p);
        if (!node) return prev;
        var without = removeAt(prev, p);
        var parentIdx = parts[0];
        var copy = without.slice();
        copy.splice(parentIdx + 1, 0, Object.assign({}, node, { children: [] }));
        return copy;
      });
    }

    /* ── Render helpers ──────────────────────────────────────────────── */

    function renderSectionRow(sec, p, isChild, totalAtLevel) {
      var idx           = pathToArr(p)[pathToArr(p).length - 1];
      var hovered       = hoverPath === p && dragPath !== null && !pathStartsWith(p, dragPath);
      var hoveredZone   = hovered ? dropZone : null;

      return React.createElement('li', {
        key:       sec._key,
        className: 'fs-library__editor-section'
                   + (isChild ? ' fs-library__editor-section--child' : '')
                   + (dragPath === p ? ' fs-library__editor-section--dragging' : '')
                   + (hoveredZone === 'before' ? ' fs-library__editor-section--drop-before' : '')
                   + (hoveredZone === 'into'   ? ' fs-library__editor-section--drop-into'   : '')
                   + (hoveredZone === 'after'  ? ' fs-library__editor-section--drop-after'  : ''),
        draggable: true,
        onDragStart: onDragStart(p),
        onDragOver:  onDragOver(p),
        onDrop:      onDrop(),
        onDragEnd:   onDragEnd,
      },
        React.createElement('span', {
          className:   'fs-library__editor-drag-handle',
          'aria-hidden': true,
          title:       'Drag to reorder or nest',
        }, '⋮⋮'),
        React.createElement('span', {
          className: 'fs-library__editor-kind-tag',
          title:     KIND_LABEL[sec.kind] || sec.kind,
        }, KIND_ICON[sec.kind] || '•'),
        React.createElement('input', {
          className:   'fs-library__editor-section-input',
          value:       sec.title,
          onChange:    function (e) { rename(p, e.target.value); },
          'aria-label': 'Section title',
          placeholder: 'Section heading',
          maxLength:   80,
          autoFocus:   sec._key === addedKey.current,
        }),
        React.createElement('div', { className: 'fs-library__editor-section-controls' },
          /* A sub-section, one level only -- the same cap dragging enforces. */
          !isChild && React.createElement('button', {
            type: 'button', className: 'fs-library__editor-addchild-btn',
            onClick: function () { addChild(p); },
            'aria-label': 'Add a sub-section', title: 'Add a sub-section',
          }, '+'),
          isChild && React.createElement('button', {
            type: 'button', className: 'fs-library__editor-promote-btn',
            onClick: function () { promote(p); },
            'aria-label': 'Promote to top level', title: 'Promote to top level',
          }, '↤'),
          React.createElement('button', {
            type: 'button', className: 'fs-library__editor-delete-btn',
            onClick: function () { del(p); }, disabled: sections.length <= 1 && !isChild,
            'aria-label': 'Delete section', title: 'Delete',
          }, '×'),
        ),

        /* WHAT THE SECTION IS FOR. This sentence is the only part of a section
           the model reads -- the heading is just a heading. It was display-only
           until now, so a template's headings could be changed and their
           meaning could not. The label says so plainly, because somebody
           filling it in is writing an instruction, not a caption. */
        React.createElement('div', { className: 'fs-library__editor-section-hint' },
          React.createElement('select', {
            className:   'fs-library__editor-kind-select',
            value:       sec.kind || 'narrative',
            onChange:    function (e) { setKind(p, e.target.value); },
            'aria-label': 'How this section is laid out',
            title:       'How this section is laid out',
          }, Object.keys(KIND_LABEL).map(function (k) {
            return React.createElement('option', { key: k, value: k }, KIND_LABEL[k]);
          })),
          React.createElement('input', {
            className:   'fs-library__editor-hint-input',
            value:       sec.prompt_hint || '',
            onChange:    function (e) { setHint(p, e.target.value); },
            'aria-label': 'What goes in this section',
            placeholder: 'What goes in this section — e.g. "Hazards raised, and whether a control was agreed"',
            maxLength:   400,
          }),
        ),
        /* Recursive children (only top-level can have children — 1-level cap) */
        !isChild && sec.children && sec.children.length > 0
          ? React.createElement('ol', { className: 'fs-library__editor-section-list fs-library__editor-children' },
              sec.children.map(function (child, j) {
                return renderSectionRow(child, p + '.' + j, true, sec.children.length);
              }),
            )
          : null,
      );
    }

    return React.createElement('div', { className: 'fs-library__editor' },

      React.createElement('p', { className: 'fs-library__editor-hint' },
        'Drag the ⋮⋮ handle to reorder. Drop a section ',
        React.createElement('strong', null, 'into the middle'),
        ' of another to make it a sub-section. Use ',
        React.createElement('strong', null, '↤'),
        ' on a sub-section to promote it back to top level.'
        /* "Re-upload to change a section's kind" used to end this sentence.
           It was wrong twice over: the kind is editable in place now, and
           re-uploading never read the file anyway. */
      ),

      React.createElement('ol', { className: 'fs-library__editor-section-list' },
        sections.map(function (sec, idx) {
          return renderSectionRow(sec, '' + idx, false, sections.length);
        }),
      ),

      /* Below the list, because that is where the new one appears. A blank
         section is deliberately blank: seeding it with placeholder wording
         would put that wording in the prompt, and the model would write it up
         as an instruction. */
      React.createElement('button', {
        type:      'button',
        className: 'fs-library__editor-add-btn',
        onClick:   addSection,
      }, '+ Add section'),

      React.createElement('div', { className: 'fs-library__editor-footer' },
        React.createElement('label', { className: 'fs-library__editor-change-label' }, 'Change note'),
        React.createElement('input', {
          className:   'fs-library__editor-change-input',
          type:        'text',
          placeholder: 'e.g. Removed photos section',
          value:       changeNote,
          onChange:    function (e) { setChangeNote(e.target.value); },
          maxLength:   200,
        }),
        saveErr && React.createElement('p', { className: 'fs-library__editor-error' }, saveErr),
        React.createElement('div', { className: 'fs-library__editor-actions' },
          Button && React.createElement(Button, {
            variant: 'primary', size: 'sm',
            onClick: save,
            disabled: saving || sections.length === 0,
          }, saving ? 'Saving…' : 'Save changes'),
          Button && React.createElement(Button, {
            variant: 'ghost', size: 'sm',
            onClick: props.onCancel,
          }, 'Cancel'),
        ),
      ),

    );
  }

  /* ── B.5 Version History Panel ─────────────────────────────────────── */

  function VersionHistoryPanel(props) {
    var templateId   = props.templateId;
    var latestSchema = props.latestSchema;
    var canManage    = props.canManage;
    var Button       = window.FieldSight && window.FieldSight.Button;

    var loadRef      = React.useState({ status: 'loading', versions: [] });
    var load         = loadRef[0]; var setLoad = loadRef[1];

    var selVidRef    = React.useState(null);
    var selVid       = selVidRef[0]; var setSelVid = selVidRef[1];

    var restoringRef = React.useState(false);
    var restoring    = restoringRef[0]; var setRestoring = restoringRef[1];

    React.useEffect(function () {
      setLoad({ status: 'loading', versions: [] });
      window.FS.api.templates.listVersions(templateId).then(function (res) {
        /* Display newest-first */
        setLoad({ status: 'ok', versions: (res.versions || []).slice().reverse() });
      }).catch(function () {
        setLoad({ status: 'error', versions: [] });
      });
    }, [templateId]);

    function diffSections(verSchema) {
      if (!verSchema || !latestSchema) return null;
      var vTitles = (verSchema.sections || []).map(function (s) { return s.title; });
      var lTitles = (latestSchema.sections || []).map(function (s) { return s.title; });
      return {
        same:    vTitles.filter(function (t) { return lTitles.indexOf(t) !== -1; }),
        removed: vTitles.filter(function (t) { return lTitles.indexOf(t) === -1; }),
        added:   lTitles.filter(function (t) { return vTitles.indexOf(t) === -1; }),
      };
    }

    function restore(vid) {
      setRestoring(true);
      window.FS.api.templates.restore(templateId, vid).then(function (updated) {
        setRestoring(false);
        if (window.FS && window.FS.toast) window.FS.toast.show({ message: 'Restored as a new version', tone: 'success' });
        if (props.onRestored) props.onRestored(updated);
      }).catch(function (err) {
        setRestoring(false);
        if (window.FS && window.FS.toast) window.FS.toast.show({ message: (err && err.message) || 'Restore failed', tone: 'error' });
      });
    }

    if (load.status === 'loading') {
      return React.createElement('div', { className: 'fs-library__history' },
        React.createElement('p', { style: { color: 'var(--text-tertiary)', fontSize: '13px', padding: '12px 0' } }, 'Loading…'),
      );
    }

    if (load.status === 'error') {
      return React.createElement('div', { className: 'fs-library__history' },
        React.createElement('p', { style: { color: 'var(--text-danger)', fontSize: '13px', padding: '12px 0' } }, 'Could not load version history.'),
      );
    }

    var versions = load.versions;

    return React.createElement('div', { className: 'fs-library__history' },

      React.createElement('p', { className: 'fs-library__history-intro' },
        versions.length + ' version' + (versions.length === 1 ? '' : 's') + '. Old versions are read-only — restore creates a new version.'
      ),

      React.createElement('div', { className: 'fs-library__history-list' },
        versions.map(function (ver, idx) {
          var isSelected = ver.id === selVid;
          var isLatest   = idx === 0;
          var diff       = isSelected ? diffSections(ver.schema) : null;

          return React.createElement('div', {
            key:       ver.id,
            className: 'fs-library__history-ver' + (isSelected ? ' fs-library__history-ver--selected' : ''),
            onClick:   function () { setSelVid(isSelected ? null : ver.id); },
            tabIndex:  0,
            onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') setSelVid(isSelected ? null : ver.id); },
          },
            React.createElement('div', { className: 'fs-library__history-ver-header' },
              React.createElement('span', { className: 'fs-library__history-ver-date' }, fmtDate(ver.created_at)),
              isLatest && React.createElement('span', { className: 'fs-library__history-ver-badge' }, 'Current'),
            ),
            React.createElement('div', { className: 'fs-library__history-ver-meta' },
              'By ' + (ver.created_by_user_id === 'system' ? 'FieldSight AI' : ver.created_by_user_id),
            ),
            ver.change_note && React.createElement('div', { className: 'fs-library__history-ver-note' }, ver.change_note),

            /* Diff panel — expanded on click */
            isSelected && diff && (diff.same.length || diff.removed.length || diff.added.length)
              ? React.createElement('div', { className: 'fs-library__history-diff' },
                  diff.same.map(function (t) {
                    return React.createElement('div', { key: t, className: 'fs-library__history-diff-row' }, '= ' + t);
                  }),
                  diff.removed.map(function (t) {
                    return React.createElement('div', { key: 'rem-' + t, className: 'fs-library__history-diff-row fs-library__history-diff-removed' }, '− ' + t);
                  }),
                  diff.added.map(function (t) {
                    return React.createElement('div', { key: 'add-' + t, className: 'fs-library__history-diff-row fs-library__history-diff-added' }, '+ ' + t + ' (added later)');
                  }),
                )
              : null,

            /* Restore button */
            isSelected && !isLatest && canManage && Button
              ? React.createElement('div', { className: 'fs-library__history-ver-actions' },
                  React.createElement(Button, {
                    variant: 'secondary', size: 'sm',
                    onClick: function (e) { e.stopPropagation(); restore(ver.id); },
                    disabled: restoring,
                  }, restoring ? 'Restoring…' : 'Restore as new version'),
                )
              : null,
          );
        }),
      ),

    );
  }

  /* ── Right detail (B.1/B.3/B.4/B.5) ────────────────────────────────── */

  function LibraryRight() {
    var ctx = React.useContext(LibraryContext);

    /* All hooks unconditionally before any early return */
    var viewRef = React.useState('preview');
    var view    = viewRef[0]; var setView = viewRef[1];

    var selId = ctx && ctx.sel ? ctx.sel.id : null;
    React.useEffect(function () { setView('preview'); }, [selId]);

    if (!ctx) return null;

    var sel            = ctx.sel;
    var handleActivate = ctx.handleActivate;
    var canManageOrg   = ctx.canManageOrg;
    var caller         = ctx.caller;
    var Badge          = window.FieldSight.Badge;
    var Button         = window.FieldSight.Button;

    /* Empty state */
    if (!sel) {
      return React.createElement('div', { className: 'fs-library__right fs-library__right--empty' },
        React.createElement('p', { className: 'fs-library__right-hint' }, 'Select a template to preview it.'),
      );
    }

    var schema       = activeSchema(sel);
    var ver          = sel.versions && sel.versions.length ? sel.versions[sel.versions.length - 1] : null;
    var isExtracting = sel._status === 'extracting';

    /* "ACTIVE" MEANS "THE SCHEDULED REPORT USES THIS", not "reports use this".
       Only an organisation template can hold that job: the nightly daily,
       weekly and monthly reports go out under the company's name, and a
       personal template is invisible to everyone else, so nobody but its owner
       could say what the report even was. The backend refuses the pair
       outright ("only an organisation template can be used for a scheduled
       report").

       This used to offer the button on personal templates too, gated on
       whether you may manage your OWN templates -- which you always may. So it
       was offered to everybody, and every press was a round trip to a refusal.
       A personal template is used by CHOOSING it when you generate a report;
       it never needs to be made active, and the footer now says that instead
       of dangling a control that cannot work. */
    var isSchedulable = ['daily', 'weekly', 'monthly'].indexOf(sel.report_type) >= 0;

    /* TWO DIFFERENT QUESTIONS, and they were one variable.

       canEdit  -- may you change what this template says?
       canActivate -- may you make the SCHEDULED reports use it?

       `canActivate` used to mean both, and its old rule ("you may always
       manage your own") happened to answer the first one correctly. Narrowing
       it to org + schedulable + gm/admin was right for scheduling and took the
       Edit tab away from every personal template with it -- so people could no
       longer edit the templates they had just made.

       One name, two meanings, and a change made for one of them. Editing now
       has its own gate, and it is the same rule as deleting: your own, or the
       organisation's if you manage those. */
    var canEdit = sel.scope === 'personal'
      ? !!(window.FS && window.FS.can && window.FS.can(caller, 'template:manage:self'))
      : !!canManageOrg;
    var canActivate = sel.scope === 'org' && isSchedulable && canManageOrg;

    /* Whoever may change a template may withdraw it: your own personal ones,
       and the organisation's if you manage those. Matches what the server
       enforces rather than guessing at it -- a button that appears and then
       gets a 403 is worse than no button. */
    /* Whoever may change a template may withdraw it. Same rule, said once. */
    var canDelete = canEdit;

    /* ── Extracting state ── */
    if (isExtracting) {
      return React.createElement('div', { className: 'fs-library__right' },
        React.createElement('div', { className: 'fs-library__right-header' },
          React.createElement('h2', { className: 'fs-library__right-title' }, sel.title),
          Badge && React.createElement(Badge, { tone: RT_TONE[sel.report_type] || 'neutral', label: RT_LABEL[sel.report_type] || sel.report_type }),
        ),
        React.createElement('div', { className: 'fs-library__extracting' },
          React.createElement('div', { className: 'fs-library__extracting-spinner' }),
          React.createElement('p', { className: 'fs-library__extracting-label' }, 'Setting up your template…'),
          React.createElement('p', { className: 'fs-library__extracting-sub' }, 'This only takes a moment.'),
        ),
      );
    }

    /* ── Nothing to show, and WHY ──────────────────────────────────────
       This was one sentence, "No schema available yet.", for three unrelated
       situations. One of them shipped: the API stopped sending `versions` on
       read, every template came back empty, and the page told people their
       template had no content while it sat intact in Aurora. A sentence about
       the template, describing a fault in the request.

       So the three are separated. The one that matters is the middle one --
       it is the only one where the person should not go looking at their own
       template for the problem. (This repo has form here: a 403 swallowed
       into an empty state, and "no results" covering both a refused filter and
       a dead search backend.) */
    if (!schema) {
      var reason;
      if (sel.current_version === 0) {
        /* Genuinely empty: created, no body written yet. */
        reason = 'This template has no sections yet. Add one to get started.';
      } else if (sel.current_version > 0) {
        /* The template HAS content -- the response did not carry it. Naming
           the version is deliberate: it is the evidence that the content
           exists, and it is what anybody debugging this needs first. */
        reason = 'This template has content (version ' + sel.current_version
               + ') but it did not come back with this request. Reload the page;'
               + ' if it keeps happening, the report is worth passing on.';
      } else {
        /* current_version absent altogether: an older or partial payload. */
        reason = 'Could not read this template’s sections. Reload the page.';
      }
      return React.createElement('div', { className: 'fs-library__right' },
        React.createElement('div', { className: 'fs-library__right-header' },
          React.createElement('h2', { className: 'fs-library__right-title' }, sel.title),
        ),
        React.createElement('p', { style: { color: 'var(--text-secondary)', padding: '16px' } }, reason),
      );
    }

    /* ── Main: Preview / Edit / History ── */
    return React.createElement('div', { className: 'fs-library__right' },

      /* Header */
      React.createElement('div', { className: 'fs-library__right-header' },
        React.createElement('div', { className: 'fs-library__right-title-row' },
          React.createElement('h2', { className: 'fs-library__right-title' }, sel.title),
          sel.active && React.createElement('span', { className: 'fs-library__active-badge' }, 'Active'),
        ),
        React.createElement('div', { className: 'fs-library__right-meta' },
          Badge && React.createElement(Badge, { tone: RT_TONE[sel.report_type] || 'neutral', label: RT_LABEL[sel.report_type] || sel.report_type }),
          React.createElement('span', { className: 'fs-library__scope-tag' }, sel.scope === 'org' ? 'Org' : 'Personal'),
        ),
        sel.description && React.createElement('p', { className: 'fs-library__right-desc' }, sel.description),
        /* Withdraw. Quiet by design -- it is not the thing people came here to
           do -- but present, because until now the only way to remove a
           template was to have never made it. The server already refuses to
           withdraw one a schedule still points at; that refusal is shown as
           the server words it. */
        canDelete && React.createElement('button', {
          type: 'button',
          className: 'fs-btn fs-btn--ghost fs-btn--sm fs-library__delete',
          onClick: function () { ctx.handleDelete(sel); },
          title: 'Remove this template from the library',
        }, 'Delete template'),
        ver && React.createElement('p', { className: 'fs-library__right-version-note' },
          'Version ' + sel.versions.length + ' · updated ' + fmtDate(ver.created_at),
        ),
      ),

      /* Sub-nav: Preview / Edit / History */
      /* A MISSING TAB IS NOT AN EXPLANATION. Somebody who cannot edit this
         template sees two tabs where a colleague sees three, and nothing on
         the page says why -- which reads as a fault, and this is the fourth
         time today that two different states have looked identical. */
      !canEdit
        ? React.createElement('p', { className: 'fs-library__right-readonly' },
            sel.scope === 'org'
              ? 'This is an organisation template — an admin or GM can change it. '
                + 'To make your own version, copy it to your library.'
              : 'You can read this template but not change it.')
        : null,

      React.createElement('div', { className: 'fs-library__right-subnav', role: 'tablist' },
        React.createElement('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'preview',
          className: 'fs-library__right-tab' + (view === 'preview' ? ' fs-library__right-tab--active' : ''),
          onClick: function () { setView('preview'); },
        }, 'Preview'),
        canEdit ? React.createElement('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'editor',
          className: 'fs-library__right-tab' + (view === 'editor' ? ' fs-library__right-tab--active' : ''),
          onClick: function () { setView('editor'); },
        }, 'Edit') : null,
        React.createElement('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'history',
          className: 'fs-library__right-tab' + (view === 'history' ? ' fs-library__right-tab--active' : ''),
          onClick: function () { setView('history'); },
        }, 'History'),
      ),

      /* Body — routed by view */
      view === 'editor'
        ? React.createElement(SchemaEditor, {
            templateId: sel.id,
            schema:     schema,
            onSaved:    function (updated) {
              ctx.setSel(updated); ctx.reload(); setView('preview');
              if (window.FS && window.FS.toast) window.FS.toast.show({ message: 'Schema saved as a new version', tone: 'success' });
            },
            onCancel: function () { setView('preview'); },
          })
        : view === 'history'
        ? React.createElement(VersionHistoryPanel, {
            templateId:   sel.id,
            latestSchema: schema,
            canManage:    canEdit,
            onRestored:   function (updated) { ctx.setSel(updated); ctx.reload(); setView('preview'); },
          })
        : /* preview */
          React.createElement(React.Fragment, null,

            /* THE "YOUR FILE" PANEL IS GONE, and it has to be.
               It showed `sel.title + '.docx'` as a filename -- the template's
               NAME with an extension glued on, not the file anybody chose --
               beside the sentence "AI read your file and identified N
               sections". Nothing is read from the file and nothing about it is
               stored, so every part of that panel was invented, and it was
               stated as fact about the person's own document.

               What is left is the one true statement: here are the sections
               this template has, and you can edit them. */
            React.createElement('div', { className: 'fs-library__review-grid' },

              React.createElement('div', { className: 'fs-library__review-panel' },
                React.createElement('h3', { className: 'fs-library__review-panel-title' }, 'Sections'),
                React.createElement('ol', { className: 'fs-library__schema-list' },
                  schema.sections.map(function (s, i) {
                    return React.createElement('li', { key: i, className: 'fs-library__schema-item' },
                      React.createElement('span', { className: 'fs-library__schema-kind-icon', title: KIND_LABEL[s.kind] }, KIND_ICON[s.kind] || '•'),
                      React.createElement('div', { className: 'fs-library__schema-item-body' },
                        React.createElement('span', { className: 'fs-library__schema-item-title' }, s.title),
                        React.createElement('span', { className: 'fs-library__schema-item-hint' }, s.prompt_hint),
                      ),
                    );
                  }),
                ),
              ),
            ),

            /* Test render panel */
            React.createElement(TestRenderPanel, { schema: schema, reportType: sel.report_type }),

            /* Says what this template IS for, when it cannot be scheduled. Not
               a disabled button: there is nothing here the person is being
               kept from, so offering one greyed out would invent a
               restriction that does not exist. */
            !canActivate && !sel.active
              ? React.createElement('div', { className: 'fs-library__cta-footer' },
                  React.createElement('p', { className: 'fs-library__cta-note' },
                    sel.scope === 'personal'
                      ? 'This is yours. Pick it when you generate a report from the timeline; personal templates are not used for the scheduled reports.'
                      : (!isSchedulable
                          ? 'Pick this when you generate a report from the timeline. Only daily, weekly and monthly reports run on a schedule.'
                          : 'Only an admin or GM can choose which template the scheduled reports use.'),
                  ),
                )
              : null,

            /* CTA footer */
            canActivate && !sel.active
              ? React.createElement('div', { className: 'fs-library__cta-footer' },
                  React.createElement(Button, {
                    variant: 'primary',
                    onClick: function () { handleActivate(sel); },
                  }, '✓ Use this template'),
                  React.createElement('p', { className: 'fs-library__cta-note' },
                    'Sets this as the active default for ' + (RT_LABEL[sel.report_type] || sel.report_type).toLowerCase() + ' reports in the ' + sel.scope + ' library.',
                  ),
                )
              : null,

            sel.active
              ? React.createElement('div', { className: 'fs-library__cta-footer fs-library__cta-footer--active' },
                  React.createElement('div', { className: 'fs-library__active-confirm' },
                    React.createElement('span', { className: 'fs-library__active-confirm-icon' }, '✓'),
                    React.createElement('span', null, 'Active default for ' + (RT_LABEL[sel.report_type] || sel.report_type).toLowerCase() + ' reports'),
                  ),
                )
              : null,
          ),

    );
  }

  /* ── Test Render Panel ─────────────────────────────────────────────── */

  /* Sprint 10 follow-up — TestRender body is now max-height scrollable
     so long previews don't run off the page; "↗ Open in modal" expands
     to a full-screen modal using ModalOverlay. */
  function TestRenderPanel(props) {
    var schema     = props.schema;
    /* Default expanded so the preview, its scroller, and the "Full preview"
       affordance are visible without first clicking Expand. */
    var expandRef  = React.useState(true);
    var expanded   = expandRef[0]; var setExpanded = expandRef[1];

    var modalRef   = React.useState(false);
    var modalOpen  = modalRef[0]; var setModalOpen = modalRef[1];

    var Modal      = window.FieldSight.ModalOverlay;

    if (!schema || !schema.sections) return null;

    /* Walk all sections, including nested children, into a single
       flat list so the render body shows everything. */
    function flatten(arr, depth) {
      var out = [];
      (arr || []).forEach(function (s) {
        out.push({ sec: s, depth: depth || 0 });
        if (s.children && s.children.length) {
          out = out.concat(flatten(s.children, (depth || 0) + 1));
        }
      });
      return out;
    }
    var flat = flatten(schema.sections, 0);

    function renderBody(scrollable) {
      return React.createElement('div', {
        className: 'fs-library__test-render-body'
                   + (scrollable ? ' fs-library__test-render-body--scroll' : ''),
      },
        flat.map(function (entry, i) {
          return React.createElement('div', {
            key:       i,
            className: 'fs-library__render-section'
                       + (entry.depth > 0 ? ' fs-library__render-section--child' : ''),
          },
            React.createElement('h4', { className: 'fs-library__render-section-title' },
              React.createElement('span', { className: 'fs-library__render-kind-badge' }, KIND_LABEL[entry.sec.kind] || entry.sec.kind),
              entry.sec.title,
            ),
            renderSectionSample(entry.sec),
          );
        }),
      );
    }

    return React.createElement('div', { className: 'fs-library__test-render' },
      React.createElement('div', { className: 'fs-library__test-render-header' },
        React.createElement('span', { className: 'fs-library__test-render-title' }, 'Test render'),
        React.createElement('span', { className: 'fs-library__test-render-sub' }, 'Preview with sample site data'),
        React.createElement('div', { className: 'fs-library__test-render-actions' },
          expanded && Modal ? React.createElement('button', {
            type:      'button',
            className: 'fs-library__test-render-modal-btn',
            onClick:   function () { setModalOpen(true); },
            title:     'Open in full-screen modal',
            'aria-label': 'Open preview in full-screen modal',
          }, '↗ Full preview') : null,
          React.createElement('button', {
            type:      'button',
            className: 'fs-library__test-render-toggle',
            onClick:   function () { setExpanded(function (e) { return !e; }); },
            'aria-expanded': expanded,
          }, expanded ? 'Collapse ▲' : 'Expand ▼'),
        ),
      ),

      expanded && renderBody(true),

      modalOpen && Modal ? React.createElement(Modal, {
        open:    true,   /* ModalOverlay only shows when open=true (toggles fs-modal--open) */
        title:   'Test render · ' + flat.length + ' section' + (flat.length === 1 ? '' : 's'),
        onClose: function () { setModalOpen(false); },
        size:    'lg',
      },
        React.createElement('div', { className: 'fs-library__test-render-modal' },
          renderBody(false),
        ),
      ) : null,
    );
  }

  function renderSectionSample(sec) {
    switch (sec.kind) {
      case 'narrative':
        return React.createElement('p', { className: 'fs-library__render-narrative' }, SAMPLE.narrative);

      case 'list':
        return React.createElement('ul', { className: 'fs-library__render-list' },
          SAMPLE.list.map(function (item, i) {
            return React.createElement('li', { key: i }, item);
          }),
        );

      case 'kpi':
        var fields = sec.fields && sec.fields.length ? sec.fields : Object.keys(SAMPLE.kpi).slice(0, 3);
        return React.createElement('div', { className: 'fs-library__render-kpi-row' },
          fields.map(function (f) {
            return React.createElement('div', { key: f, className: 'fs-library__render-kpi-tile' },
              React.createElement('span', { className: 'fs-library__render-kpi-value' }, SAMPLE.kpi[f] || '—'),
              React.createElement('span', { className: 'fs-library__render-kpi-label' }, f.replace(/_/g, ' ')),
            );
          }),
        );

      case 'table':
        var cols = sec.fields && sec.fields.length ? sec.fields : ['action', 'owner', 'due_date'];
        return React.createElement('table', { className: 'fs-library__render-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              cols.map(function (c) {
                return React.createElement('th', { key: c }, c.replace(/_/g, ' '));
              }),
            ),
          ),
          React.createElement('tbody', null,
            SAMPLE.table.map(function (row, i) {
              return React.createElement('tr', { key: i },
                cols.map(function (c) {
                  return React.createElement('td', { key: c }, row[c] || '—');
                }),
              );
            }),
          ),
        );

      case 'photos':
        return React.createElement('div', { className: 'fs-library__render-photos' },
          SAMPLE.photos.map(function (label, i) {
            return React.createElement('div', { key: i, className: 'fs-library__render-photo-thumb' },
              React.createElement('span', { className: 'fs-library__render-photo-icon' }, '🖼'),
              React.createElement('span', { className: 'fs-library__render-photo-label' }, label),
            );
          }),
        );

      default:
        return null;
    }
  }

  /* ── Page wrappers ─────────────────────────────────────────────────── */

  function LibraryMiddleWithProvider() {
    return React.createElement(LibraryProvider, null,
      React.createElement(LibraryMiddle, null),
    );
  }

  function LibraryRightWithProvider() {
    return React.createElement(LibraryProvider, null,
      React.createElement(LibraryRight, null),
    );
  }

  /* The AppShell instantiates Middle and Right in separate subtrees, so we
     need a shared context. The pattern used by insights.js is a single
     Provider wrapping both. AppShell's 3-panel renderer must therefore
     use the Provider variant. We expose a combined wrapper. */

  function LibraryPage() {
    return React.createElement(LibraryProvider, null,
      React.createElement('div', { style: { display: 'contents' } },
        React.createElement(LibraryMiddle, null),
        React.createElement(LibraryRight, null),
      ),
    );
  }

  /* AppShell expects { Middle, Right } components that share context via
     a Provider prop. Follow the pattern of team.js / insights.js:
     expose Provider, Middle, Right separately so AppShell can wrap them. */

  if (!window.FieldSight)       window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};

  window.FieldSight.SchemaEditor        = SchemaEditor;
  window.FieldSight.VersionHistoryPanel = VersionHistoryPanel;

  window.FieldSight.PAGES['/library'] = {
    Provider: LibraryProvider,
    Middle:   LibraryMiddle,
    Right:    LibraryRight,
  };

})();
