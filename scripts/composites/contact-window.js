/* ==========================================================================
   FieldSight · Contact FieldSight window (spec 2026-11-08 contact-fieldsight)
   --------------------------------------------------------------------------
   Replaces the left-nav mailto with a window over the current page. The
   person types, or records up to 2:00; the recording is transcribed into the
   text, which they may edit; Send posts the text, the machine transcript and
   the audio to /api/contact/messages, which emails sales@ and keeps a record.

   Mounted once by AppShell, the SettingsHost pattern (pages/settings.js): no
   work before the first open, the host stays mounted afterwards so the draft
   (text, recording, transcript, id) survives closing until the page reloads,
   and only the overlay unmounts.

   window.FS.contact = { open, close, isOpen }

   When the backend is not there -- flag off (404), mock mode, an empty
   orgBaseUrl, a network fault -- Send keeps the window open with the text
   and offers "Email us instead", the old mailto with the text prefilled.
   Transcription failing never blocks Send: the audio still goes as a voice
   note.

   The message id is made once per draft, so a second press or a retry after
   a timeout is idempotent on the server.
   ========================================================================== */

/* global React, window, document, navigator */

(function () {
  'use strict';

  var HELP_EMAIL = 'sales@fieldsightai.com';
  var MAX_TEXT = 4000;
  var MAX_SECONDS = 120;
  var MIME_ORDER = ['audio/webm;codecs=opus', 'audio/mp4'];

  /* ---------- Pure helpers (exported for tests) ------------------------- */

  function pickMime(isTypeSupported) {
    if (typeof isTypeSupported !== 'function') return null;
    for (var i = 0; i < MIME_ORDER.length; i++) {
      try { if (isTypeSupported(MIME_ORDER[i])) return MIME_ORDER[i]; } catch (e) { return null; }
    }
    return null;
  }

  function canSend(s) {
    s = s || {};
    if (s.sending) return false;
    return !!(s.blob || String(s.text || '').trim());
  }

  function appendTranscript(text, transcript) {
    var t = String(transcript || '');
    var base = String(text || '');
    if (!t) return base;
    if (!base.trim()) return t;
    return base.replace(/\s+$/, '') + '\n\n' + t;
  }

  /* The left nav's help mailto (left-nav.js buildHelpMailto) with the typed
     text at the top of the body. With no text it is the same URL, character
     for character. Page path only: a query string may hold a search term. */
  function fallbackMailto(user, route, text) {
    var lines = [
      String(text || ''),
      '',
      '---',
      'Name: ' + ((user && user.name) || ''),
      'Page: ' + String(route || '').split('?')[0],
    ];
    return 'mailto:' + HELP_EMAIL
      + '?subject=' + encodeURIComponent('FieldSight help request')
      + '&body=' + encodeURIComponent(lines.join('\n'));
  }

  function personName(user, me) {
    var n = (user && (user.name || user.display_name)) || '';
    if (!n && me) n = [me.first_name, me.last_name].filter(Boolean).join(' ');
    return String(n || '').trim();
  }

  function personEmail(user, me) {
    return String((user && user.email) || (me && me.email) || '');
  }

  function contextFor(user, me, siteName, route) {
    return {
      name: personName(user, me),
      company: String((me && me.company_name) || (user && user.company) || ''),
      project: String(siteName || ''),
      page: String(route || '').split('?')[0],
    };
  }

  function errorCopy(kind, extra) {
    if (kind === 'mic') return 'Microphone not available. You can type instead.';
    if (kind === 'stt') return "Couldn't turn the recording into text. It will still be sent as a voice note.";
    if (kind === 'rate') {
      var n = Math.max(1, Math.ceil((Number(extra) || 0) / 60));
      return "You've sent several messages recently. Please try again in " + n + (n === 1 ? ' minute.' : ' minutes.');
    }
    return "We couldn't send this here. Email us instead.";
  }

  /* What Send's outcome means for the window. Anything that is not a 201 or a
     429 means "this route cannot take it right now", and the person is given
     the mailto rather than a dead end. */
  function classifySend(res, err) {
    if (err) {
      if (err.status === 429) {
        return { kind: 'rate', retryAfterS: (err.body && err.body.retry_after_s) || 60 };
      }
      return { kind: 'fallback' };
    }
    if (!res || res._notFound || res._accessDenied || !res.id) return { kind: 'fallback' };
    return { kind: 'ok' };
  }

  function transcriptFrom(res) {
    if (!res || res._notFound || res._accessDenied || res.error) return null;
    var t = typeof res.text === 'string' ? res.text.trim() : '';
    return t || null;
  }

  function formatClock(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /* ---------- Browser side ---------------------------------------------- */

  function contactApi() { return window.FS && window.FS.api && window.FS.api.contact; }
  function apiAvailable() { var c = contactApi(); return !!(c && c.available()); }

  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function supportedMime() {
    if (typeof window.MediaRecorder === 'undefined') return null;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return null;
    return pickMime(function (m) { return window.MediaRecorder.isTypeSupported(m); });
  }

  function freshDraft() {
    var c = contactApi();
    return {
      id: c ? c.newId() : String(Date.now()),
      text: '', blob: null, mime: null, clipUrl: null, transcript: null,
    };
  }

  /* The project's display name, from the same source the header selector
     uses (org sites when live, the sites fixture otherwise). */
  function resolveSiteName(siteId) {
    if (!siteId) return Promise.resolve('');
    var api = window.FS && window.FS.api;
    if (!api) return Promise.resolve('');
    var live = !api.useMocks && api.orgBaseUrl && api.org;
    var req = live ? api.org.getOrgSites() : (api.sites ? api.sites.getSites() : null);
    if (!req) return Promise.resolve('');
    return req.then(function (res) {
      var list = (res && res.sites) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].site_id === siteId) return list[i].name || '';
      }
      return '';
    }).catch(function () { return ''; });
  }

  function LevelMeter(props) {
    var canvasRef = React.useRef(null);
    React.useEffect(function () {
      var analyser = props.analyser;
      var canvas = canvasRef.current;
      if (!analyser || !canvas || props.still) return undefined;
      var g = canvas.getContext('2d');
      var data = new Uint8Array(analyser.fftSize);
      var colour = window.getComputedStyle(canvas).color || '#D97706';
      var history = [];
      var raf = 0;
      function draw() {
        analyser.getByteTimeDomainData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) { var v = (data[i] - 128) / 128; sum += v * v; }
        var level = Math.min(1, Math.sqrt(sum / data.length) * 4);
        var bars = Math.floor(canvas.width / 4);
        history.push(level);
        if (history.length > bars) history.shift();
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = colour;
        for (var b = 0; b < history.length; b++) {
          var h = Math.max(2, history[b] * canvas.height);
          g.fillRect(b * 4, (canvas.height - h) / 2, 2, h);
        }
        raf = window.requestAnimationFrame(draw);
      }
      raf = window.requestAnimationFrame(draw);
      return function () { window.cancelAnimationFrame(raf); };
    }, [props.analyser, props.still]);

    if (props.still) {
      return React.createElement('span', { className: 'fs-contact__meter fs-contact__meter--still', 'aria-hidden': 'true' });
    }
    return React.createElement('canvas', {
      ref: canvasRef, className: 'fs-contact__meter', width: 160, height: 28, 'aria-hidden': 'true',
    });
  }

  function hasUnsentDraft(d) {
    return !!(d && ((d.text && d.text.trim()) || d.blob));
  }

  /* The entry point (owner, 2026-11-09): a labelled button fixed bottom-right on
     every page, replacing the left-nav item. The text label is the point: an icon
     alone could read as a site feature; this has to say "this reaches us". */
  /* FieldSight's own contact mark: a speech bubble carrying a short voice wave,
     because a message here is usually a voice note. Strokes use currentColor. */
  function ContactMark() {
    var h = React.createElement;
    return h('svg', { className: 'fs-contact-fab__mark', viewBox: '0 0 24 24', width: 24, height: 24,
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round',
      strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z' }),
      h('path', { d: 'M8.5 8.5v2M12 7v5M15.5 8.5v2' }));
  }

  function ContactLauncher(props) {
    var h = React.createElement;
    return h('button', {
      type: 'button',
      className: 'fs-contact-fab',
      'aria-label': 'Contact the FieldSight team',
      title: 'Questions, problems or feedback? Message the FieldSight team.',
      onClick: props.onClick,
    },
      h(ContactMark, null),
      h('span', { className: 'fs-contact-fab__label' }, 'Contact'),
      props.hasDraft ? h('span', { className: 'fs-contact-fab__dot', 'aria-label': 'unsent message' }) : null);
  }

  function ContactHost(props) {
    var rOpen = React.useState(false); var open = rOpen[0], setOpen = rOpen[1];
    var rUsed = React.useState(false); var used = rUsed[0], setUsed = rUsed[1];
    var rDraft = React.useState(null); var draft = rDraft[0], setDraft = rDraft[1];
    var rMe = React.useState(null); var me = rMe[0], setMe = rMe[1];
    var rSite = React.useState(''); var siteName = rSite[0], setSiteName = rSite[1];
    /* idle | recording | transcribing */
    var rRec = React.useState('idle'); var recState = rRec[0], setRecState = rRec[1];
    var rElapsed = React.useState(0); var elapsed = rElapsed[0], setElapsed = rElapsed[1];
    var rAnalyser = React.useState(null); var analyser = rAnalyser[0], setAnalyser = rAnalyser[1];
    var rMicErr = React.useState(false); var micErr = rMicErr[0], setMicErr = rMicErr[1];
    var rSttErr = React.useState(false); var sttErr = rSttErr[0], setSttErr = rSttErr[1];
    var rSending = React.useState(false); var sending = rSending[0], setSending = rSending[1];
    /* null | { kind: 'fallback' } | { kind: 'rate', retryAfterS } */
    var rNotice = React.useState(null); var notice = rNotice[0], setNotice = rNotice[1];

    var live = React.useRef({});
    live.current = { user: props.user, route: props.route, onOpen: props.onOpen, open: open, draft: draft, me: me, siteName: siteName };
    /* Everything the recorder holds that must be released on every exit. */
    var rec = React.useRef({ stream: null, recorder: null, ctx: null, timer: 0, stopAt: 0, startedAt: 0, gen: 0 });

    function patchDraft(patch) {
      setDraft(function (d) { return Object.assign({}, d || freshDraft(), patch); });
    }

    function releaseMic() {
      var r = rec.current;
      if (r.timer) { window.clearInterval(r.timer); r.timer = 0; }
      if (r.stopAt) { window.clearTimeout(r.stopAt); r.stopAt = 0; }
      if (r.stream) {
        try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* already gone */ }
        r.stream = null;
      }
      if (r.ctx) { try { r.ctx.close(); } catch (e) { /* already closed */ } r.ctx = null; }
      setAnalyser(null);
    }

    function stopRecording() {
      var r = rec.current;
      if (r.recorder && r.recorder.state !== 'inactive') {
        try { r.recorder.stop(); } catch (e) { releaseMic(); }
      } else {
        releaseMic();
      }
    }

    function transcribe(blob, mime, gen) {
      if (!apiAvailable()) { setRecState('idle'); setSttErr(true); return; }
      setRecState('transcribing');
      contactApi().transcribe(blob, mime).then(function (res) {
        if (rec.current.gen !== gen) return;
        var words = transcriptFrom(res);
        if (!words) { setSttErr(true); return; }
        setDraft(function (d) {
          d = d || freshDraft();
          return Object.assign({}, d, { transcript: words, text: appendTranscript(d.text, words).slice(0, MAX_TEXT) });
        });
      }).catch(function () {
        if (rec.current.gen === gen) setSttErr(true);
      }).then(function () {
        if (rec.current.gen === gen) setRecState('idle');
      });
    }

    function startRecording() {
      var mime = supportedMime();
      if (!mime) { setMicErr(true); return; }
      setMicErr(false); setSttErr(false); setNotice(null);
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var r = rec.current;
        var gen = ++r.gen;
        var recorder;
        try {
          recorder = new window.MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
        } catch (e) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          setMicErr(true);
          return;
        }
        var chunks = [];
        r.stream = stream;
        r.recorder = recorder;
        recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
        recorder.onstop = function () {
          releaseMic();
          r.recorder = null;
          if (rec.current.gen !== gen) return;
          /* The type is the base of what pickMime chose: the server's
             whitelist is exact, and recorder.mimeType may carry extra codec
             parameters (audio/mp4;codecs=mp4a.40.2). */
          var blob = new Blob(chunks, { type: mime.split(';')[0] });
          if (!blob.size) { setRecState('idle'); setMicErr(true); return; }
          patchDraft({ blob: blob, mime: mime, clipUrl: URL.createObjectURL(blob), transcript: null });
          transcribe(blob, mime, gen);
        };
        try {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          if (Ctx) {
            var ctx = new Ctx();
            var an = ctx.createAnalyser();
            an.fftSize = 512;
            ctx.createMediaStreamSource(stream).connect(an);
            r.ctx = ctx;
            setAnalyser(an);
          }
        } catch (e) { /* the meter is decoration; recording goes on */ }
        r.startedAt = Date.now();
        setElapsed(0);
        r.timer = window.setInterval(function () { setElapsed((Date.now() - r.startedAt) / 1000); }, 250);
        r.stopAt = window.setTimeout(stopRecording, MAX_SECONDS * 1000);
        recorder.start(1000);
        setRecState('recording');
      }).catch(function () {
        setMicErr(true);
      });
    }

    function removeRecording() {
      rec.current.gen += 1;   /* a transcription still in flight is ignored */
      stopRecording();
      var d = live.current.draft;
      if (d && d.clipUrl) { try { URL.revokeObjectURL(d.clipUrl); } catch (e) { /* ignore */ } }
      patchDraft({ blob: null, mime: null, clipUrl: null, transcript: null });
      setSttErr(false);
      setRecState('idle');
    }

    function closeWindow() {
      /* A recording in progress is finished and kept with the draft. */
      if (rec.current.recorder) stopRecording();
      setOpen(false);
    }

    function openWindow() {
      setUsed(true);
      setOpen(true);
      setNotice(null);   /* a fallback or rate line belongs to the last Send */
      if (!live.current.draft) setDraft(freshDraft());
      if (live.current.onOpen) live.current.onOpen();
      var api = window.FS && window.FS.api;
      if (!live.current.me && api && api.org && api.org.getMe) {
        api.org.getMe().then(function (m) {
          if (m && !m._accessDenied && !m._notFound) setMe(m);
        }).catch(function () { /* the name and email still come from the session */ });
      }
      var siteId = window.FS && window.FS.siteContext ? window.FS.siteContext.get() : null;
      resolveSiteName(siteId).then(setSiteName);
    }

    React.useEffect(function () {
      if (!window.FS) window.FS = {};
      window.FS.contact = {
        open: openWindow,
        close: closeWindow,
        isOpen: function () { return !!live.current.open; },
      };
      return function () { delete window.FS.contact; releaseMic(); };
    }, []);

    function emailInstead() {
      var d = live.current.draft || {};
      window.location.href = fallbackMailto({ name: personName(live.current.user, live.current.me) },
        live.current.route, d.text);
    }

    function send() {
      var d = live.current.draft;
      if (!canSend({ text: d && d.text, blob: d && d.blob, sending: sending })) return;
      setNotice(null);
      if (!apiAvailable()) { setNotice({ kind: 'fallback' }); return; }
      setSending(true);
      var u = live.current.user;
      var m = live.current.me;
      contactApi().send({
        id: d.id, text: d.text, transcript: d.transcript, blob: d.blob, mime: d.mime,
        context: contextFor(u, m, live.current.siteName, live.current.route),
      }).then(function (res) { return classifySend(res, null); },
              function (err) { return classifySend(null, err); })
        .then(function (out) {
          setSending(false);
          if (out.kind === 'ok') {
            if (d.clipUrl) { try { URL.revokeObjectURL(d.clipUrl); } catch (e) { /* ignore */ } }
            setDraft(freshDraft());
            setSttErr(false);
            setOpen(false);
            if (window.FS && window.FS.toast) {
              window.FS.toast.show({ message: "Sent. We'll reply to " + (personEmail(u, m) || 'your email') + '.', tone: 'success', duration: 6000 });
            }
          } else {
            setNotice(out);
          }
        });
    }

    var launcher = React.createElement(ContactLauncher, { onClick: openWindow, hasDraft: hasUnsentDraft(draft) });
    if (!used) return launcher;
    var Modal = window.FieldSight && window.FieldSight.ModalOverlay;
    if (!open || !Modal || !draft) return launcher;

    var u = props.user;
    var name = personName(u, me);
    var email = personEmail(u, me);
    var h = React.createElement;
    var recording = recState === 'recording';
    var hasMime = !!supportedMime();

    var recordRow;
    if (draft.blob && !recording) {
      recordRow = h('div', { className: 'fs-contact__clip' },
        h('audio', { controls: true, src: draft.clipUrl, className: 'fs-contact__audio' }),
        h('button', { type: 'button', className: 'fs-btn fs-btn--ghost fs-btn--sm', onClick: removeRecording }, 'Remove recording'));
    } else if (recording) {
      recordRow = h('div', { className: 'fs-contact__rec fs-contact__rec--on' },
        h('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm fs-contact__stop', onClick: stopRecording },
          h('span', { className: 'fs-contact__stop-icon', 'aria-hidden': 'true' }), 'Stop'),
        h(LevelMeter, { analyser: analyser, still: reducedMotion() }),
        h('span', { className: 'fs-contact__clock', 'aria-live': 'off' }, formatClock(elapsed) + ' / ' + formatClock(MAX_SECONDS)));
    } else if (!hasMime || micErr) {
      recordRow = h('div', { className: 'fs-contact__rec' },
        h('span', { className: 'fs-contact__note' }, errorCopy('mic')));
    } else {
      recordRow = h('div', { className: 'fs-contact__rec' },
        h('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm fs-contact__record', onClick: startRecording },
          h('span', { className: 'fs-contact__dot', 'aria-hidden': 'true' }), 'Record a voice note'),
        h('span', { className: 'fs-contact__hint' }, 'Up to 2 minutes. We turn it into text you can edit.'));
    }

    var status = null;
    if (recState === 'transcribing') status = h('div', { className: 'fs-contact__status', role: 'status' }, 'Transcribing…');
    else if (sttErr && draft.blob) status = h('div', { className: 'fs-contact__status', role: 'status' }, errorCopy('stt'));

    var noticeEl = null;
    if (notice && notice.kind === 'rate') {
      noticeEl = h('div', { className: 'fs-contact__notice', role: 'alert' }, errorCopy('rate', notice.retryAfterS));
    } else if (notice) {
      noticeEl = h('div', { className: 'fs-contact__notice', role: 'alert' },
        h('span', null, errorCopy('fallback')),
        h('button', { type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm', onClick: emailInstead }, 'Email us instead'));
    }

    return h(Modal, { open: true, size: 'md', title: 'Contact FieldSight', onClose: closeWindow },
      h('div', { className: 'fs-contact' },
        h('div', { className: 'fs-contact__meta' },
          h('div', null, h('span', { className: 'fs-contact__label' }, 'From: '), [name, email].filter(Boolean).join(' · ')),
          siteName ? h('div', null, h('span', { className: 'fs-contact__label' }, 'About: '), siteName) : null),
        h('textarea', {
          className: 'fs-field__control fs-contact__text',
          'aria-label': 'Your message',
          placeholder: 'What can we help with?',
          rows: 4,
          maxLength: MAX_TEXT,
          value: draft.text,
          onChange: function (e) { patchDraft({ text: e.target.value }); },
        }),
        recordRow,
        status,
        noticeEl,
        h('div', { className: 'fs-contact__actions' },
          h('button', { type: 'button', className: 'fs-btn fs-btn--ghost fs-btn--md', onClick: closeWindow }, 'Cancel'),
          h('button', {
            type: 'button', className: 'fs-btn fs-btn--primary fs-btn--md',
            disabled: !canSend({ text: draft.text, blob: draft.blob, sending: sending }) || recState !== 'idle',
            onClick: send,
          }, sending ? 'Sending…' : 'Send'))));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ContactHost = ContactHost;

  /* Node test runner only; Babel-standalone leaves `module` undefined. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      pickMime: pickMime, canSend: canSend, appendTranscript: appendTranscript,
      fallbackMailto: fallbackMailto, contextFor: contextFor, errorCopy: errorCopy,
      classifySend: classifySend, transcriptFrom: transcriptFrom, formatClock: formatClock,
      hasUnsentDraft: hasUnsentDraft,
    };
  }
})();
