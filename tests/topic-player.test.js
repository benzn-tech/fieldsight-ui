'use strict';
/* Topic player (spec 2026-11-06): the join, the bar, the masked words, the wiring. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
global.localStorage = global.localStorage || { getItem: () => null, setItem: () => {} };
const P = require('../scripts/api/topic-playback.js');
const M = require('../scripts/api/mask-words.js');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'scripts', ...p), 'utf8').replace(/\r\n/g, '\n');

const A = 'j_2026-11-04_13-00-17_sid1_c0000_off0.0_to300.0_srcwav';
const B = 'j_2026-11-04_13-05-19_sid1_c0003_bn4_off0.0_to122.0_srcwav';
const C = 'j_2026-11-04_13-10-00_sid1_c0007_off0.0_to30.0_srcwav';
const SEGS = [
  { filename: A + '.wav', url: 'a', duration: 300, absolute_start: 47000, absolute_end: 47300 },
  { filename: B + '.wav', url: 'b', duration: 122, absolute_start: 47319, absolute_end: 47441 },
  { filename: C + '.wav', url: 'c', duration: 30, absolute_start: 47600, absolute_end: 47630 },
];
const TL = P.buildTimeline(SEGS);

test('files lay end to end, and a file with no length is dropped', () => {
  assert.strictEqual(TL.total, 452);
  assert.deepStrictEqual(TL.items.map((i) => i.start), [0, 300, 422]);
  assert.strictEqual(P.buildTimeline([{ filename: 'x.wav', duration: 0 }, { filename: 'y.wav' }]).items.length, 0);
  assert.strictEqual(P.buildTimeline(null).total, 0);
});

test('locate and position are inverses, and locate clamps', () => {
  assert.deepStrictEqual(P.locate(TL, 310), { index: 1, offset: 10 });
  assert.strictEqual(P.position(TL, 1, 10), 310);
  assert.deepStrictEqual(P.locate(TL, -5), { index: 0, offset: 0 });
  assert.deepStrictEqual(P.locate(TL, 9999), { index: 2, offset: 30 });
  assert.strictEqual(P.locate(P.buildTimeline([]), 0), null);
});

test('a line joins on file plus offset, not on the clock', () => {
  /* In a batch the clock has moved on far past start + offset. */
  const turn = { source_filename: B + '.json', chunk_start: 40, start: 47500, duration: 3 };
  assert.deepStrictEqual(P.turnTarget(TL, turn), { index: 1, offset: 40 });
});

test('a line with no file on the bar has no target', () => {
  assert.strictEqual(P.turnTarget(TL, { source_filename: 'other.json', chunk_start: 1 }), null);
  assert.strictEqual(P.turnTarget(TL, { chunk_start: 1 }), null, 'mock shape');
  assert.strictEqual(P.turnTarget(TL, { source_filename: A + '.json' }), null, 'no offset');
  assert.strictEqual(P.turnTarget(TL, null), null);
});

test('turnAt finds the line by file and offset; a silent stretch has none', () => {
  const turns = [
    { source_filename: A + '.json', chunk_start: 10, duration: 5 },
    { source_filename: B + '.json', chunk_start: 10, duration: 5 },
  ];
  assert.strictEqual(P.turnAt(turns, TL, 12), 0);
  assert.strictEqual(P.turnAt(turns, TL, 312), 1, 'same offset, other file');
  assert.strictEqual(P.turnAt(turns, TL, 20), null);
  assert.strictEqual(P.turnAt(turns, TL, 15), null, 'end is exclusive');
  assert.strictEqual(P.turnAt([], TL, 12), null);
});

test('a wav with no transcript still plays and simply has no line', () => {
  assert.strictEqual(P.turnAt([{ source_filename: A + '.json', chunk_start: 0, duration: 9 }], TL, 430), null);
  assert.strictEqual(P.locate(TL, 430).index, 2);
});

