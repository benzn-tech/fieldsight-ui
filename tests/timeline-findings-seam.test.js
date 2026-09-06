'use strict';

/*
 * The seam between the timeline render and api/findings-view.js.
 *
 * The ordering rules have their own tests. What had NO coverage was whether
 * the render CALLS them — and that gap was invisible from either side:
 * findings-view.test.js drives the module directly, and the five existing
 * tests that load timeline.js never seed `window.FS.api`, so every one of
 * them was exercising the fallback branch while nothing exercised the wired
 * one. Green on both halves, untested in the middle.
 *
 * Found by sweeping the suite for tests that load a module which reads
 * `FS.api.*` at runtime without seeding it. This file is the answer to the
 * one real hit that sweep produced.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.React = global.React || {};

const { selectFindings } = require('../scripts/pages/timeline.js');
const findingsView = require('../scripts/api/findings-view.js');

function f(over) {
  return Object.assign({
    id: 'f1', observation: 'o', domain: 'progress', severity: 'minor',
  }, over);
}

function withModule(fn) {
  const prev = window.FS;
  window.FS = { api: { findingsView: findingsView } };
  try { return fn(); } finally { window.FS = prev; }
}

function withoutModule(fn) {
  const prev = window.FS;
  window.FS = undefined;
  try { return fn(); } finally { window.FS = prev; }
}

/* ---- the wired path ------------------------------------------------------ */

test('with the module present, the render gets findings in severity order', () => {
  const out = withModule(() => selectFindings({ findings: [
    f({ id: 'n', severity: 'none' }),
    f({ id: 'ma', severity: 'major' }),
    f({ id: 'mi', severity: 'minor' }),
  ] }));
  assert.deepStrictEqual(out.map(x => x.id), ['ma', 'mi', 'n']);
});

test('with the module present, safety findings are excluded', () => {
  // They were already promoted into safety_flags and render above this
  // section; without the filter the same observation appears twice.
  const out = withModule(() => selectFindings({ findings: [
    f({ id: 's', domain: 'safety' }), f({ id: 'q', domain: 'quality' }),
  ] }));
  assert.deepStrictEqual(out.map(x => x.id), ['q']);
});

/* ---- the fallback -------------------------------------------------------- */

test('without the module, the section still renders — unordered, not empty', () => {
  // The fallback is deliberate. A findings section that vanishes because a
  // script tag moved is worse than one that is merely unordered.
  const out = withoutModule(() => selectFindings({ findings: [
    f({ id: 'n', severity: 'none' }), f({ id: 'ma', severity: 'major' }),
  ] }));
  assert.deepStrictEqual(out.map(x => x.id), ['n', 'ma']);
});

test('without the module, safety findings are STILL excluded', () => {
  // The duplicate-row defect must not come back through the fallback. This is
  // the assertion that makes the fallback a fallback rather than a hole.
  const out = withoutModule(() => selectFindings({ findings: [
    f({ id: 's', domain: 'safety' }), f({ id: 'q', domain: 'quality' }),
  ] }));
  assert.deepStrictEqual(out.map(x => x.id), ['q']);
});

/* ---- shapes the payload really produces ---------------------------------- */

test('a topic with no findings key is not an error on either path', () => {
  // The report/ingest path and pre-#46 extractions have no `findings`.
  assert.deepStrictEqual(withModule(() => selectFindings({})), []);
  assert.deepStrictEqual(withoutModule(() => selectFindings({})), []);
});

test('a missing topic is not an error on either path', () => {
  assert.deepStrictEqual(withModule(() => selectFindings(null)), []);
  assert.deepStrictEqual(withoutModule(() => selectFindings(undefined)), []);
});

test('both paths agree whenever severity has nothing to say', () => {
  // Same input, same single severity: the two branches must not disagree
  // about membership, only about order. If they ever do, the fallback has
  // become a second implementation rather than a degraded one.
  const input = [f({ id: 'a' }), f({ id: 'b' }), f({ id: 'c', domain: 'safety' })];
  const wired = withModule(() => selectFindings({ findings: input })).map(x => x.id);
  const fell = withoutModule(() => selectFindings({ findings: input })).map(x => x.id);
  assert.deepStrictEqual(wired.slice().sort(), fell.slice().sort());
});
