# Topic player: plan

Spec: `docs/superpowers/specs/2026-11-06-topic-player-design.md`, after its review corrections.

1. Pure rules, tested first: `scripts/api/topic-playback.js` (timeline, file-plus-offset join, clock display,
   marks, missing files, store) and `scripts/api/mask-words.js` (word list, display, reveal).
2. `scripts/composites/topic-player.js`: one audio element, bar, marks, topic range, current line, expiry recovery.
3. `VideoPlayer`: optional `videos`, `onClock`, `seekClock`, `onNoMoment`. Evidence passes none and is unchanged.
4. `TranscriptList`: optional `store` and `visible`; play control on joined lines, active row, follow, masked text.
5. `TimelineRightDetail`: store per topic, player above the tabs, transcript kept mounted once seen, Audio and Video tabs removed.
6. Script tags in `app-shell-preview.html`, CSS with existing tokens.
7. Verify before merge in the real app in mock mode on localhost, with real audio elements and stem-matched data:
   tab change keeps playing, a line seeks across files, `ended` advances, an expired link recovers with one refetch,
   a line with no file has no control, masked text reveals. Then the full suite, then CI.
