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
     for nothing). A cleared deadline is null; any other cleared field is
     left out (PATCH has no "unset" for priority or responsible). */
  function editDiff(a, values) {
    var base = editFields(a);
    var out = {};
    values = values || {};
    base.fields.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(values, k)) return;
      var v = formValue(values[k]);
      if (v === base.values[k]) return;
      if (v === '' && k !== 'deadline') return;   /* "—" on a select means leave it */
      out[k] = v === '' ? null : v;
    });
    return out;
  }

  /* After an apply nobody could confirm (gateway timeout, network), the
     re-read right away may still miss a commit that lands a moment later:
     read once more after ~5 s. */
  function followUpDelay(out) { return out && out.kind === 'unknown' ? 5000 : null; }

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
    var dirty = false;      /* start()/kick() while a read is in flight: read again */
    var first = false;      /* the first read after start() uses the default GET retry */

    function schedule() {
      if (stopped) return;
      if (handle) clearTimer(handle);
      var v = visibility();
      handle = setTimer(tick, v === 'hidden' ? delay.hidden : delay.visible);
    }

    function finish(r) {
      inFlight = false;
      if (stopped) return;
      if (dirty) {
        /* The read in flight was taken before the reason for the reload (an
           apply, a dismiss): drop it and read again, final state or not. */
        dirty = false;
        tick();
        return;
      }
      o.onData(r);
      if (stopped) return;
      if (r.res && (isEnvelope(r.res) || (o.isDone && o.isDone(r.res)))) { stopped = true; return; }
      schedule();
    }

    function tick() {
      if (stopped || inFlight) return;
      handle = null;
      inFlight = true;
      var mark = { first: first };
      first = false;
      Promise.resolve(mark).then(o.fetch).then(function (res) { finish({ res: res }); },
        function (err) { finish({ err: err }); });
    }

    return {
      start: function () {
        stopped = false;
        first = true;
        if (inFlight) { dirty = true; return; }
        tick();
      },
      stop: function () { stopped = true; if (handle) clearTimer(handle); handle = null; },
      kick: function () {
        if (stopped) return;
        if (inFlight) { dirty = true; return; }
        if (handle) clearTimer(handle);
        handle = null;
        tick();
      },
    };
  }

  /* ---- components --------------------------------------------------------- *
     Presentational components are hook-free (state lives in PackList,
     PackDetail and the forms), so tests can call them as plain functions.  */

  function h() { return React.createElement.apply(React, arguments); }
  function apiPacks() { return window.FS.api.actionPacks; }
  function nzWhen(at) {
    var f = window.FS && window.FS.api && window.FS.api.nzDateTime;
    return at ? (f ? f(at) : str(at)) : '';
  }
  function nzDay(d) {
    var f = window.FS && window.FS.api && window.FS.api.nzDate;
    return d ? (f ? f(d) : str(d)) : '';
  }
  function navigate(path) {
    if (window.FS && window.FS.Router) window.FS.Router.navigate(path);
  }
  // Same button family as the Daily Report's "Back to Today" (.fs-timeline-page__back).
  function BackToPacks() {
    return h('button', { type: 'button', className: 'fs-timeline-page__back fs-pack__back',
      onClick: function () { navigate('/action-packs'); } },
      h('span', { className: 'fs-timeline-page__back-arrow', 'aria-hidden': 'true' }, '←'),
      h('span', null, 'Back to all packs'));
  }
  function packHref(id) { return '#/action-packs?id=' + encodeURIComponent(id); }
  function currentUser() { return (window.AuthMock && window.AuthMock.currentUser) || {}; }
  var FINAL = { ready: true, failed: true, cancelled: true };

  function Modal(props) {
    var M = window.FieldSight && window.FieldSight.ModalOverlay;
    if (M) return h(M, { open: true, onClose: props.onClose, title: props.title, size: props.size || 'md',
      closeOnBackdrop: props.closeOnBackdrop !== false }, props.children);
    return h('div', { role: 'dialog', 'aria-label': props.title, className: 'fs-pack__dialog' }, props.children);
  }

  function Chip(props) {
    return h('span', { className: 'fs-pack__chip fs-pack__chip--' + props.tone }, props.text);
  }

  function StateChip(props) {
    var tone = { ready: 'ok', failed: 'danger', cancelled: 'muted', running: 'info', queued: 'info' }[props.state] || 'muted';
    return h(Chip, { tone: tone, text: STATE_TEXT[props.state] || str(props.state) });
  }

  function Muted(props) { return h('p', { className: 'fs-pack__muted' }, props.children); }

  /* ---- list ---- */

  function ListBody(props) {
    var st = props.st || {};
    var env = st.status === 'env' ? envelopeState(st.res, 'list') : null;
    var body;
    if (st.status === 'loading') body = h(Muted, null, 'Loading…');
    else if (env) body = h('p', { className: env.kind === 'error' ? 'fs-pack__error' : 'fs-pack__muted' }, env.text);
    else if (st.status === 'error') body = h('p', { className: 'fs-pack__error' }, str(st.message));
    else {
      var packs = st.packs || [];
      body = h('div', null,
        st.refreshError ? h(Muted, null, 'Could not refresh — retrying.') : null,
        packs.length ? h('ul', { className: 'fs-pack__list' }, packs.map(function (p) {
          return h('li', { key: p.id, className: 'fs-pack__row' },
            h('a', { className: 'fs-pack__row-link', href: packHref(p.id) },
              h('span', { className: 'fs-pack__row-title' }, str(p.title || p.instruction)),
              h('span', { className: 'fs-pack__row-meta' },
                str(p.site_name), ' · ', h(StateChip, { state: p.state }), ' · ', nzWhen(p.created_at),
                p.state === 'failed' ? h('span', { className: 'fs-pack__row-failure' }, ' ' + failureText(p.failure)) : null)));
        })) : h(Muted, null, props.archived ? 'No archived packs.' : 'No packs yet. Start one with “+ New pack”.'),
        packs.length >= 50 ? h(Muted, null, 'Showing the newest 50.') : null);
    }
    return h('div', { className: 'fs-page fs-pack' },
      h('div', { className: 'fs-pack__header' },
        h('h1', { className: 'fs-pack__title' }, 'Action packs'),
        h('div', { className: 'fs-pack__header-buttons' },
          h('button', { type: 'button', className: 'fs-safety__raise-btn',
            onClick: props.onNew }, '+ New pack'))),
      h('div', { className: 'fs-pack__filters', role: 'group', 'aria-label': 'Filter packs' },
        h('button', { type: 'button', className: 'fs-pack__tab' + (props.archived ? '' : ' fs-pack__tab--on'),
          'aria-pressed': !props.archived, onClick: function () { props.onArchived(false); } }, 'Active'),
        h('button', { type: 'button', className: 'fs-pack__tab' + (props.archived ? ' fs-pack__tab--on' : ''),
          'aria-pressed': !!props.archived, onClick: function () { props.onArchived(true); } }, 'Archived'),
        h('label', { className: 'fs-pack__filter' }, 'State ',
          h('select', { value: props.stateFilter || '', onChange: function (e) { props.onState(e.target.value); } },
            [['', 'All'], ['queued', 'Queued'], ['running', 'Running'], ['ready', 'Ready'], ['failed', 'Failed'], ['cancelled', 'Cancelled']]
              .map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]); })))),
      body);
  }

  function usePoller(make, deps) {
    var ref = React.useRef(null);
    React.useEffect(function () {
      var p = make();
      ref.current = p;
      p.start();
      function onVis() { if (document.visibilityState === 'visible') p.kick(); }
      if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVis);
      return function () {
        p.stop();
        if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVis);
      };
    }, deps);
    return ref;
  }

  function useDocumentTitle(text) {
    React.useEffect(function () {
      if (typeof document === 'undefined') return undefined;
      var prev = document.title;
      document.title = text;
      return function () { document.title = prev; };
    }, [text]);
  }

  function PackList(props) {
    var arRef = React.useState(false); var archived = arRef[0]; var setArchived = arRef[1];
    var sfRef = React.useState(''); var stateFilter = sfRef[0]; var setStateFilter = sfRef[1];
    var stRef = React.useState({ status: 'loading' }); var st = stRef[0]; var setSt = stRef[1];
    useDocumentTitle('Action packs');
    usePoller(function () {
      setSt({ status: 'loading' });
      return createPoller({
        fetch: function (t) {
          return apiPacks().list({ archived: archived ? 'true' : undefined, state: stateFilter || undefined,
            poll: !(t && t.first) });
        },
        isDone: function (res) {
          return !((res && res.packs) || []).some(function (p) { return p.state === 'queued' || p.state === 'running'; });
        },
        delay: { visible: 15000, hidden: 60000 },
        onData: function (r) {
          if (r.err) {
            setSt(function (cur) {
              return cur.status === 'ok' ? Object.assign({}, cur, { refreshError: true })
                : { status: 'error', message: (r.err && r.err.message) || 'Could not load the packs.' };
            });
          } else if (isEnvelope(r.res)) setSt({ status: 'env', res: r.res });
          else setSt({ status: 'ok', packs: (r.res && r.res.packs) || [] });
        },
      });
    }, [archived, stateFilter]);
    return h(ListBody, { st: st, archived: archived, stateFilter: stateFilter,
      onArchived: setArchived, onState: setStateFilter,
      onNew: function () { navigate('/action-packs?new=1'); } });
  }

  /* ---- new pack form ---- */

  function createMessage(out) {
    if (!out) return null;
    if (out.kind === 'refused' && out.code === 'company_inactive') {
      return "This project's company is suspended or has left FieldSight.";
    }
    /* A 404 on create is the flag (the route answers {"error":"not found"});
       only "site not found" is about the request. */
    if (out.kind === 'refused' && out.status === 404 && (!out.message || out.message === 'not found')) {
      return 'Action packs are not switched on in this environment.';
    }
    if (out.kind === 'refused') return str(out.message) || ('Refused (HTTP ' + str(out.status) + ').');
    if (out.kind === 'not_started') return 'The pack could not be started. Try again.';
    if (out.kind === 'unknown' && out.status && out.status !== 503 && !out.waking && out.status < 500) {
      return 'Could not reach the server (HTTP ' + str(out.status) + ').';
    }
    return 'We could not tell whether the pack started. Check the list before trying again.';
  }

  function NewPackForm(props) {
    var insRef = React.useState(props.instruction || ''); var instruction = insRef[0]; var setInstruction = insRef[1];
    var siteRef = React.useState(props.siteId || ''); var siteId = siteRef[0]; var setSiteId = siteRef[1];
    var sitesRef = React.useState(null); var sites = sitesRef[0]; var setSites = sitesRef[1];
    var busyRef = React.useState(false); var busy = busyRef[0]; var setBusy = busyRef[1];
    var outRef = React.useState(null); var out = outRef[0]; var setOut = outRef[1];
    var runRef = React.useState(null); var running = runRef[0]; var setRunning = runRef[1];

    React.useEffect(function () {
      var alive = true;
      var org = window.FS.api.org;
      Promise.resolve(org && org.getOrgSites ? org.getOrgSites() : { sites: [] }).then(function (res) {
        if (alive) setSites(res && Array.isArray(res.sites) ? res.sites.filter(function (s) { return !s.archived; }) : []);
      }).catch(function () { if (alive) setSites([]); });
      return function () { alive = false; };
    }, []);

    var trimmed = instruction.trim();
    var valid = trimmed.length >= 1 && trimmed.length <= 2000 && !!siteId;

    function submit(e) {
      if (e && e.preventDefault) e.preventDefault();
      if (!valid || busy) return;
      setBusy(true);
      setOut(null);
      apiPacks().create({ instruction: trimmed, siteId: siteId }).then(function (o) {
        setBusy(false);
        if (o.kind === 'created') { props.onCreated(o.id); return; }
        setOut(o);
        if (o.kind === 'refused' && o.code === 'in_progress') {
          apiPacks().list({ state: 'running' }).then(function (r) {
            var p = r && r.packs && r.packs[0];
            if (p) return p;
            return apiPacks().list({ state: 'queued' }).then(function (q) { return q && q.packs && q.packs[0]; });
          }).then(function (p) { if (p) setRunning(p.id); }).catch(function () {});
        }
      });
    }

    var msg = createMessage(out);
    return h(Modal, { title: 'New action pack', onClose: props.onClose, closeOnBackdrop: false },
      h('form', { className: 'fs-pack__form', onSubmit: submit },
        h('label', { className: 'fs-pack__field' }, h('span', null, 'Project'),
          h('select', { value: siteId, required: true, disabled: busy,
            onChange: function (e) { setSiteId(e.target.value); } },
            h('option', { value: '' }, sites === null ? 'Loading…' : 'Choose a project'),
            (sites || []).map(function (s) {
              var id = s.site_id || s.id;
              return h('option', { key: id, value: id }, str(s.name) + (s.company_name ? ' · ' + str(s.company_name) : ''));
            }))),
        h('label', { className: 'fs-pack__field' }, h('span', null, 'Instruction'),
          h('textarea', { value: instruction, rows: 5, maxLength: 2000, disabled: busy,
            placeholder: 'For example: close anything only waiting on the pour record',
            onChange: function (e) { setInstruction(e.target.value); } }),
          h('span', { className: 'fs-pack__muted' }, trimmed.length + ' / 2000')),
        msg ? h('p', { className: 'fs-pack__error', role: 'alert' }, msg,
          running ? h('a', { className: 'fs-pack__link', href: packHref(running) }, ' Open the running pack') : null,
          out && out.kind === 'unknown' ? h('a', { className: 'fs-pack__link', href: '#/action-packs' }, ' Open the list') : null) : null,
        h('div', { className: 'fs-pack__form-actions' },
          h('button', { type: 'button', className: 'fs-pack__btn', onClick: props.onClose, disabled: busy }, 'Cancel'),
          h('button', { type: 'submit', className: 'fs-pack__btn fs-pack__btn--primary',
            disabled: !valid || busy, 'aria-busy': busy ? 'true' : undefined }, 'Start pack'))));
  }

  /* ---- detail: presentational pieces ---- */

  function ReasonText(props) {
    if (!props.reason) return null;
    return h('p', { className: 'fs-pack__reason' }, props.reason);
  }

  function RefChips(props) {
    var refs = props.refs || [];
    if (!refs.length) return null;
    return h('span', { className: 'fs-pack__chips' }, refs.map(function (ref) {
      var t = chipTarget(ref, props.sources);
      if (t.kind === 'removed') {
        return h('button', { key: ref, type: 'button', className: 'fs-pack__ref fs-pack__ref--removed',
          'aria-disabled': 'true', 'aria-label': 'Source ' + ref + ': source removed', title: 'Source removed' },
          str(ref));
      }
      var s = t.source || {};
      var label = 'Source ' + ref + (s.title ? ': ' + str(s.title) : '') + (s.date ? ', ' + nzDay(s.date) : '');
      return h('button', { key: ref, type: 'button', className: 'fs-pack__ref', 'aria-label': label,
        onClick: function () { if (props.onOpen) props.onOpen(ref); } }, str(ref));
    }));
  }

  function SubTaskList(props) {
    var subs = props.subTasks;
    if (!Array.isArray(subs) || !subs.length) return null;
    var tone = { done: 'ok', partly: 'warn', not_done: 'muted' };
    var mark = { done: '✓ ', partly: '◐ ', not_done: '○ ' };
    return h('section', { className: 'fs-pack__section', 'aria-label': 'What was asked' },
      h('h2', { className: 'fs-pack__h2' }, 'What you asked, part by part'),
      h('ul', { className: 'fs-pack__subtasks' }, subs.map(function (sub, i) {
        var v = subTaskView(sub, props.conclusionLen, props.visibleSeqs);
        function on() { if (props.onHighlight) props.onHighlight({ actions: v.actionSeqs, findings: v.findings }); }
        function off() { if (props.onHighlight) props.onHighlight(null); }
        return h('li', { key: v.id || i, className: 'fs-pack__subtask', tabIndex: 0,
            onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off },
          h('div', { className: 'fs-pack__subtask-head' },
            h(Chip, { tone: tone[v.status] || 'muted', text: (mark[v.status] || '') + v.statusText }),
            h('span', { className: 'fs-pack__ask' }, v.ask),
            v.kind ? h('span', { className: 'fs-pack__kind' }, v.kind) : null),
          v.reason ? h('p', { className: 'fs-pack__reason' }, v.reason.main,
            v.reason.muted ? h('span', { className: 'fs-pack__muted-inline' }, ' — ' + v.reason.muted) : null) : null,
          (v.actionSeqs.length || v.findings.length) ? h('p', { className: 'fs-pack__links' },
            v.actionSeqs.length ? h('span', null, 'Actions: ', v.actionSeqs.map(function (s, j) {
              return h('button', { key: s, type: 'button', className: 'fs-pack__linkbtn',
                onClick: function () { if (props.onJump) props.onJump(s); } }, (j ? ', ' : '') + 'Action ' + s);
            })) : null,
            v.actionSeqs.length && v.findings.length ? ' · ' : null,
            v.findings.length ? h('span', null, 'Findings: ' + v.findings.join(', ')) : null) : null);
      })));
  }

  function ConclusionList(props) {
    var lines = props.conclusion || [];
    if (!lines.length) return null;
    var hl = props.highlight && props.highlight.findings ? props.highlight.findings : [];
    return h('section', { className: 'fs-pack__section', 'aria-label': 'Findings' },
      h('h2', { className: 'fs-pack__h2' }, 'Findings'),
      h('ol', { className: 'fs-pack__conclusion' }, lines.map(function (c, i) {
        var badge = conclusionBadge(c);
        return h('li', { key: i, className: 'fs-pack__line' + (hl.indexOf(i + 1) !== -1 ? ' fs-pack__line--hl' : '') },
          h('span', { className: 'fs-pack__text' }, str(c && c.text)), ' ',
          badge ? h(Chip, { tone: 'warn', text: badge.text }) : null,
          isWebOnly(c && c.refs, props.sources) ? h(Chip, { tone: 'muted', text: "Web source, not your project's documents" }) : null,
          ' ', h(RefChips, { refs: c && c.refs, sources: props.sources, onOpen: props.onOpenRef }),
          badge ? h(ReasonText, { reason: badge.reason }) : null);
      })));
  }

  function fmtField(k, v) {
    if (v === null || v === undefined || v === '') return '—';
    if (k === 'deadline') return nzDay(v);
    return str(v);
  }

  function ChangeView(props) {
    var a = props.action;
    var p = a.proposed || {};
    var snap = a.target_snapshot || {};
    if (a.type === 'close_item') {
      return h('p', { className: 'fs-pack__change' }, 'Status: ' + fmtField('status', snap.status) + ' → ' + fmtField('status', p.status || 'done'));
    }
    if (a.type === 'update_item') {
      return h('ul', { className: 'fs-pack__change' }, Object.keys(p).map(function (k) {
        return h('li', { key: k }, k + ': ' + fmtField(k, snap[k]) + ' → ' + fmtField(k, p[k]));
      }));
    }
    if (a.type === 'create_item') {
      return h('ul', { className: 'fs-pack__change' }, ['text', 'responsible', 'deadline', 'priority']
        .filter(function (k) { return p[k] !== undefined && p[k] !== null && p[k] !== ''; })
        .map(function (k) { return h('li', { key: k }, k + ': ' + fmtField(k, p[k])); }));
    }
    var text = a.type === 'note' ? str(p.text)
      : [p.to ? 'To: ' + str(p.to) : null, p.subject ? 'Subject: ' + str(p.subject) : null, p.body ? '\n' + str(p.body) : null]
        .filter(Boolean).join('\n');
    return h('div', { className: 'fs-pack__draft' },
      h('pre', { className: 'fs-pack__pre' }, text),
      h('button', { type: 'button', className: 'fs-pack__btn', onClick: function () { if (props.onCopy) props.onCopy(text); } }, 'Copy'));
  }

  var OUTCOME_TEXT = {
    applied: 'Applied.', noop: 'Already done.', stale: 'This task changed since the pack read it.',
    failed: 'Apply failed — you can retry.', unknown: 'Could not confirm — refreshing.', ok: 'Done.',
    finished: 'The pack had already finished.',
  };
  function outcomeText(out) {
    if (!out) return '';
    if (out.kind === 'refused') return str(out.message) || ('Refused (HTTP ' + str(out.status) + ').');
    if (out.kind === 'skipped') return str(out.text);
    return OUTCOME_TEXT[out.kind] || '';
  }

  function ActionCard(props) {
    var a = props.action;
    var badge = actionBadge(a);
    var targeted = a.type === 'close_item' || a.type === 'update_item';
    var hidden = targeted && a.target_snapshot == null;
    var locked = !!props.locked;
    var canApply = a.applicable === true && !hidden && !locked && !props.archived;
    var canEdit = (a.applicable === true || a.applicable_reason === 'responsible_not_member') && !hidden && !locked && !props.archived;
    var canDismiss = (a.state === 'proposed' || a.state === 'failed' || a.state === 'stale') && !locked && !props.archived;
    var res = a.applied_result || {};
    var stateLine = null;
    if (a.state === 'applied') {
      stateLine = 'Applied ' + nzWhen(a.applied_at) + (res.noop ? ' · Already done'
        : (a.type === 'create_item' ? ' · ' + createdText(res) : ''));
    } else if (a.state === 'dismissed') stateLine = 'Dismissed';
    else if (a.state === 'stale') stateLine = 'Changed since the pack read it';
    else if (a.state === 'failed') stateLine = 'Last apply failed — you can retry.';
    return h('article', { id: 'fs-pack-action-' + a.seq, tabIndex: -1,
        className: 'fs-pack__action' + (props.highlighted ? ' fs-pack__action--hl' : '') },
      h('header', { className: 'fs-pack__action-head' },
        h('span', { className: 'fs-pack__seq' }, 'Action ' + str(a.seq)),
        h('span', { className: 'fs-pack__type' }, TYPE_TEXT[a.type] || str(a.type)),
        targeted && !hidden ? h('span', { className: 'fs-pack__target' },
          (a.target_task_no !== null && a.target_task_no !== undefined ? '#' + str(a.target_task_no) + ' ' : '')
          + str(a.target_snapshot.text)) : null,
        badge ? h(Chip, { tone: 'warn', text: badge.text }) : null),
      hidden ? h('p', { className: 'fs-pack__muted' }, 'Task not visible to you, or no longer exists') : h(ChangeView, { action: a, onCopy: props.onCopy }),
      badge ? h(ReasonText, { reason: badge.reason }) : null,
      a.rationale ? h('p', { className: 'fs-pack__rationale' }, str(a.rationale)) : null,
      h(RefChips, { refs: a.refs, sources: props.sources, onOpen: props.onOpenRef }),
      a.applicable_reason === 'responsible_not_member' ? h('p', { className: 'fs-pack__muted' }, 'Assignee is not on this project') : null,
      stateLine ? h('p', { className: 'fs-pack__state-line' }, stateLine,
        a.state === 'applied' && a.type === 'create_item' ? h('a', { className: 'fs-pack__link', href: '#/tasks' }, ' Open Tasks') : null,
        a.state === 'stale' ? h('button', { type: 'button', className: 'fs-pack__linkbtn',
          onClick: function () { props.onStale(a); } }, ' Why?') : null) : null,
      props.outcome ? h('p', { className: 'fs-pack__outcome', role: 'status' }, outcomeText(props.outcome)) : null,
      (canApply || canEdit || canDismiss) ? h('div', { className: 'fs-pack__buttons' },
        canApply ? h('button', { type: 'button', className: 'fs-pack__btn fs-pack__btn--primary', disabled: !!props.busy,
          'aria-busy': props.busy ? 'true' : undefined, onClick: function () { props.onApply(a); } },
          a.state === 'failed' ? 'Retry' : 'Apply') : null,
        canEdit ? h('button', { type: 'button', className: 'fs-pack__btn', disabled: !!props.busy,
          onClick: function () { props.onEdit(a); } }, 'Edit and apply') : null,
        canDismiss ? h('button', { type: 'button', className: 'fs-pack__btn', disabled: !!props.busy,
          onClick: function () { props.onDismiss(a); } }, 'Dismiss') : null) : null);
  }

  function ActionsSection(props) {
    var visible = props.visible;
    if (!visible.length) return null;
    var groups = actionGroups(visible);
    var counts = actionCounts(visible);
    var plan = applyAllPlan(visible);
    var hl = props.highlight && props.highlight.actions ? props.highlight.actions : [];
    function cards(list) {
      return list.map(function (a) {
        return h(ActionCard, { key: a.id, action: a, sources: props.sources, archived: props.archived,
          locked: props.applyAllRunning, busy: !!props.busy[a.id], outcome: props.outcomes[a.id],
          highlighted: hl.indexOf(a.seq) !== -1,
          onApply: props.onApply, onEdit: props.onEdit, onDismiss: props.onDismiss, onStale: props.onStale,
          onOpenRef: props.onOpenRef, onCopy: props.onCopy });
      });
    }
    function group(title, list) {
      if (!list.length) return null;
      return h('div', { className: 'fs-pack__group' }, h('h3', { className: 'fs-pack__h3' }, title), cards(list));
    }
    return h('section', { className: 'fs-pack__section', 'aria-label': 'Proposed actions' },
      h('h2', { className: 'fs-pack__h2' }, 'Actions',
        counts.length ? h('span', { className: 'fs-pack__counts' }, ' · ' + counts.map(function (c) { return c.text; }).join(' · ')) : null),
      (plan.run.length && !props.archived) ? h('div', { className: 'fs-pack__applyall' },
        h('button', { type: 'button', className: 'fs-pack__btn fs-pack__btn--primary',
          disabled: !!props.applyAllRunning, 'aria-busy': props.applyAllRunning ? 'true' : undefined,
          onClick: function () { props.onApplyAll(plan); } }, 'Apply all supported (' + plan.run.length + ')'),
        plan.weakCount ? h('span', { className: 'fs-pack__muted-inline' }, ' ' + plan.weakCount + ' uncertain not included') : null,
        plan.skipped.length ? h('span', { className: 'fs-pack__muted-inline' }, ' · ' + plan.skipped.length + ' skipped: another action changes the same task') : null) : null,
      props.applyAllReport ? h('ul', { className: 'fs-pack__report', 'aria-label': 'Apply all results' },
        props.applyAllReport.map(function (r) {
          return h('li', { key: r.action.id }, 'Action ' + str(r.action.seq) + ': ' + (r.outcome ? outcomeText(r.outcome) : 'waiting…'));
        })) : null,
      group('To review', groups.review),
      group('Changed since read', groups.stale),
      group('Done', groups.done));
  }

  function SourceCard(props) {
    var s = props.source || {};
    var href = safeHref(s.url);
    var dayLink = s.provenance === 'records' && s.site_id && s.date
      ? '#/timeline?site=' + encodeURIComponent(s.site_id) + '&date=' + encodeURIComponent(s.date) : null;
    return h('div', { className: 'fs-pack__source' },
      h('p', { className: 'fs-pack__source-head' },
        h('strong', null, str(s.ref)), ' ', str(s.title),
        s.date ? ' · ' + nzDay(s.date) : '', s.who ? ' · ' + str(s.who) : '',
        s.provenance === 'documents' && s.revision != null ? ' · rev ' + str(s.revision) : '',
        s.provenance === 'documents' && s.page_from != null
          ? ', p. ' + str(s.page_from) + (s.page_to != null && s.page_to !== s.page_from ? '–' + str(s.page_to) : '') : ''),
      s.removed ? h(Muted, null, 'Source removed') : null,
      s.excerpt ? h('blockquote', { className: 'fs-pack__excerpt' }, str(s.excerpt)) : null,
      s.kind === 'web_source' && !s.snapshot_s3_key ? h(Muted, null, 'Page not stored') : null,
      h('p', { className: 'fs-pack__links' },
        dayLink ? h('a', { className: 'fs-pack__link', href: dayLink }, 'Open day') : null,
        href ? h('a', { className: 'fs-pack__link', href: href, target: '_blank', rel: 'noopener noreferrer' }, ' Open the live page')
          : (s.url ? h('span', { className: 'fs-pack__muted-inline' }, ' ' + str(s.url)) : null),
        s.snapshot_s3_key && props.onSnapshot ? h('button', { type: 'button', className: 'fs-pack__linkbtn',
          onClick: function () { props.onSnapshot(s.ref); } }, ' Read the stored copy') : null));
  }

  function RunDetails(props) {
    var t = props.trace;
    var m = props.models || {};
    if (!t && !props.models) return null;
    var rows = [];
    if (t && t.dropped) rows.push(['Trace', 'Too large to show']);
    else if (t) {
      if (t.rounds != null) rows.push(['Rounds', str(t.rounds)]);
      if (t.tokens != null) rows.push(['Tokens', str(t.tokens) + (t.token_cap != null ? ' / ' + str(t.token_cap) : '')]);
      if (t.refs_gathered != null) rows.push(['Refs gathered / cited', str(t.refs_gathered) + ' / ' + str(t.refs_cited)]);
      if (t.ms && t.ms.total != null) rows.push(['Time', Math.round(Number(t.ms.total) / 1000) + ' s']);
    }
    ['planner', 'writer', 'verifier'].forEach(function (k) { if (m[k]) rows.push([k.charAt(0).toUpperCase() + k.slice(1), str(m[k])]); });
    return h('details', { className: 'fs-pack__section' },
      h('summary', null, 'Run details'),
      h('dl', { className: 'fs-pack__dl' }, rows.map(function (r) {
        return h('div', { key: r[0] }, h('dt', null, r[0]), h('dd', null, r[1]));
      })));
  }

  function PackBody(props) {
    var pack = props.pack;
    var visible = visibleActions(pack.actions);
    var visibleSeqs = visible.map(function (a) { return a.seq; });
    var conclusion = Array.isArray(pack.conclusion) ? pack.conclusion : [];
    var sources = Array.isArray(pack.sources) ? pack.sources : [];
    var running = pack.state === 'queued' || pack.state === 'running';
    var facts = [str(pack.site_name), 'Started ' + nzWhen(pack.created_at)];
    if (pack.state === 'ready' && pack.as_of) facts.push('Read as of ' + nzWhen(pack.as_of));
    if (pack.archived) facts.push('Archived');
    if (props.companyName) facts.push("Another company's project · " + str(props.companyName));
    return h('div', { className: 'fs-page fs-pack' },
      h(BackToPacks, null),
      h('div', { className: 'fs-pack__header' },
        h('h1', { className: 'fs-pack__title' }, str(pack.title || pack.instruction)),
        h('div', { className: 'fs-pack__header-buttons' },
          running && pack.is_creator ? h('button', { type: 'button', className: 'fs-pack__btn', disabled: !!props.packBusy,
            onClick: props.onCancel }, 'Cancel') : null,
          h('button', { type: 'button', className: 'fs-pack__btn', disabled: !!props.packBusy || props.applyAllRunning,
            onClick: props.onArchive }, pack.archived ? 'Unarchive' : 'Archive'),
          pack.state === 'ready' ? h('button', { type: 'button', className: 'fs-pack__btn', onClick: props.onExport }, 'Export .md') : null)),
      h('p', { className: 'fs-pack__facts' }, facts.join(' · '), ' · ', h(StateChip, { state: pack.state })),
      h('p', { className: 'fs-pack__sr', 'aria-live': 'polite' }, STATE_TEXT[pack.state] || ''),
      h('blockquote', { className: 'fs-pack__instruction' }, h('span', { className: 'fs-pack__muted-inline' }, 'You asked: '), str(pack.instruction)),
      props.notice ? h('p', { className: 'fs-pack__outcome', role: 'status' }, str(props.notice)) : null,
      props.refreshError ? h(Muted, null, 'Could not refresh — retrying.') : null,
      pack.state === 'queued' ? h(Muted, null, 'Waiting to start…') : null,
      pack.state === 'running' ? h(Muted, null, 'Working… this usually takes 1–5 minutes.') : null,
      pack.state === 'cancelled' ? h(Muted, null, 'Cancelled.') : null,
      pack.state === 'failed' ? h('div', { className: 'fs-pack__failed' },
        h('p', { className: 'fs-pack__error' }, failureText(pack.failure)),
        h('button', { type: 'button', className: 'fs-pack__btn', onClick: props.onRunAgain }, 'Run again')) : null,
      pack.reading ? h('section', { className: 'fs-pack__section', 'aria-label': 'Reading' },
        h('h2', { className: 'fs-pack__h2' }, 'I read this as'),
        h('p', { className: 'fs-pack__reading' }, str(pack.reading))) : null,
      pack.state === 'failed' ? null : h('div', null,
        h(SubTaskList, { subTasks: pack.sub_tasks, conclusionLen: conclusion.length, visibleSeqs: visibleSeqs,
          onHighlight: props.onHighlight, onJump: props.onJump }),
        h(ConclusionList, { conclusion: conclusion, sources: sources, highlight: props.highlight, onOpenRef: props.onOpenRef }),
        h(ActionsSection, { visible: visible, sources: sources, archived: !!pack.archived,
          highlight: props.highlight, busy: props.busy || {}, outcomes: props.outcomes || {},
          applyAllRunning: props.applyAllRunning, applyAllReport: props.applyAllReport,
          onApply: props.onApply, onEdit: props.onEdit, onDismiss: props.onDismiss, onStale: props.onStale,
          onApplyAll: props.onApplyAll, onOpenRef: props.onOpenRef, onCopy: props.onCopy }),
        sources.length ? h('details', { className: 'fs-pack__section' },
          h('summary', null, 'Sources (' + sources.length + ')'),
          sources.map(function (s) { return h(SourceCard, { key: s.ref, source: s, onSnapshot: props.onSnapshot }); })) : null,
        h(RunDetails, { trace: pack.run_trace, models: pack.models })));
  }

  /* ---- dialogs (with hooks) ---- */

  var COMPARE_ROWS = [['status', 'Status'], ['deadline', 'Deadline'], ['responsible', 'Responsible'],
    ['priority', 'Priority'], ['text', 'Text'], ['updated_at', 'Last changed']];

  function StaleDialog(props) {
    var a = props.action;
    var cmpRef = React.useState(props.fresh || null); var cmp = cmpRef[0]; var setCmp = cmpRef[1];
    var busyRef = React.useState(false); var busy = busyRef[0]; var setBusy = busyRef[1];
    var msgRef = React.useState(null); var msg = msgRef[0]; var setMsg = msgRef[1];
    var reason = staleReasonText(a.applied_result && a.applied_result.reason);
    var wanted = Object.keys(a.proposed || {});
    function compare() {
      setBusy(true);
      apiPacks().apply(props.packId, a.id, a.type).then(function (out) {
        setBusy(false);
        if (out.kind === 'stale') setCmp({ live: out.live, snapshot: out.snapshot });
        else setMsg(outcomeText(out));
      });
    }
    function cell(k, v) { return k === 'updated_at' ? nzWhen(v) : fmtField(k, v); }
    return h(Modal, { title: 'This task changed since the pack read it', onClose: props.onClose },
      reason ? h('p', null, reason) : null,
      cmp ? ((cmp.live == null && cmp.snapshot == null)
        ? h('p', null, 'This task changed or is no longer visible to you.')
        : h('table', { className: 'fs-pack__compare' },
          h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Now'), h('th', null, 'When the pack read it'), h('th', null, ''))),
          h('tbody', null, COMPARE_ROWS.map(function (r) {
            var now = cmp.live ? cmp.live[r[0]] : null;
            var then = cmp.snapshot ? cmp.snapshot[r[0]] : null;
            var differs = str(now) !== str(then);
            return h('tr', { key: r[0], className: wanted.indexOf(r[0]) !== -1 ? 'fs-pack__wanted' : '' },
              h('th', null, r[1]), h('td', null, cell(r[0], now)), h('td', null, cell(r[0], then)),
              h('td', null, differs ? 'changed' : ''));
          }))))
        : (!props.archived ? h('button', { type: 'button', className: 'fs-pack__btn', disabled: busy,
          'aria-busy': busy ? 'true' : undefined, onClick: compare }, 'Compare with now') : null),
      msg ? h('p', { className: 'fs-pack__muted' }, msg) : null,
      h('div', { className: 'fs-pack__form-actions' },
        h('a', { className: 'fs-pack__btn', href: '#/tasks' }, 'Open Tasks'),
        !props.archived ? h('button', { type: 'button', className: 'fs-pack__btn', onClick: function () { props.onDismiss(a); } }, 'Dismiss action') : null));
  }

  function EditApplyForm(props) {
    var a = props.action;
    var ef = editFields(a);
    var valRef = React.useState(ef.values); var values = valRef[0]; var setValues = valRef[1];
    var memRef = React.useState(null); var members = memRef[0]; var setMembers = memRef[1];
    React.useEffect(function () {
      var alive = true;
      var org = window.FS.api.org;
      if (ef.fields.indexOf('responsible') === -1 || !org || !org.getSiteMembers) return undefined;
      Promise.resolve(org.getSiteMembers(props.siteId)).then(function (res) {
        if (alive) setMembers(res && Array.isArray(res.users) ? res.users.map(function (u) { return str(u.name); }).filter(Boolean) : []);
      }).catch(function () { if (alive) setMembers([]); });
      return function () { alive = false; };
    }, []);
    function set(k, v) { setValues(function (cur) { var n = Object.assign({}, cur); n[k] = v; return n; }); }
    function control(k) {
      var v = values[k];
      if (k === 'status') {
        var opts = a.type === 'close_item' ? ['done', 'closed'] : ['open', 'in_progress', 'blocked', 'done', 'closed'];
        return h('select', { value: v, onChange: function (e) { set(k, e.target.value); } },
          opts.map(function (o) { return h('option', { key: o, value: o }, o); }));
      }
      if (k === 'priority') {
        return h('select', { value: v, onChange: function (e) { set(k, e.target.value); } },
          ['', 'low', 'medium', 'high'].map(function (o) { return h('option', { key: o, value: o }, o || '—'); }));
      }
      if (k === 'responsible') {
        var names = (members || []).slice();
        if (v && names.indexOf(v) === -1) names.unshift(v);
        return h('select', { value: v, onChange: function (e) { set(k, e.target.value); } },
          [h('option', { key: '', value: '' }, members === null ? 'Loading…' : '—')].concat(
            names.map(function (n) { return h('option', { key: n, value: n }, n); })));
      }
      if (k === 'deadline') {
        return h('input', { type: 'date', value: v, onChange: function (e) { set(k, e.target.value); } });
      }
      return h('textarea', { value: v, rows: 3, maxLength: 2000, onChange: function (e) { set(k, e.target.value); } });
    }
    return h(Modal, { title: 'Edit and apply · Action ' + str(a.seq), onClose: props.onClose, closeOnBackdrop: false },
      h('form', { className: 'fs-pack__form', onSubmit: function (e) {
        if (e && e.preventDefault) e.preventDefault();
        props.onSubmit(a, editDiff(a, values));
      } },
        ef.fields.map(function (k) {
          return h('label', { key: k, className: 'fs-pack__field' }, h('span', null, k), control(k));
        }),
        h('div', { className: 'fs-pack__form-actions' },
          h('button', { type: 'button', className: 'fs-pack__btn', onClick: props.onClose }, 'Cancel'),
          h('button', { type: 'submit', className: 'fs-pack__btn fs-pack__btn--primary' }, 'Apply'))));
  }

  function SnapshotDialog(props) {
    var stRef = React.useState({ status: 'loading' }); var st = stRef[0]; var setSt = stRef[1];
    React.useEffect(function () {
      var alive = true;
      apiPacks().snapshot(props.packId, props.ref).then(function (res) {
        if (!alive) return;
        if (isEnvelope(res) || !res) setSt({ status: 'none' });
        else setSt({ status: 'ok', snap: res });
      }).catch(function () { if (alive) setSt({ status: 'none' }); });
      return function () { alive = false; };
    }, []);
    var s = st.snap || {};
    var href = safeHref(s.url);
    return h(Modal, { title: 'Stored copy · ' + str(props.ref), onClose: props.onClose, size: 'lg' },
      st.status === 'loading' ? h(Muted, null, 'Loading…') : null,
      st.status === 'none' ? h(Muted, null, 'Snapshot not available') : null,
      st.status === 'ok' ? h('div', null,
        h('p', null, 'Snapshot of ' + str(s.url) + ' taken ' + nzWhen(s.fetched_at)),
        href ? h('a', { className: 'fs-pack__link', href: href, target: '_blank', rel: 'noopener noreferrer' }, 'Open the live page') : null,
        h('pre', { className: 'fs-pack__pre' }, str(s.text)),
        s.truncated ? h(Muted, null, '(truncated)') : null) : null);
  }

  function ApplyAllConfirm(props) {
    var plan = props.plan || { run: [], skipped: [] };
    var n = plan.run.length;
    function line(a) {
      var what = a.type === 'create_item' ? str(a.proposed && a.proposed.text)
        : ((a.target_task_no !== null && a.target_task_no !== undefined ? '#' + str(a.target_task_no) + ' ' : '')
          + str(a.target_snapshot && a.target_snapshot.text));
      return 'Action ' + str(a.seq) + ' · ' + (TYPE_TEXT[a.type] || str(a.type)) + (what ? ' · ' + what : '');
    }
    return h(Modal, { title: 'Apply ' + n + ' supported action' + (n === 1 ? '' : 's') + '?', onClose: props.onClose },
      h('p', null, 'Apply ' + n + ' supported action' + (n === 1 ? '' : 's') + '?'),
      h('ul', { className: 'fs-pack__report' }, plan.run.map(function (a) { return h('li', { key: a.id }, line(a)); })),
      plan.skipped.length ? h('div', null,
        h('p', { className: 'fs-pack__muted' }, 'Skipped:'),
        h('ul', { className: 'fs-pack__report' }, plan.skipped.map(function (s) {
          return h('li', { key: s.action.id }, line(s.action) + ' — ' + str(s.text));
        }))) : null,
      plan.weakCount ? h('p', { className: 'fs-pack__muted' }, plan.weakCount + ' uncertain not included.') : null,
      h('div', { className: 'fs-pack__form-actions' },
        h('button', { type: 'button', className: 'fs-pack__btn', onClick: props.onClose }, 'Cancel'),
        h('button', { type: 'button', className: 'fs-pack__btn fs-pack__btn--primary',
          onClick: function () { props.onConfirm(plan); } }, 'Apply ' + n)));
  }

  function SourceDialog(props) {
    var t = chipTarget(props.ref, props.sources);
    return h(Modal, { title: 'Source ' + str(props.ref), onClose: props.onClose, size: 'sm' },
      h(SourceCard, { source: t.source || { ref: props.ref, removed: true },
        onSnapshot: t.kind === 'snapshot' ? props.onSnapshot : null }));
  }

  /* ---- detail (state) ---- */

  function downloadText(filename, content, type) {
    try {
      var blob = new Blob([content], { type: type || 'text/markdown' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return true;
    } catch (e) { return false; }
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
    } catch (e) { /* nothing to do */ }
  }

  function PackDetail(props) {
    var id = props.id;
    var stRef = React.useState({ status: 'loading' }); var st = stRef[0]; var setSt = stRef[1];
    var hlRef = React.useState(null); var highlight = hlRef[0]; var setHighlight = hlRef[1];
    var busyRef = React.useState({}); var busy = busyRef[0]; var setBusy = busyRef[1];
    var outRef = React.useState({}); var outcomes = outRef[0]; var setOutcomes = outRef[1];
    var dlgRef = React.useState(null); var dialog = dlgRef[0]; var setDialog = dlgRef[1];
    var aaRef = React.useState(null); var applyAll = aaRef[0]; var setApplyAll = aaRef[1];
    var pbRef = React.useState(false); var packBusy = pbRef[0]; var setPackBusy = pbRef[1];
    var ntRef = React.useState(null); var notice = ntRef[0]; var setNotice = ntRef[1];
    var coRef = React.useState(null); var companyName = coRef[0]; var setCompanyName = coRef[1];
    var alive = React.useRef(true);
    React.useEffect(function () { alive.current = true; return function () { alive.current = false; }; }, []);

    var pack = st.status === 'ok' ? st.pack : null;
    useDocumentTitle(pack ? str(pack.title || pack.instruction) + ' · Action packs' : 'Action packs');

    var poller = usePoller(function () {
      setSt({ status: 'loading' });
      return createPoller({
        fetch: function (t) { return apiPacks().get(id, { poll: !(t && t.first) }); },
        isDone: function (res) { return !!(res && FINAL[res.state]); },
        delay: { visible: 4000, hidden: 15000 },
        onData: function (r) {
          if (r.err) {
            setSt(function (cur) {
              return cur.status === 'ok' ? Object.assign({}, cur, { refreshError: true })
                : { status: 'error', message: (r.err && r.err.message) || 'Could not load the pack.' };
            });
          } else if (isEnvelope(r.res)) setSt({ status: 'env', res: r.res });
          else setSt({ status: 'ok', pack: r.res });
        },
      });
    }, [id]);

    function reload() { if (poller.current) { poller.current.stop(); poller.current.start(); } }

    var siteId = pack && pack.site_id;
    React.useEffect(function () {
      if (!siteId || currentUser().role !== 'platform_admin') return undefined;
      var on = true;
      var org = window.FS.api.org;
      Promise.resolve(org && org.getOrgSites ? org.getOrgSites() : null).then(function (res) {
        var s = res && Array.isArray(res.sites) ? res.sites.filter(function (x) { return (x.site_id || x.id) === siteId; })[0] : null;
        if (on) setCompanyName(s && s.company_name ? s.company_name : null);
      }).catch(function () {});
      return function () { on = false; };
    }, [siteId]);

    function setOne(setter, key, value) {
      setter(function (cur) { var n = Object.assign({}, cur); n[key] = value; return n; });
    }

    function runApply(a, fields) {
      setOne(setBusy, a.id, true);
      setOne(setOutcomes, a.id, null);
      return apiPacks().apply(pack.id, a.id, a.type, fields).then(function (out) {
        if (!alive.current) return out;
        setOne(setBusy, a.id, false);
        setOne(setOutcomes, a.id, out);
        if (out.kind === 'stale') setDialog({ kind: 'stale', action: a, fresh: { live: out.live, snapshot: out.snapshot } });
        var later = followUpDelay(out);
        if (later) setTimeout(function () { if (alive.current) reload(); }, later);
        return out;
      });
    }

    function onApply(a) { runApply(a).then(reload); }
    function onEditSubmit(a, fields) { setDialog(null); runApply(a, fields).then(reload); }
    function onDismiss(a) {
      setDialog(null);
      setOne(setBusy, a.id, true);
      apiPacks().dismiss(pack.id, a.id).then(function (out) {
        if (!alive.current) return;
        setOne(setBusy, a.id, false);
        setOne(setOutcomes, a.id, out);
        reload();
      });
    }

    function onApplyAll(plan) { setDialog({ kind: 'applyall', plan: plan }); }

    function runApplyAll(plan) {
      setDialog(null);
      var report = plan.run.map(function (a) { return { action: a, outcome: null } })
        .concat(plan.skipped.map(function (s) { return { action: s.action, outcome: { kind: 'skipped', text: s.text } }; }));
      setApplyAll({ running: true, report: report });
      var i = 0;
      function next() {
        if (!alive.current) return;
        if (i >= plan.run.length) {
          setApplyAll(function (cur) { return Object.assign({}, cur, { running: false }); });
          reload();
          return;
        }
        var a = plan.run[i];
        apiPacks().apply(pack.id, a.id, a.type).then(function (out) {
          if (!alive.current) return;
          var idx = i;
          setApplyAll(function (cur) {
            var r = cur.report.slice();
            r[idx] = { action: a, outcome: out };
            return Object.assign({}, cur, { report: r });
          });
          i += 1;
          next();
        });
      }
      next();
    }

    function onCancel() {
      setPackBusy(true);
      apiPacks().cancel(pack.id).then(function (out) {
        if (!alive.current) return;
        setPackBusy(false);
        setNotice(out.kind === 'ok' ? 'Cancelled.' : outcomeText(out));
        reload();
      });
    }
    function onArchive() {
      setPackBusy(true);
      apiPacks().archive(pack.id, !pack.archived).then(function (out) {
        if (!alive.current) return;
        setPackBusy(false);
        setNotice(out.kind === 'ok' ? (pack.archived ? 'Unarchived.' : 'Archived.') : outcomeText(out));
        reload();
      });
    }
    function onExport() {
      Promise.resolve(apiPacks().exportMd(pack.id)).then(function (res) {
        if (!res || isEnvelope(res) || typeof res.content !== 'string') { setNotice('Could not export the pack.'); return; }
        if (!downloadText(res.filename || ('action-pack-' + pack.id + '.md'), res.content, res.content_type)) {
          setNotice('Could not export the pack.');
        }
      }).catch(function () { setNotice('Could not export the pack.'); });
    }
    function onJump(seq) {
      var el = typeof document !== 'undefined' && document.getElementById('fs-pack-action-' + seq);
      if (el) { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); if (el.focus) el.focus(); }
    }

    if (st.status === 'loading') return h('div', { className: 'fs-page fs-pack' }, h(Muted, null, 'Loading…'));
    if (st.status === 'env' || st.status === 'error') {
      var env = st.status === 'env' ? envelopeState(st.res, 'detail') : { kind: 'error', text: str(st.message) };
      return h('div', { className: 'fs-page fs-pack' },
        h(BackToPacks, null),
        h('p', { className: env.kind === 'gone' ? 'fs-pack__muted' : 'fs-pack__error' }, env.text),
        env.kind === 'gone' ? null : h('button', { type: 'button', className: 'fs-pack__btn', onClick: reload }, 'Retry'));
    }

    var sources = pack.sources || [];
    var dlg = null;
    if (dialog && dialog.kind === 'stale') {
      dlg = h(StaleDialog, { action: dialog.action, fresh: dialog.fresh, packId: pack.id, archived: !!pack.archived,
        onClose: function () { setDialog(null); }, onDismiss: onDismiss });
    } else if (dialog && dialog.kind === 'edit') {
      dlg = h(EditApplyForm, { action: dialog.action, siteId: pack.site_id,
        onClose: function () { setDialog(null); }, onSubmit: onEditSubmit });
    } else if (dialog && dialog.kind === 'source') {
      dlg = h(SourceDialog, { ref: dialog.ref, sources: sources, onClose: function () { setDialog(null); },
        onSnapshot: function (ref) { setDialog({ kind: 'snapshot', ref: ref }); } });
    } else if (dialog && dialog.kind === 'snapshot') {
      dlg = h(SnapshotDialog, { ref: dialog.ref, packId: pack.id, onClose: function () { setDialog(null); } });
    } else if (dialog && dialog.kind === 'applyall') {
      dlg = h(ApplyAllConfirm, { plan: dialog.plan, onClose: function () { setDialog(null); }, onConfirm: runApplyAll });
    } else if (dialog && dialog.kind === 'new') {
      dlg = h(NewPackForm, { instruction: pack.instruction, siteId: pack.site_id,
        onClose: function () { setDialog(null); },
        onCreated: function (newId) { setDialog(null); navigate('/action-packs?id=' + encodeURIComponent(newId)); } });
    }

    return h('div', null,
      h(PackBody, { pack: pack, highlight: highlight, busy: busy, outcomes: outcomes, notice: notice,
        refreshError: st.refreshError, companyName: companyName, packBusy: packBusy,
        applyAllRunning: !!(applyAll && applyAll.running), applyAllReport: applyAll && applyAll.report,
        onHighlight: setHighlight, onJump: onJump,
        onApply: onApply, onDismiss: onDismiss, onApplyAll: onApplyAll,
        onEdit: function (a) { setDialog({ kind: 'edit', action: a }); },
        onStale: function (a) { setDialog({ kind: 'stale', action: a }); },
        onOpenRef: function (ref) {
          var t = chipTarget(ref, sources);
          setDialog(t.kind === 'snapshot' ? { kind: 'snapshot', ref: ref } : { kind: 'source', ref: ref });
        },
        onSnapshot: function (ref) { setDialog({ kind: 'snapshot', ref: ref }); },
        onCopy: copyText, onCancel: onCancel, onArchive: onArchive, onExport: onExport,
        onRunAgain: function () { setDialog({ kind: 'new' }); } }),
      dlg);
  }

  /* ---- route ---- */

  function useRouteParams() {
    var r = React.useState(function () {
      return (window.FS && window.FS.Router) ? (window.FS.Router.getCurrentRoute().params || {}) : {};
    });
    React.useEffect(function () {
      if (!(window.FS && window.FS.Router)) return undefined;
      return window.FS.Router.subscribe(function (route) { r[1](route.params || {}); });
    }, []);
    return r[0];
  }

  function ActionPacksMiddle() {
    var params = useRouteParams();
    if (params.id) return h(PackDetail, { key: params.id, id: params.id });
    return h('div', null,
      h(PackList, null),
      params['new'] === '1' ? h(NewPackForm, {
        onClose: function () { navigate('/action-packs'); },
        onCreated: function (newId) { navigate('/action-packs?id=' + encodeURIComponent(newId)); } }) : null);
  }

  if (typeof window !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
    window.FieldSight.PAGES['/action-packs'] = { Middle: ActionPacksMiddle, layout: 'full-width' };
  }

  var exported = {
    ListBody: ListBody, PackBody: PackBody, ActionCard: ActionCard, SubTaskList: SubTaskList,
    ConclusionList: ConclusionList, SourceCard: SourceCard, ActionPacksMiddle: ActionPacksMiddle,
    createMessage: createMessage, outcomeText: outcomeText, ApplyAllConfirm: ApplyAllConfirm,
    followUpDelay: followUpDelay,
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
