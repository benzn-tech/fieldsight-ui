'use strict';

/*
 * The review screen: the draft beside the form, every edit through the pure ops in
 * api/template-digitise.js, flags in plain words, and the banner about silent
 * spelling fixes (spec 2026-10-16 section 5). Rendered with a minimal createElement
 * double: the repo has no DOM test harness, and what matters here is which ops each
 * control calls and which words reach the screen.
 */
const test = require('node:test');
const assert = require('node:assert');

function h(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) }; }
function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  (node.children || []).forEach((c) => walk(c, fn));
  if (typeof node.type === 'function') walk(node.type(Object.assign({}, node.props, { children: node.children })), fn);
}
function texts(node) { const out = []; walk(node, (n) => n.children.forEach((c) => { if (typeof c === 'string') out.push(c); })); return out.join(' | '); }
function find(node, pred) { const out = []; walk(node, (n) => { if (pred(n)) out.push(n); }); return out; }

function load() {
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.window = { FS: { api: { useMocks: false, orgBaseUrl: 'x', orgRequest: async () => ({}) } },
    FieldSight: { Button: function Button(p) { return h('button', p, ...(p.children || [])); } } };
  global.React = { createElement: h };
  for (const f of ['../scripts/api/template-store.js', '../scripts/api/template-digitise.js',
                   '../scripts/composites/template-digitise-review.js']) {
    delete require.cache[require.resolve(f)]; require(f);
  }
  return window.FieldSight.TemplateDigitiseReview;
}

const DRAFT = { name: 'Penina', flags: ['too_many_sections'], sections: [
  { title: 'Compressed Gasses', flags: ['near_duplicate_section'],
    items: [{ text: 'Bottles upright?', flags: ['truncated'] }, { text: 'Flashback arrestors?', flags: [] }] },
  { title: 'Ladders', flags: [], items: [{ text: 'Footed?', flags: [] }] }] };
const SOURCES = [{ key: 'k1', contentType: 'image/jpeg', url: 'https://s3/get/k1' },
                 { key: 'k2', contentType: 'application/pdf', url: 'https://s3/get/k2' }];

/* A useState double: slots survive between renders of one mount, the way React
   keeps them, so the Undo bar can be seen on the render after a delete. */
function mount(over) {
  const Review = load();
  const slots = [];
  let cursor = 0;
  React.useState = (init) => {
    const k = cursor++;
    if (!(k in slots)) slots[k] = init;
    return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }];
  };
  const seen = { changed: [], saved: [] };
  let props = Object.assign({ draft: DRAFT, sources: SOURCES, error: '', saving: false,
    onChange: (d) => seen.changed.push(d), onSave: (d) => seen.saved.push(d), onCancel: () => {} }, over || {});
  const rerender = (more) => { props = Object.assign({}, props, more || {}); cursor = 0; return Review(props); };
  return { tree: rerender(), seen, rerender };
}
function render(over) { return mount(over); }
function button(tree, label) {
  return find(tree, (n) => n.type === 'button' && ((n.children || []).includes(label) || n.props['aria-label'] === label));
}
function manySections(n) {
  return { name: 'Big', flags: ['too_many_sections'], sections: Array.from({ length: n }, (_, i) =>
    ({ title: 'S' + (i + 1), flags: [], items: [{ text: 'Item ' + (i + 1), flags: [] }] })) };
}

test('THE: the banner about silent spelling fixes is on the screen', () => {
  const { tree } = render();
  assert.match(texts(tree), /Check the wording against your form — the reader can correct a spelling without saying so\./);
});

test('every flag is shown in words, at the level it belongs to', () => {
  const { tree } = render();
  const t = texts(tree);
  const TD = window.FS.api.templateDigitise;
  for (const f of ['near_duplicate_section', 'truncated']) assert.ok(t.includes(TD.FLAG_TEXT[f]), f);
  // The server's draft-level too_many_sections is stale on a two-section draft: derived, not echoed.
  assert.ok(!t.includes(TD.FLAG_TEXT.too_many_sections), 'stale server flag is not shown');
  assert.ok(find(tree, (n) => /--flagged/.test(n.props.className || '')).length >= 2, 'flagged section and item are highlighted');
});

test('each section shows its item count', () => {
  assert.match(texts(render().tree), /2 items[\s\S]*1 item\b/);
});

test('the source sits beside the draft: page images and the PDF', () => {
  const { tree } = render();
  assert.deepStrictEqual(find(tree, (n) => n.type === 'img').map((n) => n.props.src), ['https://s3/get/k1']);
  assert.strictEqual(find(tree, (n) => n.type === 'iframe')[0].props.src, 'https://s3/get/k2');
});

test('editing an item goes through ops.editItem and reaches onChange', () => {
  const { tree, seen } = render();
  const box = find(tree, (n) => n.type === 'textarea')[0];
  box.props.onChange({ target: { value: 'Bottles upright and secured?' } });
  assert.strictEqual(seen.changed[0].sections[0].items[0].text, 'Bottles upright and secured?');
});

