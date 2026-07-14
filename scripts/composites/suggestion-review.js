/* ==========================================================================
   FieldSight SuggestionReview — Layer 5 composite (Sprint 11 — programme<->
   item feedback, Task 6 UI)
   --------------------------------------------------------------------------
   Review queue for session-sourced programme-task suggestions (backend
   Tasks 1-5, live on TEST): each row proposes a status/progress update to
   one programme task, derived from a report topic, awaiting PM/CM
   confirmation before it lands on the task. See scripts/api/programme.js
   for the getSuggestions/confirmSuggestion/rejectSuggestion contract.

   Controlled list: the CALLER owns fetching (scripts/pages/programme.js's
   ProgrammeProvider fetches once via getSuggestions and holds the list in
   ctx.suggestionsState, so both this queue and the page's pending-count
   badge read the same source of truth without a duplicate network call).
   This component owns per-card MUTATION state (busy / inline error /
   "Adjust…" draft) and calls confirmSuggestion/rejectSuggestion directly
   (same self-contained-composite pattern as ActionItemRow's toggleAction
   and SafetyCreateModal's createObservation) — on success it calls
   props.onResolved(id) so the caller can drop the row from the shared list.

   Props:
     suggestions   array of suggestion rows (see api/programme.js header
                   for the row shape) — required
     siteSlug      report-side site slug (window.FS.siteContext /
                   api/sites.js identifier) used ONLY to build the evidence
                   deep-link's &site= param. May be null/undefined when the
                   org-UUID -> report-slug bridge can't resolve it (see
                   scripts/pages/sites.js ~line 575 — same parked identity
                   gap); the deep-link degrades to date+topicTitle only,
                   same graceful-omission the AskChat citation deep-link
                   already uses when c.site_slug is absent.
     onResolved    (id) => void — called after a successful confirm/reject
     emptyText     optional override for the empty-state copy

   Exported to:
     window.FieldSight.SuggestionReview
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var STATUS_OPTIONS = [
    { value: 'not_started', label: 'Not started' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'completed',   label: 'Done' },
    { value: 'blocked',     label: 'Blocked' },
    { value: 'delayed',     label: 'Delayed' },
  ];

  var STATUS_LABEL = {
    not_started: 'Not started',
    in_progress: 'In progress',
    completed:   'Done',
    blocked:     'Blocked',
    delayed:     'Delayed',
  };

  function statusLabel(v) {
    if (v == null || v === '') return '—';
    return STATUS_LABEL[v] || v;
  }

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  function confidenceTone(c) {
    var n = Number(c);
    if (Number.isNaN(n)) return 'neutral';
    if (n >= 0.75) return 'success';
    if (n >= 0.5)  return 'warning';
    return 'neutral';
  }

  /* Reads err thrown by _fetch.js's request() (409/other non-ok status —
     rejects with err.status + err.body === parsed JSON), OR a resolved
     _accessDenied/_notFound envelope (403/404 — those resolve, not
     reject). Either shape can carry the backend's { error } message. */
  function errorMessage(errOrRes, fallback) {
    if (!errOrRes) return fallback;
    if (errOrRes.body && errOrRes.body.error) return errOrRes.body.error;
    if (errOrRes.error) return errOrRes.error;
    if (errOrRes.message) return errOrRes.message;
    return fallback;
  }

  function SuggestionCard(props) {
    var fs       = window.FieldSight;
    var Badge    = fs.Badge;
    var Button   = fs.Button;
    var Select   = fs.Select;
    var Input    = fs.Input;
    var ErrorBanner = fs.ErrorBanner;

    var row      = props.row;
    var siteSlug = props.siteSlug;
    var onResolved = props.onResolved || function () {};

    var refAdjusting = React.useState(false);
    var adjusting    = refAdjusting[0];
    var setAdjusting = refAdjusting[1];

    var refDraft = React.useState({
      status:       row.suggested_status || '',
      progress_pct: row.suggested_progress != null ? String(row.suggested_progress) : '',
    });
    var draft    = refDraft[0];
    var setDraft = refDraft[1];

    var refBusy  = React.useState(false);
    var busy     = refBusy[0];
    var setBusy  = refBusy[1];

    var refError = React.useState(null);
    var errMsg   = refError[0];
    var setError = refError[1];

    var evidence = row.match_evidence || {};

    function openEvidence() {
      if (!(window.FS && window.FS.Router)) return;
      var url = '/timeline?date=' + encodeURIComponent(row.report_date || '')
        + '&topicTitle=' + encodeURIComponent(row.topic_title || '');
      /* siteSlug is a best-effort UUID->slug match (see module header) —
         omit rather than send a wrong identifier, same as AskChat's
         citation deep-link only appending &site= when it has one. */
      if (siteSlug) url += '&site=' + encodeURIComponent(siteSlug);
      window.FS.Router.navigate(url);
    }

    function doConfirm(overrides) {
      if (busy) return;
      setBusy(true);
      setError(null);
      window.FS.api.programme.confirmSuggestion(row.id, overrides || {}).then(function (res) {
        setBusy(false);
        if (res && (res._accessDenied || res._notFound)) {
          setError(errorMessage(res, 'Could not confirm this suggestion.'));
          return;
        }
        if (res && res.confirmed) {
          if (window.FS.toast) {
            window.FS.toast.show({ message: 'Suggestion confirmed', tone: 'success' });
          }
          setAdjusting(false);
          onResolved(row.id);
          return;
        }
        setError('Could not confirm this suggestion.');
      }).catch(function (err) {
        setBusy(false);
        /* 409 = programme changed since suggestion / task no longer in
           programme — surface the backend's message, not a generic one. */
        setError(errorMessage(err, 'Could not confirm this suggestion. Try again.'));
      });
    }

    function doReject() {
      if (busy) return;
      setBusy(true);
      setError(null);
      window.FS.api.programme.rejectSuggestion(row.id).then(function (res) {
        setBusy(false);
        if (res && (res._accessDenied || res._notFound)) {
          setError(errorMessage(res, 'Could not reject this suggestion.'));
          return;
        }
        if (res && res.rejected) {
          if (window.FS.toast) {
            window.FS.toast.show({ message: 'Suggestion rejected', tone: 'info' });
          }
          onResolved(row.id);
          return;
        }
        setError('Could not reject this suggestion.');
      }).catch(function (err) {
        setBusy(false);
        setError(errorMessage(err, 'Could not reject this suggestion. Try again.'));
      });
    }

    var hasProgressDelta = row.suggested_progress != null;
    var hasStatusDelta    = !!row.suggested_status;

    return React.createElement('div', { className: 'fs-suggestion-review__card' },

      React.createElement('div', { className: 'fs-suggestion-review__card-head' },
        React.createElement('div', { className: 'fs-suggestion-review__card-topic' }, row.topic_title),
        row.confidence != null
          ? React.createElement(Badge, {
              tone: confidenceTone(row.confidence), size: 'sm', variant: 'subtle',
            }, Math.round(row.confidence * 100) + '% match')
          : null,
      ),

      row.topic_summary
        ? React.createElement('div', { className: 'fs-suggestion-review__card-summary' }, row.topic_summary)
        : null,

      React.createElement('div', { className: 'fs-suggestion-review__card-meta' },
        fmtDate(row.report_date),
        React.createElement('button', {
          type: 'button',
          className: 'fs-suggestion-review__card-link',
          onClick: openEvidence,
          title: 'Open this topic on /timeline',
        }, 'View source topic →'),
      ),

      React.createElement('div', { className: 'fs-suggestion-review__card-target' },
        React.createElement('span', { className: 'fs-suggestion-review__card-target-label' }, 'Task \xb7 '),
        React.createElement('span', { className: 'fs-suggestion-review__card-target-name' }, row.task_name),
      ),

      React.createElement('div', { className: 'fs-suggestion-review__card-delta' },
        hasStatusDelta
          ? React.createElement('span', { className: 'fs-suggestion-review__card-delta-item' },
              'Status ' + statusLabel(row.task_status_before) + ' → ' + statusLabel(row.suggested_status))
          : null,
        hasProgressDelta
          ? React.createElement('span', { className: 'fs-suggestion-review__card-delta-item' },
              'Progress ' + (row.task_progress_before != null ? row.task_progress_before : '—')
                + '% → ' + row.suggested_progress + '%')
          : null,
      ),

      evidence.llm_evidence
        ? React.createElement('div', { className: 'fs-suggestion-review__card-evidence' },
            '“' + evidence.llm_evidence + '”')
        : null,

      evidence.assignee_overlap
        ? React.createElement(Badge, {
            tone: 'info', size: 'sm', variant: 'outline',
            className: 'fs-suggestion-review__card-chip',
          }, 'Assignee overlap')
        : null,

      errMsg
        ? React.createElement(ErrorBanner, { message: errMsg, mini: true, retryable: false })
        : null,

      adjusting
        ? React.createElement('div', { className: 'fs-suggestion-review__adjust' },
            React.createElement('div', { className: 'fs-suggestion-review__adjust-row' },
              React.createElement(Select, {
                label: 'Status', size: 'sm',
                value: draft.status,
                placeholder: 'No status change',
                options: STATUS_OPTIONS,
                onChange: function (e) { setDraft(Object.assign({}, draft, { status: e.target.value })); },
              }),
              React.createElement(Input, {
                label: 'Progress (%)', size: 'sm', type: 'number', min: 0, max: 100,
                value: draft.progress_pct,
                onChange: function (e) { setDraft(Object.assign({}, draft, { progress_pct: e.target.value })); },
              }),
            ),
            React.createElement('div', { className: 'fs-suggestion-review__adjust-actions' },
              React.createElement(Button, {
                variant: 'primary', size: 'sm', loading: busy,
                onClick: function () {
                  var overrides = {};
                  if (draft.status)                   overrides.status = draft.status;
                  if (draft.progress_pct !== '' && draft.progress_pct != null) {
                    overrides.progress_pct = Number(draft.progress_pct);
                  }
                  doConfirm(overrides);
                },
              }, 'Confirm with changes'),
              React.createElement(Button, {
                variant: 'tertiary', size: 'sm', disabled: busy,
                onClick: function () { setAdjusting(false); setError(null); },
              }, 'Cancel'),
            ),
          )
        : React.createElement('div', { className: 'fs-suggestion-review__card-actions' },
            React.createElement(Button, {
              variant: 'primary', size: 'sm', loading: busy,
              onClick: function () { doConfirm({}); },
            }, 'Confirm'),
            React.createElement(Button, {
              variant: 'secondary', size: 'sm', disabled: busy,
              onClick: function () { setAdjusting(true); setError(null); },
            }, 'Adjust…'),
            React.createElement(Button, {
              variant: 'danger', size: 'sm', loading: busy,
              onClick: doReject,
            }, 'Reject'),
          ),
    );
  }

  function SuggestionReview(props) {
    var rows      = props.suggestions || [];
    var siteSlug  = props.siteSlug;
    var onResolved = props.onResolved || function () {};

    return React.createElement('div', { className: 'fs-suggestion-review' },
      React.createElement('div', { className: 'fs-suggestion-review__header' },
        React.createElement('h3', { className: 'fs-suggestion-review__title' },
          'Suggested updates ',
          React.createElement('span', { className: 'fs-suggestion-review__count' }, '(' + rows.length + ')')),
      ),
      rows.length === 0
        ? React.createElement('div', { className: 'fs-suggestion-review__empty' },
            props.emptyText || 'No pending suggestions for this project.')
        : React.createElement('div', { className: 'fs-suggestion-review__list' },
            rows.map(function (row) {
              return React.createElement(SuggestionCard, {
                key: row.id, row: row, siteSlug: siteSlug, onResolved: onResolved,
              });
            }),
          ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.SuggestionReview = SuggestionReview;

})();
