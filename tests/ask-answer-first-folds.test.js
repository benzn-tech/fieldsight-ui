'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* Ask: answer first, details folded (spec docs/specs/2026-10-17-ask-answer-
 * first-folds.md, rev 2).
 *
 * The owner re-asked "What is the minimum concrete cover for a slab on grade?"
 * on TEST and scrolled past a basis line and five record cards before reaching
 * a word of the answer, then read the web facts twice. The rule now: above the
 * answer only one-line context that changes how it must be read (scope lines,
 * "Searched for:", a WIDENED basis line, the web provenance label); below it,
 * folds.
 *
 * The fixtures below are the real TEST payloads (2026-10-17), trimmed only in
 * snippet length: the offer turn and the button's re-ask, which came back
 * grounded:true AND from_web:true with inline [1]..[5] pointing at the cards.
 */

const askChat = fs.readFileSync(
  require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
const css = fs.readFileSync(__dirname + '/../styles/composites.css', 'utf8');

/* ---- real payloads ------------------------------------------------------- */

const DUMP_OFFER = {
  answer: "Your site records don't cover that.",
  web_offer: true,
  grounded: true,
  citations: [],
  basis: { from: null, to: null, widened: false, chunks: 5,
           dates: ['2026-10-06', '2026-10-08', '2026-10-12'] },
  applied_scope: { dropped: [] },
  asked: null,
};

function cite(date, title, sid) {
  return {
    source_s3_key: 'extractions/Ben_Lin_test2/' + date + '/' + sid + '.json',
    report_date: date, site_name: 'Test Project', site_slug: 'test-project',
    topic_title: title, chunk_type: 'topic',
    snippet: '[17:14 – 17:16] ' + title + ' (quality)\nBottom cover at 40mm is correct.',
    time_start: null,
  };
}

const DUMP_WEB = {
  answer: 'Project records do not contain the minimum concrete cover requirements for a ' +
          'slab on grade, only referencing bottom cover (40mm) [1][2][3][4][5].\n\n' +
          'Under New Zealand standards, minimum concrete cover requirements for a ' +
          'slab-on-ground are:\n* Concrete cast directly on or against the ground: 75 mm.',
  citations: [
    cite('2026-10-06', 'Slab Rebar and Cover', 'sid44d8'),
    cite('2026-10-06', 'Slab Rebar and Cover', 'sid44d8'),
    cite('2026-10-06', 'Slab Reinforcement and Cover', 'side2e5'),
    cite('2026-10-12', 'Slab Rebar Spacing and Cover', 'sid5746'),
    cite('2026-10-08', 'Slab Reinforcement Steel Check', 'sid5cc1'),
  ],
  grounded: true,
  from_web: true,
  web: {
    answer: 'Under New Zealand standards, the minimum concrete cover requirements for a ' +
            'slab-on-ground are:\n\n* Concrete cast directly on or against the ground: **75 mm**.',
    sources: [
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/A1', title: 'placemakers.co.nz', domain: 'placemakers.co.nz' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/A2', title: 'scribd.com', domain: 'scribd.com' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/A3', title: 'cloudfront.net', domain: 'cloudfront.net' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/A4', title: 'atlasconcrete.co.nz', domain: 'atlasconcrete.co.nz' },
    ],
    status: 'verified',
    kind: 'mixed',
    conflicts: [],
    searched: true,
    timed_out: false,
    failed: false,
    refused: null,
  },
  basis: { from: null, to: null, widened: false, chunks: 5,
           dates: ['2026-10-06', '2026-10-08', '2026-10-12'] },
  applied_scope: { dropped: [] },
  asked: null,
};

/* A project question ("What did we do yesterday?"): grounded, no web. */
const GROUNDED = {
  answer: 'You poured the level 2 slab [1] and checked the edge cover [2].',
  citations: [cite('2026-10-12', 'Slab pour', 'sidA'), cite('2026-10-12', 'Edge cover', 'sidB')],
  grounded: true,
  basis: { from: '2026-10-12', to: '2026-10-12', widened: false, chunks: 6, dates: ['2026-10-12'] },
  applied_scope: { dropped: [] },
};

