# Topic player: hear it and read it at the same time

**Status:** design, 2026-11-06. Frontend only. No backend change, no migration, no flag.
**Requested by:** the owner, reviewing Timeline as a user.

## Why

The owner opens a topic to check whether the record is right. Today that cannot be done:

1. Playing a recording shows no transcript, so a line cannot be checked against what was said.
2. Switching from Audio to Transcript stops playback. `bodyByTab[tab]` in `TimelineRightDetail`
   renders only the active tab, so the `<audio>` element is unmounted.
3. Audio has no progress bar. `AudioPlaylist` renders each file as a row with a bare `<audio>`
   and no `controls`, so a 5-minute file can only be played from the start.
4. Transcript lines can hold words a customer would rather not see on screen.

The owner also asked whether to copy Avoma's per-speaker heatmap lanes. Decision, recorded so it
is not re-litigated: **no lanes now.** Avoma's lanes serve sales coaching (who talked how much).
The FieldSight job is verifying evidence. And the labels cannot carry lanes: measured on prod
(James_Lamb, 2026-10-30 and 2026-11-04), each file has its own 1 to 4 `spk_N` labels, restarting per
file, so a lane would draw one person as several. Lanes come back when most turns carry confirmed
names; nothing here blocks them.

## Measured facts this design rests on

Read-only from the prod bucket on 2026-11-06.

| Fact | Evidence |
|---|---|
| A transcript and its wav share a file stem | 19/19, 15/15, 4/4, 8/8 on four days, including a batched day |
| Each transcript turn carries `source_filename` and `chunk_start` (offset inside that file) | `_read_org_transcripts` in `lambda_org_api.py` |
| Clock arithmetic is wrong inside a batch wav | A batch stitches chunks with gaps bridged; `batch_map.members` has `batch_offset_sec` and `abs_start`, and the audio API does not return them. `absolute_start + offset` lands early after a bridged gap |
| The audio API hides chunks a batch covers | `batch_cover.covered_chunk_keys`; so the stems the listing returns are the ones transcripts name |
| Some wavs have no transcript | Rejected by VAD, or chunk wavs on a day with batches. They must still play |
| Video coverage is partial | 15 wavs against 4 videos on one day; 0 videos on another |
| Video files are continuous and named by clock | `video_start_sec` from the filename. API returns no duration |

Consequence: **audio sync joins on file plus offset, never on the clock.** Video has no such join,
so it uses the clock, which is sound because a video file is not stitched.

## What the person sees

```
[ topic header: time, title, participants                         ]
[ ▶  -10 +10  1x   ▮▮▮▮|▮▮  ▮▮▮|▮▮▮▮▮    02:14 / 07:30  Audio|Video ]   <- stays while tabs change
[ "...the pour's been pushed to Thursday..."  (the current line)   ]
[ Overview | Transcript | Photos                                   ]
[ tab body                                                         ]
```

- **Player bar** sits between the header and the tab strip, outside the scrolling body. Switching
  tabs does not touch it. Closing the panel or selecting another topic stops playback.
- **Progress bar** covers the whole topic: the listed audio files laid end to end, so a topic made
  of six files has one bar. Dragging it moves across files. Time shown is position in that bar.
- **Activity strip** behind the bar: one mark per transcript turn. Neutral colour, or the speaker's
  colour where the turn has a confirmed `speaker_name`. Not lanes. Appears once turns have loaded.
- **Current line** under the bar: the turn being spoken, in every tab, so Overview can be checked by
  ear without changing tabs. Blank when the position has no turn.
- **Transcript tab:** the current turn is highlighted and scrolls into view while playing. If the
  person scrolls away, following stops and a "Follow playback" button appears; pressing it resumes.
  Each row's time is a button: press it to play from that line.
- **Audio|Video** switch appears only when the topic has a video. It keeps the position as near as
  the clock allows (see Video). Audio is the default because it always covers the whole topic.
- **Speed:** 1x, 1.25x, 1.5x, 2x, kept across files. **-10 / +10** seconds, across files.

The Audio and Video tabs are removed from Timeline: the player replaces them. Evidence keeps
`AudioPlaylist` and `VideoPlayer` unchanged; it is a different page with its own job.

### Masked words

- In the transcript and the current line, listed words show as first letter plus asterisks:
  `shit` to `s***`, `fucking` to `f******`. Length is kept so the line does not reflow on reveal.
