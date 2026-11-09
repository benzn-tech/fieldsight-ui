'use strict';

/*
 * Action pack page wiring (spec 2026-11-10-action-pack-page-design.md §5.4, §10).
 * platform_admin only while ACTION_PACKS=internal: a company admin passes every
 * permission check, so the role itself decides (canSeeNav platformAdminOnly).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

test('only the platform admin sees Action packs', () => {
  global.window = {};
  delete require.cache[require.resolve('../scripts/fs-globals.js')];
  require('../scripts/fs-globals.js');
  const FS = global.window.FS;
  assert.strictEqual(FS.NAV_ITEMS.actionPacks.path, '/action-packs');
  assert.strictEqual(FS.NAV_ITEMS.actionPacks.platformAdminOnly, true);
  assert.strictEqual(FS.canSeeNav('actionPacks', { role: 'platform_admin', isAdmin: true }), true);
  assert.strictEqual(FS.canSeeNav('actionPacks', { role: 'admin', isAdmin: true }), false);
  assert.strictEqual(FS.canSeeNav('actionPacks', { role: 'gm' }), false);
  assert.strictEqual(FS.canSeeNav('actionPacks', 'platform_admin'), false, 'a bare role string is not a session');
});

test('script tags: api after api/index.js, page as text/babel, stylesheet linked', () => {
  const html = read('app-shell-preview.html');
  const idx = html.indexOf('scripts/api/index.js');
  const apiTag = html.search(/<script src="scripts\/api\/action-packs\.js\?v=\d+"><\/script>/);
  assert.ok(idx > 0 && apiTag > idx, 'action-packs.js must load after api/index.js (which replaces FS.api)');
  assert.match(html, /<script type="text\/babel" src="scripts\/pages\/action-packs\.js\?v=\d+"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="styles\/action-packs\.css\?v=\d+" \/>/);
  assert.ok(fs.existsSync(path.join(ROOT, 'styles', 'action-packs.css')));
});

test('left nav lists actionPacks with an icon', () => {
  const nav = read('scripts', 'left-nav.js');
  assert.match(nav, /actionPacks: 'sparkles'/);
  assert.match(nav, /items: \['sites', 'team', 'trace', 'decisionReview', 'actionPacks'\]/);
});

test("the page registers PAGES['/action-packs']", () => {
  global.window = { FieldSight: {} };
  delete require.cache[require.resolve('../scripts/pages/action-packs.js')];
  require('../scripts/pages/action-packs.js');
  const page = global.window.FieldSight.PAGES['/action-packs'];
  assert.ok(page && typeof page.Middle === 'function');
  assert.strictEqual(page.layout, 'full-width');
});
