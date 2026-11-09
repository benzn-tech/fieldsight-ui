'use strict';

/*
 * Action packs API module (spec docs/superpowers/specs/2026-11-10-action-pack-page-design.md
 * §7.1, §5.3).
 *
 * - The api layer is the body whitelist: every write is built from named fields only.
 * - Every write passes retry:false (a write is never repeated behind the person's back).
 * - orgRequest RESOLVES 403/404 (and any non-JSON answer) as envelopes; every outcome
 *   helper checks them before it reads a 200.
 * - A thrown 409 is stale only when body.state says so; a backend 503 that says "the pack
 *   could not be started" is not the same as a gateway that is waking up.
 */
const test = require('node:test');
const assert = require('node:assert');

function loadApi(apiOverrides) {
  global.window = { FS_ENV: {} };
  delete require.cache[require.resolve('../scripts/api/index.js')];
  require('../scripts/api/index.js');
  Object.assign(global.window.FS.api, { delay: async () => {} }, apiOverrides || {});
  delete require.cache[require.resolve('../scripts/api/action-packs.js')];
  require('../scripts/api/action-packs.js');
  return global.window.FS.api;
}

function liveApi(answer) {
  const calls = [];
  const api = loadApi({
    useMocks: false,
    orgBaseUrl: 'https://example.test/prod/api',
    orgRequest: async (p, opts) => {
      calls.push([p, opts || {}]);
      if (typeof answer === 'function') return answer(p, opts || {});
      return answer === undefined ? {} : answer;
    },
  });
  return { ap: api.actionPacks, calls };
}

function thrown(status, body, extra) {
  const e = new Error((body && body.error) || ('HTTP ' + status));
  e.status = status;
  e.body = body;
  return Object.assign(e, extra || {});
}

/* ---- Task 1: requests and body whitelist --------------------------------- */

test('create sends exactly {instruction, site_id} with retry:false', async () => {
  const { ap, calls } = liveApi({ id: 'p1', state: 'queued' });
  await ap.create({ instruction: 'Close #4', siteId: 's1', site_id: 'evil', state: 'ready', extra: 1 });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], '/action-packs');
  assert.strictEqual(calls[0][1].method, 'POST');
  assert.deepStrictEqual(calls[0][1].body, { instruction: 'Close #4', site_id: 's1' });
  assert.strictEqual(calls[0][1].retry, false);
});

test('cancel, archive, dismiss and apply pass retry:false', async () => {
  const { ap, calls } = liveApi({});
  await ap.cancel('p1');
  await ap.archive('p1', true);
  await ap.dismiss('p1', 'a1');
  await ap.apply('p1', 'a1', 'close_item');
  assert.strictEqual(calls.length, 4);
  calls.forEach(([p, o]) => {
    assert.strictEqual(o.method, 'POST', p);
    assert.strictEqual(o.retry, false, p + ' must not be retried');
  });
  assert.deepStrictEqual(calls.map((c) => c[0]), [
    '/action-packs/p1/cancel', '/action-packs/p1/archive',
    '/action-packs/p1/actions/a1/dismiss', '/action-packs/p1/actions/a1/apply']);
});

test('archive sends {archived: boolean}', async () => {
  const { ap, calls } = liveApi({});
  await ap.archive('p', 1);
  await ap.archive('p', 0);
  assert.deepStrictEqual(calls[0][1].body, { archived: true });
  assert.deepStrictEqual(calls[1][1].body, { archived: false });
});

test('dismiss and cancel send {}', async () => {
  const { ap, calls } = liveApi({});
  await ap.dismiss('p', 'a');
  await ap.cancel('p');
  assert.deepStrictEqual(calls[0][1].body, {});
  assert.deepStrictEqual(calls[1][1].body, {});
});

