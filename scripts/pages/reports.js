/* ==========================================================================
   FieldSight Reports Page — Sprint 2.6 (PLAN.md Phase F)
   --------------------------------------------------------------------------
   /reports — historical archive of daily / weekly / monthly Word
   reports. Reads /api/reports/history (BACKEND-CONTEXT §4.11) and
   downloads each .docx via /api/media/presigned-url.

   Middle column:
     • Type filter chips (All · Daily · Weekly · Monthly)
     • Optional "Generate report" panel (admin/pm only — gated via
       FS.canDo('report:create')). Workers can technically trigger
       their own report (BACKEND-CONTEXT §4.11) but the UI hides
       the affordance for view-only roles.
     • Reverse-chronological list of report rows: type · date · size,
       click to open in right detail.

   Right detail:
     • Type badge + date + author/site + generated-at + file size.
     • Download button — fetches a fresh presigned URL on click and
       starts the download (BACKEND-CONTEXT §7: 15-min expiry, no
       localStorage caching).
     • Regenerate button (gated) with inline confirm.

   Registers as window.FieldSight.PAGES['/reports']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var TYPE_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  var TYPE_TONE  = { daily: 'info', weekly: 'success', monthly: 'accent' };

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = yyyymmdd.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + p[0];
  }

  function fmtGeneratedAt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  /* Trigger a download for a presigned URL. We must NOT cache the URL
     (15-min expiry, BACKEND-CONTEXT §7) — fetch fresh on every click. */
  /* WHICH FILE THE BUTTON ACTUALLY FETCHES.

     The button has always said "Download .docx" and always presigned
     `report.key`, which is the .json — so every download in this product's
     life handed the user raw JSON while the Word file sat beside it in the
     same S3 folder, unmentioned by the history endpoint. That endpoint now
     returns `docx_key` when a Word file exists.

     `docx_key` ABSENT means this report genuinely has no Word file (Word
     generation disables itself when the python-docx layer is missing or built
     for the wrong runtime; production has one such day). Falling back to the
     .json is right there — it is the report, just not in Word — but the
     button has to stop claiming otherwise, which is what downloadLabel is
     for. Presigning a .docx that does not exist would hand the browser a URL
     that answers 403, and this bucket answers 403 for absent keys, so it
     would not even read as "no Word file". */
  /* WHAT THE DETAIL PANEL IS HANDED WHEN A ROW IS CLICKED.

     The whole row, plus the two fields that say what kind of selection it is.
     This used to be a hand-built object with a fixed field list, and docx_key
     was not on it: the history endpoint named the Word file, the click threw
     it away, and every report in the archive offered its .json. A longer list
     would lose the next field the same way, so the row is passed through. */
  function reportSelection(r) {
    return Object.assign({}, r, { kind: 'report', id: r.key });
  }

  /* WHOSE REPORT THIS IS. A per-person report lives at
     reports/<date>/<folder>/<type>_report.json. Summary, site and combined
     reports have no folder segment, so they belong to nobody -- and nobody
     regenerates them by hand. */
  function reportFolder(key) {
    var m = /^reports\/[^/]+\/([^/]+)\/(daily|weekly|monthly)_report\.json$/.exec(key || '');
    return m ? m[1] : null;
  }

  /* Owner rule: each person regenerates only their own reports. The server
     enforces it; this only decides whether to offer the button -- and which row
     the page then waits on. */
  function canRegenerateReport(caller, report) {
    var mine = caller && caller.folder_name;
    if (!mine || !report) return false;
    if (['daily', 'weekly', 'monthly'].indexOf(report.type) < 0) return false;
    return reportFolder(report.key) === mine;
  }

  /* The archive-level buttons generate your own LATEST period: yesterday, the
     last completed week (ending Sunday), the previous month. Local calendar. */
  function defaultPeriodEnd(type, now) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (type === 'weekly') {
      var back = d.getDay() === 0 ? 7 : d.getDay();
      d.setDate(d.getDate() - back);
    } else if (type === 'monthly') {
      d = new Date(d.getFullYear(), d.getMonth(), 0);
    } else {
      d.setDate(d.getDate() - 1);
    }
    var mm = String(d.getMonth() + 1), dd = String(d.getDate());
    return d.getFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);
  }

  /* A REGENERATE OUTLIVES THE PANEL THAT STARTED IT.

     The waiting state used to live only in the detail panel, so a reload, a route
     change or selecting another report showed the Regenerate button again while
     the generator was still running -- which reads as "it failed" and invites a
     second click, i.e. a second generation. So the click is recorded here, per
     report key, and the panel resumes from it. Records expire with the
     generator's own timeout and belong to the folder that clicked, so a shared
     browser with a different login never sees them. Storage that is blocked or
     corrupt means "nothing pending", never an error. */
  var PENDING_REGEN_KEY = 'fs.reports.pendingRegenerate';
  var PENDING_REGEN_TTL_MS = 15 * 60 * 1000;

  function readPendingRegenerations(storage, now) {
    var all = {};
    try {
      all = JSON.parse((storage && storage.getItem(PENDING_REGEN_KEY)) || '{}') || {};
    } catch (_) { return {}; }
    if (typeof all !== 'object') return {};
    var live = {};
    Object.keys(all).forEach(function (k) {
      var e = all[k];
      if (e && typeof e.startedAt === 'number' && now - e.startedAt <= PENDING_REGEN_TTL_MS) live[k] = e;
    });
    return live;
  }

  function pendingRegenerationFor(storage, key, folder, now) {
    if (!key || !folder) return null;
    var e = readPendingRegenerations(storage, now)[key];
    return e && e.folder === folder ? e : null;
  }

  function rememberPendingRegeneration(storage, key, entry) {
    try {
      var all = readPendingRegenerations(storage, entry.startedAt);
      all[key] = { before: entry.before || '', beforeDocx: entry.beforeDocx || '',
                   startedAt: entry.startedAt, folder: entry.folder };
      storage.setItem(PENDING_REGEN_KEY, JSON.stringify(all));
    } catch (_) { /* blocked or full: the in-memory wait still works for this view */ }
  }

  function forgetPendingRegeneration(storage, key) {
    /* Removes exactly this key. It reads the raw record rather than the live view:
       clearing one report must never also drop another report's record by judging
       it against this call's clock. */
    try {
      var all = JSON.parse(storage.getItem(PENDING_REGEN_KEY) || '{}') || {};
      if (typeof all !== 'object') return;
      delete all[key];
      storage.setItem(PENDING_REGEN_KEY, JSON.stringify(all));
    } catch (_) { /* nothing to clear */ }
  }

  function localStore() {
    try { return window.localStorage; } catch (_) { return null; }
  }

  /* Done means the report object was rewritten after the click -- never the 202. */
  function regenerationFinished(before, row, beforeDocx) {
    if (!row || !row.generated_at) return false;
    if (!(String(row.generated_at) > String(before || ''))) return false;
    /* The generator writes the .docx AFTER the JSON. Stopping on the JSON alone
       can show a refreshed report beside the previous generation's Word file.
       No Word file, or a backend that does not send its time, falls back to the
       JSON so nothing waits forever on a field that will not arrive. */
    if (!row.docx_key || !row.docx_generated_at) return true;
    return String(row.docx_generated_at) > String(beforeDocx || '');
  }

  /* Who generated a report, from its own _report_metadata.generated_by. The
     schedule writes "system" (and "backfill"); a regenerate request writes the
     requester. Anything unknown is a dash, never a guess. */
  /* The effect body for the Author row, built outside the component so the
     component itself has no `return` above its hooks. */
  function authorEffect(caller, sel, setAuthor) {
    return function () {
      setAuthor(null);
      if (!sel || !canRegenerateReport(caller, sel)) return undefined;
      var live = true;
      fetchReportJson(sel).then(function (json) {
        if (live) setAuthor(authorLabel(((json || {})._report_metadata || {}).generated_by,
                                        reportFolder(sel.key)));
      }).catch(function () { if (live) setAuthor(null); });
      return function () { live = false; };
    };
  }

  function authorLabel(generatedBy, folder) {
    if (typeof generatedBy !== 'string' || !generatedBy.trim()) return '\u2014';
    var v = generatedBy.trim();
    if (v === 'system' || v === 'backfill') return 'Scheduled';
    /* A PERSON is shown by name, never by their email address. The panel only
       ever shows the caller's OWN report, and a regenerate may only write into
       the caller's own folder, so the one person an address here can name is
       that report's owner -- and the folder is where their name already lives.
       A value that is already a name is kept as it is. */
    var name = personName(v.indexOf('@') >= 0 ? folder : v);
    return name || '\u2014';
  }

  /* folder -> person: `Ben_Lin` -> `Ben Lin`. The shared rule is
     FS.speakerNaming.folderToName, which collapses repeated underscores and
     trims -- a member with no last name has a folder ending in `_`, and
     "Ben UCPK " is not a name anyone would pick out of a list. The same single
     line is inlined as the fallback because this module is also read on its
     own, without the page around it. */
  function personName(value) {
    var sn = (typeof window !== 'undefined' && window.FS && window.FS.speakerNaming) || null;
    if (sn && typeof sn.folderToName === 'function') return sn.folderToName(value);
    return String(value == null ? '' : value).replace(/_+/g, ' ').trim();
  }

  function regenerateErrorMessage(res) {
    if (!res) return 'Could not start the report.';
    if (res._accessDenied) return res.error || 'You can only regenerate your own reports.';
    if (res._notFound) return res.error || 'No recordings for that date.';
    if (res.status === 'unavailable') return res.error || 'Regenerate is unavailable here.';
    return null;
  }

  function downloadKeyFor(report) {
    return (report && report.docx_key) || (report && report.key) || null;
  }
  function downloadLabel(report) {
    return (report && report.docx_key) ? 'Download .docx' : 'Download .json';
  }

  /* Read a report in the browser. Same presigned URL the download uses —
     which is fetchable cross-origin because the data bucket carries a CORS
     rule for the Amplify origins (out-of-band config; see the pipeline's
     CLAUDE.md, it is not in any template).

     Always the .json, never the .docx: this is the machine-readable form and
     the one the viewer renders. The Word file is for sending to someone. */
  async function fetchReportJson(report) {
    var key = (report && report.key) || null;
    if (!key) throw new Error('This report has no file to open.');
    var res = await window.FS.api.media.presignedUrl(key);
    var r = await fetch(res.url);
    if (!r.ok) throw new Error('Could not fetch the report (' + r.status + ').');
    /* BUG-20: a 404 can arrive as a 200 carrying HTML. A report that parses
       as JSON is the only one worth rendering. */
    var text = await r.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('That file is not a readable report.');
    }
  }

  async function downloadReport(report) {
    try {
      var key = downloadKeyFor(report);
      if (!key) return;
      var res = await window.FS.api.media.presignedUrl(key);
      var a = document.createElement('a');
      a.href = res.url;
      a.target = '_blank';
      a.rel = 'noopener';
      /* download attr makes browsers prefer the filename in the URL or
         the last path segment when same-origin; the API serves with
         Content-Disposition so the real backend handles the filename. */
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.error('[reports] download failed', err);
    }
  }

  /* Sprint 8.10.3 — Batch export.
     Iterates the current month's reports, fetches presigned URLs, and
     triggers each download with a short stagger so the browser doesn't
     drop concurrent navigations. Caps at MAX_BATCH; otherwise we'd
     hammer the presign endpoint. */
  var MAX_BATCH = 10;
  async function batchExport(rows) {
    if (!rows || !rows.length) return;
    var capped = rows.slice(0, MAX_BATCH);
    if (rows.length > MAX_BATCH && window.FS && window.FS.toast) {
      window.FS.toast.show({
        message: 'Exporting first ' + MAX_BATCH + ' of ' + rows.length + ' reports',
        tone:    'warning',
      });
    } else if (window.FS && window.FS.toast) {
      window.FS.toast.show({
        message: 'Exporting ' + capped.length + ' report' + (capped.length === 1 ? '' : 's') + '…',
        tone:    'info',
      });
    }
    for (var i = 0; i < capped.length; i++) {
      try {
        await downloadReport(capped[i]);
      } catch (e) { /* individual failure already logged in downloadReport */ }
      /* 250 ms stagger keeps Chrome/Safari happy with many a.click()s */
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
    if (window.FS && window.FS.toast) {
      window.FS.toast.show({ message: 'Export complete', tone: 'success' });
    }
  }

  /* Filter rows down to the current calendar month (YYYY-MM). */
  function thisMonthRows(rows) {
    var prefix = (new Date()).toISOString().slice(0, 7);   /* e.g. "2026-05" */
    return rows.filter(function (r) {
      return r.date && r.date.slice(0, 7) === prefix;
    });
  }

  /* =====================================================================
     B.6 — TemplateFormatSelector
     Shows personal templates first, then org; defaults to the active one.
     Returns null when no templates exist (keeps the generate card clean).
     ===================================================================== */
  function TemplateFormatSelector(props) {
    /* props: onChange(templateId|null) */
    var loadRef  = React.useState({ status: 'loading', personal: [], org: [] });
    var load     = loadRef[0]; var setLoad = loadRef[1];

    var selRef   = React.useState('');
    var selId    = selRef[0]; var setSelId = selRef[1];

    React.useEffect(function () {
      if (!window.FS || !window.FS.api || !window.FS.api.templates) {
        setLoad({ status: 'ok', personal: [], org: [] });
        return;
      }
      setLoad({ status: 'loading', personal: [], org: [] });
      window.FS.api.templates.list().then(function (res) {
        var all = (res.templates || []);
        function sortActive(arr) {
          return arr.slice().sort(function (a, b) { return (b.active ? 1 : 0) - (a.active ? 1 : 0); });
        }
        var personal = sortActive(all.filter(function (t) { return t.scope === 'personal'; }));
        var org      = sortActive(all.filter(function (t) { return t.scope === 'org'; }));
        setLoad({ status: 'ok', personal: personal, org: org });
        /* Default: active personal first, then active org */
        var activePers = personal.find(function (t) { return t.active; });
        var activeOrg  = org.find(function (t) { return t.active; });
        var def = (activePers || activeOrg || {}).id || '';
        setSelId(def);
        if (props.onChange) props.onChange(def || null);
      }).catch(function () {
        setLoad({ status: 'ok', personal: [], org: [] });
      });
    }, []);

    function handleChange(e) {
      var val = e.target.value;
      setSelId(val);
      if (props.onChange) props.onChange(val || null);
    }

    if (load.status === 'loading') return null;
    if (!load.personal.length && !load.org.length) return null;

    return React.createElement('div', { className: 'fs-reports__format' },
      React.createElement('label', {
        className: 'fs-reports__format-label',
        htmlFor:   'rpt-format-sel',
      }, 'Output format'),
      React.createElement('select', {
        id:        'rpt-format-sel',
        className: 'fs-reports__format-select',
        value:     selId,
        onChange:  handleChange,
      },
        React.createElement('option', { value: '' }, '— Standard (FieldSight default) —'),
        load.personal.length
          ? React.createElement('optgroup', { label: 'My templates' },
              load.personal.map(function (t) {
                return React.createElement('option', { key: t.id, value: t.id },
                  t.title + (t.active ? ' ✓' : '') + '  (' + (TYPE_LABEL[t.report_type] || t.report_type) + ')');
              }),
            )
          : null,
        load.org.length
          ? React.createElement('optgroup', { label: 'Org templates' },
              load.org.map(function (t) {
                return React.createElement('option', { key: t.id, value: t.id },
                  t.title + (t.active ? ' ✓' : '') + '  (' + (TYPE_LABEL[t.report_type] || t.report_type) + ')');
              }),
            )
          : null,
      ),
    );
  }

  /* =====================================================================
     ReportsMiddleColumn
     ===================================================================== */
  function ReportsMiddleColumn(props) {
    var fs = window.FieldSight;
    var Button = fs.Button;
    var Badge  = fs.Badge;
    var Card   = fs.Card;

    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    /* Own reports only: anyone with a recording folder can regenerate theirs. */
    var canRegenerate = !!caller.folder_name;

    var refState = React.useState({ status: 'loading', rows: [] });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    var refFilter = React.useState('all');
    var filter    = refFilter[0];
    var setFilter = refFilter[1];

    /* A regenerate in the detail panel finished: refetch, and re-select the
       report so the panel shows its new Generated and Size. */
    var reselectRef = React.useRef(null);
    React.useEffect(function () {
      function onRefresh(e) {
        reselectRef.current = (e && e.detail && e.detail.key) || null;
        setRetry(function (n) { return n + 1; });
      }
      window.addEventListener('fs:reports-refresh', onRefresh);
      return function () { window.removeEventListener('fs:reports-refresh', onRefresh); };
    }, []);

    /* Re-read pending regenerates when one starts or ends, so the row label
       follows without a reload. */
    var pendingTickRef = React.useState(0);
    var setPendingTick = pendingTickRef[1];
    React.useEffect(function () {
      function onPending() { setPendingTick(function (n) { return n + 1; }); }
      window.addEventListener('fs:reports-pending', onPending);
      return function () { window.removeEventListener('fs:reports-pending', onPending); };
    }, []);

    /* Inline regenerate panel: 'closed' | 'pick' | 'submitting' | 'done' */
    var refReg = React.useState({ phase: 'closed' });
    var reg    = refReg[0];
    var setReg = refReg[1];

    /* B.6 — selected output-format template ID (null = standard) */
    var refTpl   = React.useState(null);
    var selTplId = refTpl[0];
    var setSelTplId = refTpl[1];

    React.useEffect(function () {
      var cancelled = false;
      window.FS.api.reports.getReportsHistory(50).then(function (res) {
        if (cancelled) return;
        /* P-12 — surface 403 as an empathetic state instead of a
           generic error. The reports archive is broadly readable for
           admin/pm/site_manager but a worker / viewer can be denied. */
        if (res && res._accessDenied) {
          setState({ status: 'access_denied', message: res.error, rows: [] });
          return;
        }
        var sorted = (res.reports || []).slice().sort(function (a, b) {
          return (b.generated_at || '').localeCompare(a.generated_at || '');
        });
        setState({ status: 'ok', rows: sorted });
        if (reselectRef.current && props.onSelect) {
          var fresh = sorted.filter(function (r) { return r.key === reselectRef.current; })[0];
          reselectRef.current = null;
          if (fresh) props.onSelect(reportSelection(fresh));
        }
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load reports', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); }, rows: [] });
      });
      return function () { cancelled = true; };
    }, [retryCount]);

    function regenerate(type) {
      setReg({ phase: 'submitting', type: type });
      var date = defaultPeriodEnd(type, new Date());
      window.FS.api.reports.regenerate({ report_type: type, date: date }).then(function (res) {
        var problem = regenerateErrorMessage(res);
        if (problem) { setReg({ phase: 'error', type: type, error: { message: problem } }); return; }
        setReg({ phase: 'done', type: type,
                 message: 'Queued your ' + type + ' report for ' + date + ' — it appears here when ready.' });
        setTimeout(function () { setRetry(function (n) { return n + 1; }); }, 60000);
        /* Clear the success message after a moment without dismissing
           the panel — gives the user a beat to see the confirmation. */
        setTimeout(function () { setReg({ phase: 'closed' }); }, 2400);
      }).catch(function (err) {
        setReg({ phase: 'error', type: type, error: err });
      });
    }

    var filtered = filter === 'all'
      ? state.rows
      : state.rows.filter(function (r) { return r.type === filter; });

    var counts = {
      all:     state.rows.length,
      daily:   state.rows.filter(function (r) { return r.type === 'daily';   }).length,
      weekly:  state.rows.filter(function (r) { return r.type === 'weekly';  }).length,
      monthly: state.rows.filter(function (r) { return r.type === 'monthly'; }).length,
    };

    function FilterChip(props) {
      var active = filter === props.value;
      return React.createElement('button', {
        type: 'button',
        className: 'fs-reports__chip' + (active ? ' fs-reports__chip--active' : ''),
        onClick: function () { setFilter(props.value); },
        'aria-pressed': active,
      },
        props.label,
        React.createElement('span', { className: 'fs-reports__chip-count' },
          counts[props.value] || 0),
      );
    }

    var selectedKey = props.selectedItem && props.selectedItem.kind === 'report'
      ? props.selectedItem.key
      : null;

    /* Sprint 8.10.3 — batch export state */
    var refExport = React.useState({ phase: 'idle' });
    var exp = refExport[0];
    var setExp = refExport[1];

    var monthRows = thisMonthRows(state.rows || []);

    function onBatchExport() {
      if (exp.phase === 'submitting') return;
      setExp({ phase: 'submitting' });
      batchExport(monthRows).finally(function () {
        setExp({ phase: 'idle' });
      });
    }

    return React.createElement('div', { className: 'fs-reports' },

      /* Header */
      React.createElement('div', { className: 'fs-reports__header' },
        React.createElement('div', { className: 'fs-reports__header-main' },
          React.createElement('h2', { className: 'fs-reports__title' }, 'Reports archive'),
          React.createElement('div', { className: 'fs-reports__subtitle' },
            'Daily, weekly and monthly report history. Click a row to download.'),
        ),
        /* Sprint 8.10.3 — batch export trigger */
        monthRows.length > 0
          ? React.createElement(Button, {
              size:      'sm',
              variant:   'secondary',
              leftIcon:  'download',
              onClick:   onBatchExport,
              disabled:  exp.phase === 'submitting',
            }, exp.phase === 'submitting'
                ? 'Exporting…'
                : 'Export all (this month, ' + monthRows.length + ')')
          : null,
      ),

      /* Filter chips */
      React.createElement('div', { className: 'fs-reports__chips' },
        React.createElement(FilterChip, { value: 'all',     label: 'All' }),
        React.createElement(FilterChip, { value: 'daily',   label: 'Daily' }),
        React.createElement(FilterChip, { value: 'weekly',  label: 'Weekly' }),
        React.createElement(FilterChip, { value: 'monthly', label: 'Monthly' }),
      ),

      /* Generate panel (gated) */
      canRegenerate ? React.createElement(Card, {
        padding: 'md', className: 'fs-reports__regen',
      },
        React.createElement(Card.Body, null,
          React.createElement('div', { className: 'fs-reports__regen-row' },
            React.createElement('div', { className: 'fs-reports__regen-main' },
              React.createElement('div', { className: 'fs-reports__regen-title' },
                'Generate report'),
              React.createElement('div', { className: 'fs-reports__regen-body' },
                'Regenerate your own latest report. It replaces your previous copy; nobody else\u2019s report is touched.'),
            ),
            reg.phase === 'closed' ? React.createElement('div', { className: 'fs-reports__regen-actions' },
              React.createElement(Button, {
                size: 'sm', variant: 'secondary',
                onClick: function () { regenerate('daily'); },
              }, 'Daily'),
              React.createElement(Button, {
                size: 'sm', variant: 'secondary',
                onClick: function () { regenerate('weekly'); },
              }, 'Weekly'),
              React.createElement(Button, {
                size: 'sm', variant: 'secondary',
                onClick: function () { regenerate('monthly'); },
              }, 'Monthly'),
            ) : null,

            reg.phase === 'submitting' ? React.createElement('div', {
              className: 'fs-reports__regen-msg',
            }, 'Queueing ' + reg.type + '…') : null,

            reg.phase === 'done' ? React.createElement('div', {
              className: 'fs-reports__regen-msg fs-reports__regen-msg--ok',
            }, '✓ ' + reg.message) : null,

            reg.phase === 'error' ? React.createElement('div', {
              className: 'fs-reports__regen-msg fs-reports__regen-msg--err',
            }, 'Failed: ' + (reg.error && reg.error.message || 'unknown')) : null,
          ),
          /* B.6 output-format selector */
          React.createElement(TemplateFormatSelector, { onChange: setSelTplId }),
        ),
      ) : null,

      /* List */
      state.status === 'loading'
        ? React.createElement('div', { className: 'fs-reports__loading' }, 'Loading reports…')
        : state.status === 'error'
        ? (window.FieldSight.ErrorBanner
            ? React.createElement(window.FieldSight.ErrorBanner, {
                message:   (state.error && state.error.message) || 'Could not load reports',
                retryable: true,
                onRetry:   state.retry,
              })
            : React.createElement('div', { className: 'fs-reports__empty' }, 'Could not load reports.'))
        : state.status === 'access_denied'
        ? (window.FieldSight.AccessDenied
            ? React.createElement(window.FieldSight.AccessDenied, {
                scope:   'the report archive',
                message: state.message,
              })
            : React.createElement('div', { className: 'fs-reports__empty' },
                'Access denied.'))
        : filtered.length === 0
        ? React.createElement('div', { className: 'fs-reports__empty' },
            'No ' + (filter === 'all' ? '' : filter + ' ') + 'reports yet.')
        : React.createElement('div', { className: 'fs-reports__list' },
            filtered.map(function (r) {
              var selected = selectedKey === r.key;
              return React.createElement('button', {
                key:       r.key,
                type:      'button',
                className: 'fs-reports__row' + (selected ? ' fs-reports__row--selected' : ''),
                onClick:   function () {
                  if (props.onSelect) {
                    props.onSelect(reportSelection(r));
                  }
                },
              },
                React.createElement(Badge, {
                  tone:    TYPE_TONE[r.type] || 'neutral',
                  size:    'sm',
                  variant: 'subtle',
                  className: 'fs-reports__row-type',
                }, TYPE_LABEL[r.type] || r.type),

                React.createElement('div', { className: 'fs-reports__row-main' },
                  React.createElement('div', { className: 'fs-reports__row-date' },
                    fmtDate(r.date)),
                  React.createElement('div', { className: 'fs-reports__row-meta' },
                    pendingRegenerationFor(localStore(), r.key, caller.folder_name, Date.now())
                      ? 'Generating… · ' + fmtGeneratedAt(r.generated_at)
                      : (r.author || '—') + ' · ' + fmtGeneratedAt(r.generated_at)),
                ),

                React.createElement('div', { className: 'fs-reports__row-size' },
                  fmtSize(r.size)),
              );
            }),
          ),
    );
  }

  /* =====================================================================
     ReportsRightDetail
     ===================================================================== */
  function ReportsRightDetail(props) {
    var Viewer = window.FieldSight && window.FieldSight.ReportViewerModal;
    var fs       = window.FieldSight;
    var Button   = fs.Button;
    var Badge    = fs.Badge;
    var IconBtn  = fs.IconButton;

    var sel = props.selectedItem;
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var canRegenerate = canRegenerateReport(caller, sel);

    var refConfirm = React.useState({ phase: 'idle' });
    var conf = refConfirm[0];
    var setConf = refConfirm[1];

    /* Read it here, rather than downloading a Word file to glance at
       yesterday. `viewer.status` carries loading/ok/error so a slow fetch is
       visible and a failed one says why — the modal opens on click, not when
       the content happens to arrive.

       ABOVE THE EARLY RETURN, with the other hooks. This sat further down,
       after the "nothing selected" placeholder returns, so React saw one hook
       on an empty pane and two once a report was picked: "Rendered more hooks
       than during the previous render", and the whole page replaced by an
       error boundary. Every test passed — the helpers are pure and the hook
       order is not something they can see. */
    /* Author of the selected report, read from the report itself. Only for the
       caller's own report: it is the one the caller may always open, and the
       file can be hundreds of KB. ABOVE the early return, with the other hooks. */
    var authorRef = React.useState(null);
    var author = authorRef[0];
    var setAuthor = authorRef[1];
    React.useEffect(authorEffect(caller, sel, setAuthor), [sel && sel.id, sel && sel.generated_at]);

    var viewRef = React.useState({ open: false, status: 'idle', report: null, error: '' });
    var viewer  = viewRef[0];
    var setView = viewRef[1];

    /* Reset the confirm state whenever a new report is selected -- unless the
       "new" selection is this same report refreshed after its regenerate. */
    React.useEffect(function () {
      var pending = sel ? pendingRegenerationFor(localStore(), sel.key, caller.folder_name, Date.now()) : null;
      if (pending && regenerationFinished(pending.before, sel, pending.beforeDocx)) {
        // It finished while this panel was not showing it.
        forgetPendingRegeneration(localStore(), sel.key);
        window.dispatchEvent(new CustomEvent('fs:reports-pending'));
        setConf({ phase: 'done', message: 'Updated ' + fmtGeneratedAt(sel.generated_at) });
        return;
      }
      if (pending) {
        setConf({ phase: 'waiting', key: sel.key, before: pending.before,
                  beforeDocx: pending.beforeDocx, startedAt: pending.startedAt });
        return;
      }
      setConf(function (c) { return c.phase === 'done' ? c : { phase: 'idle' }; });
    }, [sel && sel.id]);

    /* Follow a regenerate to completion. ABOVE the early return with the other
       hooks. Polls history until THIS report's generated_at moves past the value
       captured at click time; the generator can take up to 15 minutes. */
    React.useEffect(function () {
      if (conf.phase !== 'waiting') return undefined;
      var stopped = false;
      var deadline = conf.startedAt + 15 * 60 * 1000;
      var timer = setInterval(function () {
        if (stopped) return;
        if (Date.now() > deadline) {
          clearInterval(timer);
          forgetPendingRegeneration(localStore(), conf.key);
          window.dispatchEvent(new CustomEvent('fs:reports-pending'));
          setConf({ phase: 'timeout' });
          return;
        }
        window.FS.api.reports.getReportsHistory(50).then(function (res) {
          if (stopped) return;
          var fresh = ((res && res.reports) || []).filter(function (r) { return r.key === conf.key; })[0];
          if (regenerationFinished(conf.before, fresh, conf.beforeDocx)) {
            clearInterval(timer);
            forgetPendingRegeneration(localStore(), conf.key);
            window.dispatchEvent(new CustomEvent('fs:reports-pending'));
            setConf({ phase: 'done', message: 'Updated ' + fmtGeneratedAt(fresh.generated_at) });
            window.dispatchEvent(new CustomEvent('fs:reports-refresh', { detail: { key: conf.key } }));
          }
        });
      }, 10000);
      return function () { stopped = true; clearInterval(timer); };
    }, [conf.phase]);

    if (!sel || sel.kind !== 'report') {
      return React.createElement('div', { className: 'fs-reports-detail__placeholder' },
        React.createElement('div', { className: 'fs-reports-detail__placeholder-title' },
          'Select a report'),
        React.createElement('div', { className: 'fs-reports-detail__placeholder-body' },
          'Pick any row to download or regenerate.'),
      );
    }

    function onDownload() {
      downloadReport(sel);
    }

    function onView() {
      setView({ open: true, status: 'loading', report: null, error: '' });
      fetchReportJson(sel).then(function (json) {
        setView({ open: true, status: 'ok', report: json, error: '' });
      }).catch(function (err) {
        setView({ open: true, status: 'error', report: null,
                  error: (err && err.message) || 'Could not load this report.' });
      });
    }

    function onConfirmRegenerate() {
      var before = sel.generated_at;
      var beforeDocx = sel.docx_generated_at || '';
      var key = sel.key;
      setConf({ phase: 'submitting' });
      window.FS.api.reports.regenerate({
        report_type: sel.type, date: sel.date,
      }).then(function (res) {
        var problem = regenerateErrorMessage(res);
        if (problem) { setConf({ phase: 'error', error: { message: problem } }); return; }
        var startedAt = Date.now();
        rememberPendingRegeneration(localStore(), key,
          { before: before, beforeDocx: beforeDocx, startedAt: startedAt, folder: caller.folder_name });
        window.dispatchEvent(new CustomEvent('fs:reports-pending'));
        setConf({ phase: 'waiting', key: key, before: before, beforeDocx: beforeDocx, startedAt: startedAt });
      }).catch(function (err) {
        setConf({ phase: 'error', error: err });
      });
    }

    return React.createElement('div', { className: 'fs-reports-detail' },

      React.createElement('div', { className: 'fs-reports-detail__header' },
        React.createElement('div', { className: 'fs-reports-detail__header-main' },
          React.createElement('div', { className: 'fs-reports-detail__date' },
            fmtDate(sel.date)),
          React.createElement('div', { className: 'fs-reports-detail__metaline' },
            React.createElement(Badge, {
              tone:    TYPE_TONE[sel.type] || 'neutral',
              size:    'sm',
              variant: 'subtle',
            }, TYPE_LABEL[sel.type] || sel.type),
            sel.site ? React.createElement('span', {
              className: 'fs-reports-detail__site',
            }, sel.site) : null,
          ),
        ),
        IconBtn ? React.createElement(IconBtn, {
          icon: 'x', ariaLabel: 'Close detail', size: 'sm',
          onClick: function () { if (props.onClose) props.onClose(); },
        }) : null,
      ),

      React.createElement('div', { className: 'fs-reports-detail__rows' },
        React.createElement(DetailRow, {
          label: 'Generated', value: fmtGeneratedAt(sel.generated_at),
        }),
        React.createElement(DetailRow, {
          label: 'Author',    value: author || sel.author || '—',
        }),
        React.createElement(DetailRow, {
          label: 'File',
          /* The file the button will fetch, not the one the row is keyed on.
             Naming the .json here while the button sends the .docx would be
             the same mismatch in the other direction. */
          value: (downloadKeyFor(sel) || '').split('/').pop(),
          mono:  true,
        }),
        React.createElement(DetailRow, {
          label: 'Size',      value: fmtSize(sel.size),
        }),
      ),

      /* Action row */
      React.createElement('div', { className: 'fs-reports-detail__actions' },
        React.createElement(Button, {
          leftIcon: 'eye', size: 'sm', variant: 'primary',
          onClick: onView,
        }, 'View'),

        React.createElement(Button, {
          leftIcon: 'download', size: 'sm', variant: 'secondary',
          onClick: onDownload,
        }, downloadLabel(sel)),

        Viewer ? React.createElement(Viewer, {
          open:    viewer.open,
          status:  viewer.status,
          report:  viewer.report,
          error:   viewer.error,
          onClose: function () { setView({ open: false, status: 'idle', report: null, error: '' }); },
        }) : null,

        canRegenerate
          ? (conf.phase === 'idle'
              ? React.createElement(Button, {
                  variant: 'secondary', size: 'sm',
                  onClick: function () { setConf({ phase: 'confirm' }); },
                }, 'Regenerate')
              : conf.phase === 'confirm'
              ? React.createElement('div', { className: 'fs-reports-detail__confirm' },
                  React.createElement('span', null, 'Overwrite this report?'),
                  React.createElement(Button, {
                    size: 'sm', variant: 'danger',
                    onClick: onConfirmRegenerate,
                  }, 'Yes, regenerate'),
                  React.createElement(Button, {
                    size: 'sm', variant: 'ghost',
                    onClick: function () { setConf({ phase: 'idle' }); },
                  }, 'Cancel'),
                )
              : conf.phase === 'submitting'
              ? React.createElement('span', { className: 'fs-reports-detail__msg' },
                  'Queueing…')
              : conf.phase === 'waiting'
              ? React.createElement('span', { className: 'fs-reports-detail__msg' },
                  'Generating your report… this can take a few minutes.')
              : conf.phase === 'timeout'
              ? React.createElement('span', { className: 'fs-reports-detail__msg fs-reports-detail__msg--err' },
                  'No new report yet — check again later.')
              : conf.phase === 'done'
              ? React.createElement('span', {
                  className: 'fs-reports-detail__msg fs-reports-detail__msg--ok',
                }, '✓ ' + conf.message)
              : React.createElement('span', {
                  className: 'fs-reports-detail__msg fs-reports-detail__msg--err',
                }, 'Failed: ' + (conf.error && conf.error.message || 'unknown')))
          : null,
      ),
    );
  }

  function DetailRow(props) {
    return React.createElement('div', { className: 'fs-reports-detail__row' },
      React.createElement('div', { className: 'fs-reports-detail__row-label' },
        props.label),
      React.createElement('div', {
        className: 'fs-reports-detail__row-value' + (props.mono ? ' fs-reports-detail__row-value--mono' : ''),
      }, props.value),
    );
  }

  /* ---------- Register --------------------------------------------------- */
  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/reports'] = {
    Middle: ReportsMiddleColumn,
    Right:  ReportsRightDetail,
  };

})();