test('video uses the clock and names no file before the first', () => {
  const v = [{ video_start_sec: 100 }, { video_start_sec: 700 }];
  assert.deepStrictEqual(P.videoTarget(v, 150), { index: 0, offset: 50 });
  assert.deepStrictEqual(P.videoTarget(v, 900), { index: 1, offset: 200 });
  assert.strictEqual(P.videoTarget(v, 50), null);
  assert.strictEqual(P.turnAtClock([{ start: 10, end: 20 }], 15), 0);
  assert.strictEqual(P.turnAtClock([{ start: 10, end: 20 }], 25), null);
});

test('the clock shown prefers the turn, which knows its own', () => {
  const turn = { start: 47500, chunk_start: 40 };
  assert.strictEqual(P.clockAt(TL, 345, turn), 47505);
  assert.strictEqual(P.clockAt(TL, 10, null), 47010);
  assert.strictEqual(P.fmtClock(47505), '13:11:45');
  assert.strictEqual(P.fmtClock(null), '');
  assert.strictEqual(P.fmtLength(125), '2:05');
});

test('clockToPos sets a start in the file holding the moment', () => {
  assert.strictEqual(P.clockToPos(TL, 47010), 10);
  assert.strictEqual(P.clockToPos(TL, 46000), 0, 'before the first file');
  assert.strictEqual(P.clockToPos(TL, 99999), 452, 'after the last');
});

test('activity marks: join only, colour only from a confirmed name', () => {
  const marks = P.activityMarks([
    { source_filename: A + '.json', chunk_start: 0, duration: 45.2, speaker_name: 'Sam', speaker_state: 'confirmed' },
    { source_filename: A + '.json', chunk_start: 50, duration: 1, speaker_name: 'Lee', speaker_state: 'tentative' },
    { source_filename: 'gone.json', chunk_start: 0, duration: 9 },
  ], TL);
  assert.strictEqual(marks.length, 2);
  assert.strictEqual(marks[0].name, 'Sam');
  assert.strictEqual(marks[1].name, null);
  assert.ok(Math.abs(marks[0].width - 0.1) < 1e-9);
});

test('missing files: the earliest start to ask for, null when none', () => {
  assert.strictEqual(P.missingFileStart([{ source_filename: A + '.json', chunk_start: 3, start: 47003 }], TL), null);
  assert.strictEqual(P.missingFileStart([
    { source_filename: 'x.json', chunk_start: 40, start: 46040 },
    { source_filename: 'y.json', chunk_start: 0, start: 46500 },
  ], TL), 46000);
  assert.strictEqual(P.missingFileStart([{ text: 'mock' }], TL), null);
});

test('merge keeps the newer URL and clock order', () => {
  const out = P.mergeSegments(
    [{ filename: 'b', absolute_start: 2, url: 'old' }],
    [{ filename: 'a', absolute_start: 1, url: 'n1' }, { filename: 'b', absolute_start: 2, url: 'new' }]);
  assert.deepStrictEqual(out.map((s) => s.url), ['n1', 'new']);
});

test('store notifies on a change only, and handlers are replaceable', () => {
  const s = P.createStore();
  let n = 0;
  const off = s.subscribe(() => { n += 1; });
  s.set({ activeTurn: 3 }); s.set({ activeTurn: 3 });
  assert.strictEqual(n, 1);
  off(); s.set({ activeTurn: 4 });
  assert.strictEqual(n, 1);
  assert.strictEqual(s.canSeek({}), false);
  let got = null;
  s.setHandlers({ canSeek: () => true, seekToTurn: (t) => { got = t; } });
  s.seekToTurn('x');
  assert.strictEqual(got, 'x');
  s.setHandlers(null);
  assert.strictEqual(s.canSeek({}), false);
});

/* ---- masked words ---- */
test('listed words keep their first letter and length', () => {
  assert.strictEqual(M.maskWords('oh shit'), 'oh s***');
  assert.strictEqual(M.maskWords('Fucking hell'), 'F****** hell');
  assert.strictEqual(M.maskWords('BULLSHIT, mate.'), 'B*******, mate.');
  assert.strictEqual(M.maskWords("that's a bitch's job"), "that's a b****'s job");
});

test('every listed word is masked', () => {
  for (const w of M.WORDS) {
    const out = M.maskWords('a ' + w + ' b');
    assert.notStrictEqual(out, 'a ' + w + ' b', w);
    assert.strictEqual(out.length, ('a ' + w + ' b').length, w);
  }
});

