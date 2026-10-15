'use strict';

/*
 * The upload modal reads the file now (spec 2026-10-16 section 5). Its phases and the
 * calls between them are pinned at the source, the way this repo pins composites: no
 * DOM harness, and the logic that can be run lives in api/template-digitise.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'composites', 'template-upload-modal.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const LIB = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

test('THE: with a file, the modal digitises; with none, it creates from starting sections', () => {
  assert.match(SRC, /TD\.digitise\(files, title\.trim\(\)/);
  assert.match(SRC, /if \(!files\.length\) return createFromStarter\(false\)/);
});

test('reading switched off falls back to today and says nothing was read', () => {
  assert.match(SRC, /if \(result\.off\) return createFromStarter\(true\)/);
  assert.match(LIB, /nothing was read from your file/);
});

test('a refused save keeps the draft: back to review with the message', () => {
  const save = SRC.slice(SRC.indexOf('async function handleSave'), SRC.indexOf('async function handleSave') + 1200);
  assert.match(save, /catch \(e\)[\s\S]*setPhase\('review'\)[\s\S]*setErr\(/);
  assert.ok(!/setDraft\(/.test(save), 'a failed save must not replace the draft');
});

test('Save sends the mapped body as a custom template, after the same checks the server makes', () => {
  assert.match(SRC, /TD\.bodyProblem\(body\)/);
  assert.match(SRC, /report_type:\s*'custom'/);
  assert.match(SRC, /body:\s*body/);
});

test('the picker takes up to ten photos, or one PDF or Word file, and no markdown or tiff', () => {
  assert.match(SRC, /multiple:\s*true/);
  assert.ok(!/'\.md'|'\.tiff'/.test(SRC));
});

test('the reading phase copy is the spec\'s', () => {
  assert.match(SRC, /Reading your form… about half a minute/);
});

test('an unreadable form shows the server\'s reason', () => {
  assert.match(SRC, /result\.reason \|\| result\.error/);
});

/* ---- carried from the Task 8 review ------------------------------------------ */

test('Save is refused with the message numbered the way the screen numbers sections', () => {
  const save = SRC.slice(SRC.indexOf('async function handleSave'), SRC.indexOf('async function handleSave') + 1200);
  assert.match(save, /Review\.problemFor\(current\)/);
  assert.ok(save.indexOf('problemFor') < save.indexOf("setPhase('saving')"),
    'the check must run before anything is sent');
  assert.match(save, /if \(problem\) \{ setErr\(problem\.message\); return; \}/);
});

test('each read remounts the review, so a stale Undo cannot bring back an old draft', () => {
  assert.match(SRC, /key: 'read-' \+ readNo/);
  const submit = SRC.slice(SRC.indexOf('async function handleSubmit'), SRC.indexOf('async function handleSave'));
  assert.ok(submit.indexOf('setReadNo(') < submit.indexOf("setPhase('review')"),
    'the key must change with the draft it belongs to');
});

