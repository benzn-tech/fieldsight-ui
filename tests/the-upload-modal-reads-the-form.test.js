'use strict';

/*
 * The upload modal reads the file now (spec 2026-10-16 section 5). Its phases and the
 * calls between them are pinned at the source, the way this repo pins composites: no
 * DOM harness, and the logic that can be run lives in api/template-digitise.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'composites', 'template-upload-modal.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const LIB = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

test('THE: with a file, the modal digitises; with none, it creates from starting sections', () => {
  assert.match(SRC, /TD\.digitise\(files, title\.trim\(\)/);
  assert.match(SRC, /if \(!files\.length\) return createFromStarter\(false\)/);
});

test('reading switched off falls back to today and says nothing was read', () => {
  assert.match(SRC, /if \(result\.off\) return createFromStarter\(true\)/);
  assert.match(LIB, /nothing was read from your file/);
});

test('a refused save keeps the draft: back to review with the message', () => {
  const save = SRC.slice(SRC.indexOf('async function handleSave'), SRC.indexOf('async function handleSave') + 1200);
  assert.match(save, /catch \(e\)[\s\S]*setPhase\('review'\)[\s\S]*setErr\(/);
  assert.ok(!/setDraft\(/.test(save), 'a failed save must not replace the draft');
});

test('Save sends the mapped body as a custom template, after the same checks the server makes', () => {
  assert.match(SRC, /TD\.bodyProblem\(body\)/);
  assert.match(SRC, /report_type:\s*'custom'/);
  assert.match(SRC, /body:\s*body/);
});

test('the picker takes up to ten photos, or one PDF or Word file, and no markdown or tiff', () => {
  assert.match(SRC, /multiple:\s*true/);
  assert.ok(!/'\.md'|'\.tiff'/.test(SRC));
});

test('the reading phase copy is the spec\'s', () => {
  assert.match(SRC, /Reading your form… about half a minute/);
});

test('an unreadable form shows the server\'s reason', () => {
  assert.match(SRC, /result\.reason \|\| result\.error/);
});

/* ---- carried from the Task 8 review ------------------------------------------ */

test('Save is refused with the message numbered the way the screen numbers sections', () => {
  const save = SRC.slice(SRC.indexOf('async function handleSave'), SRC.indexOf('async function handleSave') + 1200);
  assert.match(save, /Review\.problemFor\(current\)/);
  assert.ok(save.indexOf('problemFor') < save.indexOf("setPhase('saving')"),
    'the check must run before anything is sent');
  assert.match(save, /if \(problem\) \{ setErr\(problem\.message\); return; \}/);
});

test('each read remounts the review, so a stale Undo cannot bring back an old draft', () => {
  assert.match(SRC, /key: 'read-' \+ readNo/);
  const submit = SRC.slice(SRC.indexOf('async function handleSubmit'), SRC.indexOf('async function handleSave'));
  assert.ok(submit.indexOf('setReadNo(') < submit.indexOf("setPhase('review')"),
    'the key must change with the draft it belongs to');
});

test('the two-pane review gets a wide modal, full screen on a phone, and a backdrop tap does not close it', () => {
  assert.match(SRC, /size: wide \? 'xl' : 'md'/);
  assert.match(SRC, /closeOnBackdrop: !wide/);
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles', 'composites.css'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(CSS, /\.fs-modal--xl \{ width: min\(1180px, calc\(100vw - 32px\)\)/);
  assert.match(CSS, /@media \(max-width: 600px\) \{\n  \.fs-modal--xl \{ width: 100vw; max-width: 100vw;/);
  assert.match(CSS, /\.fs-tpl-upload--wide \{ width: min\(1140px, 100%\); \}/);
});

test('no report type the server refuses is offered', () => {
  /* POST /templates answers 'incident' with a 400 (_REPORT_TYPES in lambda_org_api.py). */
  const m = SRC.match(/var REPORT_TYPES = \[([^\]]*)\]/);
  assert.ok(m, 'REPORT_TYPES has moved');
  assert.ok(!/incident/.test(m[1]));
});

test('a read that comes back after Close creates nothing', () => {
  const submit = SRC.slice(SRC.indexOf('async function handleSubmit'), SRC.indexOf('async function handleSave'));
  assert.ok(submit.indexOf('if (!alive.current) return;') < submit.indexOf('createFromStarter(true)'));
});
