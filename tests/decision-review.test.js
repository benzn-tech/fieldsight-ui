'use strict';

/*
 * Site decision loop, P0 shadow review (backend plan 2026-11-08 Task 8).
 * A platform admin labels each card needed / not needed / wrong evidence.
 *
 * - The label POST body is built from exactly `label` and `note` (the api
 *   layer is the whitelist).
 * - The route is platform_admin only: a company admin (isAdmin=true) passes
 *   every permission check, so the role itself decides.
 * - precision null (nothing labelled needed/not needed yet) reads "—".
 * - orgRequest RESOLVES 404/403 as envelopes: 404 = the flag is off here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const flush = () => new Promise((r) => setImmediate(r));

function loadApi(apiOverrides) {
  global.window = { FS_ENV: {} };
  delete require.cache[require.resolve('../scripts/api/index.js')];
  require('../scripts/api/index.js');
  Object.assign(global.window.FS.api, { delay: async () => {} }, apiOverrides || {});
  delete require.cache[require.resolve('../scripts/api/decisions.js')];
  require('../scripts/api/decisions.js');
  return global.window.FS.api;
}

function liveApi() {
  const calls = [];
  const api = loadApi({
    useMocks: false,
    orgBaseUrl: 'https://example.test/prod/api',
    orgRequest: async (p, opts) => { calls.push([p, opts]); return { card_id: 'c1', shadow_label: 'needed' }; },
  });
  return { api, calls };
}

function loadPage() {
  global.window.FieldSight = global.window.FieldSight || {};
  delete require.cache[require.resolve('../scripts/pages/decision-review.js')];
  return require('../scripts/pages/decision-review.js');
}

/* ---- api ------------------------------------------------------------------ */

test('the label body carries exactly label and note; extra keys are dropped', async () => {
  const { api, calls } = liveApi();
  await api.decisions.label('c1', { label: 'needed', note: 'real gap', status: 'done',
    shadow_label: 'not_needed', labelled_by: 'x' });
  await api.decisions.label('c/2', 'wrong_evidence', 'quote is from another day', { extra: 1 });
  await api.decisions.label('c3', 'not_needed');
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0][0], '/decision-shadow/c1/label');
  assert.strictEqual(calls[0][1].method, 'POST');
  assert.deepStrictEqual(calls[0][1].body, { label: 'needed', note: 'real gap' });
  assert.deepStrictEqual(Object.keys(calls[0][1].body), ['label', 'note']);
  assert.strictEqual(calls[1][0], '/decision-shadow/c%2F2/label', 'the card id is URL-encoded');
  assert.deepStrictEqual(calls[1][1].body, { label: 'wrong_evidence', note: 'quote is from another day' });
  assert.deepStrictEqual(calls[2][1].body, { label: 'not_needed', note: '' });
});

test('an unknown label is refused before any request', async () => {
  const { api, calls } = liveApi();
  await assert.rejects(api.decisions.label('c1', 'maybe', ''), /Unknown label/);
  assert.strictEqual(calls.length, 0);
});

test('the list asks GET /decision-shadow; "all" sends no label', async () => {
  const { api, calls } = liveApi();
  await api.decisions.listShadow({ label: '', limit: 50, offset: 0 });
  await api.decisions.listShadow({ label: 'needed', limit: 50, offset: 50 });
  assert.strictEqual(calls[0][0], '/decision-shadow');
  assert.deepStrictEqual(calls[0][1], { params: { limit: 50, offset: 0 } });
  assert.deepStrictEqual(calls[1][1], { params: { label: 'needed', limit: 50, offset: 50 } });
  assert.strictEqual(calls[0][1].method, undefined, 'a read is a GET');
});

test('mock mode answers without the org API and a label sticks', async () => {
  let hit = 0;
  const api = loadApi({ useMocks: true, orgRequest: async () => { hit++; return {}; } });
  const res = await api.decisions.listShadow({ limit: 50, offset: 0 });
  assert.ok(res.cards.length >= 1);
  assert.ok('precision' in res.summary);
  const card = await api.decisions.label(res.cards[0].card_id, 'not_needed', 'noise');
  assert.strictEqual(card.shadow_label, 'not_needed');
  assert.strictEqual(hit, 0);
});

/* ---- role gate ------------------------------------------------------------- */

