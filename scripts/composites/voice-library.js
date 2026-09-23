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

  /* One sentence per person, in words somebody who has never heard of an embedding
     can act on.

     The thresholds are deliberately coarse and are NOT a quality score: what was
     measured is that coherent profiles of five-plus recordings were recognised at
     0.47-0.63 while thin or incoherent ones sat at 0.19-0.41. So "Ready" claims
     only "there is enough here to try", never "this will be right", and nothing
     here reports a confidence the system has not earned.

     `quarantined` does not lower the verdict. Samples set aside are ALREADY
     excluded from the live count, so a profile with eight good recordings and four
     set aside is exactly as ready as one with eight and none -- the note exists to
     explain why a number somebody saw yesterday went down, not to warn them. */
  function readiness(r) {
    var live = r.samples != null ? r.samples : 0;
    var aside = r.quarantined != null ? r.quarantined : 0;
    var note = aside
      ? aside + ' recording(s) did not sound like this person and are not used.'
      : null;
    if (r.status === 'withdrawn') {
      return { tone: 'off', label: 'Removed', note: null };
    }
    if (live === 0) {
      return { tone: 'off', label: 'No voice stored',
               note: aside ? note : 'Name this person in a meeting to store one.' };
    }
    if (live < 3) {
      return { tone: 'warn', label: 'Not enough yet',
               note: 'Name this person in a few more meetings.' };
    }
    return { tone: 'ok', label: 'Ready', note: note };
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
    /* Off by default: the counts are for whoever is diagnosing a profile, not for
       whoever is reading the page. */
    var refDetail = React.useState(false);
    var showDetail = refDetail[0], setShowDetail = refDetail[1];

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
      /* PLAIN BY DEFAULT, PRECISE ON DEMAND.

         This table used to show Samples / Vouched for / Set aside / Status / Last
         attempt. Those are the numbers I needed while building it; a site manager
         opening this page does not know what a sample is, has no way to act on
         "vouched for", and cannot tell whether 8 is a good number or a bad one.
         The counts were engineering telemetry shown to a customer.

         So each person gets one sentence about whether the system can recognise
         them, and what to do if it cannot. The numbers stay -- this panel is the
         whole of the feature's observability and losing them would undo that --
         but behind a toggle, where somebody looking for them will find them and
         nobody else has to read them. */
      body = React.createElement('div', { className: 'fs-voices__table-wrap' },
        React.createElement('table', { className: 'fs-voices__table' },
        React.createElement('thead', null,
          React.createElement('tr', null,
            ['Name', 'Voice recognition', ''].concat(
              showDetail ? ['Stored from', 'Not used', 'Last attempt'] : []
            ).map(function (h, i) { return React.createElement('th', { key: i }, h); }))),
        React.createElement('tbody', null,
          state.rows.map(function (r) {
            var q = readiness(r);
            /* Cells built as an ARRAY and passed as one, rather than spread as
               arguments: the detail columns are conditional, and mixing a spread
               with a conditional tail is what broke this the first time. */
            var cells = [
              React.createElement('td', { key: 'name' },
                r.displayName || '(unnamed voice)'),
              React.createElement('td', { key: 'state', className: 'fs-voices__state' },
                React.createElement('span', {
                  className: 'fs-voices__dot fs-voices__dot--' + q.tone,
                }),
                q.label,
                q.note
                  ? React.createElement('div', { className: 'fs-voices__sub' }, q.note)
                  : null),
              React.createElement('td', { key: 'act' },
                React.createElement('button', {
                  type: 'button',
                  className: 'fs-voices__delete',
                  disabled: busy === r.id || r.status === 'withdrawn',
                  onClick: function () { withdraw(r); },
                }, r.status === 'withdrawn' ? 'Removed'
                  : busy === r.id ? 'Removing…' : 'Remove')),
            ];
            if (showDetail) {
              cells.push(React.createElement('td', { key: 'd1' },
                String(r.samples != null ? r.samples : 0)));
              cells.push(React.createElement('td', { key: 'd2' },
                String(r.quarantined != null ? r.quarantined : 0)));
              cells.push(React.createElement('td', { key: 'd3',
                title: r.lastAttemptDetail || '' },
                r.lastAttemptOutcome
                  ? (r.lastAttemptOutcome + (r.lastAttemptAt
                      ? ' · ' + String(r.lastAttemptAt).slice(0, 10) : ''))
                  : '—'));
            }
            return React.createElement('tr', { key: r.id }, cells);
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
      body,

      /* The counts, one click away. Offered only when there is something to count,
         and worded as what it is rather than as a feature: somebody diagnosing a
         profile goes looking for this, and nobody else should have to decide
         whether they need it. */
      (state.status === 'ready' && state.rows.length)
        ? React.createElement('button', {
            type: 'button',
            className: 'fs-voices__detail-toggle',
            onClick: function () { setShowDetail(!showDetail); },
          }, showDetail ? 'Hide the numbers' : 'Show the numbers')
        : null);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.VoiceLibrary = VoiceLibrary;
  window.FieldSight.voiceLibraryMayManage = mayManage;
})();
