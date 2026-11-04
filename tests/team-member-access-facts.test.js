'use strict';

/*
 * Team detail panel: the read-only Email / Joined / Sign-in / Last seen rows,
 * the "Company access" field (users.global_role) and the Resend gate that the
 * login status now drives. memberAccessFacts lives in the api layer; the page
 * is a browser IIFE with no export, so its wiring is pinned by source.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadOrg() {
  global.window = {
    FieldSight: { fixtures: {} },
    FS: { api: {
      useMocks: false, orgWrites: true, timelineSource: 'aurora',
      orgBaseUrl: 'https://org.example/prod/api',
      delay: function () { return Promise.resolve(); },
      orgRequest: function () { return Promise.resolve({}); },
      nzDate: function (v) { return 'D(' + v + ')'; },
      nzDateTime: function (v) { return 'DT(' + v + ')'; },
    } },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8').replace(/\r\n/g, '\n');

test('an invited member who never signed in: Never, and Resend stays', () => {
  const f = loadOrg().memberAccessFacts({
    email: 'b@rcp.co.nz', created_at: '2026-10-20T01:00:00Z',
    login_status: 'FORCE_CHANGE_PASSWORD', last_seen_at: null,
  });
  assert.strictEqual(f.email, 'b@rcp.co.nz');
  assert.strictEqual(f.joined, 'D(2026-10-20T01:00:00Z)');
  assert.match(f.signIn, /has not signed in yet/);
  assert.strictEqual(f.lastSeen, 'Never');
  assert.strictEqual(f.canResend, true);
});

test('a signed-in member: last_seen_at in NZ time, Resend hidden', () => {
  const f = loadOrg().memberAccessFacts({
    login_status: 'CONFIRMED', last_seen_at: '2026-10-30T20:00:00+00:00',
  });
  assert.strictEqual(f.signIn, 'Signed in');
  assert.strictEqual(f.lastSeen, 'DT(2026-10-30T20:00:00+00:00)');
  assert.strictEqual(f.canResend, false);
});

test('signed in before last-seen tracking shipped reads "Not recorded yet", not "Never"', () => {
  const f = loadOrg().memberAccessFacts({ login_status: 'CONFIRMED', last_seen_at: null });
  assert.strictEqual(f.lastSeen, 'Not recorded yet');
});

test('status unknown (Cognito lookup failed / old backend): dashes, Resend kept for the backend to decide', () => {
  const f = loadOrg().memberAccessFacts({});
  assert.deepStrictEqual([f.email, f.joined, f.signIn, f.lastSeen], ['—', '—', '—', '—']);
  assert.strictEqual(f.canResend, true);
});

test('an unmapped Cognito status is shown raw, not hidden', () => {
  assert.strictEqual(loadOrg().memberAccessFacts({ login_status: 'ARCHIVED' }).signIn, 'ARCHIVED');
});

test('the page renders the four rows, gates Resend on the facts, and labels the global role "Company access"', () => {
  const s = src('pages/team.js');
  assert.match(s, /memberAccessFacts\(u\)/);
  assert.match(s, /\['Email', facts\.email\], \['Joined', facts\.joined\], \['Sign-in', facts\.signIn\], \['Last seen', facts\.lastSeen\]/);
  assert.match(s, /&& facts\.canResend;/);
  assert.match(s, /field-label' \}, 'Company access'\)/);
  assert.doesNotMatch(s, /field-label' \}, 'Position'\)/);
  assert.match(s, /fFieldRow\('Company access',/);
});

test('live company-access options put Admin last', () => {
  const s = src('pages/team.js');
  const block = s.slice(s.indexOf('if (orgLive()) {', s.indexOf('function roleOptions()')));
  const order = ['worker', 'site_manager', 'pm', 'gm', 'admin'].map((v) => block.indexOf("v: '" + v + "'"));
  assert.ok(order.every((i) => i > 0), order);
  assert.deepStrictEqual(order.slice().sort((a, b) => a - b), order);
});
