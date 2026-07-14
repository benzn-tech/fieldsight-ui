/* ==========================================================================
   FieldSight Programme Suggestions fixture (Sprint 11 — programme<->item
   feedback, Task 6 UI)
   --------------------------------------------------------------------------
   Mock rows for the SB1108 Ellesmere College site (same site_id as
   scripts/mock/programme.fixture.js — 'sb1108-ellesmere' — so getProgramme
   and getSuggestions agree on "current site" in mock mode, where the org
   UUID and report-side slug happen to be the same string). Sourced from
   the 2026-04-29 daily report fixture (scripts/mock/daily-report.fixture.js)
   so the evidence deep-link opens onto real topics:
     topic 1 'Crane pre-start inspection slot'
     topic 2 'Concrete pour — Block 4 south footing'
     topic 3 'Wind warning — secure tarps and edge protection'

   Row shape mirrors the live backend contract (see scripts/api/programme.js
   header): { id, site_id, task_id, task_name, topic_title, topic_summary,
   report_date, suggested_status, suggested_progress, task_status_before,
   task_progress_before, confidence, match_evidence: { llm_evidence,
   assignee_overlap, programme_updated_at }, state }.

   Three rows, deliberately varied per the Task 6 UI brief:
     sugg-001  status -> completed, WITH a progress bump  (T-003 wraps up)
     sugg-002  status -> blocked                          (T-006 held up)
     sugg-003  progress-only bump, assignee_overlap true  (T-004 ticking along)

   Exported to window.FieldSight.fixtures.programmeSuggestions
   ========================================================================== */

(function () {
  'use strict';

  var suggestions = [
    {
      id:                    'sugg-001',
      site_id:               'sb1108-ellesmere',
      task_id:               'T-003',
      task_name:             'Foundation pour',
      topic_title:           'Concrete pour — Block 4 south footing',
      topic_summary:         'Pour completed 11:30, slump test passed, south footing forms stripped same afternoon — crew signed it off as done.',
      report_date:           '2026-04-29',
      suggested_status:      'completed',
      suggested_progress:    100,
      task_status_before:    'in_progress',
      task_progress_before:  95,
      confidence:            0.88,
      match_evidence: {
        llm_evidence:        'Report states the Block 4 south footing pour finished at 11:30 with a passed slump test and forms stripped — matches Foundation pour (T-003), currently 95% and due to wrap this week.',
        assignee_overlap:    true,
        programme_updated_at: '2026-04-28T21:00:00Z',
      },
      state: 'pending',
    },
    {
      id:                    'sugg-002',
      site_id:               'sb1108-ellesmere',
      task_id:               'T-006',
      task_name:             'Roof structure',
      topic_title:           'Wind warning — secure tarps and edge protection',
      topic_summary:         'Wind warning issued for 14:00 onward (gusts to 65 km/h); tarps secured and edge-protection panels tied off ahead of the front.',
      report_date:           '2026-04-29',
      suggested_status:      'blocked',
      suggested_progress:    null,
      task_status_before:    'not_started',
      task_progress_before:  0,
      confidence:            0.62,
      match_evidence: {
        llm_evidence:        'Crew called a stand-down and secured the site ahead of a 65 km/h wind front — steel/roof work that depends on crane lifts (Roof structure, T-006) can’t proceed while the warning is active.',
        assignee_overlap:    false,
        programme_updated_at: '2026-04-28T21:00:00Z',
      },
      state: 'pending',
    },
    {
      id:                    'sugg-003',
      site_id:               'sb1108-ellesmere',
      task_id:               'T-004',
      task_name:             'Steel frame',
      topic_title:           'Crane pre-start inspection slot',
      topic_summary:         'Crane pre-start inspection pushed from 07:00 to 09:00 after operator delay; rebar offload coordinated with the revised slot.',
      report_date:           '2026-04-29',
      suggested_status:      'in_progress',
      suggested_progress:    28,
      task_status_before:    'in_progress',
      task_progress_before:  12,
      confidence:            0.71,
      match_evidence: {
        llm_evidence:        'Crane pre-start clears the way for steel erection lifts; the same crew (Ben Lin, David Barillaro) assigned to Steel frame (T-004) is named on this topic, and progress reads further along than the programme’s last recorded 12%.',
        assignee_overlap:    true,
        programme_updated_at: '2026-04-28T21:00:00Z',
      },
      state: 'pending',
    },
  ];

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.fixtures) window.FieldSight.fixtures = {};
  window.FieldSight.fixtures.programmeSuggestions = suggestions;

})();
