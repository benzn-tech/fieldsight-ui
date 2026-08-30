/* ==========================================================================
   FieldSight RecordingDeleteModal — Layer 5 composite
   --------------------------------------------------------------------------
   The confirmation step for deleting recordings from /evidence.

   Its whole job is to make the confirm un-blind. The user selected rows
   labelled by time and topic COUNT; what they are actually about to remove is
   a set of named topics, and those live one page away in the timeline. So the
   modal lists them here — `topic.session_id` IS the backend's `session_base`
   (session_scope.session_ref), so the join needs no endpoint of its own.

   A recording whose topics could not be loaded says so rather than rendering
   an empty list: "we could not read this one" and "this one contains nothing"
   are different statements, and only one of them is safe to confirm against.

   Props:
     open        boolean
     rows        [{folder, date, sessionBase, label, topics:[{title}]|null}]
     busy        boolean — request in flight
     onConfirm   () => void
     onCancel    () => void

   Exported to:
     window.FieldSight.RecordingDeleteModal
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var MAX_TOPICS_SHOWN = 8;

  function TopicLines(props) {
    var topics = props.topics;
    /* null = never loaded / failed. Not the same as []. */
    if (topics == null) {
      return React.createElement('div', { className: 'fs-rec-delete__topics-unknown' },
        'Could not load this recording’s topics.');
    }
    if (!topics.length) {
      return React.createElement('div', { className: 'fs-rec-delete__topics-none' },
        'No topics were extracted from this recording.');
    }
    var shown = topics.slice(0, MAX_TOPICS_SHOWN);
    var rest  = topics.length - shown.length;
    return React.createElement('ul', { className: 'fs-rec-delete__topics' },
      shown.map(function (t, i) {
        return React.createElement('li', { key: i, className: 'fs-rec-delete__topic' },
          (t && (t.topic_title || t.title)) || 'Untitled topic');
      }),
      rest > 0
        ? React.createElement('li', {
            className: 'fs-rec-delete__topic fs-rec-delete__topic--more',
          }, '+ ' + rest + ' more')
        : null,
    );
  }

  function RecordingDeleteModal(props) {
    var ModalOverlay = window.FieldSight.ModalOverlay;
    var rows = props.rows || [];
    var total = rows.reduce(function (n, r) {
      return n + ((r.topics && r.topics.length) || 0);
    }, 0);
    var anyUnknown = rows.some(function (r) { return r.topics == null; });

    return React.createElement(ModalOverlay, {
      open: !!props.open,
      onClose: props.onCancel,
      title: 'Delete ' + rows.length + ' recording' + (rows.length === 1 ? '' : 's'),
      size: 'md',
      closeOnBackdrop: !props.busy,
    },
      React.createElement('div', { className: 'fs-rec-delete' },

        React.createElement('p', { className: 'fs-rec-delete__lead' },
          total > 0
            ? ('These ' + total + ' topic' + (total === 1 ? '' : 's')
               + ' will be deleted, along with their action items, findings and '
               + 'search results. Everyone loses access, including you.')
            : ('These recordings will be deleted, along with anything derived '
               + 'from them. Everyone loses access, including you.')),

        React.createElement('div', { className: 'fs-rec-delete__list' },
          rows.map(function (r) {
            return React.createElement('div', {
              key: r.folder + '|' + r.date + '|' + r.sessionBase,
              className: 'fs-rec-delete__row',
            },
              React.createElement('div', { className: 'fs-rec-delete__row-head' },
                React.createElement('span', { className: 'fs-rec-delete__row-date' },
                  r.date),
                React.createElement('span', { className: 'fs-rec-delete__row-label' },
                  r.label || r.sessionBase),
              ),
              React.createElement(TopicLines, { topics: r.topics }),
            );
          }),
        ),

        anyUnknown
          ? React.createElement('p', { className: 'fs-rec-delete__warn' },
              'Some recordings’ topics could not be read, so this list may be '
              + 'incomplete. Everything derived from every selected recording '
              + 'is still deleted.')
          : null,

        /* The restore window. 24 hours is how long the batch stays in the
           user's own list — see api/recording-deletion.js for what the
           backend actually does, which is not the same thing. */
        React.createElement('p', { className: 'fs-rec-delete__restore' },
          'You can restore this yourself for 24 hours, from '
          + 'Evidence → Recordings → Recent deletions.'),

        React.createElement('div', { className: 'fs-rec-delete__actions' },
          React.createElement('button', {
            type: 'button',
            className: 'fs-btn fs-btn--tertiary',
            onClick: props.onCancel,
            disabled: !!props.busy,
          }, 'Cancel'),
          React.createElement('button', {
            type: 'button',
            className: 'fs-btn fs-btn--danger',
            onClick: props.onConfirm,
            disabled: !!props.busy || rows.length === 0,
          }, props.busy ? 'Deleting…' : 'Delete'),
        ),
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.RecordingDeleteModal = RecordingDeleteModal;
})();
