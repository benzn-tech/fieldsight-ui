'use strict';
/* Topic player bar (spec 2026-11-10): real video spans, speaker colours, the video playhead. */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
const P = require('../scripts/api/topic-playback.js');

const SID = '1b13e0dc081b499c930b61809a67190b';
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const sec = (hms) => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const chunk = (hms, n, sid = SID) => ({
  filename: 'ben_lin_test2_2026-11-07_' + hms.replace(/:/g, '-') + '_sid' + sid + '_c' + String(n).padStart(4, '0') + '.mp4',
  video_start_sec: sec(hms), is_preview: true, url: 'u' + n,
});
const names = (list) => list.map((v) => v.filename.slice(-9, -4));

test('sessionOf reads the sid from a chunk name, and a legacy name has none', () => {
  assert.strictEqual(P.sessionOf(chunk('14:05:07', 1).filename), SID);
  assert.strictEqual(P.sessionOf('ben_lin_test2_2026-11-07_14-00-00.mp4'), null);
  assert.strictEqual(P.sessionOf(null), null);
});

test('a successor within 45 s in the same session closes the span', () => {
  const s = P.videoSpans([chunk('14:00:00', 0), chunk('14:00:30', 1)], {});
  assert.strictEqual(s[0].span_end, sec('14:00:30'));
  assert.strictEqual(s[0].span_known, true);
  assert.strictEqual(s[0].span_start, sec('14:00:00'));
  assert.strictEqual(s[0].url, 'u0', 'the video fields are kept');
});

test('another session does not count as a successor', () => {
  const s = P.videoSpans([chunk('14:00:00', 0), chunk('14:00:30', 0, OTHER)], {});
  assert.strictEqual(s[0].span_end, sec('14:00:00') + 600);
  assert.strictEqual(s[0].span_known, false);
});

test('a gap over 45 s is not closed by the next file', () => {
  const s = P.videoSpans([chunk('14:00:00', 0), chunk('14:00:46', 1)], {});
  assert.strictEqual(s[0].span_known, false);
  assert.strictEqual(s[0].span_end, sec('14:00:00') + 600);
});

test('the successor is the next in list order, not the next chunk number', () => {
  /* The list is by video_start_sec; c0005 sits between c0001 and c0002 in time. */
  const s = P.videoSpans([chunk('14:00:00', 1), chunk('14:00:20', 5), chunk('14:00:40', 2)], {});
  assert.strictEqual(s[0].span_end, sec('14:00:20'));
  assert.strictEqual(s[1].span_end, sec('14:00:40'));
});

test('a probe duration closes the last file; no probe means 600 s and unknown', () => {
  const v = [chunk('14:00:00', 0), chunk('14:00:30', 1)];
  const probed = P.videoSpans(v, { [v[1].filename]: 30.2 });
  assert.strictEqual(probed[1].span_end, sec('14:00:30') + 30.2);
  assert.strictEqual(probed[1].span_known, true);
  const none = P.videoSpans(v, {});
  assert.strictEqual(none[1].span_end, sec('14:00:30') + 600);
  assert.strictEqual(none[1].span_known, false);
  assert.strictEqual(P.videoSpans(v, null)[1].span_known, false);
});

test('only files the successor rule leaves open are probed, at most six', () => {
  const v = [chunk('14:00:00', 0), chunk('14:00:30', 1), chunk('14:00:00', 0, OTHER),
    { filename: 'legacy_2026-11-07_13-00-00.mp4', video_start_sec: sec('13:00:00') }];
  assert.deepStrictEqual(P.probeTargets(v).map((x) => x.filename).sort(),
    [v[1].filename, v[2].filename, v[3].filename].sort());
  const eight = Array.from({ length: 8 }, (_, i) => chunk('14:0' + i + ':00', i));
  assert.strictEqual(P.probeTargets(eight).length, 6, 'gaps of 60 s leave all eight open; six probed');
  assert.strictEqual(P.probeTargets(eight, 2).length, 2);
});

test('overlap: touching ends do not overlap; null bounds keep everything', () => {
  const s = [{ span_start: 100, span_end: 130 }, { span_start: 130, span_end: 160 }, { span_start: 160, span_end: 190 }];
  assert.deepStrictEqual(P.overlapping(s, 130, 160), [s[1]], 'touching ends');
  assert.deepStrictEqual(P.overlapping(s, 135, 140), [s[1]], 'inside one chunk');
  assert.deepStrictEqual(P.overlapping(s, 110, 170), s, 'across three');
  assert.deepStrictEqual(P.overlapping(s, null, null), s);
  assert.deepStrictEqual(P.overlapping(s, null, 120), [s[0]]);
  assert.deepStrictEqual(P.overlapping(s, 185, null), [s[2]]);
});

