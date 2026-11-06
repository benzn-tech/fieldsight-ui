/* ==========================================================================
   FieldSight TopicPlayer — Layer 5 composite
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-11-06-topic-player-design.md

   Sits above the topic's tabs, so changing tabs does not touch playback. Hears
   the whole topic as one bar, and shows the line being spoken. One <audio> whose
   src changes, never one per file, so only one thing can be playing. UI state
   comes from media events, never from reading .paused (BUG-21).

   Props:
     date, user, start, end   the topic window (HH:MM[:SS])
     store                    FS.topicPlayback.createStore(), owned by the parent
                              because TranscriptList is this component's sibling

   Exported to: window.FieldSight.TopicPlayer
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var SPEEDS = [1, 1.25, 1.5, 2];
  /* Links last 15 minutes. Refresh before a new src rather than wait for a failure:
     a Range request that expires mid-stream may only ever surface as a stall. */
  var URL_MAX_AGE_MS = 13 * 60 * 1000;

  function tp() { return window.FS.topicPlayback; }

  function toSec(t) {
    var p = String(t || '').split(':').map(Number);
    if (p.length < 2 || p.some(isNaN)) return null;
    return p[0] * 3600 + p[1] * 60 + (p[2] || 0);
  }

  function useStore(store, read) {
    return React.useSyncExternalStore(store.subscribe, function () { return read(store.getState()); });
  }

  function CurrentLine(props) {
    var turn = useStore(props.store, function (s) { return s.activeTurn === null ? null : s.turns[s.activeTurn] || null; });
    var masks = window.FS.maskWords;
    React.useSyncExternalStore(masks.subscribe, masks.isRevealed);
    return React.createElement('div', { className: 'fs-topic-player__line', 'aria-live': 'off' },
      turn ? masks.display(turn.text) : ' ');
  }

  function TopicPlayer(props) {
    var store = props.store;
    var P = tp();
    var h = React.createElement;

    var s_load = React.useState({ status: 'loading', segments: [], videos: [] });
    var load = s_load[0], setLoad = s_load[1];
    var s_pos = React.useState(0); var pos = s_pos[0], setPos = s_pos[1];
    var s_drag = React.useState(null); var drag = s_drag[0], setDrag = s_drag[1];
    var s_playing = React.useState(false); var playing = s_playing[0], setPlaying = s_playing[1];
    var s_speed = React.useState(1); var speed = s_speed[0], setSpeed = s_speed[1];
    var s_mode = React.useState('audio'); var mode = s_mode[0], setMode = s_mode[1];
    var s_error = React.useState(null); var error = s_error[0], setError = s_error[1];
    var s_seekClock = React.useState(null); var seekClock = s_seekClock[0], setSeekClock = s_seekClock[1];

    var audioRef = React.useRef(null);
    var fetchedAt = React.useRef(0);
    var pending = React.useRef(null);     /* { offset, resume } waiting for metadata */
    var loadedIndex = React.useRef(-1);
    var retried = React.useRef(false);
    var widened = React.useRef(false);

    var turns = useStore(store, function (s) { return s.turns; });
    var timeline = React.useMemo(function () { return P.buildTimeline(load.segments); }, [load.segments]);
    var timelineRef = React.useRef(timeline); timelineRef.current = timeline;
    var modeRef = React.useRef(mode); modeRef.current = mode;

    function fetchAudio(startOverride) {
      return window.FS.api.audio.getAudioSegments({
        date: props.date, user: props.user, start: startOverride || props.start, end: props.end,
      }).then(function (res) { fetchedAt.current = Date.now(); return (res && res.segments) || []; });
    }

    /* First load. The bar shows its real length before anything plays. */
    React.useEffect(function () {
      var cancelled = false;
      Promise.all([
        fetchAudio().catch(function () { return null; }),
        window.FS.api.video.getVideoSegments({ date: props.date, user: props.user, start: props.start, end: props.end })
          .then(function (res) { return ((res && res.videos) || []).filter(function (v) { return v.is_preview; }); })
          .catch(function () { return []; }),
      ]).then(function (r) {
        if (cancelled) return;
        var segs = r[0];
        setLoad({ status: segs === null ? 'error' : 'ok', segments: segs || [], videos: r[1] });
        var t = P.buildTimeline(segs || []);
        var startSec = toSec(props.start);
        setPos(startSec === null ? 0 : P.clockToPos(t, startSec));
      });
      return function () {
        cancelled = true;
        var el = audioRef.current;
        /* Explicit: removal from the DOM does not reliably stop a media element. */
        if (el) { try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) { /* gone */ } }
      };
    }, [props.date, props.user, props.start, props.end]);

    /* Audio filters a batch on its stitched length and transcripts on its real
       span, so a line can name a file this list left out. Ask once more, from that
       file's start. Lines still unmatched simply have no play control. */
    React.useEffect(function () {
      if (widened.current || load.status !== 'ok' || !turns.length) return;
      var earliest = P.missingFileStart(turns, timeline);
      if (earliest === null) return;
      widened.current = true;
      fetchAudio(P.fmtClock(Math.max(0, earliest))).then(function (segs) {
        setLoad(function (l) { return Object.assign({}, l, { segments: P.mergeSegments(l.segments, segs) }); });
      }).catch(function () { /* those lines keep no control */ });
    }, [turns, timeline, load.status]);

    React.useEffect(function () { store.set({ version: store.getState().version + 1 }); }, [timeline]);

    function publishActive(p) {
      store.set({ activeTurn: P.turnAt(store.getState().turns, timelineRef.current, p) });
    }

    function setRate(el, rate) { el.defaultPlaybackRate = rate; el.playbackRate = rate; }

    function start(el) {
      var p = el.play();
      if (p && p.catch) p.catch(function () { setPlaying(false); });  /* the Play button remains */
    }

    function loadInto(index, offset, resume) {
      var el = audioRef.current;
      var item = timelineRef.current.items[index];
      if (!el || !item) return;
      setError(null);
      function go(url) {
        loadedIndex.current = index;
        pending.current = { offset: offset, resume: resume };
        el.src = url;
        el.load();
      }
      if (Date.now() - fetchedAt.current > URL_MAX_AGE_MS) {
        fetchAudio().then(function (segs) {
          setLoad(function (l) { return Object.assign({}, l, { segments: P.mergeSegments(l.segments, segs) }); });
          var fresh = segs.filter(function (s) { return s.filename === item.filename; })[0];
          go(fresh ? fresh.url : item.url);
        }).catch(function () { go(item.url); });
      } else {
        go(item.url);
      }
    }

    function seekPos(p, resume) {
      var at = P.locate(timelineRef.current, p);
      var el = audioRef.current;
      if (!at || !el) return;
      setPos(P.position(timelineRef.current, at.index, at.offset));
      publishActive(p);
      if (at.index === loadedIndex.current && !pending.current) {
        el.currentTime = at.offset;
        if (resume) start(el);
      } else {
        loadInto(at.index, at.offset, resume);
      }
    }

    function togglePlay() {
      var el = audioRef.current;
      if (!el) return;
      store.set({ wantTurns: true });
      if (playing) { el.pause(); return; }
      if (loadedIndex.current < 0 || pending.current) { seekPos(pos, true); return; }
      start(el);
    }

    /* The transcript reaches playback through these. */
    React.useEffect(function () {
      store.setHandlers({
        canSeek: function (turn) {
          return !!P.turnTarget(timelineRef.current, turn)
            || (modeRef.current === 'video' && typeof turn.start === 'number');
        },
        seekToTurn: function (turn) {
          if (modeRef.current === 'video') { setSeekClock({ sec: turn.start, turn: turn, nonce: Date.now() }); return; }
          var at = P.turnTarget(timelineRef.current, turn);
          if (at) seekPos(P.position(timelineRef.current, at.index, at.offset), true);
        },
      });
      return function () { store.setHandlers(null); };
    }, [store]);

    function switchMode(next) {
      if (next === mode) return;
      var state = store.getState();
      var turn = state.activeTurn === null ? null : state.turns[state.activeTurn];
      if (next === 'video') {
        if (audioRef.current) audioRef.current.pause();
        var clock = P.clockAt(timeline, pos, turn);
        setSeekClock(clock === null ? null : { sec: clock, nonce: Date.now() });
      }
      setMode(next);
    }

    /* The moment a pressed line asks for is not in any video. */
    function onNoVideoMoment(request) {
      setMode('audio');
      var toast = window.FS && window.FS.toast;
      if (toast) toast.show({ message: 'No video at this moment', tone: 'info', duration: 3000 });
      var at = request && request.turn ? P.turnTarget(timelineRef.current, request.turn) : null;
      if (at) seekPos(P.position(timelineRef.current, at.index, at.offset), true);
    }

    if (load.status === 'loading') {
      return h('div', { className: 'fs-topic-player fs-topic-player--quiet' }, 'Loading recording…');
    }
    if (load.status === 'error') {
      return h('div', { className: 'fs-topic-player fs-topic-player--quiet' }, 'Could not load audio.');
    }
    var hasVideo = load.videos.length > 0;
    if (!timeline.items.length && !hasVideo) {
      return h('div', { className: 'fs-topic-player fs-topic-player--quiet' }, 'No recording in this window.');
    }

    var shown = drag !== null ? drag : pos;
    var state = store.getState();
    var activeTurn = state.activeTurn === null ? null : state.turns[state.activeTurn];
    var clock = P.fmtClock(P.clockAt(timeline, shown, activeTurn));
    var marks = P.activityMarks(turns, timeline);
    var rangeStart = toSec(props.start), rangeEnd = toSec(props.end);
    var shade = (timeline.total && rangeStart !== null && rangeEnd !== null) ? {
      left: P.clockToPos(timeline, rangeStart) / timeline.total,
      right: P.clockToPos(timeline, rangeEnd) / timeline.total,
    } : null;
    var VideoPlayer = window.FieldSight.VideoPlayer;

    return h('div', { className: 'fs-topic-player' },
      h('audio', {
        ref: audioRef,
        preload: 'metadata',
        onLoadedMetadata: function () {
          var el = audioRef.current, w = pending.current;
          if (!el || !w) return;
          pending.current = null;
          setRate(el, speed);
          try { el.currentTime = w.offset; } catch (_) { /* stays at 0 */ }
          if (w.resume) start(el);
        },
        onPlay: function () { retried.current = false; setPlaying(true); store.set({ playing: true }); },
        onPause: function () { setPlaying(false); store.set({ playing: false }); },
        onTimeUpdate: function () {
          var el = audioRef.current;
          if (!el || pending.current || loadedIndex.current < 0) return;
          var p = P.position(timelineRef.current, loadedIndex.current, el.currentTime);
          setPos(p);
          publishActive(p);
        },
        onEnded: function () {
          var next = loadedIndex.current + 1;
          if (next < timelineRef.current.items.length) loadInto(next, 0, true);
          else { setPlaying(false); store.set({ playing: false }); }
        },
        onError: function () {
          var el = audioRef.current;
          if (!el || !el.getAttribute('src') || loadedIndex.current < 0) return;
          var item = timelineRef.current.items[loadedIndex.current];
          var offset = pending.current ? pending.current.offset : el.currentTime;
          var resume = pending.current ? pending.current.resume : playing;
          pending.current = null;
          if (retried.current || !item) { setPlaying(false); setError('Could not load audio.'); return; }
          retried.current = true;
          fetchAudio().then(function (segs) {
            setLoad(function (l) { return Object.assign({}, l, { segments: P.mergeSegments(l.segments, segs) }); });
            var fresh = segs.filter(function (s) { return s.filename === item.filename; })[0];
            if (!fresh) { setError('Could not load audio.'); return; }
            pending.current = { offset: offset, resume: resume };
            el.src = fresh.url;
            el.load();
          }).catch(function () { setError('Could not load audio.'); });
        },
      }),

      mode === 'video' && VideoPlayer
        ? h(VideoPlayer, {
            date: props.date, user: props.user, start: props.start, end: props.end,
            videos: load.videos,
            seekClock: seekClock,
            onNoMoment: onNoVideoMoment,
            onClock: function (sec) { store.set({ activeTurn: P.turnAtClock(store.getState().turns, sec) }); },
          })
        : h('div', { className: 'fs-topic-player__bar' },
            h('button', {
              type: 'button', className: 'fs-topic-player__play',
              'aria-label': playing ? 'Pause' : 'Play', onClick: togglePlay,
            }, playing ? '❚❚' : '▶'),
            h('button', { type: 'button', className: 'fs-topic-player__skip', 'aria-label': 'Back 10 seconds',
              onClick: function () { seekPos(pos - 10, playing); } }, '-10'),
            h('button', { type: 'button', className: 'fs-topic-player__skip', 'aria-label': 'Forward 10 seconds',
              onClick: function () { seekPos(pos + 10, playing); } }, '+10'),
            h('button', {
              type: 'button', className: 'fs-topic-player__speed', 'aria-label': 'Playback speed',
              onClick: function () {
                var next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                setSpeed(next);
                if (audioRef.current) setRate(audioRef.current, next);
              },
            }, speed + 'x'),
            h('div', { className: 'fs-topic-player__track' },
              shade ? h('div', { className: 'fs-topic-player__range', title: 'This topic',
                style: { left: (shade.left * 100) + '%', width: (Math.max(0, shade.right - shade.left) * 100) + '%' } }) : null,
              marks.map(function (m, i) {
                return h('span', {
                  key: i,
                  className: 'fs-topic-player__mark' + (m.name ? ' fs-topic-player__mark--named' : ''),
                  title: m.name || undefined,
                  style: { left: (m.left * 100) + '%', width: Math.max(0.2, m.width * 100) + '%' },
                });
              }),
              h('input', {
                type: 'range', className: 'fs-topic-player__seek', 'aria-label': 'Position in this recording',
                min: 0, max: timeline.total, step: 0.1, value: Math.min(shown, timeline.total),
                onChange: function (e) { setDrag(Number(e.target.value)); },
                onPointerUp: function (e) { setDrag(null); seekPos(Number(e.target.value), playing); },
                onKeyUp: function (e) { setDrag(null); seekPos(Number(e.target.value), playing); },
              })
            ),
            h('span', { className: 'fs-topic-player__time' },
              clock ? h('b', null, clock) : null,
              ' ' + P.fmtLength(shown) + ' / ' + P.fmtLength(timeline.total))
          ),

      hasVideo && timeline.items.length ? h('div', { className: 'fs-topic-player__modes', role: 'group', 'aria-label': 'Recording type' },
        ['audio', 'video'].map(function (m) {
          return h('button', {
            key: m, type: 'button', 'aria-pressed': mode === m,
            className: 'fs-topic-player__mode' + (mode === m ? ' fs-topic-player__mode--on' : ''),
            onClick: function () { switchMode(m); },
          }, m === 'audio' ? 'Audio' : 'Video');
        })
      ) : null,

      error ? h('div', { className: 'fs-topic-player__error', role: 'alert' }, error,
        ' ', h('button', { type: 'button', className: 'fs-settings__link-btn', onClick: function () {
          retried.current = false; setError(null); seekPos(pos, true);
        } }, 'Retry')) : null,

      h(CurrentLine, { store: store })
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TopicPlayer = TopicPlayer;
})();
