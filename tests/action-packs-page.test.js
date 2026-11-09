'use strict';

/*
 * Action pack page: pure view helpers (spec 2026-11-10-action-pack-page-design.md §5-§7).
 *
 * - An action with verifier "unsupported" is never rendered, counted, planned or linked,
 *   whatever its reason_code (backend spec 2026-11-05 §7.2).
 * - sub_tasks[].listed is not part of the contract; reason_code is.
 * - verifier_detail may be null or absent (== null).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

function loadPage() {
  global.window = global.window || {};
  global.window.FieldSight = global.window.FieldSight || {};
  delete require.cache[require.resolve('../scripts/pages/action-packs.js')];
  return require('../scripts/pages/action-packs.js');
}

const P = loadPage();

const A = (o) => Object.assign({ id: 'a' + o.seq, type: 'close_item', verifier: 'supported', state: 'proposed',
  refs: [], applicable: false, target_stable_id: null, proposed: {}, target_snapshot: null }, o);

/* ---- visible actions, groups, counts --------------------------------------- */

test('unsupported actions are dropped whatever their reason_code', () => {
  const acts = [
    A({ seq: 1 }),
    A({ seq: 2, verifier: 'unsupported', verifier_detail: { reason_code: 'not_checked' }, applicable: true }),
    A({ seq: 3, verifier: 'unsupported', verifier_detail: { reason_code: 'contradicted' } }),
    A({ seq: 4, verifier: 'unsupported', verifier_detail: null }),
    A({ seq: 5, verifier: 'weak', applicable: true }),
    A({ seq: 6, verifier: 'not_checked' }),
  ];
  const vis = P.visibleActions(acts);
  assert.deepStrictEqual(vis.map((a) => a.seq), [1, 5]);
  const counts = P.actionCounts(vis);
  assert.strictEqual(counts.reduce((s, c) => s + c.n, 0), 2);
  const plan = P.applyAllPlan(P.visibleActions(acts.map((a) => Object.assign({}, a, { applicable: true }))));
  assert.ok(plan.run.every((a) => a.verifier === 'supported'));
  assert.ok(!plan.run.some((a) => [2, 3, 4, 6].includes(a.seq)));
  assert.deepStrictEqual(P.visibleActions(null), []);
});

test('actions group by state: proposed/failed review, stale, applied/dismissed done, unknown done; seq order', () => {
  const g = P.actionGroups([
    A({ seq: 5, state: 'applied' }), A({ seq: 2, state: 'failed' }), A({ seq: 4, state: 'stale' }),
    A({ seq: 1, state: 'proposed' }), A({ seq: 3, state: 'dismissed' }), A({ seq: 6, state: 'weird' }),
  ]);
  assert.deepStrictEqual(g.review.map((a) => a.seq), [1, 2]);
  assert.deepStrictEqual(g.stale.map((a) => a.seq), [4]);
  assert.deepStrictEqual(g.done.map((a) => a.seq), [3, 5, 6]);
  const counts = P.actionCounts([A({ seq: 1 }), A({ seq: 2 }), A({ seq: 3, state: 'applied' })]);
  assert.deepStrictEqual(counts.map((c) => c.text), ['2 to review', '1 applied'], 'zero counts are left out');
});

/* ---- badges ----------------------------------------------------------------- */

test('action badge: supported none; weak with reason; weak with null and missing detail gives reason null', () => {
  assert.strictEqual(P.actionBadge(A({ seq: 1 })), null);
  assert.deepStrictEqual(P.actionBadge(A({ seq: 1, verifier: 'weak', verifier_detail: { reason_code: 'date_assumed', reason: 'Deadline assumed: date raised.' } })),
    { text: 'Uncertain', reason: 'Deadline assumed: date raised.' });
  assert.deepStrictEqual(P.actionBadge(A({ seq: 1, verifier: 'weak', verifier_detail: null })), { text: 'Uncertain', reason: null });
  const noDetail = A({ seq: 1, verifier: 'weak' });
  delete noDetail.verifier_detail;
  assert.deepStrictEqual(P.actionBadge(noDetail), { text: 'Uncertain', reason: null });
  assert.deepStrictEqual(P.actionBadge(A({ seq: 1, verifier: 'weak', verifier_detail: { reason: '   ' } })), { text: 'Uncertain', reason: null });
});

test('conclusion badge: uncertain with reason, null reason, no detail; supported none', () => {
  assert.strictEqual(P.conclusionBadge({ confidence: 'supported', verifier_detail: { reason: 'x' } }), null);
  assert.deepStrictEqual(P.conclusionBadge({ confidence: 'uncertain', verifier_detail: { reason: 'Web source only.' } }),
    { text: 'Uncertain', reason: 'Web source only.' });
  assert.deepStrictEqual(P.conclusionBadge({ confidence: 'uncertain', verifier_detail: { reason: null } }), { text: 'Uncertain', reason: null });
  assert.deepStrictEqual(P.conclusionBadge({ confidence: 'uncertain' }), { text: 'Uncertain', reason: null });
});

