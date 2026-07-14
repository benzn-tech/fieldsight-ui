/* ==========================================================================
   FieldSight · QualityCreateModal — Sprint 8.1.3
   --------------------------------------------------------------------------
   Modal form for logging a new quality item. Opened by the
   "+ Log Item" button on /quality (gated: quality_manager or site_manager).

   Props:
     siteId    string    — current site context
     onSuccess fn(newItem) — called after successful POST; caller prepends
                             newItem to the QualityProvider list
     onCancel  fn        — called when user dismisses without submitting

   Fields:
     observation        Textarea, required
     category           Select: quality | compliance | workmanship, required
     follow_up_required Checkbox, default true
     deadline           Input[type=date], optional
     location           Input, optional

   Live path (batch B Task 5 — orgAvailable = FS.api.org.createObservation
   exists && !useMocks):
     window.FS.api.org.createObservation({ kind: 'quality', site_slug,
       observation })
     site_slug is siteId (FS.siteContext, passed in by the page) or, when
     nothing is anchored, the in-modal required Project select below.
     category/follow_up_required/deadline/location are NOT part of this
     endpoint's body (Task 4 scope only covers kind/site_slug/observation/
     risk_level/recommended_action) — they are collected in the form for
     product parity but not sent live yet.

   Mock path (useMocks, or no org.createObservation): builds a local item
     object and calls onSuccess immediately — unchanged from Sprint 8.1.3.

   CSS: .fs-quality-create-modal in styles/composites.css

   Exported to: window.FieldSight.QualityCreateModal
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var CATEGORIES = ['quality', 'compliance', 'workmanship'];

  function QualityCreateModal(props) {
    var fs           = window.FieldSight;
    var ModalOverlay = fs.ModalOverlay;
    var Button       = fs.Button;

    var siteId    = props.siteId    || '';
    var onSuccess = props.onSuccess || function () {};
    var onCancel  = props.onCancel  || function () {};

    var refForm = React.useState({
      observation:        '',
      category:           'quality',
      follow_up_required: true,
      deadline:           '',
      location:           '',
    });
    var form    = refForm[0];
    var setForm = refForm[1];

    var refStatus = React.useState('idle');
    var status    = refStatus[0];
    var setStatus = refStatus[1];

    var refError = React.useState('');
    var errorMsg = refError[0];
    var setError = refError[1];

    /* Batch B Task 5 — live write path via FS.api.org.createObservation.
       isLive gates the in-modal project field (select vs read-only text);
       orgAvailable additionally requires the org API to actually exist and
       gates which branch handleSubmit takes. Neither check touches
       writeMocks — org.createObservation makes that call itself. */
    var isLive       = !window.FS.api.useMocks;
    var orgAvailable = !!(window.FS.api.org && window.FS.api.org.createObservation && isLive);

    var refSelectedSite = React.useState('');
    var selectedSite    = refSelectedSite[0];
    var setSelectedSite = refSelectedSite[1];

    var refSitesList = React.useState([]);
    var sitesList    = refSitesList[0];
    var setSitesList = refSitesList[1];

    /* One-shot fetch, mirrors the cancelled-guard pattern used by the
       header project selector (app-shell.js MiddleColumn). Only needed
       live: it feeds the required Project select's options (when siteId
       is unset) and resolves a display name for the read-only site line
       (when siteId IS set). Skipped entirely in mock mode. */
    React.useEffect(function () {
      if (!isLive) return undefined;
      var cancelled = false;
      window.FS.api.sites.getSites().then(function (res) {
        if (cancelled) return;
        setSitesList((res && res.sites) || []);
      }).catch(function () {
        if (cancelled) return;
        setSitesList([]);
      });
      return function () { cancelled = true; };
    }, []);

    var needsSiteSelect  = isLive && !siteId;
    var siteValue        = siteId || selectedSite;
    var resolvedSiteName = (function () {
      if (!siteId) return '';
      var match = sitesList.filter(function (s) { return s.site_id === siteId; })[0];
      return match ? match.name : siteId;
    })();

    function set(field, value) {
      setForm(function (f) { return Object.assign({}, f, { [field]: value }); });
    }

    function validate() {
      if (!form.observation.trim()) return 'Observation is required.';
      if (!form.category) return 'Category is required.';
      if (needsSiteSelect && !selectedSite) return 'Project is required.';
      return null;
    }

    async function handleSubmit(e) {
      e.preventDefault();
      var err = validate();
      if (err) { setError(err); return; }

      setStatus('submitting');
      setError('');

      try {
        var newItem;

        if (orgAvailable) {
          var obsRes = await window.FS.api.org.createObservation({
            kind:        'quality',
            site_slug:   siteValue,
            observation: form.observation.trim(),
          });
          /* 401/403/404 resolve as envelopes, not rejections (Fable batch-B
             review F3) — without this an expired session shows a success
             toast for a row that never persisted. */
          if (obsRes && (obsRes._accessDenied || obsRes._notFound)) {
            throw new Error(obsRes.error || 'Could not save observation — please retry');
          }

          newItem = {
            id:                obsRes.id,
            /* obs_id/author_sub/closed mirror the aggregator's row shape
               (Fable batch-B review F2); status uses the quality-page
               vocabulary — 'open' (org) renders as neutral, the aggregator
               maps open manual rows to 'observed' (review F4). */
            obs_id:            obsRes.id,
            author_sub:        obsRes.author_sub,
            closed:            false,
            date:              obsRes.report_date || window.FS.api.todayNZDT(),
            item:              form.observation.trim(),
            details:           null,
            category:          form.category,
            status:            'observed',
            follow_up_needed:  form.follow_up_required,
            who_raised:        obsRes.author_name,
            source:            'manual',
            topic_id:          -1,
            topic_title:       null,
            site:              siteValue,
            author_name:       obsRes.author_name,
          };
        } else {
          await window.FS.api.delay(400);
          var who = (window.AuthMock && window.AuthMock.currentUser && window.AuthMock.currentUser.name) || 'Unknown';
          newItem = {
            id:                'qc_' + Date.now(),
            date:              window.FS.api.todayNZDT(),
            item:              form.observation.trim(),
            details:           null,
            category:          form.category,
            status:            'observed',
            follow_up_needed:  form.follow_up_required,
            who_raised:        who,
            source:            'qc_item',
            topic_id:          -1,
            topic_title:       null,
            site:              siteId,
          };
        }

        var toast = window.FS && window.FS.toast;
        if (toast) toast.show({ message: 'Quality item logged.', tone: 'success' });

        onSuccess(newItem);
      } catch (fetchErr) {
        setStatus('error');
        setError((fetchErr && fetchErr.message) || 'Failed to log item. Please try again.');
        var toast2 = window.FS && window.FS.toast;
        if (toast2) toast2.show({ message: (fetchErr && fetchErr.message) || 'Failed to log quality item', tone: 'error' });
      }
    }

    var isSubmitting   = status === 'submitting';
    var submitDisabled = isSubmitting || (needsSiteSelect && !selectedSite);

    var content = React.createElement('form', {
      className: 'fs-quality-create-modal',
      onSubmit:  handleSubmit,
    },
      React.createElement('h2', { className: 'fs-quality-create-modal__title' },
        'Log Quality Item'),

      /* Project (batch B Task 5) — required select when live and no
         project is anchored via FS.siteContext; read-only display when
         one is. Mock mode never renders either (byte-for-byte unchanged). */
      needsSiteSelect
        ? React.createElement('label', { className: 'fs-quality-create-modal__field' },
            React.createElement('span', { className: 'fs-quality-create-modal__label' },
              'Project ', React.createElement('span', { className: 'fs-quality-create-modal__required' }, '*')),
            React.createElement('select', {
              className: 'fs-quality-create-modal__select',
              value:     selectedSite,
              onChange:  function (e) { setSelectedSite(e.target.value); },
              required:  true,
              disabled:  isSubmitting,
            },
              [React.createElement('option', { key: '__unset', value: '' }, 'Select a project…')].concat(
                sitesList.map(function (s) {
                  return React.createElement('option', { key: s.site_id, value: s.site_id }, s.name);
                }),
              ),
            ),
          )
        : (isLive && siteId
            ? React.createElement('label', { className: 'fs-quality-create-modal__field' },
                React.createElement('span', { className: 'fs-quality-create-modal__label' }, 'Project'),
                React.createElement('input', {
                  type:      'text',
                  className: 'fs-quality-create-modal__input',
                  value:     resolvedSiteName,
                  readOnly:  true,
                  disabled:  true,
                }),
              )
            : null),

      /* Observation */
      React.createElement('label', { className: 'fs-quality-create-modal__field' },
        React.createElement('span', { className: 'fs-quality-create-modal__label' },
          'Observation ', React.createElement('span', { className: 'fs-quality-create-modal__required' }, '*')),
        React.createElement('textarea', {
          className:   'fs-quality-create-modal__textarea',
          value:       form.observation,
          onChange:    function (e) { set('observation', e.target.value); },
          rows:        3,
          placeholder: 'Describe the quality concern…',
          required:    true,
          disabled:    isSubmitting,
        }),
      ),

      /* Category */
      React.createElement('label', { className: 'fs-quality-create-modal__field' },
        React.createElement('span', { className: 'fs-quality-create-modal__label' },
          'Category ', React.createElement('span', { className: 'fs-quality-create-modal__required' }, '*')),
        React.createElement('select', {
          className: 'fs-quality-create-modal__select',
          value:     form.category,
          onChange:  function (e) { set('category', e.target.value); },
          required:  true,
          disabled:  isSubmitting,
        },
          CATEGORIES.map(function (cat) {
            return React.createElement('option', { key: cat, value: cat },
              cat.charAt(0).toUpperCase() + cat.slice(1));
          }),
        ),
      ),

      /* Follow-up required */
      React.createElement('label', { className: 'fs-quality-create-modal__field fs-quality-create-modal__field--inline' },
        React.createElement('input', {
          type:     'checkbox',
          className: 'fs-quality-create-modal__checkbox',
          checked:  form.follow_up_required,
          onChange: function (e) { set('follow_up_required', e.target.checked); },
          disabled: isSubmitting,
        }),
        React.createElement('span', { className: 'fs-quality-create-modal__label' },
          'Follow-up required'),
      ),

      /* Deadline */
      React.createElement('label', { className: 'fs-quality-create-modal__field' },
        React.createElement('span', { className: 'fs-quality-create-modal__label' }, 'Deadline'),
        React.createElement('input', {
          type:      'date',
          className: 'fs-quality-create-modal__input',
          value:     form.deadline,
          onChange:  function (e) { set('deadline', e.target.value); },
          disabled:  isSubmitting,
        }),
      ),

      /* Location */
      React.createElement('label', { className: 'fs-quality-create-modal__field' },
        React.createElement('span', { className: 'fs-quality-create-modal__label' }, 'Location'),
        React.createElement('input', {
          type:        'text',
          className:   'fs-quality-create-modal__input',
          value:       form.location,
          onChange:    function (e) { set('location', e.target.value); },
          placeholder: 'e.g. Level 2, Zone A (optional)',
          disabled:    isSubmitting,
        }),
      ),

      errorMsg
        ? React.createElement('div', { className: 'fs-quality-create-modal__error', role: 'alert' },
            errorMsg)
        : null,

      React.createElement('div', { className: 'fs-quality-create-modal__actions' },
        Button
          ? React.createElement(Button, {
              type:     'button',
              variant:  'secondary',
              size:     'md',
              disabled: isSubmitting,
              onClick:  onCancel,
            }, 'Cancel')
          : React.createElement('button', { type: 'button', onClick: onCancel }, 'Cancel'),
        Button
          ? React.createElement(Button, {
              type:     'submit',
              variant:  'primary',
              size:     'md',
              disabled: submitDisabled,
            }, isSubmitting ? 'Logging…' : 'Log Item')
          : React.createElement('button', { type: 'submit', disabled: submitDisabled },
              isSubmitting ? 'Logging…' : 'Log Item'),
      ),
    );

    if (ModalOverlay) {
      return React.createElement(ModalOverlay, { onClose: onCancel }, content);
    }
    return React.createElement('div', { className: 'fs-modal-overlay__backdrop' }, content);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.QualityCreateModal = QualityCreateModal;

})();
