# Topic player: honest Video button, speaker-coloured bar, one bar for video

Date: 2026-11-10 · Repo: fieldsight-ui · Builds on `2026-11-06-topic-player-design.md`
Status: draft for Fable review

## 1. Why

The owner tested the topic player on real TEST data (2026-11-07 14:05, Ben_Lin_test2) and asked for three things:

1. Show the **Video** button only when there is video for the topic, if the cost is acceptable.
2. Colour the progress bar by speaker, matching the speaker chips in the transcript (`spk_0` blue, and so on).
3. Give video the same bar. Today video mode shows the browser's native `<video controls>` timeline, which has no waveform and no speaker blocks.

The point of the player is unchanged: the owner checks the record against what was said. Speaker colours on the bar let them see who spoke where and jump to that part. Video should not be a different, poorer tool.

## 2. What we found (measured 2026-11-10)

- The Video button already depends on `load.videos.length > 0` (`scripts/composites/topic-player.js` ~L353, L472). The problem is what counts as a match.
- The backend (`lambda_org_api._read_org_video_segments`, pipeline ~L15099) assumes every file spans **600 s**, and it buffers the topic window by `MEDIA_WINDOW_BUFFER_SEC`. Real preview files are **~30 s chunks** (`..._sid<hex>_c0008.mp4`; ffprobe on c0003 = 30.22 s and c0008 = 30.23 s). One topic therefore matches every chunk within about ten minutes, so it shows the button (and a "1 of N" file list) for video that does not cover the topic.
- The previews are faststart: `moov` is in the first 64 bytes. Reading a file's duration with `preload="metadata"` costs one small range request.

## 3. Goals

- G1. The Video button appears only when at least one preview actually overlaps the topic window (unbuffered `props.start`..`props.end`).
- G2. The audio bar shows who spoke where, in the same colours as the transcript chips.
- G3. Video mode uses the same bar as audio mode (waveform, speaker colours, the topic shade), and the same play / -10 / +10 / speed / time controls.

## 4. Non-goals

- No backend change. The 600 s assumption stays on the server; the web computes real spans. A server-side span can come later, and the web would then simply use it.
- No speaker lanes (one row per speaker). The 11-06 decision stands: `spk_N` restarts per file.
- No volume slider in either mode (audio mode has none today).
- No change to how lines join audio (`source_filename` + `chunk_start`).

## 5. Anti-goals

- Hiding a video that does exist because a check failed. When unsure, show it.
- Colours that disagree with the chips. The bar and the chips must take colours from one function, never from two copies.
- Bars that are invisible in dark mode. Measure contrast in the browser; do not trust the CSS.

## 6. Design

### 6.1 Real video spans (G1)

A new pure function in `scripts/api/topic-playback.js`:

```
videoSpans(videos, durations) -> [{ ...video, span_start, span_end }]
```

