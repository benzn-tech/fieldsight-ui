/* ==========================================================================
   api/findings-view.js — what a finding is, said on screen.
   --------------------------------------------------------------------------
   ## What a finding is

   The observation record: what was said that is not a task, a decision, or a
   question. "The contractor can only complete the first 3 of 6 floors by next
   Tuesday" is not a to-do — nobody has been asked to do anything — and it is
   not a decision. It is a state of the world, and it is the kind of sentence
   the rest of the report has nowhere to put.

   That is measured, not assumed. Across the 120 extraction artifacts in the
   prod lake (2026-09-07):

     219 findings, of which 183 are about the SITE and 36 are the model
     commenting on the recording itself ("session appears to be a system
     test"). Of the 183: 40 major, 88 minor, 55 none. Only SIX have a
     recommended_action that repeats an action item's text.

   So the content is neither noise nor a duplicate of the to-do list. Sample:
   "Damaged doors found at the PK building requiring replacement across
   multiple floors"; "Three consecutive days without successful contact with
   Brade Construction Queenstown".

   ## What was wrong

   `domain` and `severity` are both selected by the backend (repositories/
   findings.py `_COLS`) and both arrive on the object. The timeline threw them
   away at render: forty MAJOR findings rendered as the same unlabelled prose
   as fifty-five severity-`none` ones. Asked what the section was for, there
   was nothing on screen that could answer.

   Safety-domain findings are not handled here — `render_report_shape` turns
   those into `safety_flags` with a `risk_level`, and the timeline renders
   that section separately. This module is the rest: quality and progress.

   ## What is deliberately NOT here

   The programme link. `programme_task_id` / `impact_severity` /
   `impact_task_name` are real columns with a real write path
   (`repositories/findings.apply_impact`), and NOTHING HAS EVER CALLED IT —
   zero rows on prod carry one. Rendering a link for data that has never
   existed would be a claim that the feature works. It stays unbuilt until
   the backend half writes a row.

   Registers as FS.api.findingsView.
   ========================================================================== */
(function () {
  'use strict';

  /* `none` is a real value the extractor emits, not a missing one, and it
     means "worth recording, not worth flagging". It gets no chip: a chip
     reading "none" is louder than the absence it describes. */
  var SEVERITY_RANK = { major: 0, minor: 1, none: 2 };

  var SEVERITY_LABEL = { major: 'Major', minor: 'Minor' };

  /* Progress is the largest domain (141 of 219) and the one with no other
     home in the report — a quality defect at least resembles the Quality
     page, while "three floors will not be done by Tuesday" resembles
     nothing. Naming the domain is what lets a reader tell them apart. */
  var DOMAIN_LABEL = { quality: 'Quality', progress: 'Progress' };

  function severityKey(f) {
    return String((f && f.severity) || '').toLowerCase();
  }

  function severityRank(f) {
    var r = SEVERITY_RANK[severityKey(f)];
    /* An unlabelled severity sorts WITH minor rather than last. The extractor
       not labelling something is not evidence it is unimportant, and sinking
       it would bury exactly the rows carrying the least metadata. */
    return r === undefined ? SEVERITY_RANK.minor : r;
  }

  function severityLabel(f) {
    return SEVERITY_LABEL[severityKey(f)] || null;
  }

  function domainLabel(f) {
    var d = String((f && f.domain) || '').toLowerCase();
    return DOMAIN_LABEL[d] || null;
  }

  /* Major first, then minor, then none — and STABLE within each band, so the
     extractor's own order survives. Array.prototype.sort is only guaranteed
     stable in modern engines; the index tiebreak makes it so regardless, and
     also makes the comparator total, which is what stops the list reshuffling
     between renders. */
  function orderFindings(list) {
    return (list || []).map(function (f, i) { return { f: f, i: i }; })
      .sort(function (a, b) {
        var ra = severityRank(a.f), rb = severityRank(b.f);
        return ra !== rb ? ra - rb : a.i - b.i;
      })
      .map(function (x) { return x.f; });
  }

  /* Safety is excluded because render_report_shape already promoted those
     into `safety_flags`, which the timeline renders above this section.
     Without this the same observation appears twice on one topic. */
  function nonSafety(list) {
    return (list || []).filter(function (f) {
      return f && String(f.domain || '').toLowerCase() !== 'safety';
    });
  }

  /* The section's own subtitle. It exists because "Findings" is a system word
     — it names the table, not the thing — and a reader who cannot tell what a
     section is for reads it as decoration. Counting the flagged ones says in
     one line both what these are and which of them want attention. */
  function sectionCaption(list) {
    var n = (list || []).length;
    if (!n) return null;
    var flagged = (list || []).filter(function (f) {
      return severityKey(f) === 'major' || severityKey(f) === 'minor';
    }).length;
    var noun = n === 1 ? 'observation' : 'observations';
    return flagged
      ? n + ' ' + noun + ' · ' + flagged + ' flagged'
      : n + ' ' + noun;
  }

  var mod = {
    orderFindings: orderFindings,
    nonSafety: nonSafety,
    severityLabel: severityLabel,
    severityRank: severityRank,
    domainLabel: domainLabel,
    sectionCaption: sectionCaption,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.findingsView = mod;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  }
})();
