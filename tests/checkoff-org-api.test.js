'use strict';

/*
 * Unit tests for feat/checkoff-org-api — moving action-item check-off off the
 * UNAUTHENTICATED legacy gateway (`POST /api/actions/toggle`, which takes
 * date/topic_id/action_index/checked straight off the body and writes DynamoDB
 * with zero authorisation) and onto `PATCH /api/org/action-items/{id}`, whose
 * ACL is "admin/gm, THIS site's pm/site_manager, or the assignee only"
 * (404 cross-company, 403 out-of-reach site).
 *
 * The legacy gateway has since been retired from this client (see
 * tests/done-ness-comes-from-the-task.test.js): the PATCH is now the ONLY
 * check-off writer and done-ness is the task's own status.
 *
 * Covers the helpers scripts/api/actions.js exports for this:
 *   orgCheckoffLive()   — the aurora + org-write kill switch
 *   resolveActionItem() — the single writer + always-resolving envelope
 *   isActionResolved()  — done-ness is the status column and nothing else
 * plus tasks.js's isRowDone(), which is that rule applied to a Tasks row.
 *
 * actions.js is a browser IIFE that only registers onto window.FS.api at load,
 * so a minimal window stub is enough to require it under Node (same posture as
 * tests/q1-tasks-page-buckets.test.js loading mine-team.js for real).
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---- harness ------------------------------------------------------------- */

/* Every call the module makes is recorded here so a test can assert on WHICH
   backend was hit, not merely that "something resolved". */
let calls;

function resetEnv(overrides) {
  calls = { org: [], legacy: [], bus: [], toast: [] };
  global.window = {
    FieldSight: { fixtures: { actions: {} } },
    FS: {
      api: Object.assign({
        useMocks:       false,
        writeMocks:     false,
        timelineSource: 'aurora',
        orgBaseUrl:     'https://org.example/prod/api',
        delay:          function () { return Promise.resolve(); },
        /* orgRequest is what updateAction rides. */
        orgRequest:     function (path, opts) {
          calls.org.push({ path: path, method: opts.method, body: opts.body });
          if (orgRejects) return Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
          return Promise.resolve(orgResponse);
        },
        /* request() was the legacy gateway. Nothing may call it any more:
           it is a tripwire — every test that cares asserts calls.legacy is
           empty. */
        request:        function (path, opts) {
          calls.legacy.push({ path: path, body: opts && opts.body });
          return Promise.resolve({});
        },
      }, overrides || {}),
      /* actions.js reads these off window.FS, not off window. */
      actionsBus: { emit: function (p) { calls.bus.push(p); } },
      toast:      { show: function (t) { calls.toast.push(t); } },
    },
  };
  /* Fresh module instance each time — the IIFE binds window at require time. */
  delete require.cache[require.resolve('../scripts/api/actions.js')];
  return require('../scripts/api/actions.js');
}

let orgResponse = null;
let orgRejects = false;

const ITEM = {
  actionItemId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  date:         '2026-03-09',
  topic_id:     2,
  action_index: 1,
  action_text:  'Fix the edge protection',
  user_folder:  'David_Barillaro',
};

/* ---- orgCheckoffLive ----------------------------------------------------- */

test('orgCheckoffLive is true only when aurora + orgBaseUrl + real writes are all on', () => {
  assert.strictEqual(resetEnv().orgCheckoffLive(), true);

  assert.strictEqual(resetEnv({ timelineSource: 'report' }).orgCheckoffLive(), false,
    'report-source timeline has no durable ids to PATCH');
  assert.strictEqual(resetEnv({ orgBaseUrl: '' }).orgCheckoffLive(), false,
    'empty orgBaseUrl is the documented org kill switch');
  assert.strictEqual(resetEnv({ useMocks: true }).orgCheckoffLive(), false);
  assert.strictEqual(resetEnv({ writeMocks: true }).orgCheckoffLive(), false,
    'writeMocks makes updateAction return its MOCK — routing there would report a phantom success');
});

/* ---- resolveActionItem: routing ------------------------------------------ */

test('resolveActionItem checks off through PATCH /org/action-items/{id} with status done', async () => {
  const m = resetEnv();
  orgResponse = { id: ITEM.actionItemId, status: 'done' };

  const env = await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(env.ok, true);
  assert.strictEqual(env.path, 'org');
  assert.strictEqual(calls.legacy.length, 0, 'the unauthenticated gateway must NOT be touched');
  assert.deepStrictEqual(calls.org, [{
    path:   '/action-items/' + ITEM.actionItemId,
    method: 'PATCH',
    body:   { status: 'done' },
  }]);
});

