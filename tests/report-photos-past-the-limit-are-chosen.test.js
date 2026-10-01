'use strict';

/*
 * Owner, 2026-10-01: a report carries 60 photographs at page size, up to 120
 * shrunk automatically, and past 120 the person chooses what to leave out --
 * before generating. The choice is kept for the day (pipeline
 * /days/{date}/photos/selection) and the nightly report follows it too.
 *
 * THE test is `past the limit Next leads to the choice, and cannot pass it
 * until enough are left out`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODAL = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'composites', 'session-report-modal.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const ORG = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'api', 'org.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function lift(src, name) {
  const start = src.indexOf('\n  function ' + name + '(');
  assert.ok(start >= 0, name + ' has moved');
  const end = src.indexOf('\n  }\n', start);
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }) };
  // eslint-disable-next-line no-new-func
  return new Function('React', src.slice(start, end + 5) + '\nreturn ' + name + ';')(React);
}

function texts(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  (node.children || []).forEach((c) => texts(c, out));
  return out;
}

const PhotoChoiceStep = lift(MODAL, 'PhotoChoiceStep');
const SEL = { photos: [
  { filename: 'a.jpg', time: '13:25', place: 'ground floor', url: 'u1' },
  { filename: 'b.jpg', time: '13:28', place: 'level 1', url: 'u2' },
  { filename: 'c.jpg', time: '13:28', place: 'level 1', url: 'u3' },
  { filename: 'd.jpg', time: '15:00', place: null, url: 'u4' }] };

test('THE: past the limit Next leads to the choice, and cannot pass it until enough are left out', () => {
  assert.match(MODAL, /btn\('Next', function \(\) \{ setStep\(mustChoose \? 'photos' : 'fill'\); \}, 'primary'\)/);
  assert.match(MODAL, /disabled: photoIn > photoMax \|\| photoSaving,/);
  assert.match(MODAL, /savePhotoChoice\(function \(\) \{ setStep\('fill'\); \}\)/);
});

test('photographs are grouped by where they were taken, ticked = in the report', () => {
  const tree = PhotoChoiceStep({ selection: SEL, out: { 'c.jpg': true }, max: 120, included: 3,
    onToggle() {} });
  const t = texts(tree).join('|');
  assert.match(t, /3 of 4 photographs in the report · at most 120/);
  assert.match(t, /Ground Floor \(1\)/);
  assert.match(t, /Level 1 \(2\)/);
  assert.match(t, /No place said \(1\)/);
});

test('over the limit it says how many more to leave out', () => {
  const t = texts(PhotoChoiceStep({ selection: SEL, out: {}, max: 2, included: 4, onToggle() {} })).join('|');
  assert.match(t, /leave out 2 more/);
});

test('only the list of names to leave out travels to the server', () => {
  assert.match(ORG, /body: \{ excluded: \(opts\.excluded \|\| \[\]\)\.slice\(\) \}, retry: false/);
  assert.match(ORG, /getPhotoSelection: getPhotoSelection,/);
});

test('between 60 and 120 the preview says they go in smaller, and asks nothing', () => {
  assert.match(MODAL, /they go into the report at a smaller size so all of them fit/);
});