test('videoTarget refuses a moment past the span at once, and old lists work as before', () => {
  const s = P.videoSpans([chunk('14:00:00', 0), chunk('14:00:30', 1)], { [chunk('14:00:30', 1).filename]: 30 });
  assert.deepStrictEqual(P.videoTarget(s, sec('14:00:40')), { index: 1, offset: 10 });
  assert.strictEqual(P.videoTarget(s, sec('14:01:01')), null);
  assert.deepStrictEqual(P.videoTarget([{ video_start_sec: 100 }], 5000), { index: 0, offset: 4900 });
});

/* The 11 TEST chunks of 2026-11-07, Ben_Lin_test2 (spec §2). */
const REAL = ['14:04:35', '14:05:07', '14:05:38', '14:06:09', '14:06:39', '14:07:10',
  '14:07:40', '14:08:11', '14:08:41', '14:09:12', '14:09:43'].map((t, i) => chunk(t, i));
const LAST = { [REAL[10].filename]: 30 };

test('real day: the 14:05 topic overlaps c0001 to c0003 only', () => {
  const spans = P.videoSpans(REAL, LAST);
  assert.ok(spans.every((s) => s.span_known));
  assert.deepStrictEqual(names(P.overlapping(spans, sec('14:05:27'), sec('14:06:30'))), ['c0001', 'c0002', 'c0003']);
  assert.deepStrictEqual(P.probeTargets(REAL).map((v) => v.filename), [REAL[10].filename], 'one probe for the day');
});

test('real day: a topic after the last chunk overlaps none', () => {
  const spans = P.videoSpans(REAL, LAST);
  assert.deepStrictEqual(P.overlapping(spans, sec('14:20:00'), sec('14:20:00')), []);
  assert.deepStrictEqual(P.overlapping(spans, sec('14:19:00'), sec('14:19:30')), []);
});

test('real day, no probe: the 600 s fallback shows c0010 for a moment it does not hold', () => {
  /* c0010 starts 14:09:43; + 600 s is 14:19:43. So 14:19 is inside the fallback
     and 14:20 is past it. (The spec said 14:20; the arithmetic says otherwise.) */
  const spans = P.videoSpans(REAL, {});
  assert.deepStrictEqual(names(P.overlapping(spans, sec('14:19:00'), sec('14:19:30'))), ['c0010']);
  assert.strictEqual(spans[10].span_known, false);
  assert.deepStrictEqual(P.overlapping(spans, sec('14:20:00'), sec('14:20:00')), []);
});

/* ---- speaker colours ---- */
const fs = require('node:fs');
const path = require('node:path');
const readSrc = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

test('speaker colours follow first appearance, wrap after six, and key on the label', () => {
  const turns = ['spk_2', 'spk_0', 'spk_2', 'spk_1', 'a', 'b', 'c', 'd'].map((s) => ({ speaker: s, speaker_name: 'Same Name' }));
  const c = P.speakerColors(turns);
  assert.deepStrictEqual(Object.keys(c), ['spk_2', 'spk_0', 'spk_1', 'a', 'b', 'c', 'd']);
  assert.deepStrictEqual(c.spk_2, P.SPEAKER_PALETTE[0]);
  assert.deepStrictEqual(c.spk_0, P.SPEAKER_PALETTE[1]);
  assert.deepStrictEqual(c.d, P.SPEAKER_PALETTE[0], 'the seventh wraps');
  assert.strictEqual(P.SPEAKER_PALETTE.length, 6);
  assert.deepStrictEqual(P.SPEAKER_PALETTE[0], { fg: '#1E40AF', bg: '#DBEAFE' }, 'spk first = blue, as the chips');
  assert.deepStrictEqual(P.speakerColors(null), {});
});

test('the swatch is the chip text colour in light, the chip fill in dark', () => {
  const pair = { fg: '#1E40AF', bg: '#DBEAFE' };
  assert.strictEqual(P.swatch(pair, false), '#1E40AF');
  assert.strictEqual(P.swatch(pair, true), '#DBEAFE');
  assert.strictEqual(P.swatch(undefined, true), null);
});

test('the transcript takes its colours from the same function, over the same turns the player gets', () => {
  const src = readSrc('scripts', 'composites', 'transcript-list.js');
  assert.doesNotMatch(src, /SPEAKER_PALETTE/);
  assert.match(src, /speakerColors\(state\.segments\)/);
  assert.match(src, /store\.set\(\{ turns: state\.segments \}\)/);
});

test('topic-playback.js loads before transcript-list.js', () => {
  const html = readSrc('app-shell-preview.html');
  assert.ok(html.indexOf('scripts/api/topic-playback.js') > 0);
  assert.ok(html.indexOf('scripts/api/topic-playback.js') < html.indexOf('scripts/composites/transcript-list.js'));
});
