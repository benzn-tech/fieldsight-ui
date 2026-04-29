/* ==========================================================================
   FieldSight Mock Data — Sprint 2.1 SHIM
   --------------------------------------------------------------------------
   This file used to be the source of truth for Today data. It now derives
   the same TODAY shape from the backend-shaped fixtures via
   FS.api.todayAdapter. The Today page sees no schema change.

     fixtures.reports[date][folder]   ─┐
     fixtures.actions[date]            ├─► todayAdapter.adapt() ─► MockData.TODAY
     fixtures.sites.users (for onSite) ─┘

   Once Phase B (Timeline page) lands, today.js will fetch through
   FS.api.timeline.getTimeline directly and this shim collapses to nothing.

   Weather data stays here — the backend has no weather endpoint yet (PLAN
   §E mentions it for a future sprint).

   Exported to:
     window.FieldSight.MockData = { TODAY, WEATHER, findItemById, getRelated, getTimeline }
   ========================================================================== */

(function () {
  'use strict';

  /* ---------- Build TODAY by adapting the daily report fixture ---------- */

  var fixtures = (window.FieldSight && window.FieldSight.fixtures) || {};
  var caller   = (window.AuthMock && window.AuthMock.currentUser) || {};

  /* The seed Today fixture targets Jarley Trainor on 2026-04-29. The
     dev-role-switcher rotates AuthMock.currentUser; only the role swap
     matters for today.js (gating teamTasks via canDo) — the underlying
     report stays the same. */
  var FIXTURE_DATE = '2026-04-29';
  var FIXTURE_USER = 'Jarley_Trainor';

  var report = (fixtures.reports && fixtures.reports[FIXTURE_DATE] && fixtures.reports[FIXTURE_DATE][FIXTURE_USER]) || null;
  var actionState = (fixtures.actions && fixtures.actions[FIXTURE_DATE]) || {};

  var primarySite = 'sb1108-ellesmere';
  var users = (fixtures.sites && fixtures.sites.users) || [];
  var match = users.filter(function (u) { return u.name === caller.name; })[0];
  if (match) primarySite = match.primary_site;

  var TODAY = window.FS.api.todayAdapter.adapt(report, {
    currentUserName: caller.name || 'Jarley Trainor',
    primarySite:     primarySite,
    actionState:     actionState,
    date:            FIXTURE_DATE,
  });

  /* ---------- Weather (no backend endpoint yet) -------------------------- */

  var WEATHER = {
    current: { temp: 17, condition: 'cloud-sun', wind: '12 km/h',
               humidity: '64%', conditionLabel: 'Partly cloudy' },
    hourly: [
      { hour: '13:00', temp: 17, condition: 'cloud-sun' },
      { hour: '14:00', temp: 18, condition: 'cloud-sun' },
      { hour: '15:00', temp: 18, condition: 'wind' },
      { hour: '16:00', temp: 17, condition: 'wind' },
      { hour: '17:00', temp: 16, condition: 'cloud' },
      { hour: '18:00', temp: 15, condition: 'cloud' },
      { hour: '19:00', temp: 14, condition: 'cloud-rain' },
      { hour: '20:00', temp: 13, condition: 'cloud-rain' },
      { hour: '21:00', temp: 12, condition: 'cloud-rain' },
      { hour: '22:00', temp: 11, condition: 'cloud' },
      { hour: '23:00', temp: 10, condition: 'cloud' },
      { hour: '00:00', temp: 9,  condition: 'cloud' },
    ],
    daily: [
      { day: 'Mon', date: '28 Apr', high: 18, low: 9,  condition: 'cloud-sun' },
      { day: 'Tue', date: '29 Apr', high: 16, low: 8,  condition: 'cloud-rain' },
      { day: 'Wed', date: '30 Apr', high: 15, low: 7,  condition: 'cloud-rain' },
      { day: 'Thu', date: '01 May', high: 17, low: 8,  condition: 'cloud-sun' },
      { day: 'Fri', date: '02 May', high: 19, low: 10, condition: 'sun' },
      { day: 'Sat', date: '03 May', high: 20, low: 11, condition: 'sun' },
      { day: 'Sun', date: '04 May', high: 18, low: 10, condition: 'cloud-sun' },
    ],
  };

  /* ---------- Lookups (preserved from Sprint 1.6 mock-data) ------------- */

  function findItemById(id) {
    if (!id) return null;
    var pools = [TODAY.urgent, TODAY.myTasks, TODAY.teamTasks, TODAY.activity];
    for (var i = 0; i < pools.length; i++) {
      for (var j = 0; j < pools[i].length; j++) {
        if (pools[i][j].id === id) return pools[i][j];
      }
    }
    return null;
  }

  /* Related items: kind-specific. Worker view of the team list will be
     empty so cross-task related stays self-coherent. */
  function getRelated(item) {
    if (!item) return [];

    if (item.kind === 'task') {
      var allTasks = TODAY.myTasks.concat(TODAY.teamTasks);
      return allTasks
        .filter(function (t) { return t.id !== item.id && t.assignee === item.assignee; })
        .slice(0, 3)
        .map(function (t) {
          return { id: t.id, title: t.title,
                   subtitle: t.status + ' · due ' + t.dueTime };
        });
    }

    if (item.kind === 'activity') {
      return TODAY.activity
        .filter(function (a) { return a.id !== item.id && a.speaker === item.speaker; })
        .slice(0, 3)
        .map(function (a) {
          return { id: a.id, title: a.snippet,
                   subtitle: a.timeAgo + ' · ' + a.channel };
        });
    }

    if (item.kind === 'urgent') {
      return TODAY.urgent
        .filter(function (u) { return u.id !== item.id; })
        .slice(0, 3)
        .map(function (u) {
          return { id: u.id, title: u.title, subtitle: u.badgeLabel };
        });
    }

    return [];
  }

  function getTimeline(item) {
    if (!item) return [];

    if (item.kind === 'task') {
      return [
        { label: 'Captured in topic',          actor: 'AI · transcript',  time: 'Today' },
        { label: 'Assigned to ' + item.assignee, actor: 'Report generator', time: 'Today' },
        { label: 'Status: ' + item.status,     actor: item.assignee,      time: 'Today' },
      ];
    }

    if (item.kind === 'urgent') {
      return [
        { label: 'Flagged urgent',                                     actor: 'System', time: 'Today' },
        { label: 'Triggered by · ' + (item.triggeredBy || 'manual'),   actor: 'System', time: 'Today' },
      ];
    }

    if (item.kind === 'activity') {
      return [
        { label: 'Captured',                            actor: item.speaker,      time: item.timeAgo },
        { label: 'Transcribed',                         actor: 'AWS Transcribe',  time: 'just after capture' },
        { label: 'Tagged · ' + (item.channel || 'General'), actor: 'AI',          time: 'just after capture' },
      ];
    }

    return [];
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.MockData = {
    TODAY:         TODAY,
    WEATHER:       WEATHER,
    findItemById:  findItemById,
    getRelated:    getRelated,
    getTimeline:   getTimeline,
  };

})();
