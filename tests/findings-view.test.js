'use strict';

/*
 * What a finding says on screen.
 *
 * The numbers these rules were chosen against are the prod lake's, measured
 * 2026-09-07 across 120 extraction artifacts: 219 findings, 183 of them about
 * the site, split 40 major / 88 minor / 55 none, and only 6 whose
 * recommended_action repeats an action item. The section was rendering all of
 * them as identical unlabelled prose.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  orderFindings, nonSafety, severityLabel, domainLabel, sectionCaption,
} = require('../scripts/api/findings-view.js');

function f(over) {
  return Object.assign({
    id: 'f1', observation: 'something', domain: 'progress', severity: 'minor',
  }, over);
}

/* ---- severity is visible at all ------------------------------------------ */

test('major and minor are labelled', () => {
  assert.strictEqual(severityLabel(f({ severity: 'major' })), 'Major');
  assert.strictEqual(severityLabel(f({ severity: 'minor' })), 'Minor');
});

test('none gets no chip — it is a value, not an omission', () => {
  // 55 of the 183 site findings are severity `none`, and the extractor means
  // "worth recording, not worth flagging" by it. A chip reading "none" would
  // be louder than the absence it describes.
  assert.strictEqual(severityLabel(f({ severity: 'none' })), null);
  assert.strictEqual(severityLabel(f({ severity: null })), null);
});

test('severity is read case-insensitively', () => {
  assert.strictEqual(severityLabel(f({ severity: 'MAJOR' })), 'Major');
});

/* ---- order --------------------------------------------------------------- */

test('major sorts above minor sorts above none', () => {
  const out = orderFindings([
    f({ id: 'n', severity: 'none' }),
    f({ id: 'mi', severity: 'minor' }),
    f({ id: 'ma', severity: 'major' }),
  ]);
  assert.deepStrictEqual(out.map(x => x.id), ['ma', 'mi', 'n']);
});

test('an unlabelled severity sorts with minor, not last', () => {
  // The extractor failing to label something is not evidence it is
  // unimportant; sinking it would bury the rows with the least metadata.
  const out = orderFindings([
    f({ id: 'none', severity: 'none' }),
    f({ id: 'blank', severity: null }),
  ]);
  assert.deepStrictEqual(out.map(x => x.id), ['blank', 'none']);
});

test('the extractor\'s own order survives inside one severity band', () => {
  const out = orderFindings([
    f({ id: 'a', severity: 'minor' }),
    f({ id: 'b', severity: 'minor' }),
    f({ id: 'c', severity: 'minor' }),
  ]);
  assert.deepStrictEqual(out.map(x => x.id), ['a', 'b', 'c']);
});

test('the order is total, so it does not reshuffle between renders', () => {
  const items = [];
  for (let i = 0; i < 20; i += 1) items.push(f({ id: 'x' + i, severity: 'major' }));
  const once = orderFindings(items).map(x => x.id);
  assert.deepStrictEqual(orderFindings(items).map(x => x.id), once);
});

test('nothing is dropped and the caller\'s list is not mutated', () => {
  const input = [f({ id: 'a', severity: 'none' }), f({ id: 'b', severity: 'major' })];
  const out = orderFindings(input);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(input.map(x => x.id), ['a', 'b']);
});

test('an empty or absent list is not an error', () => {
  assert.deepStrictEqual(orderFindings([]), []);
  assert.deepStrictEqual(orderFindings(undefined), []);
  assert.deepStrictEqual(nonSafety(undefined), []);
});

/* ---- domain -------------------------------------------------------------- */

test('quality and progress are named', () => {
  assert.strictEqual(domainLabel(f({ domain: 'quality' })), 'Quality');
  assert.strictEqual(domainLabel(f({ domain: 'progress' })), 'Progress');
});

test('safety findings are excluded, because safety_flags already shows them', () => {
  // render_report_shape promotes domain==='safety' into safety_flags with a
  // risk_level, and the timeline renders that section above this one. Without
  // this filter the same observation appears twice on one topic.
  const out = nonSafety([
    f({ id: 's', domain: 'safety' }),
    f({ id: 'q', domain: 'quality' }),
  ]);
  assert.deepStrictEqual(out.map(x => x.id), ['q']);
});

test('a domain the frontend does not know is still shown, just unlabelled', () => {
  // A new domain added backend-side must not make its findings vanish. It
  // loses its chip, which is honest, and keeps its row, which is the point.
  const out = nonSafety([f({ id: 'new', domain: 'environmental' })]);
  assert.deepStrictEqual(out.map(x => x.id), ['new']);
  assert.strictEqual(domainLabel(out[0]), null);
});

/* ---- the caption --------------------------------------------------------- */

test('the caption says how many, and how many are flagged', () => {
  const list = [
    f({ severity: 'major' }), f({ severity: 'minor' }), f({ severity: 'none' }),
  ];
  assert.strictEqual(sectionCaption(list), '3 observations · 2 flagged');
});

test('the caption drops the flagged clause when nothing is flagged', () => {
  assert.strictEqual(sectionCaption([f({ severity: 'none' })]), '1 observation');
});

test('an empty section has no caption rather than a zero', () => {
  // "0 observations" is a sentence about a section that is not rendered.
  assert.strictEqual(sectionCaption([]), null);
});

/* ---- the collapsed card's count ------------------------------------------ */

test('the collapsed card counts observations, and never the safety ones twice', () => {
  // topic-card.js builds its counts line from this same `nonSafety`. Before
  // this, the line read "1 decision · 2 actions · 1 safety flag" on a topic
  // that also carried a MAJOR observation — from the timeline it looked like
  // a topic carrying none. Safety-domain findings are already counted as
  // `safety_flags`, so counting them here would double them.
  const topicFindings = [
    f({ id: 's', domain: 'safety', severity: 'major' }),
    f({ id: 'q', domain: 'quality', severity: 'major' }),
    f({ id: 'p', domain: 'progress', severity: 'none' }),
  ];
  assert.strictEqual(nonSafety(topicFindings).length, 2);
});

test('a topic with only safety findings gets no observation count at all', () => {
  // Not "0 observations" — the line is omitted. A zero here would claim the
  // topic was checked for observations and had none, when in fact every one
  // it has is being shown as a safety flag instead.
  assert.strictEqual(nonSafety([f({ domain: 'safety' })]).length, 0);
});