/* The older web branch: records judged insufficient, web prose with its own
   [1] markers, so the record cards must stay bullets. */
const NOT_GROUNDED_WEB = {
  answer: 'The vendor says 40mm cover [1].',
  from_web: true,
  grounded: false,
  citations: [cite('2026-09-03', 'Scaffold', 'sidC')],
  web: { answer: 'The vendor says 40mm cover [1].',
         sources: [{ url: 'https://example.com/spec', title: 'Spec sheet' }] },
};

/* ---- driven harness (same approach as ask-web-offer.test.js) ------------- */

function mountAsk(flags) {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  const h = { states: [], refs: [], effects: [], asks: [], pending: [], corrobs: [] };
  let si = 0, ri = 0, ei = 0;
  global.React = {
    Fragment: 'Fragment',
    createElement(type, props, ...kids) { return { type, props: props || {}, kids }; },
    useState(init) {
      const i = si++;
      if (!(i in h.states)) h.states[i] = init;
      return [h.states[i], v => { h.states[i] = typeof v === 'function' ? v(h.states[i]) : v; }];
    },
    useRef(init) {
      const i = ri++;
      if (!(i in h.refs)) h.refs[i] = { current: init };
      return h.refs[i];
    },
    useEffect(fn, deps) {
      const i = ei++;
      const prev = h.effects[i];
      const changed = !prev || !deps || deps.some((d, k) => d !== prev.deps[k]);
      h.effects[i] = { fn, deps, changed };
    },
  };
  global.document = { addEventListener() {}, removeEventListener() {} };
  const api = Object.assign({
    ask: {
      ask(body) {
        h.asks.push(body);
        return new Promise(resolve => { h.pending.push({ resolve }); });
      },
      corroborate() {
        return new Promise(resolve => { h.corrobs.push({ resolve }); });
      },
    },
  }, flags || {});
  global.window = { FieldSight: { renderMarkdown: s => s }, FS: { api: api } };
  require('../scripts/composites/ask-chat.js');
  const AskChat = global.window.FieldSight.AskChat;
  h.render = function (props) {
    si = 0; ri = 0; ei = 0;
    h.props = props;
    h.tree = AskChat(props);
    h.nodes().forEach(n => {
      if (n.props.ref && n.props.ref.current == null) {
        n.props.ref.current = { scrollIntoView() {}, focus() {}, querySelectorAll: () => [] };
      }
    });
    h.effects.forEach(e => { if (e.changed) { e.changed = false; e.fn(); } });
    return h.tree;
  };
  h.rerender = () => h.render(h.props);
  h.walk = function (root) {
    const out = [];
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      out.push(n);
      n.kids.forEach(walk);
    })(root);
    return out;
  };
  h.nodes = () => h.walk(h.tree);
  h.has = (n, cls) => String(n.props.className || '').split(' ').includes(cls);
  h.byClass = cls => h.nodes().filter(n => h.has(n, cls));
  h.within = (root, cls) => h.walk(root).filter(n => h.has(n, cls));
  h.text = function (n) {
    if (n.props && n.props.dangerouslySetInnerHTML) return n.props.dangerouslySetInnerHTML.__html || '';
    return n.kids.map(function t(k) {
      if (Array.isArray(k)) return k.map(t).join('');
      if (k && typeof k === 'object') return h.text(k);
      return k == null || k === false ? '' : String(k);
    }).join('');
  };
  /* The assistant rows, in order. */
  h.answers = () => h.byClass('fs-ask-chat__msg').filter(n => n.props['data-role'] === 'assistant');
  /* A row's direct children, nulls dropped, in render order. */
  h.children = row => row.kids.flat(Infinity).filter(k => k && typeof k === 'object');
  h.ask = async function (question) {
    h.byClass('fs-ask-chat__input')[0].props.onChange({ target: { value: question } });
    h.rerender();
    h.byClass('fs-ask-chat__form')[0].props.onSubmit({ preventDefault() {} });
    h.rerender();
  };
  h.settle = async function (i, res) {
    h.pending[i].resolve(res);
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    h.rerender();
  };
  h.settleCorrob = async function (i, res) {
    h.corrobs[i].resolve(res);
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    h.rerender();
  };
  return h;
}

