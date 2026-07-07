/* ==========================================================================
   FieldSight API · Programme (Sprint 4.4 — MVP; org-backend wiring UI
   batch 2026-07-08 / F4)
   --------------------------------------------------------------------------
   getProgramme/saveProgramme hit the DEPLOYED org-api programme endpoints
   (Aurora/S3-backed, same channel as api/org.js):
     GET /api/org/programme?site=<ORG_SITE_UUID>  → { programme: <doc>|null }
     PUT /api/org/programme?site=<ORG_SITE_UUID>  → { programme: <saved doc
       with updated_at> } — admin/gm/pm + site access only, else 403.

   CRITICAL: `site` is the ORG SITE UUID (org.js getOrgSites()'s site_id,
   i.e. _toPageSite's s.id) — NOT the report-side site slug that
   FS.siteContext / api/sites.js key off. Passing the slug 403s (a bug
   already fixed server-side once — see scripts/pages/programme.js for how
   the UI resolves the UUID). Callers here must already have the org UUID;
   this module does no identity resolution of its own.

   Doc shape (round-trips 1:1 — whatever saveProgramme PUTs is exactly what
   getProgramme's next GET returns, plus a server-set `updated_at`):
     { name, start_date, end_date, parents: [...], leaves: [...] }

   getProgrammeTasksForRange still targets the old hypothetical
   /programmes/:id/tasks report-side endpoint and has zero callers — left
   as a dead stub (not part of this batch's scope).

   Mock branch reads from window.FieldSight.fixtures.programme, adapted to
   the same { programme } envelope so callers don't branch on useMocks.

   Worker rule (BACKEND-CONTEXT §3): when caller is a worker, scope the
   returned tasks to ones where the worker's folder name appears in
   `assignees`. Mock api does this client-side; the live endpoint does not
   (out of scope for F4 — see task brief).

   Exported to:
     window.FS.api.programme = {
       getProgramme(orgSiteId),
       saveProgramme(orgSiteId, doc),
       getProgrammeTasksForRange({ programme_id, from, to, user? }),
     }
   ========================================================================== */

