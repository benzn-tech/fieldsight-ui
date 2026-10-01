/* ==========================================================================
   FieldSight SessionNamesRegen — Layer 5 composite
   --------------------------------------------------------------------------
   "Ben Lin is named in this meeting's transcript. The summary, action items and
   draft email still use whatever names were heard out loud.  [Rewrite the summary
   with these names]"

   WHY THIS LIVES IN THE OVERVIEW. The sentence is about the summary, action items and
   draft email -- the things the Overview shows -- not about the transcript. It used to
   sit at the top of the Transcript tab, where nobody reading the summary would see it.
   Moved here 2026-10-01 (owner request). Behaviour, wording and states are exactly what
   transcript-list.js had: same API call (org.regenerateSession), same busy / done /
   message states, disabled once requested because the extraction is a paid model call.

   WHERE THE NAMES COME FROM. They are computed from the transcript's speaker segments
   (FS.speakerNaming.confirmedSessions) and there is exactly one implementation of that.
   The Transcript tab is NOT mounted while the Overview is showing, so an event from it
   could never arrive; this component therefore reads the same GET /transcripts for the
   topic's window itself and feeds it to FS.speakerNaming.regenOfferSessions. The only
   thing duplicated is one read, never the computation. When somebody names a speaker in
   the Transcript tab, transcript-list dispatches `fs:speaker-names-changed` after its
   list refreshes, and this re-reads.

   Props: { date, user, start, end }  (the same window the Transcript tab gets)

   Exported to:
     window.FieldSight.SessionNamesRegen
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function SessionNamesRegen(props) {
    var h = React.createElement;
    var date = props.date, user = props.user, start = props.start, end = props.end;

    var refSessions = React.useState([]);
    var sessions = refSessions[0], setSessions = refSessions[1];
    /* Per-session state: a day's view can hold several meetings and asking for one must
       not disable the others. */
    var refRegen = React.useState({});
    var regen = refRegen[0], setRegen = refRegen[1];
    var refTick = React.useState(0);
    var tick = refTick[0], setTick = refTick[1];

    React.useEffect(function () {
      function onChanged() { setTick(function (n) { return n + 1; }); }
      window.addEventListener('fs:speaker-names-changed', onChanged);
      return function () { window.removeEventListener('fs:speaker-names-changed', onChanged); };
    }, []);

    React.useEffect(function () {
      var fsx = window.FS || {};
      var sn = fsx.speakerNaming;
      var api = fsx.api || {};
      if (!sn || !api.transcripts || !api.org || !api.org.regenerateSession
          || !api.org.setSpeakerName) {
        setSessions([]);
        return undefined;
      }
      var cancelled = false;
      var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
      var callerFolder = caller.folder_name
        || (caller.name && api.folderName && api.folderName(caller.name)) || null;
      api.transcripts.getTranscripts({ date: date, user: user, start: start, end: end })
        .then(function (res) {
          if (cancelled) return;
          if (res && (res._accessDenied || res._notFound)) { setSessions([]); return; }
          setSessions(sn.regenOfferSessions(
            res, { role: caller.role, folder_name: callerFolder }, user));
        }, function () { if (!cancelled) setSessions([]); });
      return function () { cancelled = true; };
    }, [date, user, start, end, tick]);

    function regenerateSession(s) {
      var org = window.FS.api.org;
      if (!org || !org.regenerateSession) return;
      setRegen(function (prev) {
        var next = Object.assign({}, prev);
        next[s.sessionBase] = { state: 'busy' };
        return next;
      });
      function settle(state, message) {
        setRegen(function (prev) {
          var next = Object.assign({}, prev);
          next[s.sessionBase] = { state: state, message: message };
          return next;
        });
      }
      org.regenerateSession(s.sessionBase, { date: date, user: user })
        .then(function (res) {
          if (res && res._notAvailable) {
            settle(null, 'Rewriting is not available in this environment.');
            return;
          }
          if (res && (res._accessDenied || res._notFound)) {
            settle(null, res.error || 'You do not have permission to rewrite this summary.');
            return;
          }
          /* `namedTurns`, not the status code. Regenerating with ZERO confirmed names
             re-runs the same prompt for the same answer and costs a model call. */
          if (res && res.namedTurns === 0) {
            settle(null, 'No confirmed names reached the backend, so nothing would change. '
              + 'Nothing was rewritten.');
            return;
          }
          settle('done', 'Asked for. The summary, action items and draft email are '
            + 'rewritten in the background — usually a few minutes. Reload the report to '
            + 'see them.');
        })
        .catch(function () {
          settle(null, 'Could not ask for a rewrite.');
        });
    }

    if (!sessions.length) return null;

    return h(React.Fragment, null, sessions.map(function (s) {
      var st = regen[s.sessionBase] || {};
      return h('div', {
        key: 'regen-' + s.sessionBase,
        className: 'fs-transcript-list__regen',
      },
        h('span', null,
          s.names.join(', ')
            + (s.names.length === 1 ? ' is named' : ' are named')
            + ' in this meeting’s transcript. The summary, action items and draft email '
            + 'still use whatever names were heard out loud.'),
        h('button', {
          type: 'button',
          className: 'fs-transcript-list__regen-button',
          /* Disabled once requested, not merely after it finishes: a second click is a
             second paid model call. */
          disabled: !!st.state,
          onClick: function () { regenerateSession(s); },
          /* "Asked for", not "Done": the 202 says the request was queued, not that the
             extraction finished. */
        }, st.state === 'busy' ? 'Asking…'
          : st.state === 'done' ? 'Asked for'
          : 'Rewrite the summary with these names'),
        st.message
          ? h('span', { className: 'fs-transcript-list__name-hint' }, st.message)
          : null);
    }));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.SessionNamesRegen = SessionNamesRegen;
})();