test('merge with next is offered and joins the two sections', () => {
  const { tree, seen } = render();
  const merge = find(tree, (n) => n.type === 'button' && (n.children || []).includes('Merge with next'))[0];
  merge.props.onClick();
  assert.strictEqual(seen.changed[0].sections.length, 1);
  assert.strictEqual(seen.changed[0].sections[0].items.length, 3);
});

test('Save hands the current draft up; it is disabled while saving', () => {
  const { tree, seen } = render();
  find(tree, (n) => n.type === 'button' && (n.children || []).includes('Save template'))[0].props.onClick();
  assert.deepStrictEqual(seen.saved[0], DRAFT);
  const saving = render({ saving: true }).tree;
  assert.ok(find(saving, (n) => n.type === 'button' && (n.children || []).includes('Saving…'))[0].props.disabled);
});

test('a refused save is shown, not swallowed', () => {
  assert.match(texts(render({ error: 'a template called that already exists here' }).tree), /already exists/);
});

test('a Word source says there is no page picture to compare', () => {
  const { tree } = render({ sources: [{ key: 'k', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', url: 'u' }] });
  assert.match(texts(tree), /Word file/);
});

test('a deleted item can be undone in place, and the bar goes on the next edit', () => {
  const m = mount();
  button(m.tree, 'Delete item')[0].props.onClick();
  const after = m.seen.changed[0];
  assert.strictEqual(after.sections[0].items.length, 1);
  let tree = m.rerender({ draft: after });
  assert.match(texts(tree), /Item deleted\./);
  button(tree, 'Undo')[0].props.onClick();
  assert.deepStrictEqual(m.seen.changed[1], DRAFT);
  // Any other edit drops the offer.
  button(m.rerender({ draft: after }), 'Delete item')[0].props.onClick();
  tree = m.rerender({ draft: m.seen.changed[2] });
  find(tree, (n) => n.type === 'textarea')[0].props.onChange({ target: { value: 'x' } });
  assert.strictEqual(button(m.rerender(), 'Undo').length, 0);
});

test('a deleted section can be undone; no browser dialog is involved', () => {
  global.confirm = () => { throw new Error('no confirm dialogs'); };
  const m = mount();
  button(m.tree, 'Delete section')[0].props.onClick();
  const after = m.seen.changed[0];
  assert.strictEqual(after.sections.length, 1);
  const tree = m.rerender({ draft: after });
  assert.match(texts(tree), /Section deleted\./);
  button(tree, 'Undo')[0].props.onClick();
  assert.deepStrictEqual(m.seen.changed[1], DRAFT);
  delete global.confirm;
});

test('too many sections is worked out from the draft and clears once merged below 40', () => {
  const m = mount({ draft: manySections(41) });
  const TD = window.FS.api.templateDigitise;
  assert.ok(texts(m.tree).includes(TD.FLAG_TEXT.too_many_sections));
  button(m.tree, 'Merge with next')[0].props.onClick();
  assert.strictEqual(m.seen.changed[0].sections.length, 40);
  assert.ok(!texts(m.rerender({ draft: m.seen.changed[0] })).includes(TD.FLAG_TEXT.too_many_sections));
});

test('an item box grows with its text instead of hiding it behind a scroll', () => {
  const long = 'Check the bottle is chained upright, the regulator is in date and the hose has no cracks. '.repeat(3);
  const draft = { name: 'x', flags: [], sections: [{ title: 'A', flags: [], items: [
    { text: 'Short?', flags: [] }, { text: long, flags: [] }] }] };
  const boxes = find(render({ draft }).tree, (n) => n.type === 'textarea');
  assert.strictEqual(boxes[0].props.rows, 1);
  assert.ok(boxes[1].props.rows >= Math.ceil(long.length / 45), 'rows ' + boxes[1].props.rows + ' for ' + long.length + ' chars');
});

test('each card shows its section number, and a save problem names the card the person sees', () => {
  assert.match(texts(render().tree), /Section 1 [\s\S]*Section 2 /);
  // Section 1 is empty, so the save body drops it: bodyProblem would call the
  // unnamed one "Section 1"; on screen it is the second card.
  const draft = { name: 'x', flags: [], sections: [
    { title: 'Empty', flags: [], items: [] },
    { title: '', flags: [], items: [{ text: 'Footed?', flags: [] }] }] };
  const tree = render({ draft }).tree;
  assert.match(texts(tree), /Section 2 needs a name\./);
  const flagged = find(tree, (n) => n.type === 'section' && /--flagged/.test(n.props.className));
  assert.strictEqual(flagged.length, 1);
  assert.ok(texts(flagged[0]).includes('Section 2 needs a name.'));
});
