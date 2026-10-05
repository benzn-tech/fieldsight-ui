'use strict';

/*
 * The "+ Add section" menu has a search box, and it forgives typos (owner,
 * 2026-10-05: "safty" must find "Safety"). Instant: a pure filter over tens
 * of modules, run on every keystroke.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const LIB = read('scripts', 'pages', 'library.js');
const HTML = read('app-shell-preview.html');
const CSS = read('styles', 'composites.css');

const { fuzzySearch } = require('../scripts/fuzzy-search.js');

const MODULES = [
  { key: 'summary', title: 'Summary', purpose: 'The day in a paragraph.' },
  { key: 'safety', title: 'Safety', purpose: 'Hazards, incidents and PPE.' },
  { key: 'inspections', title: 'Inspections', purpose: 'Areas checked and the result.' },
  { key: 'visitors', title: 'Site Visitors', purpose: 'Who came on site and why.' },
  { key: 'weather', title: 'Weather', purpose: 'Filled by FieldSight.' },
];
const find = (q) => fuzzySearch(MODULES, q, (m) => [m.title, m.purpose, m.key]).map((m) => m.title);

test('THE "safty" finds Safety', () => {
  assert.deepStrictEqual(find('safty'), ['Safety']);
});

test('misspellings, half-typed words and description words all find their module', () => {
  assert.deepStrictEqual(find('inspction'), ['Inspections']);
  assert.deepStrictEqual(find('visiter'), ['Site Visitors']);
  assert.deepStrictEqual(find('wether'), ['Weather']);
  assert.deepStrictEqual(find('insp'), ['Inspections']);
  assert.deepStrictEqual(find('ppe'), ['Safety']);
});

test('a title match ranks above a description match', () => {
  assert.deepStrictEqual(find('site'), ['Site Visitors']);
  assert.strictEqual(find('summary')[0], 'Summary');
});

test('nothing close finds nothing, and an empty box shows everything', () => {
  assert.deepStrictEqual(find('xyzzy'), []);
  assert.deepStrictEqual(find('  '), MODULES.map((m) => m.title));
});

test('the menu is filtered by the box, and Enter adds the best match', () => {
  assert.match(LIB, /className: 'fs-library__module-search'/);
  assert.match(LIB, /shownModules\.map\(function \(m\)/);
  assert.match(LIB, /e\.key === 'Enter' && query && shownModules\.length[\s\S]{0,80}addModule\(shownModules\[0\]\)/);
});

test('the page loads the matcher before the library', () => {
  const fuzzy = HTML.indexOf('scripts/fuzzy-search.js?v=');
  const lib = HTML.indexOf('scripts/pages/library.js?v=');
  assert.ok(fuzzy > 0 && fuzzy < lib);
});

test('the Sections panel is full width', () => {
  const block = CSS.slice(CSS.indexOf('.fs-library__review-grid {'));
  assert.match(block.slice(0, block.indexOf('}')), /grid-template-columns: 1fr;/);
});
