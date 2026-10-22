'use strict';

/*
 * "Resend invite" on the Team detail panel: POST /members/{sub}/resend-invite.
 * The api layer owns the request, the envelope-to-error conversion and the
 * sentences; the page is a browser IIFE with no export, so its wiring is pinned
 * by source and the behaviour is asserted on the api functions it calls.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let calls, reply;
function loadOrg(live) {
  calls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: { api: {
      useMocks: !live, orgWrites: !!live, timelineSource: 'aurora',
      orgBaseUrl: live ? 'https://org.example/prod/api' : '',
      delay: function () { return Promise.resolve(); },
      orgRequest: function (p, opts) {
        calls.push({ path: p, method: opts && opts.method, body: opts && opts.body });
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      },
    } },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8').replace(/\r\n/g, '\n');
function httpErr(status, error) { const e = new Error(error); e.status = status; e.body = { error }; return e; }

test('POSTs to /members/{sub}/resend-invite with the sub encoded and no body', async () => {
  const org = loadOrg(true);
  reply = { resent: true, email: 'a@b.co', user_status: 'FORCE_CHANGE_PASSWORD' };
  const res = await org.resendInvite('sub/1');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, '/members/sub%2F1/resend-invite');
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].body, undefined);
  assert.strictEqual(res.resent, true);
});

test('403/404 envelopes become thrown errors (never read as success)', async () => {
  const org = loadOrg(true);
  reply = { _notFound: true, status: 404, raw: { error: 'member not found in your company' } };
  await assert.rejects(org.resendInvite('s'), (e) => e.status === 404 && /not found/.test(e.body.error));
  reply = { _accessDenied: true, status: 403, error: 'admin role required' };
  await assert.rejects(org.resendInvite('s'), (e) => e.status === 403);
});

test('a thrown 409 (already accepted) propagates', async () => {
  const org = loadOrg(true);
  reply = httpErr(409, 'This person has already accepted the invitation and set a password.');
  await assert.rejects(org.resendInvite('s'), (e) => e.status === 409);
});

test('mock mode makes no request', async () => {
  const org = loadOrg(false);
  const res = await org.resendInvite('s');
  assert.strictEqual(res.resent, true);
  assert.strictEqual(calls.length, 0);
});

test('messages: success names the address and the sender; 409 shows the server sentence', () => {
  const org = loadOrg(true);
  const ok = org.resendInviteMessage({ resent: true, email: 'a@b.co' });
  assert.match(ok, /re-sent to a@b\.co/);
  assert.match(ok, /no-reply@verificationemail\.com/);
  assert.match(org.resendInviteMessage(null, httpErr(409, 'already accepted -- use Forgot password')), /Forgot password/);
  assert.strictEqual(org.resendInviteMessage(null, httpErr(403, 'x')), 'Only company admins can resend invitations');
  assert.strictEqual(org.resendInviteMessage(null, httpErr(404, 'member not found in your company')), 'member not found in your company');
  assert.strictEqual(org.resendInviteMessage(null, new Error('boom')), 'Could not resend the invitation');
});

test('only admin and platform_admin may resend (same gate as the backend)', () => {
  const org = loadOrg(true);
  assert.strictEqual(org.canResendInvite({ role: 'admin' }), true);
  assert.strictEqual(org.canResendInvite({ role: 'platform_admin' }), true);
  for (const r of ['gm', 'project_manager', 'pm', 'site_manager', 'worker', undefined]) {
    assert.strictEqual(org.canResendInvite({ role: r }), false, String(r));
  }
  assert.strictEqual(org.canResendInvite(null), false);
});

test('team page: button is gated (live, admin, not archived, not self) and calls the api', () => {
  const t = src('pages/team.js');
  assert.match(t, /var canResend = orgLive\(\) && window\.FS\.api\.org\.canResendInvite\(caller\)\s*&& !u\.archived && u\.device_id !== callerSub;/);
  assert.match(t, /canResend \? React\.createElement\('button'/);
  assert.match(t, /org\.resendInvite\(u\.device_id\)/);
  assert.match(t, /'Resend invite'/);
});