test('words with an ordinary site meaning are left alone', () => {
  for (const s of ['stopcock', 'Dick said the cock is fine', 'a pin prick', 'pissing down', 'hell', 'damn', 'bloody', 'crap',
    'Scunthorpe', 'cockpit', 'shitake', 'assess the asset', 'bastardised', 'twatter', 'Mitchell', 'Fuchsia']) {
    assert.strictEqual(M.maskWords(s), s, s);
  }
});

test('empty input', () => {
  assert.strictEqual(M.maskWords(null), '');
  assert.strictEqual(M.maskWords(undefined), '');
  assert.strictEqual(M.hasMasked(null), false);
  assert.strictEqual(M.hasMasked('fine'), false);
  assert.strictEqual(M.hasMasked('shit'), true);
});

test('revealing shows the original and tells listeners', () => {
  let n = 0;
  const off = M.subscribe(() => { n += 1; });
  M.setRevealed(true);
  assert.strictEqual(M.display('oh shit'), 'oh shit');
  M.setRevealed(false);
  assert.strictEqual(M.display('oh shit'), 'oh s***');
  off();
  assert.strictEqual(n, 2);
});

/* ---- wiring ---- */
test('Audio and Video tabs are gone from the topic, and the player sits above the tabs', () => {
  const src = read('pages', 'timeline.js');
  const tabs = src.slice(src.indexOf('var DAILY_TABS = ['), src.indexOf('var MEETING_TABS'));
  assert.doesNotMatch(tabs, /'audio'|'video'/);
  const render = src.slice(src.indexOf('/* Header */', src.indexOf('function TimelineRightDetail')));
  assert.ok(render.indexOf('createElement(fs.TopicPlayer') > 0);
  assert.ok(render.indexOf('createElement(fs.TopicPlayer') < render.indexOf('fs-topic-detail__tabs'));
});

test('the transcript stays mounted across tabs and is keyed by topic', () => {
  const src = read('pages', 'timeline.js');
  assert.match(src, /key: 'transcript-' \+ sel\.id/);
  assert.match(src, /hidden: tab !== 'transcript'/);
});

test('masking is display only: the row renders through it, and the naming path does not', () => {
  const src = read('composites', 'transcript-list.js');
  assert.match(src, /masks\.display\(s\.text\)/);
  assert.doesNotMatch(src, /body[^\n]*maskWords|correctionBody[^\n]*display\(/);
  for (const f of ['api/transcripts.js', 'api/actions.js', 'composites/ask-chat.js']) {
    assert.doesNotMatch(read(f), /maskWords/, f);
  }
});

test('one audio element, stopped explicitly, with state from media events', () => {
  const src = read('composites', 'topic-player.js');
  assert.strictEqual((src.match(/h\('audio'/g) || []).length, 1);
  assert.match(src, /el\.pause\(\); el\.removeAttribute\('src'\)/);
  assert.doesNotMatch(src, /\b(el|current)\.paused/);
});

test('found on real recordings: the tabs hold still, and the Due calendar stays in the panel', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'composites.css'), 'utf8').replace(/\r\n/g, '\n');
  const line = css.slice(css.indexOf('.fs-topic-player__line {'));
  const rule = line.slice(0, line.indexOf('}'));
  const clamp = Number(rule.match(/-webkit-line-clamp: (\d+)/)[1]);
  const height = Number(rule.match(/line-height: ([\d.]+)/)[1]);
  assert.strictEqual(Number(rule.match(/min-height: ([\d.]+)em/)[1]), clamp * height, 'reserves every line the clamp can show');
  assert.match(css, /assignee-label--due ~ \.fs-date-field \.fs-date-field__popover \{\s*left: auto;\s*right: 0;/);
});

test('new scripts load, pure modules before the player and the page', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app-shell-preview.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  assert.ok(at('scripts/api/topic-playback.js') > 0);
  assert.ok(at('scripts/api/mask-words.js') > 0);
  assert.ok(at('scripts/composites/topic-player.js') > 0);
  assert.ok(at('scripts/composites/topic-player.js') < at('scripts/pages/timeline.js'));
});
