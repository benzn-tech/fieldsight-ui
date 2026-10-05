/* ==========================================================================
   FieldSight API · Action items
   --------------------------------------------------------------------------
   DONE MEANS THE TASK IS DONE. A task is done when its own
   `action_items.status === 'done'` — read from the org payload the page
   already has (the /timeline read shim stamps `status`, `updated_by_name`
   and `updated_at` onto every action item). There is no second store.

   The legacy DynamoDB tick overlay (GET /actions, POST /actions/toggle,
   POST /actions) is gone from this client. It was readable and writable by
   any signed-in user of any company, and it had no authorisation at all.
   The unambiguous ticks it held were copied into action_items by a backend
   backfill before this shipped; ticks that could not be matched to exactly
   one task were deliberately not carried over.

   Writes:
     PATCH /api/org/action-items/{id}   (useMocks=false, writeMocks=false)
          AURORA ORG WRITE (rides orgRequest — a durable action_items.id,
          not a date/topic/index composite key).
          body { priority?, status?, deadline?, responsible? } (partial)
          → the FULL updated row: { id, topic_id, site_id, text, responsible,
            deadline, deadline_text, priority, status, created_at,
            updated_at, updated_by, updated_by_name }
          updated_by_name = resolved display name for updated_by, MAY BE NULL
          (unprovisioned/nameless account). The row carries no
          checked_by/checked_at, so normaliseCheckoff below remaps
          updated_by_name/updated_at onto that pair for the bus + captions.
          400 (bad enum / non-member / empty), 403 (no authority),
          404 (missing/cross-company).

   A task with no durable actionItemId (e.g. a report-sourced item the shim
   has not stamped) cannot be ticked: resolveActionItem refuses it and every
   surface renders it read-only. The legacy toggle was its only writer.

   Key helpers (a session-local sync cache keyed per owner, NOT a store):
     actionKey(user_folder, topic_id, action_index)
       `<user_folder>|<topic_id>_<action_index>`, or bare `<topic_id>_<action_index>`
       when user_folder is falsy.
     lookupAction(map, user_folder, topic_id, action_index)
       composite-key lookup with bare-key fallback.
     itemState(action, live)
       { checked, checked_by, checked_at } for one item: the in-page tick
       that FS.actionsBus just announced (`live`), else the item's own
       status column.

   Mock path: updateAction merges the patch in memory so ticks demo without
   a backend; the fixtures carry done-ness on the items themselves.

   On a refused or failed write resolveActionItem RESOLVES
   { ok:false, reason, message } — callers show the message, never swallow it.
   ========================================================================== */

