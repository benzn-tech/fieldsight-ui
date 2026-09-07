'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { photoTime, groupByTopic, folderName } =
  require('../scripts/api/evidence-grouping.js');

function p(over) {
  return Object.assign({
    filename: 'Benl1_2026-09-02_09-55-26.jpg',
    topic_id: 't1', topic_title: 'Laundry Equipment Overview',
    userDisplayName: 'Ben Lin',
  }, over);
}

test('photoTime reads the ordinary device filename', () => {
  assert.strictEqual(photoTime('Benl1_2026-09-02_09-55-26.jpg'), '09-55-26');
});

test('photoTime reads a keyframe filename', () => {
  // Zero of these exist on prod today, but the code path that writes them
  // ships (photo-grid.js:44), so the parser must not mis-sort them into
  // "unknown" the day one appears.
  assert.strictEqual(photoTime('Benl1_2026-09-02_kf_s095526.jpg'), '09-55-26');
});

test('photoTime refuses to guess', () => {
  assert.strictEqual(photoTime('IMG_0042.jpg'), null);
  assert.strictEqual(photoTime(''), null);
  assert.strictEqual(photoTime(null), null);
});

test('groups are ordered by their first photo, not alphabetically', () => {
  const out = groupByTopic([
    p({ topic_id: 'b', topic_title: 'Air Compressor',
        filename: 'Benl1_2026-09-02_14-00-00.jpg' }),
    p({ topic_id: 'a', topic_title: 'Zebra Crossing',
        filename: 'Benl1_2026-09-02_08-00-00.jpg' }),
  ]);
  assert.deepStrictEqual(out.groups.map(g => g.topic_id), ['a', 'b']);
});

test('photos inside a group stay chronological', () => {
  const out = groupByTopic([
    p({ filename: 'Benl1_2026-09-02_10-00-00.jpg' }),
    p({ filename: 'Benl1_2026-09-02_09-00-00.jpg' }),
  ]);
  assert.deepStrictEqual(out.groups[0].photos.map(x => photoTime(x.filename)),
                         ['09-00-00', '10-00-00']);
});

test('an unparseable filename keeps payload order and sorts last', () => {
  // Guessing a time would put an invention into the folder numbering.
  const out = groupByTopic([
    p({ topic_id: 'x', filename: 'IMG_0042.jpg' }),
    p({ topic_id: 'x', filename: 'Benl1_2026-09-02_09-00-00.jpg' }),
  ]);
  assert.deepStrictEqual(out.groups[0].photos.map(x => x.filename),
    ['Benl1_2026-09-02_09-00-00.jpg', 'IMG_0042.jpg']);
});

test('nothing is dropped', () => {
  const input = [p({ topic_id: 'a' }), p({ topic_id: 'b' }), p({ topic_id: 'a' })];
  const out = groupByTopic(input);
  const total = out.groups.reduce((n, g) => n + g.photos.length, 0)
              + out.ungrouped.length;
  assert.strictEqual(total, input.length);
});

test('the same filename under two topics yields two entries', () => {
  // media.js:90-91 says this is real. De-duplicating would drop a photo from
  // a folder that should have it.
  const f = 'Benl1_2026-09-02_09-00-00.jpg';
  const out = groupByTopic([p({ topic_id: 'a', filename: f }),
                            p({ topic_id: 'b', filename: f })]);
  assert.strictEqual(out.groups.length, 2);
});

test('the ungrouped remainder is empty for anything the page can produce', () => {
  // A tripwire, not a feature (spec §2.1): every photo the Evidence page holds
  // came from report.topics[].related_photos and therefore HAS a topic. If a
  // list-photos endpoint later feeds this function topic-less photos, this
  // goes red and forces the UI decision instead of letting them vanish.
  const out = groupByTopic([p(), p({ topic_id: 'b' })]);
  assert.deepStrictEqual(out.ungrouped, []);
  const stray = groupByTopic([p({ topic_id: null, topic_title: null })]);
  assert.strictEqual(stray.ungrouped.length, 1);
});

