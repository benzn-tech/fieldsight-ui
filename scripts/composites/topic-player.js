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

  /* Every preview's real span (all), and those that overlap the topic window
     (overlap: the Video button). The bar seeks and dims over all of them, so a
     press beside the topic on real video plays it rather than say there is none. */
  function spansFor(videos, props) {
    var P = tp();
    return Promise.all(P.probeTargets(videos).map(function (v) {
      return probeDuration(v.url).then(function (d) { return [v.filename, d]; });
    })).then(function (pairs) {
      var durations = {};
      pairs.forEach(function (p) { if (p[1]) durations[p[0]] = p[1]; });
      var all = P.videoSpans(videos, durations);
      return { all: all, overlap: P.overlapping(all, toSec(props.start), toSec(props.end)) };
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
  var STRIP = 4;      /* the speaker strip along the bottom, px */

  /* The bar's swatches differ by theme (spec 2026-11-10 §6.2), so follow it. */
  function useDarkTheme() {
    var root = window.document.documentElement;
    function read() { return root.getAttribute('data-theme') === 'dark'; }
    var s_dark = React.useState(read); var dark = s_dark[0], setDark = s_dark[1];
    React.useEffect(function () {
      if (typeof window.MutationObserver !== 'function') return undefined;
      var mo = new window.MutationObserver(function () { setDark(read()); });
      mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
      setDark(read());
      return function () { mo.disconnect(); };
    }, []);
    return dark;
  }

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
      var dim = token(style, '--surface-panel-muted', '#888');

      var total = p.timeline.total || 1;
      var head = Math.max(0, Math.min(1, p.getPos() / total)) * w;
      var left = p.shade ? p.shade.left * w : 0;
      var right = p.shade ? p.shade.right * w : w;
      if (p.shade) {
        g.fillStyle = range;
        g.fillRect(left, 0, Math.max(0, right - left), h);
      }

      var P = tp();
      var mid = (h - STRIP) / 2;
      var list = barsRef.current;
      if (list) {
        /* Each bar takes the swatch of the turn covering it; none = neutral. */
        var tint = new Array(list.length);
        p.marks.forEach(function (m) {
          var c = P.swatch(p.colors[m.speaker], p.dark);
          if (!c) return;
          var from = Math.max(0, Math.floor(m.left * w / BAR_STEP));
          var to = Math.min(list.length - 1, Math.floor((m.left + m.width) * w / BAR_STEP));
          for (var k = from; k <= to; k++) tint[k] = c;
        });
        for (var i = 0; i < list.length; i++) {
          var x = i * BAR_STEP;
          var height = Math.max(2, list[i] * (h - STRIP - 6));
          /* Bars by the head move, scaled by how loud they really are. */
          if (now && Math.abs(x - head) < BAR_STEP * 7) {
            height *= 1 + 0.28 * list[i] * Math.sin(now / 110 + i * 1.4);
          }
          var inside = x >= left && x <= right;
          var played = x <= head;
          /* Dimmed bars are decoration; the strip below carries the colour. */
          g.globalAlpha = played ? 1 : (inside ? 0.6 : 0.3);
          g.fillStyle = tint[i] || (played ? accent : (inside ? strong : quiet));
          g.fillRect(x, mid - height / 2, 2, height);
        }
        g.globalAlpha = 1;
      } else {
        /* No shape was read: say only where someone spoke. */
        g.fillStyle = quiet;
        g.globalAlpha = 0.35;
        g.fillRect(0, mid - 1, w, 2);
        g.globalAlpha = 0.7;
        p.marks.forEach(function (m) {
          g.fillStyle = P.swatch(p.colors[m.speaker], p.dark) || quiet;
          g.fillRect(m.left * w, mid - 6, Math.max(2, m.width * w), 12);
        });
        g.globalAlpha = 1;
        g.fillStyle = accent;
        g.fillRect(0, mid - 1, head, 2);
      }

      /* The strip: who spoke where, at full strength, with or without a shape. */
      p.marks.forEach(function (m) {
        var c = P.swatch(p.colors[m.speaker], p.dark);
        if (!c) return;
        g.fillStyle = c;
        g.fillRect(m.left * w, h - STRIP, Math.max(2, m.width * w), STRIP);
      });

      /* Video mode: dim what no video covers. Shading only. */
      if (p.gaps && p.gaps.length) {
        g.fillStyle = dim;
        g.globalAlpha = 0.35;
        p.gaps.forEach(function (r) { g.fillRect(r.left * w, 0, Math.max(0, (r.right - r.left) * w), h); });
        g.globalAlpha = 1;
      }

      g.fillStyle = accent;
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
    }, [props.playing, bars, props.shown, props.marks, props.shade, props.dark, props.colors, props.gaps]);

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

    var s_vidAt = React.useState(-1); var vidAt = s_vidAt[0], setVidAt = s_vidAt[1];

    var audioRef = React.useRef(null);
    var fetchedAt = React.useRef(0);
    var pending = React.useRef(null);     /* { offset, resume } waiting for metadata */
    var loadedIndex = React.useRef(-1);
    var retried = React.useRef(false);
    var widened = React.useRef(false);
    /* The host video (spec 2026-11-10 §6.3): video mode on a topic with audio. */
    var videoRef = React.useRef(null);
    var wrapRef = React.useRef(null);
    var vidIndex = React.useRef(-1);      /* index into load.allSpans */
    var vidPending = React.useRef(null);  /* { offset, resume, request } waiting for metadata */
    var vidRetried = React.useRef(false);
    var allSpansRef = React.useRef([]); allSpansRef.current = load.allSpans || [];

    var turns = useStore(store, function (s) { return s.turns; });
    /* The chips' colour function over the chips' own array (store.turns). */
    var colors = React.useMemo(function () { return P.speakerColors(turns); }, [turns]);
    var dark = useDarkTheme();
    var timeline = React.useMemo(function () { return P.buildTimeline(load.segments); }, [load.segments]);
    var timelineRef = React.useRef(timeline); timelineRef.current = timeline;
    var modeRef = React.useRef(mode); modeRef.current = mode;
    /* Gaps in video coverage, dimmed on the bar in video mode. */
    var gaps = React.useMemo(function () { return P.uncovered(timeline, load.allSpans || []); }, [timeline, load.allSpans]);
    var hasVideo = load.spans !== null && load.spans.length > 0;
    /* With audio, video mode uses this player's own <video> and bar. */
    var hostVideo = hasVideo && mode === 'video' && timeline.items.length > 0;

    function fetchAudio(startOverride) {
      return window.FS.api.audio.getAudioSegments({
        date: props.date, user: props.user, start: startOverride || props.start, end: props.end,
      }).then(function (res) { fetchedAt.current = Date.now(); return (res && res.segments) || []; });
    }

    function fetchVideos() {
      return window.FS.api.video.getVideoSegments({ date: props.date, user: props.user, start: props.start, end: props.end })
        .then(function (res) { return ((res && res.videos) || []).filter(function (v) { return v.is_preview; }); });
    }

    /* First load. The bar shows its real length before anything plays. */
    React.useEffect(function () {
      var cancelled = false;
      Promise.all([
        fetchAudio().catch(function () { return null; }),
        fetchVideos().catch(function () { return []; }),
      ]).then(function (r) {
        if (cancelled) return;
        var segs = r[0];
        var videos = r[1];
        setLoad({
          status: segs === null ? 'error' : 'ok', segments: segs || [], videos: videos,
          spans: videos.length ? null : [], allSpans: [],
        });
        var t = P.buildTimeline(segs || []);
        var startSec = toSec(props.start);
        setPos(startSec === null ? 0 : P.clockToPos(t, startSec));
        /* The button appears late rather than wrongly. */
        if (videos.length) {
          spansFor(videos, props).then(function (got) {
            if (!cancelled) setLoad(function (l) { return Object.assign({}, l, { spans: got.overlap, allSpans: got.all }); });
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

    /* The host video stops explicitly when video mode ends or the topic closes.
       Captured on mount: React has detached the ref by the time this runs. */
    React.useEffect(function () {
      if (!hostVideo) return undefined;
      var mounted = videoRef.current;
      var wrap = wrapRef.current;
      return function () {
        vidIndex.current = -1;
        vidPending.current = null;
        var d = window.document;
        if (wrap && d.fullscreenElement === wrap && d.exitFullscreen) { try { d.exitFullscreen(); } catch (_) { /* not ours */ } }
        var v = videoRef.current || mounted;
        if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* gone */ } }
      };
    }, [hostVideo]);

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

    /* Video mode on a topic with audio. Read from refs: the transcript's
       handlers are registered once. */
    function hosting() { return modeRef.current === 'video' && timelineRef.current.items.length > 0; }

    function loadVideo(index, offset, resume, request) {
      var v = videoRef.current;
      var span = allSpansRef.current[index];
      if (!v || !span) return;
      setError(null);
      vidIndex.current = index;
      setVidAt(index);
      vidPending.current = { offset: offset, resume: resume, request: request };
      v.src = span.url;
      v.load();
    }

    /* A clock moment in the host video, or the existing no-video path. */
    function seekVideoClock(clock, resume, request) {
      var v = videoRef.current;
      var at = typeof clock === 'number' ? P.videoTarget(allSpansRef.current, clock) : null;
      if (!at) { onNoVideoMoment(request); return; }
      if (!v) return;
      if (at.index === vidIndex.current && !vidPending.current) {
        if (v.duration && at.offset > v.duration) { onNoVideoMoment(request); return; }
        v.currentTime = at.offset;
        if (resume) start(v);
        return;
      }
      loadVideo(at.index, at.offset, resume, request);
    }

    /* A bar position. In video mode the clock comes from the turn under the
       press (activeTurn there is clock-derived), then the span lookup. */
    function seekBar(p, resume) {
      if (!hosting()) { seekPos(p, resume); return; }
      var tl = timelineRef.current;
      var i = P.turnAt(store.getState().turns, timelineRef.current, p);
      var clock = P.clockAt(tl, p, i === null ? null : store.getState().turns[i]);
      setPos(Math.max(0, Math.min(Number(p) || 0, tl.total)));
      seekVideoClock(clock, resume, { pos: p, resume: resume });
    }

    function togglePlay() {
      store.set({ wantTurns: true });
      if (hosting()) {
        var v = videoRef.current;
        if (!v) return;
        if (playing) { v.pause(); return; }
        if (vidIndex.current < 0 || vidPending.current) { seekBar(pos, true); return; }
        start(v);
        return;
      }
      var el = audioRef.current;
      if (!el) return;
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
          if (hosting()) { seekVideoClock(turn.start, true, { turn: turn }); return; }
          if (modeRef.current === 'video') { setSeekClock({ sec: turn.start, turn: turn, nonce: Date.now() }); return; }
          var at = P.turnTarget(timelineRef.current, turn);
          if (at) seekPos(P.position(timelineRef.current, at.index, at.offset), true);
        },
      });
      return function () { store.setHandlers(null); };
    }, [store]);

    /* Entering video mode: go to the moment the audio was at, once the host
       video has mounted. */
    React.useEffect(function () {
      if (!hostVideo || !seekClock) return;
      seekVideoClock(seekClock.sec, !!seekClock.resume, { turn: seekClock.turn, pos: seekClock.pos, resume: seekClock.resume });
    }, [hostVideo, seekClock && seekClock.nonce]);

    function stopFlag() { setPlaying(false); store.set({ playing: false }); }

    /* One playing flag: the outgoing element is paused in both directions, and
       only the current mode's element reports play and pause. */
    function switchMode(next) {
      if (next === mode) return;
      var state = store.getState();
      var turn = state.activeTurn === null ? null : state.turns[state.activeTurn];
      var was = playing;
      modeRef.current = next;
      if (next === 'video') {
        /* The transcript has to be there to follow the video and to jump from. */
        store.set({ wantTurns: true });
        if (audioRef.current) audioRef.current.pause();
        var clock = P.clockAt(timeline, pos, turn);
        setSeekClock(clock === null ? null : { sec: clock, resume: was, pos: pos, nonce: Date.now() });
        stopFlag();
      } else {
        if (videoRef.current) videoRef.current.pause();
        stopFlag();
        /* The video wrote pos as it played; the audio resumes from there. */
        if (timeline.items.length) seekPos(pos, was);
      }
      setMode(next);
    }

    /* The moment asked for is not in any video: audio at that moment, and say so. */
    function onNoVideoMoment(request) {
      modeRef.current = 'audio';
      if (videoRef.current) videoRef.current.pause();
      stopFlag();   /* the video's own pause event is now ignored */
      setMode('audio');
      var toast = window.FS && window.FS.toast;
      if (toast) toast.show({ message: 'No video at this moment', tone: 'info', duration: 3000 });
      var at = request && request.turn ? P.turnTarget(timelineRef.current, request.turn) : null;
      if (at) { seekPos(P.position(timelineRef.current, at.index, at.offset), true); return; }
      if (request && typeof request.pos === 'number') seekPos(request.pos, request.resume !== false);
    }

    function toggleFullscreen() {
      var d = window.document;
      if (d.fullscreenElement) { if (d.exitFullscreen) d.exitFullscreen(); return; }
      if (!wrapRef.current || !wrapRef.current.requestFullscreen) return;
      var r = wrapRef.current.requestFullscreen();
      if (r && r.catch) r.catch(function () { /* refused; the player stays as it was */ });
    }

    if (load.status === 'loading') {
      return h('div', { className: 'fs-topic-player fs-topic-player--quiet' }, 'Loading recording…');
    }
    if (load.status === 'error') {
      return h('div', { className: 'fs-topic-player fs-topic-player--quiet' }, 'Could not load audio.');
    }
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
    /* A topic with video and no audio has nothing else to show: VideoPlayer,
       native controls, as before. With audio, video mode is hostVideo. */
    var showVideo = !!VideoPlayer && hasVideo && !timeline.items.length;
    var span = hostVideo ? (load.allSpans || [])[vidAt] : null;

    function readPos() {
      if (drag !== null) return drag;
      if (hostVideo) {
        var v = videoRef.current;
        var cur = allSpansRef.current[vidIndex.current];
        if (playing && v && cur && !vidPending.current) {
          return P.videoClockToPos(timeline, turns, cur.span_start + v.currentTime);
        }
        return pos;
      }
      var el = audioRef.current;
      if (playing && el && !pending.current && loadedIndex.current >= 0) {
        return P.position(timeline, loadedIndex.current, el.currentTime);
      }
      return pos;
    }

    return h('div', { ref: wrapRef, className: 'fs-topic-player' + (hostVideo ? ' fs-topic-player--video' : '') },
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
        onPlay: function () {
          if (modeRef.current !== 'audio') return;
          retried.current = false; setPlaying(true); store.set({ playing: true });
        },
        onPause: function () {
          if (modeRef.current !== 'audio') return;
          setPlaying(false); store.set({ playing: false });
        },
        onTimeUpdate: function () {
          var el = audioRef.current;
          if (!el || pending.current || loadedIndex.current < 0 || modeRef.current !== 'audio') return;
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

      /* No native controls: the bar and the row below are the controls. */
      hostVideo ? h('div', { className: 'fs-topic-player__screen' },
        h('video', {
          ref: videoRef,
          preload: 'metadata',
          playsInline: true,
          className: 'fs-topic-player__video',
          onLoadedMetadata: function () {
            var v = videoRef.current, w = vidPending.current;
            if (!v) return;
            setRate(v, speed);   /* a new src resets the rate */
            if (!w) return;
            vidPending.current = null;
            /* Files do not cover every moment. Say so rather than play the wrong one. */
            if (v.duration && w.offset > v.duration) { onNoVideoMoment(w.request); return; }
            try { v.currentTime = w.offset; } catch (_) { /* stays at 0 */ }
            if (w.resume) start(v);
          },
          onPlay: function () {
            if (modeRef.current !== 'video') return;
            vidRetried.current = false; setPlaying(true); store.set({ playing: true });
          },
          onPause: function () {
            if (modeRef.current !== 'video') return;
            setPlaying(false); store.set({ playing: false });
          },
          onTimeUpdate: function () {
            var v = videoRef.current;
            var cur = allSpansRef.current[vidIndex.current];
            if (!v || !cur || vidPending.current || modeRef.current !== 'video') return;
            var at = cur.span_start + v.currentTime;
            var list = store.getState().turns;
            store.set({ activeTurn: P.turnAtClock(list, at) });
            setPos(P.videoClockToPos(timelineRef.current, list, at));
          },
          /* On into the next span, over any gap, as audio does across files. */
          onEnded: function () {
            var next = vidIndex.current + 1;
            if (next < allSpansRef.current.length) loadVideo(next, 0, true, { pos: pos });
            else stopFlag();
          },
          /* Links expire after 15 minutes: refetch once, match by filename. */
          onError: function () {
            var v = videoRef.current;
            var cur = allSpansRef.current[vidIndex.current];
            if (!v || !v.getAttribute('src') || !cur) return;
            var w = vidPending.current || { offset: v.currentTime, resume: playing, request: { pos: pos } };
            vidPending.current = null;
            if (vidRetried.current) { stopFlag(); setError('Could not load video.'); return; }
            vidRetried.current = true;
            fetchVideos().then(function (list) {
              var byName = {};
              list.forEach(function (x) { byName[x.filename] = x.url; });
              if (!byName[cur.filename]) { setError('Could not load video.'); return; }
              setLoad(function (l) {
                return Object.assign({}, l, { allSpans: (l.allSpans || []).map(function (s) {
                  return byName[s.filename] ? Object.assign({}, s, { url: byName[s.filename] }) : s;
                }) });
              });
              vidPending.current = w;
              v.src = byName[cur.filename];
              v.load();
            }).catch(function () { setError('Could not load video.'); });
          },
        }),
        span ? h('div', { className: 'fs-topic-player__meta' },
          h('span', { className: 'fs-topic-player__meta-time' }, span.time_label || ''),
          h('span', { className: 'fs-topic-player__meta-file' }, span.filename)) : null
      ) : null,

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
                timeline: timeline, peaks: peaks, marks: marks, shade: shade, colors: colors, dark: dark,
                gaps: hostVideo ? gaps : null,
                playing: playing, shown: shown, getPos: readPos,
              }),
              h('input', {
                type: 'range', className: 'fs-topic-player__seek', 'aria-label': 'Position in this recording',
                min: 0, max: timeline.total, step: 0.1, value: Math.min(shown, timeline.total),
                onChange: function (e) { setDrag(Number(e.target.value)); },
                onPointerUp: function (e) { setDrag(null); seekBar(Number(e.target.value), playing); },
                onKeyUp: function (e) { setDrag(null); seekBar(Number(e.target.value), playing); },
              })
            )
          ),

      /* The same row in both modes, so the way back is always where it was. */
      h('div', { className: 'fs-topic-player__controls' },
        showVideo ? null : h('button', { type: 'button', className: 'fs-topic-player__skip', 'aria-label': 'Back 10 seconds',
          onClick: function () { seekBar(pos - 10, playing); } }, '-10'),
        showVideo ? null : h('button', { type: 'button', className: 'fs-topic-player__skip', 'aria-label': 'Forward 10 seconds',
          onClick: function () { seekBar(pos + 10, playing); } }, '+10'),
        showVideo ? null : h('button', {
          type: 'button', className: 'fs-topic-player__speed', 'aria-label': 'Playback speed',
          onClick: function () {
            var next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
            setSpeed(next);
            if (audioRef.current) setRate(audioRef.current, next);
            if (videoRef.current) setRate(videoRef.current, next);
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
        ) : null,
        /* The whole player, so the bar and controls stay usable. */
        hostVideo && window.document.fullscreenEnabled ? h('button', {
          type: 'button', className: 'fs-topic-player__skip fs-topic-player__fullscreen',
          'aria-label': 'Full screen', title: 'Full screen', onClick: toggleFullscreen,
        }, h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
          h('path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }))) : null
      ),

      error ? h('div', { className: 'fs-topic-player__error', role: 'alert' }, error,
        ' ', h('button', { type: 'button', className: 'fs-settings__link-btn', onClick: function () {
          retried.current = false; vidRetried.current = false; vidIndex.current = -1;
          setError(null); seekBar(pos, true);
        } }, 'Retry')) : null
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TopicPlayer = TopicPlayer;
})();
