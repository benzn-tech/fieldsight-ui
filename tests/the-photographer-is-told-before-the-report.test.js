'use strict';

/*
 * Owner, 2026-10-01: the person who took the photographs -- nobody else -- is
 * told before the report: at 50 that past 60 they go in smaller, and past 120
 * that they must choose. A bell row (never a toast), from GET
 * /api/org/photos/notice, which reads the caller's own folder; the row's
 * "Choose" opens the same choice the report dialog offers.
 *
 * THE test is `a notice that needs a choice opens the choice for that day`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const BELL = read('scripts/composites/notification-bell.js');
const SHELL = read('scripts/app-shell.js');
const HTML = read('app-shell-preview.html');
const DIALOG = read('scripts/composites/photo-choice-dialog.js');
const MODAL = read('scripts/composites/session-report-modal.js');

function loadStore() {
  const window = {};
  // eslint-disable-next-line no-new-func
  new Function('window', read('scripts/api/photo-notice.js'))(window);
  return window.FS.photoNotice;
}

test('THE: a notice that needs a choice opens the choice for that day', () => {
  assert.match(BELL, /n\.level === 'choose'/);
  assert.match(BELL, /new CustomEvent\('fs:open-photo-choice', \{\s*detail: \{ date: n\.date, folder: n\.folder \},/);
  assert.match(DIALOG, /window\.addEventListener\('fs:open-photo-choice', onOpen\)/);
  assert.match(MODAL, /window\.FieldSight\.PhotoChoiceStep = PhotoChoiceStep;/);
});

test('the notices count on the bell', () => {
  assert.match(BELL, /count \+= photoNotices\.length;/);
});

test('each level says what will happen', () => {
  const store = loadStore();
  assert.match(store.words({ date: '2026-10-01', included: 52, level: 'approaching' }), /Past 60 they go into the report smaller/);
  assert.match(store.words({ date: '2026-10-01', included: 84, level: 'smaller' }), /smaller so all fit/);
  assert.match(store.words({ date: '2026-10-01', included: 130, level: 'choose' }), /choose which to leave out/);
});

test('the dialog is mounted and loaded after what it renders', () => {
  assert.match(SHELL, /React\.createElement\(window\.FieldSight\.PhotoChoiceDialog\)/);
  assert.ok(HTML.indexOf('photo-choice-dialog.js') > HTML.indexOf('session-report-modal.js'));
  assert.ok(HTML.indexOf('scripts/api/photo-notice.js') > HTML.indexOf('scripts/api/index.js'),
    'api/index.js replaces FS.api wholesale; the store must load after it');
});

test('the dialog cannot save more than a report holds', () => {
  assert.match(DIALOG, /disabled: !sel \|\| included > max \|\| busy,/);
});
