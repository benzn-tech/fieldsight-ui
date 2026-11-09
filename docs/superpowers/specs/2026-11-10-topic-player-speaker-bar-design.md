# Topic player: honest Video button, speaker-coloured bar, one bar for video

Date: 2026-11-10 · Repo: fieldsight-ui · Builds on `2026-11-06-topic-player-design.md`
Status: rev 2. The Fable review (approve with changes) is folded in: the `spans` state, the turn-anchored video playhead, one `playing` flag, wrapper fullscreen, the theme rules and the source-scan updates.

## 1. Why

The owner tested the topic player on real TEST data (2026-11-07 14:05, Ben_Lin_test2) and asked for three things:

1. Show the **Video** button only when the topic has video, if the cost is acceptable.
2. Colour the progress bar by speaker, matching the speaker chips in the transcript (`spk_0` blue, and so on).
3. Give video the same bar. Video mode today shows the browser's native `<video controls>` timeline, which has no waveform and no speaker blocks.

The player's purpose is unchanged: the owner checks the record against what was said. Speaker colours on the bar show who spoke where and let the owner jump there. Video should not be a different, poorer tool.

## 2. What we found (measured 2026-11-10)

- The Video button already depends on `load.videos.length > 0` (`scripts/composites/topic-player.js` L353, L472). The problem is what counts as a match.
- The backend (`lambda_org_api._read_org_video_segments`, pipeline ~L15099) does two things:
  - it assumes every file spans **600 s**: it keeps a file when `vid_start + 600 >= start - 60` and `vid_start <= end + 60`, with `MEDIA_WINDOW_BUFFER_SEC = 60` (L13842);
  - it returns the list sorted by `video_start_sec`.
- Real preview files are **~30 s chunks** named `..._HH-MM-SS_sid<32 hex>_c<NNNN>.mp4`. The token regex is `chunk_stitch.py` L25. ffprobe gives 30.22 s for c0003 and 30.23 s for c0008. One topic therefore matches every chunk within about ten minutes.
- The previews are faststart: `moov` sits in the first 64 bytes. Bytes per metadata probe in Chrome are not yet measured (§7).
- Out of scope, noted so the span rule is not blamed: an H264-native original gets no `web_video/` preview (`lambda_vad.py` L885-887). It is returned with `is_preview: false`, both players filter it out, and such a device never shows a Video button.

## 3. Goals

- G1. The Video button appears only when at least one preview actually overlaps the topic window (unbuffered `props.start`..`props.end`). It never appears and then vanishes.
- G2. The audio bar shows who spoke where, in the chips' colours.
- G3. When the topic has audio, video mode uses the same bar (waveform, speaker colours, topic shade) and the same play / -10 / +10 / speed / time controls.

## 4. Non-goals

- No backend change. The web computes real spans; a server-side span can come later.
- No speaker lanes: the 11-06 decision stands, because `spk_N` restarts per file.
- No volume slider in either mode.
- No change to how lines join audio (`source_filename` + `chunk_start`).
- Evidence's video tab and video-only topics keep today's `VideoPlayer` with native controls.

## 5. Anti-goals

- Hiding a video that does exist because a check failed. When unsure, show it.
- Bar colours that disagree with the chips. Both come from one function.
- Bars unreadable in either theme. Measure in Chrome; do not trust the CSS.

## 6. Design

### 6.1 Real video spans (G1)

New pure functions in `scripts/api/topic-playback.js`:

```
sessionOf(filename) -> sid | null      // CHUNK_TOKENS_RE: /_sid([0-9a-f]{32})_c(\d{4,})(?:[._]|$)/
videoSpans(videos, durations) -> [{ ...video, span_start, span_end, span_known }]
overlapping(spans, startSec, endSec) -> spans
```