test('an item with no durable id is REFUSED, not routed to some other writer', async () => {
  const m = resetEnv();
  const env = await m.resolveActionItem(Object.assign({}, ITEM, { actionItemId: null, checked: true }));

  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.reason, 'no_id');
  assert.strictEqual(calls.org.length, 0, 'nothing to PATCH');
  assert.strictEqual(calls.legacy.length, 0, 'the legacy toggle is gone');
  assert.strictEqual(calls.bus.length, 0, 'a refusal must not broadcast as server truth');
  assert.ok(env.message, 'the user is told why');
});

test('with the org write unreachable the check-off is refused, not faked and not sent to the gateway', async () => {
  const m = resetEnv({ timelineSource: 'report' });
  const env = await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.reason, 'unavailable');
  assert.strictEqual(calls.org.length, 0);
  assert.strictEqual(calls.legacy.length, 0);
  assert.strictEqual(calls.bus.length, 0);
});

test('mock mode still demos a tick: in-memory merge, no network, bus announces it', async () => {
  const m = resetEnv({ useMocks: true, writeMocks: true });
  const env = await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(env.ok, true);
  assert.strictEqual(calls.org.length, 0);
  assert.strictEqual(calls.legacy.length, 0);
  assert.strictEqual(calls.bus.length, 1);
  assert.strictEqual(calls.bus[0].checked, true);
});

/* ---- resolveActionItem: refusals are never swallowed --------------------- */

test('a 403 from the org write RESOLVES as ok:false and carries the server reason', async () => {
  const m = resetEnv();
  orgResponse = { _accessDenied: true, status: 403,
                  error: "admin/gm, this site's pm/site_manager, or the assignee only" };

  const env = await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.reason, 'denied');
  assert.strictEqual(env.status, 403);
  assert.match(env.message, /assignee only/, 'the server wording must survive, not a generic string');
  assert.strictEqual(calls.bus.length, 0, 'a refused check-off must not broadcast as server truth');
});

test('a 404 from the org write RESOLVES as ok:false / not_found', async () => {
  const m = resetEnv();
  orgResponse = { _notFound: true, status: 404 };

  const env = await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.reason, 'not_found');
  assert.strictEqual(calls.bus.length, 0);
});

test('a thrown 5xx from the org write RESOLVES as ok:false rather than rejecting', async () => {
  const m = resetEnv();
  orgRejects = true;
  try {
    const env = await m.resolveActionItem(Object.assign({ checked: true }, ITEM));
    assert.strictEqual(env.ok, false);
    assert.strictEqual(env.reason, 'error');
    assert.strictEqual(env.status, 500);
    assert.strictEqual(calls.bus.length, 0);
  } finally {
    orgRejects = false;
  }
});

/* ---- resolveActionItem: there is no overlay to write or clear ------------ */

test('unchecking writes status open and touches nothing else', async () => {
  const m = resetEnv();
  orgResponse = { id: ITEM.actionItemId, status: 'open' };

  const env = await m.resolveActionItem(Object.assign({ checked: false }, ITEM));

  assert.strictEqual(env.ok, true);
  assert.deepStrictEqual(calls.org.map(function (c) { return c.body; }), [{ status: 'open' }]);
  assert.strictEqual(calls.legacy.length, 0, 'no overlay to clear any more');
});

test('checking off does not touch the legacy gateway', async () => {
  const m = resetEnv();
  orgResponse = { id: ITEM.actionItemId, status: 'done' };

  await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(calls.legacy.length, 0);
});

/* ---- resolveActionItem: bus broadcast ------------------------------------ */

test('a successful org check-off broadcasts on the actions bus so sibling rows sync', async () => {
  const m = resetEnv();
  /* fix/closed-by-display — the Aurora row carries no checked_by/checked_at
     of its own; updated_by_name/updated_at is what the bus emit must be
     remapped from (see normaliseCheckoff tests below for the mapping
     itself — this test only asserts resolveActionItem's emit wires it through). */
  orgResponse = { id: ITEM.actionItemId, status: 'done',
                  updated_at: '2026-07-24T13:40:00.562587+00:00', updated_by_name: 'Ben_UCPK' };

  await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(calls.bus.length, 1);
  assert.deepStrictEqual(calls.bus[0], {
    date:         ITEM.date,
    topic_id:     ITEM.topic_id,
    action_index: ITEM.action_index,
    checked:      true,
    checked_by:   'Ben_UCPK',
    checked_at:   '2026-07-24T13:40:00.562587+00:00',
    user_folder:  ITEM.user_folder,
  });
});

test('a successful org check-off with a null updated_by_name broadcasts checked_by:null, never the literal string "null"', async () => {
  const m = resetEnv();
  orgResponse = { id: ITEM.actionItemId, status: 'done',
                  updated_at: '2026-07-24T13:40:00.562587+00:00', updated_by_name: null };

  await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(calls.bus[0].checked_by, null);
  assert.strictEqual(calls.bus[0].checked_at, '2026-07-24T13:40:00.562587+00:00');
});