test('apply keeps only the editable fields of its type', async () => {
  const { ap, calls } = liveApi({ id: 'a', state: 'applied', applied_result: {} });
  await ap.apply('p', 'a', 'close_item', { status: 'closed', text: 'x', deadline: '2026-11-11' });
  await ap.apply('p', 'a', 'update_item', { deadline: null, text: 'nope', priority: 'high' });
  await ap.apply('p', 'a', 'create_item', { text: 'New', site_id: 's9' });
  await ap.apply('p', 'a', 'update_item');
  await ap.apply('p', 'a', 'update_item', {});
  await ap.apply('p', 'a', 'draft_rfi', { subject: 'x' });
  assert.deepStrictEqual(calls[0][1].body, { fields: { status: 'closed' } });
  assert.deepStrictEqual(calls[1][1].body, { fields: { deadline: null, priority: 'high' } });
  assert.deepStrictEqual(calls[2][1].body, { fields: { text: 'New' } });
  assert.deepStrictEqual(calls[3][1].body, {});
  assert.deepStrictEqual(calls[4][1].body, {});
  assert.deepStrictEqual(calls[5][1].body, {});
});

test('ids and refs are URL-encoded', async () => {
  const { ap, calls } = liveApi({});
  await ap.get('a/b');
  await ap.snapshot('p?x', 'W1/..');
  await ap.dismiss('p#', 'a b');
  assert.strictEqual(calls[0][0], '/action-packs/a%2Fb');
  assert.strictEqual(calls[1][0], '/action-packs/p%3Fx/sources/W1%2F../snapshot');
  assert.strictEqual(calls[2][0], '/action-packs/p%23/actions/a%20b/dismiss');
});

test('poll GETs pass retry:false, plain GETs do not', async () => {
  const { ap, calls } = liveApi({ packs: [] });
  await ap.get('p1', { poll: true });
  await ap.get('p1');
  await ap.list({ poll: true });
  await ap.list({ state: 'running', siteId: 's1', archived: 'true' });
  assert.strictEqual(calls[0][1].retry, false);
  assert.notStrictEqual(calls[1][1].retry, false);
  assert.strictEqual(calls[2][1].retry, false);
  assert.notStrictEqual(calls[3][1].retry, false);
  assert.deepStrictEqual(calls[3][1].params, { state: 'running', site_id: 's1', archived: 'true' });
  assert.deepStrictEqual(calls[2][1].params, {}, 'null params are skipped');
});

test('export asks for markdown', async () => {
  const { ap, calls } = liveApi({ format: 'md', content: '# x' });
  await ap.exportMd('p1');
  assert.strictEqual(calls[0][0], '/action-packs/p1/export');
  assert.deepStrictEqual(calls[0][1].params, { format: 'md' });
});

/* ---- Task 2: outcome mapping ------------------------------------------------ */

const WRITES = [
  ['apply', (ap) => ap.apply('p', 'a', 'close_item')],
  ['dismiss', (ap) => ap.dismiss('p', 'a')],
  ['cancel', (ap) => ap.cancel('p')],
  ['archive', (ap) => ap.archive('p', true)],
  ['create', (ap) => ap.create({ instruction: 'x', siteId: 's' })],
];

test('a 403 envelope is refused with its error, for every write', async () => {
  for (const [name, call] of WRITES) {
    const { ap } = liveApi({ _accessDenied: true, status: 403, error: 'admin/gm only' });
    const out = await call(ap);
    assert.strictEqual(out.kind, 'refused', name);
    assert.strictEqual(out.status, 403, name);
    assert.strictEqual(out.message, 'admin/gm only', name);
  }
});

test('a 404 envelope is refused with raw.error, for every write', async () => {
  for (const [name, call] of WRITES) {
    const { ap } = liveApi({ _notFound: true, status: 404, raw: { error: 'action not found' } });
    const out = await call(ap);
    assert.strictEqual(out.kind, 'refused', name);
    assert.strictEqual(out.status, 404, name);
    assert.strictEqual(out.message, 'action not found', name);
  }
});

test('a non-404 _notFound is unknown, for every write', async () => {
  for (const [name, call] of WRITES) {
    const { ap } = liveApi({ _notFound: true, status: 502 });
    const out = await call(ap);
    assert.strictEqual(out.kind, 'unknown', name);
    assert.strictEqual(out.status, 502, name);
  }
});

