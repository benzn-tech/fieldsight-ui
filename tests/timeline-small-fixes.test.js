'use strict';
/* Timeline and account fixes from owner review (2026-11-06). Pure rules run for
   real; the wiring is pinned by source scan, as elsewhere in this suite. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = { FieldSight: { PAGES: {} }, FS: {}, location: { hash: '' } };
global.React = {
  createElement: () => null, createContext: () => ({}),
  useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }),
};
global.localStorage = { getItem: () => null, setItem: () => {} };
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const { passwordFormError, passwordErrorMessage } = require('../scripts/pages/settings.js');
const { buildHelpMailto } = require('../scripts/left-nav.js');

/* ---- action item row ---- */
test('only the checkbox completes a to-do: the row is not a label', () => {
  const src = read('scripts', 'composites', 'action-item-row.js');
  assert.doesNotMatch(src, /var row = React\.createElement\('label'/);
  assert.match(src, /var row = React\.createElement\('div', \{ className: className \}/);
  const check = src.slice(src.indexOf("className: 'fs-action-item-row__check'"));
  const box = check.indexOf("type:      'checkbox'");
  const main = check.indexOf('fs-action-item-row__main');
  assert.ok(box > 0 && box < main, 'checkbox sits in the label, before the text');
  assert.match(check.slice(box, main), /\}\)\),\n/, 'the label closes before the text starts');
});

test('clicking a to-do in a card opens the topic where it can be edited', () => {
  const src = read('scripts', 'composites', 'topic-card.js');
  const b = src.slice(src.indexOf('function onBodyClick'), src.indexOf('var participants ='));
  assert.doesNotMatch(b, /\.fs-action-item-row/);
  assert.match(b, /input, label/, 'the checkbox still does not select the topic');
});

test('the detail panel edits the due date through the authorised PATCH', () => {
  const src = read('scripts', 'pages', 'timeline.js');
  const start = src.indexOf('function OverviewTab(');
  const b = src.slice(start, src.indexOf('flags.length > 0', start));
  assert.match(b, /api\.updateAction\(a\.id, \{ deadline: next \}\)/);
  assert.match(b, /window\.FieldSight\.DateField, \{\s*size: 'sm', value: dueOf\(a\)/);
  assert.match(b, /resolveDeadline\(a\.deadline, props\.date\)\.absolute/,
    'free text never reaches DateField');
});

test('the row caption follows a saved owner and due date', () => {
  const src = read('scripts', 'pages', 'timeline.js');
  assert.match(src, /owners\[a\.id\] !== undefined\) displayAction = Object\.assign\(\{\}, displayAction, \{ responsible:/);
  assert.match(src, /dues\[a\.id\] !== undefined\) displayAction = Object\.assign\(\{\}, displayAction, \{ deadline:/);
});

/* ---- came up again ---- */
test('Came up again starts collapsed to one line', () => {
  const src = read('scripts', 'pages', 'timeline.js');
  assert.match(src, /createElement\('details', \{ className: 'fs-timeline-page__threads' \}/);
  assert.doesNotMatch(src, /createElement\('details', \{ className: 'fs-timeline-page__threads', open/);
  assert.match(src, /createElement\('summary', \{ className: 'fs-timeline-page__section-label' \},\s*'Came up again · '/);
});

/* ---- recorder sign-in copy ---- */
test('QR sign-in says recorder, and says which device scans', () => {
  const modal = read('scripts', 'composites', 'qr-login-modal.js');
  const settings = read('scripts', 'pages', 'settings.js');
  for (const src of [modal, settings]) assert.doesNotMatch(src, /Log in a terminal/);
  assert.match(modal, /On the recorder, tap .Scan QR to Sign in./,
    'the quoted label must stay the button text on the device');
  assert.match(settings, /Show a QR code for your FieldSight recorder to scan\./);
});

/* ---- change password ---- */
test('no account control reports success without doing anything', () => {
  const src = read('scripts', 'pages', 'settings.js');
  assert.doesNotMatch(src, /Password updated \(demo\)/);
  assert.doesNotMatch(src, /Two-factor authentication/);
  assert.doesNotMatch(src, /toggle2FA/);
  assert.match(src, /window\.FS\.cognito\.changePassword\(/);
});

test('the Cognito call sends the three fields ChangePassword requires', () => {
  const src = read('scripts', 'auth', 'cognito.js');
  const b = src.slice(src.indexOf('async function changePassword'));
  assert.match(b, /idpCall\('ChangePassword', \{\s*AccessToken:\s+token,\s*PreviousPassword: currentPassword,\s*ProposedPassword: newPassword,/);
  assert.match(src, /changePassword: changePassword/);
});

test('passwordFormError: what may be submitted', () => {
  assert.ok(passwordFormError('', 'b', 'b'));
  assert.ok(passwordFormError('a', '', ''));
  assert.match(passwordFormError('a', 'b', 'c'), /do not match/);
  assert.match(passwordFormError('a', 'a', 'a'), /different/);
  assert.strictEqual(passwordFormError('a', 'b', 'b'), null);
});

test('passwordErrorMessage: Cognito codes in words, unknown keeps the service text', () => {
  assert.match(passwordErrorMessage({ code: 'NotAuthorizedException', message: 'Incorrect username or password.' }), /current password is not correct/);
  assert.strictEqual(passwordErrorMessage({ code: 'InvalidPasswordException', message: 'Must have a number' }), 'Must have a number');
  assert.match(passwordErrorMessage({ code: 'LimitExceededException' }), /Too many attempts/);
  assert.strictEqual(passwordErrorMessage({ code: 'Other', message: 'Boom' }), 'Boom');
  assert.match(passwordErrorMessage(null), /Could not change/);
});

/* ---- contact ---- */
test('help mail goes to the real address with the context, and no query string', () => {
  const url = buildHelpMailto({ name: 'Sam Lee' }, '/timeline?q=secret&token=abc');
  assert.ok(url.startsWith('mailto:sales@fieldsightai.com?subject='));
  const body = decodeURIComponent(url.split('&body=')[1]);
  assert.match(body, /Name: Sam Lee/);
  assert.match(body, /Page: \/timeline\n?$/);
  assert.doesNotMatch(url, /secret|abc/);
});

test('help mail tolerates a missing user and route', () => {
  assert.match(decodeURIComponent(buildHelpMailto(null, null)), /Name: \n/);
});
