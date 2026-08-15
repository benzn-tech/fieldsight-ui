/* ==========================================================================
   FieldSight TranscriptList — Layer 5 composite
   --------------------------------------------------------------------------
   Renders speaker_segments from /api/transcripts (BACKEND-CONTEXT §4.5).

   Critical bug-trap (BACKEND-CONTEXT §8.6 / BUG 8.6):
     spk_0, spk_1 from Transcribe diarization are NOT stable across
     recording files. The same person may be spk_0 in one file and spk_2
     in another. We therefore colour speakers by POSITION WITHIN THE
     CURRENT VIEW — first unique label gets palette[0], next gets
     palette[1], etc. — and never persist a speaker→colour mapping
     globally.

   When the report supplies `participants`, we additionally attach human
   names to the first N labels seen (best-effort hint, NOT authoritative).

   Props:
     date          'YYYY-MM-DD'
     user          folder-name string (Jarley_Trainor)
     start         HH:MM[:SS] window start
     end           HH:MM[:SS] window end
     participants  string[] (optional) — names to overlay onto labels
     onJump        (segment) => void  — caller wires this to audio/video
                   playback if present
     highlightTime "HH:MM:SS" string or null — A2-2 Ask citation
                   transcript-line deep link (timeline.js passes
                   selectedItem.turnTime, itself sourced from the
                   citation's backend time_start, see ask-chat.js).
                   Same precision-spotlight shape as SafetyFlagRow's
                   `highlight` prop (safety-flag-row.js): scrolls the
                   matched segment into view and runs a 3-pulse flash
                   (.fs-transcript-list__row--flash). Segment match is
                   nearest-at-or-before (see findHighlightIndex below) —
                   the window start doesn't always land exactly on a
                   segment boundary.

   Speaker naming (spec docs/specs/2026-08-14-speaker-naming-ui.md)
     A named passage carries `speaker_name` + `speaker_state`, laid over the
     response at read time (names are NOT baked into the transcript), and the
     payload carries `unmatchedNames`. The rules live in
     scripts/api/speaker-naming.js so this render and its tests read the same
     ones. Two decisions the spec makes explicitly, both load-bearing here:

       • `speaker_name` WINS over participantHint. The hint is a positional
         guess; the name is something a person asserted. If the guess won, a
         real correction would be invisible.
       • The chip is already the click-to-jump gesture and naming must not
         steal it, so naming lives behind a separate caret button.

     The colour stays keyed on `s.speaker` (the diarisation label) — naming
     someone must not reshuffle every colour in the view.

   Exported to:
     window.FieldSight.TranscriptList
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* Five-colour palette mapped by FIRST-APPEARANCE order in the current
     view. Six is enough for any single topic — diarization won't reach
     more in practice. */
  var SPEAKER_PALETTE = [
    { fg: '#1E40AF', bg: '#DBEAFE' }, /* info */
    { fg: '#15803D', bg: '#DCFCE7' }, /* success */
    { fg: '#B45309', bg: '#FEF3C7' }, /* warning */
    { fg: '#9A2A13', bg: '#FFE6D5' }, /* accent */
    { fg: '#6B21A8', bg: '#EDE9FE' }, /* purple */
    { fg: '#0F766E', bg: '#CCFBF1' }, /* teal */
  ];

  /* A2-2 — "HH:MM:SS" → seconds-since-midnight, same space as segment
     .start/.end (BACKEND-CONTEXT transcript shape). Returns null when
     unparseable so callers can no-op cleanly. */
  function hmsToSeconds(hms) {
    var m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(hms || '').trim());
    if (!m) return null;
    return (parseInt(m[1], 10) * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10);
  }

  /* A2-2 — matching rule (robust to the window-start not landing exactly
     on a segment boundary):
       1. the segment whose [start, end] CONTAINS targetSec, else
       2. the LAST segment whose start <= targetSec (nearest at-or-before), else
       3. the FIRST segment (fallback).
     Assumes segments are chronologically ordered (as returned by the API). */
  function findHighlightIndex(segments, targetSec) {
    if (targetSec == null || !segments || !segments.length) return null;
    var lastAtOrBefore = null;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (typeof s.start !== 'number') continue;
      var end = typeof s.end === 'number' ? s.end : s.start;
      if (targetSec >= s.start && targetSec <= end) return i;
      if (s.start <= targetSec) lastAtOrBefore = i;
    }
    return lastAtOrBefore !== null ? lastAtOrBefore : 0;
  }

  var SOURCE_LABEL = {
    used:      'already used here',
    wearer:    'wearing the recorder',
    mentioned: 'named in this transcript',
    /* "heard", not "participant". These come from the extraction's own
       participant list, which is what the MODEL heard — a misheard or invented
       name is one click away here, where before it needed typing. Saying where
       it came from is what keeps the click honest. `mentioned` above does not
       need the same hedge: those are roster names, so the person exists. */
    heard:     'heard in this conversation',
    team:      '',
  };

  /* The naming form. Choices, not a text box: the same person typed two ways is
     two people to the propagation layer, and the second spelling silently names
     nothing. Mounted only while its row's panel is open, so it remounts fresh.

     NOTHING is pre-selected unless this turn already carries a name. Picking is
     always a deliberate act — see the note on `heard` above. */
  function NamePanel(props) {
    var current = props.segment.speaker_name || '';
    var refChoice = React.useState(current || null);
    var choice    = refChoice[0];
    var setChoice = refChoice[1];
    var refCustom = React.useState('');
    var custom    = refCustom[0];
    var setCustom = refCustom[1];
    /* A separate flag rather than a sentinel value in `choice`. A sentinel has
       to be a string that no real name can equal, and every such string is a
       guess about what people are called. */
    var refMode = React.useState(false);
    var customMode    = refMode[0];
    var setCustomMode = refMode[1];
    var inputRef = React.useRef(null);

    function pick(name) { setChoice(name); setCustomMode(false); }
    function pickCustom() { setChoice(null); setCustomMode(true); }

    React.useEffect(function () {
      if (customMode && inputRef.current && inputRef.current.focus) {
        inputRef.current.focus();
      }
    }, [customMode]);

    var all = props.candidates || [];
    /* The roster tail is the long list, not a suggestion. Keeping it collapsed
       is what stops the panel from becoming a company directory the user has
       to read past to reach the four names that actually apply here. */
    var primary = all.filter(function (c) { return c.source !== 'team'; });
    var tail    = all.filter(function (c) { return c.source === 'team'; });
    var refAll = React.useState(false);
    var showAll    = refAll[0];
    var setShowAll = refAll[1];
    var candidates = showAll ? primary.concat(tail) : primary;

    function save() {
      props.onSave(customMode ? custom : (choice || ''));
    }

    var canSave = customMode ? !!String(custom).trim() : !!choice;

    return React.createElement('div', {
      className: 'fs-transcript-list__name-panel',
      role: 'group',
      'aria-label': 'Who is speaking',
      onKeyDown: function (e) {
        if (e.key === 'Escape') { e.preventDefault(); props.onCancel(); }
      },
    },
      React.createElement('div', { className: 'fs-transcript-list__name-title' },
        'Who is speaking?'),

      React.createElement('div', { className: 'fs-transcript-list__name-choices' },
        candidates.map(function (c) {
          return React.createElement('label', {
            key: c.name,
            className: 'fs-transcript-list__name-choice'
              + (!customMode && choice === c.name
                   ? ' fs-transcript-list__name-choice--on' : ''),
          },
            React.createElement('input', {
              type: 'radio', name: 'fs-spk-choice',
              checked: !customMode && choice === c.name,
              onChange: function () { pick(c.name); },
            }),
            React.createElement('span', {
              className: 'fs-transcript-list__name-choice-name',
            }, c.name),
            React.createElement('span', {
              className: 'fs-transcript-list__name-choice-src',
            }, SOURCE_LABEL[c.source] || ''),
          );
        }),

        React.createElement('label', {
          className: 'fs-transcript-list__name-choice'
            + (customMode ? ' fs-transcript-list__name-choice--on' : ''),
        },
          React.createElement('input', {
            type: 'radio', name: 'fs-spk-choice',
            checked: customMode,
            onChange: pickCustom,
          }),
          React.createElement('span', {
            className: 'fs-transcript-list__name-choice-name',
          }, candidates.length ? 'Someone else…' : 'Type a name…'),
        ),

        (!showAll && tail.length)
          ? React.createElement('button', {
              type: 'button',
              className: 'fs-transcript-list__name-more',
              onClick: function () { setShowAll(true); },
            }, 'Show ' + tail.length + ' more from your team')
          : null,
      ),

      /* Only rendered when a caller actually wires onJump. No mount does today
         — this keeps the prop's contract without giving the chip a second,
         invisible meaning. */
      props.onJump
        ? React.createElement('button', {
            type: 'button',
            className: 'fs-transcript-list__name-jump',
            onClick: props.onJump,
          }, 'Jump to ' + props.segment.time_label)
        : null,

      customMode
        ? React.createElement('input', {
            ref: inputRef,
            type: 'text',
            className: 'fs-transcript-list__name-input',
            value: custom,
            placeholder: 'Their name',
            'aria-label': 'Name for this passage',
            onChange: function (e) { setCustom(e.target.value); },
            onKeyDown: function (e) {
              if (e.key === 'Enter' && canSave) { e.preventDefault(); save(); }
            },
          })
        : null,

      React.createElement('div', { className: 'fs-transcript-list__name-actions' },
        React.createElement('button', {
          type: 'button',
          className: 'fs-transcript-list__name-save',
          disabled: !canSave,
          onClick: save,
        }, 'Save'),
        props.onRemove
          ? React.createElement('button', {
              type: 'button',
              className: 'fs-transcript-list__name-remove',
              onClick: props.onRemove,
            }, 'Remove this name')
          : null,
        React.createElement('button', {
          type: 'button',
          className: 'fs-transcript-list__name-cancel',
          onClick: props.onCancel,
        }, 'Cancel'),
      ),

      /* Naming propagates within THIS meeting only. Future meetings are
         backend Phase 5 and are not built — do not imply it in copy. */
      React.createElement('span', { className: 'fs-transcript-list__name-hint' },
        'Applies to this meeting.'),
    );
  }

  function TranscriptList(props) {
    var refState = React.useState({ status: 'loading', segments: [] });
    var state    = refState[0];
    var setState = refState[1];

    var date  = props.date;
    var user  = props.user;
    var start = props.start;
    var end   = props.end;

    /* Bumped after a naming write to re-fetch: the POST returns 202 (queued),
       clustering runs outside the VPC and there is no push. */
    var refReload = React.useState(0);
    var reloadTick    = refReload[0];
    var setReloadTick = refReload[1];

    /* index of the row whose naming panel is open, or null. */
    var refOpen = React.useState(null);
    var openIndex    = refOpen[0];
    var setOpenIndex = refOpen[1];

    /* { [rowIndex]: name } — shown until the re-fetch replaces it with the
       server's answer, which may name MORE turns than the one clicked. */
    var refOptimistic = React.useState({});
    var optimistic    = refOptimistic[0];
    var setOptimistic = refOptimistic[1];

    var refNotice = React.useState(null);
    var notice    = refNotice[0];
    var setNotice = refNotice[1];

    var windowRef = React.useRef('');

    /* The org's own member list, used to turn "a name was said in this
       conversation" into a real person with a real spelling. Fetched only once
       the backend has said the naming feature is on, so a mount that will never
       show the control does not spend a request — /evidence renders one of
       these per day in range. */
    var refMembers = React.useState([]);
    var members    = refMembers[0];
    var setMembers = refMembers[1];

    React.useEffect(function () {
      var cancelled = false;
      /* A naming re-fetch must NOT blank the list back to "Loading…" — that
         would throw away the optimistic label the user just set and flash the
         whole transcript. Only a genuine window change resets. */
      var windowKey = [date, user, start, end].join('|');
      if (windowRef.current !== windowKey) {
        windowRef.current = windowKey;
        setState({ status: 'loading', segments: [] });
      }
      window.FS.api.transcripts.getTranscripts({
        date: date, user: user, start: start, end: end,
      }).then(function (res) {
        if (cancelled) return;
        /* _fetch.js sentinels (BACKEND-CONTEXT §8.2/§8.4): a 403 or a
           genuine missing-transcript response must NOT fall through to
           the segments.length===0 branch below — that branch's copy
           ("recordings may have been archived") is misleading for a
           real access-denied response and was masking the Aurora-route
           403→wrong-identity bug (Issue B) as a routine empty state. */
        if (res && res._accessDenied) {
          setState({ status: 'denied', segments: [], message: res.error });
          return;
        }
        if (res && res._notFound) {
          setState({
            status:   'notfound', segments: [],
            message:  res.message || (res.raw && res.raw.message),
          });
          return;
        }
        setState({
          status:   'ok',
          segments: res.speaker_segments || [],
          speakers: res.speakers || [],
          message:  res.message,
          /* Feature detection is the PRESENCE of this key (see
             speaker-naming.featureAvailable), so the narrowing that builds
             this state object has to carry it — narrowing it away is how the
             naming control would silently never appear. */
          namingAvailable: window.FS.speakerNaming
            ? window.FS.speakerNaming.featureAvailable(res) : false,
          unmatchedNames: res.unmatchedNames,
          counts: {
            files:    res.count,
            segments: res.total_speaker_segments,
            speakers: res.speaker_count,
          },
        });
        /* The server's answer has arrived and supersedes the guess. */
        setOptimistic({});
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: err, segments: [] });
      });
      return function () { cancelled = true; };
    }, [date, user, start, end, reloadTick]);

    React.useEffect(function () {
      if (!state.namingAvailable) return undefined;
      /* A role that cannot name also cannot list members — /members 403s for a
         worker — so fetching the roster for them is a request whose only
         possible outcome is a denial. Verified live on TEST: signed in as a
         worker, getMembers returned _accessDenied. */
      var sn0 = window.FS.speakerNaming;
      var role = ((window.AuthMock && window.AuthMock.currentUser) || {}).role;
      if (!sn0 || !sn0.roleMayName(role)) return undefined;
      var org = window.FS.api.org;
      if (!org || !org.getMembers) return undefined;
      var cancelled = false;
      org.getMembers().then(function (res) {
        if (cancelled || !res || res._accessDenied || res._notFound) return;
        setMembers((res.members || []).map(function (m) {
          return m && m.name;
        }).filter(Boolean));
      }).catch(function () {
        /* No roster is a smaller list of suggestions, not a broken panel —
           `used`, `wearer` and `heard` still stand on their own. */
      });
      return function () { cancelled = true; };
    }, [state.namingAvailable]);

    /* A2-2 — precision spotlight, same shape as SafetyFlagRow /
       TopicCard (rootRef + flashing state + useEffect keyed on the
       highlight prop → scrollIntoView + timed flash class). One row
       flashes at a time, so a single index (not a per-row boolean) is
       enough; segRefs maps segment index → DOM node via callback ref. */
    var segRefs = React.useRef({});
    var refFlash = React.useState(null);
    var flashIndex    = refFlash[0];
    var setFlashIndex = refFlash[1];

    React.useEffect(function () {
      if (!props.highlightTime || !state.segments.length) return undefined;
      var idx = findHighlightIndex(state.segments, hmsToSeconds(props.highlightTime));
      if (idx == null) return undefined;
      var node = segRefs.current[idx];
      if (node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setFlashIndex(idx);
      var t = setTimeout(function () { setFlashIndex(null); }, 1900);
      return function () { clearTimeout(t); };
    }, [props.highlightTime, state.segments]);

    var sn = window.FS.speakerNaming;

    /* 202 = queued. Clustering typically takes a few seconds and there is no
       push, so re-fetch once on a timer. The optimistic label holds the gap. */
    var REFETCH_DELAY_MS = 2000;

    function scheduleRefetch() {
      setTimeout(function () { setReloadTick(function (n) { return n + 1; }); },
        REFETCH_DELAY_MS);
    }

    function submitName(seg, index, name) {
      var ref = sn.sessionRefForSegment(seg);
      if (!ref) return;
      var trimmed = String(name || '').trim();
      if (!trimmed) return;
      setOpenIndex(null);
      setOptimistic(function (prev) {
        var next = Object.assign({}, prev); next[index] = trimmed; return next;
      });
      setNotice(null);
      window.FS.api.org.setSpeakerName(ref, sn.correctionBody(seg, {
        user: user, displayName: trimmed,
      })).then(function (res) {
        if (res && res._notAvailable) {
          setNotice('Naming is not available in this environment.');
          setOptimistic({});
          return;
        }
        if (res && (res._accessDenied || res._notFound)) {
          /* 404 here means SPEAKER_IDENTITY_MODE=off — "not enabled here",
             not a bug. 403 means the role may not name. Neither is an error
             worth alarming about, but silence would read as "it worked". */
          setNotice(res._notFound
            ? 'Speaker naming is not enabled for this environment.'
            : (res.error || 'You do not have permission to name speakers.'));
          setOptimistic({});
          return;
        }
        scheduleRefetch();
      }).catch(function () {
        setNotice('Could not save that name.');
        setOptimistic({});
      });
    }

    function removeName(seg, name) {
      var ref = sn.sessionRefForSegment(seg);
      if (!ref || !name) return;
      /* Say what it does. The scope is one meeting, and a person asking for
         their name off one transcript has not asked for anything else. */
      var msg = 'Remove "' + name + '" from this meeting. '
        + 'Other meetings are not affected.';
      if (typeof window.confirm === 'function' && !window.confirm(msg)) return;
      setOpenIndex(null);
      setNotice(null);
      window.FS.api.org.removeSpeakerName(ref, name).then(function (res) {
        if (res && res._notAvailable) {
          setNotice('Naming is not available in this environment.');
          return;
        }
        if (res && (res._accessDenied || res._notFound)) {
          setNotice(res._notFound
            ? 'Speaker naming is not enabled for this environment.'
            : (res.error || 'You do not have permission to remove this name.'));
          return;
        }
        scheduleRefetch();
      }).catch(function () {
        setNotice('Could not remove that name.');
      });
    }

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-transcript-list__loading' },
        'Loading transcript…');
    }
    if (state.status === 'error') {
      return React.createElement('div', { className: 'fs-transcript-list__empty' },
        'Could not load transcript.');
    }
    if (state.status === 'denied') {
      return React.createElement(window.FieldSight.AccessDenied, {
        message: state.message,
        scope:   'this transcript',
      });
    }
    if (state.status === 'notfound') {
      return React.createElement('div', { className: 'fs-transcript-list__empty' },
        state.message || 'No transcript recorded for this date.');
    }
    if (state.segments.length === 0) {
      var emptyText = window.FS.api.useMocks
        ? 'No speaker segments in this window.'
        : (state.message || 'No transcripts available for this date — recordings may have been archived.');
      return React.createElement('div', { className: 'fs-transcript-list__empty' },
        emptyText);
    }

    /* Build position-within-view label → palette index map. */
    var labelToIdx = {};
    state.segments.forEach(function (s) {
      if (!(s.speaker in labelToIdx)) {
        labelToIdx[s.speaker] = Object.keys(labelToIdx).length;
      }
    });

    /* Best-effort name overlay from participants[]. */
    var participantHint = {};
    var participants = props.participants || [];
    Object.keys(labelToIdx).forEach(function (label, i) {
      if (participants[i]) participantHint[label] = participants[i];
    });

    /* The naming affordance appears only when the backend says the feature is
       on for this environment (the `unmatchedNames` key) AND the caller holds
       a role the write routes accept — otherwise we would be offering a
       gesture that 403s. */
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    /* Role OR your own recording — the same rule the backend applies, so the control is
       never offered where the write would 403 and never hidden where it would succeed.
       `folder_name` is the real folder from GET /api/org/me, threaded onto AuthMock by
       auth/session-bridge.js; the name-derived fallback is the same one isMineTask uses. */
    var callerFolder = caller.folder_name
      || (caller.name && window.FS.api.folderName(caller.name)) || null;
    var namingOn = !!(sn && state.namingAvailable
                      && sn.mayName({ role: caller.role, callerFolder: callerFolder,
                                      folder: user })
                      && window.FS.api.org && window.FS.api.org.setSpeakerName);
    /* used → wearer → heard, deduped. `participants` is the extraction's own
       heard-name list, which until now this component used ONLY as a
       positional guess; it is a much better suggestion source than a guess. */
    var candidates = sn ? sn.nameCandidates({
      segments:     state.segments,
      participants: props.participants,
      userFolder:   user,
      members:      members,
      /* The transcript's own words, so a roster name that is actually said
         here outranks one that merely exists. */
      text: state.segments.map(function (x) { return (x && x.text) || ''; }).join(' '),
    }) : [];

    return React.createElement('div', { className: 'fs-transcript-list' },

      React.createElement('div', { className: 'fs-transcript-list__caption' },
        state.counts.segments + ' segments · '
          + state.counts.speakers + ' speakers · '
          + state.counts.files + ' source files'),

      /* Somebody set a name and it is no longer shown. Staying silent here
         reads as "nobody ever named this", which is a different and wrong
         statement. */
      (namingOn && state.unmatchedNames > 0)
        ? React.createElement('div', { className: 'fs-transcript-list__unmatched' },
            state.unmatchedNames + (state.unmatchedNames === 1
              ? ' name no longer matches any passage.'
              : ' names no longer match any passage.'))
        : null,

      notice
        ? React.createElement('div', { className: 'fs-transcript-list__notice' }, notice)
        : null,

      state.segments.map(function (s, i) {
        var palette = SPEAKER_PALETTE[labelToIdx[s.speaker] % SPEAKER_PALETTE.length];
        var nameHint = participantHint[s.speaker];
        var pending  = optimistic[i];
        var label    = pending || sn.displayLabel(s, nameHint);
        /* Tentative is the system's guess, not the user's assertion, and must
           never render in a form a reader would quote. So is the optimistic
           label, which is our own guess until the re-fetch lands. */
        var unresolved = !!pending || sn.isTentative(s);
        var offerNaming = namingOn && sn.canName(s);

        return React.createElement('div', {
          key: i,
          ref: function (node) { segRefs.current[i] = node; },
          className: 'fs-transcript-list__row'
            + (flashIndex === i ? ' fs-transcript-list__row--flash' : ''),
        },
          React.createElement('div', { className: 'fs-transcript-list__speaker' },
            /* The chip IS the naming trigger. It used to call `props.onJump`,
               which no mount has ever passed — timeline.js and evidence.js both
               render this component without it — so the gesture the original
               spec was protecting did not exist. When a caller does pass
               onJump, it is offered as a row inside the panel instead of as a
               hidden click, so the prop keeps working without a second
               invisible meaning for the same target. */
            React.createElement('button', {
              type:    'button',
              className: 'fs-transcript-list__chip'
                + (offerNaming ? ' fs-transcript-list__chip--nameable' : ''),
              style:   { color: palette.fg, background: palette.bg },
              'aria-expanded': offerNaming ? (openIndex === i) : undefined,
              onClick: function () {
                if (offerNaming) { setOpenIndex(openIndex === i ? null : i); return; }
                if (props.onJump) props.onJump(s);
              },
              title: offerNaming
                ? (s.speaker_name ? 'Change who is speaking' : 'Say who is speaking')
                : ('Jump to ' + s.time_label),
            },
              React.createElement('span', {
                className: 'fs-transcript-list__chip-label'
                  + (unresolved ? ' fs-transcript-list__chip-label--tentative' : ''),
                title: unresolved
                  ? 'Unconfirmed — the system\'s guess at who this is'
                  : undefined,
              }, label, unresolved
                ? React.createElement('span', {
                    className: 'fs-transcript-list__tentative-mark',
                    'aria-label': 'unconfirmed',
                  }, '?')
                : null),
              React.createElement('span', {
                className: 'fs-transcript-list__chip-time',
              }, s.time_label),
            ),

          ),

          openIndex === i
            ? React.createElement(NamePanel, {
                segment:    s,
                candidates: candidates,
                onJump:  props.onJump ? function () { props.onJump(s); } : null,
                onSave:  function (name) { submitName(s, i, name); },
                onRemove: s.speaker_name
                  ? function () { removeName(s, s.speaker_name); } : null,
                onCancel: function () { setOpenIndex(null); },
              })
            : null,

          React.createElement('div', { className: 'fs-transcript-list__text' },
            s.text),
        );
      }),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TranscriptList = TranscriptList;
})();
