'use strict';
/* A worker may create a report of their own day (spec 2026-09-15 D7); the server
   already pins them to their own folder. The timeline's Generate report control asks for
   an unscoped report:create, so the worker's self-scoped grant opens it and nothing
   crew-scoped. `scripts/roles.js` is loaded by no page; fs-globals.js is the authority. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
global.document = { addEventListener() {}, removeEventListener() {} };
require('../scripts/fs-globals.js');
const FS = global.window.FS;

test('a worker may create a report', () => {
  assert.equal(FS.can({ role: 'worker' }, FS.P('report', 'create')), true);
});

test('a worker does not pass a crew-scoped create', () => {
  assert.equal(FS.can({ role: 'worker' }, FS.P('report', 'create', FS.SCOPES.CREW)), false);
});

test('foreman and above still pass the crew gate', () => {
  for (const role of ['foreman', 'site_manager', 'project_manager']) {
    assert.equal(FS.can({ role: role }, FS.P('report', 'create', FS.SCOPES.CREW)), true, role);
  }
});

test('the timeline Generate report gate asks for an unscoped create (wiring pin)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'timeline.js'), 'utf8');
  const gate = src.match(/var canCreate = [^\n]*window\.FS\.P\('report', 'create'\)\)\);/g) || [];
  assert.equal(gate.length, 1);
});
