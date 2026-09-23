'use strict';

/*
 * "+ New project" was gated on user:manage, which project_manager also holds
 * (project scope, Sprint 9). The backend create_org_site only admits admin,
 * gm and platform_admin, so a PM saw the button and every submit 403'd.
 * The gate must mirror the backend: isAdmin (admin/platform_admin) or gm.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'sites.js'), 'utf8');

test('New project button is gated on admin/gm, not user:manage', () => {
  const gate = src.match(/var canCreate = [^\n]*/g) || [];
  assert.strictEqual(gate.length, 1, 'exactly one canCreate gate in sites.js');
  assert.doesNotMatch(gate[0], /user:manage/, 'user:manage also covers project_manager');
  assert.match(gate[0], /ctx\.caller\.isAdmin/);
  assert.match(gate[0], /ctx\.caller\.role === 'gm'/);
});
