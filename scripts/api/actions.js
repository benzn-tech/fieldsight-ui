/* ==========================================================================
   FieldSight API · Action items — BACKEND-CONTEXT §4.10  (Sprint 8.1.1)
   User-dimension audit key — see
   docs/superpowers/plans/2026-07-13-user-dimension-audit-key.md
   --------------------------------------------------------------------------
   GET    /api/actions?date=YYYY-MM-DD
          → { date,
              actions:    { '<topic_id>_<action_index>': {checked, checked_by, checked_at} },  // legacy shape — collapses cross-user, kept for old-frontend transition only
              actions_v2: { '<user_folder>|<topic_id>_<action_index>': {...} } }                // new shape — bare key only for true (unmigrated) legacy records
          Live path normalizes: when actions_v2 is present on the response,
          res.actions is REPLACED with res.actions_v2, so every existing
          consumer reading res.actions transparently gets the new
          per-user map. Old backend / mock path (no actions_v2) fall
          through unchanged — no degradation.

   POST   /api/actions/toggle          (useMocks=false — Phase 0 Task 2)
          body { date, topic_id, action_index, checked, action_text, user_folder }
          → { message: "Updated", checked: true, user_folder }
          user_folder = report OWNER's folder (never the caller / current
          user — that's checked_by). Omit for legacy behaviour (writes the
          old bare key).

   POST   /api/actions                 (useMocks=false, writeMocks=false — Sprint 8.1.1)
          body { date, topic_id, action_index, action_text, responsible, ... }
          → { id, ...action }

   PATCH  /api/org/action-items/{id}    (useMocks=false, writeMocks=false — feat/editable-tasks-ui)
          AURORA ORG WRITE (rides orgRequest, NOT the report gateway above —
          a durable action_items.id, not a date/topic/index composite key).
          body { priority?, status?, deadline?, responsible? } (partial)
          → the FULL updated row: { id, topic_id, site_id, text, responsible,
            deadline, deadline_text, priority, status, created_at,
            updated_at, updated_by }
          400 (bad enum / non-member / empty), 403 (no authority),
          404 (missing/cross-company).

   Key helpers — ALL readers/writers go through these, never hand-roll a key:
     actionKey(user_folder, topic_id, action_index)
       `<user_folder>|<topic_id>_<action_index>`, or bare `<topic_id>_<action_index>`
       when user_folder is falsy.
     lookupAction(map, user_folder, topic_id, action_index)
       composite-key lookup with legacy bare-key fallback. ANTI-REGRESSION
       IRON RULE: this bare-key fallback is the ONLY legacy fallback allowed
       anywhere in the app — never fall back to querying the collapsed
       `actions` map instead (post-migration that reintroduces the original
       cross-user collision bug).

   Mock path: in-memory copy of fixtures.actions, mutations persist for the
   lifetime of the page (good enough to demo the optimistic-update pattern).
   Mock keys go through actionKey() too (bare when no user_folder given),
   so mock mode keeps exercising the legacy-fallback path.

   On real-backend failure:
     • Emits a revert event to FS.actionsBus so sibling ActionItemRows
       can roll back to previous state.
     • Shows a toast via FS.toast.show (if available).
   ========================================================================== */