- `span_start` = `video_start_sec`.
- `span_end`:
  - if the next preview **in the same session** (same `sid` parsed from `_sid<hex>_c<N>`) starts within 120 s, then `span_end` = that next start;
  - otherwise `span_end` = `video_start_sec + durations[key]` when the metadata probe gave a duration;
  - otherwise `video_start_sec + 600` (today's assumption). This keeps the anti-goal: a failed check shows the video, it never hides it.
- `overlapping(spans, startSec, endSec)` keeps the spans with `span_end > startSec && span_start < endSec`.

The probe: for each session's **last** preview only (every other span comes from its successor), create a detached `<video preload="metadata" muted>`, read `duration` on `loadedmetadata`, and give up after 4 s. This is at most one request per session per topic open, typically one.

TopicPlayer runs the probe after the first load, then sets `load.videos` to the overlapping spans. Until it settles, `hasVideo` is false, so the Video button appears late rather than wrongly. VideoPlayer receives only overlapping previews, so its "1 of N" list shrinks to the real ones.

### 6.2 Speaker colours (G2)

- Move `SPEAKER_PALETTE` and the first-appearance mapping out of `transcript-list.js` into `topic-playback.js`:

  ```
  speakerColors(turns) -> { [label]: { fg, bg } }
  ```

  It uses the same order rule (first appearance in the list given) and the same six colours. `transcript-list.js` calls it instead of its own copy, so the two cannot drift.

- `activityMarks` adds `speaker` (the label) to each mark. TopicPlayer computes `colors = speakerColors(turns)` from the store's turns, which are the transcript list's turns, and passes it to `Waveform`.
- Waveform:
  - Each bar takes the colour of the mark that covers its x position. A bar no turn covers stays neutral, as today.
  - Played bars (`x <= head`) are drawn at full colour. Unplayed bars inside the topic shade are drawn at 0.6 alpha, and those outside it at 0.3.
  - A 4 px strip along the bottom draws each mark's block in its speaker colour. This is the colour-block view the owner asked for, and it also shows when there are no peaks (the fallback path).
  - The playhead line stays in the accent colour.
- Theme: in light mode bars use `fg`; in dark mode they use `bg` (the pale tint reads on the dark panel). Read the theme the same way the canvas reads tokens today: from computed style, `color-scheme` or `data-theme` on `:root`. **Acceptance:** each colour against `--surface-panel` is at least 3:1 in both themes, measured in Chrome.
- The old rule "only a confirmed name earns a colour" was written for the accent underline. It is superseded here, because the chips already colour by label and the owner wants the bar to match them. A confirmed name still adds nothing extra. The strip colour is the label colour, exactly as on the chip.

### 6.3 One bar for video (G3)

When the topic has audio (`timeline.items.length > 0`) and video mode is on:

- The `<video>` loses `controls`. The main row is the same as audio mode: play button, `.fs-topic-player__track` with Waveform and the transparent seek input, then the controls row (-10, +10, speed, time, Audio/Video).
- Playhead: `P.clockToPos(timeline, current.video_start_sec + video.currentTime)`, updated on `timeupdate` and per frame while playing, as audio does.
- Seek: bar position to clock (`P.clockAt`), then the existing `seekClock` path (`videoTarget`). A moment no preview covers goes through the existing `onNoVideoMoment`: switch to audio at that moment and show the "No video at this moment" toast.
- The bar dims the parts no overlapping span covers: a neutral overlay at 0.35 alpha over those x ranges, computed from the spans through `clockToPos`. The user can see where video exists before clicking.
- Play/pause, -10/+10 and speed act on the video element in this mode. `onEnded` moves to the next span, as today. The Prev/Next buttons and the "n of N" count are removed, because the bar replaces them. The time label and filename stay.
- A **Fullscreen** button (`requestFullscreen` on the video element) replaces the one lost with the native controls. It is shown only when `document.fullscreenEnabled`.
- Video-only topics (no audio timeline) keep the native controls: there is no audio bar to draw.

Implementation shape, left to the builder: VideoPlayer becomes controlled. It takes `playing`, `rate`, a `seek` request and `onTime(clockSec)` / `onPlay` / `onPause` / `onEnded` from TopicPlayer, and renders `controls` only when it is given no host bar (`hostBar: false`). Its current self-loading path (no `videos` prop) is still used elsewhere and must keep working unchanged.

## 7. Tests (node --test, repo style)

- `videoSpans`:
  - successor rule within the same sid;
  - different sid, so the successor is not used;
  - a gap over 120 s;
  - probe duration used for the last file;
  - probe missing, so +600.
- `overlapping` boundaries:
  - touching ends do not overlap;
  - a topic inside one chunk;
  - a topic spanning three chunks.
- Real fixture: the 11 TEST chunks of 2026-11-07 (starts from §2, last duration 30 s).
  - A topic of 14:05:27–14:06:30 overlaps c0001, c0002 and c0003 only.
  - A topic at 14:20 overlaps none, so no Video button.
- `speakerColors`:
  - first-appearance order;
  - six colours wrap;
  - `transcript-list.js` imports it (source scan: no `SPEAKER_PALETTE` literal left there).
- `activityMarks` carries `speaker`.
- Source scans:
  - video mode with audio renders no `controls`;
  - the fullscreen button is gated on `fullscreenEnabled`;
  - the Prev/Next nav is gone from the host-bar path;
  - the self-loading VideoPlayer path keeps `controls: true`.
- Chrome on TEST (owner signed in, no reload; see the TEST session rule):
  - the 14:05 topic shows the button, and one far from video does not;
  - the bar colours match the chips;
  - the video plays from the bar;
  - the dimmed regions match the coverage;
  - dark and light contrast is measured.

## 8. Calls made on the owner's behalf

- Web-only span computation; no backend deploy (§4).
- When a probe fails, assume 600 s: show rather than hide (§5).
- Pale `bg` tint in dark mode, `fg` in light mode.
- Clicking a no-video part of the bar switches to audio, the existing behaviour, rather than snapping to the nearest video.
- Prev/Next file buttons removed in favour of the bar; fullscreen button added; no volume control.
