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
 *
 * 2026-10-16: a real extraction exists (template digitise). The assertions that the
 * modal says "Nothing is read" are REPLACED below by ones that check the reading
 * claim is made only on the path that actually read the file -- the rule this file
 * exists for, unchanged.
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

test('the reading claim is made only on the path that read the file', () => {
  /* "Reading your form" appears only in the phase entered after the server ACCEPTED
     the read (api/template-digitise.js fires onPhase('reading') after the request
     returned), and the off fallback says nothing was read. */
  assert.match(UPLOAD, /phase === 'reading'\s+\? 'Reading your form… about half a minute'/);
  const TD = read('scripts', 'api', 'template-digitise.js');
  const flow = TD.slice(TD.indexOf('async function digitise('));
  assert.ok(flow.indexOf("onPhase('reading')") > flow.indexOf('await startRead('),
    'the screen would claim to read a form before the server accepted it');
  assert.match(LIBRARY, /nothing was read from your file/);
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

test('the file travels only through the reading path', () => {
  /* Until 2026-10-16 this test said the file was neither read nor sent, and the
     copy was honest only while that held. The file IS sent now -- but only by
     api/template-digitise.js, the path whose phases the screen reports. The modal
     itself still opens nothing, and the starter path is handed no file. */
  const visible = userFacing(UPLOAD);
  for (const api of ['FileReader', 'readAsText', 'readAsArrayBuffer',
                     '.arrayBuffer(', 'FormData', 'fetch(']) {
    assert.ok(!visible.includes(api),
      'the upload modal now touches ' + api + ' itself -- route it through api/template-digitise.js');
  }
  const starter = UPLOAD.slice(UPLOAD.indexOf('async function createFromStarter'),
                               UPLOAD.indexOf('async function handleSubmit'));
  assert.ok(starter.includes('templates.create('), 'the starter path has moved');
  assert.ok(!/files/.test(starter), 'the starter path now sends the file -- the off toast would be a lie');
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