async function answered(res, question, flags) {
  const h = mountAsk(flags);
  h.render({ user: 'Ben', context: {} });
  await h.ask(question || 'What is the minimum concrete cover for a slab on grade?');
  await h.settle(0, res);
  return h;
}

/* Whatever sits above the answer in a row must be one of these. */
const ALLOWED_ABOVE = ['fs-ask-chat__scope-line', 'fs-ask-chat__asked',
                       'fs-ask-chat__basis--widened', 'fs-ask-web__label'];

function assertAnswerFirst(h, row, what) {
  const kids = h.children(row);
  const answerAt = kids.findIndex(k => h.has(k, 'fs-ask-chat__msg-text'));
  assert.ok(answerAt > -1, what + ': no answer node');
  kids.slice(0, answerAt).forEach(k => {
    assert.ok(ALLOWED_ABOVE.some(c => h.has(k, c)),
      what + ': only one-line context may sit above the answer, found ' + k.props.className);
  });
  h.walk(row).filter(n => h.has(n, 'fs-ask-fold')).forEach(f => {
    assert.ok(kids.indexOf(f) > answerAt, what + ': a fold precedes the answer');
  });
  return { kids, answerAt };
}

/* ---- Task 1: records fold --------------------------------------------------- */

test('R1 grounded project answer: the answer comes first, the sources fold after it, open', async () => {
  const h = await answered(GROUNDED, 'What did we do yesterday?');
  const row = h.answers()[0];
  const { kids, answerAt } = assertAnswerFirst(h, row, 'grounded');
  const fold = h.within(row, 'fs-ask-fold--records')[0];
  assert.ok(fold, 'no records fold');
  assert.ok(kids.indexOf(fold) > answerAt, 'records fold above the answer');
  assert.strictEqual(h.byClass('fs-ask-chat__basis').length, 0,
    'a non-widened basis line no longer sits above the answer');

  const btn = h.within(fold, 'fs-ask-fold__summary')[0];
  assert.strictEqual(btn.type, 'button');
  assert.strictEqual(btn.props['aria-expanded'], true, 'grounded records must open by default');
  assert.strictEqual(h.text(h.within(btn, 'fs-ask-fold__text')[0]),
    'Sources · 2 · Based on 2026-10-12');
  const body = h.within(fold, 'fs-ask-fold__body')[0];
  assert.strictEqual(btn.props['aria-controls'], body.props.id);
  assert.ok(body.props.id, 'the body needs an id for aria-controls');
  assert.strictEqual(body.props.hidden, false);
  assert.deepStrictEqual(h.within(body, 'fs-ask-chat__cite-num').map(h.text), ['[1]', '[2]']);
  /* The heading is the summary now; the body does not repeat it. */
  assert.strictEqual(h.within(body, 'fs-ask-chat__citations-label').length, 0);
});

test('R2 offer turn (citations: [], basis.chunks: 5): no basis line, no records fold', async () => {
  const h = await answered(DUMP_OFFER, null, { askWebOffer: true });
  const row = h.answers()[0];
  assertAnswerFirst(h, row, 'offer');
  assert.strictEqual(h.byClass('fs-ask-chat__basis').length, 0,
    '"5 excerpts" counted excerpts the reply neither shows nor uses');
  assert.strictEqual(h.byClass('fs-ask-fold--records').length, 0);
  assert.ok(!/excerpt/.test(h.text(row)), h.text(row));
  /* The offer button still follows the answer. */
  const kids = h.children(row);
  assert.ok(kids.findIndex(k => h.has(k, 'fs-ask-chat__web-offer'))
          > kids.findIndex(k => h.has(k, 'fs-ask-chat__msg-text')));
});