- **Masking is on by default**, and a "Show original" toggle at the top of the Transcript tab reveals
  everything for that viewer. The owner's reason for the player is checking accuracy, and a masked
  word cannot be checked, so the reveal must be one press away. The choice is remembered per browser.
- **Display only.** Stored text, reports, Ask, search, exports and the naming panel are untouched.
- Whole words only, case-insensitive, with the common endings. No substring matching, and no words
  with ordinary site meanings: `stopcock`, `Dick` as a name, `prick` (a pin prick), `hell`, `damn`,
  `bloody`, `crap`, `piss` are all left alone. Over-masking a construction transcript is the worse failure.

## How it is built

### `scripts/api/topic-playback.js` (pure, no DOM, tested)

- `buildTimeline(segments)`: `{ items: [{ filename, url, start, duration, stem }], total }`. Sorted as
  the API returned them. `start` is cumulative. A segment with no positive duration is dropped.
- `locate(timeline, pos)`: `{ index, offset }`, clamped to the timeline.
- `position(timeline, index, offset)`: inverse of `locate`.
- `turnTarget(timeline, turn)`: `{ index, offset }` when `stem(turn.source_filename)` is in the
  timeline, offset `turn.chunk_start`; else `null`. A `null` row shows its time as plain text with no
  play control: it must not seek somewhere approximate and present that as the line.
- `turnAt(turns, timeline, pos)`: index of the turn being spoken, joined the same way: the file at
  `pos`, and a turn on that file with `chunk_start <= offset < chunk_start + duration`. Else `null`.
- `turnAtClock(turns, clockSec)`: for video; turn whose `[start, end]` holds `clockSec`.
- `videoTarget(videos, clockSec)`: `{ index, offset }` of the last video starting at or before
  `clockSec`, or `null` when before the first. Whether the file actually reaches that moment is only
  known after its metadata loads; see Video.
- `activityMarks(turns, timeline)`: `[{ left, width, name }]` as fractions of `total`; a turn that
  does not join yields no mark.

### `scripts/api/mask-words.js` (pure, tested)

`maskWords(text)` returns text with listed words masked. Keeps `null`/`undefined` as `''`.

### `scripts/composites/topic-player.js`

Owns one `<audio>` and, in Video mode, one `<video>`. There is one audio element whose `src` changes,
not one per file, so only one thing can ever be playing.

- Fetches `getAudioSegments` and `getVideoSegments` when the topic opens, so the bar shows the real
  length before anything plays. `preload="metadata"`.
- **State comes from media events** (`play`, `pause`, `ended`, `timeupdate`, `error`), never from
  reading `.paused`, the same rule as `AudioPlaylist` (BUG-21).
- `ended` loads the next file and continues at the same speed. On the last file it stops.
- Seeking to another file: set `src`, wait for `loadedmetadata`, set `currentTime`, then resume if it
  was playing. A newer seek cancels an older one still waiting.
- **Expired links.** URLs last 15 minutes and a long check outlives them. On a media `error`, refetch
  the segment list once, match by `filename`, restore the position, resume if it was playing. Matched
  by filename because a refetch may reorder. A second failure shows "Could not load audio." with a
  Retry button and keeps the position.
- Exposes position through a small store (`subscribe`, `getState`, `seekToTurn`) so `timeupdate` at 4 Hz
  does not re-render the whole detail panel; only the bar, the current line and the active row listen.
- Empty states as today: "No audio in this window." When both are empty the bar is one quiet line.

### Video

Native `controls`, because API has no duration for a virtual bar across files. "Clip 2 of 4" with
Previous and Next; `ended` goes to the next clip. Clock is `video_start_sec + currentTime`, which drives
the current line and the highlight through `turnAtClock`.

Pressing a transcript time in Video mode uses `videoTarget`. If there is none, or the offset is past the
file's duration once metadata loads, the player switches to Audio at that line and says "No video at
this moment". It does not play the wrong moment.

Switching Audio to Video: clock from the active turn's `start`, else the current file's
`absolute_start + offset`. This is approximate inside a batch and only sets a starting point.
Switching Video to Audio: nearest turn by clock, then `turnTarget`; else stay at the current audio position.

Opening a topic starts at the topic's start: first audio file offset `max(0, rangeStart - absolute_start)`
for the file holding it. Approximate in a batch; the first press of a line is exact.