- `span_start` = `video_start_sec`.
- **Successor** = the next entry **in the returned list** (ordered by `video_start_sec`, not by `c<NNNN>`) with the same non-null sid.
- `span_end` is decided in this order:
  1. a successor exists and starts within **45 s** (1.5 × the measured 30 s chunk): `span_end` = the successor's start, `span_known: true`;
  2. otherwise, the probe gave a duration: `span_end` = `video_start_sec + durations[filename]`, `span_known: true`;
  3. otherwise `span_end` = `video_start_sec + 600` (today's assumption), `span_known: false`. A failed check shows the video, never hides it.
- Who gets probed: every entry that is not closed by rule 1. That is the last returned entry per sid; the backend clips the list, so the real successor may exist on S3 but be outside it. Files with no sid (legacy whole files) are probed too. **Cap: at most 6 probes per topic open.** Entries beyond the cap use rule 3.
- The probe: a detached `<video preload="metadata" muted>` with that preview's URL. Read `duration` on `loadedmetadata`, give up after 4 s, then remove `src` and release the element.
- `overlapping(spans, s, e)` keeps the spans with `span_end > s && span_start < e`. A null `s` or `e` means unbounded on that side, so a topic with no window keeps every span.
- `videoTarget` prefers `span_end` when present: a moment past it is refused at once (`null`), rather than after loading metadata.

State in TopicPlayer:

- `load.videos` is the raw preview list; it is fetched as today.
- `load.spans` is `null | Span[]`. It is `null` until the probes settle, then holds the overlapping spans.
- `hasVideo = load.spans !== null && load.spans.length > 0`. The button therefore appears late rather than wrongly.
- While `spans === null` on a topic with video and no audio, render the quiet "Loading recording…" line, not "No recording in this window".
- VideoPlayer (the video-only path) receives `load.spans`.

Known limit: the successor rule can overstate coverage by up to 45 s after a short chunk that ends early. Nothing wrong plays, because the `offset > duration` check still routes the seek to `onNoMoment`. The dim overlay (§6.3) may show "video" over up to 45 s of none.

### 6.2 Speaker colours (G2)

- `SPEAKER_PALETTE` and the first-appearance mapping move from `transcript-list.js` (L69, L919-937) into `topic-playback.js` as `speakerColors(turns) -> { [speaker]: { fg, bg } }`. It is keyed on `speaker` (the label), never `speaker_name`, and keeps the same six colours and order rule.
- `transcript-list.js` calls `speakerColors(state.segments)`. **Invariant:** `transcript-list.js` L889 `store.set({ turns: state.segments })` hands the player the same array the chips are coloured from (L920-924, L1042-1043). So `speakerColors(store.turns)` gives identical colours, and the index runs over all turns, not only the marked ones.
- Script order: `topic-playback.js` loads before `transcript-list.js` in `app-shell-preview.html`. This file serves Timeline and Evidence; confirm there is no other shell.
- Colours appear once the transcript has loaded. `store.turns` stays `[]` until the transcript mounts; the first Play sets `wantTurns` (`timeline.js` L4926-4931).
- `activityMarks` adds `speaker` to each mark and drops `name`. The confirmed-name accent underline (topic-player.js L118-122) is removed: the strip replaces it.
- Waveform drawing:
  - Each bar takes the swatch of the mark covering its x. A bar no turn covers stays neutral, as today.
  - Played bars (`x <= head`) are drawn at full alpha. Unplayed bars are 0.6 alpha inside the topic shade and 0.3 outside it.
  - A **4 px strip** along the bottom draws each mark's block at full alpha. The strip is the colour-identification layer, and it also draws when there are no peaks (the fallback path). The dimmed bars are decorative.
  - The playhead line stays the accent colour.
- **Swatch rule:** the hue matches the chip. The swatch is whichever of the pair passes 3:1 on `--surface-panel`:
  - light theme (white panel): `fg`, which passes (the lowest is `#B45309` at about 4.5:1);
  - dark theme (`#111827`, `tokens.css` L699): `bg`, which passes (over 10:1), while `fg` is about 2:1.

  So in light mode the bar is the chip's text colour, not its pale fill. That is expected.
- Theme: read `data-theme` on `<html>` (`scripts/theme.js` L36). Redraw on theme change: a `MutationObserver` on `documentElement`'s `data-theme`, whose effect redraws.
- **Acceptance:** played bars and the strip are each at least 3:1 against `--surface-panel` in both themes, measured in Chrome. Adjacent speaker colours are visibly distinct in dark mode, checked by eye. Amber `#FEF3C7` against peach `#FFE6D5` is the risky pair.

### 6.3 One bar for video (G3)

Applies when the topic has audio (`timeline.items.length > 0`) and video mode is on.

**Shape:** TopicPlayer owns a `<video>` element directly in this case, beside its `<audio>`. `VideoPlayer` stays unchanged for Evidence (`pages/evidence.js` L988/L1153, self-loading) and for video-only topics. The shared logic is small (target lookup, wait for metadata, `offset > duration` leads to `onNoMoment`), and keeping it out of VideoPlayer avoids a controlled-component refactor with a second caller.

Behaviour:

- The `<video>` has no `controls`. The main row is the same as audio mode: play button, the track (Waveform plus the transparent seek input), and the controls row (-10, +10, speed, time, Audio/Video, Fullscreen). Below the video sit the time label and the filename. The Prev/Next buttons and the "n of N" count are not shown here; the bar replaces them.
- **One `playing` flag.** `playing` and `store.playing` are set from the `play` and `pause` events of whichever element belongs to the current mode. A rejected `play()` promise leaves `playing` false, the same rule as `start()` (L258-261). `switchMode` pauses the outgoing element in both directions.
- **Playhead (video clock to bar position)**, in this order:
  1. `i = turnAtClock(turns, clock)`. If that turn exists and `turnTarget(timeline, turns[i])` joins, then `pos = position(timeline, at.index, at.offset + clamp(clock - turn.start, 0, turn.duration))`.
  2. Otherwise, in silence between turns, use `clockToPos(timeline, clock)`, which is approximate.

  Rule 1 is needed because `clockToPos` runs ahead inside a batch wav by the bridged gaps (`absolute_end` is the stitched length), so it can sit over the wrong speaker block while `turnAtClock` highlights the right row. The per-frame read is a ref to the `<video>`, branched by mode in `readPos`. Video `timeupdate` also writes `pos`, so switching back to Audio resumes at the same moment.
- **Seek (bar position to clock):** `clockAt(timeline, pos, turnAt(turns, timeline, pos))`. This uses the turn under the pressed position, not `activeTurn`, which in video mode is clock-derived. Then the span lookup runs:
  - in a span: load that file and seek to `clock - span_start`;
  - otherwise the existing `onNoVideoMoment` runs: switch to audio at that moment and show the "No video at this moment" toast.
- **Dim overlay:** a neutral layer at 0.35 alpha over the bar ranges no span covers, computed through `clockToPos`. It is shading only, and inside a batch it may be off by the bridged gaps.
- **Continuation:** at the end of a span, play continues into the next span automatically, jumping over any gap, as audio does across files. Rate (`setRate`, L256) is reapplied on every `loadedmetadata`, because a new `src` resets `playbackRate`.
- **Fullscreen:** fullscreen the **player wrapper** (`.fs-topic-player`), so the bar and controls stay usable. It needs CSS for `:fullscreen`: video fills the free height, the controls sit underneath. The button is shown only when `document.fullscreenEnabled`.
- Keyboard: the seek input and buttons are already focusable. With native controls gone, Space on the focused play button toggles play; no global shortcuts are added.

## 7. Tests (node --test, repo style)

Unit:

- `sessionOf`: a chunk name gives its sid; a legacy name gives null.
- `videoSpans`:
  - successor within 45 s in the same sid;
  - a different sid does not count as a successor;
  - a gap over 45 s;
  - list order is by `video_start_sec`;
  - probe duration closes the last file;
  - probe missing gives +600 and `span_known: false`;
  - the cap of 6.
- `overlapping`:
  - touching ends do not overlap;
  - a topic inside one chunk;
  - a topic spanning three;
  - null bounds keep all.
- Real fixture, the 11 TEST chunks of 2026-11-07 (§2), with `durations` passed explicitly (c0010 = 30 s):
  - 14:05:27–14:06:30 overlaps c0001–c0003 only;
  - 14:20 overlaps none;
  - inverse case: no durations, so 14:20 **does** overlap c0010 (600 s fallback).
- `speakerColors`: first appearance order; wraps after six; keyed on `speaker`.
- `activityMarks` carries `speaker` and not `name`.
- Playhead mapping:
  - a turn-anchored clock lands inside that turn's file position;
  - a batch item with the clock past the stitched end falls through to the next file's start under `clockToPos`. This pins the known limit rather than "fixing" it by extrapolation.

Source scans:

- `hasVideo` reads `spans`.
- `transcript-list.js` has no `SPEAKER_PALETTE` literal, and passes `state.segments` to both `speakerColors` and `store.set({ turns })`.
- `topic-playback.js` loads before `transcript-list.js`.
- The host `<video>` has no `controls`.
- Fullscreen targets the wrapper and is gated on `fullscreenEnabled`.
- `VideoPlayer` still renders `controls: true`.

Deliberate updates to existing pins in `tests/topic-player.test.js`:

- L93-103: marks carry `speaker`, not `name`; the confirmed-name colour rule is retired.
- L223-230: video max-height, now on the host video.
- L232-239: the video now renders inside the host, before the controls row.
- L241-243: the cleanup regex now covers the host video ref.

Chrome on TEST (owner signed in; never reload the tab):

- The 14:05 topic shows the button; a topic far from video does not.
- The bar colours match the chips.
- Video plays from the bar, and the playhead sits on the highlighted row's block.
- Dim regions match coverage.
- Dark and light contrast are measured, and the dark pairs are checked by eye.
- **Bytes per probe** are measured, to answer the owner's cost question.

## 8. Calls made on the owner's behalf

- Spans are computed on the web; no backend deploy.
- A failed probe means a 600 s assumption: show rather than hide.
- Successor window 45 s; probe cap 6.
- Swatch = whichever of the chip's pair passes 3:1: `fg` in light mode, `bg` in dark mode.
- Pressing a no-video part of the bar switches to audio, the existing behaviour.
- In video mode with audio, TopicPlayer owns the `<video>`. VideoPlayer is unchanged elsewhere.
- Prev/Next removed in this mode; wrapper fullscreen added; no volume control.