/* ---- normaliseCheckoff: ONE shape for both backends ----------------------
   fix/closed-by-display — the legacy gateway/mock answer in
   { checked_by, checked_at }; the Aurora org PATCH answers in
   { updated_by_name, updated_at } instead. normaliseCheckoff is the single
   place that tells the two shapes apart and remaps both onto
   { checked_by, checked_at } so every downstream consumer (the bus
   payload, eventually the caption) only ever has one shape to read. */

test('normaliseCheckoff maps the legacy gateway shape (checked_by/checked_at) through unchanged', () => {
  const m = resetEnv();
  const who = m.normaliseCheckoff({
    message: 'Updated', checked: true,
    checked_by: 'David_Barillaro', checked_at: '2026-07-20T09:00:00Z',
  });
  assert.deepStrictEqual(who, { checked_by: 'David_Barillaro', checked_at: '2026-07-20T09:00:00Z' });
});

test('normaliseCheckoff maps the Aurora org shape (updated_by_name/updated_at) onto checked_by/checked_at', () => {
  const m = resetEnv();
  const who = m.normaliseCheckoff({
    id: ITEM.actionItemId, status: 'done',
    updated_at: '2026-07-24T13:40:00.562587+00:00', updated_by_name: 'Ben_UCPK',
  });
  assert.deepStrictEqual(who, { checked_by: 'Ben_UCPK', checked_at: '2026-07-24T13:40:00.562587+00:00' });
});

test('normaliseCheckoff renders a null updated_by_name (unprovisioned/nameless account) as checked_by:null, never "null"', () => {
  const m = resetEnv();
  const who = m.normaliseCheckoff({
    id: ITEM.actionItemId, status: 'done',
    updated_at: '2026-07-24T13:40:00.562587+00:00', updated_by_name: null,
  });
  assert.strictEqual(who.checked_by, null);
  assert.notStrictEqual(who.checked_by, 'null');
  assert.strictEqual(who.checked_at, '2026-07-24T13:40:00.562587+00:00');
});

test('normaliseCheckoff tolerates a missing/undefined response without throwing', () => {
  const m = resetEnv();
  assert.deepStrictEqual(m.normaliseCheckoff(null), { checked_by: null, checked_at: null });
  assert.deepStrictEqual(m.normaliseCheckoff(undefined), { checked_by: null, checked_at: null });
  assert.deepStrictEqual(m.normaliseCheckoff({}), { checked_by: null, checked_at: null });
});

/* ---- isActionResolved: the status column and nothing else ---------------- */

test('isActionResolved is true for status done and for nothing else', () => {
  const m = resetEnv();
  assert.strictEqual(m.isActionResolved('done'), true);
  assert.strictEqual(m.isActionResolved('open'), false);
  assert.strictEqual(m.isActionResolved('in_progress'), false,
    'only "done" counts — in_progress/blocked are still open');
  assert.strictEqual(m.isActionResolved('blocked'), false);
});

test('isActionResolved treats a missing column status as not-done (never a crash)', () => {
  const m = resetEnv();
  assert.strictEqual(m.isActionResolved(null), false);
  assert.strictEqual(m.isActionResolved(undefined), false);
  /* A second argument (the old overlay boolean) is ignored, not honoured. */
  assert.strictEqual(m.isActionResolved('open', true), false);
});

/* ---- tasks.js isRowDone: the same rule applied to a Tasks row ------------- */

test('tasks.js isRowDone reads the status column only (an overlay boolean on the row is ignored)', () => {
  resetEnv();
  /* tasks.js needs the same page-level stubs its own bucket test uses. */
  global.window.FS.api.resolveDeadline = function (d) { return { absolute: null, display: d || '—' }; };
  global.window.FS.api.isMineTask = function () { return false; };
  global.React = {
    useState: function (v) { return [v, function () {}]; },
    useContext: function () { return null; },
    useEffect: function () {},
    createContext: function (def) { return { Provider: 'Provider', _def: def }; },
    Fragment: 'Fragment',
  };
  global.document = { addEventListener() {}, removeEventListener() {} };
  delete require.cache[require.resolve('../scripts/pages/tasks.js')];
  const { isRowDone } = require('../scripts/pages/tasks.js');

  assert.strictEqual(isRowDone({ status: 'done', audit: { checked: false } }), true,
    'set Done in the Status editor — used to stay in the Open bucket with a live check-off circle');
  assert.strictEqual(isRowDone({ status: 'open', audit: { checked: true } }), false,
    'a tick the task itself does not carry is not a tick');
  assert.strictEqual(isRowDone({ status: 'open', audit: { checked: false } }), false);
  assert.strictEqual(isRowDone(null), false);
  assert.strictEqual(isRowDone({ status: null }), false, 'a row with no audit slice must not throw');
});
