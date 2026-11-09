# Plan: topic player speaker bar

**Goal:** the Video button shows only when a preview actually overlaps the topic; the bar is coloured by speaker in the transcript chips' colours; video mode (with audio) uses the same bar and controls.

**Architecture:** pure rules in `scripts/api/topic-playback.js` (spans, overlap, colours, playhead mapping, uncovered ranges), DOM in `scripts/composites/topic-player.js` (probes, theme observer, host `<video>`, wrapper fullscreen). `VideoPlayer` is untouched (Evidence and video-only topics). `transcript-list.js` takes its colours from `speakerColors`.

**Spec:** `docs/superpowers/specs/2026-11-10-topic-player-speaker-bar-design.md` (rev 2).

**Global constraints:**
- Vanilla JS + `React.createElement`, no build. Bump `?v=` of every changed script/stylesheet in `app-shell-preview.html`.
- Tests: `TZ=Pacific/Auckland node --test tests/*.test.js`, then always `git checkout -- tests/fixtures/editor-to-prompt.body.json`. Baseline before this work: 2537 pass, 0 fail, 6 skipped.
- `git add` by explicit path, never `-A`, never stash. One commit per task.
- No backend change. `VideoPlayer` keeps `controls: true`. Plain-text rendering only. One colour function for chips and bar.
- Existing whole-file pins in `tests/topic-player.test.js` still hold: one `h('audio'`, no `.paused` reads, no `__line` class.

**Review focus:** span rule order (successor 45 s, then probe, then +600 unknown); probe cap 6; the one `playing` flag across two elements; the turn-anchored playhead; nothing in Evidence changes.

---

## Task 1: video spans (pure)

`topic-playback.js`, exported on `api`:

```
CHUNK_TOKENS_RE = /_sid([0-9a-f]{32})_c(\d{4,})(?:[._]|$)/
sessionOf(filename) -> sid | null
probeTargets(videos, cap = 6) -> videos[]        // entries not closed by the successor rule, first `cap`
videoSpans(videos, durations) -> [{ ...video, span_start, span_end, span_known }]
overlapping(spans, startSec, endSec) -> spans    // span_end > s && span_start < e; null bound = unbounded
videoTarget(videos, clockSec)                    // unchanged, plus: clock > span_end -> null
```

Tests (`tests/topic-player-spans.test.js`):
- `sessionOf`: chunk name -> sid; legacy `x_2026-11-07_14-00-00.mp4` -> null.
- `videoSpans`: successor within 45 s same sid -> `span_end` = successor start, known; different sid not a successor; gap > 45 s falls to probe; successor is next in list order (by `video_start_sec`), not by `cNNNN`; probe duration closes the last; no probe -> +600, `span_known: false`.
- `probeTargets`: only unclosed entries (last per sid, no-sid files); capped at 6 of 8.
- `overlapping`: touching ends do not overlap; topic inside one chunk; topic across three; null bounds keep all.
- `videoTarget`: clock past `span_end` -> null; old shape (no `span_end`) unchanged.
- Real fixture (11 TEST chunks 2026-11-07, Ben_Lin_test2), durations `{ c0010: 30 }`: 14:05:27–14:06:30 -> c0001..c0003; 14:20 -> none. Inverse (no durations): see Task 1 note.

**Spec arithmetic check:** c0010 starts 14:09:43 = 50983 s; +600 = 51583 s = 14:19:43, before 14:20:00 (51600). So the spec's inverse case ("no durations, 14:20 overlaps c0010") is wrong. The test uses 14:19:00–14:19:30 instead: none with durations, c0010 only without. 14:20 is still asserted to overlap none in both cases. The first expectation (c0001..c0003) checks out.

Verify: `node --test tests/topic-player-spans.test.js`.

## Task 2: speaker colours (pure + transcript)

```
SPEAKER_PALETTE (six {fg,bg}, moved from transcript-list.js)
speakerColors(turns) -> { [speaker]: { fg, bg } }   // first appearance, wraps after six, keyed on `speaker`
swatch(pair, dark) -> dark ? pair.bg : pair.fg
activityMarks(turns, timeline) -> [{ left, width, speaker }]   // `name` dropped
```

`transcript-list.js`: `var colors = window.FS.topicPlayback.speakerColors(state.segments)`; labels for the participant hint come from `Object.keys(colors)`; rows use `colors[s.speaker]`. No palette literal left.