(function () {
  'use strict';

  var state = null;

  function ensureState() {
    if (state) return;
    var f = (window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.actions) || {};
    state = JSON.parse(JSON.stringify(f));
  }

  /* actionKey/lookupAction signatures + semantics are locked by the plan
     (§1.3) — later tasks depend on them exactly as written here. */
  function actionKey(user_folder, topic_id, action_index) {
    var bare = topic_id + '_' + action_index;
    return user_folder ? (user_folder + '|' + bare) : bare;
  }

  function lookupAction(map, user_folder, topic_id, action_index) {
    if (!map) return undefined;
    var bare = topic_id + '_' + action_index;
    return (user_folder ? map[user_folder + '|' + bare] : undefined) || map[bare];
  }

  async function getActions(date) {
    if (!window.FS.api.useMocks) {
      return window.FS.api.request('/actions', { params: { date: date } }).then(function (res) {
        if (res && res.actions_v2) res.actions = res.actions_v2;
        return res;
      });
    }
    await window.FS.api.delay();
    ensureState();
    return { date: date, actions: state[date] || {} };
  }

  async function toggleAction(opts) {
    opts = opts || {};
    var date         = opts.date;
    var topic_id     = opts.topic_id;
    var action_index = opts.action_index;
    var checked      = !!opts.checked;
    var action_text  = opts.action_text;
    var user_folder  = opts.user_folder;  /* report OWNER's folder — never the caller */

    /* --- Real backend path (Phase 0 Task 2) ------------------------------
       Optimistic flow:
         1. ActionItemRow already flips its local checkbox state.
         2. We fire POST /api/actions/toggle (BACKEND-CONTEXT §4.10).
         3. On success: emit confirmed bus event (sibling rows sync).
         4. On failure: emit revert bus event + show toast error.
    */
    if (!window.FS.api.useMocks) {
      return window.FS.api.request('/actions/toggle', {
        method: 'POST',
        body:   { date: date, topic_id: topic_id, action_index: action_index, checked: checked, action_text: action_text, user_folder: user_folder },
      }).then(function (res) {
        /* Emit confirmed bus event so any sibling row with the same key
           updates to the server-truth value. */
        var bus = window.FS && window.FS.actionsBus;
        if (bus) {
          bus.emit({
            date:         date,
            topic_id:     topic_id,
            action_index: action_index,
            checked:      checked,
            checked_by:   (res && res.checked_by) || null,
            checked_at:   (res && res.checked_at) || null,
            user_folder:  user_folder,
          });
        }
        return res;
      }).catch(function (err) {
        /* Emit revert event so ActionItemRow rolls back. */
        var bus = window.FS && window.FS.actionsBus;
        if (bus) {
          bus.emit({
            date:         date,
            topic_id:     topic_id,
            action_index: action_index,
            checked:      !checked,  /* revert */
            checked_by:   null,
            checked_at:   null,
            _revert:      true,
            user_folder:  user_folder,
          });
        }
        /* Toast the failure. */
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message:  'Could not update action item' + ((err && err.message) ? ': ' + err.message : ''),
            tone:     'error',
            duration: 5000,
          });
        }
        throw err;
      });
    }

    /* --- Mock path ------------------------------------------------------- */
    await window.FS.api.delay(60);
    ensureState();

    var key = actionKey(user_folder, topic_id, action_index);
    var who = (window.AuthMock && window.AuthMock.currentUser && window.AuthMock.currentUser.name) || 'system';

    if (!state[date]) state[date] = {};
    state[date][key] = {
      checked:    checked,
      checked_by: who,
      checked_at: new Date().toISOString(),
    };

    /* T6 pre-check fix — the return value previously omitted checked_by/
       checked_at even though they're written into `state` above; callers
       that read the toggleAction response directly (e.g. safety.js's
       resolver display) got undefined in mock mode. Mirror the same
       fields the live path returns from the server. */
    return {
      message:    'Updated',
      checked:    checked,
      checked_by: state[date][key].checked_by,
      checked_at: state[date][key].checked_at,
    };
  }

  /* Sprint 8.1.1 — create a new action item. Used by future write flows. */
  async function createAction(payload) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.request('/actions', {
        method: 'POST',
        body:   payload,
      });
    }
    await window.FS.api.delay(80);
    ensureState();
    var date = payload.date;
    var key  = actionKey(payload.user_folder, payload.topic_id, payload.action_index || 0);
    if (!state[date]) state[date] = {};
    state[date][key] = {
      checked:    false,
      checked_by: null,
      checked_at: null,
    };
    return { id: date + '_' + key, created: true };
  }

  /* feat/editable-tasks-ui — PATCH one action item's editable fields
     (priority/status/deadline/responsible) by its durable action_items.id
     (read shim now stamps this onto every item as `a.id`, threaded through
     today-adapter.js as task.actionItemId). This is an AURORA org write
     (PATCH /api/org/action-items/{id}), NOT the legacy report gateway —
     unlike createAction above (which still rides `request('/actions', ...)`
     against the report gateway), so this rides `orgRequest` instead. Returns
     the FULL updated row: {id, topic_id, site_id, text, responsible,
     deadline, deadline_text, priority, status, created_at, updated_at,
     updated_by}. 400 (bad enum / non-member / empty) and 5xx REJECT (the
     org request() plumbing throws on any non-401/403/404 non-ok status);
     403/404 RESOLVE to {_accessDenied}/{_notFound} envelopes — callers must
     handle both shapes, mirroring every other org.js write.
     Mock merges the patch so the task-detail editors demo without a
     backend (mirrors createAction's mock branch, minus the audit-key
     bookkeeping — there's no legacy composite key for a durable id). */
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
     feat/checkoff-org-api — ONE authorised check-off entry point
     ----------------------------------------------------------------------
     WHY: `POST /api/actions/toggle` (the legacy report gateway) has ZERO
     authorisation — it takes date/topic_id/action_index/checked off the
     body and writes DynamoDB, so ANY signed-in user could resolve ANY
     other user's task. `PATCH /api/org/action-items/{id}` already enforces
     the real ACL (404 cross-company, 403 out-of-reach site, then
     "admin/gm, THIS site's pm/site_manager, or the assignee only"), which
     is exactly the desired check-off policy. Every surface that resolves a
     task now routes through here.

     ROUTING — the Aurora write whenever it can possibly work:
       durable actionItemId  +  orgCheckoffLive()  →  updateAction(id,
         { status: checked ? 'done' : 'open' })            [AUTHORISED]
       otherwise                                    →  toggleAction(...)
         (legacy DynamoDB overlay; id-less/pre-shim items, the report-source
          path, mocks). Kept as a fallback ONLY — never the preferred path.

     DONE-NESS IS THE UNION OF BOTH STORES. ~119 action-item check-offs
     already live in DynamoDB (prod `fieldsight-audit`, PK `ACTIONS#<date>`)
     whose Aurora rows are still status='open' — action_items.status is
     `NOT NULL DEFAULT 'open'` and only patch_action_item ever changes it.
     So NOTHING here deletes or ignores the overlay: readers keep OR-ing
     `audit.checked` with `status === 'done'` (the precedent already shipped
     in today.js keep() and action-item-row.js isColumnDone). That is a
     read-time merge, deliberately chosen over a migration: the overlay key
     is (date, REPORT topic index, action index) while Aurora is keyed by
     uuid, so a migration would have to replay the shim's positional
     ordering — and topic indices shift whenever a report is regenerated
     (ActionItemRow header, BUG §8.8), i.e. it could silently mis-assign
     someone else's completion. A merge cannot.

     UNCHECK needs the mirror of that merge: clearing only
     action_items.status would leave `audit.checked === true` and the item
     would resurrect as done on the next load (a live bug today on the
     Timeline row, the one uncheck-capable surface). So a successful
     org-path UNCHECK also clears the overlay, best-effort. This opens no
     new hole: it fires only AFTER the authorised PATCH returned 200.

     ALWAYS RESOLVES a normalised envelope, never rejects. org writes
     RESOLVE 403/404 as {_accessDenied}/{_notFound}, so a bare `.catch()`
     silently treats a refusal as success — this codebase has repeatedly
     shipped exactly that bug. Callers get:
       { ok: true,  row }
       { ok: false, reason: 'denied'|'not_found'|'error', message, status }
     ====================================================================== */

  /* True when the authoritative Aurora write path is actually reachable:
     the same `timelineSource === 'aurora' && orgBaseUrl` kill switch every
     other org read uses (compliance-aggregator.js:161, timeline.js:31),
     plus updateAction's own !useMocks && !writeMocks gate — without that
     last part updateAction returns its merged-patch MOCK and we'd report a
     phantom success while nothing was persisted. */
  function orgCheckoffLive() {
    var api = window.FS && window.FS.api;
    if (!api) return false;
    return !api.useMocks && !api.writeMocks
        && api.timelineSource === 'aurora' && !!api.orgBaseUrl;
  }

  /* Broadcast server truth so sibling rows keyed on the same
     (date, user_folder, topic_id, action_index) sync — the legacy
     toggleAction already does this; the org path must too, or a Timeline
     row and a Today card showing the same item drift apart. */
  function emitCheckoff(opts, checked, res) {
    var bus = window.FS && window.FS.actionsBus;
    if (!bus) return;
    bus.emit({
      date:         opts.date,
      topic_id:     opts.topic_id,
      action_index: opts.action_index,
      checked:      checked,
      checked_by:   (res && res.checked_by) || null,
      checked_at:   (res && res.checked_at) || null,
      user_folder:  opts.user_folder,
    });
  }

  async function resolveActionItem(opts) {
    opts = opts || {};
    var checked = opts.checked !== undefined ? !!opts.checked : true;

    /* ---- Legacy overlay path (no durable id / org write not live) ------
       toggleAction already emits the bus event + toasts + reverts on
       failure, so only normalise its outcome here. */
    if (!(opts.actionItemId && orgCheckoffLive())) {
      try {
        var legacy = await toggleAction({
          date:         opts.date,
          topic_id:     opts.topic_id,
          action_index: opts.action_index,
          checked:      checked,
          action_text:  opts.action_text,
          user_folder:  opts.user_folder,
        });
        return { ok: true, row: legacy || null, path: 'legacy' };
      } catch (err) {
        return {
          ok:      false,
          reason:  'error',
          status:  (err && err.status) || 0,
          message: (err && err.message) || 'Could not update this task.',
          path:    'legacy',
        };
      }
    }

    /* ---- Authorised Aurora path --------------------------------------- */
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

    /* Uncheck must also clear the legacy overlay — see the header note.
       Best-effort: the authoritative write already succeeded, so a failure
       here must NOT turn a successful uncheck into a reported failure. */
    if (!checked && opts.date != null && opts.topic_id != null && opts.action_index != null) {
      try {
        await toggleAction({
          date:         opts.date,
          topic_id:     opts.topic_id,
          action_index: opts.action_index,
          checked:      false,
          action_text:  opts.action_text,
          user_folder:  opts.user_folder,
        });
      } catch (e) { /* overlay clear is best-effort */ }
    }

    emitCheckoff(opts, checked, res);
    return { ok: true, row: res, path: 'org' };
  }

  /* feat/checkoff-org-api — done-ness for a row that carries BOTH stores:
     the authoritative action_items.status column and the legacy DynamoDB
     overlay boolean. Union, never one or the other (see header). Mirrors
     today.js keep()'s `item.status === 'Done' || auditEntry.checked` and
     action-item-row.js's `initialChecked || isColumnDone`. */
  function isActionResolved(columnStatus, overlayChecked) {
    return columnStatus === 'done' || !!overlayChecked;
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

  /* editable-content-correction — content_edits trail for one row. */
  async function getContentHistory(table, id) {
    if (!window.FS.api.useMocks) {
      return window.FS.api.orgRequest(
        '/content/' + encodeURIComponent(table) + '/' + encodeURIComponent(id) + '/history');
    }
    await window.FS.api.delay(40);
    return { edits: [] };
  }

  /* editable-content-correction — confirm a glossary candidate into a scoped
     name_aliases row (site_manager+ enforced server-side). */
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

  /* Sprint 4.2 — cross-day audit aggregation. */
  async function getActionsRange(opts) {
    opts = opts || {};
    var from = opts.from, to = opts.to;
    if (!from || !to) return { byDate: {}, dates: [] };

    var dates = [];
    var cursor = from;
    while (cursor <= to) {
      dates.push(cursor);
      cursor = window.FS.api.addDaysISO(cursor, 1);
    }

    /* Narrow to days that actually have a report — actions only exist where
       reports do, and the calendar enumeration above can span 150 days on
       the 'All' range. getSpan() reuses the same cached /api/dates fetch the
       toolbar uses; on failure keep the full enumeration. */
    try {
      var span = await window.FS.api.window.getSpan();
      var dmap = (span && span.dates) || {};
      var reportDays = dates.filter(function (d) { return dmap[d] && dmap[d].hasReport; });
      if (reportDays.length) dates = reportDays;
    } catch (e) { /* keep full enumeration */ }

    /* Pooled + per-day catch (an uncaught throttle rejection here killed
       /tasks even after the timeline leg was pooled — a failed day degrades
       to "no audit info" instead). */
    var perDay = (await window.FS.api.pooledAll(dates.map(function (d) {
      return function () {
        return getActions(d).then(function (res) { return { date: d, res: res }; })
          .catch(function () { return { date: d, res: { actions: {} } }; });
      };
    }), 8)).filter(Boolean);

    /* IB-1 permission-robustness fix — SWALLOW per-date denials instead of
       killing the whole range on the first 403. A denied date just drops
       out of `byDate` (callers already treat a missing date as "no audit
       info", see lookupAction()); only surface `_accessDenied` for the
       WHOLE range when EVERY date came back denied — a genuine total
       denial, not a partial one. Mirrors the inline per-date getActions()
       swallow in compliance-aggregator.js's fanoutDates(). */
    var byDate = {};
    var deniedCount = 0;
    var lastDenied = null;
    perDay.forEach(function (x) {
      if (x.res && x.res._accessDenied) {
        deniedCount++;
        lastDenied = x.res;
        return;
      }
      byDate[x.date] = (x.res && x.res.actions) || {};
    });

    if (perDay.length > 0 && deniedCount === perDay.length) {
      return { _accessDenied: true, error: (lastDenied && lastDenied.error) || 'Access denied' };
    }
    return { byDate: byDate, dates: dates };
  }

  window.FS.api.actions = {
    getActions:      getActions,
    getActionsRange: getActionsRange,
    toggleAction:    toggleAction,
    createAction:    createAction,
    updateAction:    updateAction,
    /* feat/checkoff-org-api — the ONE check-off entry point every surface
       must use; never call toggleAction directly for an action item. */
    resolveActionItem:  resolveActionItem,
    isActionResolved:   isActionResolved,
    orgCheckoffLive:    orgCheckoffLive,
    updateContent:   updateContent,
    getContentHistory: getContentHistory,
    confirmAlias:    confirmAlias,
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
    };
  }

})();