(function () {
  'use strict';

  function orgLive() {
    return !window.FS.api.useMocks && !!window.FS.api.orgBaseUrl;
  }

  function fixtures() {
    return (window.FieldSight && window.FieldSight.fixtures) || {};
  }

  function callerFolder() {
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (!u.name) return null;
    return window.FS.api.folderName(u.name);
  }

  function isAdminLike(u) {
    return u && (u.role === 'admin' || u.role === 'gm' || u.isAdmin);
  }

  function applyWorkerScope(tasks) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (caller.role !== 'worker') return tasks;
    var folder = callerFolder();
    if (!folder) return tasks;
    return tasks.filter(function (t) {
      if (t.status === 'group') return false;          /* hide WBS groups for workers */
      return (t.assignees || []).indexOf(folder) !== -1;
    });
  }

  function rangeOverlap(task, from, to) {
    if (!from || !to) return true;
    return !(task.end < from || task.start > to);
  }

  /* orgSiteId — the ORG SITE UUID (see module header). Returns the raw
     org-api envelope in live mode ({ programme: doc|null } or
     { _accessDenied } / { _notFound }); mock mode adapts the single
     fixture programme onto the same envelope, matched on the fixture's
     site_id so switching sites in the UI's own picker demonstrates the
     per-site empty state too. */
  async function getProgramme(orgSiteId) {
    if (orgLive()) {
      return window.FS.api.orgRequest('/programme', { params: { site: orgSiteId } });
    }
    await window.FS.api.delay();
    var p = fixtures().programme;
    if (!p || (orgSiteId && p.site_id && p.site_id !== orgSiteId)) {
      return { programme: null };
    }
    /* Deep-copy so callers can mutate state freely. */
    var copy = JSON.parse(JSON.stringify(p));
    var tasks = applyWorkerScope(copy.tasks);
    return {
      programme: {
        name:       copy.name,
        start_date: copy.start_date,
        end_date:   copy.end_date,
        parents:    tasks.filter(function (t) { return t.status === 'group'; }),
        leaves:     tasks.filter(function (t) { return t.status !== 'group'; }),
        updated_at: copy.updated_at || null,
      },
    };
  }

  /* doc = { name, start_date, end_date, parents, leaves } — see module
     header for the round-trip contract. Mock mode is a no-op success
     (mutations already live in page state; nothing durable to persist
     without a real backend). */
  async function saveProgramme(orgSiteId, doc) {
    if (orgLive()) {
      return window.FS.api.orgRequest('/programme', {
        method: 'PUT', params: { site: orgSiteId }, body: doc,
      });
    }
    await window.FS.api.delay();
    return { ok: true };
  }

  async function getProgrammeTasksForRange(opts) {
    opts = opts || {};
    if (!window.FS.api.useMocks) {
      return window.FS.api.request(
        '/programmes/' + encodeURIComponent(opts.programme_id) + '/tasks',
        { params: { from: opts.from, to: opts.to, user: opts.user } });
    }
    await window.FS.api.delay();
    var p = fixtures().programme;
    if (!p || p.programme_id !== opts.programme_id) {
      return { tasks: [], programme_id: opts.programme_id };
    }
    var tasks = JSON.parse(JSON.stringify(p.tasks))
      .filter(function (t) { return t.status !== 'group'; })
      .filter(function (t) { return rangeOverlap(t, opts.from, opts.to); });
    tasks = applyWorkerScope(tasks);
    return {
      programme_id: opts.programme_id,
      tasks:        tasks,
      from:         opts.from || null,
      to:           opts.to   || null,
    };
  }

  /* =========================================================================
     Sprint 8.2.1 — Write operations (PATCH / POST / DELETE)
     No real /api/programmes endpoints exist yet — gated on
     useMocks=false && writeMocks=false (Phase 0 Task 2 audit sweep) so
     these stay mocked even once reads go live. In mock mode they return a
     resolved-success object immediately (mutations live in page state).
     ========================================================================= */

  async function updateTask(programmeId, taskId, patch) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.request(
        '/programmes/' + encodeURIComponent(programmeId) +
        '/tasks/' + encodeURIComponent(taskId),
        { method: 'PATCH', body: JSON.stringify(patch) });
    }
    await window.FS.api.delay();
    return { ok: true, task_id: taskId };
  }

  async function createTask(programmeId, payload) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.request(
        '/programmes/' + encodeURIComponent(programmeId) + '/tasks',
        { method: 'POST', body: JSON.stringify(payload) });
    }
    await window.FS.api.delay();
    return { ok: true };
  }

  async function deleteTask(programmeId, taskId) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.request(
        '/programmes/' + encodeURIComponent(programmeId) +
        '/tasks/' + encodeURIComponent(taskId),
        { method: 'DELETE' });
    }
    await window.FS.api.delay();
    return { ok: true };
  }

  async function importTasks(programmeId, tasks) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.request(
        '/programmes/' + encodeURIComponent(programmeId) + '/tasks/bulk',
        { method: 'POST', body: JSON.stringify({ tasks: tasks }) });
    }
    await window.FS.api.delay();
    return { ok: true, imported: tasks.length };
  }

  /* =========================================================================
     Sprint 8.3.3 — Baseline snapshot (localStorage, keyed by programmeId)
     ========================================================================= */

  function saveBaseline(programmeId, tasks) {
    var key = 'fs.baseline.' + programmeId;
    var snapshot = tasks.map(function (t) {
      return { task_id: t.task_id, start: t.start, end: t.end, status: t.status };
    });
    try {
      localStorage.setItem(key, JSON.stringify({
        saved_at: new Date().toISOString(),
        tasks:    snapshot,
      }));
    } catch (_) {}
    return snapshot;
  }

  function getBaseline(programmeId) {
    var key = 'fs.baseline.' + programmeId;
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.programme = {
    getProgramme:               getProgramme,
    saveProgramme:              saveProgramme,
    getProgrammeTasksForRange:  getProgrammeTasksForRange,
    updateTask:                 updateTask,
    createTask:                 createTask,
    deleteTask:                 deleteTask,
    importTasks:                importTasks,
    saveBaseline:               saveBaseline,
    getBaseline:                getBaseline,
  };

})();
