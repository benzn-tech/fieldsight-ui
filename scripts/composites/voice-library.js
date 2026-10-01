/* ==========================================================================
   FieldSight VoiceLibrary — Layer 5 composite
   --------------------------------------------------------------------------
   The company's stored voice patterns: who is enrolled, how much evidence each
   profile stands on, and a way to delete one.

   Backend (fieldsight-pipeline lambda_org_api.py), all three of which had NO
   caller anywhere until 2026-09-22:
     GET    /api/org/voiceprints              _CORRECTION_ROLES
     DELETE /api/org/voiceprints/{id}         _CORRECTION_ROLES
     PUT    /api/org/company/voiceprint-basis platform_admin ONLY

   Until this existed the only way to look at this data was a database session,
   and "empty because the enrolment window was refused" and "empty because the
   embedder died" produced exactly the same row. Both happened on TEST on one
   day and were indistinguishable. This panel is the whole of the feature's
   observability, not a convenience.

   It lives beside Evidence rather than in Settings because it answers a
   question about the RECORDINGS — who the system thinks it can recognise —
   which is the same question the Transcripts tab raises two tabs away.

   Exported to:
     window.FieldSight.VoiceLibrary
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* The backend's own vocabulary for why a company may hold voice patterns at
     all. Free text is not accepted: the column has a CHECK and an unrecognised
     value is a 400. Descriptions rather than bare slugs, because "notice" and
     "attestation" are legal distinctions nobody reading a dropdown would guess. */
  var BASIS_OPTS = [
    { v: '', l: 'Not settled — enrolment falls back to the strict rule' },
    { v: 'notice', l: 'Notice — the site induction tells workers their voice is captured' },
    { v: 'attestation', l: 'Attestation — whoever names a speaker states that person agreed' },
    { v: 'confirmed', l: 'Confirmed — the person themselves has agreed, on record' },
  ];

  /* The same role list the naming control uses, read from the one module that
     owns it. A second hard-coded list is the failure that already happened
     here: the UI never sees the org role `pm` (session-bridge renames it to
     `project_manager`), so a list written from the backend's spelling alone
     silently denied every pm account. */
  function mayManage(user) {
    var sn = window.FS && window.FS.speakerNaming;
    return !!(sn && sn.roleMayName((user || {}).role));
  }

  function VoiceLibrary() {
    var org = window.FS && window.FS.api && window.FS.api.org;
    var user = (window.AuthMock && window.AuthMock.currentUser) || {};

    var refRows = React.useState({ status: 'loading', rows: [] });
    var state = refRows[0], setState = refRows[1];
    var refBusy = React.useState(null);
    var busy = refBusy[0], setBusy = refBusy[1];
    var refNote = React.useState(null);
    var note = refNote[0], setNote = refNote[1];
    /* Per-row result of "Try again": { phase: 'saving' | 'saved' | 'failed', message }.
       Keyed on the profile so two rows can be retried independently. */
    var refRetry = React.useState({});
    var retrying = refRetry[0], setRetrying = refRetry[1];
    var watchRef = React.useRef(0);
    React.useEffect(function () {
      return function () { watchRef.current = -1; };    /* leaving the page stops every poll */
    }, []);
    var refTick = React.useState(0);
    var tick = refTick[0], setTick = refTick[1];

    React.useEffect(function () {
      if (!mayManage(user) || !org || !org.getVoiceprints) {
        setState({ status: 'unavailable', rows: [] });
        return undefined;
      }
      var cancelled = false;
      org.getVoiceprints().then(function (res) {
        if (cancelled) return;
        /* 404 is SPEAKER_IDENTITY_MODE=off — "not enabled in this environment",
           not a fault. 403 is the role. Collapsing either into an empty list
           would say this company has enrolled nobody, a different claim. */
        if (res && res._notFound) { setState({ status: 'disabled', rows: [] }); return; }
        if (res && res._accessDenied) { setState({ status: 'denied', rows: [] }); return; }
        setState({ status: 'ready', rows: (res && res.voiceprints) || [] });
      }).catch(function () {
        if (!cancelled) setState({ status: 'error', rows: [] });
      });
      return function () { cancelled = true; };
    }, [tick]);

    function withdraw(row) {
      var label = row.displayName || 'this unnamed voice';
      /* Says what it destroys AND what it leaves. Removing a name from one
         meeting is a different control in a different place, and neither is
         reversible — so the two must not read alike. */
      var msg = 'Delete the stored voice pattern for ' + label + '.\n\n'
        + 'Every passage this profile named will lose that name, in every meeting. '
        + 'The audit record of the profile survives; the voice data does not. '
        + 'This cannot be undone.';
      if (typeof window.confirm === 'function' && !window.confirm(msg)) return;
      setBusy(row.id);
      setNote(null);
      org.withdrawVoiceprint(row.id).then(function (res) {
        setBusy(null);
        if (res && res._notAvailable) { setNote('Not available in this environment.'); return; }
        if (res && (res._accessDenied || res._notFound)) {
          setNote(res.error || 'You do not have permission to do that.');
          return;
        }
        setNote('Deleted ' + label + ' — '
          + (res && res.samplesRemoved != null ? res.samplesRemoved : 0) + ' sample(s) removed.');
        setTick(function (n) { return n + 1; });
      }).catch(function () {
        setBusy(null);
        setNote('Could not delete that profile.');
      });
    }

    function setRowRetry(id, value) {
      setRetrying(function (prev) {
        var next = Object.assign({}, prev); next[id] = value; return next;
      });
    }

    /* Try again: ask the backend to store the voice from the passage it remembered, then
       poll the library for the answer exactly as a rename does (transcript-list's
       watchEnrolment). The 202 only says it was queued -- the result arrives on the
       profile about a minute later and may be another refusal, so the row says "Saving"
       until it can say saved or not saved, and why. Never silent either way. */
    function tryAgain(row) {
      var sn = window.FS.speakerNaming;
      var who = row.displayName || 'this voice';
      var sinceMs = Date.now();
      setRowRetry(row.id, { phase: 'saving',
        message: 'Saving ' + who + '’s voice — this takes about a minute.' });
      org.retryVoiceprint(row.id).then(function (res) {
        if (res && res._notAvailable) {
          setRowRetry(row.id, { phase: 'failed', message: 'Not available in this environment.' });
          return;
        }
        if (res && (res._accessDenied || res._notFound)) {
          setRowRetry(row.id, { phase: 'failed',
            message: res.error || 'There is nothing to try again for this voice.' });
          return;
        }
        var token = watchRef.current + 1;
        if (watchRef.current < 0) return;
        watchRef.current = token;
        var tries = 0, POLL_MS = 10000, MAX_TRIES = 18;     /* ~3 minutes */
        function giveUp() {
          setRowRetry(row.id, { phase: 'failed',
            message: who + '’s voice has not been saved yet. Check again in a few minutes, '
              + 'or ' + sn.retryGuidance(who).charAt(0).toLowerCase()
              + sn.retryGuidance(who).slice(1) });
        }
        function tick() {
          if (watchRef.current !== token) return;
          tries += 1;
          org.getVoiceprints().then(function (r) {
            if (watchRef.current !== token) return;
            var out = sn.enrolmentOutcome(r && r.voiceprints, who, sinceMs);
            if (out) {
              setRowRetry(row.id, { phase: out.state === 'stored' ? 'saved' : 'failed',
                message: out.message });
              setTick(function (n) { return n + 1; });
              return;
            }
            if (tries < MAX_TRIES) setTimeout(tick, POLL_MS); else giveUp();
          }, function () {
            if (tries < MAX_TRIES) setTimeout(tick, POLL_MS); else giveUp();
          });
        }
        setTimeout(tick, POLL_MS);
      }).catch(function (err) {
        setRowRetry(row.id, { phase: 'failed',
          message: (err && err.status === 409)
            ? 'There is nothing to try again for ' + who + '. '
              + window.FS.speakerNaming.retryGuidance(who)
            : 'Could not try again. Check your connection and press Try again.' });
      });
    }

    function openRecording(route) {
      var router = window.FS && window.FS.Router;
      if (router && route) router.navigate(route);
    }

    function saveBasis(value) {
      setNote(null);
      org.setVoiceprintBasis(value || null).then(function (res) {
        if (res && res._notAvailable) { setNote('Not available in this environment.'); return; }
        if (res && (res._accessDenied || res._notFound)) {
          setNote(res.error || 'Only a platform admin can set the consent basis.');
          return;
        }
        setNote('Consent basis saved.');
      }).catch(function () { setNote('Could not save the consent basis.'); });
    }

    /* Visible, not a tooltip: why the voice was not saved, what to do, and the two ways to
       do it. A saved voice returns null here and shows nothing extra. After "Try again"
       the row's own progress / result replaces the buttons while it is working. */
    function retryBlock(r) {
      var sn = window.FS.speakerNaming;
      var st = retrying[r.id];
      var act = sn.voiceRetryActions(r);
      if (!act && !(st && st.phase === 'saved')) return null;
      var kids = [];
      if (st) {
        kids.push(React.createElement('div', {
          key: 'st', role: 'status',
          className: 'fs-voices__result fs-voices__result--' + st.phase,
        }, st.message));
      }
      if (act && (!st || st.phase === 'failed')) {
        if (!st) {
          kids.push(React.createElement('div', { key: 'why', className: 'fs-voices__reason' },
            act.reason));
        }
        kids.push(React.createElement('div', { key: 'how', className: 'fs-voices__reason' },
          act.guidance));
        kids.push(React.createElement('div', { key: 'btns', className: 'fs-voices__retry-actions' },
          act.canRetry ? React.createElement('button', {
            type: 'button', className: 'fs-voices__retry',
            onClick: function () { tryAgain(r); },
          }, act.tryAgainLabel) : null,
          act.openRoute ? React.createElement('button', {
            type: 'button', className: 'fs-voices__retry',
            onClick: function () { openRecording(act.openRoute); },
          }, act.openLabel) : null));
      }
      return React.createElement('div', { className: 'fs-voices__retry-block' }, kids);
    }

    function hint(text) {
      return React.createElement('div', { className: 'fs-voices__hint' }, text);
    }

    var body;
    if (!mayManage(user)) {
      body = hint('You do not have permission to view this company’s voice library.');
    } else if (state.status === 'loading') {
      body = hint('Loading…');
    } else if (state.status === 'disabled') {
      body = hint('Voice recognition is not enabled in this environment.');
    } else if (state.status === 'denied') {
      body = hint('You do not have permission to view this company’s voice library.');
    } else if (state.status === 'unavailable' || state.status === 'error') {
      body = hint('Could not read the voice library.');
    } else if (!state.rows.length) {
      /* Empty is the expected state on every company today, and saying WHY
         stops it reading as a fault: no company has settled a consent basis,
         so the strict rule applies and nothing enrols. */
      body = hint('No voices stored. A voice is only stored when somebody names a speaker '
        + 'AND records that the person agreed.');
    } else {
      /* Wrapped so the table scrolls sideways instead of overflowing its
         container. The narrow target here is real — 320x427dp — and a table
         that overflows there does it silently. */
      body = React.createElement('div', { className: 'fs-voices__table-wrap' },
        React.createElement('table', { className: 'fs-voices__table' },
        React.createElement('thead', null,
          React.createElement('tr', null,
            ['Name', 'Learned from', 'Status', 'Latest', ''].map(
              function (h, i) { return React.createElement('th', { key: i }, h); }))),
        React.createElement('tbody', null,
          state.rows.map(function (r) {
            var w = window.FS.speakerNaming.voiceRowWords(r);
            return React.createElement('tr', { key: r.id },
              React.createElement('td', null, r.displayName || '(unnamed voice)'),
              /* Plain words, not the database's vocabulary -- see voiceRowWords. A
                 profile with no voice saved still shows, and says so, because it names
                 nobody; and "named by someone" keeps a person's assertion visible beside
                 what the clustering inferred. */
              React.createElement('td', null, w.learned),
              React.createElement('td', null, w.status),
              React.createElement('td', { title: w.latestTitle },
                w.latest,
                retryBlock(r)),
              React.createElement('td', null,
                React.createElement('button', {
                  type: 'button',
                  className: 'fs-voices__delete',
                  disabled: busy === r.id || r.status === 'withdrawn',
                  onClick: function () { withdraw(r); },
                }, r.status === 'withdrawn' ? 'Deleted'
                  : busy === r.id ? 'Deleting…' : 'Delete')));
          }))));
    }

    return React.createElement('div', { className: 'fs-voices' },
      React.createElement('div', { className: 'fs-voices__hint' },
        'A voice pattern is biometric data. It is stored only so a person can be '
        + 'recognised in later meetings, and only the person recorded can agree to that — '
        + 'not their employer, and not whoever names them.'),

      /* platform_admin only, matching the server, which answers 403 for anyone
         else. Offered to nobody else rather than offered-and-refused. */
      (mayManage(user) && user.role === 'platform_admin')
        ? React.createElement('div', { className: 'fs-voices__basis' },
            React.createElement('label', null, 'Consent basis'),
            React.createElement('select', {
              className: 'fs-voices__select',
              defaultValue: '',
              onChange: function (e) { saveBasis(e.target.value); },
            }, BASIS_OPTS.map(function (o) {
              return React.createElement('option', { key: o.v, value: o.v }, o.l);
            })))
        : null,

      note ? React.createElement('div', { className: 'fs-voices__hint' }, note) : null,
      body);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.VoiceLibrary = VoiceLibrary;
  window.FieldSight.voiceLibraryMayManage = mayManage;
})();
