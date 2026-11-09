'use strict';

/*
 * Contact FieldSight window (spec 2026-11-08 contact-fieldsight, plan task 6).
 * The pure rules run for real; the wiring (nav, AppShell mount, script order,
 * styles) is pinned by source scan, as elsewhere in this suite.
 *
 * Review focus pinned here:
 *  #4 microphone denied / MediaRecorder unsupported -> one line of copy, and
 *     typing and sending still work (canSend does not need a recording).
 *  #5 backend flag off while this code is live -> Send keeps the window open
 *     and offers "Email us instead", whose mailto carries the typed text.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = { FieldSight: { PAGES: {} }, FS: {}, location: { hash: '', href: '' } };
global.React = {
  createElement: () => null, createContext: () => ({}),
  useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }),
};
global.localStorage = { getItem: () => null, setItem: () => {} };
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const cw = require('../scripts/composites/contact-window.js');
const nav = require('../scripts/left-nav.js');

test('pickMime prefers webm opus then mp4 then null', () => {
  assert.strictEqual(cw.pickMime(() => true), 'audio/webm;codecs=opus');
  assert.strictEqual(cw.pickMime((m) => m === 'audio/mp4'), 'audio/mp4');
  assert.strictEqual(cw.pickMime(() => false), null);
  assert.strictEqual(cw.pickMime(null), null);
  assert.strictEqual(cw.pickMime(() => { throw new Error('nope'); }), null);
});

test('canSend needs text or recording and not sending', () => {
  assert.strictEqual(cw.canSend({ text: '', blob: null, sending: false }), false);
  assert.strictEqual(cw.canSend({ text: '   \n', blob: null, sending: false }), false);
  assert.strictEqual(cw.canSend({ text: 'Hi', blob: null, sending: false }), true);
  assert.strictEqual(cw.canSend({ text: '', blob: {}, sending: false }), true);
  assert.strictEqual(cw.canSend({ text: 'Hi', blob: {}, sending: true }), false);
});

test('appendTranscript separators', () => {
  assert.strictEqual(cw.appendTranscript('', 'spoken words'), 'spoken words');
  assert.strictEqual(cw.appendTranscript('   ', 'spoken words'), 'spoken words');
  assert.strictEqual(cw.appendTranscript('typed', 'spoken words'), 'typed\n\nspoken words');
  assert.strictEqual(cw.appendTranscript('typed\n', 'spoken words'), 'typed\n\nspoken words');
  assert.strictEqual(cw.appendTranscript('typed', ''), 'typed');
});

test('fallbackMailto contains typed text and no query string', () => {
  const url = cw.fallbackMailto({ name: 'Sam Lee' }, '/timeline?q=secret&token=abc', 'The gate is broken');
  assert.ok(url.startsWith('mailto:sales@fieldsightai.com?subject='));
  const body = decodeURIComponent(url.split('&body=')[1]);
  assert.ok(body.startsWith('The gate is broken\n'), 'typed text is at the top');
  assert.match(body, /Name: Sam Lee/);
  assert.match(body, /Page: \/timeline\n?$/);
  assert.doesNotMatch(url, /secret|abc/);
});

test('fallbackMailto with no text is exactly the existing help mailto', () => {
  assert.strictEqual(cw.fallbackMailto({ name: 'Sam' }, '/today?x=1', ''), nav.buildHelpMailto({ name: 'Sam' }, '/today?x=1'));
  assert.strictEqual(cw.fallbackMailto(null, null, null), nav.buildHelpMailto(null, null));
});

test('contextFor strips query', () => {
  const ctx = cw.contextFor({ name: 'Sam Lee' }, { company_name: 'Southbase' }, 'Hobsonville', '/timeline?q=secret');
  assert.deepStrictEqual(ctx, { name: 'Sam Lee', company: 'Southbase', project: 'Hobsonville', page: '/timeline' });
});

test('contextFor falls back to the /me name and tolerates nothing', () => {
  assert.strictEqual(cw.contextFor({}, { first_name: 'Ana', last_name: 'Ru' }, null, '/x').name, 'Ana Ru');
  assert.deepStrictEqual(cw.contextFor(null, null, null, null), { name: '', company: '', project: '', page: '' });
});

test('errorCopy rate minutes rounding', () => {
  assert.strictEqual(cw.errorCopy('rate', 61), "You've sent several messages recently. Please try again in 2 minutes.");
  assert.strictEqual(cw.errorCopy('rate', 3600), "You've sent several messages recently. Please try again in 60 minutes.");
  assert.strictEqual(cw.errorCopy('rate', 30), "You've sent several messages recently. Please try again in 1 minute.");
  assert.strictEqual(cw.errorCopy('rate', undefined), "You've sent several messages recently. Please try again in 1 minute.");
});

test('errorCopy exact strings', () => {
  assert.strictEqual(cw.errorCopy('mic'), 'Microphone not available. You can type instead.');
  assert.strictEqual(cw.errorCopy('stt'), "Couldn't turn the recording into text. It will still be sent as a voice note.");
  assert.strictEqual(cw.errorCopy('fallback'), "We couldn't send this here. Email us instead.");
});

test('classifySend: 201 ok, 404/denied/network/5xx fall back, 429 is rate', () => {
  assert.deepStrictEqual(cw.classifySend({ id: 'a' }, null), { kind: 'ok' });
  assert.strictEqual(cw.classifySend({ _notFound: true, status: 404 }, null).kind, 'fallback');
  assert.strictEqual(cw.classifySend({ _accessDenied: true }, null).kind, 'fallback');
  assert.strictEqual(cw.classifySend(null, new TypeError('Failed to fetch')).kind, 'fallback');
  const five = new Error('HTTP 502'); five.status = 502;
  assert.strictEqual(cw.classifySend(null, five).kind, 'fallback');
  const rl = new Error('rate_limited'); rl.status = 429; rl.body = { retry_after_s: 61 };
  assert.deepStrictEqual(cw.classifySend(null, rl), { kind: 'rate', retryAfterS: 61 });
});

test('transcriptFrom accepts only a real text result', () => {
  assert.strictEqual(cw.transcriptFrom({ text: 'hello' }), 'hello');
  assert.strictEqual(cw.transcriptFrom({ text: '  hello ' }), 'hello');
  assert.strictEqual(cw.transcriptFrom({ text: '', error: 'unavailable' }), null);
  assert.strictEqual(cw.transcriptFrom({ _notFound: true }), null);
  assert.strictEqual(cw.transcriptFrom(null), null);
});

test('formatClock counts m:ss', () => {
  assert.strictEqual(cw.formatClock(0), '0:00');
  assert.strictEqual(cw.formatClock(65.4), '1:05');
  assert.strictEqual(cw.formatClock(120), '2:00');
});

test('contactHelp calls FS.contact.open when present', () => {
  let opened = 0;
  global.window.location.href = 'about:blank';
  global.window.FS = { contact: { open: () => { opened += 1; } } };
  nav.contactHelp({ name: 'Sam' }, '/today');
  assert.strictEqual(opened, 1);
  assert.strictEqual(global.window.location.href, 'about:blank', 'no mail app is opened');
});

test('contactHelp falls back to the mailto without the window', () => {
  global.window.location.href = 'about:blank';
  global.window.FS = {};
  nav.contactHelp({ name: 'Sam' }, '/today?q=1');
  assert.strictEqual(global.window.location.href, nav.buildHelpMailto({ name: 'Sam' }, '/today?q=1'));
});

test('existing buildHelpMailto tests still pass', () => {
  const url = nav.buildHelpMailto({ name: 'Sam Lee' }, '/timeline?q=secret&token=abc');
  assert.ok(url.startsWith('mailto:sales@fieldsightai.com?subject='));
  const body = decodeURIComponent(url.split('&body=')[1]);
  assert.match(body, /Name: Sam Lee/);
  assert.match(body, /Page: \/timeline\n?$/);
  assert.doesNotMatch(url, /secret|abc/);
  assert.match(decodeURIComponent(nav.buildHelpMailto(null, null)), /Name: \n/);
});

/* ---- wiring ---- */
test('the recorder asks for 32 kbps, a 1 s timeslice, and stops at 2:00', () => {
  const src = read('scripts', 'composites', 'contact-window.js');
  assert.match(src, /audioBitsPerSecond: 32000/);
  assert.match(src, /\.start\(1000\)/);
  assert.match(src, /MAX_SECONDS = 120/);
  assert.match(src, /maxLength: MAX_TEXT/);
  assert.match(src, /MAX_TEXT = 4000/);
  assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /getTracks\(\)\.forEach/);
});

