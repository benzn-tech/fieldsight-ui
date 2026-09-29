/* ==========================================================================
   FieldSight · IntroSuggestionDialog — "someone said their own name, is this it?"
   --------------------------------------------------------------------------
   When somebody on a recording says "Hi, this is Petros from Cassidy", the
   backend queues it as a question — there is no enrolled voice to compare it
   against yet, unlike name-proposals-dialog.js's "is this the SAME person".
   This is "is this a NAME at all, and did we hear it right".

   Reuses the audio-key rule, date formatting and "not saved" wording from
   name-proposals-dialog.js verbatim (both files are independent IIFEs in this
   no-build-step repo, so the small pure functions are duplicated rather than
   imported — keep them identical if either changes).

   THREE WAYS OUT:
     Save as <name>  -- confirmed. Queues a correction exactly like a rename
                        would (the backend's `decide_name_suggestion` delegates
                        to `speaker_corrections`), so it counts toward the
                        company's calibration the same way.
     Not a name      -- rejected. Recorded, never asked again.
     Decide later    -- nothing recorded. Stays on the bell.

   PLAIN WORDS ONLY. No scores, no "voiceprint", "embedding" or "cluster"
   anywhere in this file's rendered output — the customer rule the design doc
   states up front.

   Opened by the bell (event `fs:open-intro-suggestion`, detail: {suggestion}).
   On decide, fires `fs:name-suggestion-decided` (detail: {id}) so the bell can
   drop the row locally without re-fetching the whole list.

   Exposed as window.FieldSight.IntroSuggestionDialog (mount once, in the shell)
   ========================================================================== */

