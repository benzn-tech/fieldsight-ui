/* ==========================================================================
   FieldSight Template Store — org API backed
   --------------------------------------------------------------------------
   The Library's templates now live in Aurora (fieldsight-pipeline migration
   0062) and are reached through the org API. This file keeps the exact
   function names and return shapes the pages already call, which is what the
   previous localStorage version was written to make possible:

       "mirror the real backend surface so the swap-in is a backend-only
        change with no UI rework"

   So /library and /reports are unchanged by this file. What changed is that a
   template now outlives the tab that made it and is visible to the rest of the
   company.

   TWO SHAPES, ONE ADAPTER, AND NOTHING DROPPED BETWEEN THEM
   ---------------------------------------------------------
   The editor speaks {title, kind, fields, prompt_hint, children}. The backend
   body is what report_template.render_prompt consumes: {sections:[{key, title,
   purpose}], catch_all, excluded_subjects, style}. They meet here, at the api
   layer, and nowhere else -- a component must never have to know about both.

   `prompt_hint` and `purpose` are the same sentence under two names, so they
   map onto each other. `kind`, `fields` and `children` mean nothing to the
   prompt, and they are CARRIED THROUGH as extra keys on the section rather
   than dropped: a field a component sends and this layer quietly discards is
   exactly how the templateVersion bug happened, and the server ignores keys it
   does not read. `catch_all` has no editor control yet, so a default is
   supplied on create and whatever the server holds is preserved on save.

   WHAT IS STILL LOCAL, ON PURPOSE
   -------------------------------
   Favourites. They are one viewer's pinned row, they mean nothing to anybody
   else, and they are exactly the per-viewer convenience localStorage is for.
   Everything that has to survive a different browser is now server-side.

   Exposed as: window.FS.api.templates  (CRUD)
               window.FS.templateStore  (listener helpers)
   ========================================================================== */