test('the two-pane review gets a wide modal, full screen on a phone, and a backdrop tap does not close it', () => {
  assert.match(SRC, /size: wide \? 'xl' : 'md'/);
  assert.match(SRC, /closeOnBackdrop: !wide/);
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles', 'composites.css'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(CSS, /\.fs-modal--xl \{ width: min\(1180px, calc\(100vw - 32px\)\)/);
  const phone = CSS.slice(CSS.indexOf('.fs-modal--xl { width: min('));
  assert.match(phone, /@media \(max-width: 600px\) \{[\s\S]*?\.fs-modal--xl\.fs-modal--open \{\s*top: 0; left: 0; transform: none;\s*width: 100vw; max-width: 100vw;\s*height: 100vh; height: 100dvh;/);
  /* Coarse pointers: 44px fields and buttons, 16px text (no iOS zoom on focus), declared
     after the base rules they must beat at equal specificity. */
  const base = CSS.indexOf('.fs-tpl-upload__select { cursor: pointer; }');
  const coarse = CSS.indexOf('.fs-tpl-upload__textarea { min-height: 44px; font-size: 16px; }');
  assert.ok(base > 0 && coarse > base, 'the coarse-pointer field rule must come after the base field rules');
  assert.match(CSS, /@media \(pointer: coarse\) \{\n  \.fs-tpl-upload__footer \.fs-btn \{ min-height: 44px; \}/);
  assert.match(CSS, /\.fs-tpl-upload--wide \{ width: min\(1140px, 100%\); \}/);
});

test('no report type the server refuses is offered', () => {
  /* POST /templates answers 'incident' with a 400 (_REPORT_TYPES in lambda_org_api.py). */
  const m = SRC.match(/var REPORT_TYPES = \[([^\]]*)\]/);
  assert.ok(m, 'REPORT_TYPES has moved');
  assert.ok(!/incident/.test(m[1]));
});

/* ---- behaviour (fix round 1): the component driven through a minimal hook runtime --
   No DOM: function-component children stay as {type, props} nodes, so the review's
   and the overlay's props are read and their callbacks called directly. */

function harness(server, createImpl) {
  const calls = [];
  const created = [];
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.document = { getElementById: () => null };
  global.window = {
    FS: { api: {
      useMocks: false,
      orgRequest: async (p, o) => { calls.push(p); return server(p, o || {}); },
    } },
    FieldSight: {
      ModalOverlay: function ModalOverlay() {}, Button: function Button() {},
    },
  };
  let slots = []; let i = 0; let tree = null; const cleanups = [];
  const effects = [];
  global.React = {
    createElement(type, props, ...children) {
      return { type, props: Object.assign({}, props, { children: children.flat(Infinity) }) };
    },
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = init;
      return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; render(); }];
    },
    useRef(init) { const k = i++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (!prev || !deps || deps.some((d, j) => d !== prev[j])) { slots[k] = deps || []; effects.push(fn); }
    },
  };
  for (const f of ['../scripts/api/template-store.js', '../scripts/api/template-digitise.js',
                   '../scripts/composites/template-digitise-review.js',
                   '../scripts/composites/template-upload-modal.js']) {
    delete require.cache[require.resolve(f)];
    require(f);
  }
  window.FS.api.templates.create = async (data) => { created.push(data); return createImpl ? createImpl(data) : { id: 't1' }; };
  const done = [];
  const cancelled = [];
  const props = { scope: 'personal', onComplete: (row, how) => done.push({ row, how }), onCancel: () => cancelled.push(1) };
  function render() {
    i = 0;
    tree = window.FieldSight.TemplateUploadModal(props);
    effects.splice(0).forEach((fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c); });
  }
  render();
  function find(pred, node = tree) {
    if (!node || typeof node !== 'object') return null;
    if (pred(node)) return node;
    for (const c of (node.props && node.props.children) || []) { const r = find(pred, c); if (r) return r; }
    return null;
  }
  const text = (n) => (n.props.children || []).filter((c) => typeof c === 'string').join('');
  return {
    calls, created, done, cancelled, find,
    get tree() { return tree; },
    unmount() { cleanups.forEach((c) => c()); },
    button(label) { return find((n) => n.type === window.FieldSight.Button && text(n) === label); },
    pick(files) { find((n) => n.type === 'input' && n.props.type === 'file').props.onChange({ target: { files } }); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const jpg = (name) => ({ name: name || 'form.jpg', size: 10 });

test('Close during the upload: the read is never requested and nothing is created', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness(async (p) => {
    if (p === '/templates/digitise/upload-url') { await gate; return { uploadUrl: 'https://s3/put', sourceKey: 'k' }; }
    if (p === '/templates/digitise') return { id: 'r1', status: 'pending' };
    return { id: 'r1', status: 'pending' };
  });
  const puts = [];
  global.fetch = async (url) => { puts.push(url); return { ok: true, status: 200 }; };
  h.pick([jpg('a.jpg'), jpg('b.jpg')]);
  h.button('Read the form').props.onClick();
  await tick();
  h.button('Close').props.onClick();
  h.unmount();
  release();
  for (let n = 0; n < 5; n++) await tick();
  assert.deepStrictEqual(h.cancelled, [1]);
  assert.deepStrictEqual(puts, [], 'a page was uploaded after Close');
  assert.ok(!h.calls.includes('/templates/digitise'), 'the billed read was requested after Close');
  assert.strictEqual(h.created.length, 0);
  assert.strictEqual(h.done.length, 0);
});

test('reading off with a file attached: the toast is told which report type was made', async () => {
  const h = harness(async () => ({ _notFound: true, status: 404, raw: { error: 'not found' } }));
  h.pick([jpg()]);
  h.button('Read the form').props.onClick();
  for (let n = 0; n < 5; n++) await tick();
  assert.strictEqual(h.created[0].report_type, 'daily');
  assert.deepStrictEqual(h.done[0].how, { readingOff: true, reportType: 'daily' });
  assert.match(LIB, /A ' \+ kind \+ 'template was created from the starting sections; '/);
});

test('a 409 on Save: back to the review with the message beside an editable name', async () => {
  const DONE = { id: 'r1', status: 'done', name: 'Form', flags: [],
    sections: [{ title: 'General', items: [{ text: 'Gate locked?', flags: [] }], flags: [] }], sources: [] };
  let attempt = 0;
  const h = harness(async (p) => {
    if (p === '/templates/digitise/upload-url') return { uploadUrl: 'https://s3/put', sourceKey: 'k' };
    if (p === '/templates/digitise') return { id: 'r1', status: 'pending' };
    return DONE;
  }, (data) => {
    attempt += 1;
    if (attempt === 1) { const e = new Error('A template called "form" already exists here.'); e.status = 409; throw e; }
    return { id: 't2', title: data.title };
  });
  global.fetch = async () => ({ ok: true, status: 200 });
  h.pick([jpg()]);
  h.button('Read the form').props.onClick();
  for (let n = 0; n < 10; n++) await tick();
  const Review = window.FieldSight.TemplateDigitiseReview;
  let review = h.find((n) => n.type === Review);
  assert.ok(review, 'the review did not open');
  review.props.onSave(review.props.draft);
  for (let n = 0; n < 5; n++) await tick();
  review = h.find((n) => n.type === Review);
  assert.ok(review, 'a refused save left the review');
  assert.strictEqual(review.props.draft.sections[0].items[0].text, 'Gate locked?');
  const alert = h.find((n) => n.props.role === 'alert' && /already exists/.test((n.props.children || []).join('')));
  assert.ok(alert, 'the 409 message is not shown');
  const name = h.find((n) => n.type === 'input' && n.props.value === 'form');
  assert.ok(name, 'no editable name field in the review');
  name.props.onChange({ target: { value: 'Form B' } });
  h.find((n) => n.type === Review).props.onSave(review.props.draft);
  for (let n = 0; n < 5; n++) await tick();
  assert.strictEqual(h.created[1].title, 'Form B');
  assert.strictEqual(h.created[1].report_type, 'custom');
  assert.deepStrictEqual(h.done[0].how, { digitised: true });
});

test('clearing the file empties the file input, so the same file can be picked again', () => {
  const h = harness(async () => ({}));
  h.pick([jpg()]);
  const input = h.find((n) => n.type === 'input' && n.props.type === 'file');
  const el = { value: 'C:\fakepath\form.jpg' };
  input.props.ref.current = el;
  h.find((n) => n.props['aria-label'] === 'Remove file').props.onClick({ stopPropagation() {} });
  assert.strictEqual(el.value, '');
});
