/* ==========================================================================
   api/speaker-naming.js — the rules behind naming a passage in a transcript
   --------------------------------------------------------------------------
   Spec: docs/specs/2026-08-14-speaker-naming-ui.md
   Backend: fieldsight-pipeline PRs #487-#496.

   These are pure functions so the render path (composites/transcript-list.js)
   and the tests read the SAME rules — three of them are corrections the spec
   marks with a warning because getting them wrong fails silently:

   1. `end_sec` is `chunk_start + duration`, NEVER `chunk_start + (end - start)`.
      `start`/`end` are absolute clock seconds resolved through the batch map,
      which re-inserts the silence batching removed. For a turn straddling a
      batch seam, `end - start` is larger than the real in-file span by that
      whole gap and the backend analyses the wrong audio window. NOTHING
      validates it: the request returns 202 and writes a row either way.

   2. The session reference in the URL is not the session list's `session_id`.
      The POST route searches the path segment for BOTH a `YYYY-MM-DD` date
      AND a `sid<32 hex>` token; a bare `session_id` carries no date and 400s
      every time. `source_filename` carries both, and is what we have in hand
      on a segment, so it is what we send.

   3. A legacy (RealPTT-era) transcript filename has no `sid`, and the backend
      overlay + both write routes decline for it. `sessionRefForSegment`
      returns null there, which is what suppresses the affordance — a correct
      refusal, not a bug to hunt.

   Feature detection is the presence of the `unmatchedNames` KEY on the
   transcripts response (§"Feature detection"). The GET route is not gated on
   the switch and does not 403 for workers, so a feature-detect that expects
   the read to fail would never fire.

   Exported to:
     window.FS.speakerNaming   (browser)
     module.exports            (node --test)
   ========================================================================== */

