'use strict';

/*
 * The template library does not claim to do things it does not do.
 *
 * The upload flow said "AI will extract the section structure for you", showed
 * a spinner reading "AI is extracting schema", and then presented a review
 * panel headed "Your file" with a filename and the sentence "AI read your file
 * and identified N sections".
 *
 * None of it happened. The file is checked for extension and size and then
 * dropped -- it is never read and never sent. The sections come from
 * STARTING_SECTIONS in api/template-store.js, picked by report type. The
 * "filename" was the template's own name with ".docx" glued on.
 *
 * It cost real time: the owner testing this on TEST concluded his report
 * format was wrong and set about trying different files.
 *
 * THE test is `no screen claims a file was read`. A copy fix is one commit
 * away from being undone by anybody who thinks the wording sounds flat, so the
 * claim is pinned here rather than left to reviewers to notice.
 *
 * This is NOT a rule against the word "AI". It is a rule against stating, as
 * fact, that the system did something to the user's own document. When a real
 * extraction exists, these assertions should be replaced by ones that check it
 * ran -- not deleted.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function read(...p) {
  return fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
}

const UPLOAD = read('scripts', 'composites', 'template-upload-modal.js');
const LIBRARY = read('scripts', 'pages', 'library.js');
const STORE = read('scripts', 'api', 'template-store.js');

/* Only the strings a user can read. Comments explaining the history are
   allowed to quote the old wording, and must be, or the reason it was removed
   is lost with it.

   This strips block and line comments properly rather than dropping lines that
   START with a comment marker: this repo's block comments run to several lines
   whose continuations are plain indented prose, and a line-prefix filter left
   all of them in -- which failed this file's own tests against code that was
   already correct. */
function userFacing(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: no screen claims a file was read', () => {
  for (const [name, src] of [['upload modal', UPLOAD], ['library', LIBRARY]]) {
    const visible = userFacing(src);
    assert.ok(!/read your file/i.test(visible), name + ' still says the file was read');
    assert.ok(!/AI will extract/i.test(visible), name + ' still promises an extraction');
    assert.ok(!/AI is extracting/i.test(visible), name + ' still shows an extraction in progress');
  }
});

test('the upload screen says what actually decides the sections', () => {
  assert.match(UPLOAD, /Nothing is read/);
  assert.match(UPLOAD, /starting set of sections/);
});

/* ---- the invented file card ------------------------------------------------ */

test('no filename is invented from the template name', () => {
  /* `sel.title + '.docx'` was shown as "Your file". Nothing about the chosen
     file is stored, because nothing is read from it. */
  assert.ok(!/title \+ '\.docx'/.test(userFacing(LIBRARY)),
    'the fabricated filename is back');
  assert.ok(!/'Your file'/.test(userFacing(LIBRARY)),
    'the panel that showed a file we never kept is back');
});

/* ---- the claim has to stay false-proof ------------------------------------- */

test('the file is still neither read nor sent', () => {
  /* The copy is only honest for as long as this stays true. If somebody wires
     a real extraction, this test fails and whoever does it has to come back
     and update the wording in the same change -- which is the point. */
  const visible = userFacing(UPLOAD);
  for (const api of ['FileReader', 'readAsText', 'readAsArrayBuffer',
                     '.arrayBuffer(', 'FormData', 'fetch(']) {
    assert.ok(!visible.includes(api),
      'the upload modal now touches ' + api + ' -- the copy must say so');
  }
});

test('create() is handed no file, only what the person typed', () => {
  const m = STORE.match(/function create\(data\)[\s\S]*?orgRequest\('\/templates', \{[\s\S]*?\}\)/);
  assert.ok(m, 'create() has moved');
  const body = m[0];
  assert.ok(!/file/i.test(body), 'a file now travels in the create body');
  for (const field of ['scope', 'report_type', 'name', 'description']) {
    assert.ok(body.includes(field), field + ' should still travel');
  }
});

/* ---- the starting sections are what they are ------------------------------- */

test('the starting sections are chosen by report type, not by anything read', () => {
  assert.match(STORE, /STARTING_SECTIONS\[reportType\] \|\| STARTING_SECTIONS\.daily/);
});

test('the store calls them starting points, not an extraction', () => {
  assert.match(STORE, /STARTING POINTS/);
});
