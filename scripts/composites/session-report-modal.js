/* ==========================================================================
   FieldSight SessionReportModal — Layer 5 composite (Delivery-C Tier-2)
   --------------------------------------------------------------------------
   The per-session report review flow: preview the company template, fill the
   confirmed fields (attendees / weather / sign-off), review, generate a
   Word/PDF, then download or email it. A thin wrapper over ModalOverlay
   (closeOnBackdrop:false — it holds unsaved form input), driving a step
   state-machine: preview -> fill -> review -> generating -> done | error.

   Backend = the F1 org client (scripts/api/org.js):
     org.getSessionReportPreview / generateSessionReport / getSessionReportStatus
   Async contract: generate -> {status:'queued', requestId}; poll status until
   done{docUrl,emailed} | error.

   The testable logic (buildGeneratePayload, interpretReportStatus) is factored
   into pure helpers + exported via module.exports for node --test — the same
   split as timeline.js's buildSessionEmailDraft. The React shell itself is not
   unit-tested (no DOM in the node harness), like the other L5 composites.

   Props:
     open        boolean
     onClose     () => void
     session     {session_id, participants[], ...} — the picked session
     date        string (YYYY-MM-DD)
     userFolder  string — the recording folder (org 'user' param)
     siteName    string?
     topics      array — the session's visible topics (for the preview)

   Exported to: window.FieldSight.SessionReportModal
   F3 fills PreviewStep, F4 FillStep, F6 the download/email done step.
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var STEPS = ['preview', 'fill', 'review', 'generating', 'done'];

  // ---- pure helpers (exported for node --test) --------------------------

  function buildGeneratePayload(ctx) {
    // ctx = {session, date, userFolder, form:{templateId,title,attendees,fields}, deliver, recipients}
    var form = (ctx && ctx.form) || {};
    var deliver = ctx && ctx.deliver === 'email' ? 'email' : 'download';
    return {
      sessionId: ctx && ctx.session ? ctx.session.session_id : undefined,
      date: ctx ? ctx.date : undefined,
      user: ctx ? ctx.userFolder : undefined,
      templateId: form.templateId || null,
      title: (form.title || '').trim(),
      attendees: Array.isArray(form.attendees) ? form.attendees : [],
      fields: form.fields || {},
      deliver: deliver,
      // recipients only travel when emailing (download has no addressees)
      recipients: deliver === 'email' && Array.isArray(ctx.recipients) ? ctx.recipients : [],
    };
  }

  function interpretReportStatus(res) {
    // Map a generate / status response to a UI phase. Mirrors the F1 client's
    // envelopes: {_accessDenied}/{_notFound} (never thrown), {status:'unavailable'}
    // (gated off), and the async {queued|done|error} contract.
    if (!res || res._accessDenied) return { phase: 'error', message: 'You don’t have access to this report.' };
    if (res._notFound) return { phase: 'error', message: 'Session not found.' };
    var status = res.status;
    if (status === 'done') return { phase: 'done', docUrl: res.docUrl || null, emailed: !!res.emailed };
    if (status === 'error') return { phase: 'error', message: res.error || 'Report generation failed.' };
    if (status === 'unavailable') return { phase: 'error', message: 'Report generation is unavailable here.' };
    return { phase: 'pending' };   // queued / pending / anything not yet terminal
  }

  function previewFieldDefaults(preview) {
    // The editable defaults the modal pre-fills from the preview response
    // (session_report_preview.fieldDefaults), with top-level fallbacks.
    var d = (preview && preview.fieldDefaults) || {};
    return {
      title: d.title || (preview && preview.title) || '',
      attendees: Array.isArray(d.attendees) ? d.attendees
               : (Array.isArray(preview && preview.participants) ? preview.participants : []),
    };
  }

  // ---- React shell (browser only; not exercised by node tests) ----------

  function SessionReportModal(props) {
    var h = React.createElement;
    var ModalOverlay = (window.FieldSight || {}).ModalOverlay;
    var org = (((window.FS || {}).api) || {}).org || {};

    var s_step = React.useState('preview'); var step = s_step[0], setStep = s_step[1];
    var s_form = React.useState({ templateId: null, title: '', attendees: [], fields: {} });
    var form = s_form[0], setForm = s_form[1];   // setForm seeds defaults (F3) + F4's FillStep
    var s_preview = React.useState(null); var preview = s_preview[0], setPreview = s_preview[1];
    var s_pverr = React.useState(null); var previewErr = s_pverr[0], setPreviewErr = s_pverr[1];
    var s_deliver = React.useState('download'); var deliver = s_deliver[0];
    var s_recip = React.useState([]); var recipients = s_recip[0];
    var s_req = React.useState(null); var reqId = s_req[0], setReqId = s_req[1];
    var s_result = React.useState(null); var result = s_result[0], setResult = s_result[1];
    var s_error = React.useState(null); var error = s_error[0], setError = s_error[1];

    function sid() { return props.session ? props.session.session_id : null; }

    // Reset the wizard whenever it (re)opens.
    React.useEffect(function () {
      if (props.open) {
        setStep('preview'); setReqId(null); setResult(null); setError(null);
        setPreview(null); setPreviewErr(null);
      }
    }, [props.open]);

    // F3 — on open, fetch the assembled preview (the backend renders the session's
    // content into the report shape) and seed the editable field defaults. The
    // client returns the content or a benign {_accessDenied}/{_notFound}/
    // {status:'unavailable'} envelope (never throws) — surface those as an error.
    React.useEffect(function () {
      if (!props.open || !org.getSessionReportPreview) return undefined;
      var alive = true;
      Promise.resolve(org.getSessionReportPreview({
        sessionId: sid(), date: props.date, user: props.userFolder,
      })).then(function (res) {
        if (!alive) return;
        if (!res || res._accessDenied || res._notFound || res.status === 'unavailable') {
          setPreviewErr((res && res.error) || 'Preview is unavailable here.'); return;
        }
        setPreview(res);
        var d = previewFieldDefaults(res);
        setForm(function (f) {
          return { templateId: f.templateId, title: d.title, attendees: d.attendees, fields: f.fields };
        });
      }).catch(function () { if (alive) setPreviewErr('Could not load the preview.'); });
      return function () { alive = false; };
    }, [props.open]);

    // F5 — poll the async status while generating, until a terminal phase.
    React.useEffect(function () {
      if (step !== 'generating' || !reqId) return undefined;
      var alive = true, timer = null;
      function tick() {
        if (!alive) return;
        Promise.resolve(org.getSessionReportStatus({
          sessionId: sid(), date: props.date, user: props.userFolder, requestId: reqId,
        })).then(function (res) {
          if (!alive) return;
          var v = interpretReportStatus(res);
          if (v.phase === 'done') { setResult(v); setStep('done'); }
          else if (v.phase === 'error') { setError(v.message); setStep('error'); }
          else { timer = setTimeout(tick, 2000); }
        }).catch(function () {
          if (alive) { setError('Could not check the report status.'); setStep('error'); }
        });
      }
      tick();
      return function () { alive = false; if (timer) clearTimeout(timer); };
    }, [step, reqId]);

    function onGenerate() {
      setError(null); setStep('generating');
      var payload = buildGeneratePayload({
        session: props.session, date: props.date, userFolder: props.userFolder,
        form: form, deliver: deliver, recipients: recipients,
      });
      Promise.resolve(org.generateSessionReport(payload)).then(function (res) {
        var v = interpretReportStatus(res);
        if (v.phase === 'error') { setError(v.message); setStep('error'); return; }
        if (v.phase === 'done') { setResult(v); setStep('done'); return; }
        if (res && res.requestId) { setReqId(res.requestId); }      // hands off to the poll effect
        else { setError('The report did not start.'); setStep('error'); }
      }).catch(function () { setError('Could not start report generation.'); setStep('error'); });
    }

    function btn(label, onClick, variant) {
      return h('button', {
        type: 'button', className: 'fs-btn' + (variant ? ' fs-btn--' + variant : ''), onClick: onClick,
      }, label);
    }

    // Step bodies — placeholders for F3 (preview) / F4 (fill) / F6 (done UI).
    var body;
    if (step === 'preview') {
      if (previewErr) {
        body = h('div', { className: 'fs-srm__step fs-srm__step--error' }, h('p', null, previewErr));
      } else if (!preview) {
        body = h('div', { className: 'fs-srm__step' }, h('p', { className: 'fs-srm__hint' }, 'Loading preview…'));
      } else {
        body = h('div', { className: 'fs-srm__step fs-srm__preview' },
          h('h3', { className: 'fs-srm__preview-title' }, preview.title || 'Session report'),
          h('p', { className: 'fs-srm__preview-meta' }, [preview.siteName, preview.date].filter(Boolean).join(' · ')),
          (preview.participants && preview.participants.length)
            ? h('p', { className: 'fs-srm__preview-attendees' }, 'Attendees: ' + preview.participants.join(', ')) : null,
          h('div', { className: 'fs-srm__preview-topics' },
            (preview.topics || []).map(function (t, i) {
              return h('div', { key: i, className: 'fs-srm__preview-topic' },
                h('h4', null, t.topic_title || t.title || ('Topic ' + (i + 1))),
                t.summary ? h('p', null, t.summary) : null,
                (t.action_items && t.action_items.length)
                  ? h('ul', { className: 'fs-srm__preview-actions' },
                      t.action_items.map(function (a, j) {
                        return h('li', { key: j },
                          (a.action || a.text || '') + (a.responsible ? ' — ' + a.responsible : ''));
                      }))
                  : null);
            })));
      }
    } else if (step === 'fill') {
      body = h('div', { className: 'fs-srm__step' },
        h('p', { className: 'fs-srm__hint' }, 'Confirm attendees, weather and sign-off (F4).'));
    } else if (step === 'review') {
      body = h('div', { className: 'fs-srm__step' },
        h('p', { className: 'fs-srm__hint' }, 'Review, then generate the report.'));
    } else if (step === 'generating') {
      body = h('div', { className: 'fs-srm__step' }, h('p', null, 'Generating your report…'));
    } else if (step === 'done') {
      body = h('div', { className: 'fs-srm__step' },
        h('p', null, (result && result.emailed) ? 'Report emailed.' : 'Report ready.'),
        (result && result.docUrl) ? h('a', { href: result.docUrl, className: 'fs-btn fs-btn--primary' }, 'Download') : null);
    } else {  // error
      body = h('div', { className: 'fs-srm__step fs-srm__step--error' },
        h('p', null, error || 'Something went wrong.'));
    }

    var footer;
    if (step === 'preview') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Cancel', props.onClose), btn('Next', function () { setStep('fill'); }, 'primary'));
    else if (step === 'fill') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Back', function () { setStep('preview'); }), btn('Next', function () { setStep('review'); }, 'primary'));
    else if (step === 'review') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Back', function () { setStep('fill'); }), btn('Generate report', onGenerate, 'primary'));
    else if (step === 'generating') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Cancel', props.onClose));
    else if (step === 'done') footer = h('footer', { className: 'fs-srm__footer' },
      btn('Done', props.onClose, 'primary'));
    else footer = h('footer', { className: 'fs-srm__footer' },
      btn('Back', function () { setStep('review'); }), btn('Close', props.onClose));

    return h(ModalOverlay, {
      open: !!props.open, onClose: props.onClose, closeOnBackdrop: false,
      size: 'lg', title: 'Session report',
    }, h('div', { className: 'fs-srm' }, body, footer));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.SessionReportModal = SessionReportModal;

  // Pure-helper export for node --test (browser ignores this).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildGeneratePayload: buildGeneratePayload, interpretReportStatus: interpretReportStatus, previewFieldDefaults: previewFieldDefaults, STEPS: STEPS };
  }
})();