(function () {
  'use strict';

  /* voiceprint_utils.DEFAULT_MIN_TURN_S — the backend declines to propagate
     from a turn shorter than this, so we do not invite the gesture. */
  var MIN_TURN_SECONDS = 3;

  /* Both write routes 403 for anyone else (lambda_org_api). Gating the UI on
     the same list means a worker is never offered a control that refuses.

     `project_manager` is here because the UI never sees the org role `pm`:
     scripts/auth/session-bridge.js:104 renames it on the way into
     AuthMock.currentUser, since roles.js has no 'pm' slug and an unmapped role
     gets zero permissions. Matching only the backend's spelling meant every pm
     account was silently denied a control the backend would have accepted —
     no error, just an absent caret. Both spellings, and a test pinning it. */
  var NAMING_ROLES = ['admin', 'gm', 'pm', 'project_manager',
                      'site_manager', 'platform_admin'];

  var SID_RE = /sid[0-9a-f]{32}/i;
  var DATE_RE = /\d{4}-\d{2}-\d{2}/;

  /* The path segment the write routes locate the session by. Requires BOTH
     tokens; returns null when either is missing (legacy recordings), and the
     caller treats null as "this feature does not apply here". */
  function sessionRefForSegment(seg) {
    var f = seg && seg.source_filename;
    if (!f || typeof f !== 'string') return null;
    if (!SID_RE.test(f) || !DATE_RE.test(f)) return null;
    return f;
  }

  /* A turn we may offer to name. Short turns are refused by the backend
     (roughly a fifth of them are under 3 s, by its own comment). */
  function canName(seg) {
    if (!seg) return false;
    if (!sessionRefForSegment(seg)) return false;
    if (typeof seg.duration !== 'number' || !(seg.duration >= MIN_TURN_SECONDS)) return false;
    return typeof seg.chunk_start === 'number';
  }

  /* The ROLE arm only. Still exported because it is also the right gate for the member
     roster: /members 403s for a worker, so fetching it for one is a request whose only
     possible outcome is a denial. */
  function roleMayName(role) {
    return NAMING_ROLES.indexOf(String(role || '')) !== -1;
  }

  /* The whole rule, mirroring the backend: the role list OR your own recording.

     The second arm exists because the person who pressed record is the person who knows who
     was in the room, and until 2026-08-14 they were the one person who could not say so.
     Compare against the caller's OWN folder — not against "the transcript loaded", which is
     a different question: `regional_manager` can READ a colleague's day and still must not
     name in it. Backend counterpart: `_may_correct_speakers` in lambda_org_api.py. */
  function mayName(opts) {
    opts = opts || {};
    if (roleMayName(opts.role)) return true;
    return !!(opts.callerFolder && opts.folder && opts.callerFolder === opts.folder);
  }

  /* The POST body. `consent_given` is hard-false here BY DESIGN: consent is a
     different act from naming — it stores a voiceprint, which is biometric
     data, and the consent required is the consent of the person whose voice
     it is. Phase 1 ships no consent UI (spec §Consent). Do not add a flag to
     this function; add a deliberate surface with real wording instead. */
  function correctionBody(seg, opts) {
    opts = opts || {};
    return {
      user: opts.user || '',
      source_filename: seg.source_filename,
      start_sec: seg.chunk_start,
      end_sec: seg.chunk_start + seg.duration,
      display_name: String(opts.displayName || '').trim(),
      consent_given: false,
      consented_by: null,
    };
  }

  /* Presence of the KEY, not its value: 0 unmatched names is still a
     feature-is-on signal. The key appears only when the backend mode is not
     `off` and the payload has at least one speaker segment. */
  function featureAvailable(res) {
    return !!res && Object.prototype.hasOwnProperty.call(res, 'unmatchedNames');
  }

  /* Precedence: a name a person asserted beats a positional guess. If the
     guess won, a real correction would be invisible — which is the failure
     the whole backend layer exists to avoid. */
  function displayLabel(seg, hint) {
    if (!seg) return '';
    if (seg.speaker_name) return seg.speaker_name;
    return hint || seg.speaker;
  }

  /* `tentative` is the SYSTEM's guess, not the user's assertion, and must
     never render in a form a reader would quote. */
  function isTentative(seg) {
    return !!(seg && seg.speaker_name && seg.speaker_state !== 'confirmed');
  }

  /* Names already used in this meeting — offered as suggestions so a second
     correction spells the person the same way as the first. */
  function namesInSession(segments) {
    var seen = {};
    (segments || []).forEach(function (s) {
      if (s && s.speaker_name) seen[s.speaker_name] = true;
    });
    return Object.keys(seen).sort();
  }

  /* folder → display name. `Jarley_Trainor` → `Jarley Trainor`.
     Collapses repeats and trims, because a member with a NULL last_name gets a
     folder ending in `_` (fieldsight-display-name-trailing-space) and
     "Ben UCPK " is not a name anyone would pick from a list. */
  function folderToName(folder) {
    return String(folder || '').replace(/_+/g, ' ').trim();
  }

  /* Which of these known people are named in this transcript.

     The roster is the org's own member list, so nothing here is invented — the
     worst case is a suggestion nobody wanted, never a name that does not exist.
     That is the whole reason this reads a roster instead of pulling capitalised
     words out of the text: "the model heard a name" and "this person exists"
     are different claims, and only the second one is safe to offer as a click.

     Matching is per token, because a transcript says "Ben", not "Ben Lin".

     A Latin token needs three characters and a boundary, or "Mark" matches
     "marked". But the boundary is "not another LATIN letter", NOT "not a
     letter" — these transcripts are frequently Chinese with Latin names inside
     them, and in `我要去和Sam见面` the neighbours are Han characters, which are
     letters. Bounding on \p{L} rejected every name embedded in Chinese text,
     silently, and that is how this codebase has twice shipped a Latin-centric
     text rule that erases non-Latin content. Found by opening the page.

     Tokens with no Latin letters have no spaces to bound at all and match as
     substrings from two characters. Nothing is ASCII-normalised anywhere here;
     normalising deletes the Chinese outright. */
  function mentionedNames(members, text) {
    var hay = String(text || '');
    if (!hay) return [];
    var lower = hay.toLowerCase();
    return (members || []).filter(function (name) {
      var tokens = String(name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      return tokens.some(function (t) {
        if (/\p{Script=Latin}/u.test(t)) {
          if (t.length < 3) return false;
          var esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(
            '(?<![\\p{Script=Latin}\\p{N}])' + esc + '(?![\\p{Script=Latin}\\p{N}])',
            'iu').test(hay);
        }
        return t.length >= 2 && lower.indexOf(t.toLowerCase()) !== -1;
      });
    });
  }

  /* The choices offered for "who is speaking", in the order they are offered.

     Picking beats typing here: the same person typed twice two different ways
     is two people to the propagation layer, and the second spelling silently
     names nothing. So the names already used in this meeting come first.

     `heard` comes from the extraction's `participants` — names the MODEL heard
     in the conversation. They are the most useful suggestions and the least
     trustworthy: a misheard or invented name is now one click away, where
     before it needed typing. The caller must label the group as heard rather
     than confirmed, and must not pre-select anything. Ordering it last is part
     of that.

     Deduped case-insensitively, first group wins, so a name that is both used
     and heard is offered once, as used. */
  function nameCandidates(opts) {
    opts = opts || {};
    var out = [];
    var seen = {};

    function add(name, source) {
      var clean = String(name == null ? '' : name).trim();
      if (!clean) return;
      var k = clean.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push({ name: clean, source: source });
    }

    var members = opts.members || [];
    namesInSession(opts.segments).forEach(function (n) { add(n, 'used'); });
    add(folderToName(opts.userFolder), 'wearer');
    /* Real people who are actually named in this transcript — the answer the
       user is most often reaching for, and the only group that is both
       specific to this conversation AND guaranteed to exist. */
    mentionedNames(members, opts.text).forEach(function (n) { add(n, 'mentioned'); });
    (opts.participants || []).forEach(function (p) { add(p, 'heard'); });
    /* Everyone else on the roster, so a person who is present but never says a
       name is still one click away rather than a typing exercise. The caller
       keeps this group collapsed — it is the long tail, not a suggestion. */
    members.forEach(function (m) { add(m, 'team'); });
    return out;
  }

  var mod = {
    MIN_TURN_SECONDS: MIN_TURN_SECONDS,
    folderToName: folderToName,
    mentionedNames: mentionedNames,
    nameCandidates: nameCandidates,
    NAMING_ROLES: NAMING_ROLES,
    sessionRefForSegment: sessionRefForSegment,
    canName: canName,
    roleMayName: roleMayName,
    mayName: mayName,
    correctionBody: correctionBody,
    featureAvailable: featureAvailable,
    displayLabel: displayLabel,
    isTentative: isTentative,
    namesInSession: namesInSession,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    window.FS.speakerNaming = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