test('folderName numbers, truncates at a word boundary, and never mid-word', () => {
  assert.strictEqual(
    folderName('Laundry Equipment Overview and Lint Collection System', 0),
    '01 Laundry Equipment Overview');
  assert.ok(folderName('Steam Heating and Energy Recovery System', 1)
            .startsWith('02 '));
});

test('folderName replaces path characters instead of dropping them', () => {
  // Dropping would merge "Level 1/2 inspection" and "Level 12 inspection".
  assert.strictEqual(folderName('Level 1/2 inspection', 0), '01 Level 1-2 inspection');
  assert.ok(!/[\\/:*?"<>|]/.test(folderName('a:b*c?d"e<f>g|h/i\\j', 0)));
});

test('two titles that truncate identically stay distinct by their number', () => {
  const a = folderName('Washing Machine Control Panel and Capacity Review', 0);
  const b = folderName('Washing Machine Control Panel and Load Sensors', 1);
  assert.notStrictEqual(a, b);
});

test('an empty title still yields a usable folder', () => {
  assert.strictEqual(folderName('', 4), '05 Untitled');
  assert.strictEqual(folderName(null, 0), '01 Untitled');
});

/* ---- the shape the payload really has ------------------------------------ */

test('topic_id 0 is a topic, not a missing one', () => {
  // The defect this file shipped and the browser caught. `topic_id` is the
  // payload's LOOP INDEX (render_report_shape emits "topic_id": i; the durable
  // id is topic_row_id), so the FIRST topic of every day is 0. A falsy check
  // dropped its photos on every single day — the most common case, not an edge
  // one — while every test above stayed green because they all used invented
  // string ids.
  const out = groupByTopic([
    { filename: 'Benl1_2026-04-29_07-12-04.jpg', topic_id: 0, topic_title: 'First' },
    { filename: 'Benl1_2026-04-29_08-46-11.jpg', topic_id: 1, topic_title: 'Second' },
  ]);
  assert.strictEqual(out.ungrouped.length, 0);
  assert.deepStrictEqual(out.groups.map(g => g.topic_id), [0, 1]);
});

test('the real payload shape loses nothing', () => {
  // Exactly what the browser handed the component: integer ids from 0, two
  // photos sharing the first topic.
  const real = [
    { filename: 'Benl1_2026-04-29_07-12-04.jpg', topic_id: 0, topic_title: 'Crane pre-start' },
    { filename: 'Benl1_2026-04-29_07-19-22.jpg', topic_id: 0, topic_title: 'Crane pre-start' },
    { filename: 'Benl1_2026-04-29_08-46-11.jpg', topic_id: 1, topic_title: 'Concrete pour' },
    { filename: 'Benl1_2026-04-29_11-08-44.jpg', topic_id: 2, topic_title: 'Scaffold' },
    { filename: 'Benl1_2026-04-29_11-31-02.jpg', topic_id: 2, topic_title: 'Scaffold' },
  ];
  const out = groupByTopic(real);
  assert.strictEqual(out.groups.reduce((n, g) => n + g.photos.length, 0), 5);
  assert.strictEqual(out.ungrouped.length, 0);
  assert.strictEqual(out.groups.length, 3);
});

test('an empty-string topic_id is still treated as absent', () => {
  const out = groupByTopic([{ filename: 'a.jpg', topic_id: '', topic_title: null }]);
  assert.strictEqual(out.ungrouped.length, 1);
});

/* ---- the whole day, not only the bound photos ---------------------------- */

const { photosForReport } = require('../scripts/api/evidence-grouping.js');

function report(over) {
  return Object.assign({
    user_name: 'Ben Lin',
    topics: [
      { topic_id: 0, topic_title: 'Crane pre-start',
        related_photos: ['a.jpg', 'b.jpg'] },
      { topic_id: 1, topic_title: 'Concrete pour', related_photos: ['c.jpg'] },
    ],
    photo_filenames: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
  }, over);
}

test('a photo no topic bound is carried, with no topic', () => {
  // The case the whole change exists for. Measured on prod 2026-09-07 by the
  // day-photos work: 71 of 90 photos on days that HAVE a report were
  // unreachable from any screen, because 37 % of topic time windows are a
  // single instant and a photo taken while nobody was talking binds to
  // nothing. Photograph a room in silence and every shot used to vanish.
  const rows = photosForReport(report());
  const d = rows.filter(r => r.filename === 'd.jpg');
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].topic_id, null);
});