/* ---- sub-tasks -------------------------------------------------------------- */

test('reason line follows the spec table', () => {
  const s = (o) => Object.assign({ status: 'not_done', reason: null, reason_code: null }, o);
  assert.deepStrictEqual(P.reasonLine(s({ reason: 'Skipped it.', reason_code: 'not_answered' })),
    { main: 'Skipped it.', muted: 'The agent did not answer this part' });
  assert.deepStrictEqual(P.reasonLine(s({ reason: 'Checks removed it.', reason_code: 'dropped_by_checks' })),
    { main: 'Checks removed it.', muted: 'What the agent proposed was removed by checks' });
  assert.deepStrictEqual(P.reasonLine(s({ reason: 'No record says so.', reason_code: 'no_evidence' })),
    { main: 'No record says so.', muted: null });
  assert.deepStrictEqual(P.reasonLine(s({ reason: '  ', reason_code: 'not_answered' })),
    { main: 'The agent did not answer this part', muted: null }, 'whitespace counts as empty');
  assert.deepStrictEqual(P.reasonLine(s({ reason_code: 'already_done' })), { main: 'Already done', muted: null });
  assert.strictEqual(P.reasonLine(s({ reason_code: 'other' })), null);
  assert.strictEqual(P.reasonLine(s({ reason_code: 'something_new' })), null);
  assert.deepStrictEqual(P.reasonLine(s({ status: 'partly', reason_code: 'ambiguous_target' })),
    { main: 'More than one item could be meant', muted: null });
  assert.strictEqual(P.reasonLine(s({ status: 'done', reason: 'x', reason_code: 'no_evidence' })), null, 'done rows have no reason line');
});

