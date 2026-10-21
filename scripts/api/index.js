/* ==========================================================================
   FieldSight API namespace — Sprint 2.1 (Phase A)
   --------------------------------------------------------------------------
   One module per real backend endpoint, all under window.FS.api.*.

   Today every call is satisfied from in-memory fixtures (window.FieldSight
   .fixtures.*) with a small artificial delay to simulate network. When the
   real API is wired (Sprint I — see PLAN.md), flip `useMocks` to false and
   each module will fall through to a real `fetch()` against /api/<route>.

   The PUBLIC SHAPE of every response matches BACKEND-CONTEXT.md §4 verbatim.
   Call sites code against that shape, not against the fixtures.

   Loaded BEFORE any composite or page that calls FS.api.*.
   ========================================================================== */

(function () {
  'use strict';

  if (!window.FS) window.FS = {};

  /* Folder name in S3 = display name with spaces → underscores
     (BACKEND-CONTEXT §6, §4.4). Centralised so call sites don't hand-roll.

     TRIM FIRST — this is not cosmetic. The server builds user_name as
     `first_name || ' ' || last_name`, so an account with an empty last_name
     (e.g. Ben_UCPK) yields "Ben_UCPK " with a trailing space. Without the
     trim that becomes the folder "Ben_UCPK_", which matches nothing: it
     403'd every photo presign (P5) and it silently sent the user's own
     unassigned tasks to Team instead of Mine, because the derived owner
     folder never equalled the real one. A real folder never has a leading
     or trailing underscore, so trimming is strictly more correct. */
  function folderName(displayName) {
    return String(displayName == null ? '' : displayName).trim().replace(/\s+/g, '_');
  }

  /* The signed-in caller's OWN recording folder -- an identity key that comes
     from the directory (users.folder_name, carried onto
     AuthMock.currentUser.folder_name by the session bridge), never from the
     display name. Display names are not folders: "Deandre' Alberts" is the
     folder "Deandre__Alberts", and the name-derived guess ("Deandre'_Alberts")
     belongs to nobody, so the server refused the caller their OWN day.

     Only mock mode (fixtures keyed by derived folders) may fall back to the
     name. In live mode with no folder_name this returns null and the caller
     must OMIT `user` and let the backend resolve "self" -- never guess. */
  function callerFolder() {
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (u.folder_name) return u.folder_name;
    if (window.FS.api && window.FS.api.useMocks && u.name) return folderName(u.name);
    return null;
  }

  /* The folder that OWNS a report. A success DailyReport carries only the
     display name, and a display name is not a folder, so: the report's own
     `user` folder when it has one; the caller's directory folder when the
     report is the caller's own (same display name); only then the name-derived
     guess (other people -- the backend gives no folder for them yet). */
  function reportOwnerFolder(report) {
    if (!report) return null;
    if (typeof report.user === 'string' && report.user) return report.user;
    var n = report.user_name;
    if (!n) return null;
    var me = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (me.name && String(me.name).trim() === String(n).trim()) {
      var own = callerFolder();
      if (own) return own;
    }
    return folderName(n);
  }

  /* The folder of a ROW (topic / observation / task row). Prefer the folder the
     backend sent (`user_folder` on topics, `author_folder` on observations) --
     it is the directory's identity key. Only when the field is ABSENT (old
     backend, mock) derive it from the display name; a field that is present
     and null means "no linked user" and stays null. */
  function rowFolder(row, folderKey, nameKey) {
    if (!row) return null;
    if (Object.prototype.hasOwnProperty.call(row, folderKey) && row[folderKey] !== undefined) {
      return row[folderKey] || null;
    }
    var n = row[nameKey];
    return n ? folderName(n) : null;
  }

  /* Small artificial delay so optimistic-UI patterns can be tested. */
  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms || 80);
    });
  }

  /* Build a presigned-URL placeholder so UI code can render <img>/<video>
     against a plausible-looking string. Real backend returns short-lived
     S3 URLs from /api/media/presigned-url; replace when going live. */
  function mockPresignedUrl(key) {
    return 'https://mock.fieldsight.local/' + key + '?expires=900';
  }

  /* NZDT (UTC+13) date math helper — see BACKEND-CONTEXT §8.1 / BUG-19.
     `new Date('2026-04-29')` parses as UTC midnight; toISOString().slice(0,10)
     can shift the date by one day in NZDT. Use UTC-based arithmetic only. */
  function addDaysISO(yyyymmdd, days) {
    var parts = yyyymmdd.split('-').map(Number);
    var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
    return d.toISOString().slice(0, 10);
  }

  /* "Today" in NZDT (Pacific/Auckland) — Sprint 3 P-06.
     Uses Intl with the canonical IANA zone so DST transitions
     (NZDT/NZST) are handled by the runtime. Falls back to a manual
     UTC+13 offset if the engine is missing the time-zone tables. */
  function todayNZDT() {
    try {
      var fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Pacific/Auckland',
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
      return fmt.format(new Date()); /* en-CA → YYYY-MM-DD */
    } catch (e) {
      var d = new Date(Date.now() + 13 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    }
  }

  /* ── NZ display time (owner rule 2026-10-22) ────────────────────────────
     The server stores and returns UTC; every date or time the UI SHOWS a
     person is New Zealand time (Pacific/Auckland), whatever the browser's
     own zone or locale. These are the one place that conversion happens:

       nzDate('2026-10-21T21:30:00Z')      → '22 Oct 2026'
       nzDateTime('2026-10-21T21:30:00Z')  → '22 Oct 2026, 10:30'
       nzTime('2026-10-21T21:30:00Z')      → '10:30'
       nzDay('2026-10-21T21:30:00Z')       → '2026-10-22'   (NZ calendar day)

     Input: an ISO timestamp with Z or an offset ('T' or Postgres' ' '
     separator), a Date, or epoch MILLISECONDS — converted to Auckland time.

     A timestamp with NO offset is NOT converted: the one such field the
     server sends is a session's started_at/ended_at, which is the device's
     NZ wall clock parsed out of the filename (session_scope.session_start),
     never a UTC instant. Same rule as todo-history.js formatWhen. Shifting
     what cannot be proven to be UTC is the bug this helper exists to stop.

     A bare 'YYYY-MM-DD' is a calendar day (report dates, S3 day folders),
     already a NZ business day: it is formatted by string surgery and NEVER
     goes through Date, because shifting a pure date by a zone is the same
     bug in the other direction (BUG-19). nzTime of a bare date is ''.

     Unparseable input comes back unchanged, so a reader sees the raw value
     rather than a plausible-looking wrong one. Built from numeric parts and
     our own month names: ICU's en-NZ short month is 'Sept', and some
     engines emit hour '24' at midnight. */
  var NZ_TZ = 'Pacific/Auckland';
  var NZ_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var PURE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var nzFmt = null;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toInstant(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') return isFinite(v) ? new Date(v) : null;
    var d = new Date(String(v).trim().replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }

  var NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(:\d{2}(\.\d+)?)?$/;
  var ZONED = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;

  /* { y, m, d, hh, mm } of the instant on the Auckland wall clock. */
  function nzParts(date) {
    try {
      if (!nzFmt) {
        nzFmt = new Intl.DateTimeFormat('en-NZ', {
          timeZone: NZ_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        });
      }
      var p = {};
      nzFmt.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
      return { y: +p.year, m: +p.month, d: +p.day, hh: (+p.hour) % 24, mm: +p.minute };
    } catch (e) {
      /* Engine without time-zone data: same fallback as todayNZDT. */
      var f = new Date(date.getTime() + 13 * 60 * 60 * 1000);
      return { y: f.getUTCFullYear(), m: f.getUTCMonth() + 1, d: f.getUTCDate(),
               hh: f.getUTCHours(), mm: f.getUTCMinutes() };
    }
  }

  /* Normalised view of any input: { day:{y,m,d}, time:'HH:MM'|null } or null. */
  function nzView(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      var s = v.trim();
      var m = PURE_DATE.exec(s);
      if (m) {
        if (+m[2] < 1 || +m[2] > 12) return null;
        return { day: { y: +m[1], m: +m[2], d: +m[3] }, time: null };
      }
      var n = NAIVE.exec(s);
      if (n) {
        if (+n[2] < 1 || +n[2] > 12) return null;
        return { day: { y: +n[1], m: +n[2], d: +n[3] }, time: n[4] + ':' + n[5] };
      }
      if (!ZONED.test(s)) return null;
    }
    var inst = toInstant(v);
    if (!inst) return null;
    var p = nzParts(inst);
    return { day: { y: p.y, m: p.m, d: p.d }, time: pad2(p.hh) + ':' + pad2(p.mm) };
  }

  function raw(v) { return (v === null || v === undefined) ? '' : String(v); }
  function dayText(day) { return day.d + ' ' + NZ_MONTHS[day.m - 1] + ' ' + day.y; }

  function nzDate(v) {
    var x = nzView(v);
    return x ? dayText(x.day) : raw(v);
  }

  function nzDateTime(v) {
    var x = nzView(v);
    if (!x) return raw(v);
    return x.time ? dayText(x.day) + ', ' + x.time : dayText(x.day);
  }

  function nzTime(v) {
    var x = nzView(v);
    if (!x) return raw(v);
    return x.time || '';
  }

  function nzDay(v) {
    var x = nzView(v);
    if (!x) return '';
    return x.day.y + '-' + pad2(x.day.m) + '-' + pad2(x.day.d);
  }

  /* Detect HTML-content-type 404 trap (BACKEND-CONTEXT §8.2 / BUG-20). */
  function isJsonResponse(res) {
    var ct = (res.headers.get && res.headers.get('content-type')) || '';
    return ct.indexOf('application/json') !== -1;
  }

  /* Per-environment config: env.js (generated at deploy time) sets
     window.FS_ENV before this script loads. Absent locally → mock mode. */
  var env = window.FS_ENV || {};

  window.FS.api = {
    useMocks: env.useMocks !== undefined ? !!env.useMocks : true,
    /* writeMocks: write paths WITHOUT a real backend stay mocked even when
       reads go live (Sprint-5 lesson: never ship writes without a backend). */
    writeMocks: env.writeMocks !== undefined ? !!env.writeMocks : true,
    baseUrl: env.baseUrl || '/api',
    /* Second base URL for the org backend (test gateway). Empty '' = kill
       switch: org reads/writes fall back to mocks. See api/org.js. */
    orgBaseUrl: env.orgBaseUrl || '',
    /* authority flip (pipeline plan 2026-07-14): 'report' = prod /api/timeline
       (S3 daily_report.json), 'aurora' = org /api/org/timeline (item store).
       'aurora' only takes effect when orgBaseUrl is non-empty (kill switch). */
    timelineSource: env.timelineSource || 'report',
    orgWrites: env.orgWrites !== undefined ? !!env.orgWrites : false,
    /* "Came up again" — the queue that asks a person whether this topic
       restates an earlier one (recurring-item threading). Held back from
       customers 2026-08-16 while it is exercised on dev only.

       Defaults to FALSE, and that direction is the point: a missing or
       misspelled variable hides the feature rather than exposing it. This
       repo's standing failure is a switch whose middle segment goes missing
       and silently takes the DEFAULT — so the default has to be the safe
       answer, not the convenient one. */
    threadReview: env.threadReview !== undefined ? !!env.threadReview : false,
    /* Second-pass web corroboration under an Ask answer. Off unless the env
       says otherwise -- an older deploy, or a stack whose backend has no
       /ask/corroborate route, must render exactly what it renders today. */
    externalCorroboration: env.externalCorroboration !== undefined ? !!env.externalCorroboration : false,
    /* Ask as an async turn (POST /ask/start, poll GET /ask/result) instead of
       one POST /ask held open against API Gateway's 29s ceiling. Off unless
       the env says otherwise (Amplify FS_ASK_ASYNC): a stack whose backend
       has no /ask/start must keep sending exactly today's request. */
    askAsync: env.askAsync !== undefined ? !!env.askAsync : false,
    /* Ask offers the web instead of running it unasked (Amplify
       FS_ASK_WEB_OFFER; spec 2026-10-16 ask-screen-web-offer §5). On, Ask
       sends `offer_web: true` and renders a "Search the web" button under an
       answer that carries `web_offer`. Off unless the env says otherwise:
       prod (`main`) must keep sending exactly today's request. */
    askWebOffer: env.askWebOffer !== undefined ? !!env.askWebOffer : false,
    /* Ask keeps the palette's conversations server-side (Amplify
       FS_ASK_THREADS; spec 2026-10-22 ask-conversation-history §7). On, the
       palette lists "Recent conversations" and its AskChat sends
       `new_thread` / `thread_id`. Off unless the env says otherwise: the
       module that talks to the routes is FS.api.askThreads (api/ask-threads.js),
       this is only the switch. */
    askThreadsOn: env.askThreads !== undefined ? !!env.askThreads : false,
    /* D5 (visibility spec) — legacy report-gateway read fallback (/timeline,
       /dates, /site-users). Default ON during Phase 2 rollout; flip to false
       (env.legacyReadFallback = false) to retire the legacy read paths once
       Aurora reads are trusted — Aurora then stays authoritative even on an
       _accessDenied divergence. */
    legacyReadFallback: env.legacyReadFallback !== false,
    delay: delay,
    folderName: folderName,
    callerFolder: callerFolder,
    reportOwnerFolder: reportOwnerFolder,
    rowFolder: rowFolder,
    mockPresignedUrl: mockPresignedUrl,
    addDaysISO: addDaysISO,
    todayNZDT: todayNZDT,
    nzDate: nzDate,
    nzDateTime: nzDateTime,
    nzTime: nzTime,
    nzDay: nzDay,
    isJsonResponse: isJsonResponse,
  };

})();
