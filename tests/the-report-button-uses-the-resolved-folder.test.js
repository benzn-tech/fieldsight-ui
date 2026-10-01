'use strict';

/*
 * Generate report on the Timeline opened a modal whose preview answered 404
 * for Ben_Lin_test2's day (TEST, 2026-10-01): the button was handed a folder
 * folded from the display name ("Ben Lin" -> Ben_Lin, nobody's day), the same
 * guess ui#381 removed from the page's own identity chain.
 *
 * THE test is `the report button is given the folder the server resolved`.
 * Also here: the template picker shows that it is a picker, and the fields a
 * template report never reads say so.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TIMELINE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'timeline.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const MODAL = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'composites', 'session-report-modal.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function block(src, start) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, start + ' has moved');
  return src.slice(i, src.indexOf('});', i));
}

test('THE: the report button is given the folder the server resolved', () => {
  const props = block(TIMELINE, 'React.createElement(GenerateReportButton, {');
  const line = props.split('\n').find((l) => /^\s*userFolder:/.test(l));
  assert.ok(line, 'GenerateReportButton has no userFolder');
  assert.match(line, /userFolder:\s+user \|\| null,/);
  assert.doesNotMatch(line, /folderName|user_name|_draftUserFolder/);
});

test('the template picker carries the select chevron', () => {
  const chooser = MODAL.slice(MODAL.indexOf('function TemplateChooser'), MODAL.indexOf('function FillStep'));
  assert.match(chooser, /fs-field__control fs-field__control--select/);
  assert.match(chooser, /fs-field__select-chevron/);
});

test('fields only the standard report reads are disabled, with the reason, under a template', () => {
  const fill = MODAL.slice(MODAL.indexOf('function FillStep'), MODAL.indexOf('function DeliveryChooser'));
  assert.match(fill, /var templated = !!form\.templateId;/);
  assert.strictEqual((fill.match(/disabled: templated,/g) || []).length, 3);
  assert.match(fill, /used by the standard report only/);
});