(function () {
  'use strict';

  var FAV_KEY = 'fs.lib.favourites';
  var FAV_CAP = 6;

  function api() { return window.FS.api; }
  function orgLive() { return !api().useMocks && !!api().orgBaseUrl; }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /* ── Starting points for a new template ────────────────────────────────
     These were the "ADE extraction" results. Nothing extracted them: the
     upload modal validated a file, discarded it, showed a spinner for 2.2
     seconds and handed back whichever of these matched the report type. They
     are kept because a new template that starts empty is worse than one that
     starts with the sections most of these reports want -- but they are
     STARTING POINTS, and the copy calling them an extraction is wrong.
     (Fixing that wording is a UI change, tracked separately.) */

  var STARTING_SECTIONS = {
    daily: [
      { title: 'Daily Summary', kind: 'narrative', fields: [], prompt_hint: 'Key activities and overall progress' },
      { title: 'Workforce',     kind: 'kpi',       fields: ['headcount', 'subcontractors'], prompt_hint: 'Labour numbers on site' },
      { title: 'Key Decisions', kind: 'list',      fields: [], prompt_hint: 'Decisions affecting programme or cost' },
      { title: 'Open Actions',  kind: 'table',     fields: ['action', 'owner', 'due_date'], prompt_hint: 'Outstanding tasks' },
      { title: 'Photos',        kind: 'photos',    fields: [], prompt_hint: 'Site progress photos' },
    ],
    weekly: [
      { title: 'Executive Summary', kind: 'narrative', fields: [], prompt_hint: 'One-paragraph summary for distribution' },
      { title: 'Programme KPIs',    kind: 'kpi',       fields: ['completion_pct', 'days_variance'], prompt_hint: 'Key metrics vs baseline' },
      { title: 'Completed',         kind: 'list',      fields: [], prompt_hint: 'Tasks completed this week' },
      { title: 'Planned Next Week', kind: 'list',      fields: [], prompt_hint: 'Tasks for the coming week' },
      { title: 'Issues & Risks',    kind: 'table',     fields: ['issue', 'impact', 'mitigation'], prompt_hint: 'Open issues' },
    ],
    monthly: [
      { title: 'Monthly Summary',   kind: 'narrative', fields: [], prompt_hint: 'Month-level summary' },
      { title: 'Progress KPIs',     kind: 'kpi',       fields: ['completion_pct', 'budget_pct'], prompt_hint: 'Programme and cost metrics' },
      { title: 'Milestones',        kind: 'list',      fields: [], prompt_hint: 'Milestones achieved and upcoming' },
      { title: 'Commercial Update', kind: 'narrative', fields: [], prompt_hint: 'Cost and variation summary' },
      { title: 'Photos',            kind: 'photos',    fields: [], prompt_hint: 'Progress photos' },
    ],
    incident: [
      { title: 'Incident Details',   kind: 'kpi',       fields: ['date_time', 'location', 'severity'], prompt_hint: 'Who, what, when, where' },
      { title: 'Description',        kind: 'narrative', fields: [], prompt_hint: 'Factual account' },
      { title: 'Immediate Actions',  kind: 'list',      fields: [], prompt_hint: 'Steps taken immediately' },
      { title: 'Corrective Actions', kind: 'table',     fields: ['action', 'owner', 'due_date'], prompt_hint: 'Prevention actions' },
      { title: 'Photos & Evidence',  kind: 'photos',    fields: [], prompt_hint: 'Scene photos' },
    ],
  };

  var DEFAULT_CATCH_ALL = {
    key: 'other',
    title: 'Anything else',
    purpose: 'Only what will still matter next week and fits nowhere above. '
           + 'One sentence each. If there is nothing, write "Nothing here."',
  };

  /* ── Shape adapter ─────────────────────────────────────────────────────── */

  function slugKey(title, i) {
    var k = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return k || ('section-' + (i + 1));
  }

  /* editor section -> backend section. Unknown keys ride along. */
  function toBackendSection(s, i) {
    var out = Object.assign({}, s);
    delete out.prompt_hint;
    out.key = s.key || slugKey(s.title, i);
    out.title = s.title;
    /* render_prompt needs a non-empty purpose and the server rejects a section
       without one, so an untouched hint is carried over rather than blanked. */
    out.purpose = s.purpose || s.prompt_hint || '';
    if (s.children && s.children.length) {
      out.children = s.children.map(toBackendSection);
    }
    return out;
  }

  /* backend section -> editor section. */
  function toEditorSection(s) {
    var out = Object.assign({}, s);
    out.prompt_hint = s.prompt_hint || s.purpose || '';
    out.kind = s.kind || 'narrative';
    out.fields = s.fields || [];
    if (s.children && s.children.length) {
      out.children = s.children.map(toEditorSection);
    }
    return out;
  }

  function toBackendBody(schema, previousBody) {
    var prev = previousBody || {};
    schema = schema || {};
    return {
      sections: (schema.sections || []).map(toBackendSection),
      /* Preserved, never regenerated: the editor has no control for these, so
         writing a default on every save would silently overwrite whatever the
         company put there by any other route. */
      catch_all: schema.catch_all || prev.catch_all || clone(DEFAULT_CATCH_ALL),
      excluded_subjects: schema.excluded_subjects || prev.excluded_subjects || [],
      style: schema.style || prev.style || [],
    };
  }

  function toEditorSchema(body) {
    if (!body) return { sections: [] };
    return Object.assign({}, body, {
      sections: (body.sections || []).map(toEditorSection),
    });
  }

  /* A server template row -> the shape /library and /reports already render.
     `active` is not a column: it is whether a schedule is bound to this
     template, which is the same question the old store answered locally. */
  function toRow(t, boundIds) {
    return {
      id: t.id,
      scope: t.scope,
      report_type: t.report_type,
      active: !!(boundIds && boundIds[t.id]),
      owner_user_id: t.owner_user_id,
      title: t.name,
      description: t.description,
      created_at: t.created_at,
      /* The version a chooser should pin to. Between picking a template and
         pressing Generate, somebody else can save a new version; a report
         written to "whatever is current when the worker gets there" would not
         be the template the person was looking at. */
      version: t.current_version,
      /* Carried through, not derived. The right-hand panel needs to tell
         "this template has no sections yet" from "the sections did not come
         back with this request", and only the server's own count can say
         which. Deriving it from `versions` is what hid the bug: an empty
         versions list looked exactly like an empty template. */
      current_version: t.current_version,
      section_count: t.section_count,
      _status: t.current_version > 0 ? 'ready' : 'empty',
      versions: (t.versions || []).map(toVersion),
    };
  }

  function toVersion(v) {
    return {
      id: v.id,
      version: v.version,
      schema: toEditorSchema(v.body),
      created_at: v.created_at,
      created_by_user_id: v.created_by,
      change_note: v.change_note,
    };
  }

  /* ── Extraction listeners ──────────────────────────────────────────────
     Kept so the Library can re-render after a create without polling. There is
     no asynchronous extraction any more -- the server answers with the
     finished template -- so this fires at once. */

  var _listeners = [];

  function _notifyExtracted(id) {
    _listeners.forEach(function (fn) { try { fn(id); } catch (_) {} });
  }

  function onExtracted(fn) {
    _listeners.push(fn);
    return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); };
  }

  /* ── Bindings ──────────────────────────────────────────────────────────
     list() needs to know which templates a schedule points at: one extra GET
     per list, not one per row. A bindings failure must not empty the Library,
     so it degrades to "nothing is active" -- wrong in the safer direction: a
     bound template reads as unbound, rather than an unbound one reading as
     bound and persuading somebody to leave it alone. */

  function fetchBoundIds() {
    return api().orgRequest('/templates/bindings').then(function (res) {
      var map = {};
      ((res && res.bindings) || []).forEach(function (b) { map[b.template_id] = b; });
      return map;
    }).catch(function () { return {}; });
  }

  /* ── Mock mode ─────────────────────────────────────────────────────────
     Every api module in this repo has a `useMocks` arm, and the demo shell
     (`?mocks=1`) is how this product is shown to people. A Library that only
     works against a live backend would go blank in the one mode whose whole
     job is to have something in it.

     In memory, not localStorage: a demo should start from the fixtures every
     time rather than from whatever the last person clicked, and the reason the
     old store reached for localStorage -- there was nowhere else for a real
     template to live -- no longer applies. */

  var _mock = null;

  function mockStore() {
    if (_mock) return _mock;
    var fx = (window.FieldSight && window.FieldSight.fixtures
              && window.FieldSight.fixtures.templates) || {};
    _mock = { rows: (fx.org || []).concat(fx.personal || []).map(clone) };
    return _mock;
  }

  function mockFind(id) {
    return mockStore().rows.filter(function (t) { return t.id === id && !t._deleted; })[0] || null;
  }

  function mockResolve(value) {
    return delay(30).then(function () { return clone(value); });
  }

  function mockMissing() {
    return delay(30).then(function () {
      return Promise.reject({ status: 404, message: 'Template not found' });
    });
  }

  /* ── API ──────────────────────────────────────────────────────────────── */

  function unavailable(what) {
    return Promise.reject({
      status: 0,
      message: 'The template library needs the org API. ' + what + ' is unavailable here.',
    });
  }

  function list(scope) {
    if (api().useMocks) {
      var rows = mockStore().rows.filter(function (t) { return !t._deleted; });
      if (scope === 'org' || scope === 'personal') {
        rows = rows.filter(function (t) { return t.scope === scope; });
      }
      return mockResolve({ templates: rows });
    }
    if (!orgLive()) return unavailable('Listing templates');
    var params = (scope === 'org' || scope === 'personal') ? { scope: scope } : undefined;
    return Promise.all([
      api().orgRequest('/templates', { params: params }),
      fetchBoundIds(),
    ]).then(function (both) {
      var bound = both[1];
      return {
        templates: ((both[0] && both[0].templates) || []).map(function (t) {
          return toRow(t, bound);
        }),
      };
    });
  }

  function get(id) {
    if (api().useMocks) {
      var hit = mockFind(id);
      return hit ? mockResolve(hit) : mockMissing();
    }
    if (!orgLive()) return unavailable('Opening a template');
    return Promise.all([
      api().orgRequest('/templates/' + encodeURIComponent(id)),
      fetchBoundIds(),
    ]).then(function (both) { return toRow(both[0], both[1]); });
  }

  function create(data) {
    data = data || {};
    if (api().useMocks) {
      var rt = data.report_type || 'daily';
      var row = {
        id: 'tpl-mock-' + (mockStore().rows.length + 1),
        scope: data.scope || 'personal', report_type: rt, active: false,
        owner_user_id: data.owner_user_id || null,
        title: data.title || 'New Template', description: data.description || '',
        created_at: new Date().toISOString(), _status: 'ready',
        versions: [{ id: 'ver-mock-1',
                     schema: toEditorSchema(toBackendBody({
                       sections: clone(STARTING_SECTIONS[rt] || STARTING_SECTIONS.daily) })),
                     created_at: new Date().toISOString(),
                     created_by_user_id: data.owner_user_id || 'you',
                     change_note: 'Created' }],
      };
      mockStore().rows.push(row);
      return mockResolve(row).then(function (r) { _notifyExtracted(r.id); return r; });
    }
    if (!orgLive()) return unavailable('Creating a template');
    var reportType = data.report_type || 'daily';
    var starting = STARTING_SECTIONS[reportType] || STARTING_SECTIONS.daily;
    return api().orgRequest('/templates', {
      method: 'POST',
      retry: false,
      body: {
        scope: data.scope || 'personal',
        report_type: reportType,
        name: data.title || 'New Template',
        description: data.description || '',
        body: toBackendBody({ sections: clone(starting) }),
        change_note: 'Created',
      },
    }).then(function (row) {
      var shaped = toRow(row, {});
      /* The old store fired this 2.2s after create, when its fake extraction
         "finished". The template is complete here, so listeners are told at
         once rather than on a timer that no longer measures anything. */
      _notifyExtracted(shaped.id);
      return shaped;
    });
  }

  function updateSchema(id, schema, changeNote) {
    if (api().useMocks) {
      var hit = mockFind(id);
      if (!hit) return mockMissing();
      hit.versions = (hit.versions || []).concat([{
        id: 'ver-mock-' + ((hit.versions || []).length + 1),
        schema: clone(schema), created_at: new Date().toISOString(),
        created_by_user_id: 'you', change_note: changeNote || 'Edited sections',
      }]);
      return mockResolve(hit);
    }
    if (!orgLive()) return unavailable('Saving a template');
    /* Read the current version first, so catch_all / style / excluded_subjects
       survive a save made from an editor that cannot see them. */
    return api().orgRequest('/templates/' + encodeURIComponent(id) + '/versions')
      .then(function (res) {
        var latest = ((res && res.versions) || [])[0];
        return api().orgRequest('/templates/' + encodeURIComponent(id) + '/versions', {
          method: 'POST',
          retry: false,          /* a retried save is a second version */
          body: {
            body: toBackendBody(schema, latest && latest.body),
            change_note: changeNote || null,
          },
        });
      })
      .then(function () { return get(id); });
  }

  function activate(id) {
    if (api().useMocks) {
      var hit = mockFind(id);
      if (!hit) return mockMissing();
      mockStore().rows.forEach(function (t) {
        if (t.scope === hit.scope && t.report_type === hit.report_type) t.active = false;
      });
      hit.active = true;
      return mockResolve(hit);
    }
    if (!orgLive()) return unavailable('Activating a template');
    return api().orgRequest('/templates/' + encodeURIComponent(id))
      .then(function (t) {
        if (t.scope !== 'org') {
          return Promise.reject({
            status: 400,
            message: 'Only an organisation template can be used for a scheduled report.',
          });
        }
        if (['daily', 'weekly', 'monthly'].indexOf(t.report_type) < 0) {
          return Promise.reject({
            status: 400,
            message: 'Only daily, weekly and monthly reports run on a schedule.',
          });
        }
        return api().orgRequest('/templates/bindings/' + encodeURIComponent(t.report_type), {
          method: 'PUT',
          retry: false,
          body: { template_id: id },
        });
      })
      .then(function () { return get(id); });
  }

  function remove(id) {
    if (api().useMocks) {
      var hit = mockFind(id);
      if (!hit) return mockMissing();
      hit._deleted = true; hit.active = false;
      return mockResolve({ ok: true });
    }
    if (!orgLive()) return unavailable('Deleting a template');
    return api().orgRequest('/templates/' + encodeURIComponent(id), {
      method: 'DELETE',
      retry: false,
    }).then(function () { return { ok: true }; });
  }

  function listVersions(id) {
    if (api().useMocks) {
      var hit = mockFind(id);
      return hit ? mockResolve({ versions: hit.versions || [] }) : mockMissing();
    }
    if (!orgLive()) return unavailable('Reading a template history');
    return api().orgRequest('/templates/' + encodeURIComponent(id) + '/versions')
      .then(function (res) {
        return { versions: ((res && res.versions) || []).map(toVersion) };
      });
  }

  function restore(id, vid) {
    if (api().useMocks) {
      var hit = mockFind(id);
      if (!hit) return mockMissing();
      var ver = (hit.versions || []).filter(function (v) { return v.id === vid; })[0];
      if (!ver) return mockMissing();
      return updateSchema(id, ver.schema, 'Restored from version ' + vid);
    }
    if (!orgLive()) return unavailable('Restoring a version');
    /* The Library holds version ROW ids; the route takes the version NUMBER,
       which is the thing that is stable and readable in a change note. */
    return listVersions(id).then(function (res) {
      var hit = (res.versions || []).filter(function (v) { return v.id === vid; })[0];
      if (!hit) return Promise.reject({ status: 404, message: 'Version not found' });
      return api().orgRequest(
        '/templates/' + encodeURIComponent(id) + '/versions/'
        + encodeURIComponent(hit.version) + '/restore',
        { method: 'POST', retry: false });
    }).then(function () { return get(id); });
  }

  function copyToPersonal(id, name) {
    if (!orgLive()) return unavailable('Copying a template');
    return api().orgRequest('/templates/' + encodeURIComponent(id) + '/copy', {
      method: 'POST',
      retry: false,
      body: name ? { name: name } : {},
    }).then(function (row) { return toRow(row, {}); });
  }

  function usageStats() {
    if (api().useMocks) {
      return list().then(function (res) {
        return {
          org_count: res.templates.filter(function (t) { return t.scope === 'org'; }).length,
          personal_count: res.templates.filter(function (t) { return t.scope === 'personal'; }).length,
        };
      });
    }
    if (!orgLive()) return Promise.resolve({ org_count: 0, personal_count: 0 });
    return list().then(function (res) {
      var rows = res.templates || [];
      return {
        org_count: rows.filter(function (t) { return t.scope === 'org'; }).length,
        personal_count: rows.filter(function (t) { return t.scope === 'personal'; }).length,
      };
    });
  }

  /* ── Favourites — per viewer, and deliberately still local ──────────────
     One person's pinned row. It means nothing to anybody else, it does not
     need to survive a different browser, and moving it to the server would
     buy nothing and cost a round trip on every render. */

  function loadFavourites() {
    try {
      var raw = localStorage.getItem(FAV_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function saveFavourites(arr) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(arr.slice(0, FAV_CAP))); } catch (_) {}
  }

  function getFavourites() {
    return delay(0).then(function () { return loadFavourites().slice(); });
  }

  function isFavourite(id) { return loadFavourites().indexOf(id) >= 0; }

  function addFavourite(id) {
    return delay(0).then(function () {
      var favs = loadFavourites();
      if (favs.indexOf(id) < 0 && favs.length < FAV_CAP) {
        favs.push(id);
        saveFavourites(favs);
      }
      return favs;
    });
  }

  function removeFavourite(id) {
    return delay(0).then(function () {
      var favs = loadFavourites().filter(function (x) { return x !== id; });
      saveFavourites(favs);
      return favs;
    });
  }

  function toggleFavourite(id) {
    return isFavourite(id) ? removeFavourite(id) : addFavourite(id);
  }

  /* ── Expose ──────────────────────────────────────────────────────────── */

  if (!window.FS)     window.FS     = {};
  if (!window.FS.api) window.FS.api = {};

  window.FS.api.templates = {
    list:           list,
    get:            get,
    create:         create,
    updateSchema:   updateSchema,
    activate:       activate,
    'delete':       remove,
    listVersions:   listVersions,
    restore:        restore,
    copyToPersonal: copyToPersonal,
    usageStats:     usageStats,
    getFavourites:    getFavourites,
    isFavourite:      isFavourite,
    addFavourite:     addFavourite,
    removeFavourite:  removeFavourite,
    toggleFavourite:  toggleFavourite,
    FAVOURITES_CAP:   FAV_CAP,
    /* Exported for tests: the two shapes meet here and nowhere else. */
    _toBackendBody:   toBackendBody,
    _toEditorSchema:  toEditorSchema,
    _toRow:           toRow,
  };

  if (!window.FS.templateStore) window.FS.templateStore = {};
  window.FS.templateStore._notifyExtracted = _notifyExtracted;
  window.FS.templateStore.onExtracted      = onExtracted;

})();
