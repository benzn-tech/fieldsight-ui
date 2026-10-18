'use strict';

/*
 * Ask's documents block (backend rule 3): document excerpts are labelled as what the
 * project's documents REQUIRE, never as what happened, in their own block below the
 * answer, separate from the recording Sources and from the web block.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const askChat = fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
const css = fs.readFileSync(__dirname + '/../styles/composites.css', 'utf8');

test('the message keeps the documents the backend returned', () => {
  assert.match(askChat, /documents: {3}res\.documents \|\| null,/);
});

test('the label names both sides of the distinction', () => {
  assert.match(askChat, /From project documents — what should be, not what happened on site/);
});

test('the block renders below the answer and after the recording sources', () => {
  const tree = askChat.slice(askChat.indexOf("m.role === 'assistant' && formatAnswerBasis"));
  const body = tree.indexOf('renderMarkdown(m.text)');
  /* Since #436 the recording Sources render as the records fold below the answer. */
  const sources = tree.indexOf("body:        renderCitations(m.citations, !m.grounded, true),");
  const docs = tree.indexOf("m.role === 'assistant' ? renderDocumentOrigin(m) : null");
  assert.ok(body > -1 && sources > body && docs > sources);
});

test('no documents, no block; each entry opens the original at its page', () => {
  const start = askChat.indexOf('function renderDocumentOrigin');
  const block = askChat.slice(start, start + 2200);
  assert.ok(block.length > 400);
  assert.match(block, /if \(!docs\.length\) return null;/);
  assert.match(block, /PD\.citeLabel\(d\)/);
  assert.match(block, /\.open\(d\.site_id, d\.document_id, d\.page\)/);
});

test('the block is visually separated', () => {
  assert.match(css, /\.fs-ask-docs \{/);
  const rule = css.slice(css.indexOf('.fs-ask-docs {'), css.indexOf('.fs-ask-docs__label'));
  assert.match(rule, /border-left/);
});

/* Behaviour, with React stubbed to a plain tree and the real api module loaded. */
function loadBlock(api) {
  global.window = { FieldSight: {}, FS: { api: Object.assign({ useMocks: false, orgBaseUrl: 'https://x/prod/api' }, api || {}) } };
  global.React = { createElement: function (type, props) {
    return { type, props: props || {}, kids: [].slice.call(arguments, 2) };
  } };
  delete require.cache[require.resolve('../scripts/api/project-documents.js')];
  require('../scripts/api/project-documents.js');
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight._askWebStatus.docs;
}
function flat(n) {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map(flat).join('|');
  return flat(n.kids);
}
const DOC = { n: 1, title: 'Concrete spec', heading: '4.2 Tolerances', page: 12, page_to: 13,
  document_id: 'd1', site_id: 's1', content_type: 'application/pdf' };

test('renders the label and a cite label per document', () => {
  const tree = loadBlock()({ documents: [DOC] });
  assert.strictEqual(tree.props.className, 'fs-ask-docs');
  assert.match(flat(tree), /what should be, not what happened on site/);
  assert.match(flat(tree), /Concrete spec · 4\.2 Tolerances · pp\. 12–13/);
});

test('absent, null or empty documents render nothing (old backends)', () => {
  const r = loadBlock();
  assert.strictEqual(r({}), null);
  assert.strictEqual(r({ documents: null }), null);
  assert.strictEqual(r({ documents: [] }), null);
});

test('org API off (mocks, or no org base): still labelled, nothing opens (rule 3)', () => {
  for (const api of [{ useMocks: true }, { orgBaseUrl: '' }]) {
    const tree = loadBlock(api)({ documents: [DOC] });
    assert.ok(tree, 'document-derived claims must stay labelled');
    assert.strictEqual(tree.props.className, 'fs-ask-docs');
    assert.match(flat(tree), /what should be, not what happened on site/);
    assert.match(flat(tree), /Concrete spec/);
    const btn = tree.kids[1].kids[0][0];
    assert.strictEqual(btn.props.disabled, true);
    let opened = false;
    global.window.FS.api.projectDocuments.open = () => { opened = true; return Promise.resolve(); };
    btn.props.onClick();
    assert.strictEqual(opened, false);
  }
});

test('a Chinese question gets the Chinese label, the same distinction', () => {
  const tree = loadBlock()({ zh: true, documents: [DOC] });
  assert.match(flat(tree), /来自项目文档 — 规定应如何，不是现场发生了什么/);
  assert.doesNotMatch(flat(tree), /what should be/);
});

test('live: an entry opens; an entry without ids does not', () => {
  const tree = loadBlock()({ documents: [DOC, { title: 'Loose', page: 1 }] });
  const btns = tree.kids[1].kids[0];
  assert.strictEqual(btns[0].props.disabled, false);
  assert.strictEqual(btns[1].props.disabled, true);
});

test('clicking an entry opens the original at its page', () => {
  const r = loadBlock();
  let args;
  global.window.FS.api.projectDocuments.open = (a, b, c) => { args = [a, b, c]; return Promise.resolve(); };
  const tree = r({ documents: [DOC] });
  const btn = tree.kids[1].kids[0][0];
  btn.props.onClick();
  assert.deepStrictEqual(args, ['s1', 'd1', 12]);
});
