/* ==========================================================================
   FieldSight /action-packs -- what the background agent did with an instruction
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-11-10-action-pack-page-design.md (rev 2).

   One route: #/action-packs (list), ?id=<uuid> (one pack), ?new=1 (form).
   A pack shows how the agent read the instruction, which parts of it were
   done and why not the rest (sub-tasks), the cited findings, and the
   proposed actions -- each with its verifier badge and an Apply button only
   where the backend says this viewer may apply.

   Hard rules:
   - An action with verifier "unsupported" is never rendered, counted,
     planned or linked, whatever its reason_code (backend spec 2026-11-05
     §7.2). visibleActions() is the only door to the actions list.
   - Every piece of model or user text is a React text child, never HTML.
   - orgRequest resolves 403/404 as envelopes; they are read before data.

   platform_admin only while ACTION_PACKS=internal: the nav item
   (fs-globals.js NAV_ITEMS.actionPacks, platformAdminOnly) and the backend
   route both check the role. A 404 from the list means the flag is off.

   Registers window.FieldSight.PAGES['/action-packs'].
   ========================================================================== */

/* global React, window, document */

(function () {
  'use strict';

  /* ---- pure helpers ------------------------------------------------------- */

  var SHOWN_VERIFIERS = { supported: true, weak: true };

  /* src/action_pack_view.py:355-359 */
  var EDIT_FIELDS = {
    close_item: ['status'],
    update_item: ['deadline', 'responsible', 'priority', 'status'],
    create_item: ['text', 'responsible', 'deadline', 'priority'],
  };

  var TYPE_TEXT = {
    close_item: 'Close task', update_item: 'Update task', create_item: 'New task',
    draft_rfi: 'Draft RFI', draft_email: 'Draft email', note: 'Note',
  };

  var STATE_TEXT = {
    queued: 'Queued', running: 'Running', ready: 'Ready', failed: 'Failed', cancelled: 'Cancelled',
  };

  var SUB_STATUS_TEXT = { done: 'Done', partly: 'Partly', not_done: 'Not done' };

  /* src/action_pack_stages.py:627-629 */
  var REASON_CODE_TEXT = {
    no_evidence: 'No evidence found in the records',
    not_found: 'Could not find what this refers to',
    ambiguous_target: 'More than one item could be meant',
    out_of_scope: 'Outside what this pack may change',
    already_done: 'Already done',
    not_answered: 'The agent did not answer this part',
    dropped_by_checks: 'What the agent proposed was removed by checks',
  };
  var CODE_ALWAYS_SHOWN = { not_answered: true, dropped_by_checks: true };

  var STALE_REASON_TEXT = {
    changed: 'Someone changed this task after the pack read it.',
    target_gone: 'The task no longer exists.',
    target_moved: 'The task moved to another project.',
  };

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function nonEmpty(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : null; }
  function bySeq(a, b) { return (Number(a.seq) || 0) - (Number(b.seq) || 0); }

  function visibleActions(actions) {
    return (Array.isArray(actions) ? actions : []).filter(function (a) {
      return a && SHOWN_VERIFIERS[a.verifier] === true;
    });
  }

  function actionGroups(visible) {
    var g = { review: [], stale: [], done: [] };
    (visible || []).slice().sort(bySeq).forEach(function (a) {
      if (a.state === 'proposed' || a.state === 'failed') g.review.push(a);
      else if (a.state === 'stale') g.stale.push(a);
      else g.done.push(a);
    });
    return g;
  }

  function actionCounts(visible) {
    var n = { review: 0, stale: 0, applied: 0, dismissed: 0 };
    (visible || []).forEach(function (a) {
      if (a.state === 'proposed' || a.state === 'failed') n.review++;
      else if (a.state === 'stale') n.stale++;
      else if (a.state === 'applied') n.applied++;
      else if (a.state === 'dismissed') n.dismissed++;
    });
    var words = { review: 'to review', stale: 'changed since read', applied: 'applied', dismissed: 'dismissed' };
    return ['review', 'stale', 'applied', 'dismissed'].filter(function (k) { return n[k] > 0; })
      .map(function (k) { return { key: k, n: n[k], text: n[k] + ' ' + words[k] }; });
  }

  function detailReason(detail) {
    if (detail == null || typeof detail !== 'object') return null;
    return nonEmpty(detail.reason);
  }

  function actionBadge(a) {
    if (!a || a.verifier !== 'weak') return null;
    return { text: 'Uncertain', reason: detailReason(a.verifier_detail) };
  }

  function conclusionBadge(line) {
    if (!line || line.confidence !== 'uncertain') return null;
    return { text: 'Uncertain', reason: detailReason(line.verifier_detail) };
  }

  function reasonLine(sub) {
    if (!sub || (sub.status !== 'partly' && sub.status !== 'not_done')) return null;
    var reason = nonEmpty(sub.reason);
    var codeText = REASON_CODE_TEXT[sub.reason_code] || null;
    if (reason) {
      return { main: reason, muted: CODE_ALWAYS_SHOWN[sub.reason_code] ? codeText : null };
    }
    return codeText ? { main: codeText, muted: null } : null;
  }

  function subTaskView(sub, conclusionLen, visibleSeqs) {
    sub = sub || {};
    var seqs = visibleSeqs instanceof Set ? visibleSeqs : new Set(visibleSeqs || []);
    var len = Number(conclusionLen) || 0;
    return {
      id: str(sub.id), ask: str(sub.ask), kind: str(sub.kind), status: str(sub.status),
      statusText: SUB_STATUS_TEXT[sub.status] || str(sub.status),
      reason: reasonLine(sub),
      actionSeqs: (Array.isArray(sub.actions) ? sub.actions : []).filter(function (s) { return seqs.has(s); }),
      findings: (Array.isArray(sub.conclusion) ? sub.conclusion : []).filter(function (i) {
        return typeof i === 'number' && Math.floor(i) === i && i >= 0 && i < len;
      }).map(function (i) { return i + 1; }),
    };
  }

  function findSource(ref, sources) {
    return (Array.isArray(sources) ? sources : []).filter(function (s) { return s && s.ref === ref; })[0] || null;
  }

  function chipTarget(ref, sources) {
    var s = findSource(ref, sources);
    if (!s || s.removed) return { kind: 'removed', source: s };
    if (s.provenance === 'records') return { kind: 'records', source: s };
    if (s.provenance === 'documents') return { kind: 'documents', source: s };
    if (s.kind === 'web_source') return { kind: s.snapshot_s3_key ? 'snapshot' : 'web_link', source: s };
    if (s.kind === 'web_answer') return { kind: 'web_answer', source: s };
    return { kind: 'other', source: s };
  }

  function isWebOnly(refs, sources) {
    if (!Array.isArray(refs) || !refs.length) return false;
    return refs.every(function (r) {
      var s = findSource(r, sources);
      return !!s && !s.removed && s.provenance === 'web';
    });
  }

  function applyAllPlan(visible) {
    var run = [];
    var skipped = [];
    var targets = {};
    var list = (visible || []).slice().sort(bySeq);
    list.forEach(function (a) {
      if (a.verifier !== 'supported' || a.applicable !== true) return;
      if (a.target_stable_id && targets[a.target_stable_id]) {
        skipped.push({ action: a, text: 'Another action changes this task' });
        return;
      }
      if (a.target_stable_id) targets[a.target_stable_id] = true;
      run.push(a);
    });
    var weakCount = list.filter(function (a) { return a.verifier === 'weak' && a.applicable === true; }).length;
    return { run: run, skipped: skipped, weakCount: weakCount };
  }

  function formValue(v) { return (v === null || v === undefined) ? '' : String(v); }

  function editFields(a) {
    a = a || {};
    var fields = EDIT_FIELDS[a.type] || [];
    var proposed = a.proposed || {};
    var snap = a.target_snapshot || {};
    var values = {};
    fields.forEach(function (k) {
      if (a.type === 'close_item') values[k] = formValue(proposed.status) || 'done';
      else if (a.type === 'update_item') {
        values[k] = formValue(Object.prototype.hasOwnProperty.call(proposed, k) ? proposed[k] : snap[k]);
      } else values[k] = formValue(proposed[k]);
    });
    return { fields: fields, values: values };
  }

  /* Only what the person changed from the prefill: an untouched snapshot
     value is not sent (it would widen the stale check and write an audit row
     for nothing). A cleared deadline is null. */
  function editDiff(a, values) {
    var base = editFields(a);
    var out = {};
    values = values || {};
    base.fields.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(values, k)) return;
      var v = formValue(values[k]);
      if (v === base.values[k]) return;
      out[k] = (v === '' && k === 'deadline') ? null : v;
    });
    return out;
  }

  function failureText(failure) {
    if (failure === 'company_inactive') {
      return "This project's company is suspended or has left FieldSight, so the run stopped.";
    }
    return failure ? 'The run could not finish (' + str(failure) + '). Try again.'
      : 'The run could not finish. Try again.';
  }

  function createdText(result) {
    return (result && result.task_no !== null && result.task_no !== undefined && result.task_no !== '')
      ? 'Created #' + str(result.task_no) : 'Created';
  }

  function staleReasonText(reason) { return STALE_REASON_TEXT[reason] || null; }

  function envelopeState(res, where) {
    if (!res || typeof res !== 'object') return null;
    if (res._notFound && res.status === 404) {
      return where === 'detail'
        ? { kind: 'gone', text: 'This pack does not exist or you cannot see it.' }
        : { kind: 'off', text: 'Action packs are not switched on in this environment.' };
    }
    if (res._notFound) return { kind: 'error', text: 'Could not load (HTTP ' + str(res.status) + ').' };
    if (res._accessDenied) return { kind: 'denied', text: str(res.error) || 'Access denied.' };
    return null;
  }

  function safeHref(url) {
    return (typeof url === 'string' && /^https?:\/\//i.test(url)) ? url : null;
  }

  function isEnvelope(res) { return !!res && typeof res === 'object' && !!(res._notFound || res._accessDenied); }

  /* ---- poller: a chained timer, never setInterval ------------------------- */

  function createPoller(o) {
    var setTimer = o.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = o.clearTimer || function (h) { clearTimeout(h); };
    var visibility = o.visibility || function () {
      return (typeof document !== 'undefined' && document.visibilityState) || 'visible';
    };
    var delay = o.delay || { visible: 4000, hidden: 15000 };
    var stopped = true;
    var inFlight = false;
    var handle = null;

    function schedule() {
      if (stopped) return;
      if (handle) clearTimer(handle);
      var v = visibility();
      handle = setTimer(tick, v === 'hidden' ? delay.hidden : delay.visible);
    }

    function finish(r) {
      inFlight = false;
      if (stopped) return;
      o.onData(r);
      if (stopped) return;
      if (r.res && (isEnvelope(r.res) || (o.isDone && o.isDone(r.res)))) { stopped = true; return; }
      schedule();
    }

    function tick() {
      if (stopped || inFlight) return;
      handle = null;
      inFlight = true;
      Promise.resolve().then(o.fetch).then(function (res) { finish({ res: res }); },
        function (err) { finish({ err: err }); });
    }

    return {
      start: function () { stopped = false; tick(); },
      stop: function () { stopped = true; if (handle) clearTimer(handle); handle = null; },
      kick: function () {
        if (stopped || inFlight) return;
        if (handle) clearTimer(handle);
        handle = null;
        tick();
      },
    };
  }

  var exported = {
    visibleActions: visibleActions, actionGroups: actionGroups, actionCounts: actionCounts,
    actionBadge: actionBadge, conclusionBadge: conclusionBadge, reasonLine: reasonLine,
    subTaskView: subTaskView, chipTarget: chipTarget, isWebOnly: isWebOnly,
    applyAllPlan: applyAllPlan, editFields: editFields, editDiff: editDiff,
    failureText: failureText, createdText: createdText, staleReasonText: staleReasonText,
    envelopeState: envelopeState, safeHref: safeHref, createPoller: createPoller,
    TYPE_TEXT: TYPE_TEXT, STATE_TEXT: STATE_TEXT, REASON_CODE_TEXT: REASON_CODE_TEXT,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})();