test('R3 widened with citations: [] still says so above the answer, with no count tail', async () => {
  const h = await answered({
    answer: 'Nothing was recorded yesterday.', citations: [], grounded: true,
    basis: { from: '2026-10-06', to: '2026-10-06', widened: true, chunks: 4, dates: ['2026-10-06'] },
  }, 'What did we do yesterday?');
  const row = h.answers()[0];
  const { kids, answerAt } = assertAnswerFirst(h, row, 'widened');
  const line = h.byClass('fs-ask-chat__basis');
  assert.strictEqual(line.length, 1);
  assert.ok(h.has(line[0], 'fs-ask-chat__basis--widened'));
  assert.ok(kids.indexOf(line[0]) < answerAt);
  assert.strictEqual(h.text(line[0]),
    'Nothing in the period asked about — based on 2026-10-06 instead');
  assert.strictEqual(h.byClass('fs-ask-fold--records').length, 0);
});

test('R4 widened with citations: the tail counts the cards shown, not basis.chunks', async () => {
  const h = await answered(Object.assign({}, GROUNDED, {
    basis: { from: '2026-10-06', to: '2026-10-06', widened: true, chunks: 7, dates: ['2026-10-06'] },
  }), 'What did we do yesterday?');
  assert.strictEqual(h.text(h.byClass('fs-ask-chat__basis')[0]),
    'Nothing in the period asked about — based on 2026-10-06 instead · 2 excerpts');
  /* The records summary does not repeat the widened sentence. */
  assert.strictEqual(h.text(h.within(h.byClass('fs-ask-fold--records')[0], 'fs-ask-fold__text')[0]),
    'Sources · 2');
});

test('R5 the mixed web answer (grounded + from_web, real payload): records open and numbered, below the answer', async () => {
  const h = await answered(DUMP_WEB);
  const row = h.answers()[0];
  const kids = h.children(row);
  const answerAt = kids.findIndex(k => h.has(k, 'fs-ask-chat__msg-text'));
  const fold = h.within(row, 'fs-ask-fold--records')[0];
  assert.ok(kids.indexOf(fold) > answerAt, 'records must come after the answer');
  const btn = h.within(fold, 'fs-ask-fold__summary')[0];
  assert.strictEqual(btn.props['aria-expanded'], true, 'the answer cites [1]..[5]; the cards open');
  assert.strictEqual(h.text(h.within(btn, 'fs-ask-fold__text')[0]),
    'Sources · 5 · Based on all records you can see');
  assert.deepStrictEqual(h.within(fold, 'fs-ask-chat__cite-num').map(h.text),
    ['[1]', '[2]', '[3]', '[4]', '[5]']);
});

test('R6 not grounded: records collapsed, bulleted, and still in the tree with the hidden attribute', async () => {
  const h = await answered(NOT_GROUNDED_WEB);
  const fold = h.byClass('fs-ask-fold--records')[0];
  const btn = h.within(fold, 'fs-ask-fold__summary')[0];
  assert.strictEqual(btn.props['aria-expanded'], false);
  assert.strictEqual(h.text(h.within(btn, 'fs-ask-fold__text')[0]),
    'What we found in your records · 1');
  const body = h.within(fold, 'fs-ask-fold__body')[0];
  assert.strictEqual(body.props.hidden, true, 'a collapsed body keeps the hidden attribute');
  assert.strictEqual(h.within(body, 'fs-ask-chat__cite').length, 1, 'collapsed is not removed');
  assert.deepStrictEqual(h.within(body, 'fs-ask-chat__cite-num').map(h.text), ['•']);
});

