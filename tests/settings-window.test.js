'use strict';
/* Settings as a window over the page (spec 2026-11-07). */
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
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'scripts', ...p), 'utf8').replace(/\r\n/g, '\n');
const { landingAfterSettings, landingChoices } = require('../scripts/pages/settings.js');
const SRC = read('pages', 'settings.js');
const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

test('the old route never redirects to itself', () => {
  assert.strictEqual(landingAfterSettings('/tasks', '/today'), '/tasks');
  assert.strictEqual(landingAfterSettings(null, '/timeline'), '/timeline');
  assert.strictEqual(landingAfterSettings('/settings', '/timeline'), '/timeline');
  assert.strictEqual(landingAfterSettings('/settings', '/settings'), '/today');
  assert.strictEqual(landingAfterSettings(null, null), '/today');
});

test('Settings is not offered as a landing page', () => {
  const out = landingChoices([{ path: '/today' }, { path: '/settings' }, { path: '/tasks' }]);
  assert.deepStrictEqual(out.map((i) => i.path), ['/today', '/tasks']);
  assert.deepStrictEqual(landingChoices(undefined), []);
});

test('Preferences is Appearance, holding theme and density only', () => {
  assert.match(SRC, /key: 'appearance',\s+label: 'Appearance'/);
  assert.doesNotMatch(SRC, /'preferences'|PreferencesTab/);
  const tab = between(SRC, 'function AppearanceTab', 'function landingChoices');
  assert.match(tab, /fs-theme/);
  assert.match(tab, /fs-density/);
  assert.doesNotMatch(tab, /On open, go to|Reset onboarding/);
  const defaults = between(SRC, 'function AccountDefaults', 'Profile tab');
  assert.match(defaults, /On open, go to/);
  assert.match(defaults, /Saved automatically/);
  assert.match(defaults, /Reset onboarding/);
});

test('landing sits outside the Save and Reset form', () => {
  const profile = between(SRC, 'function ProfileTab', 'Change password ---');
  assert.ok(profile.indexOf('ctx.saveProfile') < profile.indexOf('createElement(AccountDefaults'));
});

test('Security has no nested modal', () => {
  const sec = between(SRC, 'function SecurityTab', 'Glossary tab');
  assert.doesNotMatch(sec, /FieldSight\.ModalOverlay|createElement\(Modal/);
  assert.match(sec, /setView\('password'\)/);
  assert.match(sec, /setView\('qr'\)/);
});

test('the overlay unmounts on close while the provider stays', () => {
  const host = between(SRC, 'function SettingsHost', 'Register ---');
  assert.match(host, /if \(!used\) return null;/);
  assert.match(host, /createElement\(SettingsProvider, [^]*open \? React\.createElement\(SettingsWindow/);
});

test('the page entry does no work at boot', () => {
  const entry = SRC.slice(SRC.indexOf('window.FieldSight.PAGES[SETTINGS_ROUTE]'));
  assert.doesNotMatch(entry.slice(0, entry.indexOf('};')), /Provider:/);
});

test('the host handles the old route and applies the permission', () => {
  const host = between(SRC, 'function SettingsHost', 'Register ---');
  assert.match(host, /props\.route !== SETTINGS_ROUTE \|\| !canOpenSettings\(props\.user\)/);
  assert.match(host, /window\.FS\.Router\.replace\(landingAfterSettings/);
  assert.match(host, /if \(!canOpenSettings\(live\.current\.user\)\) return;/);
});

test('nav opens the window and does not change the route', () => {
  const nav = read('left-nav.js');
  assert.match(nav, /setMenuOpen\(false\); openSettings\(\);/);
  assert.doesNotMatch(nav, /onNavigate\('\/settings'\)/);
});

test('the shell mounts the host and silences its shortcuts while open', () => {
  const shell = read('app-shell.js');
  assert.match(shell, /createElement\(window\.FieldSight\.SettingsHost/);
  assert.match(shell, /onOpen: function \(\) \{ setOnboardingOpen\(false\); \}/);
  const onKey = shell.slice(shell.indexOf('function onKey(e)'));
  assert.ok(onKey.indexOf('settings.isOpen()') < onKey.indexOf("toLowerCase() === 'b'"));
});

test('Router.replace adds no history entry and tells subscribers', () => {
  const r = read('router.js');
  const b = r.slice(r.indexOf('replace(path)'), r.indexOf('Subscribe to route changes'));
  assert.match(b, /history\.replaceState\(/);
  assert.match(b, /notify\(\)/);
});