test('sub-task view maps conclusion indexes to 1-based findings and ignores unknown or unsupported seqs', () => {
  const v = P.subTaskView({ id: 's1', ask: 'Close #4', kind: 'close', status: 'done',
    actions: [1, 4, 9], conclusion: [0, 2, 7, -1, 'x'], reason_code: null, reason: null, listed: false },
  3, [1, 2, 3]);
  assert.deepStrictEqual(v.findings, [1, 3]);
  assert.deepStrictEqual(v.actionSeqs, [1]);
  assert.strictEqual(v.statusText, 'Done');
  assert.strictEqual(v.reason, null);
  assert.strictEqual(P.subTaskView({ status: 'not_done', actions: null, conclusion: null }, 0, new Set()).actionSeqs.length, 0);
  const src = read('scripts', 'pages', 'action-packs.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.listed\b|\['listed'\]/.test(src), 'listed is not part of the contract');
});

/* ---- sources and chips ------------------------------------------------------ */

const SOURCES = [
  { ref: 'R10', provenance: 'records', kind: 'topic', removed: false, title: 'ten' },
  { ref: 'R2', provenance: 'records', kind: 'topic', removed: false, title: 'two' },
  { ref: 'R5', provenance: 'records', kind: 'item', removed: true },
  { ref: 'D1', provenance: 'documents', kind: 'document', removed: false },
  { ref: 'W1', provenance: 'web', kind: 'web_source', removed: false, snapshot_s3_key: 'k', url: 'https://x.test' },
  { ref: 'W2', provenance: 'web', kind: 'web_source', removed: false, snapshot_s3_key: null, url: 'https://y.test' },
  { ref: 'W3', provenance: 'web', kind: 'web_answer', removed: false, excerpt: 'e' },
];

test('chips look sources up by ref, not order', () => {
  assert.strictEqual(P.chipTarget('R2', SOURCES).source.title, 'two');
  assert.strictEqual(P.chipTarget('R10', SOURCES).source.title, 'ten');
  assert.strictEqual(P.chipTarget('R5', SOURCES).kind, 'removed');
  assert.strictEqual(P.chipTarget('R99', SOURCES).kind, 'removed');
  assert.strictEqual(P.chipTarget('R2', SOURCES).kind, 'records');
  assert.strictEqual(P.chipTarget('D1', SOURCES).kind, 'documents');
  assert.strictEqual(P.chipTarget('W1', SOURCES).kind, 'snapshot');
  assert.strictEqual(P.chipTarget('W2', SOURCES).kind, 'web_link');
  assert.strictEqual(P.chipTarget('W3', SOURCES).kind, 'web_answer');
  assert.strictEqual(P.chipTarget('R2', null).kind, 'removed');
});

test('web-only only when every ref is web; no refs is false', () => {
  assert.strictEqual(P.isWebOnly(['W1', 'W3'], SOURCES), true);
  assert.strictEqual(P.isWebOnly(['W1', 'R2'], SOURCES), false);
  assert.strictEqual(P.isWebOnly([], SOURCES), false);
  assert.strictEqual(P.isWebOnly(['W9'], SOURCES), false);
});

/* ---- apply-all -------------------------------------------------------------- */

test('apply-all plan', () => {
  const plan = P.applyAllPlan([
    A({ seq: 4, applicable: true, target_stable_id: 't1' }),
    A({ seq: 1, applicable: true, target_stable_id: 't1', type: 'update_item' }),
    A({ seq: 2, applicable: true, type: 'create_item' }),
    A({ seq: 3, applicable: true, type: 'create_item' }),
    A({ seq: 5, applicable: false, target_stable_id: 't2' }),
    A({ seq: 6, verifier: 'weak', applicable: true, target_stable_id: 't3' }),
    A({ seq: 7, verifier: 'weak', applicable: false }),
    A({ seq: 8, applicable: 'yes', target_stable_id: 't4' }),
  ]);
  assert.deepStrictEqual(plan.run.map((a) => a.seq), [1, 2, 3]);
  assert.deepStrictEqual(plan.skipped.map((s) => s.action.seq), [4]);
  assert.strictEqual(plan.skipped[0].text, 'Another action changes this task');
  assert.strictEqual(plan.weakCount, 1);
});

/* ---- edit and apply --------------------------------------------------------- */

test('edit fields', () => {
  const create = A({ seq: 1, type: 'create_item', proposed: { text: 'Send cure log', responsible: 'Sam', deadline: '2026-11-04' } });
  const ef = P.editFields(create);
  assert.deepStrictEqual(ef.fields, ['text', 'responsible', 'deadline', 'priority']);
  assert.deepStrictEqual(ef.values, { text: 'Send cure log', responsible: 'Sam', deadline: '2026-11-04', priority: '' });
  assert.deepStrictEqual(P.editDiff(create, ef.values), {}, 'nothing changed -> {}');
  assert.deepStrictEqual(P.editDiff(create, Object.assign({}, ef.values, { responsible: 'Ana' })), { responsible: 'Ana' });

  const update = A({ seq: 2, type: 'update_item', proposed: { deadline: '2026-11-20' },
    target_snapshot: { status: 'open', deadline: '2026-11-01', responsible: 'Sam', priority: 'high' } });
  const uf = P.editFields(update);
  assert.deepStrictEqual(uf.values, { deadline: '2026-11-20', responsible: 'Sam', priority: 'high', status: 'open' });
  assert.deepStrictEqual(P.editDiff(update, uf.values), {}, 'unchanged snapshot values are not sent');
  assert.deepStrictEqual(P.editDiff(update, Object.assign({}, uf.values, { deadline: '' })), { deadline: null },
    'a cleared deadline is null');
  assert.deepStrictEqual(P.editDiff(update, Object.assign({}, uf.values, { priority: 'low' })), { priority: 'low' });

  const close = A({ seq: 3, type: 'close_item', proposed: {} });
  assert.deepStrictEqual(P.editFields(close).values, { status: 'done' });
  assert.deepStrictEqual(P.editDiff(close, { status: 'closed' }), { status: 'closed' });
});

/* ---- copy ------------------------------------------------------------------- */

test('failure text: company_inactive has its own copy; others name the code', () => {
  assert.match(P.failureText('company_inactive'), /suspended or has left FieldSight/);
  assert.strictEqual(P.failureText('budget'), 'The run could not finish (budget). Try again.');
  assert.strictEqual(P.failureText(null), 'The run could not finish. Try again.');
});

test('created text never says #null', () => {
  assert.strictEqual(P.createdText({ task_no: 88 }), 'Created #88');
  assert.strictEqual(P.createdText({ task_no: null }), 'Created');
  assert.strictEqual(P.createdText(null), 'Created');
});

test('stale reasons map to text', () => {
  assert.match(P.staleReasonText('changed'), /changed this task/);
  assert.strictEqual(P.staleReasonText('target_gone'), 'The task no longer exists.');
  assert.strictEqual(P.staleReasonText('target_moved'), 'The task moved to another project.');
  assert.strictEqual(P.staleReasonText('x'), null);
});

test('envelope state: 404 not switched on vs Could not load (HTTP n)', () => {
  assert.deepStrictEqual(P.envelopeState({ _notFound: true, status: 404 }, 'list'),
    { kind: 'off', text: 'Action packs are not switched on in this environment.' });
  assert.deepStrictEqual(P.envelopeState({ _notFound: true, status: 404 }, 'detail'),
    { kind: 'gone', text: 'This pack does not exist or you cannot see it.' });
  assert.deepStrictEqual(P.envelopeState({ _notFound: true, status: 502 }, 'list'),
    { kind: 'error', text: 'Could not load (HTTP 502).' });
  assert.deepStrictEqual(P.envelopeState({ _accessDenied: true, status: 403, error: 'nope' }, 'list'),
    { kind: 'denied', text: 'nope' });
  assert.strictEqual(P.envelopeState({ packs: [] }, 'list'), null);
});

test('safeHref allows only http and https', () => {
  assert.strictEqual(P.safeHref('https://a.test/x'), 'https://a.test/x');
  assert.strictEqual(P.safeHref('http://a.test'), 'http://a.test');
  assert.strictEqual(P.safeHref('javascript:alert(1)'), null);
  assert.strictEqual(P.safeHref(' data:text/html,x'), null);
  assert.strictEqual(P.safeHref(null), null);
});
