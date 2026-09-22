'use strict';

/*
 * Choosing a template, and the one combination the backend will not serve.
 *
 * Batch 2 connects the Library to report generation. Two things have to hold
 * and neither is obvious from the diff:
 *
 * 1. templateVersion has to survive from the chooser to the wire. It passes
 *    through three places that can lose it -- the form, buildGeneratePayload,
 *    and org.js's request-body whitelist -- and the backend answers 400
 *    without it. That 400 names a field the UI believes it sent, which points
 *    the search at the backend, the one place the bug is not.
 *
 * 2. A named template cannot be emailed. lambda_org_api._generation_request
 *    refuses that pair outright, because the worker's generate branch always
 *    writes `emailed: false` and would produce a document nobody receives. A
 *    form that can only be submitted to a 400 teaches people the feature is
 *    broken.
 *
 * THE test is `choosing a template and emailing cannot both be true`. It is
 * the one that stops a user reaching a guaranteed failure.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'composites', 'session-report-modal.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function lift(names) {
  const parts = names.map((n) => {
    const m = SRC.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n  \\}'));
    assert.ok(m, n + ' has moved or been renamed');
    return m[0];
  });
  // eslint-disable-next-line no-new-func
  return new Function(parts.join('\n') + '\nreturn {' + names.join(',') + '};')();
}

const H = lift(['buildGeneratePayload', 'emailBlockedBecause', 'canGenerate']);

const BASE = {
  session: { session_id: 'sid1' }, date: '2026-07-25', userFolder: 'Ada_L',
  deliver: 'download',
};

function payload(form, extra) {
  return H.buildGeneratePayload(Object.assign({}, BASE, extra, { form: form }));
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: choosing a template and emailing cannot both be true', () => {
  assert.ok(H.emailBlockedBecause('tpl-1'), 'a chosen template blocks email');
  assert.strictEqual(H.emailBlockedBecause(null), null, 'the standard report may be emailed');

  // And Generate refuses the pair even if the radio were somehow still on email.
  assert.strictEqual(H.canGenerate('email', ['a@b.com'], null, 'tpl-1'), false);
  assert.strictEqual(H.canGenerate('email', ['a@b.com'], null, null), true);
});

test('the block explains itself rather than just being dead', () => {
  const why = H.emailBlockedBecause('tpl-1');
  assert.match(why, /download/i, 'it has to say what IS possible');
});

/* ---- the version reaches the wire ------------------------------------------ */

test('a chosen template sends its id AND its version', () => {
  const p = payload({ templateId: 't1', templateVersion: 4, title: 'x', attendees: [] });
  assert.strictEqual(p.templateId, 't1');
  assert.strictEqual(p.templateVersion, 4);
});

test('version 1 is not mistaken for absent', () => {
  const p = payload({ templateId: 't1', templateVersion: 1 });
  assert.strictEqual(JSON.parse(JSON.stringify(p)).templateVersion, 1);
});

test('the standard report sends neither field, at every layer', () => {
  /* "None" is a real choice, not a gap in the form, and it is the default.
     The request for it must stay exactly what it has always been -- checked on
     the object, not only on the encoding, because a present-but-undefined key
     is not an absent one. */
  const p = payload({ title: 'x', attendees: ['Neil'] });
  assert.ok(!('templateVersion' in p), 'the key must not sit on the object');
  assert.strictEqual(p.templateId, null);
});

test('a template with no version does not send a half request', () => {
  /* Better to send no version and let the backend pin the current one than to
     send `templateVersion: undefined`, which reads as "I have one" to anything
     inspecting the object. */
  const p = payload({ templateId: 't1' });
  assert.ok(!('templateVersion' in p));
});

test('a day report carries the template the same way a meeting does', () => {
  const p = payload({ templateId: 't1', templateVersion: 2 }, { scope: 'day' });
  assert.strictEqual(p.scope, 'day');
  assert.strictEqual(p.templateVersion, 2);
  assert.ok(!('sessionId' in p) || p.sessionId === undefined);
});

/* ---- the rest of the form is unchanged ------------------------------------- */

test('choosing a template does not disturb the other fields', () => {
  const p = payload({ templateId: 't1', templateVersion: 2, title: '  Slab pour  ',
                      attendees: ['Neil'], fields: { weather: 'wet' } });
  assert.strictEqual(p.title, 'Slab pour');
  assert.deepStrictEqual(p.attendees, ['Neil']);
  assert.deepStrictEqual(p.fields, { weather: 'wet' });
  assert.deepStrictEqual(p.recipients, []);
});

test('canGenerate keeps every rule it had before a template could be chosen', () => {
  assert.strictEqual(H.canGenerate('download', [], null, null), true);
  assert.strictEqual(H.canGenerate('email', [], null, null), false, 'email needs a recipient');
  assert.strictEqual(H.canGenerate('download', [], [], null), false, 'no topics is no report');
  assert.strictEqual(H.canGenerate('download', [], [], 't1'), false);
});

/* ---- the chooser's own source ---------------------------------------------- */

test('the chooser offers None, and offers it first', () => {
  const m = SRC.match(/var options = \[h\('option',[^\n]*\n[^\n]*/);
  assert.ok(m, 'the None option has moved');
  assert.match(m[0], /value: ''/, 'None carries an empty value, i.e. no template');
});

test('a template with no content yet is not offered', () => {
  /* The backend refuses it ("that template has no content yet"); offering it
     would be offering a 400. */
  assert.match(SRC, /t\._status !== 'empty'/);
});

test('a failed template load is not an empty list', () => {
  /* An empty list reads as "your company has no templates", which is a
     different and wrong statement -- and it would remove the only choice this
     step exists to offer without saying so. */
  assert.match(SRC, /phase: 'error'/);
  assert.match(SRC, /Could not load your templates/);
});
