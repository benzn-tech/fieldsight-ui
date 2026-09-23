'use strict';

/*
 * A new field on a section has to survive four hops, and this file is about the
 * one that has swallowed a field before.
 *
 *   the checkbox -> the editor's own section state (tagKeys)
 *                -> sectionsToSchema
 *                -> the api layer's toBackendSection
 *                -> the server
 *
 * `sectionsToSchema` REBUILDS each section from a literal:
 *
 *     var out = { title: s.title, kind: s.kind, fields: s.fields, ... };
 *
 * A field missing from that literal is not an error and produces no symptom in
 * the page: the checkbox stays ticked, because the page renders its own state,
 * which still has the field. Only the report disagrees, days later, and the
 * person reporting it says "I ticked the box and nothing happened" -- which
 * sounds like a backend fault and is not one.
 *
 * That exact shape has already cost this line one round trip (a field the
 * component added was dropped by the api layer's whitelist, and the fix was
 * verified by reading the request in the browser, not the source).
 *
 * THE test is `a ticked box is still ticked after a round trip through
 * sectionsToSchema`. It is deliberately a round trip and not an assertion about
 * the literal: a test that greps the source for the field name would pass on
 * code that carried it and then dropped it one line later.
 *
 * `kind` is checked here too, for a different reason: `photos` has just been
 * removed from the dropdown because nothing in the generated-report path
 * inserts an image and the server now refuses the value. An option that cannot
 * be saved must not be offerable.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function lift(name, src) {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}'));
  assert.ok(m, name + ' has moved or been renamed');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn ' + name + ';')();
}

const sectionsToSchema = lift('sectionsToSchema', SRC);

/* A section as the editor holds it while someone is typing. */
function editorSection(over) {
  return Object.assign({
    title: 'Daily Summary',
    kind: 'list',
    fields: [],
    prompt_hint: 'Only the camera and GoPro discussion.',
    always_present: false,
    children: [],
    _key: 3,
  }, over || {});
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: a ticked box is still ticked after a round trip', () => {
  const schema = sectionsToSchema([editorSection({ always_present: true })]);
  assert.strictEqual(schema.sections[0].always_present, true);
});

test('an unticked box travels as false rather than as absent', () => {
  /* Absent and false mean the same thing to the server, but only one of them
     can overwrite a previously-saved true. */
  const schema = sectionsToSchema([editorSection({ always_present: false })]);
  assert.strictEqual(schema.sections[0].always_present, false);
});

test('a sub-section carries it too', () => {
  const parent = editorSection({
    children: [editorSection({ title: 'Deliveries', always_present: true })],
  });
  const child = sectionsToSchema([parent]).sections[0].children[0];
  assert.strictEqual(child.always_present, true);
});

test('the description and the kind still travel, which is what it rode in on', () => {
  const s = sectionsToSchema([editorSection()]).sections[0];
  assert.strictEqual(s.prompt_hint, 'Only the camera and GoPro discussion.');
  assert.strictEqual(s.kind, 'list');
  assert.strictEqual(s.title, 'Daily Summary');
});

/* ---- the api layer, which is the hop that dropped a field before ----------- */

test('the api layer does not rebuild the section from a shorter list', () => {
  const api = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'api', 'template-store.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const m = api.match(/function toBackendSection\([\s\S]*?\n  \}/);
  assert.ok(m, 'toBackendSection has moved');
  assert.match(m[0], /Object\.assign\(\{\}, s\)/,
    'it copies the section rather than listing the fields it knows about; a '
    + 'field added to the editor must not need a second edit here to survive');
});

/* ---- the option that cannot be saved --------------------------------------- */

test('Photos is not offered, because the server refuses it', () => {
  const m = SRC.match(/var KIND_LABEL = \{[^}]*\}/);
  assert.ok(m, 'KIND_LABEL has moved');
  assert.ok(!/photos/i.test(m[0]),
    'nothing in the generated-report path inserts an image');
  for (const kept of ['narrative', 'list', 'table', 'kpi']) {
    assert.ok(m[0].includes(kept), kept + ' makes the document do something and stays');
  }
});

test('the Test render no longer draws photos the report cannot produce', () => {
  assert.ok(!/case 'photos':/.test(SRC),
    'the preview drawing something the output cannot is how this started');
});

test('the checkbox asks for a heading, not for content on an empty day', () => {
  /* The wording is the feature. "Always produce this list even if the day was
     quiet" is the sentence a customer wrote when they had no checkbox, and it
     beat the house rule that says to write "Nothing here." Rebuilding that
     request with our name on it would be worse than leaving it in free text,
     because it would look sanctioned. */
  assert.match(SRC, /Always show this heading/);
  assert.ok(!/Always produce/i.test(SRC));
});