test('R7 the toggle flips aria-expanded and hidden, per message', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('q1');
  await h.settle(0, GROUNDED);
  await h.ask('q2');
  await h.settle(1, GROUNDED);
  const btns = () => h.byClass('fs-ask-fold--records').map(f => h.within(f, 'fs-ask-fold__summary')[0]);
  assert.deepStrictEqual(btns().map(b => b.props['aria-expanded']), [true, true]);

  btns()[0].props.onClick();
  h.rerender();
  assert.deepStrictEqual(btns().map(b => b.props['aria-expanded']), [false, true],
    'one message\'s fold moved another');
  assert.strictEqual(h.within(h.byClass('fs-ask-fold--records')[0], 'fs-ask-fold__body')[0].props.hidden, true);

  btns()[0].props.onClick();
  h.rerender();
  assert.deepStrictEqual(btns().map(b => b.props['aria-expanded']), [true, true]);

  const ids = h.byClass('fs-ask-fold__body').map(b => b.props.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'body ids must be unique');
});

test('R8 a Chinese question gets the Chinese basis in the summary; "Sources" stays English', async () => {
  const h = await answered(Object.assign({}, GROUNDED, {
    basis: { from: null, to: null, widened: false, chunks: 5, dates: [] },
  }), '昨天做了什么');
  assert.strictEqual(h.text(h.within(h.byClass('fs-ask-fold--records')[0], 'fs-ask-fold__text')[0]),
    'Sources · 2 · 基于你能看到的全部记录');
});

