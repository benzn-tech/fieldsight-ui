/* ==========================================================================
   FieldSight Fixtures · Daily Report
   --------------------------------------------------------------------------
   Schema-faithful to BACKEND-CONTEXT §5.1 (the primary object the UI
   renders, returned verbatim by /api/timeline).

   Notes the fixture honours:
     • executive_summary is an ARRAY of bullet strings (v3.0+), no leading
       bullet char
     • time_range uses the EN-DASH '–' (U+2013), not a hyphen
     • topic_id is sequential, starting at 0
     • category is one of safety | progress | quality
     • action_items use `responsible` (NOT `owner` — that's meeting minutes)
     • participants may include device IDs (e.g. 'Benl1') when names
       couldn't be resolved
     • related_photos are filenames only — UI must build the S3 key
       users/{folder}/pictures/{date}/{filename} and call /api/media/presigned-url
     • Empty arrays render gracefully (BACKEND-CONTEXT §8.7)

   Exported to window.FieldSight.fixtures.reports[date][folder_name]
   ========================================================================== */

(function () {
  'use strict';

  /* en-dash for time ranges — U+2013, see BACKEND-CONTEXT §5.1 / §8.9. */
  var EN = '–';

  var REPORT_2026_04_29_JARLEY = {
    report_date: '2026-04-29',
    report_type: 'daily',
    user_name:   'Jarley Trainor',
    device:      'Benl1',
    site:        'SB1108 Ellesmere College',

    executive_summary: [
      'Morning safety brief covered fall protection on Block C; eight crew signed off and one trip hazard flagged near gate 2.',
      'Concrete pour at Block 4 footing completed at 11:30; slump test passed and forms stripped for the south footing.',
      'Crane pre-start inspection pushed from 07:00 to 09:00 after operator delay; rebar offload coordinated with revised slot.',
      'Wind warning issued for 14:00 onward (gusts to 65 km/h); tarps secured and edge-protection panels tied off ahead of the front.',
    ],

    critical_dates_and_deadlines: [
      {
        date_mentioned: 'Friday 03 May',
        context:        'Council inspection scheduled for Block C scaffold sign-off',
        who_mentioned:  'Jack Gibson',
        urgency:        'high',
        type:           'inspection',
      },
      {
        date_mentioned: 'Tomorrow',
        context:        'Edge-protection panel delivery (4 short)',
        who_mentioned:  'Ben Lin',
        urgency:        'medium',
        type:           'delivery',
      },
    ],

    quality_and_compliance: [
      {
        item:             'Concrete slump test — Block 4 footing',
        status:           'completed',
        details:          'Slump 95mm, within spec. Forms stripped at 14:00.',
        follow_up_needed: false,
      },
      {
        item:             'Edge-protection panel inventory',
        status:           'concern',
        details:          'Short by 4 panels for level 2 — replacement order placed.',
        follow_up_needed: true,
      },
    ],

    safety_observations: [
      {
        observation:        'Loose scaffold board on level 2 of Block C',
        risk_level:         'high',
        location:           'Block C, level 2',
        who_raised:         'Jarley Trainor',
        recommended_action: 'Quarantine board, replace before next shift.',
      },
      {
        observation:        'Trip hazard near gate 2 — coiled hose left across walkway',
        risk_level:         'medium',
        location:           'Gate 2',
        who_raised:         'Jack Gibson',
        recommended_action: 'Reroute hose along fence line.',
      },
    ],

    topics: [
      {
        topic_id:    0,
        time_range:  '07:00 ' + EN + ' 07:30',
        topic_title: 'Morning Safety Briefing',
        category:    'safety',
        participants: ['Jarley Trainor', 'Jack Gibson', 'Ben Lin', 'Sarah Chen'],
        summary:
          'Toolbox talk on fall protection for Block C scaffold work. Eight crew attended and signed off. One trip hazard ' +
          'flagged near gate 2; agreed to reroute hose along the fence line before 09:00.',
        key_decisions: [
          'Block C scaffold work paused until level-2 board replaced (Jarley Trainor)',
          'Reroute hose at gate 2 before 09:00 (Jack Gibson)',
        ],
        action_items: [
          {
            action:      'Order replacement scaffold boards from supplier',
            responsible: 'Jack Gibson',
            deadline:    'Today 08:30',
            priority:    'high',
          },
          {
            action:      'Reroute hose at gate 2',
            responsible: 'Sarah Chen',
            deadline:    'Today 09:00',
            priority:    'medium',
          },
        ],
        safety_flags: [
          {
            observation:        'Loose scaffold board, level 2 Block C',
            risk_level:         'high',
            recommended_action: 'Quarantine and replace before next shift.',
          },
          {
            observation:        'Coiled hose creating trip hazard at gate 2',
            risk_level:         'medium',
            recommended_action: 'Route along fence line.',
          },
        ],
        related_photos: ['Benl1_2026-04-29_07-12-04.jpg', 'Benl1_2026-04-29_07-19-22.jpg'],
      },

      {
        topic_id:    1,
        time_range:  '08:30 ' + EN + ' 09:15',
        topic_title: 'Crane pre-start inspection slot',
        category:    'progress',
        participants: ['Jarley Trainor', 'David Barillaro', 'Benl1'],
        summary:
          'Operator pushed the crane pre-start from 07:00 to 09:00. Rebar offload re-coordinated with the new slot — crane crew ' +
          'briefed on tag-line positions and exclusion zone for the lift.',
        key_decisions: [
          'Move rebar offload to 09:30 lift slot (David Barillaro)',
        ],
        action_items: [
          {
            action:      'Confirm crane inspection sign-off paperwork',
            responsible: 'David Barillaro',
            deadline:    'Today 09:30',
            priority:    'high',
          },
          {
            action:      'Coordinate rebar offload with crane crew',
            responsible: 'Jarley Trainor',
            deadline:    'Today 15:30',
            priority:    'medium',
          },
        ],
        safety_flags: [],
        related_photos: ['Benl1_2026-04-29_08-46-11.jpg'],
      },

      {
        topic_id:    2,
        time_range:  '11:00 ' + EN + ' 11:45',
        topic_title: 'Concrete pour — Block 4 south footing',
        category:    'quality',
        participants: ['Jarley Trainor', 'Ben Lin', 'David Barillaro'],
        summary:
          'South-footing pour at Block 4 completed by 11:30. Slump test passed at 95mm. Crew moved to north footing prep; ' +
          'forms stripped at 14:00 once initial set was confirmed.',
        key_decisions: [
          'Strip forms at 14:00 once initial set is reached (Jarley Trainor)',
        ],
        action_items: [
          {
            action:      'Pour concrete — Block 4 footing',
            responsible: 'Jarley Trainor',
            deadline:    'Today 11:30',
            priority:    'high',
          },
          {
            action:      'Slump test — Block 4 footing',
            responsible: 'Jarley Trainor',
            deadline:    'Today 11:45',
            priority:    'medium',
          },
          {
            action:      'Strip forms — south footing',
            responsible: 'Ben Lin',
            deadline:    'Today 14:00',
            priority:    'low',
          },
        ],
        safety_flags: [],
        related_photos: ['Benl1_2026-04-29_11-08-44.jpg', 'Benl1_2026-04-29_11-31-02.jpg'],
      },

      {
        topic_id:    3,
        time_range:  '13:30 ' + EN + ' 14:00',
        topic_title: 'Wind warning — secure tarps and edge protection',
        category:    'safety',
        participants: ['Jarley Trainor', 'Sarah Chen', 'Ben Lin'],
        summary:
          'MetService alert: gusts to 65 km/h after midday. Tarps over Block C scaffold secured with extra tie-downs and ' +
          'edge-protection panels checked along the western boundary.',
        key_decisions: [
          'Secure all tarps before 14:00 (Sarah Chen)',
        ],
        action_items: [
          {
            action:      'Secure tarps along Block C west elevation',
            responsible: 'Sarah Chen',
            deadline:    'Today 14:00',
            priority:    'high',
          },
          {
            action:      'Walk perimeter and tie off loose edge-protection panels',
            responsible: 'Ben Lin',
            deadline:    'Today 14:00',
            priority:    'high',
          },
        ],
        safety_flags: [
          {
            observation:        'Gusty conditions forecast — risk of windborne debris',
            risk_level:         'medium',
            recommended_action: 'Reinspect tie-downs every 2h until 18:00.',
          },
        ],
        related_photos: [],
      },
    ],

    _report_metadata: {
      version:              'v3.5',
      generated_at:         '2026-04-29T16:00:00Z',
      generated_by:         'system',
      recordings_processed: 12,
      total_words:          3450,
      model:                'claude-sonnet-4-6',
      parse_success:        true,
    },
  };

  /* Index per (date, folder_name). Phase B (Timeline page) iterates this map
     directly; Phase D (today-adapter) reads the report for the current
     user as the source of truth for the Today page. */
  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.fixtures) window.FieldSight.fixtures = {};
  if (!window.FieldSight.fixtures.reports) window.FieldSight.fixtures.reports = {};

  window.FieldSight.fixtures.reports['2026-04-29'] = {
    Jarley_Trainor: REPORT_2026_04_29_JARLEY,
  };

  /* Reports archive fixture — feeds /api/reports/history (Phase F).
     Mix of daily / weekly / monthly across the last few weeks so the
     list page has enough rows for a useful preview. */
  window.FieldSight.fixtures.reportHistory = [
    /* — Daily reports for the last working week — */
    { key: 'reports/2026-04-29/Jarley_Trainor/daily_report.docx',
      type: 'daily', date: '2026-04-29',
      generated_at: '2026-04-29T16:00:00Z', size: 184320,
      author: 'Jarley Trainor', site: 'SB1108 Ellesmere College' },
    { key: 'reports/2026-04-28/Jarley_Trainor/daily_report.docx',
      type: 'daily', date: '2026-04-28',
      generated_at: '2026-04-28T16:00:00Z', size: 196608,
      author: 'Jarley Trainor', site: 'SB1108 Ellesmere College' },
    { key: 'reports/2026-04-27/Jarley_Trainor/daily_report.docx',
      type: 'daily', date: '2026-04-27',
      generated_at: '2026-04-27T16:30:00Z', size: 158720,
      author: 'Jarley Trainor', site: 'SB1108 Ellesmere College' },
    { key: 'reports/2026-04-24/Jarley_Trainor/daily_report.docx',
      type: 'daily', date: '2026-04-24',
      generated_at: '2026-04-24T16:00:00Z', size: 178176,
      author: 'Jarley Trainor', site: 'SB1108 Ellesmere College' },

    /* — Weekly summaries (week-ending Sundays) — */
    { key: 'reports/2026-04-26/weekly_report.docx',
      type: 'weekly', date: '2026-04-26',
      generated_at: '2026-04-26T18:00:00Z', size: 412928,
      author: 'system', site: 'SB1108 Ellesmere College' },
    { key: 'reports/2026-04-19/weekly_report.docx',
      type: 'weekly', date: '2026-04-19',
      generated_at: '2026-04-19T18:00:00Z', size: 397312,
      author: 'system', site: 'SB1108 Ellesmere College' },
    { key: 'reports/2026-04-12/weekly_report.docx',
      type: 'weekly', date: '2026-04-12',
      generated_at: '2026-04-12T18:00:00Z', size: 421120,
      author: 'system', site: 'SB1108 Ellesmere College' },

    /* — Monthly (end-of-month) — */
    { key: 'reports/2026-03-31/monthly_report.docx',
      type: 'monthly', date: '2026-03-31',
      generated_at: '2026-03-31T18:00:00Z', size: 684032,
      author: 'system', site: 'SB1108 Ellesmere College' },
    { key: 'reports/2026-02-28/monthly_report.docx',
      type: 'monthly', date: '2026-02-28',
      generated_at: '2026-02-28T18:00:00Z', size: 717824,
      author: 'system', site: 'SB1108 Ellesmere College' },
  ];

})();