test('apply: 200 is applied, noop is noop', async () => {
  let ap = liveApi({ id: 'a', state: 'applied', applied_result: { action_item_id: 'i1' } }).ap;
  let out = await ap.apply('p', 'a', 'close_item');
  assert.strictEqual(out.kind, 'applied');
  assert.deepStrictEqual(out.result, { action_item_id: 'i1' });
  ap = liveApi({ id: 'a', state: 'applied', applied_result: { noop: true, action_item_id: 'i1' } }).ap;
  out = await ap.apply('p', 'a', 'close_item');
  assert.strictEqual(out.kind, 'noop');
});

test('apply: a thrown body.state stale is stale with live and snapshot, whatever the status', async () => {
  const live = { status: 'in_progress' };
  const snapshot = { status: 'open' };
  for (const status of [409, 400]) {
    const { ap } = liveApi(() => { throw thrown(status, { error: 'action is stale', state: 'stale', live, snapshot }); });
    const out = await ap.apply('p', 'a', 'close_item');
    assert.strictEqual(out.kind, 'stale');
    assert.deepStrictEqual(out.live, live);
    assert.deepStrictEqual(out.snapshot, snapshot);
  }
  const { ap } = liveApi(() => { throw thrown(409, { error: 'action is stale', state: 'stale', live: null, snapshot: null }); });
  const out = await ap.apply('p', 'a', 'close_item');
  assert.strictEqual(out.kind, 'stale');
  assert.strictEqual(out.live, null);
});

test('apply: 500 is failed; another 4xx is refused; 502/504/no body/timeout is unknown', async () => {
  let ap = liveApi(() => { throw thrown(500, { error: 'apply failed', code: 'internal' }); }).ap;
  assert.strictEqual((await ap.apply('p', 'a', 'close_item')).kind, 'failed');
  ap = liveApi(() => { throw thrown(409, { error: 'pack is archived' }); }).ap;
  let out = await ap.apply('p', 'a', 'close_item');
  assert.strictEqual(out.kind, 'refused');
  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.message, 'pack is archived');
  ap = liveApi(() => { throw thrown(400, { error: 'assignee must be a member of this site' }); }).ap;
  assert.strictEqual((await ap.apply('p', 'a', 'update_item', { responsible: 'X' })).kind, 'refused');
  for (const err of [thrown(502, null, { waking: true }), thrown(504, { message: 'Endpoint request timed out' }, { waking: true }),
    Object.assign(new Error('timeout'), { timeout: true, waking: true }), new TypeError('Failed to fetch')]) {
    ap = liveApi(() => { throw err; }).ap;
    out = await ap.apply('p', 'a', 'close_item');
    assert.strictEqual(out.kind, 'unknown', String(err.message));
  }
});

test('dismiss: a 409 with state dismissed is ok', async () => {
  let ap = liveApi(() => { throw thrown(409, { error: 'action is dismissed', state: 'dismissed' }); }).ap;
  assert.strictEqual((await ap.dismiss('p', 'a')).kind, 'ok');
  ap = liveApi(() => { throw thrown(409, { error: 'action is applied', state: 'applied' }); }).ap;
  const out = await ap.dismiss('p', 'a');
  assert.strictEqual(out.kind, 'refused');
  assert.strictEqual(out.message, 'action is applied');
  ap = liveApi({ id: 'a', state: 'dismissed' }).ap;
  assert.strictEqual((await ap.dismiss('p', 'a')).kind, 'ok');
});

test('cancel: a 409 with a state is finished', async () => {
  let ap = liveApi(() => { throw thrown(409, { error: 'pack is already finished', state: 'ready' }); }).ap;
  const out = await ap.cancel('p');
  assert.strictEqual(out.kind, 'finished');
  assert.strictEqual(out.state, 'ready');
  ap = liveApi(() => { throw thrown(403, { error: 'only the creator or a company admin can cancel this pack' }); }).ap;
  assert.strictEqual((await ap.cancel('p')).kind, 'refused');
  ap = liveApi(() => { throw thrown(504, null, { waking: true }); }).ap;
  assert.strictEqual((await ap.cancel('p')).kind, 'unknown');
});

