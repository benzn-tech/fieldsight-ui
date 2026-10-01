'use strict';

/*
 * "Download report" is a link styled as a button. It carried a variant and no
 * size, so it had neither the footer's 40px height nor its padding, and the
 * step's column layout stretched it across the dialog (owner, 2026-10-01).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODAL = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'composites', 'session-report-modal.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles', 'composites.css'), 'utf8');

test('the download link has the Done button size and only its own width', () => {
  const at = MODAL.indexOf("'Download report'");
  const link = MODAL.slice(MODAL.lastIndexOf("h('a', {", at), at);
  assert.match(link, /className: 'fs-btn fs-btn--md fs-btn--primary fs-srm__download'/);
  assert.match(CSS, /\.fs-srm__download \{ align-self: flex-start; \}/);
});
