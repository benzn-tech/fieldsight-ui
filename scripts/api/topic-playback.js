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
    return hit;
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

  /* Fractions of the bar. A turn that does not join draws nothing. A colour comes
     only from a confirmed name: a tentative one must not read as a fact. */
  function activityMarks(turns, timeline) {
    if (!timeline.total) return [];
    var marks = [];
    (turns || []).forEach(function (t) {
      var at = turnTarget(timeline, t);
      if (!at) return;
      marks.push({
        left: position(timeline, at.index, at.offset) / timeline.total,
        width: (Number(t.duration) || 0) / timeline.total,
        name: t.speaker_state === 'confirmed' ? (t.speaker_name || null) : null,
      });
    });
    return marks;
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
    clockToPos: clockToPos, clockAt: clockAt, fmtClock: fmtClock, fmtLength: fmtLength,
    activityMarks: activityMarks, missingFileStart: missingFileStart, mergeSegments: mergeSegments,
    createStore: createStore,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    window.FS.topicPlayback = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