test('only the platform admin sees the decision review route', () => {
  global.window = global.window || {};
  delete require.cache[require.resolve('../scripts/fs-globals.js')];
  require('../scripts/fs-globals.js');
  const FS = global.window.FS;
  assert.strictEqual(FS.NAV_ITEMS.decisionReview.path, '/decision-review');
  assert.strictEqual(FS.canSeeNav('decisionReview', { role: 'platform_admin', isAdmin: true }), true);
  assert.strictEqual(FS.canSeeNav('decisionReview', { role: 'admin', isAdmin: true }), false,
    'a company admin passes every permission -- the role decides');
  assert.strictEqual(FS.canSeeNav('decisionReview', { role: 'gm' }), false);
  assert.strictEqual(FS.canSeeNav('decisionReview', { role: 'project_manager' }), false);
  assert.strictEqual(FS.canSeeNav('decisionReview', 'platform_admin'), false, 'a bare role string is not a session');
  const visible = FS.getVisibleNavItems({ role: 'admin', isAdmin: true }).map((i) => i.key);
  assert.ok(!visible.includes('decisionReview'));
});

test('the page and its api are loaded, in the nav, with an icon', () => {
  const html = read('app-shell-preview.html');
  const idx = html.indexOf('scripts/api/index.js');
  const dec = html.indexOf('scripts/api/decisions.js');
  assert.ok(idx > 0 && dec > idx, 'decisions.js must load after api/index.js (which replaces FS.api)');
  assert.match(html, /<script type="text\/babel" src="scripts\/pages\/decision-review\.js\?v=\d+"><\/script>/);
  const nav = read('scripts', 'left-nav.js');
  assert.match(nav, /items: \['sites', 'team', 'trace', 'decisionReview'\]/);
  assert.match(nav, /decisionReview: 'list-checks'/);
  global.window.FieldSight = {};
  loadPage();
  assert.ok(global.window.FieldSight.PAGES['/decision-review'].Middle);
});

/* ---- pure rendering helpers ------------------------------------------------ */

test('precision renders "—" when null, a percent otherwise', () => {
  global.window = { FS: { api: {} } };
  const page = loadPage();
  assert.strictEqual(page.precisionText(null), '—');
  assert.strictEqual(page.precisionText(undefined), '—');
  assert.strictEqual(page.precisionText(0.6667), '67%');
  assert.strictEqual(page.precisionText(0), '0%');
  const parts = Object.fromEntries(page.summaryParts({ labelled: 0, needed: 0, not_needed: 0,
    wrong_evidence: 0, precision: null, cards_per_recipient_day_p95: null }));
  assert.strictEqual(parts.Precision, '—');
  assert.strictEqual(parts['Cards per recipient per day (p95)'], '—');
  assert.strictEqual(parts.Labelled, '0');
  assert.strictEqual(page.p95Text(3.5), '3.5');
});

test('a card with missing fields reads as blanks; the recommended option is marked', () => {
  global.window = { FS: { api: {} } };
  const page = loadPage();
  const blank = page.cardView({});
  assert.strictEqual(blank.company, '');
  assert.strictEqual(blank.question, '');
  assert.deepStrictEqual(blank.options, []);
  assert.deepStrictEqual(blank.evidence, []);
  assert.deepStrictEqual(blank.recipients, []);
  assert.strictEqual(blank.label, '');
  const v = page.cardView({
    card_id: 'c1', company_name: 'Acme', site_name: 'Block B', rule_id: 'checklist.gap',
    options: [{ id: 'remind', label: 'Remind Tom', recommended: true },
              { id: 'accept', label: 'Accept with reason', reason_required: true }],
    evidence: [{ quote: 'cover looks thin', at: '2026-11-07T01:00:00Z' }, { quote: '' }],
    recipients: [{ user_id: 'u1', role: 'pm' }, { user_id: 'u2', role: 'platform_admin' }],
    shadow_label: 'bogus',
  });
  assert.deepStrictEqual(v.options.map((o) => o.recommended), [true, false]);
  assert.strictEqual(v.options[1].reasonRequired, true);
  assert.deepStrictEqual(v.evidence.map((e) => e.quote), ['cover looks thin']);
  assert.deepStrictEqual(v.recipients, ['u1 (Project manager)', 'u2 (FieldSight ops)']);
  assert.strictEqual(v.label, '', 'an unknown label is not shown as one');
});

test('created date is New Zealand time through the shared formatter', () => {
  loadApi({});
  const page = loadPage();
  assert.strictEqual(page.cardView({ created_at: '2026-10-21T21:30:00Z' }).created, '22 Oct 2026, 10:30');
});

test('404 says the loop is off here; 403 says platform admins only', () => {
  global.window = { FS: { api: {} } };
  const page = loadPage();
  assert.strictEqual(page.envelopeMessage({ _notFound: true, status: 404 }),
    'The decision loop is off on this environment.');
  assert.strictEqual(page.envelopeMessage({ _accessDenied: true, status: 403, error: 'platform_admin role required' }),
    'Platform admins only.');
  assert.strictEqual(page.envelopeMessage({ cards: [] }), null);
});

