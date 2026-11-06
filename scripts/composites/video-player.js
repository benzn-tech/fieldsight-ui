/* ==========================================================================
   FieldSight VideoPlayer — Layer 5 composite
   --------------------------------------------------------------------------
   Plays the H264 preview clips from /api/video-segments (BACKEND-CONTEXT
   §4.7).

   Critical bug-traps:
     • Always prefer is_preview:true (BUG §8.10). Originals may be H265
       and won't play in Chrome. The api filters on the server side and
       this component double-checks defensively.
     • Use offset_sec to seek to the topic-relevant moment inside the
       file (start - file_start). Seek when metadata is loaded — before
       that the duration is unknown and seeking is a no-op.
     • <video preload="metadata"> — never preload a 200–300 MB file
       (BACKEND-CONTEXT §8.10).
     • URLs are presigned, expire 15 min — re-fetch on remount (no
       localStorage caching).

   Props:
     date    'YYYY-MM-DD'
     user    folder-name string
     start   HH:MM[:SS]
     end     HH:MM[:SS]
     videos     (optional) the list, when the host has already fetched it
     onClock    (optional) (clockSec) => void, as it plays
     seekClock  (optional) { sec, nonce }: go to this moment
     onNoMoment (optional) (request) => void: no video holds that moment

   Exported to:
     window.FieldSight.VideoPlayer
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function VideoPlayer(props) {
    var date  = props.date;
    var user  = props.user;
    var start = props.start;
    var end   = props.end;

    var refState = React.useState({ status: 'loading', videos: [] });
    var state    = refState[0];
    var setState = refState[1];

    var refIdx = React.useState(0);
    var idx    = refIdx[0];
    var setIdx = refIdx[1];

    var videoEl = React.useRef(null);

    /* A requested offset, waiting for that file's metadata. */
    var pendingSeek = React.useRef(null);

    React.useEffect(function () {
      if (props.videos) {
        setState({ status: 'ok', videos: props.videos });
        setIdx(0);
        return undefined;
      }
      var cancelled = false;
      setState({ status: 'loading', videos: [] });
      setIdx(0);
      window.FS.api.video.getVideoSegments({
        date: date, user: user, start: start, end: end,
      }).then(function (res) {
        if (cancelled) return;
        var previews = (res.videos || []).filter(function (v) { return v.is_preview; });
        setState({ status: 'ok', videos: previews });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: err, videos: [] });
      });
      return function () { cancelled = true; };
    }, [date, user, start, end]);

    var current = state.videos[idx] || null;

    React.useEffect(function () {
      var req = props.seekClock;
      if (!req || state.status !== 'ok') return;
      var at = window.FS.topicPlayback.videoTarget(state.videos, req.sec);
      if (!at) { if (props.onNoMoment) props.onNoMoment(req); return; }
      pendingSeek.current = { offset: at.offset, request: req };
      if (at.index !== idx) { setIdx(at.index); return; }
      applySeek();
    }, [props.seekClock && props.seekClock.nonce, state.status]);

    function applySeek() {
      var el = videoEl.current, w = pendingSeek.current;
      if (!el || !w || !el.duration) return;
      pendingSeek.current = null;
      /* Files do not cover every moment. Say so rather than play the wrong one. */
      if (w.offset > el.duration) { if (props.onNoMoment) props.onNoMoment(w.request); return; }
      el.currentTime = w.offset;
      var p = el.play();
      if (p && p.catch) p.catch(function () { /* native controls remain */ });
    }

    /* Seek to offset_sec once metadata is loaded; resets when current
       video changes. */
    function onLoadedMetadata() {
      var el = videoEl.current;
      if (!el || !current) return;
      if (pendingSeek.current) { applySeek(); return; }
      try {
        if (current.offset_sec && el.duration && current.offset_sec < el.duration) {
          el.currentTime = current.offset_sec;
        }
      } catch (e) { /* noop */ }
    }

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-video-player__loading' },
        'Loading video…');
    }
    if (state.status === 'error') {
      return React.createElement('div', { className: 'fs-video-player__empty' },
        'Could not load video.');
    }
    if (!current) {
      return React.createElement('div', { className: 'fs-video-player__empty' },
        'No video preview in this window.');
    }

    return React.createElement('div', { className: 'fs-video-player' },

      React.createElement('video', {
        ref:        videoEl,
        src:        current.url,
        controls:   true,
        preload:    'metadata',
        playsInline: true,
        className:  'fs-video-player__media',
        onLoadedMetadata: onLoadedMetadata,
        onTimeUpdate: props.onClock ? function () {
          var el = videoEl.current;
          if (el && current && typeof current.video_start_sec === 'number') {
            props.onClock(current.video_start_sec + el.currentTime);
          }
        } : undefined,
        onEnded: props.videos ? function () {
          setIdx(function (i) { return i < state.videos.length - 1 ? i + 1 : i; });
        } : undefined,
      }),

      React.createElement('div', { className: 'fs-video-player__meta' },
        React.createElement('span', { className: 'fs-video-player__time' },
          current.time_label),
        React.createElement('span', { className: 'fs-video-player__filename' },
          current.filename),
        React.createElement('span', { className: 'fs-video-player__size' },
          current.size_mb ? current.size_mb.toFixed(1) + ' MB' : ''),
      ),

      state.videos.length > 1 ? React.createElement('div', {
        className: 'fs-video-player__nav',
      },
        React.createElement('button', {
          type:     'button',
          disabled: idx === 0,
          onClick:  function () { setIdx(function (i) { return Math.max(0, i - 1); }); },
        }, '← Previous'),
        React.createElement('span', { className: 'fs-video-player__count' },
          (idx + 1) + ' of ' + state.videos.length),
        React.createElement('button', {
          type:     'button',
          disabled: idx >= state.videos.length - 1,
          onClick:  function () { setIdx(function (i) { return Math.min(state.videos.length - 1, i + 1); }); },
        }, 'Next →'),
      ) : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.VideoPlayer = VideoPlayer;
})();
