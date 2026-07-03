/* ==========================================================================
   FieldSight /insights — Sprint 9 Track A.1
   --------------------------------------------------------------------------
   PM-facing analytics dashboard. Aggregates safety + quality issues over
   a date window (default last 7 days; switchable to 30 days, All, or a
   custom range via the shared RangeToolbar — date-range batch Task B)
   and surfaces three focusable views:

     • KPI strip — totals + week-over-week deltas (7d/30d only; All and
       Custom have no natural "period before" to diff against, so the
       delta badges are hidden for those two)
     • Top-5 subcontractors (with risk-level segmentation per bar)
     • Top-5 tags (with linked top-subcontractor caption)
     • 14-day daily-count sparkline
     • Drill-down: clicking a sub or tag filters the row list below
                   and pivots the right detail to that profile

   No new backend endpoints; reuses compliance-aggregator + the new
   insights-aggregator (Sprint 9 A.0/A.1). Permission gate:
   `insights:view` (added to roles.js for SM, PM, HSE, QC, gm,
   director, admin in this sprint).

   Registers as window.FieldSight.PAGES['/insights'].
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* ─── Helpers ────────────────────────────────────────────────────── */

  function fmtDateLabel(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = yyyymmdd.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    var months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getUTCDate() + ' ' + months[d.getUTCMonth()];
  }

  /* Prior-period delta is only meaningful for the trailing-window presets
     ('7d'/'30d' — both always end "today", per FS.api.window.resolve),
     never for 'all' or an arbitrary 'custom' span: there's no natural
     "period before" a custom range and 'all' has nothing earlier to
     compare against. Returns null for those, and callers hide the delta
     badges accordingly (Task B). */
  function priorRangeFor(preset, today) {
    if (preset !== '7d' && preset !== '30d') return null;
    var span = preset === '30d' ? 30 : 7;
    return {
      from: window.FS.api.addDaysISO(today, -(span * 2 - 1)),
      to:   window.FS.api.addDaysISO(today, -span),
    };
  }

  /* ─── Provider ───────────────────────────────────────────────────── */

  var InsightsContext = React.createContext(null);

  function InsightsProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};

    /* Permission gate (matches NAV_ITEMS gating in fs-globals.js,
       defense in depth: a direct URL hit lands here too). */
    var canSee = window.FS && window.FS.can && window.FS.can(caller, 'insights:view');

    /* fs.settings.insightsView holds { preset, from, to } — persisted and
       restored by the shared RangeToolbar composite (Task B). Default
       preset stays '7d' ("Last 7 days") — the pre-Task-B default — with
       'all'/'custom' newly available alongside it. */
    var refView = React.useState({ preset: '7d', from: null, to: null });
    var view = refView[0]; var setView = refView[1];

    var refSel = React.useState(null);    /* { kind: 'sub'|'tag', id } */
    var sel = refSel[0]; var setSel = refSel[1];

    var refState = React.useState({ status: canSee ? 'loading' : 'access_denied' });
    var state = refState[0]; var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    React.useEffect(function () {
      if (!canSee) {
        setState({ status: 'access_denied', message: 'Insights requires the insights:view permission.' });
        return undefined;
      }
      /* RangeToolbar resolves the range asynchronously (e.g. 'all' needs
         FS.api.window.getSpan()) — wait for both ends before fetching. */
      if (!view.from || !view.to) return undefined;
      var cancelled = false;
      setState({ status: 'loading' });

      var today    = window.FS.api.todayNZDT();
      var current  = { from: view.from, to: view.to };
      /* null for 'all'/'custom' — no natural "period before" to diff
         against, so no prior fetch and no delta badges (Task B). */
      var previous = priorRangeFor(view.preset, today);

      Promise.all([
        window.FS.api.insights.getInsights({
          from: current.from, to: current.to, kind: 'all',
        }),
        previous
          ? window.FS.api.insights.getInsights({ from: previous.from, to: previous.to, kind: 'all' })
          : Promise.resolve(null),
      ]).then(function (results) {
        if (cancelled) return;
        var cur  = results[0];
        var prev = results[1];

        if ((cur.safety && cur.safety._accessDenied) ||
            (cur.quality && cur.quality._accessDenied)) {
          var denied = (cur.safety && cur.safety._accessDenied) ? cur.safety : cur.quality;
          setState({ status: 'access_denied', message: denied.error });
          return;
        }

        setState({
          status:   'ok',
          range:    { preset: view.preset, current: current, previous: previous, today: today },
          safety:   cur.safety  || emptySection(),
          quality:  cur.quality || emptySection(),
          previous: prev ? {
            safety:  (prev.safety  && !prev.safety._accessDenied)  ? prev.safety  : emptySection(),
            quality: (prev.quality && !prev.quality._accessDenied) ? prev.quality : emptySection(),
          } : null,
        });
      }).catch(function (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          error: {
            code:      (err && err.status)  || 0,
            message:   (err && err.message) || 'Could not load insights',
            retryable: true,
          },
          retry:  function () { setRetry(function (n) { return n + 1; }); },
        });
      });

      return function () { cancelled = true; };
    }, [view.preset, view.from, view.to, retryCount, canSee]);

    var ctx = {
      state:      state,
      view:       view,
      setView:    function (next) { setSel(null); setView(next); },
      selection:  sel,
      setSelection: setSel,
      caller:     caller,
    };

    return React.createElement(InsightsContext.Provider, { value: ctx },
      props.children);
  }

  function emptySection() {
    return { rows: [], bySub: [], byTag: [], byDay: [], totals: { count: 0, high: 0, medium: 0, low: 0, distinct_subs: 0, distinct_tags: 0 } };
  }

  /* ─── KPI strip ──────────────────────────────────────────────────── */

  function InsightsKpis(props) {
    var fs       = window.FieldSight;
    var KpiStrip = fs.KpiStrip;
    var StatCard = fs.StatCard;
    var TrendPill= fs.TrendPill;

    var safety       = props.safety;
    var quality      = props.quality;
    var prevSafety   = props.prevSafety;
    var prevQuality  = props.prevQuality;

    /* Task B: prevSafety/prevQuality are null for 'all'/'custom' ranges
       (no matched-length "period before" to diff against) — hide the
       delta badges rather than diffing against nothing. */
    var safetyDelta  = prevSafety  ? safety.totals.count  - prevSafety.totals.count  : null;
    var qualityDelta = prevQuality ? quality.totals.count - prevQuality.totals.count : null;

    var topSub = safety.bySub[0] || quality.bySub[0] || null;
    var topTag = safety.byTag[0] || quality.byTag[0] || null;

    return React.createElement(KpiStrip, null,
      React.createElement(StatCard, {
        value: safety.totals.count, label: 'Safety issues',
        tone: safety.totals.high > 0 ? 'danger' : 'neutral',
        footer: (TrendPill && safetyDelta != null) ? React.createElement(TrendPill, {
          delta: safetyDelta, unit: '', polarity: 'lower_better',
        }) : null,
      }),
      React.createElement(StatCard, {
        value: quality.totals.count, label: 'Quality issues',
        tone: quality.totals.count > 0 ? 'warning' : 'neutral',
        footer: (TrendPill && qualityDelta != null) ? React.createElement(TrendPill, {
          delta: qualityDelta, unit: '', polarity: 'lower_better',
        }) : null,
      }),
      React.createElement(StatCard, {
        value: topSub ? topSub.name : '—',
        label: topSub ? 'Top subcontractor (' + topSub.count + ')' : 'Top subcontractor',
        tone:  'neutral',
      }),
      React.createElement(StatCard, {
        value: topTag ? topTag.label : '—',
        label: topTag ? 'Top tag (' + topTag.count + ')' : 'Top tag',
        tone:  'neutral',
      }),
    );
  }

  /* ─── Section · Top-N subcontractors ─────────────────────────────── */

  function TopSubcontractors(props) {
    var fs       = window.FieldSight;
    var BarStack = fs.BarStack;
    var ctx      = props.ctx;
    var section  = props.section;       /* safety or quality slice */
    var kindLabel = props.kindLabel;
    if (!BarStack) return null;

    /* Compose data for the bar stack. Risk-level segmentation lets
       PMs see at-a-glance how dangerous each sub's issues are. */
    var data = section.bySub.slice(0, 5).map(function (b) {
      return {
        key:      b.subcontractor_id,
        label:    b.name,
        meta:     b.trade ? b.trade : null,
        value:    b.count,
        selected: ctx.selection && ctx.selection.kind === 'sub'
                  && ctx.selection.id === b.subcontractor_id,
        segments: [
          { value: b.high,   tone: 'danger',  label: 'High: '   + b.high   },
          { value: b.medium, tone: 'warning', label: 'Medium: ' + b.medium },
          { value: b.low,    tone: 'success', label: 'Low: '    + b.low    },
        ].filter(function (s) { return s.value > 0; }),
      };
    });

    return React.createElement('section', { className: 'fs-insights__section' },
      React.createElement('div', { className: 'fs-insights__section-header' },
        React.createElement('h3', { className: 'fs-insights__section-title' },
          'Top subcontractors · ' + kindLabel),
        React.createElement('div', { className: 'fs-insights__section-meta' },
          section.totals.distinct_subs + ' distinct'),
      ),
      React.createElement(BarStack, {
        data:     data,
        emptyText: 'No ' + kindLabel.toLowerCase() + ' issues attributed to a subcontractor in this range.',
        onSelect: function (row) {
          if (!row.key || row.key === 'unknown') return;
          ctx.setSelection({ kind: 'sub', id: row.key });
        },
      }),
    );
  }

  /* ─── Section · Top-N tags ───────────────────────────────────────── */

  function TopTags(props) {
    var fs       = window.FieldSight;
    var BarStack = fs.BarStack;
    var ins      = window.FS && window.FS.insights;
    var ctx      = props.ctx;
    var section  = props.section;
    var kindLabel = props.kindLabel;
    if (!BarStack) return null;

    /* Sprint 9.5.7 — pull each tag's categorical hue from
       TAG_VOCAB.color so the 5 bars are distinguishable by hue
       (red / orange / amber / green / blue / etc.) rather than
       by 5 shades of the same tone family. */
    var data = section.byTag.slice(0, 5).map(function (b) {
      var topSub = b.top_subcontractor && ins
        ? ins.subcontractorById(b.top_subcontractor)
        : null;
      var meta = topSub ? 'Most-often: ' + topSub.name : null;
      var voc  = (ins ? ins.TAG_VOCAB : []).filter(function (v) { return v.slug === b.tag; })[0];
      var tone     = voc ? voc.tone  : 'accent';
      var tagColor = voc ? voc.color : null;
      return {
        key:      b.tag,
        label:    b.label,
        meta:     meta,
        value:    b.count,
        tone:     tone,
        selected: ctx.selection && ctx.selection.kind === 'tag'
                  && ctx.selection.id === b.tag,
        segments: [{ value: b.count, tone: tone, color: tagColor }],
      };
    });

    return React.createElement('section', { className: 'fs-insights__section' },
      React.createElement('div', { className: 'fs-insights__section-header' },
        React.createElement('h3', { className: 'fs-insights__section-title' },
          'Top tags · ' + kindLabel),
        React.createElement('div', { className: 'fs-insights__section-meta' },
          section.totals.distinct_tags + ' distinct'),
      ),
      React.createElement(BarStack, {
        data:     data,
        emptyText: 'No tagged ' + kindLabel.toLowerCase() + ' issues in this range.',
        onSelect: function (row) {
          ctx.setSelection({ kind: 'tag', id: row.key });
        },
      }),
    );
  }

  /* ─── Section · Daily trend sparkline ────────────────────────────── */

  function DailyTrend(props) {
    var fs        = window.FieldSight;
    var SparkLine = fs.SparkLine;
    var section   = props.section;
    var kindLabel = props.kindLabel;
    if (!SparkLine) return null;

    var points = section.byDay.map(function (d) {
      return { date: d.date, value: d.count, label: fmtDateLabel(d.date) };
    });

    return React.createElement('section', { className: 'fs-insights__section fs-insights__section--inline' },
      React.createElement('div', { className: 'fs-insights__inline-label' }, kindLabel + ' trend'),
      React.createElement(SparkLine, {
        points: points, tone: kindLabel === 'Quality' ? 'info' : 'danger',
        width: 280, height: 48, showLastValue: true,
      }),
    );
  }

  /* ─── Section · Hot word cloud (Sprint 9.5.5) ───────────────────── */

  function HotWordCloud(props) {
    var fs        = window.FieldSight;
    var WordCloud = fs.WordCloud;
    var ins       = window.FS && window.FS.insights;
    var ctx       = props.ctx;
    var safety    = props.safety;
    var quality   = props.quality;
    if (!WordCloud || !ins) return null;

    /* Combine safety + quality tag counts into a single frequency
       map. Each tag pulled from TAG_VOCAB so we get its colour +
       label even when count is 0 (renders at minFontPx). */
    var counts = {};
    [safety.byTag, quality.byTag].forEach(function (arr) {
      (arr || []).forEach(function (b) {
        counts[b.tag] = (counts[b.tag] || 0) + (b.count || 0);
      });
    });
    var data = ins.TAG_VOCAB.map(function (v) {
      return {
        slug:  v.slug,
        label: v.label,
        count: counts[v.slug] || 0,
        color: v.color,
        tone:  v.tone,
      };
    }).filter(function (t) { return t.count > 0; });
    /* If everything is zero, render a placeholder via WordCloud's
       emptyText. */
    var sel = ctx.selection && ctx.selection.kind === 'tag'
      ? ctx.selection.id : null;

    return React.createElement('section', { className: 'fs-insights__section' },
      React.createElement('div', { className: 'fs-insights__section-header' },
        React.createElement('h3', { className: 'fs-insights__section-title' },
          'Hot tags'),
        React.createElement('div', { className: 'fs-insights__section-meta' },
          data.length + ' tag' + (data.length === 1 ? '' : 's') + ' active'),
      ),
      React.createElement(WordCloud, {
        data:     data,
        selected: sel,
        onSelect: function (slug) {
          ctx.setSelection(
            ctx.selection && ctx.selection.kind === 'tag' && ctx.selection.id === slug
              ? null
              : { kind: 'tag', id: slug }
          );
        },
        emptyText: 'No tagged issues in this range.',
      }),
    );
  }

  /* ─── Section · Sub × tag heatmap (Sprint 9.5.5) ─────────────────── */

  function SubTagHeatmap(props) {
    var fs          = window.FieldSight;
    var HeatmapGrid = fs.HeatmapGrid;
    var ins         = window.FS && window.FS.insights;
    var ctx         = props.ctx;
    var safety      = props.safety;
    var quality     = props.quality;
    if (!HeatmapGrid || !ins) return null;

    /* Walk every row across safety + quality, build sub→tag matrix.
       Skip rows without subcontractor_id (otherwise the matrix has
       a useless 'unknown' bucket dominating the visual). */
    var subRowsBySub = {};        /* { subId: { subId, name, total } } */
    var matrix       = {};
    function visit(rows) {
      (rows || []).forEach(function (r) {
        var subId = r.subcontractor_id;
        if (!subId) return;
        if (!subRowsBySub[subId]) {
          var sub = ins.subcontractorById(subId);
          subRowsBySub[subId] = {
            id:    subId,
            label: sub ? sub.name  : subId,
            sub:   sub ? sub.trade : null,
            total: 0,
          };
        }
        subRowsBySub[subId].total += 1;
        if (!matrix[subId]) matrix[subId] = {};
        (r.tags || []).forEach(function (slug) {
          matrix[subId][slug] = (matrix[subId][slug] || 0) + 1;
        });
      });
    }
    visit(safety.rows);
    visit(quality.rows);

    /* Top 8 subs by total — keeps the matrix scannable. */
    var rowList = Object.keys(subRowsBySub)
      .map(function (k) { return subRowsBySub[k]; })
      .sort(function (a, b) { return b.total - a.total; })
      .slice(0, 8);

    var colList = ins.TAG_VOCAB.map(function (v) {
      return { id: v.slug, label: v.label, color: v.color, tone: v.tone };
    });

    function onCell(subId, tagSlug) {
      /* Toggle filter: clicking the same selection clears it. */
      var cur = ctx.selection;
      if (cur && cur.kind === 'sub' && cur.id === subId) {
        ctx.setSelection({ kind: 'tag', id: tagSlug });
      } else {
        ctx.setSelection({ kind: 'sub', id: subId });
      }
    }

    return React.createElement('section', { className: 'fs-insights__section' },
      React.createElement('div', { className: 'fs-insights__section-header' },
        React.createElement('h3', { className: 'fs-insights__section-title' },
          'Subcontractor × tag heatmap'),
        React.createElement('div', { className: 'fs-insights__section-meta' },
          rowList.length + ' sub' + (rowList.length === 1 ? '' : 's') + ' shown'),
      ),
      React.createElement(HeatmapGrid, {
        rows:     rowList,
        cols:     colList,
        matrix:   matrix,
        onSelect: onCell,
        emptyText: 'No attributed issues in this range.',
      }),
    );
  }

  /* ─── Section · Drill-down rows ──────────────────────────────────── */

  function DrillDown(props) {
    var fs        = window.FieldSight;
    var Card      = fs.Card;
    var Badge     = fs.Badge;
    var ctx       = props.ctx;
    var safety    = props.safety;
    var quality   = props.quality;
    var sel       = ctx.selection;
    if (!sel) return null;

    function matches(r) {
      if (sel.kind === 'sub') return r.subcontractor_id === sel.id;
      if (sel.kind === 'tag') return (r.tags || []).indexOf(sel.id) >= 0;
      return false;
    }
    var rows = []
      .concat((safety.rows  || []).filter(matches).map(function (r) { return Object.assign({ _kind: 'safety'  }, r); }))
      .concat((quality.rows || []).filter(matches).map(function (r) { return Object.assign({ _kind: 'quality' }, r); }))
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });

    var title = sel.kind === 'sub'
      ? ('Issues attributed to ' + (rows[0] && rows[0].subcontractor_id ? '' : '') + (sel.id || ''))
      : ('Issues tagged ' + sel.id);

    return React.createElement('section', { className: 'fs-insights__section' },
      React.createElement('div', { className: 'fs-insights__section-header' },
        React.createElement('h3', { className: 'fs-insights__section-title' },
          rows.length + ' matching issue' + (rows.length === 1 ? '' : 's')),
        React.createElement('button', {
          type: 'button',
          className: 'fs-insights__clear',
          onClick: function () { ctx.setSelection(null); },
        }, 'Clear filter'),
      ),
      rows.length === 0
        ? React.createElement('div', { className: 'fs-insights__empty' },
            'No matches in the current range.')
        : React.createElement('ul', { className: 'fs-insights__rows', role: 'list' },
            rows.map(function (r) {
              return React.createElement('li', {
                key:        r.id,
                className:  'fs-insights__row fs-insights__row--' + r._kind,
              },
                React.createElement('div', { className: 'fs-insights__row-meta' },
                  React.createElement(Badge, {
                    tone: r._kind === 'safety' ? 'danger' : 'info', size: 'sm',
                  }, r._kind === 'safety' ? 'Safety' : 'Quality'),
                  r.risk_level
                    ? React.createElement(Badge, { tone: 'neutral', size: 'sm', variant: 'outline' },
                        r.risk_level)
                    : null,
                  React.createElement('span', { className: 'fs-insights__row-date' },
                    fmtDateLabel(r.date)),
                ),
                React.createElement('div', { className: 'fs-insights__row-text' },
                  r.observation || r.item || '(no description)'),
                r.user_name ? React.createElement('div', { className: 'fs-insights__row-attrib' },
                  'Raised by ' + (r.who_raised || r.user_name)
                  + (r.site ? ' · ' + r.site : '')) : null,
              );
            }),
          ),
    );
  }

  /* ─── Middle column ──────────────────────────────────────────────── */

  function InsightsMiddleColumn() {
    var fs           = window.FieldSight;
    var AccessDenied = fs.AccessDenied;
    var ErrorBanner  = fs.ErrorBanner;
    var RangeToolbar = fs.RangeToolbar;

    var ctx = React.useContext(InsightsContext);
    if (!ctx) return null;

    var state = ctx.state;
    var header = React.createElement('div', { className: 'fs-insights__header' },
      React.createElement('h2', { className: 'fs-insights__title' }, 'Insights'),
      React.createElement('div', { className: 'fs-insights__subtitle' },
        'Cross-report safety + quality patterns. Closed 12-tag vocab.'),
    );
    var toolbar = RangeToolbar
      ? React.createElement(RangeToolbar, {
          value:      ctx.view,
          onChange:   ctx.setView,
          presets:    ['7d', '30d', 'all', 'custom'],
          storageKey: 'fs.settings.insightsView',
        })
      : null;

    if (state.status === 'access_denied') {
      return React.createElement('div', { className: 'fs-insights' },
        header,
        AccessDenied
          ? React.createElement(AccessDenied, { scope: 'insights', message: state.message })
          : React.createElement('div', { className: 'fs-insights__empty' }, state.message),
      );
    }

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-insights' },
        header,
        toolbar,
        React.createElement('div', { className: 'fs-insights__loading' }, 'Aggregating…'),
      );
    }

    if (state.status === 'error') {
      return React.createElement('div', { className: 'fs-insights' },
        header,
        toolbar,
        ErrorBanner ? React.createElement(ErrorBanner, {
          message:   (state.error && state.error.message) || 'Could not load insights',
          retryable: true,
          onRetry:   state.retry,
        }) : null,
      );
    }

    var safety      = state.safety;
    var quality     = state.quality;
    var prevSafety  = state.previous ? state.previous.safety  : null;
    var prevQuality = state.previous ? state.previous.quality : null;

    /* Sprint 9.5.5 — full-width 2-column dashboard layout. The
       previous stacked-panel layout (4 separate top-N panels) is
       replaced with a 2×2 grid of charts that share a unified
       drill-down filter. Quality top-N panels were dropped since
       quality data still surfaces via word cloud + heatmap +
       trend; carrying separate quality bars below was duplicative. */
    return React.createElement('div', { className: 'fs-insights' },
      header,
      toolbar,
      React.createElement(InsightsKpis, {
        safety:      safety,      quality:      quality,
        prevSafety:  prevSafety,  prevQuality:  prevQuality,
      }),

      /* Row 1 — top-5 subs (left) | hot word cloud (right) */
      React.createElement('div', { className: 'fs-insights__row-2col' },
        React.createElement(TopSubcontractors, {
          ctx: ctx, section: safety, kindLabel: 'Safety',
        }),
        React.createElement(HotWordCloud, {
          ctx: ctx, safety: safety, quality: quality,
        }),
      ),

      /* Row 2 — top-5 tags (left) | trend pair (right) */
      React.createElement('div', { className: 'fs-insights__row-2col' },
        React.createElement(TopTags, {
          ctx: ctx, section: safety, kindLabel: 'Safety',
        }),
        React.createElement('div', { className: 'fs-insights__trend-stack' },
          React.createElement(DailyTrend, { section: safety,  kindLabel: 'Safety'  }),
          React.createElement(DailyTrend, { section: quality, kindLabel: 'Quality' }),
        ),
      ),

      /* Full width — subcontractor × tag heatmap */
      React.createElement(SubTagHeatmap, {
        ctx: ctx, safety: safety, quality: quality,
      }),

      /* Drill-down (only when something is selected) */
      React.createElement(DrillDown, {
        ctx: ctx, safety: safety, quality: quality,
      }),
    );
  }

  /* ─── Right detail · selected sub or tag profile ─────────────────── */

  function InsightsRightDetail() {
    var fs         = window.FieldSight;
    var Card       = fs.Card;
    var SparkLine  = fs.SparkLine;
    var ins        = window.FS && window.FS.insights;
    var ctx        = React.useContext(InsightsContext);
    if (!ctx) return null;

    var sel = ctx.selection;
    var state = ctx.state;

    if (!sel || state.status !== 'ok') {
      return React.createElement('div', { className: 'fs-insights-detail__placeholder' },
        React.createElement('div', { className: 'fs-insights-detail__placeholder-title' },
          'Select a subcontractor or tag'),
        React.createElement('div', { className: 'fs-insights-detail__placeholder-body' },
          'Pick any bar in the lists to see its full profile, trend, and matching issues.'),
      );
    }

    if (sel.kind === 'sub') {
      var sub = ins ? ins.subcontractorById(sel.id) : null;
      var safetyBucket  = (state.safety.bySub  || []).filter(function (b) { return b.subcontractor_id === sel.id; })[0];
      var qualityBucket = (state.quality.bySub || []).filter(function (b) { return b.subcontractor_id === sel.id; })[0];

      /* Build a per-day series for this sub by walking byDay totals
         and counting our rows on each date. */
      var subRows = [].concat(safetyBucket ? safetyBucket.rows : [])
                       .concat(qualityBucket ? qualityBucket.rows : []);
      var subPoints = state.safety.byDay.map(function (d) {
        var n = subRows.filter(function (r) { return r.date === d.date; }).length;
        return { date: d.date, value: n };
      });

      return React.createElement('div', { className: 'fs-insights-detail' },
        React.createElement('div', { className: 'fs-insights-detail__header' },
          React.createElement('h2', { className: 'fs-insights-detail__name' },
            sub ? sub.name : 'Unattributed'),
          sub ? React.createElement('div', { className: 'fs-insights-detail__sub' },
            sub.trade) : null,
        ),
        SparkLine ? React.createElement(SparkLine, {
          points: subPoints, tone: 'danger', width: 320, height: 56,
        }) : null,
        React.createElement('div', { className: 'fs-insights-detail__rows' },
          React.createElement(DetailRow, { label: 'Safety issues',
            value: safetyBucket ? safetyBucket.count.toString() : '0' }),
          React.createElement(DetailRow, { label: 'High-risk safety',
            value: safetyBucket ? safetyBucket.high.toString() : '0' }),
          React.createElement(DetailRow, { label: 'Quality issues',
            value: qualityBucket ? qualityBucket.count.toString() : '0' }),
          sub ? React.createElement(DetailRow, { label: 'Sites',
            value: (sub.sites || []).join(', ') }) : null,
        ),
      );
    }

    if (sel.kind === 'tag') {
      var voc = (ins ? ins.TAG_VOCAB : []).filter(function (v) { return v.slug === sel.id; })[0];
      var tagSafety  = (state.safety.byTag  || []).filter(function (b) { return b.tag === sel.id; })[0];
      var tagQuality = (state.quality.byTag || []).filter(function (b) { return b.tag === sel.id; })[0];

      var tagRows = [].concat(tagSafety  ? tagSafety.rows  : [])
                       .concat(tagQuality ? tagQuality.rows : []);
      var tagPoints = state.safety.byDay.map(function (d) {
        var n = tagRows.filter(function (r) { return r.date === d.date; }).length;
        return { date: d.date, value: n };
      });

      var topSub = (tagSafety && tagSafety.top_subcontractor)
        ? (ins ? ins.subcontractorById(tagSafety.top_subcontractor) : null)
        : null;

      return React.createElement('div', { className: 'fs-insights-detail' },
        React.createElement('div', { className: 'fs-insights-detail__header' },
          React.createElement('h2', { className: 'fs-insights-detail__name' },
            voc ? voc.label : sel.id),
          React.createElement('div', { className: 'fs-insights-detail__sub' },
            'Tag · ' + sel.id),
        ),
        SparkLine ? React.createElement(SparkLine, {
          points: tagPoints, tone: voc ? voc.tone : 'accent',
          width: 320, height: 56,
        }) : null,
        React.createElement('div', { className: 'fs-insights-detail__rows' },
          React.createElement(DetailRow, { label: 'Safety hits',
            value: tagSafety ? tagSafety.count.toString() : '0' }),
          React.createElement(DetailRow, { label: 'Quality hits',
            value: tagQuality ? tagQuality.count.toString() : '0' }),
          React.createElement(DetailRow, { label: 'Most-often subcontractor',
            value: topSub ? topSub.name : '—' }),
        ),
      );
    }

    return null;
  }

  function DetailRow(props) {
    return React.createElement('div', { className: 'fs-insights-detail__row' },
      React.createElement('div', { className: 'fs-insights-detail__row-label' },
        props.label),
      React.createElement('div', { className: 'fs-insights-detail__row-value' },
        props.value),
    );
  }

  /* ─── Register ───────────────────────────────────────────────────── */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/insights'] = {
    Provider: InsightsProvider,
    Middle:   InsightsMiddleColumn,
    Right:    InsightsRightDetail,
    layout:   'full-width',   /* Sprint 9.5.1 — 2-panel canvas, drill-down via RightDrawer */
  };

})();
