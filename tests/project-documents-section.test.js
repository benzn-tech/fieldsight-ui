'use strict';

/*
 * The Documents section on the project page. Rendering is checked on the source (this
 * repo's composites run in-browser through Babel); the behaviour lives in
 * api/project-documents.js and is tested there.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const src = fs.readFileSync(require.resolve('../scripts/composites/project-documents-section.js'), 'utf8');
const sites = fs.readFileSync(require.resolve('../scripts/pages/sites.js'), 'utf8');
const html = fs.readFileSync(__dirname + '/../app-shell-preview.html', 'utf8');
const css = fs.readFileSync(__dirname + '/../styles/composites.css', 'utf8');

test('THE: switched off on the server, the section does not exist', () => {
  assert.match(src, /if \(st\.status === 'off'\) return null;/);
});

test('every change control is behind canWrite from the server', () => {
  for (const label of ['Upload document', 'New revision', 'Rename', 'Delete']) {
    const at = src.indexOf("'" + label + "'");
    assert.ok(at > -1, label + ' is missing');
    const before = src.slice(Math.max(0, at - 400), at);
    assert.match(before, /canWrite/, label + ' is not gated on canWrite');
  }
});

test('status comes from statusOf and Retry only where it can help', () => {
  assert.match(src, /api\(\)\.statusOf\(d, Date\.now\(\)\)/);
  assert.match(src, /status\.canRetry && st\.canWrite/);
});

test('it keeps reading the list while anything is indexing', () => {
  assert.match(src, /api\(\)\.REFRESH_MS/);
});

test('the project page mounts it between the reports and the people', () => {
  const reports = sites.indexOf("'Recent reports'");
  const docs = sites.indexOf('ProjectDocumentsSection');
  const users = sites.indexOf("'Users on site'");
  assert.ok(reports > -1 && docs > reports && users > docs);
  assert.match(sites, /ProjectDocumentsSection, \{ siteId: sel\.site_id/);
});

test('both files are loaded by the app and styled', () => {
  assert.match(html, /scripts\/api\/project-documents\.js\?v=\d+/);
  assert.match(html, /scripts\/composites\/project-documents-section\.js\?v=\d+/);
  assert.match(css, /\.fs-project-docs \{/);
});

test('no browser dialogs: rename and delete are confirmed inline', () => {
  assert.doesNotMatch(src, /window\.(alert|confirm|prompt)\(/);
  assert.match(src, /It will no longer be searched\./);
});

test('every hook runs before the off return', () => {
  const off = src.indexOf("if (st.status === 'off') return null;");
  const lastHook = Math.max(src.lastIndexOf('React.useState('), src.lastIndexOf('React.useEffect('),
    src.lastIndexOf('React.useRef('));
  assert.ok(off > -1 && lastHook < off);
});

test('finger targets and a 16px field on touch screens', () => {
  const at = css.indexOf('.fs-project-docs');
  const coarse = css.slice(at).match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/);
  assert.ok(coarse, 'no coarse-pointer block for the section');
  assert.match(coarse[0], /min-height: 44px/);
  assert.match(coarse[0], /font-size: 16px/);
});

test('nothing renders while the first load is in flight (no flash when off)', () => {
  assert.match(src, /if \(st\.status === 'loading'\) return null;/);
  assert.doesNotMatch(src, /Loading documents/);
});

test('polling follows shouldPoll and the tab being visible', () => {
  assert.match(src, /api\(\)\.shouldPoll\(st\.documents, Date\.now\(\), visibility\)/);
  assert.match(src, /addEventListener\('visibilitychange'/);
  assert.match(src, /removeEventListener\('visibilitychange'/);
});

test('a new revision keeps the series title', () => {
  assert.match(src, /\{ seriesId: rev\.seriesId, title: rev\.title \}/);
});

test('the component showcase renders it', () => {
  const preview = fs.readFileSync(__dirname + '/../components-preview.html', 'utf8');
  assert.match(preview, /scripts\/api\/project-documents\.js/);
  assert.match(preview, /scripts\/composites\/project-documents-section\.js/);
  assert.match(preview, /<ProjectDocumentsShowcase \/>/);
});

/* Behaviour: the component rendered with React stubbed to a plain tree, the first state
   preset to a loaded list, and the real api module (statusOf etc.). */
function renderWith(listState) {
  /* The real FS.api namespace (dates are shown through its NZ helpers), live org. */
  global.window = { FieldSight: {}, FS_ENV: { useMocks: false, orgBaseUrl: 'https://x/prod/api' } };
  delete require.cache[require.resolve('../scripts/api/index.js')];
  require('../scripts/api/index.js');
  let first = true;
  global.React = {
    createElement: function (type, props) { return { type, props: props || {}, kids: [].slice.call(arguments, 2) }; },
    useState: function (init) {
      if (first) { first = false; return [listState, function () {}]; }
      return [typeof init === 'function' ? init() : init, function () {}];
    },
    useEffect: function () {},
    useRef: function () { return { current: null }; },
  };
  delete require.cache[require.resolve('../scripts/api/project-documents.js')];
  require('../scripts/api/project-documents.js');
  delete require.cache[require.resolve('../scripts/composites/project-documents-section.js')];
  require('../scripts/composites/project-documents-section.js');
  return global.window.FieldSight.ProjectDocumentsSection({ siteId: 's1' });
}
function buttons(n, out) {
  out = out || [];
  if (n == null || typeof n !== 'object') return out;
  if (Array.isArray(n)) { n.forEach(function (k) { buttons(k, out); }); return out; }
  if (n.type === 'button') out.push(n.kids.join(''));
  (n.kids || []).forEach(function (k) { buttons(k, out); });
  return out;
}
const NOW_ISO = new Date().toISOString();
function doc(id, status, extra) {
  return Object.assign({ id: id, seriesId: 'ser-' + id, revision: 2, title: 'Doc ' + id,
    filename: id + '.pdf', status: status, reason: null, uploadedByName: 'G M',
    createdAt: NOW_ISO, requestedAt: NOW_ISO }, extra || {});
}

test('an archived project (canWrite false from the server) lists with no write controls', () => {
  const tree = renderWith({ status: 'ok', canWrite: false,
    documents: [doc('a', 'indexed'), doc('b', 'error', { reason: 'x' }), doc('c', 'unreadable')] });
  const labels = buttons(tree);
  for (const write of ['Upload document', 'New revision', 'Rename', 'Delete', 'Retry']) {
    assert.ok(!labels.includes(write), write + ' rendered without canWrite');
  }
  assert.ok(labels.includes('Doc a') && labels.includes('History'), labels.join(','));
});

test('Retry is never offered for a document that cannot be read (server refuses it)', () => {
  const tree = renderWith({ status: 'ok', canWrite: true,
    documents: [doc('c', 'unreadable', { reason: 'protected' }), doc('b', 'error', { reason: 'x' })] });
  const labels = buttons(tree);
  assert.strictEqual(labels.filter(function (l) { return l === 'Retry'; }).length, 1);   // b only
  assert.ok(labels.includes('Upload document'));
});
