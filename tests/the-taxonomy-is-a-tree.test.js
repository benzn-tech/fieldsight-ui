'use strict';

/*
 * The taxonomy, as the screen needs it.
 *
 * The backend sends a FLAT list of tags (GET /api/org/tags), each with a
 * `parent_id` and a `scope` of 'global' | 'company' | 'site'. Two levels, no
 * deeper. Turning that into the tree a reader sees is pure, so it is tested
 * here rather than discovered in a render.
 *
 * What the shape has to protect:
 *
 *  - a child whose parent is missing from the payload is STILL SHOWN. The
 *    parent can be absent for a real reason (deactivated, or belonging to a
 *    site this caller cannot reach) and a child that silently disappears is
 *    how a company loses half its vocabulary with nothing to look at.
 *  - `scope` travels, because 'global' is the one a customer may not edit and
 *    the screen has to be able to say so.
 *  - order is the backend's, not the alphabet's: sort_order is a choice
 *    somebody made.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = { FieldSight: {}, FS: { api: {} } };
const { asTree } = require('../scripts/api/tags.js');

const T = (id, slug, label, parent, scope, order) => ({
  id: id, slug: slug, label: label, parent_id: parent || null,
  scope: scope || 'global', is_active: true, sort_order: order || 0,
  site_id: null,
});

const FLAT = [
  T('1', 'architecture', 'Architecture', null, 'global', 20),
  T('2', 'structure', 'Structure', null, 'global', 10),
  T('1a', 'architecture.walls', 'Walls', '1', 'global', 10),
  T('1b', 'architecture.ceilings', 'Ceilings', '1', 'global', 20),
  T('2a', 'structure.slab', 'Slab', '2', 'global', 10),
];

test('each level is ordered by sort_order, not by payload order', () => {
  /* The payload lists architecture (20) before structure (10). It comes back
     the other way round because sort_order is the choice somebody made. This
     assertion found a real defect: the backend's first ORDER BY grouped each
     parent with its children via COALESCE(parent_id::text, id::text), which
     ordered the GROUPS by a uuid rendered as text. */
  const tree = asTree(FLAT);
  assert.deepStrictEqual(tree.map((n) => n.slug), ['structure', 'architecture']);
});

test('children hang off their parent, in their own order', () => {
  const tree = asTree(FLAT);
  const arch = tree.find((n) => n.slug === 'architecture');
  assert.deepStrictEqual(arch.children.map((c) => c.label), ['Walls', 'Ceilings']);
});

test('a parent with no children still renders as a parent', () => {
  const tree = asTree([T('9', 'prefab', 'Prefab', null, 'company', 5)]);
  assert.strictEqual(tree.length, 1);
  assert.deepStrictEqual(tree[0].children, []);
});

test('a child whose parent is missing is shown, not dropped', () => {
  /* The parent can be absent for real reasons — deactivated, or on a site
     this caller cannot reach. Dropping the child would take a company's
     vocabulary off the screen with nothing to indicate it happened. */
  const tree = asTree([T('1a', 'architecture.walls', 'Walls', 'gone', 'company', 10)]);
  const slugs = tree.map((n) => n.slug);
  assert.ok(slugs.includes('architecture.walls'), slugs);
});

test('every tag in, every tag out', () => {
  const tree = asTree(FLAT);
  const seen = tree.reduce((a, n) => a.concat([n], n.children), []);
  assert.strictEqual(seen.length, FLAT.length);
});

test('scope travels, so the screen can say what is not editable', () => {
  const tree = asTree([
    T('1', 'safety', 'Safety', null, 'global', 10),
    T('9', 'prefab', 'Prefab', null, 'company', 20),
  ]);
  assert.deepStrictEqual(tree.map((n) => n.scope), ['global', 'company']);
});

test('nothing at all is an empty tree, not a crash', () => {
  assert.deepStrictEqual(asTree([]), []);
  assert.deepStrictEqual(asTree(null), []);
  assert.deepStrictEqual(asTree(undefined), []);
});

test('a tag that claims itself as its own parent does not hang the render', () => {
  /* Not a shape the backend can produce today (parent_id is set at create and
     the slug prefix is checked), but a cycle here is an infinite loop in a
     recursive renderer, and the cost of not being able to is one guard. */
  const tree = asTree([T('1', 'x', 'X', '1', 'company', 0)]);
  assert.strictEqual(tree.length, 1);
  assert.deepStrictEqual(tree[0].children, []);
});

/* ---- wiring pins (source scan — these pin CONNECTIONS, not behaviour) ---- */

const fsmod = require('node:fs');
const pathmod = require('node:path');
const read = (...p) =>
  fsmod.readFileSync(pathmod.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

test('Settings offers a Taxonomy tab and renders it from the real reader', () => {
  const src = read('scripts', 'pages', 'settings.js');
  assert.match(src, /\{ key: 'taxonomy',\s+label: 'Taxonomy' \}/);
  assert.match(src, /ctx\.tab === 'taxonomy'/, 'the tab is routed');
  assert.match(src, /window\.FS\.api\.tags/, 'and backed by the real module');
  assert.match(src, /api\.asTree\(/, 'through the tested tree builder');
});

test('api/tags.js loads AFTER api/index.js, which assigns FS.api wholesale', () => {
  /* CLAUDE.md's first load-order trap: a module registering onto FS.api from a
     script tag placed before that assignment is silently wiped — no error at
     load, just `Cannot read properties of undefined` from the first consumer.
     Asserted on the ORDER, because the failure is invisible in any unit test. */
  const html = read('app-shell-preview.html');
  assert.ok(html.indexOf('scripts/api/index.js') < html.indexOf('scripts/api/tags.js'),
    'api/tags.js is registered before FS.api is assigned and will be wiped');
});

test('the mock teaches the payload the route actually emits', () => {
  /* `scope`, never `company_id`: lambda_org_api._tag_payload sends the first
     and not the second. A fixture that invents a different shape is how a
     client gets written against a payload that does not exist. */
  const fx = read('scripts', 'mock', 'tags.fixture.js');
  assert.match(fx, /scope: 'global'/);
  assert.match(fx, /scope: 'company'/);
  assert.match(fx, /scope: 'site'/);
  assert.doesNotMatch(fx, /company_id:/);
  assert.match(fx, /is_active: false/, 'one row must be off, or nothing tests the filter');
});
