/* ==========================================================================
   FieldSight · NameProposalsDialog — "is this the same person?"
   --------------------------------------------------------------------------
   After somebody names a speaker, the backend finds other passages that may be
   the same voice. This is where a person listens to them and says yes or no.

   WHAT AN ANSWER IS FOR. Every "yes" is recorded exactly as if the person had
   renamed that passage by hand, because it goes through the same endpoint. That
   matters more than the name it fixes: a company needs a number of these human
   judgements before the system is allowed to name anybody with confidence, and
   until then every automatic name shows as a guess. A "yes" is how that number
   grows. So this dialog never writes a name itself -- it asks the backend, which
   routes the answer through the rename path. One place to get that right.

   THREE WAYS OUT, AND ONLY TWO OF THEM ARE ANSWERS.
     Yes     -- it is them. Recorded, and the passage takes their name.
     No      -- it is not them. Recorded, and never asked again.
     Close   -- nothing is recorded. The passage stays on the bell for later.
   Closing is not "no". Treating it as no would silently throw away questions
   somebody simply had not got to, and those are the ones this exists to collect.

   THE VOICE IS WHAT IS BEING JUDGED, not the words. The transcriber gets names
   and half-heard phrases wrong, so the words are shown to place the passage and
   the play button is the real evidence.

   Opened by the bell (event `fs:open-name-proposals`) and by the transcript right
   after a rename, when the person already has passages waiting.

   Exposed as window.FieldSight.NameProposalsDialog (mount once, in the shell)
   ========================================================================== */

