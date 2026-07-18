/* ==========================================================================
   FieldSight TranscriptList — Layer 5 composite
   --------------------------------------------------------------------------
   Renders speaker_segments from /api/transcripts (BACKEND-CONTEXT §4.5).

   Critical bug-trap (BACKEND-CONTEXT §8.6 / BUG 8.6):
     spk_0, spk_1 from Transcribe diarization are NOT stable across
     recording files. The same person may be spk_0 in one file and spk_2
     in another. We therefore colour speakers by POSITION WITHIN THE
     CURRENT VIEW — first unique label gets palette[0], next gets
     palette[1], etc. — and never persist a speaker→colour mapping
     globally.

   When the report supplies `participants`, we additionally attach human
   names to the first N labels seen (best-effort hint, NOT authoritative).

   Props:
     date          'YYYY-MM-DD'
     user          folder-name string (Jarley_Trainor)
     start         HH:MM[:SS] window start
     end           HH:MM[:SS] window end
     participants  string[] (optional) — names to overlay onto labels
     onJump        (segment) => void  — caller wires this to audio/video
                   playback if present
     highlightTime "HH:MM:SS" string or null — A2-2 Ask citation
                   transcript-line deep link (timeline.js passes
                   selectedItem.turnTime, itself sourced from the
                   citation's backend time_start, see ask-chat.js).
                   Same precision-spotlight shape as SafetyFlagRow's
                   `highlight` prop (safety-flag-row.js): scrolls the
                   matched segment into view and runs a 3-pulse flash
                   (.fs-transcript-list__row--flash). Segment match is
                   nearest-at-or-before (see findHighlightIndex below) —
                   the window start doesn't always land exactly on a
                   segment boundary.

   Exported to:
     window.FieldSight.TranscriptList
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* Five-colour palette mapped by FIRST-APPEARANCE order in the current
     view. Six is enough for any single topic — diarization won't reach
     more in practice. */
  var SPEAKER_PALETTE = [
    { fg: '#1E40AF', bg: '#DBEAFE' }, /* info */
    { fg: '#15803D', bg: '#DCFCE7' }, /* success */
    { fg: '#B45309', bg: '#FEF3C7' }, /* warning */
    { fg: '#9A2A13', bg: '#FFE6D5' }, /* accent */
    { fg: '#6B21A8', bg: '#EDE9FE' }, /* purple */
    { fg: '#0F766E', bg: '#CCFBF1' }, /* teal */
  ];

  /* A2-2 — "HH:MM:SS" → seconds-since-midnight, same space as segment
     .start/.end (BACKEND-CONTEXT transcript shape). Returns null when
     unparseable so callers can no-op cleanly. */
  function hmsToSeconds(hms) {
    var m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(hms || '').trim());
    if (!m) return null;
    return (parseInt(m[1], 10) * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10);
  }

  /* A2-2 — matching rule (robust to the window-start not landing exactly
     on a segment boundary):
       1. the segment whose [start, end] CONTAINS targetSec, else
       2. the LAST segment whose start <= targetSec (nearest at-or-before), else
       3. the FIRST segment (fallback).
     Assumes segments are chronologically ordered (as returned by the API). */
  function findHighlightIndex(segments, targetSec) {
    if (targetSec == null || !segments || !segments.length) return null;
    var lastAtOrBefore = null;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (typeof s.start !== 'number') continue;
      var end = typeof s.end === 'number' ? s.end : s.start;
      if (targetSec >= s.start && targetSec <= end) return i;
      if (s.start <= targetSec) lastAtOrBefore = i;
    }
    return lastAtOrBefore !== null ? lastAtOrBefore : 0;
  }

  function TranscriptList(props) {
    var refState = React.useState({ status: 'loading', segments: [] });
    var state    = refState[0];
    var setState = refState[1];

    var date  = props.date;
    var user  = props.user;
    var start = props.start;
    var end   = props.end;

    React.useEffect(function () {
      var cancelled = false;
      setState({ status: 'loading', segments: [] });
      window.FS.api.transcripts.getTranscripts({
        date: date, user: user, start: start, end: end,
      }).then(function (res) {
        if (cancelled) return;
        /* _fetch.js sentinels (BACKEND-CONTEXT §8.2/§8.4): a 403 or a
           genuine missing-transcript response must NOT fall through to
           the segments.length===0 branch below — that branch's copy
           ("recordings may have been archived") is misleading for a
           real access-denied response and was masking the Aurora-route
           403→wrong-identity bug (Issue B) as a routine empty state. */
        if (res && res._accessDenied) {
          setState({ status: 'denied', segments: [], message: res.error });
          return;
        }
        if (res && res._notFound) {
          setState({
            status:   'notfound', segments: [],
            message:  res.message || (res.raw && res.raw.message),
          });
          return;
        }
        setState({
          status:   'ok',
          segments: res.speaker_segments || [],
          speakers: res.speakers || [],
          message:  res.message,
          counts: {
            files:    res.count,
            segments: res.total_speaker_segments,
            speakers: res.speaker_count,
          },
        });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: err, segments: [] });
      });
      return function () { cancelled = true; };
    }, [date, user, start, end]);

    /* A2-2 — precision spotlight, same shape as SafetyFlagRow /
       TopicCard (rootRef + flashing state + useEffect keyed on the
       highlight prop → scrollIntoView + timed flash class). One row
       flashes at a time, so a single index (not a per-row boolean) is
       enough; segRefs maps segment index → DOM node via callback ref. */
    var segRefs = React.useRef({});
    var refFlash = React.useState(null);
    var flashIndex    = refFlash[0];
    var setFlashIndex = refFlash[1];

    React.useEffect(function () {
      if (!props.highlightTime || !state.segments.length) return undefined;
      var idx = findHighlightIndex(state.segments, hmsToSeconds(props.highlightTime));
      if (idx == null) return undefined;
      var node = segRefs.current[idx];
      if (node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setFlashIndex(idx);
      var t = setTimeout(function () { setFlashIndex(null); }, 1900);
      return function () { clearTimeout(t); };
    }, [props.highlightTime, state.segments]);

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-transcript-list__loading' },
        'Loading transcript…');
    }
    if (state.status === 'error') {
      return React.createElement('div', { className: 'fs-transcript-list__empty' },
        'Could not load transcript.');
    }
    if (state.status === 'denied') {
      return React.createElement(window.FieldSight.AccessDenied, {
        message: state.message,
        scope:   'this transcript',
      });
    }
    if (state.status === 'notfound') {
      return React.createElement('div', { className: 'fs-transcript-list__empty' },
        state.message || 'No transcript recorded for this date.');
    }
    if (state.segments.length === 0) {
      var emptyText = window.FS.api.useMocks
        ? 'No speaker segments in this window.'
        : (state.message || 'No transcripts available for this date — recordings may have been archived.');
      return React.createElement('div', { className: 'fs-transcript-list__empty' },
        emptyText);
    }

    /* Build position-within-view label → palette index map. */
    var labelToIdx = {};
    state.segments.forEach(function (s) {
      if (!(s.speaker in labelToIdx)) {
        labelToIdx[s.speaker] = Object.keys(labelToIdx).length;
      }
    });

    /* Best-effort name overlay from participants[]. */
    var participantHint = {};
    var participants = props.participants || [];
    Object.keys(labelToIdx).forEach(function (label, i) {
      if (participants[i]) participantHint[label] = participants[i];
    });

    return React.createElement('div', { className: 'fs-transcript-list' },

      React.createElement('div', { className: 'fs-transcript-list__caption' },
        state.counts.segments + ' segments · '
          + state.counts.speakers + ' speakers · '
          + state.counts.files + ' source files'),

      state.segments.map(function (s, i) {
        var palette = SPEAKER_PALETTE[labelToIdx[s.speaker] % SPEAKER_PALETTE.length];
        var nameHint = participantHint[s.speaker];

        return React.createElement('div', {
          key: i,
          ref: function (node) { segRefs.current[i] = node; },
          className: 'fs-transcript-list__row'
            + (flashIndex === i ? ' fs-transcript-list__row--flash' : ''),
        },
          React.createElement('button', {
            type:    'button',
            className: 'fs-transcript-list__chip',
            style:   { color: palette.fg, background: palette.bg },
            onClick: function () { if (props.onJump) props.onJump(s); },
            title:   'Jump to ' + s.time_label,
          },
            React.createElement('span', {
              className: 'fs-transcript-list__chip-label',
            }, nameHint || s.speaker),
            React.createElement('span', {
              className: 'fs-transcript-list__chip-time',
            }, s.time_label),
          ),

          React.createElement('div', { className: 'fs-transcript-list__text' },
            s.text),
        );
      }),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TranscriptList = TranscriptList;
})();
