/* ==========================================================================
   FieldSight · TemplateDigitiseReview
   --------------------------------------------------------------------------
   The draft a form was read into, beside the form itself, for a person to
   check before anything is saved (pipeline spec 2026-10-16 section 5).
   Controlled: the draft lives in the upload modal, so a Save the server
   refuses (a name already taken) comes back here with every edit intact.
   Every edit is one of the pure ops in api/template-digitise.js.

   Props:
     draft     { sections:[{title, items:[{text, flags}], flags}], flags:[] }
     sources   [{ key, url, contentType }]   presigned, from the poll
     error     string                        a refused Save, shown above the buttons
     saving    bool
     onChange  fn(draft)   onSave fn(draft)   onCancel fn

   The one piece of local state is the last delete, so it can be undone: a
   field worker on a tablet taps x next to an arrow, and a confirm dialog on
   every delete would be worse than one Undo. The next edit drops it.

   The draft-level "too many sections" / "too long" warnings are worked out
   from the draft as it stands, never the server's flags from the read --
   those would stay up after the person had already merged below the limit.

   CSS: §TEMPLATE-DIGITISE in styles/composites.css
   Exported to: window.FieldSight.TemplateDigitiseReview
                (and .problemFor(draft), for the modal's Save check)
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var DERIVED_FLAGS = ['too_many_sections', 'too_long'];
  var MAX_SECTIONS = 40;
  /* About how many characters fit on one line of an item box in the narrowest
     layout (phone, tools wrapped below the text). Over-estimating rows costs a
     blank line; under-estimating hides text behind an inner scroll. */
  var CHARS_PER_ROW = 40;

  function el() { return React.createElement.apply(React, arguments); }
  function itemsOf(s) { return (s && s.items) || []; }

  function rowsFor(text) {
    return String(text || '').split('\n').reduce(function (n, line) {
      return n + Math.max(1, Math.ceil(line.length / CHARS_PER_ROW));
    }, 0);
  }

  /* bodyProblem (api/template-digitise.js) numbers sections in the SAVE BODY,
     which leaves out sections with no items. Map its "Section N" back to the
     section the person sees, so the message names the card it is on. */
  function problemFor(draft) {
    var TD = window.FS.api.templateDigitise;
    var sections = (draft && draft.sections) || [];
    var body = TD.toTemplateBody(draft || {});
    var message = TD.bodyProblem(body);
    if (!message) return null;
    var kept = [];
    sections.forEach(function (s, i) {
      var any = itemsOf(s).some(function (it) {
        var t = typeof it === 'string' ? it : ((it && it.text) || '');
        return t.trim() !== '';
      });
      if (any) kept.push(i);
    });
    var m = /^Section (\d+)(.*)$/.exec(message);
    if (m && kept[Number(m[1]) - 1] !== undefined) {
      var at = kept[Number(m[1]) - 1];
      return { message: 'Section ' + (at + 1) + m[2], sectionIndex: at, bodySections: body.sections.length };
    }
    return { message: message, sectionIndex: null, bodySections: body.sections.length };
  }

  function draftFlags(draft, problem) {
    var flags = (draft.flags || []).filter(function (f) { return DERIVED_FLAGS.indexOf(f) < 0; });
    if (problem && problem.sectionIndex === null) {
      if (problem.bodySections > MAX_SECTIONS) flags.push('too_many_sections');
      else if (problem.bodySections > 0) flags.push('too_long');
    }
    return flags;
  }

  function SourcePane(props) {
    return el('div', { className: 'fs-tpl-digitise__source', role: 'region', 'aria-label': 'Your form' },
      (props.sources || []).map(function (s, i) {
        var ct = s.contentType || '';
        if (ct.indexOf('image/') === 0) {
          return el('img', { key: s.key, className: 'fs-tpl-digitise__page', src: s.url,
                             alt: 'Page ' + (i + 1) + ' of your form' });
        }
        if (ct === 'application/pdf') {
          /* The link first and styled as a button: an embedded PDF on an iPad
             often shows only its first page. */
          return el('div', { key: s.key, className: 'fs-tpl-digitise__doc' },
            el('a', { className: 'fs-tpl-digitise__open-pdf', href: s.url, target: '_blank', rel: 'noopener' },
               'Open the PDF in a new tab'),
            el('iframe', { className: 'fs-tpl-digitise__pdf', src: s.url, title: 'Your form (PDF)' }));
        }
        return el('div', { key: s.key, className: 'fs-tpl-digitise__doc' },
          el('p', null, 'Word file — read straight from its tables, so there is no page picture to compare against.'),
          el('a', { href: s.url }, 'Download the Word file'));
      }));
  }

  function Flags(props) {
    var TD = window.FS.api.templateDigitise;
    var flags = props.flags || [];
    if (!flags.length) return null;
    return el('ul', { className: 'fs-tpl-digitise__flags' },
      flags.map(function (f) { return el('li', { key: f }, TD.FLAG_TEXT[f] || f); }));
  }

  function tool(label, aria, disabled, onClick, extra) {
    return el('button', { type: 'button', className: 'fs-tpl-digitise__tool' + (extra ? ' ' + extra : ''),
                          'aria-label': aria, title: aria, disabled: disabled, onClick: onClick }, label);
  }

  function TemplateDigitiseReview(props) {
    /* Hooks first, before anything can return. */
    var undoState = React.useState(null);
    var undo = undoState[0];
    var setUndo = undoState[1];

    var Button = window.FieldSight.Button;
    var TD = window.FS.api.templateDigitise;
    var ops = TD.ops;
    var draft = props.draft;
    var sections = draft.sections || [];
    var total = sections.reduce(function (n, s) { return n + itemsOf(s).length; }, 0);
    var problem = problemFor(draft);

    function change(next) { setUndo(null); props.onChange(next); }
    function remove(next, what, i, j) {
      setUndo({ prev: draft, what: what, i: i, j: j });
      props.onChange(next);
    }
    function undoBar(key, tag) {
      return el(tag, { key: key, className: 'fs-tpl-digitise__undo', role: 'status' },
        el('span', null, undo.what === 'section' ? 'Section deleted.' : 'Item deleted.'),
        el(Button, { variant: 'secondary', onClick: function () { var prev = undo.prev; setUndo(null); props.onChange(prev); } },
           'Undo'));
    }

    function sectionCard(s, i) {
      var items = itemsOf(s);
      var last = i === sections.length - 1;
      var rows = items.map(function (it, j) {
        var text = (it && it.text) || '';
        return el('li', { key: 'i' + j, className: 'fs-tpl-digitise__item'
                                     + ((it.flags || []).length ? ' fs-tpl-digitise__item--flagged' : '') },
          el('textarea', { className: 'fs-tpl-upload__textarea fs-tpl-digitise__item-text', rows: rowsFor(text),
                           value: text, 'aria-label': 'Section ' + (i + 1) + ', item ' + (j + 1),
                           onChange: function (e) { change(ops.editItem(draft, i, j, e.target.value)); } }),
          el(Flags, { flags: it.flags }),
          el('div', { className: 'fs-tpl-digitise__item-tools' },
            tool('↑', 'Move item up', j === 0, function () { change(ops.moveItem(draft, i, j, -1)); }),
            tool('↓', 'Move item down', j === items.length - 1, function () { change(ops.moveItem(draft, i, j, 1)); }),
            tool('×', 'Delete item', false, function () { remove(ops.deleteItem(draft, i, j), 'item', i, j); },
                 'fs-tpl-digitise__tool--delete')));
      });
      if (undo && undo.what === 'item' && undo.i === i) {
        rows.splice(Math.min(undo.j, rows.length), 0, undoBar('undo', 'li'));
      }
      var sectionProblem = problem && problem.sectionIndex === i ? problem.message : null;
      return el('section', { key: 's' + i, className: 'fs-tpl-digitise__section'
                                       + ((s.flags || []).length || sectionProblem ? ' fs-tpl-digitise__section--flagged' : '') },
        el('div', { className: 'fs-tpl-digitise__section-head' },
          el('span', { className: 'fs-tpl-digitise__section-no' }, 'Section ' + (i + 1)),
          el('input', { className: 'fs-tpl-upload__input', value: s.title || '',
                        'aria-label': 'Section ' + (i + 1) + ' name',
                        onChange: function (e) { change(ops.renameSection(draft, i, e.target.value)); } }),
          el('span', { className: 'fs-tpl-digitise__count' },
             items.length + (items.length === 1 ? ' item' : ' items'))),
        el(Flags, { flags: s.flags }),
        sectionProblem ? el('p', { className: 'fs-tpl-digitise__problem' }, sectionProblem) : null,
        el('ol', { className: 'fs-tpl-digitise__items' }, rows),
        el('div', { className: 'fs-tpl-digitise__section-tools' },
          el(Button, { variant: 'ghost', onClick: function () { change(ops.addItem(draft, i)); } }, '+ Add item'),
          el(Button, { variant: 'ghost', disabled: i === 0, onClick: function () { change(ops.moveSection(draft, i, -1)); } }, 'Move up'),
          el(Button, { variant: 'ghost', disabled: last, onClick: function () { change(ops.moveSection(draft, i, 1)); } }, 'Move down'),
          el(Button, { variant: 'ghost', disabled: last, onClick: function () { change(ops.mergeWithNext(draft, i)); } }, 'Merge with next'),
          el(Button, { variant: 'ghost', className: 'fs-tpl-digitise__delete-section',
                       onClick: function () { remove(ops.deleteSection(draft, i), 'section', i); } }, 'Delete section')));
    }

    var cards = sections.map(sectionCard);
    if (undo && undo.what === 'section') cards.splice(Math.min(undo.i, cards.length), 0, undoBar('undo', 'div'));
    var flags = draftFlags(draft, problem);
    var draftProblem = problem && problem.sectionIndex === null && !flags.some(function (f) { return DERIVED_FLAGS.indexOf(f) >= 0; })
      ? problem.message : null;

    return el('div', { className: 'fs-tpl-digitise' },
      el('p', { className: 'fs-tpl-digitise__banner', role: 'note' }, TD.BANNER),
      el(Flags, { flags: flags }),
      draftProblem ? el('p', { className: 'fs-tpl-digitise__problem' }, draftProblem) : null,
      el('div', { className: 'fs-tpl-digitise__panes' },
        el(SourcePane, { sources: props.sources }),
        el('div', { className: 'fs-tpl-digitise__draft' },
          el('p', { className: 'fs-tpl-digitise__count' }, sections.length + ' sections · ' + total + ' items'),
          cards)),
      props.error ? el('p', { className: 'fs-tpl-upload__error', role: 'alert' }, props.error) : null,
      el('div', { className: 'fs-tpl-upload__footer' },
        el(Button, { variant: 'ghost', onClick: props.onCancel, disabled: props.saving }, 'Cancel'),
        el(Button, { variant: 'primary', disabled: props.saving,
                     onClick: function () { props.onSave(draft); } },
           props.saving ? 'Saving…' : 'Save template')));
  }

  TemplateDigitiseReview.problemFor = problemFor;
  TemplateDigitiseReview.rowsFor = rowsFor;

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TemplateDigitiseReview = TemplateDigitiseReview;
})();
