'use strict';

/*
 * An organisation template can be copied into your own library.
 *
 * The read-only note on an org template has said "To make your own version,
 * copy it to your library" since the Library moved to the server. Nothing on
 * the page did it: POST /templates/{id}/copy existed, FS.api.templates
 * .copyToPersonal existed, and no control ever called them. A site manager --
 * who may not change the company's templates -- had no way to get one they
 * could change, while the page told them there was.
 *
 * These are wiring checks: there is no React in this test runner, so the
 * behaviour (click -> copy -> opens under Personal) was verified in the browser
 * on TEST as a site manager. What is pinned here is what a later edit could
 * quietly undo -- the control, its gate, and that it reaches the store.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIBRARY = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8').replace(/\r\n/g, '\n');

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SRC = code(LIBRARY);

test('THE test: the note that promises a copy has a control beside it', () => {
  assert.match(SRC, /To make your own version, copy it to your library/);
  assert.match(SRC, /'Copy to my library'/, 'the control is on the page');
});

test('the control is offered on every organisation template, not gated on a role', () => {
  const m = SRC.match(/sel\.scope === 'org' && ctx\.handleCopy\s*\?/);
  assert.ok(m, 'gated on the template being an org one');
  const around = SRC.slice(m.index - 200, m.index + 60);
  assert.ok(!/canManageOrg|canEdit/.test(around),
    'not hidden from the people who cannot edit -- they are the ones who need it');
});

test('the handler reaches the store and opens the copy under Personal', () => {
  const start = SRC.indexOf('function handleCopy(tpl)');
  assert.ok(start >= 0, 'handleCopy exists');
  const body = SRC.slice(start, SRC.indexOf('function reload()', start));
  assert.match(body, /window\.FS\.api\.templates\.copyToPersonal\(tpl\.id\)/);
  assert.match(body, /setTab\('personal'\)/);
  assert.match(body, /setSel\(copied\)/);
  assert.match(body, /err && err\.message/, "the server's refusal is shown as worded");
});

test('the handler is in the context the detail panel reads', () => {
  assert.match(SRC, /handleActivate, reload,\s*handleCopy,/);
});
