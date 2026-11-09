/* ==========================================================================
   FieldSight API · action packs -- the background action agent's packs.
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-11-10-action-pack-page-design.md (§4, §7.1).
   Org-api routes (fieldsight-pipeline src/lambda_org_api.py:734-1330), all 404
   while ACTION_PACKS is off (and for everyone but platform_admin while it is
   internal):

     GET  /action-packs?state=&site_id=&archived=     -> { packs: [...] }
     GET  /action-packs/{id}                          -> the pack
     POST /action-packs            {instruction, site_id}       -> 202 {id, state}
     POST /action-packs/{id}/cancel                   {}
     POST /action-packs/{id}/archive                  {archived}
     POST /action-packs/{id}/actions/{aid}/dismiss    {}
     POST /action-packs/{id}/actions/{aid}/apply      {} | {fields}
     GET  /action-packs/{id}/export?format=md
     GET  /action-packs/{id}/sources/{ref}/snapshot

   Rules this module enforces:
   - It is the body whitelist: every write is built from named fields only
     (memory "api layer whitelists the request body").
   - Every write passes retry:false. A write is never repeated behind the
     person's back; after anything but a clean answer the page re-reads the
     pack, and that read is the truth. Poll GETs pass retry:false too.
   - Every write RETURNS an outcome object and never throws. orgRequest
     resolves a 403/404 (and any non-JSON answer) as an envelope instead of
     throwing, so the envelope is checked before anything is read as a 200.

   Gate: org LIVE (!useMocks && orgBaseUrl), like decisions.js -- deliberately
   not orgWrite(): with orgWrites=false an apply would land in the mock and the
   person would believe it happened. Not live: a small in-memory set of packs
   answers, so the page renders with no backend.

   window.FS.api.actionPacks.{list,get,create,cancel,archive,dismiss,apply,
     exportMd,snapshot} + pure helpers for tests.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};

  var api = window.FS.api;

  /* src/action_pack_view.py:355-359 */
  var APPLY_EDIT_FIELDS = {
    close_item: ['status'],
    update_item: ['deadline', 'responsible', 'priority', 'status'],
    create_item: ['text', 'responsible', 'deadline', 'priority'],
  };

  function orgLive() { return !api.useMocks && !!api.orgBaseUrl; }
  function enc(v) { return encodeURIComponent(String(v === null || v === undefined ? '' : v)); }
  function packPath(id) { return '/action-packs/' + enc(id); }
  function actionPath(id, aid, verb) { return packPath(id) + '/actions/' + enc(aid) + '/' + verb; }
  function isObj(v) { return !!v && typeof v === 'object'; }

  /* {} or {fields}: only the keys this action type may edit survive. */
  function applyBody(type, fields) {
    var allowed = APPLY_EDIT_FIELDS[type] || [];
    var out = {};
    var n = 0;
    if (isObj(fields)) {
      allowed.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) { out[k] = fields[k]; n++; }
      });
    }
    return n ? { fields: out } : {};
  }

  /* ---- outcome mapping (pure) ---------------------------------------------- */

  function envelopeOutcome(res) {
    if (!isObj(res)) return null;
    if (res._accessDenied) {
      return { kind: 'refused', status: res.status || 403, message: res.error || 'Access denied.' };
    }
    if (res._notFound) {
      if (res.status === 404) {
        return { kind: 'refused', status: 404, message: (res.raw && res.raw.error) || null };
      }
      return { kind: 'unknown', status: res.status };
    }
    return null;
  }

  function errBody(err) { return err && isObj(err.body) ? err.body : null; }
  function is4xx(status) { return typeof status === 'number' && status >= 400 && status < 500; }

  function applyOutcome(r) {
    r = r || {};
    if (r.err) {
      var err = r.err;
      var body = errBody(err);
      if (body && body.state === 'stale') {
        return { kind: 'stale', live: body.live || null, snapshot: body.snapshot || null };
      }
      if (err.status === 500) return { kind: 'failed', message: body && body.error };
      if (is4xx(err.status) && body) {
        return { kind: 'refused', status: err.status, message: body.error || ('HTTP ' + err.status),
                 code: body.code };
      }
      return { kind: 'unknown', status: err.status };
    }
    var env = envelopeOutcome(r.res);
    if (env) return env;
    if (!isObj(r.res)) return { kind: 'unknown' };
    var result = isObj(r.res.applied_result) ? r.res.applied_result : null;
    if (result && result.noop) return { kind: 'noop', result: result };
    return { kind: 'applied', result: result };
  }

  function writeOutcome(verb, r) {
    r = r || {};
    if (r.err) {
      var err = r.err;
      var body = errBody(err);
      if (verb === 'dismiss' && err.status === 409 && body && body.state === 'dismissed') {
        return { kind: 'ok' };
      }
      if (verb === 'cancel' && err.status === 409 && body && body.state) {
        return { kind: 'finished', state: body.state };
      }
      if (is4xx(err.status)) {
        return { kind: 'refused', status: err.status, message: (body && body.error) || ('HTTP ' + err.status) };
      }
      return { kind: 'unknown', status: err.status };
    }
    var env = envelopeOutcome(r.res);
    if (env) return env;
    return { kind: 'ok', res: r.res };
  }

  var IN_PROGRESS = 'you already have a pack in progress';
  var NOT_STARTED = 'the pack could not be started';

  function createOutcome(r) {
    r = r || {};
    if (r.err) {
      var err = r.err;
      var body = errBody(err);
      var msg = body && typeof body.error === 'string' ? body.error : null;
      /* The backend's own 503 first: with retry:false a single 503 still
         reads as "waking" to _fetch.js, so the body decides, not the flag. */
      if (err.status === 503 && msg === NOT_STARTED) return { kind: 'not_started' };
      if (err.status === 409 && msg === IN_PROGRESS) {
        return { kind: 'refused', status: 409, code: 'in_progress', message: msg };
      }
      if (err.status === 409 && msg === 'company_inactive') {
        return { kind: 'refused', status: 409, code: 'company_inactive', message: msg };
      }
      if (is4xx(err.status) && body) {
        return { kind: 'refused', status: err.status, message: msg || ('HTTP ' + err.status) };
      }
      return { kind: 'unknown', status: err.status, waking: !!err.waking };
    }
    var env = envelopeOutcome(r.res);
    if (env) return env;
    if (isObj(r.res) && r.res.id) return { kind: 'created', id: String(r.res.id) };
    return { kind: 'unknown' };
  }

  async function settle(promise) {
    try { return { res: await promise }; } catch (err) { return { err: err }; }
  }

  /* ---- mock (useMocks / no org base URL) ---------------------------------- */

  var MOCK = null;
  var mockSeq = 0;

  function mockPacks() {
    if (MOCK) return MOCK;
    var site = { id: '6f1c2a8e-3b7d-4c55-9a51-1f0e2b7c9d10', name: '12 Harbour St' };
    function detail(reason, code) {
      return { model: 'google/gemini-3.8-flash', attempt: 1, reason_code: code || null, reason: reason || null };
    }
    var ready = {
      id: 'mock-pack-ready', site_id: site.id, site_name: site.name,
      title: 'Level 3 pour follow-up',
      instruction: 'Close anything only waiting on the L3 pour record, set a deadline for the cure log, and draft an RFI for the curing period.',
      reading: 'Review the Level 3 slab pour on 10 Oct 2026: close items it settles, give the cure-log item a deadline, and draft an RFI about the curing period.',
      state: 'ready', failure: null,
      created_at: '2026-11-09 21:14:07.512331+00:00', updated_at: '2026-11-09 21:17:55.881002+00:00',
      as_of: '2026-11-09 21:16:41.003120+00:00', archived: false, archived_at: null, is_creator: true,
      conclusion: [
        { text: 'The pour record confirms the Level 3 slab was poured and tested on 10 Oct.',
          refs: ['R2', 'D1'], confidence: 'supported', verifier_detail: detail(null) },
        { text: 'No curing standard was found in the project library.',
          refs: [], confidence: 'uncertain', verifier_detail: null },
        { text: 'A curing guide recommends seven days of moist curing.',
          refs: ['W1'], confidence: 'uncertain',
          verifier_detail: detail('Web source only, not your project\'s documents.', 'web_only') },
      ],
      sub_tasks: [
        { id: 's1', ask: 'Close items only waiting on the L3 pour record', kind: 'close', status: 'done',
          actions: [1, 2], conclusion: [0], reason_code: null, reason: null },
        { id: 's2', ask: 'Set a deadline for the cure log', kind: 'update', status: 'partly',
          actions: [3], conclusion: [], reason_code: 'no_evidence',
          reason: 'No record states a date; the deadline was assumed from the date raised.' },
        { id: 's3', ask: 'Draft an RFI for the curing period', kind: 'draft', status: 'done',
          actions: [5], conclusion: [1], reason_code: null, reason: null },
        { id: 's4', ask: 'Tell the engineer', kind: 'other', status: 'not_done',
          actions: [], conclusion: [], reason_code: 'not_answered', reason: null },
      ],
      actions: [
        { id: 'mock-a1', seq: 1, type: 'close_item', verifier: 'supported', state: 'proposed',
          refs: ['R2', 'R5'], rationale: 'The pour record shows the cylinders were taken, which this item asked for.',
          proposed: { status: 'done' }, target_stable_id: 'mock-item-69', target_task_no: 69,
          target_snapshot: { status: 'open', deadline: '2026-10-12', responsible: 'Sam Patel', priority: 'high',
                             text: 'Take test cylinders at the L3 pour', updated_at: '2026-10-09T21:03:11+00:00' },
          applicable: true, applicable_reason: null, applied_at: null, applied_result: null,
          created_item_stable_id: null, verifier_detail: detail(null) },
        { id: 'mock-a2', seq: 2, type: 'update_item', verifier: 'supported', state: 'proposed',
          refs: ['R2'], rationale: 'The same item: the pour is done, so its priority can drop.',
          proposed: { priority: 'low' }, target_stable_id: 'mock-item-69', target_task_no: 69,
          target_snapshot: { status: 'open', deadline: '2026-10-12', responsible: 'Sam Patel', priority: 'high',
                             text: 'Take test cylinders at the L3 pour', updated_at: '2026-10-09T21:03:11+00:00' },
          applicable: true, applicable_reason: null, applied_at: null, applied_result: null,
          created_item_stable_id: null, verifier_detail: detail(null) },
        { id: 'mock-a3', seq: 3, type: 'update_item', verifier: 'weak', state: 'proposed',
          refs: ['R7'], rationale: 'The engineer asked for the cure log; the item has no deadline.',
          proposed: { deadline: '2026-10-20' }, target_stable_id: 'mock-item-71', target_task_no: 71,
          target_snapshot: { status: 'open', deadline: null, responsible: 'Ana Lee', priority: 'medium',
                             text: 'Send the L3 cure log to the engineer', updated_at: '2026-10-20T01:00:00+00:00' },
          applicable: true, applicable_reason: null, applied_at: null, applied_result: null,
          created_item_stable_id: null, verifier_detail: detail('Deadline assumed: date raised.', 'date_assumed') },
        { id: 'mock-a4', seq: 4, type: 'close_item', verifier: 'unsupported', state: 'proposed',
          refs: ['R7'], rationale: 'UNSUPPORTED MOCK RATIONALE (must never render)',
          proposed: { status: 'done' }, target_stable_id: 'mock-item-72', target_task_no: 72,
          target_snapshot: { status: 'open', text: 'Unsupported target' },
          applicable: false, applicable_reason: null, applied_at: null, applied_result: null,
          created_item_stable_id: null, verifier_detail: detail(null, 'not_checked') },
        { id: 'mock-a5', seq: 5, type: 'draft_rfi', verifier: 'supported', state: 'proposed',
          refs: ['R7', 'D1'], rationale: 'The engineer\'s question about the curing period is still open.',
          proposed: { subject: 'L3 slab curing period', body: 'Please confirm the required curing period for the L3 slab.\n\nRegards' },
          target_stable_id: null, target_task_no: null, target_snapshot: null,
          applicable: false, applicable_reason: null, applied_at: null, applied_result: null,
          created_item_stable_id: null, verifier_detail: detail(null) },
        { id: 'mock-a6', seq: 6, type: 'update_item', verifier: 'supported', state: 'stale',
          refs: ['R2'], rationale: 'The pour record names Sam as responsible for the cylinders.',
          proposed: { responsible: 'Sam Patel' }, target_stable_id: 'mock-item-70', target_task_no: 70,
          target_snapshot: { status: 'open', deadline: null, responsible: 'Ana Lee', priority: 'medium',
                             text: 'Book the cylinder lab', updated_at: '2026-10-09T21:03:11+00:00' },
          applicable: false, applicable_reason: null, applied_at: null,
          applied_result: { reason: 'changed' }, created_item_stable_id: null, verifier_detail: detail(null) },
      ],
      sources: [
        { ref: 'D1', kind: 'document', provenance: 'documents', removed: false, document_id: 'mock-doc-1',
          revision: 3, page_from: 12, page_to: 12, title: 'Specification · 4.3 Curing', date: null,
          site_id: site.id, excerpt: 'Concrete shall be cured for not less than 7 days.' },
        { ref: 'R2', kind: 'topic', provenance: 'records', removed: false, topic_id: 'mock-topic-2',
          title: 'L3 slab pour', date: '2026-10-10', who: 'Sam Patel', site_id: site.id,
          excerpt: 'Pour finished at two, cylinders taken, slump was fine.' },
        { ref: 'R5', kind: 'item', provenance: 'records', removed: true },
        { ref: 'R7', kind: 'topic', provenance: 'records', removed: false, topic_id: 'mock-topic-7',
          title: 'Engineer site visit', date: '2026-10-14', who: 'Ana Lee', site_id: site.id,
          excerpt: 'Engineer wants the cure log before stripping the props.' },
        { ref: 'W1', kind: 'web_source', provenance: 'web', removed: false, url: 'https://example.org/curing-guide',
          title: 'Curing concrete', fetched_at: '2026-11-09 21:16:02+00:00',
          snapshot_s3_key: 'action_packs/c/mock-pack-ready/web/W1.txt', excerpt: 'Moist curing for seven days…' },
      ],
      run_trace: { rounds: 2, tokens: 81234, token_cap: 400000, refs_gathered: 41, refs_cited: 5, ms: { total: 104233 } },
      models: { planner: 'deepseek/deepseek-v4.1-flash', writer: 'deepseek/deepseek-v4.1-flash',
                verifier: 'google/gemini-3.8-flash' },
    };
    var running = {
      id: 'mock-pack-running', site_id: site.id, site_name: site.name, title: null,
      instruction: 'Tidy the open items on this site.', reading: null, state: 'running', failure: null,
      created_at: '2026-11-10 01:02:03.000000+00:00', updated_at: '2026-11-10 01:02:03.000000+00:00',
      as_of: null, archived: false, archived_at: null, is_creator: true,
      conclusion: [], sub_tasks: null, actions: [], sources: [], run_trace: null, models: null,
      _polls: 0,
    };
    MOCK = { site: site, packs: [running, ready] };
    return MOCK;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function strip(p) { var c = clone(p); delete c._polls; return c; }

  function mockRow(p) {
    var counts = { proposed: 0, applied: 0, dismissed: 0, stale: 0, failed: 0 };
    (p.actions || []).forEach(function (a) { if (a.state in counts) counts[a.state]++; });
    return { id: p.id, title: p.title, instruction: p.instruction, state: p.state, failure: p.failure,
             site_id: p.site_id, site_name: p.site_name, created_at: p.created_at,
             archived: !!p.archived, action_counts: counts };
  }

  function mockFind(id) {
    return mockPacks().packs.filter(function (p) { return p.id === id; })[0] || null;
  }

  async function mockDelay() { if (api.delay) await api.delay(); }

  /* ---- routes -------------------------------------------------------------- */

  async function list(opts) {
    opts = opts || {};
    var params = {};
    if (opts.state) params.state = opts.state;
    if (opts.siteId) params.site_id = opts.siteId;
    if (opts.archived === 'true' || opts.archived === true) params.archived = 'true';
    else if (opts.archived === 'all') params.archived = 'all';
    if (orgLive()) {
      var o = { params: params };
      if (opts.poll) o.retry = false;
      return api.orgRequest('/action-packs', o);
    }
    await mockDelay();
    var wantArchived = params.archived === 'true' ? true : (params.archived === 'all' ? null : false);
    return { packs: mockPacks().packs.filter(function (p) {
      return (!params.state || p.state === params.state)
        && (wantArchived === null || !!p.archived === wantArchived);
    }).map(mockRow) };
  }

  async function get(id, opts) {
    opts = opts || {};
    if (orgLive()) {
      return api.orgRequest(packPath(id), opts.poll ? { retry: false } : undefined);
    }
    await mockDelay();
    var p = mockFind(id);
    if (!p) return { _notFound: true, status: 404, raw: { error: 'not found' } };
    if (p.state === 'queued' || p.state === 'running') {
      p._polls = (p._polls || 0) + 1;
      if (p._polls >= 2 && !p.reading) {
        p.state = 'running';
        p.reading = 'Tidy the open items: close what the records show is done.';
        p.title = 'Tidy open items';
      }
      if (p._polls >= 4) {
        p.state = 'ready';
        p.as_of = p.updated_at;
        p.conclusion = [{ text: 'Nothing on this site is waiting only on a record.', refs: [],
                          confidence: 'uncertain', verifier_detail: null }];
        p.sub_tasks = [{ id: 's1', ask: 'Close what the records show is done', kind: 'close',
                         status: 'not_done', actions: [], conclusion: [0],
                         reason_code: 'no_evidence', reason: null }];
      }
    }
    return strip(p);
  }

  async function create(input) {
    input = input || {};
    var body = { instruction: String(input.instruction === undefined || input.instruction === null ? '' : input.instruction),
                 site_id: input.siteId === undefined ? null : input.siteId };
    if (orgLive()) {
      return createOutcome(await settle(api.orgRequest('/action-packs', { method: 'POST', body: body, retry: false })));
    }
    await mockDelay();
    var m = mockPacks();
    var active = m.packs.filter(function (p) { return p.state === 'queued' || p.state === 'running'; })[0];
    if (active) {
      return createOutcome({ err: Object.assign(new Error(IN_PROGRESS), { status: 409, body: { error: IN_PROGRESS } }) });
    }
    mockSeq += 1;
    var p = { id: 'mock-pack-new-' + mockSeq, site_id: body.site_id || m.site.id, site_name: m.site.name,
              title: null, instruction: body.instruction.trim(), reading: null, state: 'queued', failure: null,
              created_at: new Date().toISOString(), updated_at: new Date().toISOString(), as_of: null,
              archived: false, archived_at: null, is_creator: true, conclusion: [], sub_tasks: null,
              actions: [], sources: [], run_trace: null, models: null, _polls: 0 };
    m.packs.unshift(p);
    return createOutcome({ res: { id: p.id, state: 'queued' } });
  }

  async function cancel(id) {
    if (orgLive()) {
      return writeOutcome('cancel', await settle(api.orgRequest(packPath(id) + '/cancel',
        { method: 'POST', body: {}, retry: false })));
    }
    await mockDelay();
    var p = mockFind(id);
    if (!p) return writeOutcome('cancel', { res: { _notFound: true, status: 404, raw: { error: 'not found' } } });
    if (p.state !== 'queued' && p.state !== 'running') {
      return writeOutcome('cancel', { err: Object.assign(new Error('pack is already finished'),
        { status: 409, body: { error: 'pack is already finished', state: p.state } }) });
    }
    p.state = 'cancelled';
    return writeOutcome('cancel', { res: { id: id, state: 'cancelled' } });
  }

  async function archive(id, archived) {
    var body = { archived: !!archived };
    if (orgLive()) {
      return writeOutcome('archive', await settle(api.orgRequest(packPath(id) + '/archive',
        { method: 'POST', body: body, retry: false })));
    }
    await mockDelay();
    var p = mockFind(id);
    if (!p) return writeOutcome('archive', { res: { _notFound: true, status: 404, raw: { error: 'not found' } } });
    p.archived = body.archived;
    p.archived_at = body.archived ? new Date().toISOString() : null;
    (p.actions || []).forEach(function (a) { if (body.archived) a.applicable = false; });
    return writeOutcome('archive', { res: { id: id, archived: body.archived } });
  }

  function mockAction(id, aid) {
    var p = mockFind(id);
    var a = p && (p.actions || []).filter(function (x) { return x.id === aid; })[0];
    return { p: p, a: a || null };
  }

  async function dismiss(id, aid) {
    if (orgLive()) {
      return writeOutcome('dismiss', await settle(api.orgRequest(actionPath(id, aid, 'dismiss'),
        { method: 'POST', body: {}, retry: false })));
    }
    await mockDelay();
    var m = mockAction(id, aid);
    if (!m.a || m.a.verifier === 'unsupported') {
      return writeOutcome('dismiss', { res: { _notFound: true, status: 404, raw: { error: 'action not found' } } });
    }
    if (m.a.state === 'applied' || m.a.state === 'dismissed') {
      return writeOutcome('dismiss', { err: Object.assign(new Error('action is ' + m.a.state),
        { status: 409, body: { error: 'action is ' + m.a.state, state: m.a.state } }) });
    }
    m.a.state = 'dismissed';
    m.a.applicable = false;
    return writeOutcome('dismiss', { res: { id: aid, state: 'dismissed' } });
  }

  async function apply(id, aid, type, fields) {
    var body = applyBody(type, fields);
    if (orgLive()) {
      return applyOutcome(await settle(api.orgRequest(actionPath(id, aid, 'apply'),
        { method: 'POST', body: body, retry: false })));
    }
    await mockDelay();
    var m = mockAction(id, aid);
    if (!m.a) return applyOutcome({ res: { _notFound: true, status: 404, raw: { error: 'action not found' } } });
    if (m.a.state === 'applied') return applyOutcome({ res: { id: aid, state: 'applied', applied_result: m.a.applied_result } });
    if (m.a.state === 'stale') {
      return applyOutcome({ err: Object.assign(new Error('action is stale'), { status: 409, body: {
        error: 'action is stale', state: 'stale',
        live: Object.assign({}, m.a.target_snapshot, { responsible: 'Chris Wong', updated_at: '2026-11-08T22:40:12+00:00' }),
        snapshot: m.a.target_snapshot } }) });
    }
    if (!m.a.applicable && m.a.applicable_reason !== 'responsible_not_member') {
      return applyOutcome({ err: Object.assign(new Error('refused'), { status: 409, body: { error: 'this action cannot be applied' } }) });
    }
    /* A second action on a target an earlier apply already changed goes stale. */
    var touched = (m.p.actions || []).some(function (x) {
      return x !== m.a && x.state === 'applied' && x.target_stable_id && x.target_stable_id === m.a.target_stable_id;
    });
    if (touched) {
      m.a.state = 'stale';
      m.a.applicable = false;
      m.a.applied_result = { reason: 'changed' };
      return applyOutcome({ err: Object.assign(new Error('action is stale'), { status: 409, body: {
        error: 'action is stale', state: 'stale', live: m.a.target_snapshot, snapshot: m.a.target_snapshot } }) });
    }
    var result = m.a.type === 'create_item'
      ? { action_item_id: 'mock-new-item', task_no: 88, content_edit_ids: ['mock-edit'] }
      : { action_item_id: 'mock-item-id', content_edit_ids: ['mock-edit'] };
    m.a.state = 'applied';
    m.a.applicable = false;
    m.a.applied_at = new Date().toISOString();
    m.a.applied_result = result;
    return applyOutcome({ res: { id: aid, state: 'applied', applied_result: result } });
  }

  async function exportMd(id) {
    if (orgLive()) return api.orgRequest(packPath(id) + '/export', { params: { format: 'md' } });
    await mockDelay();
    var p = mockFind(id);
    if (!p) return { _notFound: true, status: 404 };
    return { format: 'md', filename: 'action-pack-' + id + '.md', content_type: 'text/markdown',
             content: '# ' + (p.title || p.instruction) + '\n\n' + (p.reading || '') + '\n' };
  }

  async function snapshot(id, ref) {
    if (orgLive()) return api.orgRequest(packPath(id) + '/sources/' + enc(ref) + '/snapshot');
    await mockDelay();
    var p = mockFind(id);
    var s = p && (p.sources || []).filter(function (x) { return x.ref === ref; })[0];
    if (!s || !s.snapshot_s3_key) return { _notFound: true, status: 404, raw: { error: 'not found' } };
    return { ref: ref, url: s.url, fetched_at: s.fetched_at, truncated: false,
             text: 'Curing concrete\n\nKeep the surface moist for seven days. <b>not bold</b>' };
  }

  window.FS.api.actionPacks = {
    APPLY_EDIT_FIELDS: APPLY_EDIT_FIELDS,
    list: list, get: get, create: create, cancel: cancel, archive: archive,
    dismiss: dismiss, apply: apply, exportMd: exportMd, snapshot: snapshot,
    applyBody: applyBody, envelopeOutcome: envelopeOutcome,
    applyOutcome: applyOutcome, writeOutcome: writeOutcome, createOutcome: createOutcome,
    _resetMocks: function () { MOCK = null; mockSeq = 0; },
  };
})();
