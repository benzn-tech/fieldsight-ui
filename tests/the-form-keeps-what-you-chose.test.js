'use strict';

/*
 * From picking a template in the dropdown to the body on the wire, with
 * nothing built by hand in between.
 *
 * WHAT HAPPENED. The owner picked a template, generated, and the request in
 * the Network panel was:
 *
 *     { templateId: "df153e1c-…", title: "…", attendees: ["Ben"],
 *       deliver: "download", fields: {}, recipients: [] }
 *
 * No templateVersion. Three separate tests asserted that it travels, and all
 * three were green.
 *
 * They were green because each one drove a single hop and handed it a form
 * object written out by hand. Nobody drove the CHAIN. And in the middle of the
 * chain sat this, in the effect that lands the preview:
 *
 *     setForm(function (f) {
 *       return { templateId: f.templateId, title: d.title,
 *                attendees: d.attendees, fields: f.fields };
 *     });
 *
 * An object literal that enumerates the fields it keeps is a whitelist. It has
 * no name, it does not look like one, and nothing fails when a new field
 * appears -- it just stops arriving. Which is the same defect as the one fixed
 * one batch earlier in scripts/api/org.js, reproduced one layer in, by me,
 * about a week of work apart.
 *
 * THE test is `choosing a template survives the preview landing`. It is the
 * one that fails against the shipped code.
 *
 * Every test here composes the REAL updaters in the order the component calls
 * them. The rule this file exists to enforce: a path is only tested if it was
 * driven from the entry a person touches to the exit that leaves the browser.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
if (!global.window.FieldSight) global.window.FieldSight = {};

const {
  buildGeneratePayload, applyPreviewDefaults, applyTemplateChoice,
} = require('../scripts/composites/session-report-modal.js');

/* What the modal starts with. */
const INITIAL = { templateId: null, title: '', attendees: [], fields: {} };

/* What the chooser hands over: a row from FS.api.templates.list(). */
const ROW = { id: 'df153e1c-fef4-4c0a-bdb3-84fbb507c2ec', version: 3, title: 'Site Daily' };

/* What the preview resolves with. */
const DEFAULTS = { title: '2026-09-23 · UC PK', attendees: ['Ben'] };

const CTX = { session: { session_id: 'sid1' }, date: '2026-09-23', userFolder: 'Ben_UCPK2' };

function wire(form) {
  return buildGeneratePayload(Object.assign({}, CTX, { form: form, deliver: 'download' }));
}

/* org.js's request-body whitelist, as it is written there. Included so the
   chain reaches the wire rather than stopping one hop short. */
function throughOrgWhitelist(payload) {
  const body = {
    templateId: payload.templateId,
    title: payload.title,
    attendees: payload.attendees,
    fields: payload.fields || {},
    deliver: payload.deliver || 'download',
    recipients: payload.recipients || [],
  };
  if (payload.templateVersion !== undefined && payload.templateVersion !== null) {
    body.templateVersion = payload.templateVersion;
  }
  return JSON.parse(JSON.stringify(body));
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: choosing a template survives the preview landing', () => {
  /* The real order on a slow connection: the modal opens, the person clicks
     Next and picks a template, and THEN the preview resolves. */
  let form = INITIAL;
  form = applyTemplateChoice(form, ROW.id, ROW.version);
  form = applyPreviewDefaults(form, DEFAULTS);

  const body = throughOrgWhitelist(wire(form));
  assert.strictEqual(body.templateId, ROW.id);
  assert.strictEqual(body.templateVersion, 3,
    'the preview landing must not drop the version the person chose');
});

test('and the other order, where the preview lands first', () => {
  let form = INITIAL;
  form = applyPreviewDefaults(form, DEFAULTS);
  form = applyTemplateChoice(form, ROW.id, ROW.version);

  const body = throughOrgWhitelist(wire(form));
  assert.strictEqual(body.templateVersion, 3);
});

test('the preview landing twice does not lose it either', () => {
  let form = applyTemplateChoice(INITIAL, ROW.id, ROW.version);
  form = applyPreviewDefaults(form, DEFAULTS);
  form = applyPreviewDefaults(form, { title: 'Renamed', attendees: ['Ben', 'Neil'] });
  assert.strictEqual(throughOrgWhitelist(wire(form)).templateVersion, 3);
});

/* ---- the preview only changes what the preview knows ----------------------- */

test('the preview sets the title and attendees, and touches nothing else', () => {
  const before = applyTemplateChoice(
    Object.assign({}, INITIAL, { fields: { weather: 'wet' } }), ROW.id, ROW.version);
  const after = applyPreviewDefaults(before, DEFAULTS);

  assert.strictEqual(after.title, DEFAULTS.title);
  assert.deepStrictEqual(after.attendees, DEFAULTS.attendees);
  /* Everything the person had already chosen. */
  assert.strictEqual(after.templateId, ROW.id);
  assert.strictEqual(after.templateVersion, 3);
  assert.deepStrictEqual(after.fields, { weather: 'wet' });
});

test('a field nobody has thought of yet also survives it', () => {
  /* The actual guard. templateVersion was lost because the rebuild listed the
     fields it knew; the next field added would go the same way. */
  const before = Object.assign({}, INITIAL, { somethingLater: 'kept' });
  assert.strictEqual(applyPreviewDefaults(before, DEFAULTS).somethingLater, 'kept');
});

test('neither updater mutates the form it was given', () => {
  const form = Object.assign({}, INITIAL);
  applyPreviewDefaults(form, DEFAULTS);
  applyTemplateChoice(form, ROW.id, ROW.version);
  assert.deepStrictEqual(form, INITIAL);
});

/* ---- choosing, and un-choosing --------------------------------------------- */

test('picking "None" clears both fields, not just the id', () => {
  /* A version left behind on an id-less form would be a request describing a
     version of nothing. */
  let form = applyTemplateChoice(INITIAL, ROW.id, ROW.version);
  form = applyTemplateChoice(form, null, undefined);
  const body = throughOrgWhitelist(wire(form));
  assert.ok(!('templateVersion' in body));
  assert.strictEqual(body.templateId, null);
});

test('switching template carries the new version, not the old one', () => {
  let form = applyTemplateChoice(INITIAL, ROW.id, 3);
  form = applyTemplateChoice(form, 'other-uuid', 7);
  assert.strictEqual(throughOrgWhitelist(wire(form)).templateVersion, 7);
});

/* ---- the standard report is unchanged --------------------------------------- */

test('never choosing a template sends exactly what it always sent', () => {
  let form = applyPreviewDefaults(INITIAL, DEFAULTS);
  assert.deepStrictEqual(throughOrgWhitelist(wire(form)), {
    templateId: null,
    title: DEFAULTS.title,
    attendees: DEFAULTS.attendees,
    fields: {},
    deliver: 'download',
    recipients: [],
  });
});
