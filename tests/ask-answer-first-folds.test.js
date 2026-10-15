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
