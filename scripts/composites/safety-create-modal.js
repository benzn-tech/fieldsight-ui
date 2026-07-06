/* ==========================================================================
   FieldSight · SafetyCreateModal — Sprint 8.1.2
   --------------------------------------------------------------------------
   Modal form for raising a new safety observation. Opened by the
   "+ Raise Observation" button on /safety (gated: hse_manager or
   site_manager).

   Props:
     siteId    string    — current site context (passed by safety page)
     onSuccess fn(newFlag) — called after a successful POST; caller
                            prepends newFlag to the SafetyProvider list
     onCancel  fn        — called when user dismisses without submitting

   Fields:
     observation         Textarea, required
     risk_level          Select: low | medium | high, required
     recommended_action  Textarea, optional
     location            Input, optional
     photos              file input, multiple, accept image/*, max 5

   Live path (batch B Task 5 — orgAvailable = FS.api.org.createObservation
   exists && !useMocks):
     window.FS.api.org.createObservation({ kind: 'safety', site_slug,
       observation, risk_level, recommended_action })
     site_slug is siteId (FS.siteContext, passed in by the page) or, when
     nothing is anchored, the in-modal required Project select below.
     location/photo_keys are NOT part of this endpoint's body (Task 4
     scope) — the presignedPut upload block further down is dead
     (FS.api.media.presignedPut is not implemented anywhere in this repo)
     and is left in place untouched; its result is simply unused now.

   Mock path (useMocks, or no org.createObservation): builds a local flag
     object and calls onSuccess immediately — unchanged from Sprint 8.1.2.

   CSS: .fs-safety-create-modal in styles/composites.css

   Exported to: window.FieldSight.SafetyCreateModal
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var RISK_LEVELS = ['low', 'medium', 'high'];

  function SafetyCreateModal(props) {
    var fs          = window.FieldSight;
    var ModalOverlay = fs.ModalOverlay;
    var Button      = fs.Button;
    var Input       = fs.Input;

    var siteId    = props.siteId    || '';
    var onSuccess = props.onSuccess || function () {};
    var onCancel  = props.onCancel  || function () {};

    var refForm = React.useState({
      observation:        '',
      risk_level:         'medium',
      recommended_action: '',
      location:           '',
    });
    var form    = refForm[0];
    var setForm = refForm[1];

    var refPhotos = React.useState([]);
    var photos    = refPhotos[0];
    var setPhotos = refPhotos[1];

    var refStatus = React.useState('idle');  /* 'idle' | 'submitting' | 'error' */
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

    function onPhotoChange(e) {
      var files = Array.from(e.target.files || []).slice(0, 5);
      setPhotos(files);
    }

    function validate() {
      if (!form.observation.trim()) return 'Observation is required.';
      if (!form.risk_level) return 'Risk level is required.';
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
        var newFlag;

        if (orgAvailable) {
          /* Upload photos first (if any) — dead/guarded, left untouched
             (see header note): FS.api.media.presignedPut is not
             implemented anywhere, so photoKeys stays [] and is not
             forwarded to createObservation (its body has no photo_keys). */
          var photoKeys = [];
          if (photos.length > 0 && window.FS.api.media && window.FS.api.media.presignedPut) {
            photoKeys = await Promise.all(photos.map(async function (file) {
              var key = await window.FS.api.media.presignedPut(file.name, file.type);
              return key;
            }));
          }

          var obsRes = await window.FS.api.org.createObservation({
            kind:                'safety',
            site_slug:           siteValue,
            observation:         form.observation.trim(),
            risk_level:          form.risk_level,
            recommended_action:  form.recommended_action.trim() || null,
          });

          newFlag = {
            id:                 obsRes.id,
            date:               window.FS.api.todayNZDT(),
            observation:        form.observation.trim(),
            risk_level:         form.risk_level,
            recommended_action: form.recommended_action.trim() || null,
            location:           form.location.trim() || null,
            status:             obsRes.status,
            who_raised:         obsRes.author_name,
            source:             'manual',
            topic_id:           -1,
            topic_title:        'Site safety observations',
            site:               siteValue,
            author_name:        obsRes.author_name,
          };
        } else {
          /* Mock path — simulate network delay and build a local flag. */
          await window.FS.api.delay(400);
          var who = (window.AuthMock && window.AuthMock.currentUser && window.AuthMock.currentUser.name) || 'Unknown';
          newFlag = {
            id:                 'obs_' + Date.now(),
            date:               window.FS.api.todayNZDT(),
            observation:        form.observation.trim(),
            risk_level:         form.risk_level,
            recommended_action: form.recommended_action.trim() || null,
            location:           form.location.trim() || null,
            status:             'open',
            who_raised:         who,
            source:             'observation',
            topic_id:           -1,
            topic_title:        'Site safety observations',
            site:               siteId,
          };
        }

        /* Toast success. */
        var toast = window.FS && window.FS.toast;
        if (toast) toast.show({ message: 'Safety observation raised.', tone: 'success' });

        onSuccess(newFlag);
      } catch (fetchErr) {
        setStatus('error');
        setError((fetchErr && fetchErr.message) || 'Failed to raise observation. Please try again.');
        var toast2 = window.FS && window.FS.toast;
        if (toast2) {
          toast2.show({
            message: (fetchErr && fetchErr.message) || 'Failed to raise observation',
            tone:    'error',
          });
        }
      }
    }

    var isSubmitting  = status === 'submitting';
    var submitDisabled = isSubmitting || (needsSiteSelect && !selectedSite);

    var content = React.createElement('form', {
      className: 'fs-safety-create-modal',
      onSubmit:  handleSubmit,
    },
      React.createElement('h2', { className: 'fs-safety-create-modal__title' },
        'Raise Safety Observation'),

      /* Project (batch B Task 5) — required select when live and no
         project is anchored via FS.siteContext; read-only display when
         one is. Mock mode never renders either (byte-for-byte unchanged). */
      needsSiteSelect
        ? React.createElement('label', { className: 'fs-safety-create-modal__field' },
            React.createElement('span', { className: 'fs-safety-create-modal__label' },
              'Project ', React.createElement('span', { className: 'fs-safety-create-modal__required' }, '*')),
            React.createElement('select', {
              className: 'fs-safety-create-modal__select',
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
            ? React.createElement('label', { className: 'fs-safety-create-modal__field' },
                React.createElement('span', { className: 'fs-safety-create-modal__label' }, 'Project'),
                React.createElement('input', {
                  type:      'text',
                  className: 'fs-safety-create-modal__input',
                  value:     resolvedSiteName,
                  readOnly:  true,
                  disabled:  true,
                }),
              )
            : null),

      /* Observation */
      React.createElement('label', { className: 'fs-safety-create-modal__field' },
        React.createElement('span', { className: 'fs-safety-create-modal__label' },
          'Observation ', React.createElement('span', { className: 'fs-safety-create-modal__required' }, '*')),
        React.createElement('textarea', {
          className:   'fs-safety-create-modal__textarea',
          value:       form.observation,
          onChange:    function (e) { set('observation', e.target.value); },
          rows:        4,
          placeholder: 'Describe the safety concern…',
          required:    true,
          disabled:    isSubmitting,
        }),
      ),

      /* Risk level */
      React.createElement('label', { className: 'fs-safety-create-modal__field' },
        React.createElement('span', { className: 'fs-safety-create-modal__label' },
          'Risk level ', React.createElement('span', { className: 'fs-safety-create-modal__required' }, '*')),
        React.createElement('select', {
          className: 'fs-safety-create-modal__select',
          value:     form.risk_level,
          onChange:  function (e) { set('risk_level', e.target.value); },
          required:  true,
          disabled:  isSubmitting,
        },
          RISK_LEVELS.map(function (lvl) {
            return React.createElement('option', { key: lvl, value: lvl },
              lvl.charAt(0).toUpperCase() + lvl.slice(1));
          }),
        ),
      ),

      /* Recommended action */
      React.createElement('label', { className: 'fs-safety-create-modal__field' },
        React.createElement('span', { className: 'fs-safety-create-modal__label' },
          'Recommended action'),
        React.createElement('textarea', {
          className:   'fs-safety-create-modal__textarea',
          value:       form.recommended_action,
          onChange:    function (e) { set('recommended_action', e.target.value); },
          rows:        2,
          placeholder: 'Suggested corrective measure (optional)…',
          disabled:    isSubmitting,
        }),
      ),

      /* Location */
      React.createElement('label', { className: 'fs-safety-create-modal__field' },
        React.createElement('span', { className: 'fs-safety-create-modal__label' }, 'Location'),
        React.createElement('input', {
          type:        'text',
          className:   'fs-safety-create-modal__input',
          value:       form.location,
          onChange:    function (e) { set('location', e.target.value); },
          placeholder: 'e.g. Level 3, Grid B-4 (optional)',
          disabled:    isSubmitting,
        }),
      ),

      /* Photos */
      React.createElement('label', { className: 'fs-safety-create-modal__field' },
        React.createElement('span', { className: 'fs-safety-create-modal__label' },
          'Photos ', React.createElement('span', { className: 'fs-safety-create-modal__hint' }, '(max 5)')),
        React.createElement('input', {
          type:     'file',
          className: 'fs-safety-create-modal__file',
          accept:   'image/*',
          multiple: true,
          onChange: onPhotoChange,
          disabled: isSubmitting,
        }),
        photos.length > 0
          ? React.createElement('div', { className: 'fs-safety-create-modal__file-count' },
              photos.length + (photos.length === 1 ? ' photo selected' : ' photos selected'))
          : null,
      ),

      /* Validation error */
      errorMsg
        ? React.createElement('div', { className: 'fs-safety-create-modal__error', role: 'alert' },
            errorMsg)
        : null,

      /* Actions */
      React.createElement('div', { className: 'fs-safety-create-modal__actions' },
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
            }, isSubmitting ? 'Raising…' : 'Raise Observation')
          : React.createElement('button', { type: 'submit', disabled: submitDisabled },
              isSubmitting ? 'Raising…' : 'Raise Observation'),
      ),
    );

    if (ModalOverlay) {
      return React.createElement(ModalOverlay, { onClose: onCancel }, content);
    }
    /* Fallback when ModalOverlay isn't loaded yet. */
    return React.createElement('div', { className: 'fs-modal-overlay__backdrop' }, content);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.SafetyCreateModal = SafetyCreateModal;

})();
