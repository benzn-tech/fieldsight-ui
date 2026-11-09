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

/* ---- video clock -> bar position ---- */
const A = 'j_2026-11-04_13-00-17_sid1_c0000_off0.0_to300.0_srcwav';
const B = 'j_2026-11-04_13-05-19_sid1_c0003_bn4_off0.0_to122.0_srcwav';
const C = 'j_2026-11-04_13-10-00_sid1_c0007_off0.0_to30.0_srcwav';
const TL = P.buildTimeline([
  { filename: A + '.wav', url: 'a', duration: 300, absolute_start: 47000, absolute_end: 47300 },
  { filename: B + '.wav', url: 'b', duration: 122, absolute_start: 47319, absolute_end: 47441 },
  { filename: C + '.wav', url: 'c', duration: 30, absolute_start: 47600, absolute_end: 47630 },
]);

test('a clock inside a turn lands inside that turn on its own file', () => {
  /* Inside batch B the clock has run past start + offset by the bridged gaps. */
  const turns = [{ source_filename: B + '.json', chunk_start: 40, start: 47420, end: 47426, duration: 6 }];
  assert.strictEqual(P.videoClockToPos(TL, turns, 47422), 300 + 40 + 2);
  assert.notStrictEqual(P.clockToPos(TL, 47422), 342, 'clockToPos alone would sit elsewhere');
  assert.strictEqual(P.videoClockToPos(TL, turns, 47426), 346, 'clamped to the turn');
});

test('in silence past a batch stitched end the clock falls through to the next file start (known limit)', () => {
  assert.strictEqual(P.videoClockToPos(TL, [], 47500), 422);
  const unjoined = [{ source_filename: 'gone.json', chunk_start: 0, start: 47490, end: 47510, duration: 20 }];
  assert.strictEqual(P.videoClockToPos(TL, unjoined, 47500), 422, 'a turn that does not join falls back too');
});

test('uncovered: the bar ranges no video span covers', () => {
  const only = P.uncovered(TL, [{ span_start: 47319, span_end: 47441 }]);
  assert.deepStrictEqual(only.map((g) => [g.left * TL.total, g.right * TL.total]), [[0, 300], [422, 452]]);
  assert.deepStrictEqual(P.uncovered(TL, []), [{ left: 0, right: 1 }]);
  assert.deepStrictEqual(P.uncovered(TL, [{ span_start: 0, span_end: 99999 }]), []);
  assert.deepStrictEqual(P.uncovered(P.buildTimeline([]), []), []);
});

/* ---- wiring (source scans, as this suite does) ---- */
const player = () => readSrc('scripts', 'composites', 'topic-player.js');

test('the Video button waits for the real spans, and a video-only topic says it is loading meanwhile', () => {
  const src = player();
  assert.match(src, /var hasVideo = load\.spans !== null && load\.spans\.length > 0;/);
  assert.match(src, /spans: videos\.length \? null : \[\]/, 'no video means no wait');
  assert.match(src, /load\.spans === null && load\.videos\.length\) \{\s*return h\('div', \{ className: 'fs-topic-player fs-topic-player--quiet' \}, 'Loading recording…'\)/);
  assert.match(src, /videos: load\.spans/, 'VideoPlayer gets the overlapping spans');
  assert.match(src, /var all = P\.videoSpans\(videos, durations\);\s*return \{ all: all, overlap: P\.overlapping\(all, toSec\(props\.start\), toSec\(props\.end\)\) \}/);
  assert.match(src, /spans: got\.overlap, allSpans: got\.all/, 'the button reads overlap; the host bar seeks over all');
});

test('a probe reads metadata only, gives up, and lets the file go', () => {
  const src = player();
  const probe = src.slice(src.indexOf('function probeDuration'), src.indexOf('function probeDuration') + 1200);
  assert.match(probe, /preload = 'metadata'/);
  assert.match(probe, /muted = true/);
  assert.match(probe, /setTimeout\(function \(\) \{ finish\(null\); \}, PROBE_TIMEOUT_MS\)/);
  assert.match(probe, /removeAttribute\('src'\)/);
  assert.match(src, /var PROBE_TIMEOUT_MS = 4000;/);
  assert.match(src, /P\.probeTargets\(videos\)/);
});

test('the bar draws speaker colours: a strip from every mark, no confirmed-name accent', () => {
  const src = player();
  assert.doesNotMatch(src, /m\.name/);
  assert.match(src, /P\.swatch\(p\.colors\[m\.speaker\], p\.dark\)/);
  assert.match(src, /var STRIP = 4;/);
  assert.match(src, /g\.globalAlpha = played \? 1 : \(inside \? 0\.6 : 0\.3\)/);
  assert.match(src, /return P\.speakerColors\(turns\); \}, \[turns\]\)/, 'the same function and turns as the chips');
  assert.match(src, /colors: colors, dark: dark/);
});

test('the bar follows the theme: data-theme observed, observer released', () => {
  const src = player();
  const hook = src.slice(src.indexOf('function useDarkTheme'), src.indexOf('function useDarkTheme') + 900);
  assert.match(hook, /getAttribute\('data-theme'\) === 'dark'/);
  assert.match(hook, /new window\.MutationObserver/);
  assert.match(hook, /attributeFilter: \['data-theme'\]/);
  assert.match(hook, /disconnect\(\)/);
  assert.match(src, /props\.dark, props\.colors, props\.gaps\]/, 'a theme change redraws');
});

/* ---- one bar for video ---- */
test('the host video has no native controls; VideoPlayer keeps its own', () => {
  const src = player();
  assert.strictEqual((src.match(/h\('video'/g) || []).length, 1);
  const el = src.slice(src.indexOf("h('video'"), src.indexOf('}),', src.indexOf("h('video'")));
  assert.doesNotMatch(el, /controls/);
  assert.match(el, /preload: 'metadata'/);
  assert.match(readSrc('scripts', 'composites', 'video-player.js'), /controls:\s*true/);
});

test('one playing flag: each element speaks only in its own mode, and switching pauses the other', () => {
  const src = player();
  assert.match(src, /onPlay: function \(\) \{\s*if \(modeRef\.current !== 'audio'\) return;/);
  assert.match(src, /onPlay: function \(\) \{\s*if \(modeRef\.current !== 'video'\) return;/);
  const sw = src.slice(src.indexOf('function switchMode'), src.indexOf('function onNoVideoMoment'));
  assert.match(sw, /audioRef\.current\.pause\(\)/);
  assert.match(sw, /videoRef\.current\.pause\(\)/);
});

test('pressing the bar in video mode asks for the turn under the press, not the active one', () => {
  const src = player();
  const seek = src.slice(src.indexOf('function seekBar'), src.indexOf('function seekBar') + 700);
  assert.match(seek, /P\.turnAt\(store\.getState\(\)\.turns, timelineRef\.current, p\)/);
  assert.doesNotMatch(seek, /activeTurn/);
  assert.match(src, /P\.videoClockToPos\(/, 'the playhead is turn-anchored');
  assert.match(src, /setRate\(v, speed\)/, 'a new src keeps the speed');
});

test('fullscreen takes the whole player, and only where the browser allows it', () => {
  const src = player();
  assert.match(src, /wrapRef\.current\.requestFullscreen\(\)/);
  assert.match(src, /document\.fullscreenEnabled/);
  assert.match(src, /ref: wrapRef, className: 'fs-topic-player'/);
  assert.match(readSrc('styles', 'composites.css'), /\.fs-topic-player:fullscreen \{/);
});
