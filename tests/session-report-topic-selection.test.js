'use strict';
/* Which topics a meeting report covers, as it reaches the wire.

   The backend has accepted `topicRowIds` on POST /sessions/{id}/report since it
   was built, and no screen ever sent it -- so choosing what goes in a report has
   never been reachable. Its contract is what these tests pin from the client
   side:

     absent -> the whole meeting        (what every existing report is)
     []     -> 400, "report on nothing"  (so the client must never send it)
     [ids]  -> intersected server-side with what the caller may see

   The first line is the compatibility promise. A reviewer who touches nothing
   must produce exactly the request they produced before this change existed. */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
if (!global.window.FieldSight) global.window.FieldSight = {};

const { buildGeneratePayload, selectedRowIds, windowChecked, canGenerate } =
  require('../scripts/composites/session-report-modal.js');

const TOPICS = [
  { topic_row_id: 'a', time_range: '09:05 \u2013 09:40', topic_title: 'Slab pour' },
  { topic_row_id: 'b', time_range: '11:20 \u2013 11:50', topic_title: 'Door hardware' },
  { topic_row_id: 'c', time_range: '13:40 \u2013 13:41', topic_title: 'Lunch' },
  { topic_row_id: 'd', time_range: null,                topic_title: 'Unplaced' },
];

test('untouched: selection is null, meaning the whole meeting', () => {
  assert.strictEqual(selectedRowIds(TOPICS, {}), null);
  assert.strictEqual(selectedRowIds(TOPICS, undefined), null);
});

test('untouched: the payload has NO topicRowIds key at all', () => {
  const p = buildGeneratePayload({ session: { session_id: 's' }, date: 'd', userFolder: 'u',
    form: {}, deliver: 'download', topicRowIds: selectedRowIds(TOPICS, {}) });
  assert.ok(!('topicRowIds' in p), 'absent, not null and not []');
});

test('unticking one sends the rest, in meeting order', () => {
  assert.deepStrictEqual(selectedRowIds(TOPICS, { c: false }), ['a', 'b', 'd']);
});

test('ticking back after unticking returns to the whole meeting', () => {
  assert.strictEqual(selectedRowIds(TOPICS, { c: true }), null);
});

test('unticking everything is [], and Generate refuses it', () => {
  const none = selectedRowIds(TOPICS, { a: false, b: false, c: false, d: false });
  assert.deepStrictEqual(none, []);
  assert.strictEqual(canGenerate('download', [], none), false);
});

test('an empty selection never reaches the wire even if Generate were forced', () => {
  const p = buildGeneratePayload({ session: { session_id: 's' }, date: 'd', userFolder: 'u',
    form: {}, deliver: 'download', topicRowIds: [] });
  assert.ok(!('topicRowIds' in p));
});

test('canGenerate keeps its old behaviour when no selection is passed', () => {
  assert.strictEqual(canGenerate('download', []), true);
  assert.strictEqual(canGenerate('email', []), false);
  assert.strictEqual(canGenerate('download', [], null), true);
});

test('a 9:00-11:30 window picks the overlapping topics and not the unplaced one', () => {
  const c = windowChecked(TOPICS, '09:00', '11:30');
  assert.deepStrictEqual(c, { a: true, b: true, c: false, d: false });
  assert.deepStrictEqual(selectedRowIds(TOPICS, c), ['a', 'b']);
});

test('a window that covers every placeable topic still names them explicitly', () => {
  // The unplaced topic is not in any window, so this is a real subset -- and
  // saying so is how a reviewer finds out a topic had no time to match on.
  const c = windowChecked(TOPICS, '00:00', '23:59');
  assert.deepStrictEqual(selectedRowIds(TOPICS, c), ['a', 'b', 'c']);
});

test('a topic with no row id is never sent and never blocks a selection', () => {
  const topics = TOPICS.concat([{ time_range: '09:10 \u2013 09:20', topic_title: 'mock only' }]);
  assert.deepStrictEqual(selectedRowIds(topics, { c: false }), ['a', 'b', 'd']);
});

test('the payload copies the ids rather than aliasing the tick state', () => {
  const ids = ['a'];
  const p = buildGeneratePayload({ session: { session_id: 's' }, date: 'd', userFolder: 'u',
    form: {}, deliver: 'download', topicRowIds: ids });
  ids.push('z');
  assert.deepStrictEqual(p.topicRowIds, ['a']);
});
