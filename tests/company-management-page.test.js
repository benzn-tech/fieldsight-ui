'use strict';

/*
 * WIRING ONLY -- sites.js is an IIFE with no export and this repo has no DOM
 * harness. The api behaviour is pinned in company-management-api.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'sites.js'), 'utf8');

test('the company controls are gated on isCrossCompany, not isAdmin or gm', () => {
  assert.match(SRC, /var mayManageCompanies = !!\(orgApi && orgApi\.isCrossCompany && orgApi\.isCrossCompany\(ctx\.caller\)\) && orgLive\(\);/);
  assert.match(SRC, /mayManageCompanies \? React\.createElement\('button'[\s\S]{0,200}'\+ New company'/);
  assert.match(SRC, /mayManageCompanies \? React\.createElement\('button'[\s\S]{0,200}'Manage companies'/);
});

test('creating a company goes through the api layer', () => {
  assert.match(SRC, /orgApi\.createCompany\(\{ name: name \}\)/);
});

test('renaming goes through the api layer', () => {
  assert.match(SRC, /orgApi\.renameCompany\(row\.id, \{ name: draft \}\)/);
});

test('the management list reads the directory, not the sites', () => {
  assert.match(SRC, /orgApi\.listCompanies\(\)/);
});

test('a taken name offers the existing company instead of a dead end', () => {
  assert.match(SRC, /'Create a project in ' \+ taken\.name/);
});

test('a new project can open with a company already chosen', () => {
  assert.match(SRC, /company_id: props\.initialCompanyId \|\| ''/);
});