(function () {
  'use strict';

  /* actionKey/lookupAction signatures + semantics are locked by the plan
     (§1.3) — later tasks depend on them exactly as written here. They key
     the per-page map of ticks announced on FS.actionsBus this session. */
  function actionKey(user_folder, topic_id, action_index) {
    var bare = topic_id + '_' + action_index;
    return user_folder ? (user_folder + '|' + bare) : bare;
  }

  function lookupAction(map, user_folder, topic_id, action_index) {
    if (!map) return undefined;
    var bare = topic_id + '_' + action_index;
    return (user_folder ? map[user_folder + '|' + bare] : undefined) || map[bare];
  }

  /* Done-ness + closer for ONE action item. `live` is the entry from the
     page's bus-fed map (a tick made in this session, which the report
     payload does not reflect until the next load); when present it wins,
     including an explicit unchecked. Otherwise the item's own status
     column decides, and the closer is the row's updated_by_name/
     updated_at. */
  function itemState(action, live) {
    if (live && live.checked !== undefined) {
      return { checked: !!live.checked,
               checked_by: live.checked_by || null,
               checked_at: live.checked_at || null };
    }
    var done = !!(action && action.status === 'done');
    return { checked: done,
             checked_by: done ? ((action && action.updated_by_name) || null) : null,
             checked_at: done ? ((action && action.updated_at) || null) : null };
  }

  /* feat/editable-tasks-ui — PATCH one action item's editable fields
     (priority/status/deadline/responsible) by its durable action_items.id
     (read shim now stamps this onto every item as `a.id`, threaded through
     today-adapter.js as task.actionItemId). This is an AURORA org write
     (PATCH /api/org/action-items/{id}); it rides `orgRequest`. Returns
     the FULL updated row: {id, topic_id, site_id, text, responsible,
     deadline, deadline_text, priority, status, created_at, updated_at,
     updated_by}. 400 (bad enum / non-member / empty) and 5xx REJECT (the
     org request() plumbing throws on any non-401/403/404 non-ok status);
     403/404 RESOLVE to {_accessDenied}/{_notFound} envelopes — callers must
     handle both shapes, mirroring every other org.js write.
     Mock merges the patch so the task-detail editors demo without a
     backend. */
  async function updateAction(actionItemId, patch) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.orgRequest('/action-items/' + encodeURIComponent(actionItemId), {
        method: 'PATCH',
        body:   patch || {},
      });
    }
    await window.FS.api.delay(60);
    return Object.assign({ id: actionItemId }, patch || {});
  }

  /* ======================================================================
     ONE authorised check-off entry point
     ----------------------------------------------------------------------
     `PATCH /api/org/action-items/{id}` enforces the real ACL (404
     cross-company, 403 out-of-reach site, then "admin/gm, THIS site's
     pm/site_manager, or the assignee only"). Every surface that resolves a
     task routes through here, and this is the ONLY writer of done-ness:

       durable actionItemId + org write reachable → updateAction(id,
         { status: checked ? 'done' : 'open' })
       mocks                                      → updateAction's in-memory
         merge (so demos tick)
       no actionItemId                            → refused, reason 'no_id'
       live but org write unreachable             → refused, 'unavailable'

     A worker who could tick under the old unauthenticated toggle may now
     get a 403 here. That is intended, and it is shown, never swallowed.

     ALWAYS RESOLVES a normalised envelope, never rejects. org writes
     RESOLVE 403/404 as {_accessDenied}/{_notFound}, so a bare `.catch()`
     silently treats a refusal as success — this codebase has repeatedly
     shipped exactly that bug. Callers get:
       { ok: true,  row }
       { ok: false, reason: 'denied'|'not_found'|'no_id'|'unavailable'|'error',
         message, status }
     ====================================================================== */

  /* True when the authoritative Aurora write path is actually reachable:
     the same `timelineSource === 'aurora' && orgBaseUrl` kill switch every
     other org read uses, plus updateAction's own !useMocks && !writeMocks
     gate — without that last part updateAction returns its merged-patch
     MOCK and we'd report a phantom success while nothing was persisted. */
  function orgCheckoffLive() {
    var api = window.FS && window.FS.api;
    if (!api) return false;
    return !api.useMocks && !api.writeMocks
        && api.timelineSource === 'aurora' && !!api.orgBaseUrl;
  }

  /* ONE internal "who/when closed this" shape. The Aurora org write
     (PATCH /api/org/action-items/{id}) returns the full action_items row,
     whose closer is `updated_by_name` (a resolved display name, may be null
     for an unprovisioned/nameless account) plus `updated_at`. Every
     consumer (the bus payload below, action-item-row.js's caption) reads
     ONLY checked_by/checked_at — never updated_by_name/updated_at
     directly — so this is the single place that shape decision lives. A
     payload that already carries checked_by/checked_at passes through. */
  function normaliseCheckoff(res) {
    if (res && (res.updated_by_name !== undefined || res.updated_at !== undefined)) {
      return {
        checked_by: res.updated_by_name || null,
        checked_at: res.updated_at || null,
      };
    }
    return {
      checked_by: (res && res.checked_by) || null,
      checked_at: (res && res.checked_at) || null,
    };
  }

  /* Broadcast server truth so sibling rows keyed on the same
     (date, user_folder, topic_id, action_index) sync — a Timeline row and a
     Today card showing the same item must not drift apart. */
  function emitCheckoff(opts, checked, res) {
    var bus = window.FS && window.FS.actionsBus;
    if (!bus) return;
    var who = normaliseCheckoff(res);
    bus.emit({
      date:         opts.date,
      topic_id:     opts.topic_id,
      action_index: opts.action_index,
      checked:      checked,
      checked_by:   who.checked_by,
      checked_at:   who.checked_at,
      user_folder:  opts.user_folder,
    });
  }

  async function resolveActionItem(opts) {
    opts = opts || {};
    var checked = opts.checked !== undefined ? !!opts.checked : true;
    var api = window.FS && window.FS.api;

    /* No durable id → no task record to update. Never guess a different
       writer: the legacy toggle that used to cover this case is gone. */
    if (!opts.actionItemId) {
      return {
        ok:      false,
        reason:  'no_id',
        status:  0,
        message: 'This item has no task record yet, so it cannot be ticked here.',
        path:    'none',
      };
    }
    /* Real backend but the org write is not reachable (kill switch off /
       no org base URL): say so rather than report a phantom success. */
    if (!orgCheckoffLive() && !(api && (api.useMocks || api.writeMocks))) {
      return {
        ok:      false,
        reason:  'unavailable',
        status:  0,
        message: 'Task updates are unavailable right now.',
        path:    'none',
      };
    }

    var res;
    try {
      res = await updateAction(opts.actionItemId, { status: checked ? 'done' : 'open' });
    } catch (err) {
      return {
        ok:      false,
        reason:  'error',
        status:  (err && err.status) || 0,
        message: (err && err.message) || 'Could not update this task.',
        path:    'org',
      };
    }
    if (!res || res._accessDenied) {
      return {
        ok:      false,
        reason:  'denied',
        status:  (res && res.status) || 403,
        /* patch_action_item's own wording ("admin/gm, this site's
           pm/site_manager, or the assignee only") is the most useful thing
           we can show — never replace it with a generic string. */
        message: (res && res.error)
                   || 'You do not have permission to check off this task.',
        path:    'org',
      };
    }
    if (res._notFound) {
      return {
        ok:      false,
        reason:  'not_found',
        status:  404,
        message: 'This task no longer exists.',
        path:    'org',
      };
    }

    emitCheckoff(opts, checked, res);
    return { ok: true, row: res, path: 'org' };
  }

  /* A task is resolved when its own status column says done. Nothing else
     counts: there is no overlay to consult. */
  function isActionResolved(columnStatus) {
    return columnStatus === 'done';
  }

  /* editable-content-correction — PATCH one free-text content field
     (topic title/summary, action_items.text/responsible, findings.*,
     safety_observations.observation) by its durable Aurora id. AURORA org
     write (PATCH /api/org/content/{table}/{id}), mirrors updateAction.
     Resolves {row, candidates} on success (candidates = D2 glossary diff
     terms), or {_accessDenied}/{_notFound}. Mock returns the merged patch. */
  async function updateContent(table, id, patch) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.orgRequest(
        '/content/' + encodeURIComponent(table) + '/' + encodeURIComponent(id),
        { method: 'PATCH', body: patch || {} });
    }
    await window.FS.api.delay(60);
    return { row: Object.assign({ id: id }, patch || {}), candidates: [] };
  }

  /* content-propagate (item #3) — same-term correction fan-out across ONE
     topic's rows. patch_content forbids batching ("exactly one editable
     field required" — one field, one row, one edit), so fixing a name in
     topics.summary leaves the same wrong name sitting in every
     action_items.responsible cell etc. Verified live on test: one topic had
     "Sean" in topics.summary AND in 5 action_items.responsible cells — 6
     places, one edit fixed 1. These two calls close that gap.

     Both are AURORA org endpoints with NO legacy fallback (there is no
     report-gateway equivalent), gated by the SAME kill switch orgCheckoffLive()
     uses above — aurora timeline source + a live orgBaseUrl + real writes
     (mocks/writeMocks both off). When the gate is off, both resolve an inert
     mock (field_count/changed_count 0) rather than silently hitting nothing,
     matching updateAction's mock branch.

     preview (POST .../propagate/preview) is READ-ONLY — writes nothing, safe
     to call automatically. apply (POST .../propagate) WRITES and is
     all-or-nothing: a 409 means a row changed mid-apply and NOTHING was
     written.

     Both RESOLVE {_accessDenied}/{_notFound} on 403/404 (mirrors every other
     org write above) and REJECT (the org request() plumbing throws on any
     non-401/403/404 non-ok status, so 400/409/5xx all throw) — callers must
     catch, never bare `.then()`. Never swallow either shape: this codebase
     has repeatedly shipped exactly that bug (see orgCheckoffLive's own
     header note). */
  function propagateLive() {
    var api = window.FS && window.FS.api;
    if (!api) return false;
    return !api.useMocks && !api.writeMocks
        && api.timelineSource === 'aurora' && !!api.orgBaseUrl;
  }

  async function previewTopicCorrection(topicId, before, after) {
    if (propagateLive()) {
      return window.FS.api.orgRequest(
        '/topics/' + encodeURIComponent(topicId) + '/propagate/preview',
        { method: 'POST', body: { before: before, after: after } });
    }
    await window.FS.api.delay(40);
    return { topic_id: topicId, before: before, after: after,
             field_count: 0, occurrence_count: 0, matches: [] };
  }

  async function applyTopicCorrection(topicId, before, after) {
    if (propagateLive()) {
      return window.FS.api.orgRequest(
        '/topics/' + encodeURIComponent(topicId) + '/propagate',
        { method: 'POST', body: { before: before, after: after } });
    }
    await window.FS.api.delay(60);
    return { topic_id: topicId, changed_count: 0, changed: [], reindex_enqueued: false };
  }

  /* editable-content-correction — content_edits trail for one row. */
  async function getContentHistory(table, id) {
    if (!window.FS.api.useMocks) {
      return window.FS.api.orgRequest(
        '/content/' + encodeURIComponent(table) + '/' + encodeURIComponent(id) + '/history');
    }
    await window.FS.api.delay(40);
    return { edits: table === 'action_items' ? mockActionEdits(id) : [] };
  }

  /* Mock read serves the fixture's own data (CLAUDE.md "a read stub should
     serve the day's own fixture"): an item stamped version N gets N-1
     priority edits, newest first, so opening it under mocks agrees with its
     chip instead of resetting it to v1 (spec 2026-09-15 §3.4/§8.3). */
  function mockActionEdits(id) {
    var reports = (((window.FieldSight || {}).fixtures || {}).reports) || {};
    var version = 1;
    Object.keys(reports).forEach(function (d) {
      Object.keys(reports[d]).forEach(function (f) {
        (reports[d][f].topics || []).forEach(function (t) {
          (t.action_items || []).forEach(function (a) { if (a.id === id && a.version) version = a.version; });
        });
      });
    });
    var edits = [];
    for (var k = version - 1; k >= 1; k--) {
      edits.push({
        id: 'mock-edit-' + id + '-' + k, field: 'priority',
        before_text: k % 2 ? 'medium' : 'high', after_text: k % 2 ? 'high' : 'medium',
        actor_name: 'Jack Gibson', created_at: '2026-04-29T0' + k + ':00:00+00:00',
      });
    }
    return edits;
  }

  /* editable-content-correction — confirm a glossary candidate into a scoped
     name_aliases row (site_manager+ enforced server-side). */
  /* The company's glossary, for the Settings › Glossary list (admin/gm), and
     undoing one entry. Entries are learned from people's own corrections
     (pipeline #1018, owner 2026-10-02); this is where they are seen and undone. */
  async function listAliases() {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.orgRequest('/aliases');
    }
    await window.FS.api.delay(60);
    return { aliases: [] };
  }

  async function retireAlias(id) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.orgRequest('/aliases/' + encodeURIComponent(id),
        { method: 'DELETE', retry: false });
    }
    await window.FS.api.delay(60);
    return { retired: id };
  }

  async function confirmAlias(body) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.orgRequest('/aliases', { method: 'POST', body: body || {} });
    }
    await window.FS.api.delay(60);
    return Object.assign({ id: 'mock-alias' }, body || {});
  }

  async function createRedaction(targetId, reason) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.orgRequest('/redactions',
        { method: 'POST', body: { target_id: targetId, reason: reason || 'non_work' } });
    }
    await window.FS.api.delay(60);
    return { redaction: { id: 'mock-red', target_id: targetId, reason: reason || 'non_work' } };
  }

  async function revertRedaction(redactionId) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.orgRequest('/redactions/' + encodeURIComponent(redactionId) + '/revert',
        { method: 'POST', body: {} });
    }
    await window.FS.api.delay(60);
    return { redaction: { id: redactionId, reverted_at: 'mock' } };
  }

  async function submitClassificationFeedback(payload) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.orgRequest('/classification-feedback',
        { method: 'POST', body: payload || {} });
    }
    await window.FS.api.delay(60);
    return { feedback: Object.assign({ id: 'mock-fb' }, payload || {}) };
  }

  /* spec 2026-09-15 §4 — the ONE place a field-editor save is judged.
     Returns {ok}. ok === true only for a resolved, non-denied, non-error
     envelope. On ok: shows the 'Saved' toast and emits content:edited
     {table, id} (FS.events). On !ok: does nothing, and the caller keeps its
     own existing failure handling. A thrown save never reaches here (callers'
     .catch paths are unchanged). Call pattern:
       if (!api.settleSave(res, {table, id}).ok) { ...existing failure... } */
  function settleSave(res, target) {
    var ok = !!res && !res._accessDenied && !res._notFound && !res.error;
    if (!ok) return { ok: false };
    var toast = window.FS && window.FS.toast;
    if (toast) toast.show({ message: 'Saved', tone: 'success', duration: 2000 });
    var events = window.FS && window.FS.events;
    if (events && target) events.emit('content:edited', { table: target.table, id: target.id });
    return { ok: true };
  }

  window.FS.api.actions = {
    updateAction:    updateAction,
    /* The ONE check-off entry point every surface must use. */
    resolveActionItem:  resolveActionItem,
    isActionResolved:   isActionResolved,
    itemState:          itemState,
    orgCheckoffLive:    orgCheckoffLive,
    /* Exposed so other read paths (not just the bus emit above) can remap
       an org-shaped row onto the same checked_by/checked_at pair without
       duplicating the shape logic. */
    normaliseCheckoff:  normaliseCheckoff,
    updateContent:   updateContent,
    /* content-propagate (item #3) */
    previewTopicCorrection: previewTopicCorrection,
    applyTopicCorrection:   applyTopicCorrection,
    propagateLive:          propagateLive,
    getContentHistory: getContentHistory,
    settleSave:      settleSave,
    confirmAlias:    confirmAlias,
    listAliases: listAliases,
    retireAlias: retireAlias,
    createRedaction: createRedaction,
    revertRedaction: revertRedaction,
    submitClassificationFeedback: submitClassificationFeedback,
    actionKey:       actionKey,
    lookupAction:    lookupAction,
  };

  /* Expose the pure/routing helpers to Node's test runner only (CommonJS).
     No-op in the browser (this file is a plain <script>, `module` is
     undefined), so the page bundle is unaffected — same pattern as
     scripts/pages/timeline.js. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      actionKey:         actionKey,
      lookupAction:      lookupAction,
      orgCheckoffLive:   orgCheckoffLive,
      resolveActionItem: resolveActionItem,
      isActionResolved:  isActionResolved,
      itemState:         itemState,
      normaliseCheckoff: normaliseCheckoff,
      propagateLive:            propagateLive,
      previewTopicCorrection:   previewTopicCorrection,
      applyTopicCorrection:     applyTopicCorrection,
      settleSave:               settleSave,
    };
  }

})();
