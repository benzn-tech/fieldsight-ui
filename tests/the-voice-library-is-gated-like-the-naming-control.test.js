'use strict';

/*
 * The Voices tab (in /evidence since 2026-09-23) reads and deletes biometric data. Three wiring facts decide
 * who reaches it, and all three fail SILENTLY when they are wrong — a tab that renders for
 * the wrong role looks exactly like a tab that renders for the right one.
 *
 * These are source-level assertions on purpose. This repository's own rule is that scanning
 * source is only good for pinning WIRING, never behaviour, and wiring is precisely what is
 * at stake: whether the gate is called at all, and whether it reads from the one role list
 * the backend agrees with.
 *
 * Backend counterparts (fieldsight-pipeline lambda_org_api.py):
 *   GET    /api/org/voiceprints          _CORRECTION_ROLES  (admin, gm, pm, site_manager, platform_admin)
 *   DELETE /api/org/voiceprints/{id}     _CORRECTION_ROLES
 *   PUT    /api/org/company/voiceprint-basis   platform_admin ONLY
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sn = require('../scripts/api/speaker-naming.js');

const LIB = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'composites', 'voice-library.js'), 'utf8');
const EVIDENCE = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'evidence.js'), 'utf8');
const SETTINGS = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'settings.js'), 'utf8');
const ORG = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'api', 'org.js'), 'utf8');

test('the Voices tab is gated, and by the naming role list rather than a second copy', () => {
  /* A second hard-coded list is the failure that already happened once here: the UI never
     sees the org role `pm` (session-bridge renames it to project_manager), so a list
     written from the backend's spelling alone silently denied every pm account. One source
     means the two cannot drift. */
  assert.match(LIB, /function mayManage/, 'no gate function at all');
  assert.match(LIB, /speakerNaming[\s\S]{0,120}roleMayName/,
    'the gate does not read roleMayName — a second role list will drift from the backend');
  assert.doesNotMatch(LIB, /\[\s*'admin',\s*'gm',\s*'pm'/,
    'voice-library.js has its own inline role list');
  /* It moved out of Settings on 2026-09-23. A copy left behind would be a second
     surface serving the same biometric data under a gate nobody is maintaining. */
  assert.doesNotMatch(SETTINGS, /voiceprint|VoicesTab/i,
    'settings.js still carries a voiceprint surface after the move to Evidence');
});

test('hiding the tab is not the only check', () => {
  /* Hiding a tab hides the BUTTON, not the state behind it: the dev role switcher changes
     `user.role` without resetting `activeTab`, so a demotion while the tab is open leaves
     the body rendering for a role that may no longer read it.

     Three places, and all three are load-bearing: where the tab is offered,
     where the tab's body is chosen, and inside the panel itself. */
  const build = EVIDENCE.indexOf("tabs.push({ key: 'voices'");
  const dispatch = EVIDENCE.indexOf("case 'voices':");
  assert.ok(build > -1, 'the Voices tab is never offered');
  assert.ok(dispatch > -1, 'the Voices tab has no body');
  assert.match(EVIDENCE.slice(Math.max(0, build - 400), build), /voiceLibraryMayManage/,
    'the tab button is not gated');
  assert.match(EVIDENCE.slice(dispatch, dispatch + 400), /voiceLibraryMayManage/,
    'the tab BODY is not gated, only the button that opens it');
  assert.match(LIB, /if \(!mayManage\(user\)/,
    'the panel does not gate itself, so any future mount reaches it ungated');
});

test('every role the tab admits is one the backend accepts', () => {
  /* Both spellings of the pm role, because the UI and the backend disagree on it and the
     UI's is the one this list is checked against. */
  ['admin', 'gm', 'pm', 'project_manager', 'site_manager', 'platform_admin']
    .forEach((r) => assert.strictEqual(sn.roleMayName(r), true, r));
  ['worker', 'viewer', '', null, undefined, 'regional_manager']
    .forEach((r) => assert.strictEqual(sn.roleMayName(r), false, String(r)));
});

test('the consent basis is offered to platform_admin alone', () => {
  /* Deliberately a narrower gate than naming. Naming a speaker is an everyday act by
     whoever is on site; deciding the legal basis on which a company may hold biometric
     data is not, and the server enforces `!= 'platform_admin'` → 403. Offering it to a gm
     would be offering a control whose only outcome is a denial. */
  /* Anchored on the CONTROL, not on the words: "consent basis" also appears in a message
     string a few lines above, and matching that one made this test read the wrong 400
     characters and fail for the wrong reason. */
  const at = LIB.indexOf("'Consent basis'");
  assert.ok(at > -1, 'the consent basis control is gone');
  const before = LIB.slice(Math.max(0, at - 400), at);
  assert.match(before, /role === 'platform_admin'/,
    'the consent basis control is not restricted to platform_admin');
});

test('the write calls do not retry', () => {
  /* A lost 202/200 retried is a second deletion attempt or a second basis write. The
     project has already shipped a _fetch layer that retried every method four times and
     turned one timed-out POST into four writes; only GET may retry. */
  ['withdrawVoiceprint', 'setVoiceprintBasis', 'regenerateSession'].forEach((fn) => {
    const at = ORG.indexOf('function ' + fn);
    assert.ok(at > -1, `${fn} is missing`);
    const body = ORG.slice(at, at + 600);
    assert.match(body, /retry:\s*false/, `${fn} may be retried`);
  });
});

test('the library read is company-scoped with no parameter that could widen it', () => {
  /* There is no companyId argument and there must never be one: the server takes the
     company from the caller, so there is nothing a client could send to reach another
     tenant's profiles. */
  const at = ORG.indexOf('function getVoiceprints');
  assert.ok(at > -1);
  assert.match(ORG.slice(at, at + 120), /function getVoiceprints\s*\(\s*\)/,
    'getVoiceprints takes an argument — a company or site parameter here is a tenant leak');
});