Tests:
- `speakerColors`: order of first appearance; seventh speaker wraps to the first colour; keyed on `speaker` not `speaker_name`.
- `swatch`: light -> fg, dark -> bg.
- Existing 'activity marks…' test updated: marks carry `speaker`, have no `name` key.
- Scan: `transcript-list.js` has no `SPEAKER_PALETTE`, matches `speakerColors(state.segments)` and `store.set({ turns: state.segments })`.
- Scan: `topic-playback.js` loads before `transcript-list.js` in `app-shell-preview.html`.

## Task 3: playhead mapping and uncovered ranges (pure)

```
videoClockToPos(timeline, turns, clock) -> pos   // turn under clock joins -> anchored; else clockToPos
uncovered(timeline, spans) -> [{ left, right }]  // bar fractions no span covers, via clockToPos
```

Tests:
- A clock inside a turn in batch file B lands at B's `start + chunk_start + (clock - turn.start)`, not where `clockToPos` puts it.
- A clock past B's stitched end with no turn falls to C's start (422) under `clockToPos` (pins the known limit).
- `uncovered`: one span covering the middle file leaves the two ends; no spans -> whole bar; empty timeline -> [].

## Task 4: honest Video button (player state + probes)

`topic-player.js`:
- `probeDuration(url) -> Promise<number|null>`: detached `<video preload=metadata muted>`, 4 s timeout, finite `duration > 0` only, then removes `src`.
- First load sets `spans: videos.length ? null : []`; then probes `probeTargets(videos)` and sets `spans = overlapping(videoSpans(videos, durations), toSec(start), toSec(end))`, guarded by the effect's `cancelled`.
- `var hasVideo = load.spans !== null && load.spans.length > 0`; video-only topic with `spans === null` shows "Loading recording…". VideoPlayer gets `videos: load.spans`.

Tests (scan): `hasVideo` reads `spans`; "Loading recording…" on `spans === null`; `VideoPlayer` receives `load.spans`; probe has a timeout and removes `src`.

## Task 5: coloured waveform + theme

- Waveform props add `colors`, `dark`, `gaps`. Bar colour = swatch of the mark covering it (uncovered = today's colours); alpha 1 played, 0.6 unplayed inside shade, 0.3 outside; 4 px strip of mark blocks at full alpha, also on the no-peaks path; confirmed-name accent line removed; dim layer 0.35 over `gaps`.
- `useDarkTheme()`: reads `data-theme` on `<html>`, `MutationObserver` with `attributeFilter: ['data-theme']`, disconnects on unmount.

Tests (scan): no `m.name`; `MutationObserver` on `data-theme` with `disconnect`; strip drawn from `m.speaker`.

## Task 6: one bar for video

- TopicPlayer owns `h('video', …)` (no `controls`) when `mode === 'video' && timeline.items.length`. VideoPlayer only for video-only topics.
- One `playing` flag: each element's `play`/`pause` ignored unless it belongs to `modeRef.current`; `switchMode` pauses the outgoing element both ways.
- `seekBar(pos, resume)`: audio -> `seekPos`; video -> `clockAt(timeline, pos, turns[turnAt(...)])` then `seekVideoClock(clock, resume, request)`; no span -> `onNoVideoMoment` (switch to audio at that position, toast).
- Video `timeupdate` -> `activeTurn = turnAtClock`, `pos = videoClockToPos`; `readPos` branches on mode; `ended` -> next span at 0; rate reapplied on `loadedmetadata`.
- Fullscreen button on `wrapRef` (`.fs-topic-player`), only when `document.fullscreenEnabled`; CSS for `.fs-topic-player:fullscreen`.
- Bump `?v=`: composites.css 150->151, topic-playback 1->2, transcript-list 17->18, topic-player 1->2.

Tests (scan, updating existing pins deliberately):
- Exactly one `h('video'` in `topic-player.js`, and its props have no `controls`.
- Host video is before the controls row; `VideoPlayer` still before it too.
- `.fs-topic-player__video` has `max-height: min(240px, Nvh)` (old VideoPlayer rule kept).
- Cleanup pauses and clears the host video ref.
- Fullscreen calls `wrapRef.current.requestFullscreen` and is gated on `fullscreenEnabled`; CSS has `.fs-topic-player:fullscreen`.
- `video-player.js` still has `controls: true`.

Verify all: full suite 0 failures; reset the fixture file.
