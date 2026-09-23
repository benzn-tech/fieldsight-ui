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
        setState({ status: 'ready', rows: (res && res.voiceprints) || [],
                   basis: res && res.consentBasis });
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
      /* TWO different empties, and only one of them is somebody's to fix.
         Collapsing them is the failure this whole panel exists to end: before it,
         "empty because the enrolment window was refused" and "empty because the
         embedder died" were also the same row.

         No consent basis  -> naming a speaker creates no profile AT ALL, so this
                              library stays empty for ever until somebody settles
                              one. Actionable, and nothing on screen said so.
         Basis settled     -> the ordinary new-company empty. Nobody has been
                              named yet; naming somebody will fill it. */
      body = state.basis
        ? hint('No voices stored yet. One is stored the first time somebody names a '
               + 'speaker and records that the person agreed.')
        : hint('No voices stored, and none can be: this company has not settled a '
               + 'consent basis, so naming a speaker records the name but stores no '
               + 'voice. A platform admin sets it above.');
    } else {
      /* Wrapped so the table scrolls sideways instead of overflowing its
         container. The narrow target here is real — 320x427dp — and a table
         that overflows there does it silently. */
      body = React.createElement('div', { className: 'fs-voices__table-wrap' },
        React.createElement('table', { className: 'fs-voices__table' },
        React.createElement('thead', null,
          React.createElement('tr', null,
            ['Name', 'Samples', 'Vouched for', 'Set aside', 'Status', 'Last attempt', ''].map(
              function (h, i) { return React.createElement('th', { key: i }, h); }))),
        React.createElement('tbody', null,
          state.rows.map(function (r) {
            return React.createElement('tr', { key: r.id },
              React.createElement('td', null, r.displayName || '(unnamed voice)'),
              /* Both numbers, always. A profile with zero samples names nobody,
                 and a profile made only of clustering inference stays tentative
                 — the row has to show which kind it is. */
              React.createElement('td', null, String(r.samples != null ? r.samples : 0)),
              React.createElement('td', null,
                String(r.humanSamples != null ? r.humanSamples : 0)),
              /* Why a well-stocked profile can still match badly. Measured: a profile
                 holding twelve samples, four of them a wind recording, scored 0.192
                 where its eight real ones score 0.257. Without this column that
                 profile reads as the healthiest in the company. */
              React.createElement('td', {
                title: r.quarantined
                  ? 'Samples that do not sound like the rest of this profile. They are '
                    + 'kept but do not match.' : undefined,
              }, String(r.quarantined != null ? r.quarantined : 0)),
              React.createElement('td', null, r.status || ''),
              React.createElement('td', { title: r.lastAttemptDetail || '' },
                r.lastAttemptOutcome
                  ? (r.lastAttemptOutcome + (r.lastAttemptAt
                      ? ' · ' + String(r.lastAttemptAt).slice(0, 10) : ''))
                  : '—'),
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