test('a bound photo is NOT also emitted as unbound', () => {
  // photo_filenames is a superset of the bound ones, so a naive concat shows
  // every bound photo twice — once under its topic and once under No topic.
  const rows = photosForReport(report());
  assert.strictEqual(rows.filter(r => r.filename === 'a.jpg').length, 1);
  assert.strictEqual(rows.length, 4);
});

test('a photo bound to TWO topics still appears under both', () => {
  // media.js:90-91 says this is real, and the two occurrences are not
  // duplicates — they are the same photo in two folders. Only the UNBOUND
  // computation dedupes.
  const rows = photosForReport(report({
    topics: [
      { topic_id: 0, topic_title: 'One', related_photos: ['a.jpg'] },
      { topic_id: 1, topic_title: 'Two', related_photos: ['a.jpg'] },
    ],
    photo_filenames: ['a.jpg'],
  }));
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.topic_id), [0, 1]);
});

test('a day with no photo_filenames is byte-for-byte what it was', () => {
  // An older backend, or a verbatim-history day, which does not carry the
  // field. Absent must not become an empty day.
  const rows = photosForReport(report({ photo_filenames: undefined }));
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every(r => r.topic_id !== null));
});

test('a day with ONLY unbound photos still yields them', () => {
  // 2026-08-14 on prod: one topic, five photos, zero returned.
  const rows = photosForReport(report({
    topics: [{ topic_id: 0, topic_title: 'Silent walk', related_photos: [] }],
    photo_filenames: ['x.jpg', 'y.jpg'],
  }));
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every(r => r.topic_id === null));
});

test('every row carries the recorder, since the key is built from it', () => {
  photosForReport(report()).forEach(r => {
    assert.strictEqual(r.userDisplayName, 'Ben Lin');
  });
});

test('a report with neither topics nor photos is not an error', () => {
  assert.deepStrictEqual(photosForReport({}), []);
  assert.deepStrictEqual(photosForReport(null), []);
});

/* ---- measured against the whole prod corpus ------------------------------ */

test('topic_id is an integer on prod, and 0 appears on every report', () => {
  // Not a shape this file invented. Every one of the 99 prod reports carrying
  // topics has exactly one topic_id === 0, and all 428 topic_ids across them
  // are integers — never a uuid string. `render_report_shape` emits the loop
  // index; the durable id is topic_row_id.
  //
  // Replaying the whole corpus through this module with the pre-fix falsy
  // check gave: 211 photos in, 121 grouped, 90 dropped into `ungrouped` —
  // 43 % of every photo Evidence can see, on 99 reports out of 99. The fix is
  // one operator, so this test is what stops it being "simplified" back.
  const asProd = [
    { filename: 'a.jpg', topic_id: 0, topic_title: 'First topic of the day' },
    { filename: 'b.jpg', topic_id: 1, topic_title: 'Second' },
    { filename: 'c.jpg', topic_id: 2, topic_title: 'Third' },
  ];
  const out = groupByTopic(asProd);
  assert.strictEqual(out.ungrouped.length, 0, 'topic 0 must not be treated as absent');
  assert.strictEqual(out.groups.reduce((n, g) => n + g.photos.length, 0), 3);
});

test('every real prod topic title yields a legal folder name', () => {
  // The longest titles in the corpus, verbatim. Checked across all 69
  // photo-carrying topics: none produced an illegal character or a name over
  // 34 characters (28 + the "NN " prefix).
  const real = [
    'Laundry Equipment Overview and Lint Collection System',
    'Steam Heating and Energy Recovery System Explanation',
    'Washing Machine Control Panel and Capacity Review',
    'Concrete pour — Block 4 south footing',
    'Three consecutive days without contact with Brade Construction Queenstown',
  ];
  real.forEach((title, i) => {
    const name = folderName(title, i);
    assert.ok(name.length <= 34, name + ' is ' + name.length + ' chars');
    assert.ok(!/[\/:*?"<>|]/.test(name), name);
    assert.ok(/^\d\d /.test(name), name);
  });
});
