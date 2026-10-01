'use strict';

/*
 * The Library's right column is a fixed-height, scrolling flex column. Its
 * children used to shrink when the editor overflowed, and Test render -- the
 * one with overflow:hidden, so no content floor -- took all of the shrink and
 * vanished (owner, 2026-10-02; measured in the browser against the dev
 * stylesheet: 365px of panel squeezed to 128px by a 700px editor).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles', 'composites.css'), 'utf8');

test('the right column scrolls and its parts keep their height', () => {
  const right = CSS.match(/\.fs-library__right \{[^}]*\}/)[0];
  assert.match(right, /overflow-y: auto;/);
  assert.match(right, /flex-direction: column;/);
  assert.match(CSS, /\.fs-library__right > \* \{ flex-shrink: 0; \}/);
});