(function () {
  'use strict';

  function fmtDate(iso) {
    /* Date-only strings are NOT parsed through `new Date()` -- that reads them as
       UTC midnight and shows the previous day in New Zealand (BUG-19). */
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
    var p = iso.slice(0, 10).split('-');
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                  'Oct', 'Nov', 'Dec'];
    return Number(p[2]) + ' ' + months[Number(p[1]) - 1];
  }

  function audioKey(p) {
    /* The transcript and its audio share a stem; the audio lives under
       audio_segments/, never users/.../audio/ -- after batching, a transcript's
       timeline belongs to the batch file, and the original upload it looks like
       it came from is a different recording. */
    if (!p.userFolder || !p.date || !p.sourceFilename) return null;
    var stem = String(p.sourceFilename).replace(/\.json$/, '');
    return 'audio_segments/' + p.userFolder + '/' + p.date + '/' + stem + '.wav';
  }

  function Passage(props) {
    var h = React.createElement;
    var p = props.proposal;
    var s_state = React.useState('idle');         /* idle | loading | playing | error */
    var state = s_state[0], setState = s_state[1];
    var audioRef = React.useRef(null);

    React.useEffect(function () {
      return function () { if (audioRef.current) audioRef.current.pause(); };
    }, []);

    function play() {
      if (state === 'playing') {
        if (audioRef.current) audioRef.current.pause();
        setState('idle');
        return;
      }
      var key = audioKey(p);
      var media = ((window.FS || {}).api || {}).media;
      if (!key || !media) { setState('error'); return; }
      setState('loading');
      media.presignedUrl(key).then(function (r) {
        var url = r && (r.url || r);
        if (!url || typeof url !== 'string') { setState('error'); return; }
        var a = new Audio(url);
        audioRef.current = a;
        var start = Number(p.startSec) || 0;
        var end = Number(p.endSec) || 0;
        /* Play only this passage, not the whole file it sits in. */
        a.addEventListener('loadedmetadata', function () { a.currentTime = start; });
        a.addEventListener('timeupdate', function () {
          if (end && a.currentTime >= end) { a.pause(); setState('idle'); }
        });
        a.addEventListener('ended', function () { setState('idle'); });
        a.addEventListener('error', function () { setState('error'); });
        a.play().then(function () { setState('playing'); },
                      function () { setState('error'); });
      }, function () { setState('error'); });
    }

    var busy = props.busy;
    return h('li', { className: 'fs-npd__item' },
      h('div', { className: 'fs-npd__meta' },
        h('span', { className: 'fs-npd__date' }, fmtDate(p.date)),
        p.startSec != null && p.endSec != null
          ? h('span', { className: 'fs-npd__len' },
              Math.max(1, Math.round(Number(p.endSec) - Number(p.startSec))) + 's')
          : null),
      h('p', { className: 'fs-npd__words' },
        p.text
          ? '“' + p.text + '”'
          /* Absent is different from empty: the transcript could not be read,
             so there is nothing to show -- the voice is still there to hear. */
          : h('span', { className: 'fs-npd__nowords' }, 'No words to show — listen instead.')),
      h('div', { className: 'fs-npd__actions' },
        h('button', {
          type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm fs-npd__play',
          onClick: play, disabled: state === 'loading',
          'aria-label': state === 'playing' ? 'Stop' : 'Listen to this passage',
        }, state === 'playing' ? 'Stop'
           : state === 'loading' ? 'Loading…'
           : state === 'error' ? 'Audio unavailable' : 'Listen'),
        h('span', { className: 'fs-npd__spacer' }),
        h('button', {
          type: 'button', className: 'fs-btn fs-btn--ghost fs-btn--sm', disabled: busy,
          onClick: function () { props.onAnswer(p, 'rejected'); },
        }, 'Not them'),
        h('button', {
          type: 'button', className: 'fs-btn fs-btn--primary fs-btn--sm', disabled: busy,
          onClick: function () { props.onAnswer(p, 'confirmed'); },
        }, 'Yes, it’s them')));
  }

  function NameProposalsDialog() {
    var h = React.createElement;
    var s_open = React.useState(null);            /* {voiceprintId, displayName} */
    var target = s_open[0], setTarget = s_open[1];
    var s_items = React.useState([]);
    var items = s_items[0], setItems = s_items[1];
    var s_phase = React.useState('idle');         /* idle | loading | ready | failed */
    var phase = s_phase[0], setPhase = s_phase[1];
    var s_busy = React.useState(null);
    var busyId = s_busy[0], setBusyId = s_busy[1];
    var s_note = React.useState(null);
    var note = s_note[0], setNote = s_note[1];
    var s_done = React.useState(0);
    var answered = s_done[0], setAnswered = s_done[1];

    React.useEffect(function () {
      function onOpen(e) {
        var d = (e && e.detail) || {};
        if (!d.voiceprintId) return;
        setTarget({ voiceprintId: d.voiceprintId, displayName: d.displayName || 'this person' });
      }
      window.addEventListener('fs:open-name-proposals', onOpen);
      return function () { window.removeEventListener('fs:open-name-proposals', onOpen); };
    }, []);

    React.useEffect(function () {
      if (!target) return;
      var org = ((window.FS || {}).api || {}).org;
      if (!org || !org.getNameProposals) { setPhase('failed'); return; }
      setPhase('loading'); setItems([]); setNote(null); setAnswered(0);
      org.getNameProposals(target.voiceprintId).then(function (r) {
        setItems((r && r.proposals) || []);
        setPhase('ready');
      }, function () { setPhase('failed'); });
    }, [target && target.voiceprintId]);

    function close() {
      /* Nothing is written. Unanswered passages stay on the bell. */
      setTarget(null);
      var store = (window.FS || {}).nameProposals;
      if (store) store.refresh();
    }

    function answer(p, decision) {
      var org = ((window.FS || {}).api || {}).org;
      if (!org || !org.decideNameProposal) return;
      setBusyId(p.id); setNote(null);
      org.decideNameProposal(p.id, decision).then(function (res) {
        setBusyId(null);
        if (res && (res._accessDenied || res._notFound || res.error)) {
          /* 404 also means somebody else answered it first -- the backend only
             decides a pending row. Say so rather than pretend it worked. */
          setNote(res._notFound
            ? 'That one was already answered, possibly by a colleague.'
            : (res.error || 'That answer was not saved.'));
          setItems(function (prev) { return prev.filter(function (x) { return x.id !== p.id; }); });
          return;
        }
        setItems(function (prev) { return prev.filter(function (x) { return x.id !== p.id; }); });
        setAnswered(function (n) { return n + 1; });
      }, function () {
        setBusyId(null);
        setNote('That answer was not saved. Check your connection and try again.');
      });
    }

    var Modal = (window.FieldSight || {}).ModalOverlay;
    if (!Modal || !target) return null;

    var name = target.displayName;
    var body;
    if (phase === 'loading') {
      body = h('p', { className: 'fs-npd__state' }, 'Finding the passages…');
    } else if (phase === 'failed') {
      body = h('p', { className: 'fs-npd__state' },
        'These could not be loaded. They are still on the bell — try again in a moment.');
    } else if (!items.length) {
      body = h('p', { className: 'fs-npd__state' },
        answered
          ? 'That’s all of them for ' + name + '. Thank you.'
          : 'Nothing is waiting for ' + name + ' right now.');
    } else {
      body = h('ul', { className: 'fs-npd__list' },
        items.map(function (p) {
          return h(Passage, { key: p.id, proposal: p, busy: busyId === p.id,
                              onAnswer: answer });
        }));
    }

    return h(Modal, {
      open: true, onClose: close, size: 'md',
      title: 'Is this ' + name + '?',
      ariaLabel: 'Passages that may be ' + name,
    },
      h('div', { className: 'fs-npd' },
        items.length
          ? h('p', { className: 'fs-npd__lede' },
              'These sound like ' + name + '. Listen, then say whether it is them. '
              + 'Anything you leave will wait on the bell.')
          : null,
        body,
        note ? h('p', { className: 'fs-npd__note', role: 'status' }, note) : null,
        h('div', { className: 'fs-npd__foot' },
          h('button', { type: 'button', className: 'fs-btn fs-btn--tertiary fs-btn--md', onClick: close },
            items.length ? 'Decide later' : 'Close'))));
  }

  if (typeof window !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.NameProposalsDialog = NameProposalsDialog;
  }
  /* The key builder decides whether the passage can be heard at all, and a
     module that cannot be required has no coverage -- so it is exported. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { audioKey: audioKey, fmtDate: fmtDate };
  }

})();