### Changes to existing code

- `TimelineRightDetail` (`timeline.js`): mounts `TopicPlayer` above the tab strip for daily topics,
  keyed by topic id; drops the `audio` and `video` tabs. Meeting topics have no media and no player.
- `TranscriptList`: new optional props `store` (the player store), `maskOn` handled internally.
  With a `store`: row time becomes a play button; the active row gets `--active`; follow and the
  "Follow playback" button. `onSegments(segments)` reports loaded turns upward so the bar can draw marks.
  Without a `store` (Evidence) it behaves as now, except masking, which applies everywhere transcripts
  are shown.
- **Transcript loading.** Mounted on first visit to the Transcript tab or first Play, whichever is
  first, then kept mounted and hidden so the highlight and scroll state survive tab changes. Not fetched
  merely on opening a topic: it reads S3 per file.
- A deep link with `turnTime` still lands on Transcript and flashes the line; it does not autoplay.
- `app-shell-preview.html`: new script tags. CSS in `styles/composites.css` with existing tokens, checked
  in light and dark.

## Corrections from review (these win over anything above)

- **Missing files.** Audio filters a batch on its stitched length, transcripts on its real span, so a turn can name
  a wav the list left out. When loaded turns miss the timeline, the player refetches once from the earliest such
  file's start and merges by filename. Lines still unmatched have no play control. The real fix is on the backend
  and is out of scope tonight.
- **Store ownership.** `TimelineRightDetail` creates the store with `useMemo` per topic and passes it to both
  siblings; they read it with `useSyncExternalStore` (React 18.3.1).
- `TranscriptList` is keyed by topic when kept mounted: its naming state only resets on window change otherwise.
  Follow re-fires on reveal, since `scrollIntoView` does nothing on hidden rows.
- A naming refetch can re-deliver turns up to seven times; they go to the store from an effect, and the store
  ignores no-ops.
- **Expiry.** Refresh by age (13 minutes) before any new `src`; `error` remains the fallback, since a mid-stream
  Range failure may only stall. A rejected `play()` leaves a visible Play button.
- **Masked words** are enumerated in `mask-words.js`. Marks are coloured only for `speaker_state === 'confirmed'`.
- The toggle appears only when a topic contains a masked word; otherwise it is clutter.
- **The bar is not the topic.** The audio window has a 60 s buffer and whole files, so the bar shows clock time
  and shades the topic's range. Opening still starts at the topic's start.
- **Video is smaller:** the existing `VideoPlayer` with optional props, in the same place. No virtual bar across clips.
- **Dependency:** this needs `timelineSource: aurora`; the legacy gateway has no `source_filename`. With no join,
  rows have no control and the bar still plays. Mock fixtures have no join either; the browser test uses stem-matched data.
- Unmasked by scope: Ask citation snippets and the name-proposal dialog show raw text, being outside the transcript.
- Fetching audio and video lists on topic open is accepted: it is one list call each, and it makes the bar honest.

## Non-goals

Speaker lanes. Waveforms. Word-level highlight. Editing transcripts from the player. Clips or sharing.
Keyboard shortcuts beyond native focus behaviour. Changing Evidence's players. Any backend change.

## Failure that would make this wrong even if it works

- A pressed line plays a different moment than the line says. This is why a join miss shows no control.
- A masked word reaches a report, export or stored text.
- Playback stops on a tab change.
- Audio and video audible at once.

## Testing

- Pure modules: `node --test`. Timeline arithmetic, join hit and miss, batch-named stems, a wav with no
  transcript, zero durations, last-file clamp, every masked word and every deliberately unmasked word.
- Source-scan pins, as this suite does: the Audio and Video tabs are gone from `DAILY_TABS`; `TopicPlayer`
  is mounted outside the tab body; `TranscriptList` still renders the raw `s.text` when revealed.
- Real browser, mounted in the page with real `<audio>` elements and generated wav data URLs since the
  test account cannot be signed in by automation: tab change keeps playing, `ended` advances, seek across
  files lands at the right offset, and an `error` triggers exactly one refetch.
- Owner, signed in on TEST in the morning: a real topic, listening and reading.

## Rollout

Merge to `dev` for TEST. Reaches prod only with the next UI release after the owner has checked it. It
uses only endpoints already on prod, so it is independent of any backend release tonight.
