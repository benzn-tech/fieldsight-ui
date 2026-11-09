/* ==========================================================================
   FieldSight topic playback — pure rules behind the topic player
   --------------------------------------------------------------------------
   The listed audio files of a topic, laid end to end, and how a transcript
   turn finds its moment in them.

   A turn joins its audio on FILE PLUS OFFSET (source_filename, chunk_start),
   never on the clock. A batch wav is several chunks stitched with the gaps
   bridged, so clock arithmetic lands early inside one. A turn that does not
   join has no target: a line must never play some other moment. Video has no
   such join and uses the clock, which is sound because a video is not stitched.

   Also holds the small store the player and the transcript share, so 4 Hz
   timeupdates do not re-render the whole detail panel.

   Exported to: window.FS.topicPlayback (and CommonJS for tests)
   ========================================================================== */

(function () {
  'use strict';

  function stem(name) {
    return String(name || '').replace(/\.[A-Za-z0-9]+$/, '');
  }

  /* `{ items:[{filename,url,stem,start,duration,absolute_start,absolute_end}], total }`.
     Order as given (the API sorts by clock). A file with no length is dropped:
     it cannot be played or positioned. */
  function buildTimeline(segments) {
    var items = [];
    var total = 0;
    (segments || []).forEach(function (s) {
      var d = Number(s && s.duration);
      if (!(d > 0)) return;
      items.push({
        filename: s.filename, url: s.url, stem: stem(s.filename),
        start: total, duration: d,
        absolute_start: s.absolute_start, absolute_end: s.absolute_end,
      });
      total += d;
    });
    return { items: items, total: total };
  }

  /* Position on the bar -> file and offset. Clamped: past the end is the end. */
  function locate(timeline, pos) {
    var items = timeline.items;
    if (!items.length) return null;
    var p = Math.max(0, Math.min(Number(pos) || 0, timeline.total));
    for (var i = 0; i < items.length; i++) {
      if (p < items[i].start + items[i].duration) return { index: i, offset: p - items[i].start };
    }
    var last = items[items.length - 1];
    return { index: items.length - 1, offset: last.duration };
  }

  function position(timeline, index, offset) {
    var item = timeline.items[index];
    return item ? item.start + Math.max(0, Number(offset) || 0) : 0;
  }

  function indexOfStem(timeline, s) {
    for (var i = 0; i < timeline.items.length; i++) {
      if (timeline.items[i].stem === s) return i;
    }
    return -1;
  }

  /* Where a turn is, or null when its file is not on this timeline. */
  function turnTarget(timeline, turn) {
    if (!turn || !turn.source_filename || typeof turn.chunk_start !== 'number') return null;
    var i = indexOfStem(timeline, stem(turn.source_filename));
    if (i < 0) return null;
    return { index: i, offset: Math.min(turn.chunk_start, timeline.items[i].duration) };
  }

  /* The turn being spoken at a bar position: same file, offset inside the turn. */
  function turnAt(turns, timeline, pos) {
    var at = locate(timeline, pos);
    if (!at) return null;
    var s = timeline.items[at.index].stem;
    for (var i = 0; i < (turns || []).length; i++) {
      var t = turns[i];
      if (!t || typeof t.chunk_start !== 'number' || stem(t.source_filename) !== s) continue;
      var d = Number(t.duration) || 0;
      if (at.offset >= t.chunk_start && at.offset < t.chunk_start + d) return i;
    }
    return null;
  }

  function turnAtClock(turns, clockSec) {
    for (var i = 0; i < (turns || []).length; i++) {
      var t = turns[i];
      if (t && clockSec >= t.start && clockSec <= t.end) return i;
    }
    return null;
  }

  /* The last video starting at or before this moment, or null. Whether that file
     reaches the moment is only known once its metadata has loaded. */
  function videoTarget(videos, clockSec) {
    var hit = null;
    (videos || []).forEach(function (v, i) {
      if (typeof v.video_start_sec === 'number' && v.video_start_sec <= clockSec) {
        hit = { index: i, offset: clockSec - v.video_start_sec };
      }
    });
    /* A span end refuses a later moment now, not after metadata loads. */
    var end = hit ? videos[hit.index].span_end : null;
    return (typeof end === 'number' && clockSec > end) ? null : hit;
  }

  /* ---- Real video spans (spec 2026-11-10 §6.1) ----
     The backend assumes every file lasts 600 s; previews are ~30 s chunks. A
     span is closed by the next chunk of the same session when it starts within
     SUCCESSOR_SEC, else by a probed duration, else it keeps the 600 s
     assumption: a failed check shows a video, it never hides one. */
  var CHUNK_TOKENS_RE = /_sid([0-9a-f]{32})_c(\d{4,})(?:[._]|$)/;
  var SUCCESSOR_SEC = 45;      /* 1.5 x the measured 30 s chunk */
  var ASSUMED_SPAN_SEC = 600;  /* the backend's assumption */
  var PROBE_CAP = 6;

  function sessionOf(filename) {
    var m = CHUNK_TOKENS_RE.exec(String(filename || ''));
    return m ? m[1] : null;
  }

  /* Successor = the next entry IN THE LIST (ordered by video_start_sec) with the
     same non-null sid, starting within SUCCESSOR_SEC. */
  function successorStart(videos, i) {
    var v = videos[i];
    var sid = sessionOf(v.filename);
    if (!sid || typeof v.video_start_sec !== 'number') return null;
    for (var j = i + 1; j < videos.length; j++) {
      if (sessionOf(videos[j].filename) !== sid) continue;
      var s = videos[j].video_start_sec;
      return (typeof s === 'number' && s - v.video_start_sec <= SUCCESSOR_SEC) ? s : null;
    }
    return null;
  }

  /* Entries the successor rule leaves open, which a probe could close. */
  function probeTargets(videos, cap) {
    var list = videos || [];
    var out = [];
    list.forEach(function (v, i) { if (successorStart(list, i) === null) out.push(v); });
    return out.slice(0, typeof cap === 'number' ? cap : PROBE_CAP);
  }

  function videoSpans(videos, durations) {
    var list = videos || [];
    var d = durations || {};
    return list.map(function (v, i) {
      var start = typeof v.video_start_sec === 'number' ? v.video_start_sec : null;
      var end = successorStart(list, i);
      var known = end !== null;
      if (!known && start !== null && Number(d[v.filename]) > 0) {
        end = start + Number(d[v.filename]);
        known = true;
      }
      if (!known) end = start === null ? null : start + ASSUMED_SPAN_SEC;
      return Object.assign({}, v, { span_start: start, span_end: end, span_known: known });
    });
  }

  /* Spans that share time with [startSec, endSec). A null bound is open. A span
     with no clock is kept: when unsure, show it. */
  function overlapping(spans, startSec, endSec) {
    return (spans || []).filter(function (s) {
      if (typeof s.span_start !== 'number' || typeof s.span_end !== 'number') return true;
      return (startSec === null || startSec === undefined || s.span_end > startSec)
        && (endSec === null || endSec === undefined || s.span_start < endSec);
    });
  }

  /* Clock -> bar position. Approximate inside a batch, so it only ever sets a
     starting point or shades a range; pressing a line uses turnTarget. */
  function clockToPos(timeline, sec) {
    var items = timeline.items;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (typeof it.absolute_end === 'number' && sec < it.absolute_end) {
        return it.start + Math.min(it.duration, Math.max(0, sec - it.absolute_start));
      }
    }
    return timeline.total;
  }

  /* Bar position -> clock, for display. A turn knows its own clock exactly, so
     it wins; otherwise the file's clock, approximate inside a batch. */
  function clockAt(timeline, pos, turn) {
    var at = locate(timeline, pos);
    if (!at) return null;
    if (turn && typeof turn.start === 'number' && typeof turn.chunk_start === 'number') {
      return turn.start + Math.max(0, at.offset - turn.chunk_start);
    }
    var abs = timeline.items[at.index].absolute_start;
    return typeof abs === 'number' ? abs + at.offset : null;
  }

  function fmtClock(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return '';
    var s = Math.floor(sec);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s % 3600 / 60)) + ':' + p(s % 60);
  }

  function fmtLength(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var r = s % 60;
    return Math.floor(s / 60) + ':' + (r < 10 ? '0' + r : r);
  }

  /* Fractions of the bar. A turn that does not join draws nothing. Each mark
     carries its speaker LABEL, coloured by speakerColors like the chips. */
  function activityMarks(turns, timeline) {
    if (!timeline.total) return [];
    var marks = [];
    (turns || []).forEach(function (t) {
      var at = turnTarget(timeline, t);
      if (!at) return;
      marks.push({
        left: position(timeline, at.index, at.offset) / timeline.total,
        width: (Number(t.duration) || 0) / timeline.total,
        speaker: t.speaker,
      });
    });
    return marks;
  }

  /* ---- Speaker colours (spec 2026-11-10 §6.2) ----
     One function for the transcript chips and the bar, so they cannot disagree.
     Mapped by FIRST APPEARANCE of the `speaker` label (never speaker_name) over
     all turns; six colours, then they wrap. */
  var SPEAKER_PALETTE = [
    { fg: '#1E40AF', bg: '#DBEAFE' }, /* info */
    { fg: '#15803D', bg: '#DCFCE7' }, /* success */
    { fg: '#B45309', bg: '#FEF3C7' }, /* warning */
    { fg: '#9A2A13', bg: '#FFE6D5' }, /* accent */
    { fg: '#6B21A8', bg: '#EDE9FE' }, /* purple */
    { fg: '#0F766E', bg: '#CCFBF1' }, /* teal */
  ];

  function speakerColors(turns) {
    var out = {};
    var n = 0;
    (turns || []).forEach(function (t) {
      if (!t) return;
      if (!(t.speaker in out)) { out[t.speaker] = SPEAKER_PALETTE[n % SPEAKER_PALETTE.length]; n += 1; }
    });
    return out;
  }

  /* Whichever of the chip's pair passes 3:1 on the panel: the text colour on the
     light panel, the fill on the dark one. Same hue as the chip either way. */
  function swatch(pair, dark) {
    if (!pair) return null;
    return dark ? pair.bg : pair.fg;
  }

  /* Turns whose file the audio listing did not return. Audio filters on a batch's
     stitched length and transcripts on its real span, so a batch can reach the
     topic yet be missing from the list. The clock of the earliest such file start
     is what to ask for, or null when nothing is missing. */
  function missingFileStart(turns, timeline) {
    var min = null;
    (turns || []).forEach(function (t) {
      if (!t || !t.source_filename || typeof t.chunk_start !== 'number') return;
      if (indexOfStem(timeline, stem(t.source_filename)) >= 0) return;
      var s = t.start - t.chunk_start;
      if (min === null || s < min) min = s;
    });
    return min;
  }

  /* Merged by filename, sorted by clock; a fresh row replaces an old one because
     its URL is newer. */
  function mergeSegments(oldList, newList) {
    var by = {};
    (oldList || []).concat(newList || []).forEach(function (s) { if (s && s.filename) by[s.filename] = s; });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) {
      return (a.absolute_start || 0) - (b.absolute_start || 0);
    });
  }

  function createStore() {
    var state = {
      activeTurn: null, turns: [], version: 0, wantTurns: false, playing: false,
    };
    var subs = [];
    var handlers = {};
    return {
      getState: function () { return state; },
      set: function (patch) {
        var changed = Object.keys(patch).some(function (k) { return state[k] !== patch[k]; });
        if (!changed) return;
        state = Object.assign({}, state, patch);
        subs.slice().forEach(function (cb) { cb(); });
      },
      subscribe: function (cb) {
        subs.push(cb);
        return function () { subs = subs.filter(function (x) { return x !== cb; }); };
      },
      setHandlers: function (h) { handlers = h || {}; },
      canSeek: function (turn) { return !!(handlers.canSeek && handlers.canSeek(turn)); },
      seekToTurn: function (turn) { if (handlers.seekToTurn) handlers.seekToTurn(turn); },
    };
  }

  var api = {
    stem: stem, buildTimeline: buildTimeline, locate: locate, position: position,
    turnTarget: turnTarget, turnAt: turnAt, turnAtClock: turnAtClock, videoTarget: videoTarget,
    sessionOf: sessionOf, probeTargets: probeTargets, videoSpans: videoSpans, overlapping: overlapping,
    clockToPos: clockToPos, clockAt: clockAt, fmtClock: fmtClock, fmtLength: fmtLength,
    activityMarks: activityMarks, SPEAKER_PALETTE: SPEAKER_PALETTE, speakerColors: speakerColors, swatch: swatch,
    missingFileStart: missingFileStart, mergeSegments: mergeSegments,
    createStore: createStore,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    window.FS.topicPlayback = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
