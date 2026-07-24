'use strict';

/*
 * Unit tests for feat/checkoff-org-api — moving action-item check-off off the
 * UNAUTHENTICATED legacy gateway (`POST /api/actions/toggle`, which takes
 * date/topic_id/action_index/checked straight off the body and writes DynamoDB
 * with zero authorisation) and onto `PATCH /api/org/action-items/{id}`, whose
 * ACL is "admin/gm, THIS site's pm/site_manager, or the assignee only"
 * (404 cross-company, 403 out-of-reach site).
 *
 * Covers the two helpers scripts/api/actions.js exports for this:
 *   orgCheckoffLive()   — the aurora + org-write kill switch
 *   resolveActionItem() — the routing + always-resolving envelope
 *   isActionResolved()  — the read-time UNION of the two done-ness stores
 * plus tasks.js's isRowDone(), which is that union applied to a Tasks row.
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
          return Promise.resolve(orgResponse);
        },
        /* request() is what toggleAction rides (the legacy gateway). */
        request:        function (path, opts) {
          calls.legacy.push({ path: path, body: opts.body });
          if (legacyRejects) return Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
          return Promise.resolve({ message: 'Updated', checked: opts.body.checked });
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
let legacyRejects = false;

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

test('resolveActionItem falls back to the legacy toggle when the item has no durable id', async () => {
  const m = resetEnv();
  const env = await m.resolveActionItem(Object.assign({}, ITEM, { actionItemId: null, checked: true }));

  assert.strictEqual(env.ok, true);
  assert.strictEqual(env.path, 'legacy');
  assert.strictEqual(calls.org.length, 0);
  assert.strictEqual(calls.legacy.length, 1);
  assert.strictEqual(calls.legacy[0].path, '/actions/toggle');
  assert.strictEqual(calls.legacy[0].body.user_folder, 'David_Barillaro',
    'user_folder is the report OWNER folder, never the caller');
});

test('resolveActionItem falls back to the legacy toggle when the aurora gate is off', async () => {
  const m = resetEnv({ timelineSource: 'report' });
  const env = await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(env.path, 'legacy');
  assert.strictEqual(calls.org.length, 0);
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

test('a thrown 5xx on the legacy leg RESOLVES as ok:false rather than rejecting', async () => {
  const m = resetEnv();
  legacyRejects = true;
  try {
    const env = await m.resolveActionItem(
      Object.assign({}, ITEM, { actionItemId: null, checked: true }));
    assert.strictEqual(env.ok, false);
    assert.strictEqual(env.reason, 'error');
    assert.strictEqual(env.status, 500);
  } finally {
    legacyRejects = false;
  }
});

/* ---- resolveActionItem: uncheck clears the legacy overlay too ------------- */

test('unchecking writes status open AND clears the legacy DynamoDB overlay', async () => {
  const m = resetEnv();
  orgResponse = { id: ITEM.actionItemId, status: 'open' };

  const env = await m.resolveActionItem(Object.assign({ checked: false }, ITEM));

  assert.strictEqual(env.ok, true);
  assert.deepStrictEqual(calls.org[0].body, { status: 'open' });
  assert.strictEqual(calls.legacy.length, 1,
    'without this the overlay still reads checked:true and the item re-checks itself on reload');
  assert.strictEqual(calls.legacy[0].body.checked, false);
});

test('checking off does NOT write the legacy overlay (the whole point of the move)', async () => {
  const m = resetEnv();
  orgResponse = { id: ITEM.actionItemId, status: 'done' };

  await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(calls.legacy.length, 0);
});

test('an overlay-clear failure does not turn a successful uncheck into a failure', async () => {
  const m = resetEnv();
  orgResponse = { id: ITEM.actionItemId, status: 'open' };
  legacyRejects = true;
  try {
    const env = await m.resolveActionItem(Object.assign({ checked: false }, ITEM));
    assert.strictEqual(env.ok, true, 'the authoritative write already succeeded');
  } finally {
    legacyRejects = false;
  }
});

/* ---- resolveActionItem: bus broadcast ------------------------------------ */

test('a successful org check-off broadcasts on the actions bus so sibling rows sync', async () => {
  const m = resetEnv();
  orgResponse = { id: ITEM.actionItemId, status: 'done' };

  await m.resolveActionItem(Object.assign({ checked: true }, ITEM));

  assert.strictEqual(calls.bus.length, 1);
  assert.deepStrictEqual(calls.bus[0], {
    date:         ITEM.date,
    topic_id:     ITEM.topic_id,
    action_index: ITEM.action_index,
    checked:      true,
    checked_by:   null,   /* the Aurora row carries no checked_by/checked_at */
    checked_at:   null,
    user_folder:  ITEM.user_folder,
  });
});

/* ---- isActionResolved: the read-time union ------------------------------- */

test('isActionResolved is the UNION of the Aurora column and the legacy overlay', () => {
  const m = resetEnv();
  assert.strictEqual(m.isActionResolved('done', false), true,  'column alone (checked off post-migration)');
  assert.strictEqual(m.isActionResolved('open', true),  true,  'overlay alone — the ~119 pre-existing prod check-offs');
  assert.strictEqual(m.isActionResolved('done', true),  true);
  assert.strictEqual(m.isActionResolved('open', false), false);
});

test('isActionResolved treats a missing column status as not-done (never a crash)', () => {
  const m = resetEnv();
  assert.strictEqual(m.isActionResolved(null, false), false);
  assert.strictEqual(m.isActionResolved(undefined, undefined), false);
  assert.strictEqual(m.isActionResolved(null, true), true);
  assert.strictEqual(m.isActionResolved('in_progress', false), false,
    'only "done" counts — in_progress/blocked are still open');
});

/* ---- tasks.js isRowDone: the same union applied to a Tasks row ------------ */

test('tasks.js isRowDone unions the column and the overlay (the two used to contradict)', () => {
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
  assert.strictEqual(isRowDone({ status: 'open', audit: { checked: true } }), true,
    'pre-existing DynamoDB check-off — must NOT regress to Open when writes move to Aurora');
  assert.strictEqual(isRowDone({ status: 'open', audit: { checked: false } }), false);
  assert.strictEqual(isRowDone(null), false);
  assert.strictEqual(isRowDone({ status: null }), false, 'a row with no audit slice must not throw');
});
