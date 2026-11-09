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

  /* A probe that has not answered by now counts as failed: the file keeps the
     600 s assumption and is shown, never hidden (spec 2026-11-10 §6.1). */
  var PROBE_TIMEOUT_MS = 4000;

  function tp() { return window.FS.topicPlayback; }

  /* A preview's real length, from its metadata only (the previews are
     faststart, so this reads the head of the file). Null on any failure. */
  function probeDuration(url) {
    return new Promise(function (resolve) {
      var v = window.document.createElement('video');
      var done = false;
      var timer = 0;
      function finish(d) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        v.onloadedmetadata = null; v.onerror = null;
        try { v.removeAttribute('src'); v.load(); } catch (_) { /* released */ }
        resolve(d);
      }
      timer = window.setTimeout(function () { finish(null); }, PROBE_TIMEOUT_MS);
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = function () { finish(isFinite(v.duration) && v.duration > 0 ? v.duration : null); };
      v.onerror = function () { finish(null); };
      v.src = url;
    });
  }

  /* The previews that really overlap the topic window. */
  function spansFor(videos, props) {
    var P = tp();
    return Promise.all(P.probeTargets(videos).map(function (v) {
      return probeDuration(v.url).then(function (d) { return [v.filename, d]; });
    })).then(function (pairs) {
      var durations = {};
      pairs.forEach(function (p) { if (p[1]) durations[p[0]] = p[1]; });
      return P.overlapping(P.videoSpans(videos, durations), toSec(props.start), toSec(props.end));
    });
  }

  function toSec(t) {
    var p = String(t || '').split(':').map(Number);
    if (p.length < 2 || p.some(isNaN)) return null;
    return p[0] * 3600 + p[1] * 60 + (p[2] || 0);
  }

  function useStore(store, read) {
    return React.useSyncExternalStore(store.subscribe, function () { return read(store.getState()); });
  }

  var BAR_STEP = 3;   /* 2px bar, 1px gap */

  function token(style, name, fallback) {
    return (style.getPropertyValue(name) || '').trim() || fallback;
  }

  /* The bar's picture. A transparent range input lies over it and takes every
     press, drag and key, so this only ever draws. While playing it reads the
     position each frame through getPos; otherwise it draws when props change. */
  function Waveform(props) {
    var canvasRef = React.useRef(null);
    var s_width = React.useState(0); var width = s_width[0], setWidth = s_width[1];
    var latest = React.useRef(props); latest.current = props;
    var count = Math.floor(width / BAR_STEP);
    var bars = React.useMemo(function () {
      return window.FS.topicWave.barsFor(props.timeline, props.peaks, count);
    }, [props.timeline, props.peaks, count]);
    var barsRef = React.useRef(bars); barsRef.current = bars;

    function draw(now) {
      var c = canvasRef.current;
      var p = latest.current;
      if (!c || !c.clientWidth) return;
      var w = c.clientWidth, h = c.clientHeight;
      var ratio = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * ratio) || c.height !== Math.round(h * ratio)) {
        c.width = Math.round(w * ratio);
        c.height = Math.round(h * ratio);
      }
      var g = c.getContext('2d');
      if (!g) return;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, w, h);

      var style = window.getComputedStyle(c);
      var accent = token(style, '--color-accent-700', '#d97706');
      var strong = token(style, '--text-secondary', '#888');
      var quiet = token(style, '--text-tertiary', '#666');
      var range = token(style, '--surface-topic-selected', 'rgba(128,128,128,.15)');

      var total = p.timeline.total || 1;
      var head = Math.max(0, Math.min(1, p.getPos() / total)) * w;
      var left = p.shade ? p.shade.left * w : 0;
      var right = p.shade ? p.shade.right * w : w;
      if (p.shade) {
        g.fillStyle = range;
        g.fillRect(left, 0, Math.max(0, right - left), h);
      }

      var mid = h / 2;
      var list = barsRef.current;
      if (list) {
        for (var i = 0; i < list.length; i++) {
          var x = i * BAR_STEP;
          var height = Math.max(2, list[i] * (h - 8));
          /* Bars by the head move, scaled by how loud they really are. */
          if (now && Math.abs(x - head) < BAR_STEP * 7) {
            height *= 1 + 0.28 * list[i] * Math.sin(now / 110 + i * 1.4);
          }
          var inside = x >= left && x <= right;
          g.globalAlpha = x <= head ? 1 : (inside ? 0.85 : 0.45);
          g.fillStyle = x <= head ? accent : (inside ? strong : quiet);
          g.fillRect(x, mid - height / 2, 2, height);
        }
        g.globalAlpha = 1;
      } else {
        /* No shape was read: say only where someone spoke. */
        g.fillStyle = quiet;
        g.globalAlpha = 0.35;
        g.fillRect(0, mid - 1, w, 2);
        g.globalAlpha = 0.7;
        p.marks.forEach(function (m) { g.fillRect(m.left * w, mid - 6, Math.max(2, m.width * w), 12); });
        g.globalAlpha = 1;
        g.fillStyle = accent;
        g.fillRect(0, mid - 1, head, 2);
      }

      /* A confirmed name is the only thing that earns a colour. */
      g.fillStyle = accent;
      p.marks.forEach(function (m) {
        if (m.name) g.fillRect(m.left * w, h - 2, Math.max(2, m.width * w), 2);
      });
      g.fillRect(Math.min(head, w - 2), 0, 2, h);
    }

    React.useEffect(function () {
      var c = canvasRef.current;
      if (!c) return undefined;
      setWidth(c.clientWidth);
      if (typeof window.ResizeObserver !== 'function') return undefined;
      var ro = new window.ResizeObserver(function () { setWidth(c.clientWidth); });
      ro.observe(c);
      return function () { ro.disconnect(); };
    }, []);

    React.useEffect(function () {
      if (!props.playing) { draw(0); return undefined; }
      var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var frame = 0;
      function loop(now) {
        draw(still ? 0 : now);
        frame = window.requestAnimationFrame(loop);
      }
      frame = window.requestAnimationFrame(loop);
      return function () { window.cancelAnimationFrame(frame); };
    }, [props.playing, bars, props.shown, props.marks, props.shade]);

    return React.createElement('canvas', { ref: canvasRef, className: 'fs-topic-player__wave', 'aria-hidden': true });
  }

  function PlayIcon(props) {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true, fill: 'currentColor' },
      props.playing
        ? React.createElement('path', { d: 'M7 5h4v14H7zM13 5h4v14h-4z' })
        : React.createElement('path', { d: 'M8 5l11 7-11 7z' }));
  }

  function TopicPlayer(props) {
    var store = props.store;
    var P = tp();
    var h = React.createElement;

    /* videos: the raw preview list. spans: null until the probes settle, then the
       previews that overlap the topic. */
    var s_load = React.useState({ status: 'loading', segments: [], videos: [], spans: null });
    var load = s_load[0], setLoad = s_load[1];
    var s_pos = React.useState(0); var pos = s_pos[0], setPos = s_pos[1];
    var s_drag = React.useState(null); var drag = s_drag[0], setDrag = s_drag[1];
    var s_playing = React.useState(false); var playing = s_playing[0], setPlaying = s_playing[1];
    var s_speed = React.useState(1); var speed = s_speed[0], setSpeed = s_speed[1];
    var s_mode = React.useState('audio'); var mode = s_mode[0], setMode = s_mode[1];
    var s_error = React.useState(null); var error = s_error[0], setError = s_error[1];
    var s_seekClock = React.useState(null); var seekClock = s_seekClock[0], setSeekClock = s_seekClock[1];
    var s_peaks = React.useState({}); var peaks = s_peaks[0], setPeaks = s_peaks[1];

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
        var videos = r[1];
        setLoad({ status: segs === null ? 'error' : 'ok', segments: segs || [], videos: videos, spans: videos.length ? null : [] });
        var t = P.buildTimeline(segs || []);
        var startSec = toSec(props.start);
        setPos(startSec === null ? 0 : P.clockToPos(t, startSec));
        /* The button appears late rather than wrongly. */
        if (videos.length) {
          spansFor(videos, props).then(function (spans) {
            if (!cancelled) setLoad(function (l) { return Object.assign({}, l, { spans: spans }); });
          });
        }
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

    /* The lines ask canSeek, whose answer depends on both of these. */
    React.useEffect(function () { store.set({ version: store.getState().version + 1 }); }, [timeline, mode]);

    /* The waveform, one file at a time. Waits a moment so clicking down a list of
       topics downloads nothing; a file that cannot be read just draws no shape. */
    var fileKey = timeline.items.map(function (i) { return i.filename; }).join('|');
    React.useEffect(function () {
      if (!fileKey || !window.AbortController) return undefined;
      var ctl = new window.AbortController();
      var timer = window.setTimeout(function () {
        timelineRef.current.items.reduce(function (chain, item) {
          return chain.then(function () {
            if (ctl.signal.aborted) return null;
            return window.FS.topicWave.fetchPeaks(item.filename, item.url, ctl.signal).then(function (got) {
              if (ctl.signal.aborted) return;
              setPeaks(function (old) { var next = Object.assign({}, old); next[item.filename] = got; return next; });
            }).catch(function () { /* this file draws nothing */ });
          });
        }, Promise.resolve());
      }, 400);
      return function () { window.clearTimeout(timer); ctl.abort(); };
    }, [fileKey]);

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
        /* The transcript has to be there to follow the video and to jump from. */
        store.set({ wantTurns: true });
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
    var hasVideo = load.spans !== null && load.spans.length > 0;
    if (!timeline.items.length && !hasVideo) {
      if (load.spans === null && load.videos.length) {
        return h('div', { className: 'fs-topic-player fs-topic-player--quiet' }, 'Loading recording…');
      }
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
    /* A topic with video and no audio has nothing else to show. */
    var showVideo = !!VideoPlayer && hasVideo && (mode === 'video' || !timeline.items.length);

    function readPos() {
      if (drag !== null) return drag;
      var el = audioRef.current;
      if (playing && el && !pending.current && loadedIndex.current >= 0) {
        return P.position(timeline, loadedIndex.current, el.currentTime);
      }
      return pos;
    }

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

      showVideo
        ? h(VideoPlayer, {
            date: props.date, user: props.user, start: props.start, end: props.end,
            videos: load.spans,
            seekClock: seekClock,
            onNoMoment: onNoVideoMoment,
            onClock: function (sec) { store.set({ activeTurn: P.turnAtClock(store.getState().turns, sec) }); },
          })
        : h('div', { className: 'fs-topic-player__main' },
            h('button', {
              type: 'button', className: 'fs-topic-player__play',
              'aria-label': playing ? 'Pause' : 'Play', onClick: togglePlay,
            }, h(PlayIcon, { playing: playing })),
            h('div', { className: 'fs-topic-player__track' },
              h(Waveform, {
                timeline: timeline, peaks: peaks, marks: marks, shade: shade,
                playing: playing, shown: shown, getPos: readPos,
              }),
              h('input', {
                type: 'range', className: 'fs-topic-player__seek', 'aria-label': 'Position in this recording',
                min: 0, max: timeline.total, step: 0.1, value: Math.min(shown, timeline.total),
                onChange: function (e) { setDrag(Number(e.target.value)); },
                onPointerUp: function (e) { setDrag(null); seekPos(Number(e.target.value), playing); },
                onKeyUp: function (e) { setDrag(null); seekPos(Number(e.target.value), playing); },
              })
            )
          ),

      /* The same row in both modes, so the way back is always where it was. */
      h('div', { className: 'fs-topic-player__controls' },
        showVideo ? null : h('button', { type: 'button', className: 'fs-topic-player__skip', 'aria-label': 'Back 10 seconds',
          onClick: function () { seekPos(pos - 10, playing); } }, '-10'),
        showVideo ? null : h('button', { type: 'button', className: 'fs-topic-player__skip', 'aria-label': 'Forward 10 seconds',
          onClick: function () { seekPos(pos + 10, playing); } }, '+10'),
        showVideo ? null : h('button', {
          type: 'button', className: 'fs-topic-player__speed', 'aria-label': 'Playback speed',
          onClick: function () {
            var next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
            setSpeed(next);
            if (audioRef.current) setRate(audioRef.current, next);
          },
        }, speed + 'x'),
        showVideo ? null : h('span', { className: 'fs-topic-player__time' },
          clock ? h('b', null, clock) : null,
          ' ' + P.fmtLength(shown) + ' / ' + P.fmtLength(timeline.total)),
        hasVideo && timeline.items.length ? h('div', { className: 'fs-topic-player__modes', role: 'group', 'aria-label': 'Recording type' },
          ['audio', 'video'].map(function (m) {
            return h('button', {
              key: m, type: 'button', 'aria-pressed': mode === m,
              className: 'fs-topic-player__mode' + (mode === m ? ' fs-topic-player__mode--on' : ''),
              onClick: function () { switchMode(m); },
            }, m === 'audio' ? 'Audio' : 'Video');
          })
        ) : null
      ),

      error ? h('div', { className: 'fs-topic-player__error', role: 'alert' }, error,
        ' ', h('button', { type: 'button', className: 'fs-settings__link-btn', onClick: function () {
          retried.current = false; setError(null); seekPos(pos, true);
        } }, 'Retry')) : null
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TopicPlayer = TopicPlayer;
})();
