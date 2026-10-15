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
  assert.match(html, /scripts\/composites\/project-documents-section\.js\?v=1/);
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