test('a new label moves the counts and precision follows', () => {
  global.window = { FS: { api: {} } };
  const page = loadPage();
  const s0 = { labelled: 2, needed: 1, not_needed: 1, wrong_evidence: 0, precision: 0.5,
               cards_per_recipient_day_p95: 2 };
  const s1 = page.applyLabelToSummary(s0, null, 'needed');
  assert.deepStrictEqual([s1.labelled, s1.needed, s1.not_needed], [3, 2, 1]);
  assert.ok(Math.abs(s1.precision - 2 / 3) < 1e-9);
  const s2 = page.applyLabelToSummary(s1, 'needed', 'wrong_evidence');
  assert.deepStrictEqual([s2.labelled, s2.needed, s2.wrong_evidence], [3, 1, 1]);
  assert.strictEqual(s2.cards_per_recipient_day_p95, 2);
  const s3 = page.applyLabelToSummary({ labelled: 1, needed: 0, not_needed: 1, wrong_evidence: 0, precision: 0 },
    'not_needed', 'wrong_evidence');
  assert.strictEqual(s3.precision, null, 'no needed/not needed left -> null -> "—"');
});

test('the page renders no model or user text as HTML', () => {
  const src = read('scripts', 'pages', 'decision-review.js');
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
});

/* ---- the page itself, on a tiny hook runtime ------------------------------- */

function mountPage(decisions) {
  const st = { states: [], effects: [] };
  let si = 0, ei = 0;
  global.React = {
    createElement(type, props, ...kids) { return { type, props: props || {}, kids }; },
    useState(init) {
      const i = si++;
      if (!(i in st.states)) st.states[i] = typeof init === 'function' ? init() : init;
      return [st.states[i], (v) => { st.states[i] = typeof v === 'function' ? v(st.states[i]) : v; }];
    },
    useEffect(fn, deps) { const i = ei++; st.effects[i] = { fn, deps }; },
  };
  global.window = { FS: { api: { decisions } } };
  const page = loadPage();
  const render = () => { si = 0; ei = 0; return page.DecisionReviewMiddle(); };
  const text = (tree) => {
    const out = [];
    (function walk(n) {
      if (n === null || n === undefined || n === false) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (typeof n !== 'object') { out.push(String(n)); return; }
      if (typeof n.type === 'function') return; /* child components are not expanded */
      walk(n.kids);
    })(tree);
    return out.join(' ');
  };
  return { st, render, text };
}

test('with the flag off the page says so instead of an empty list', async () => {
  const m = mountPage({ listShadow: async () => ({ _notFound: true, status: 404 }) });
  m.render();
  m.st.effects[0].fn();
  await flush();
  assert.match(m.text(m.render()), /The decision loop is off on this environment\./);
});

test('a 403 reads "Platform admins only."', async () => {
  const m = mountPage({ listShadow: async () => ({ _accessDenied: true, status: 403, error: 'x' }) });
  m.render();
  m.st.effects[0].fn();
  await flush();
  assert.match(m.text(m.render()), /Platform admins only\./);
});

test('after a label the row shows it and the summary moves, with no second list call', async () => {
  let lists = 0;
  const card = { card_id: 'c1', question: 'Q?', shadow_label: null };
  const m = mountPage({
    listShadow: async () => { lists++; return { cards: [card], summary: { labelled: 0, needed: 0,
      not_needed: 0, wrong_evidence: 0, precision: null, cards_per_recipient_day_p95: null } }; },
  });
  m.render();
  m.st.effects[0].fn();
  await flush();
  const find = (tree, pred) => {
    let hit = null;
    (function walk(n) {
      if (hit || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (pred(n)) { hit = n; return; }
      walk(n.kids);
    })(tree);
    return hit;
  };
  const row = find(m.render(), (n) => n.type && n.type.name === 'CardRow');
  assert.ok(row, 'one row per card');
  row.props.onLabelled(row.props.card, { card_id: 'c1', shadow_label: 'needed', label_note: 'ok' }, 'needed', 'ok');
  const after = m.render();
  const row2 = find(after, (n) => n.type && n.type.name === 'CardRow');
  assert.strictEqual(row2.props.card.shadow_label, 'needed');
  const summary = find(after, (n) => n.type && n.type.name === 'SummaryLine');
  assert.strictEqual(summary.props.summary.needed, 1);
  assert.strictEqual(summary.props.summary.precision, 1);
  assert.strictEqual(lists, 1);
});
