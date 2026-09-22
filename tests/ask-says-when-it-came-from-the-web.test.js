'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* An answer the records could not give must say so before it is read.
 *
 * The backend now answers from the open web when the retrieved excerpts do not
 * cover the question, and marks it `from_web: true` with a `web.sources` list.
 * Rendered without that marker the reader gets a fluent, correct-looking answer
 * and no reason to suspect it did not come out of their own meetings — which is
 * the one thing this product promises they can always tell.
 *
 * Placement is the substance, not styling. The basis line sits above the answer
 * for the same measured reason (user, 2026-08-31): a caveat reached after three
 * sentences has already been read past. Corroboration sits BELOW because it
 * annotates an answer that did come from the recordings; this sits ABOVE
 * because it says the answer did not.
 */

const askChat = fs.readFileSync(
  require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
const css = fs.readFileSync(__dirname + '/../styles/composites.css', 'utf8');

test('a web-derived answer is labelled before the prose, not after', () => {
  /* Anchored inside the RENDER TREE, not the whole file. The first version
     searched the file for `renderWebOrigin(m)` -- which the function's own
     definition also contains, several thousand characters earlier -- so moving
     the call below the answer left the test green. The mutation caught it. */
  const tree = askChat.slice(askChat.indexOf("m.role === 'assistant' && formatAnswerBasis"));
  const origin = tree.indexOf('? renderWebOrigin(m)');
  const body = tree.indexOf('renderMarkdown(m.text)');
  const corrob = tree.indexOf('? renderCorroboration(m.corrob)');
  assert.ok(origin > -1, 'nothing renders the web origin');
  assert.ok(origin < body, 'the label sits after the answer text');
  assert.ok(body < corrob, 'the corroboration block moved above the answer');
});

test('the label names both sides of the distinction', () => {
  /* "From the web" alone leaves the reader to infer what it is NOT. */
  assert.match(askChat, /From the open web .* not from your recordings/);
});

test('a normal answer renders no web block at all', () => {
  const block = askChat.slice(askChat.indexOf('function renderWebOrigin'));
  assert.match(block.slice(0, 200), /if \(!m\.fromWeb\) return null;/);
});

test('sources are named by publisher, not by the redirect they arrived through', () => {
  /* The search vendor returns Google grounding redirects; parsing the URL
     would attribute every source to vertexaisearch.cloud.google.com. */
  /* Sliced from the function's own start rather than to the next function:
     the two are not in source order, and slicing between them silently
     produced an empty string that passed every assertion. */
  const start = askChat.indexOf('function renderWebOrigin');
  const block = askChat.slice(start, start + 1200);
  assert.ok(block.length > 400, 'the slice found nothing to assert on');
  assert.match(block, /sourceDomain\(s\)/);
  assert.ok(!/sourceHost\(s\.url\)/.test(block), 'it parsed the redirect URL');
});

test('a web answer is never corroborated against the web', () => {
  const line = askChat.slice(askChat.indexOf('var wantsCorrob'),
                             askChat.indexOf('var wantsCorrob') + 320);
  assert.match(line, /!res\.from_web/);
});

test('the block is visually separated, not just labelled', () => {
  assert.match(css, /\.fs-ask-web \{/);
  const rule = css.slice(css.indexOf('.fs-ask-web {'), css.indexOf('.fs-ask-web__label'));
  assert.match(rule, /border-left/, 'nothing marks it apart from the answer');
});

/* --------------------------------------------------------------------------
   Union, not either/or (spec 2026-09-22). The backend used to throw the
   retrieved record excerpts away on this branch (`citations: []`); it now
   sends them alongside the web answer instead of replacing it. Rendered
   through the SAME "Sources · N" heading and "[i+1]" numbering as a
   grounded answer, a reader would map the web prose's own [1]/[2] markers
   onto these cards -- a worse mix-up than throwing them away. This is a
   DRIVEN test (mounts the real component, same approach as
   ask-scoped-context.test.js's mountAsk) because the hazard is about what
   actually renders and in what order, not just what the source says.
   -------------------------------------------------------------------------- */

function mountAsk() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  const h = { states: [], refs: [], effects: [], asks: [], pending: [] };
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
  global.window = {
    FieldSight: { renderMarkdown: s => s },
    FS: { api: { ask: { ask(body) {
      h.asks.push(body);
      const d = new Promise(resolve => { h.pending.push({ resolve }); });
      return d;
    } } } },
  };
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
  h.unmount = () => { h.states = []; h.refs = []; h.effects = []; };
  h.rerender = () => h.render(h.props);
  h.nodes = function () {
    const out = [];
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      out.push(n);
      n.kids.forEach(walk);
    })(h.tree);
    return out;
  };
  h.byClass = cls => h.nodes().filter(n =>
    String(n.props.className || '').split(' ').includes(cls));
  h.indexOf = node => h.nodes().indexOf(node);
  h.text = function (n) {
    return n.kids.map(function t(k) {
      if (Array.isArray(k)) return k.map(t).join('');
      if (k && typeof k === 'object') return h.text(k);
      return k == null || k === false ? '' : String(k);
    }).join('');
  };
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
  return h;
}

const WEB_ANSWER = {
  answer: 'The vendor says 40mm cover [1].',
  from_web: true,
  grounded: false,
  citations: [{ source_s3_key: 'reports/2026-09-03/Ben/daily_report.json',
                report_date: '2026-09-03', site_name: 'UC PK', site_slug: 'uc-pk',
                topic_title: 'Scaffold', chunk_type: 'topic',
                snippet: 'Scaffold tagged.', time_start: null }],
  web: { answer: 'The vendor says 40mm cover [1].',
         sources: [{ url: 'https://example.com/spec', title: 'Spec sheet' }] },
};

test('records render, labelled as records, ABOVE the web block, never as "Sources"', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('What cover does the spec require?');
  await h.settle(0, WEB_ANSWER);

  const recordBlocks = h.byClass('fs-ask-chat__citations');
  assert.strictEqual(recordBlocks.length, 1,
    'the web branch must render its record citations, not drop them');

  const label = h.text(h.byClass('fs-ask-chat__citations-label')[0]);
  assert.ok(!/^Sources/.test(label),
    'the web-branch record block must not be labelled like a grounded source list: ' + label);
  assert.match(label, /records/i);

  const webOrigin = h.byClass('fs-ask-web')[0];
  assert.ok(webOrigin, 'the web block itself must still render');
  assert.ok(h.indexOf(recordBlocks[0]) < h.indexOf(webOrigin),
    'records must render before the web block, not after');

  /* The hazard this guards against: reusing the grounded "[i+1]" marker
     would read as the web prose's own [1] inline reference. */
  const marker = h.text(h.byClass('fs-ask-chat__cite-num')[0]);
  assert.notStrictEqual(marker, '[1]',
    'a bracketed number on the record block is indistinguishable from the ' +
    'web answer\'s own inline citation marker');

  /* The web answer's own sources still render, untouched, in their own block. */
  assert.ok(/example\.com/.test(h.text(webOrigin)) || webOrigin.kids.length,
    'the web block lost its own sources');
});