test('R9 the collapsed body prints, has no expand animation, and the chevron respects reduced motion', () => {
  assert.match(css, /\.fs-ask-fold__body\[hidden\]\s*\{\s*display:\s*none/);
  const print = css.slice(css.indexOf('@media print', css.indexOf('.fs-ask-fold')));
  assert.match(print.slice(0, 300), /\.fs-ask-fold__body\[hidden\]\s*\{\s*display:\s*block/);
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.fs-ask-fold')));
  assert.match(rm.slice(0, 300), /\.fs-ask-fold__chevron\s*\{\s*transition:\s*none/);
});

test('R10 the fold styles use semantic tokens only (no palette-scale foreground)', () => {
  const start = css.indexOf('/* ── Ask · folds');
  assert.ok(start > -1, 'fold styles not found');
  const end = css.indexOf('/* ── end Ask · folds', start);
  const block = css.slice(start, end);
  assert.ok(block.length > 200);
  assert.ok(!/--color-(primary|accent|success|danger|warning|info|neutral)-\d/.test(block),
    'a palette-scale token in the fold styles');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(block), 'a hard-coded colour in the fold styles');
});

/* ---- Task 2: the web fold and the corroboration fold ------------------------ */

function loadFolds() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement(type, props, ...kids) { return { type, props: props || {}, kids }; } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight._askFolds;
}
const src = (domain) => ({ url: 'https://vertexaisearch.cloud.google.com/r/' + domain, title: domain, domain });

test('S1 web summary: status text, then the first 3 distinct domains in source order, then +N', () => {
  const F = loadFolds();
  const m = { fromWeb: true, text: 'a', web: { status: 'verified',
    sources: ['b.org', 'a.com', 'b.org', 'c.net', 'd.io', 'e.nz'].map(src) } };
  assert.strictEqual(F.web(m).text, 'Checked against 6 web sources · b.org, a.com, c.net +2');
  assert.strictEqual(F.web(m).level, 'ok');

  /* The real re-ask (4 sources). */
  assert.strictEqual(F.web({ fromWeb: true, grounded: true, text: DUMP_WEB.answer, web: DUMP_WEB.web }).text,
    'Checked against 4 web sources · placemakers.co.nz, scribd.com, cloudfront.net +1');

  /* Three or fewer: no +N. A source without `domain` falls back to its host. */
  assert.strictEqual(F.web({ fromWeb: true, web: { status: 'verified',
    sources: [src('x.com'), { url: 'https://www.y.org/p' }] } }).text,
    'Checked against 2 web sources · x.com, y.org');
});

test('S2 web summary: the unverified, failed, too_long and refused texts', () => {
  const F = loadFolds();
  const un = F.web({ fromWeb: true, text: 'm', web: { status: 'unverified', answer: 'general', sources: [] } });
  assert.strictEqual(un.text, 'Model knowledge — not verified online (web search failed)');
  assert.strictEqual(un.level, 'warn');
  const failed = F.web({ fromWeb: false, text: 'm', web: { status: 'unverified', answer: null, sources: [] } });
  assert.strictEqual(failed.text, 'Web check unavailable — no general answer');
  assert.strictEqual(failed.level, 'warn');
  assert.strictEqual(failed.foldable, false, 'a status with nothing under it is a plain line');
  const long = F.web({ text: 'm', web: { status: 'too_long', sources: [] } });
  assert.strictEqual(long.text, 'Not searched online (question too long)');
  assert.strictEqual(long.foldable, false);

  const sentence = 'This question asks about a named individual, which the web check will not run for.';
  const refused = F.web({ text: 'm', web: { refused: sentence } });
  assert.strictEqual(refused.text, sentence, 'a refusal is never hidden behind a fold');
  assert.strictEqual(refused.foldable, false);
  /* With `status` the backend no longer refuses by content; the status speaks. */
  assert.strictEqual(F.web({ text: 'm', web: { refused: sentence, status: 'too_long' } }).text,
    'Not searched online (question too long)');
});

test('S3 web summary: the older-backend fallback and the conflict count', () => {
  const F = loadFolds();
  assert.strictEqual(F.web({ fromWeb: true, text: 'm',
    web: { answer: 'w', sources: [src('example.com'), src('b.org')] } }).text,
    'From the open web · 2 sources · example.com, b.org');
  assert.strictEqual(F.web({ fromWeb: true, text: 'm', web: { sources: [src('one.nz')] } }).text,
    'From the open web · 1 source · one.nz');

  const one = F.web({ fromWeb: true, text: 'm', web: { status: 'verified', sources: [src('a.nz')],
    conflicts: ['records say 900 mm; F4/AS1 says 1000 mm'] } });
  assert.strictEqual(one.text, 'Checked against 1 web source · a.nz · 1 conflict');
  assert.strictEqual(one.level, 'warn', 'a hidden disagreement must not read as all-clear');
  assert.strictEqual(F.web({ text: 'm', web: { status: 'verified', sources: [],
    conflicts: ['x', 'y', '', null] } }).text, 'Checked against 0 web sources · 2 conflicts');
});

test('S4 web summary: nothing to say is no fold at all', () => {
  const F = loadFolds();
  assert.strictEqual(F.web({ text: 'm', web: null }), null);
  assert.strictEqual(F.web({ text: 'm' }), null);
  assert.strictEqual(F.web({ text: 'm', web: { status: 'not_needed', sources: [] } }), null);
  assert.strictEqual(F.web({ text: 'm', web: { sources: [], refused: null, conflicts: [] } }), null);
});

test('C1 corroboration summary: pending, failed and timed_out are plain lines', () => {
  const F = loadFolds();
  assert.deepStrictEqual(F.corrob({ _pending: true }), { text: 'Checking the web…', foldable: false, level: 'muted' });
  assert.deepStrictEqual(F.corrob({ _failed: true }), { text: 'Web check unavailable', foldable: false, level: 'muted' });
  const t = F.corrob({ corroborations: [], dropped: [], truncated: false, timed_out: true, searched: true });
  assert.strictEqual(t.text, 'Web check timed out');
  assert.strictEqual(t.foldable, false);
  assert.strictEqual(F.corrob(null), null);
  assert.strictEqual(F.corrob({ corroborations: [], dropped: [], searched: true }), null);
});

test('C2 corroboration summary: claims, "· K disagree" and "· M not checked"', () => {
  const F = loadFolds();
  const res = { corroborations: [
    { entity: 'NZS 3604', state: 'corroborated' },
    { entity: 'F4/AS1', state: 'conflicts' },
    { entity: 'C30', state: 'not_found' },
  ], dropped: [{ entity: 'Acme', reason: 'name' }, { entity: 'Bob', reason: 'name' }], searched: true };
  const s = F.corrob(res);
  assert.strictEqual(s.text, 'Checked on the web · 3 claims · 1 disagree · 2 not checked');
  assert.strictEqual(s.foldable, true);
  assert.strictEqual(s.level, 'warn');
  assert.strictEqual(F.corrob({ corroborations: [{ state: 'corroborated' }], searched: true }).text,
    'Checked on the web · 1 claim');
  assert.strictEqual(F.corrob({ corroborations: [{ state: 'corroborated' }], searched: true }).level, 'ok');
  /* Truncation has no count to report, so it says what it knows. */
  assert.strictEqual(F.corrob({ corroborations: [{}, {}, {}], truncated: true, searched: true }).text,
    'Checked on the web · 3 claims · only the first 3 checked');
  /* A broken or skipped check states the fact, never "0 claims". */
  assert.strictEqual(F.corrob({ corroborations: [], failed: true, searched: true }).text,
    'The web check could not be completed');
  assert.strictEqual(F.corrob({ corroborations: [], searched: false }).text,
    'Couldn’t check the web for this answer');
});

test('D1 the real re-ask: label, answer, records (open), web fold (closed) -- in that order', async () => {
  const h = await answered(DUMP_WEB);
  const row = h.answers()[0];
  const { kids, answerAt } = assertAnswerFirst(h, row, 'mixed');
  const labels = h.within(row, 'fs-ask-web__label');
  assert.strictEqual(labels.length, 1, 'the provenance label renders once');
  assert.ok(kids.indexOf(labels[0]) < answerAt, 'the provenance label stays above the answer');
  assert.strictEqual(h.text(labels[0]), 'From the open web — not from your recordings');

  const records = h.within(row, 'fs-ask-fold--records')[0];
  const web = h.within(row, 'fs-ask-fold--web')[0];
  assert.ok(answerAt < kids.indexOf(records) && kids.indexOf(records) < kids.indexOf(web),
    'order must be answer, records, web');

  const btn = h.within(web, 'fs-ask-fold__summary')[0];
  assert.strictEqual(btn.type, 'button');
  assert.strictEqual(btn.props['aria-expanded'], false, 'the web fold starts closed');
  assert.strictEqual(h.text(h.within(btn, 'fs-ask-fold__text')[0]),
    'Checked against 4 web sources · placemakers.co.nz, scribd.com, cloudfront.net +1');
  const body = h.within(web, 'fs-ask-fold__body')[0];
  assert.strictEqual(body.props.hidden, true);
  assert.strictEqual(btn.props['aria-controls'], body.props.id);
  /* Collapsed, not removed: the web prose and every source are in the body. */
  assert.strictEqual(h.within(body, 'fs-ask-web__answer').length, 1);
  assert.strictEqual(h.within(body, 'fs-ask-web__source').length, 4);
  assert.strictEqual(h.within(body, 'fs-ask-web__label').length, 0, 'the body repeats the label');

  btn.props.onClick();
  h.rerender();
  const web2 = h.byClass('fs-ask-fold--web')[0];
  assert.strictEqual(h.within(web2, 'fs-ask-fold__summary')[0].props['aria-expanded'], true);
  assert.strictEqual(h.within(web2, 'fs-ask-fold__body')[0].props.hidden, false);
});

test('D2 not grounded, from the web: answer, records (closed), web fold (closed)', async () => {
  const h = await answered(NOT_GROUNDED_WEB);
  const row = h.answers()[0];
  const { kids, answerAt } = assertAnswerFirst(h, row, 'not grounded web');
  const records = h.within(row, 'fs-ask-fold--records')[0];
  const web = h.within(row, 'fs-ask-fold--web')[0];
  assert.ok(answerAt < kids.indexOf(records) && kids.indexOf(records) < kids.indexOf(web));
  assert.strictEqual(h.within(records, 'fs-ask-fold__summary')[0].props['aria-expanded'], false);
  assert.strictEqual(h.text(h.within(web, 'fs-ask-fold__text')[0]),
    'From the open web · 1 source · example.com');
});

test('D3 a warn status keeps its warn class on the row (and so its dark-mode override)', async () => {
  const h = await answered({ answer: 'Typically 50mm.', from_web: true, grounded: false, citations: [],
    web: { status: 'unverified', answer: 'Typically 50mm.', sources: [] } });
  const text = h.within(h.byClass('fs-ask-fold--web')[0], 'fs-ask-fold__text')[0];
  assert.ok(h.has(text, 'fs-ask-webstatus__line--warn'), text.props.className);
  assert.match(css, /\[data-theme="dark"\] \.fs-ask-webstatus__line--warn/);
  assert.strictEqual(h.text(h.byClass('fs-ask-web__label')[0]), 'Model knowledge — not verified online');
});

test('D4 a refusal renders as a plain line below the answer, never behind a button', async () => {
  const sentence = 'This question asks about a named individual, which the web check will not run for.';
  const h = await answered({ answer: 'a', citations: [], web: { refused: sentence } });
  const row = h.answers()[0];
  const { kids, answerAt } = assertAnswerFirst(h, row, 'refused');
  const fold = h.within(row, 'fs-ask-fold--web')[0];
  assert.ok(kids.indexOf(fold) > answerAt);
  assert.strictEqual(h.within(fold, 'fs-ask-fold__body').length, 0);
  assert.strictEqual(h.walk(fold).filter(n => n.type === 'button').length, 0);
  assert.strictEqual(h.text(h.within(fold, 'fs-ask-chat__web-refused')[0]), sentence);
});

test('D5 corroboration: pending under the records, then a closed fold with the counts', async () => {
  const h = await answered(GROUNDED, 'What did we do yesterday?', { externalCorroboration: true });
  let row = h.answers()[0];
  let kids = h.children(row);
  const records = h.within(row, 'fs-ask-fold--records')[0];
  const pending = h.within(row, 'fs-ask-corrob--pending')[0];
  assert.ok(pending, 'pending shows as today');
  assert.ok(kids.indexOf(records) < kids.indexOf(pending), 'corroboration stays below the citations');

  await h.settleCorrob(0, { corroborations: [
    { entity: 'NZS 3604', state: 'corroborated', summary: 'ok', sources: [src('standards.govt.nz')] },
    { entity: 'F4/AS1', state: 'conflicts', claim: '900', summary: '1000', sources: [] },
  ], dropped: [], searched: true });
  row = h.answers()[0];
  kids = h.children(row);
  const { answerAt } = assertAnswerFirst(h, row, 'corroborated');
  const fold = h.within(row, 'fs-ask-fold--corrob')[0];
  assert.ok(kids.indexOf(fold) > kids.indexOf(h.within(row, 'fs-ask-fold--records')[0]));
  assert.ok(kids.indexOf(fold) > answerAt);
  const btn = h.within(fold, 'fs-ask-fold__summary')[0];
  assert.strictEqual(btn.props['aria-expanded'], false);
  assert.strictEqual(h.text(h.within(btn, 'fs-ask-fold__text')[0]),
    'Checked on the web · 2 claims · 1 disagree');
  const body = h.within(fold, 'fs-ask-fold__body')[0];
  assert.strictEqual(body.props.hidden, true);
  /* Today's block, unchanged, inside the body. */
  assert.strictEqual(h.within(body, 'fs-ask-corrob__item').length, 2);
  assert.strictEqual(h.within(body, 'fs-ask-corrob__conflict').length, 1);
});

test('D6 a corroboration that only timed out is a plain line, not a button', async () => {
  const h = await answered(GROUNDED, 'q', { externalCorroboration: true });
  await h.settleCorrob(0, { corroborations: [], dropped: [], truncated: false, timed_out: true, searched: true });
  const fold = h.byClass('fs-ask-fold--corrob')[0];
  assert.ok(fold);
  assert.strictEqual(h.walk(fold).filter(n => n.type === 'button').length, 0);
  assert.strictEqual(h.text(fold), 'Web check timed out');
});