(function () {
  'use strict';

  /* ---- duplicated from name-proposals-dialog.js on purpose, see header ---- */

  function fmtDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
    var p = iso.slice(0, 10).split('-');
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                  'Oct', 'Nov', 'Dec'];
    return Number(p[2]) + ' ' + months[Number(p[1]) - 1];
  }

  function notSavedNote(err) {
    var status = err && err.status;
    if (status && status >= 400 && status < 500) {
      return 'That answer was not saved' + (err.message ? ': ' + err.message : '.')
        + ' It is still waiting on the bell.';
    }
    return 'That answer was not saved. Check your connection and try again.';
  }

  function audioKey(p) {
    if (!p.userFolder || !p.date || !p.sourceFilename) return null;
    var stem = String(p.sourceFilename).replace(/\.json$/, '');
    return 'audio_segments/' + p.userFolder + '/' + p.date + '/' + stem + '.wav';
  }

  /* ---- new pure helpers: who does this sound like on the roster? ---- */

  function _norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  /* Classic edit distance. Small inputs only (a person's name), so the
     straightforward O(n*m) table is plenty. */
  function _editDistance(a, b) {
    a = a || ''; b = b || '';
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var row = [];
    for (var j = 0; j <= n; j++) row[j] = j;
    for (var i = 1; i <= m; i++) {
      var prev = row[0];
      row[0] = i;
      for (j = 1; j <= n; j++) {
        var tmp = row[j];
        row[j] = a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, row[j], row[j - 1]);
        prev = tmp;
      }
    }
    return row[n];
  }

  /* The closest existing roster name to what the transcriber heard, or null if
     nothing is close. Three passes, cheapest first, matching the plan's rule
     ("case-insensitive exact, prefix, or edit distance <= 2 on the full name"):

       1. exact, case-insensitive, on the member's full name
       2. prefix either direction — this is what makes "Petros" (first name
          only, which is what a self-introduction usually gives) match a
          roster entry of "Petros Pan"
       3. edit distance <= 2 on the full name — catches what the transcriber
          mis-heard ("Petrus" -> "Petros Pan")

     A stub-able pure function: no fetch, no React, so it is fully covered by
     `node --test` without a DOM. */
  function closestRosterName(members, heardName) {
    var target = _norm(heardName);
    if (!target) return null;
    var names = (members || [])
      .map(function (m) { return m && m.name; })
      .filter(Boolean);
    var i, n;
    for (i = 0; i < names.length; i++) {
      if (_norm(names[i]) === target) return names[i];
    }
    for (i = 0; i < names.length; i++) {
      n = _norm(names[i]);
      if (n.indexOf(target) === 0 || target.indexOf(n) === 0) return names[i];
    }
    var best = null, bestDist = 3;   /* strictly better than the <=2 threshold */
    for (i = 0; i < names.length; i++) {
      n = _norm(names[i]);
      var d = _editDistance(target, n);
      if (d <= 2 && d < bestDist) { bestDist = d; best = names[i]; }
    }
    return best;
  }

  /* "heard as: <heardName>" only earns its place under the field when the
     name being offered actually differs from what was heard — showing it
     when they match would just repeat the input box back at the reader. */
  function shouldShowHeardAs(chosenName, heardName) {
    var a = _norm(chosenName), b = _norm(heardName);
    return !!a && !!b && a !== b;
  }

  function IntroSuggestionDialog() {
    var h = React.createElement;
    var s_sug = React.useState(null);
    var suggestion = s_sug[0], setSuggestion = s_sug[1];
    var s_name = React.useState('');
    var name = s_name[0], setName = s_name[1];
    var s_members = React.useState([]);
    var members = s_members[0], setMembers = s_members[1];
    var s_busy = React.useState(null);          /* null | 'confirmed' | 'rejected' */
    var busy = s_busy[0], setBusy = s_busy[1];
    var s_note = React.useState(null);
    var note = s_note[0], setNote = s_note[1];
    var s_saved = React.useState(null);         /* null | {message} after a confirm */
    var saved = s_saved[0], setSaved = s_saved[1];
    var s_audio = React.useState('idle');       /* idle | loading | playing | error */
    var audioState = s_audio[0], setAudioState = s_audio[1];
    var audioRef = React.useRef(null);
    var enrolWatchRef = React.useRef(0);

    React.useEffect(function () {
      return function () {
        enrolWatchRef.current = -1;
        if (audioRef.current) audioRef.current.pause();
      };
    }, []);

    React.useEffect(function () {
      function onOpen(e) {
        var d = (e && e.detail) || {};
        if (!d.suggestion || !d.suggestion.id) return;
        setSuggestion(d.suggestion);
        setName(d.suggestion.heardName || '');
        setMembers([]);
        setBusy(null); setNote(null); setSaved(null); setAudioState('idle');
        var org = ((window.FS || {}).api || {}).org;
        if (org && org.getMembers) {
          org.getMembers().then(function (r) {
            var roster = (r && r.members) || [];
            setMembers(roster);
            var guess = closestRosterName(roster, d.suggestion.heardName);
            if (guess) setName(guess);
          }, function () { /* no roster is not fatal — the field just starts as heard */ });
        }
      }
      window.addEventListener('fs:open-intro-suggestion', onOpen);
      return function () { window.removeEventListener('fs:open-intro-suggestion', onOpen); };
    }, []);

    function close() {
      setSuggestion(null);
    }

    function play() {
      if (!suggestion) return;
      if (audioState === 'playing') {
        if (audioRef.current) audioRef.current.pause();
        setAudioState('idle');
        return;
      }
      var key = audioKey(suggestion);
      var media = ((window.FS || {}).api || {}).media;
      if (!key || !media) { setAudioState('error'); return; }
      setAudioState('loading');
      media.presignedUrl(key).then(function (r) {
        var url = r && (r.url || r);
        if (!url || typeof url !== 'string') { setAudioState('error'); return; }
        var a = new Audio(url);
        audioRef.current = a;
        var start = Number(suggestion.startSec) || 0;
        var end = Number(suggestion.endSec) || 0;
        a.addEventListener('loadedmetadata', function () { a.currentTime = start; });
        a.addEventListener('timeupdate', function () {
          if (end && a.currentTime >= end) { a.pause(); setAudioState('idle'); }
        });
        a.addEventListener('ended', function () { setAudioState('idle'); });
        a.addEventListener('error', function () { setAudioState('error'); });
        a.play().then(function () { setAudioState('playing'); },
                      function () { setAudioState('error'); });
      }, function () { setAudioState('error'); });
    }

    /* Same shape as transcript-list.js's watchEnrolment: the embedder takes about
       a minute to answer, and until it does the honest thing to say is that
       saving is in progress, not that it succeeded. */
    function watchEnrolment(who, sinceMs) {
      var org = ((window.FS || {}).api || {}).org;
      var sn = window.FS && window.FS.speakerNaming;
      if (!org || !org.getVoiceprints || !sn || enrolWatchRef.current < 0) return;
      var token = enrolWatchRef.current + 1;
      enrolWatchRef.current = token;
      var tries = 0, POLL_MS = 10000, MAX_TRIES = 18;   /* ~3 minutes */
      function tick() {
        if (enrolWatchRef.current !== token) return;
        tries += 1;
        org.getVoiceprints().then(function (r) {
          if (enrolWatchRef.current !== token) return;
          var out = sn.enrolmentOutcome(r && r.voiceprints, who, sinceMs);
          if (out) { setSaved({ message: out.message }); return; }
          if (tries < MAX_TRIES) setTimeout(tick, POLL_MS);
        }, function () {
          if (tries < MAX_TRIES) setTimeout(tick, POLL_MS);
        });
      }
      setTimeout(tick, POLL_MS);
    }

    function decide(decision) {
      if (!suggestion) return;
      var org = ((window.FS || {}).api || {}).org;
      if (!org || !org.decideNameSuggestion) return;
      var chosen = String(name || '').trim();
      setBusy(decision); setNote(null);
      var savedAt = Date.now();
      org.decideNameSuggestion(suggestion.id, decision, chosen).then(function (res) {
        setBusy(null);
        if (res && (res._accessDenied || res._notFound || res.error)) {
          setNote(res._notFound
            ? 'That one was already answered, possibly by a colleague.'
            : (res.error || 'That answer was not saved.'));
          return;
        }
        window.dispatchEvent(new CustomEvent('fs:name-suggestion-decided',
          { detail: { id: suggestion.id } }));
        var store = (window.FS || {}).nameProposals;
        if (store) store.refresh();
        if (decision === 'rejected') { close(); return; }
        /* Confirmed: the backend's own `enrolment` field says whether an
           embedder run was queued, exactly like a rename does. */
        var requested = !!(res && res.enrolment === 'requested');
        setSaved({ message: requested
          ? 'Saving ' + (chosen || suggestion.heardName) + '’s voice — this takes about a minute.'
          : 'Saved.' });
        if (requested) watchEnrolment(chosen || suggestion.heardName, savedAt);
      }, function (err) {
        setBusy(null);
        setNote(notSavedNote(err));
      });
    }

    var Modal = (window.FieldSight || {}).ModalOverlay;
    if (!Modal || !suggestion) return null;

    var heard = suggestion.heardName || 'Someone';
    var trimmedName = String(name || '').trim();

    return h(Modal, {
      open: true, onClose: close, size: 'sm',
      title: 'Save this voice?',
      ariaLabel: 'Confirm the name for a self-introduction',
    },
      h('div', { className: 'fs-isd' },
        h('p', { className: 'fs-isd__lede' },
          'Someone introduced themselves as ', h('b', null, heard),
          suggestion.companyName ? ', from ' + suggestion.companyName : '', '.'),

        note ? h('p', { className: 'fs-isd__note', role: 'status' }, note) : null,

        saved
          ? h('p', { className: 'fs-isd__saved', role: 'status' }, saved.message)
          : h('div', null,
              h('div', { className: 'fs-isd__meta' },
                h('span', { className: 'fs-isd__date' }, fmtDate(suggestion.date)),
                suggestion.startSec != null && suggestion.endSec != null
                  ? h('span', { className: 'fs-isd__len' },
                      Math.max(1, Math.round(Number(suggestion.endSec)
                        - Number(suggestion.startSec))) + 's')
                  : null),
              h('p', { className: 'fs-isd__quote' },
                suggestion.quote
                  ? '“' + suggestion.quote + '”'
                  : h('span', { className: 'fs-isd__nowords' },
                      'No words to show — listen instead.')),
              h('button', {
                type: 'button', className: 'fs-btn fs-btn--secondary fs-btn--sm fs-isd__play',
                onClick: play, disabled: audioState === 'loading',
                'aria-label': audioState === 'playing' ? 'Stop' : 'Listen to this passage',
              }, audioState === 'playing' ? 'Stop'
                 : audioState === 'loading' ? 'Loading…'
                 : audioState === 'error' ? 'Audio unavailable' : 'Listen'),

              h('label', { className: 'fs-isd__label', htmlFor: 'fs-isd-name' }, 'Name'),
              h('input', {
                id: 'fs-isd-name', type: 'text', className: 'fs-input fs-isd__input',
                value: name, onChange: function (e) { setName(e.target.value); },
                disabled: !!busy,
              }),
              shouldShowHeardAs(trimmedName, suggestion.heardName)
                ? h('p', { className: 'fs-isd__heard' }, 'heard as: ' + suggestion.heardName)
                : null,

              h('div', { className: 'fs-isd__actions' },
                h('button', {
                  type: 'button', className: 'fs-btn fs-btn--ghost fs-btn--sm',
                  disabled: !!busy, onClick: function () { decide('rejected'); },
                }, busy === 'rejected' ? 'Saving…' : 'Not a name'),
                h('button', {
                  type: 'button', className: 'fs-btn fs-btn--primary fs-btn--sm',
                  disabled: !!busy || !trimmedName,
                  onClick: function () { decide('confirmed'); },
                }, busy === 'confirmed' ? 'Saving…' : 'Save as ' + (trimmedName || heard)))),

        h('div', { className: 'fs-isd__foot' },
          h('button', {
            type: 'button', className: 'fs-btn fs-btn--tertiary fs-btn--md', onClick: close,
          }, saved ? 'Close' : 'Decide later'))));
  }

  if (typeof window !== 'undefined') {
    if (!window.FieldSight) window.FieldSight = {};
    window.FieldSight.IntroSuggestionDialog = IntroSuggestionDialog;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      audioKey: audioKey, fmtDate: fmtDate, notSavedNote: notSavedNote,
      closestRosterName: closestRosterName, shouldShowHeardAs: shouldShowHeardAs,
    };
  }

})();