test('the request sends the mime pickMime chose, not recorder.mimeType', () => {
  const src = read('scripts', 'composites', 'contact-window.js');
  assert.doesNotMatch(src, /mime:\s*rec(order)?\.mimeType/);
});

test('ContactHost registers window.FS.contact', () => {
  const src = read('scripts', 'composites', 'contact-window.js');
  assert.match(src, /window\.FS\.contact = \{/);
  assert.match(src, /window\.FieldSight\.ContactHost = ContactHost/);
});

test('AppShell mounts ContactHost next to SettingsHost', () => {
  const src = read('scripts', 'app-shell.js');
  const s = src.indexOf('window.FieldSight.SettingsHost\n');
  const c = src.indexOf('window.FieldSight.ContactHost');
  assert.ok(s > 0 && c > s, 'ContactHost mounted after SettingsHost');
  assert.match(src.slice(c, c + 400), /user:\s+user/);
  assert.match(src.slice(c, c + 400), /route:\s+route/);
});

test('the page loads contact-window.js after modal-overlay and api/contact, before app-shell', () => {
  const html = read('app-shell-preview.html');
  const modal = html.indexOf('scripts/composites/modal-overlay.js');
  const api = html.indexOf('scripts/api/contact.js');
  const win = html.indexOf('scripts/composites/contact-window.js');
  const shell = html.indexOf('scripts/app-shell.js');
  assert.ok(modal > 0 && api > 0 && shell > 0);
  assert.ok(win > modal && win > api && win < shell);
});

/* ---- floating launcher (owner, 2026-11-09): the entry point moves from the
   left nav to a labelled button fixed bottom-right ---- */
test('hasUnsentDraft is true only for typed text or a recording', () => {
  assert.strictEqual(cw.hasUnsentDraft(null), false);
  assert.strictEqual(cw.hasUnsentDraft({ text: '  ', blob: null }), false);
  assert.strictEqual(cw.hasUnsentDraft({ text: 'hi', blob: null }), true);
  assert.strictEqual(cw.hasUnsentDraft({ text: '', blob: {} }), true);
});

test('the launcher is always rendered while the window is closed, and says what it is', () => {
  const src = read('scripts', 'composites', 'contact-window.js');
  assert.match(src, /function ContactLauncher\(/);
  assert.match(src, /if \(!used\) return launcher;/);
  assert.match(src, /if \(!open \|\| !Modal \|\| !draft\) return launcher;/);
  // a visible text label, not an icon alone, so it cannot be mistaken for a site feature
  assert.match(src, /'Contact FieldSight'/);
  assert.match(src, /'aria-label': 'Contact the FieldSight team'/);
  assert.match(src, /className: 'fs-contact-fab'/);
});

test('the left nav no longer carries the Contact entry, and contactHelp still works', () => {
  const src = read('scripts', 'left-nav.js');
  assert.doesNotMatch(src, /label: 'Contact FieldSight'/);
  assert.strictEqual(typeof nav.contactHelp, 'function');
});

test('the launcher sits bottom-right below modals, and toasts and mobile nav clear it', () => {
  const css = read('styles', 'composites.css');
  const i = css.indexOf('.fs-contact-fab {');
  assert.ok(i > 0);
  const block = css.slice(i, css.indexOf('}', i));
  assert.match(block, /position:\s*fixed/);
  assert.match(block, /right:\s*24px/);
  assert.match(block, /bottom:\s*24px/);
  const t = css.indexOf('.fs-toast-stack {');
  assert.match(css.slice(t, css.indexOf('}', t)), /bottom:\s*80px/);
  assert.match(css, /@media \(max-width: 767px\)\s*\{\s*\.fs-contact-fab \{[^}]*bottom:\s*72px/);
});

test('styles live in composites.css', () => {
  const css = read('styles', 'composites.css');
  assert.match(css, /\.fs-contact\b/);
  assert.match(css, /\.fs-contact__meter/);
});
