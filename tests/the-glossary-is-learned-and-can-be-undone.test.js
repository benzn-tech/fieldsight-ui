'use strict';

/*
 * Owner, 2026-10-02: the glossary learns from people's own corrections (no
 * confirm prompt); an admin can see every entry and undo it. Pipeline #1018:
 * the save response carries `learned`, GET/DELETE /api/org/aliases.
 *
 * THE test is `a learned correction is announced, not asked about`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const TIMELINE = read('scripts/pages/timeline.js');
const SETTINGS = read('scripts/pages/settings.js');
const ACTIONS = read('scripts/api/actions.js');

test('THE: a learned correction is announced, not asked about', () => {
  assert.match(TIMELINE, /res\.learned && res\.learned\.length/);
  assert.match(TIMELINE, /'Added to glossary: '/);
  assert.match(TIMELINE, /false && candidates\.length > 0 \? React\.createElement\(GlossaryConfirm/);
});

test('the Glossary tab is for admins and GMs only', () => {
  const m = SETTINGS.match(/var TABS = \[[\s\S]*?\];/)[0];
  // eslint-disable-next-line no-new-func
  const TABS = new Function(m + ' return TABS;')();
  const g = TABS.find((t) => t.key === 'glossary');
  assert.deepStrictEqual(g.roles, ['admin', 'gm', 'platform_admin']);
  assert.match(SETTINGS, /visibleTabs\(\)\.map\(function \(t\)/);
});

test('the list is read and an entry undone through the API layer', () => {
  assert.match(ACTIONS, /orgRequest\('\/aliases'\)/);
  assert.match(ACTIONS, /orgRequest\('\/aliases\/' \+ encodeURIComponent\(id\),\s*\{ method: 'DELETE', retry: false \}\)/);
  assert.match(ACTIONS, /listAliases: listAliases,/);
  assert.match(ACTIONS, /retireAlias: retireAlias,/);
  assert.match(SETTINGS, /api\.retireAlias\(a\.id\)/);
});