test('create: 202 is created', async () => {
  const { ap } = liveApi({ id: 'p9', state: 'queued' });
  const out = await ap.create({ instruction: 'x', siteId: 's' });
  assert.deepStrictEqual(out, { kind: 'created', id: 'p9' });
});

test('create: 409 in-progress and company_inactive carry their codes', async () => {
  let ap = liveApi(() => { throw thrown(409, { error: 'you already have a pack in progress' }); }).ap;
  let out = await ap.create({ instruction: 'x', siteId: 's' });
  assert.strictEqual(out.kind, 'refused');
  assert.strictEqual(out.code, 'in_progress');
  ap = liveApi(() => { throw thrown(409, { error: 'company_inactive' }); }).ap;
  out = await ap.create({ instruction: 'x', siteId: 's' });
  assert.strictEqual(out.code, 'company_inactive');
  ap = liveApi(() => { throw thrown(400, { error: 'instruction is required' }); }).ap;
  out = await ap.create({ instruction: '', siteId: 's' });
  assert.strictEqual(out.kind, 'refused');
  assert.strictEqual(out.message, 'instruction is required');
});

test('create: 503 "the pack could not be started" is not_started; a waking 503 or a 503 without that body is unknown', async () => {
  let ap = liveApi(() => { throw thrown(503, { error: 'the pack could not be started' }, { waking: true }); }).ap;
  assert.strictEqual((await ap.create({ instruction: 'x', siteId: 's' })).kind, 'not_started');
  ap = liveApi(() => { throw thrown(503, { message: 'Service Unavailable' }, { waking: true }); }).ap;
  assert.strictEqual((await ap.create({ instruction: 'x', siteId: 's' })).kind, 'unknown');
  ap = liveApi(() => { throw thrown(503, null); }).ap;
  assert.strictEqual((await ap.create({ instruction: 'x', siteId: 's' })).kind, 'unknown');
  ap = liveApi(() => { throw Object.assign(new Error('timeout'), { timeout: true, waking: true }); }).ap;
  assert.strictEqual((await ap.create({ instruction: 'x', siteId: 's' })).kind, 'unknown');
});

test('mocks answer when not live, with no orgRequest call', async () => {
  let hit = 0;
  const api = loadApi({ useMocks: true, orgRequest: async () => { hit++; return {}; } });
  const ap = api.actionPacks;
  const list = await ap.list({});
  assert.ok(Array.isArray(list.packs) && list.packs.length >= 2);
  const ready = list.packs.find((p) => p.state === 'ready');
  const pack = await ap.get(ready.id);
  assert.ok(Array.isArray(pack.sub_tasks) && pack.sub_tasks.length >= 2);
  assert.ok(pack.actions.some((a) => a.verifier === 'unsupported'), 'an unsupported action proves the filter');
  assert.ok(pack.actions.some((a) => a.verifier === 'weak' && a.verifier_detail && a.verifier_detail.reason));
  assert.ok(pack.actions.some((a) => a.state === 'stale'));
  const sameTarget = pack.actions.filter((a) => a.verifier === 'supported' && a.applicable && a.target_stable_id);
  const ids = sameTarget.map((a) => a.target_stable_id);
  assert.ok(ids.some((t, i) => ids.indexOf(t) !== i), 'two supported, applicable actions share a target');
  const target = pack.actions.find((a) => a.applicable);
  const out = await ap.apply(pack.id, target.id, target.type);
  assert.ok(out.kind === 'applied' || out.kind === 'noop');
  const again = await ap.get(pack.id);
  assert.strictEqual(again.actions.find((a) => a.id === target.id).state, 'applied');
  assert.strictEqual((await ap.dismiss(pack.id, pack.actions.find((a) => a.state === 'stale').id)).kind, 'ok');
  assert.strictEqual(hit, 0);
});
