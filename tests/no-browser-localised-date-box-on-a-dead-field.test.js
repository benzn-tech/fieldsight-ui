'use strict';

/*
 * "Planned completion" showed `年/月/日` to a reader whose Chrome is set to
 * Chinese. That text is not in this repository: a native `<input type="date">`
 * is drawn BY THE BROWSER in the browser's own locale, and Chrome takes that
 * from its UI language, not from the document's `lang` attribute (there is no
 * root index.html here to carry one in any case).
 *
 * So the field could not be translated -- it had to stop being a date picker.
 * Which costs nothing, because against the real backend the control is already
 * `disabled` and carries UNSAVED_HINT: `sites` has had no planned_completion
 * column since 0002_core_relational.sql, and createOrgSite does not send one.
 * A disabled control that stores nothing has no business owning a locale.
 *
 * The picker stays in mock mode, where the field does hold a value.
 *
 * This file reads the source, because sites.js is an IIFE with no export and
 * this repo has no DOM harness. It therefore pins the WIRING, not a render --
 * stated plainly so nobody mistakes it for a behavioural test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'sites.js'), 'utf8');

/* The whole `fFieldRow('Planned completion', ...)` call, so the assertions
   below cannot accidentally match some other field's options. */
function plannedCompletionRow() {
  const start = SRC.indexOf("fFieldRow('Planned completion'");
  assert.notStrictEqual(start, -1, "the field must still exist -- if it was renamed, "
    + 'rename it here too rather than deleting this guard');
  const end = SRC.indexOf('fFieldRow(', start + 10);
  return SRC.slice(start, end === -1 ? SRC.length : end);
}

test('the disabled field is not a native date input, so no browser locale can reach it', () => {
  const row = plannedCompletionRow();
  // The exact shape that shipped the bug: 'date' as a bare third argument.
  assert.ok(!/\},\s*'date'\s*,/.test(row) && !/\),\s*'date'\s*,/.test(row),
    "'date' must never be passed unconditionally -- that is what rendered "
    + '年/月/日. Got:\n' + row);
  assert.match(row, /unsaved\s*\?\s*'text'\s*:\s*'date'/,
    'live (unsaved) must be plain text; mock mode keeps the real picker');
});

test('it says its format in English rather than relying on the browser', () => {
  const row = plannedCompletionRow();
  assert.match(row, /placeholder:\s*unsaved\s*\?\s*'YYYY-MM-DD'/,
    'a disabled empty text box with no hint says less than the date input did, '
    + 'so the format has to be stated -- in English, by us');
});

test('fText actually forwards a placeholder, or the option above is dead', () => {
  // The api-layer trap in miniature: an option a caller passes and the helper
  // never reads is silently dropped, and the assertion above would still pass
  // while the user saw nothing.
  const start = SRC.indexOf('function fText(');
  assert.notStrictEqual(start, -1);
  const body = SRC.slice(start, SRC.indexOf('\n  }', start));
  assert.match(body, /placeholder:\s*opts\.placeholder/,
    'fText must pass opts.placeholder through to the input element');
});

test('the field is still disabled and still says it does not persist', () => {
  // Guards the premise of this whole change. If someone makes the field real
  // (a planned_completion column, and createOrgSite sending it), the right fix
  // is a proper date control and this file should be revisited -- not quietly
  // left asserting a plain text box over a field that now saves.
  const row = plannedCompletionRow();
  assert.match(row, /disabled:\s*unsaved/,
    'if this field now persists, revisit this guard rather than deleting it');
  assert.match(row, /unsaved\s*\?\s*UNSAVED_HINT\s*:\s*null/,
    'the hint explaining why it is dead must stay with it');
});

test('no OTHER field in this form hands the browser a date box to localise', () => {
  // Found by this change; pinned so the next date field does not reintroduce it.
  const dateInputs = SRC.match(/'date'/g) || [];
  assert.strictEqual(dateInputs.length, 1,
    "only Planned completion's conditional type may mention 'date'. A new native "
    + 'date input will show its own locale too -- give it the same treatment. '
    + 'Found ' + dateInputs.length + " occurrences of 'date'.");
});
