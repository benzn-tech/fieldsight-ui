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

   CSS: §TEMPLATE-DIGITISE in styles/composites.css
   Exported to: window.FieldSight.TemplateDigitiseReview
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function el() { return React.createElement.apply(React, arguments); }

  function SourcePane(props) {
    return el('div', { className: 'fs-tpl-digitise__source', 'aria-label': 'Your form' },
      (props.sources || []).map(function (s, i) {
        var ct = s.contentType || '';
        if (ct.indexOf('image/') === 0) {
          return el('img', { key: s.key, className: 'fs-tpl-digitise__page', src: s.url,
                             alt: 'Page ' + (i + 1) + ' of your form' });
        }
        if (ct === 'application/pdf') {
          return el('div', { key: s.key, className: 'fs-tpl-digitise__doc' },
            el('iframe', { className: 'fs-tpl-digitise__pdf', src: s.url, title: 'Your form (PDF)' }),
            el('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'Open the PDF in a new tab'));
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

  function tool(label, aria, disabled, onClick) {
    return el('button', { type: 'button', className: 'fs-tpl-digitise__tool', 'aria-label': aria,
                          title: aria, disabled: disabled, onClick: onClick }, label);
  }

  function TemplateDigitiseReview(props) {
    var Button = window.FieldSight.Button;
    var TD = window.FS.api.templateDigitise;
    var ops = TD.ops;
    var draft = props.draft;
    var change = props.onChange;
    var sections = draft.sections || [];
    var total = sections.reduce(function (n, s) { return n + (s.items || []).length; }, 0);

    function sectionCard(s, i) {
      var last = i === sections.length - 1;
      return el('section', { key: i, className: 'fs-tpl-digitise__section'
                                       + ((s.flags || []).length ? ' fs-tpl-digitise__section--flagged' : '') },
        el('div', { className: 'fs-tpl-digitise__section-head' },
          el('input', { className: 'fs-tpl-upload__input', value: s.title,
                        'aria-label': 'Section ' + (i + 1) + ' name',
                        onChange: function (e) { change(ops.renameSection(draft, i, e.target.value)); } }),
          el('span', { className: 'fs-tpl-digitise__count' },
             s.items.length + (s.items.length === 1 ? ' item' : ' items'))),
        el(Flags, { flags: s.flags }),
        el('ol', { className: 'fs-tpl-digitise__items' },
          s.items.map(function (it, j) {
            return el('li', { key: j, className: 'fs-tpl-digitise__item'
                                         + ((it.flags || []).length ? ' fs-tpl-digitise__item--flagged' : '') },
              el('textarea', { className: 'fs-tpl-upload__textarea fs-tpl-digitise__item-text', rows: 1,
                               value: it.text, 'aria-label': 'Section ' + (i + 1) + ', item ' + (j + 1),
                               onChange: function (e) { change(ops.editItem(draft, i, j, e.target.value)); } }),
              el(Flags, { flags: it.flags }),
              el('div', { className: 'fs-tpl-digitise__item-tools' },
                tool('↑', 'Move item up', j === 0, function () { change(ops.moveItem(draft, i, j, -1)); }),
                tool('↓', 'Move item down', j === s.items.length - 1, function () { change(ops.moveItem(draft, i, j, 1)); }),
                tool('×', 'Delete item', false, function () { change(ops.deleteItem(draft, i, j)); })));
          })),
        el('div', { className: 'fs-tpl-digitise__section-tools' },
          el(Button, { variant: 'ghost', onClick: function () { change(ops.addItem(draft, i)); } }, '+ Add item'),
          el(Button, { variant: 'ghost', disabled: i === 0, onClick: function () { change(ops.moveSection(draft, i, -1)); } }, 'Move up'),
          el(Button, { variant: 'ghost', disabled: last, onClick: function () { change(ops.moveSection(draft, i, 1)); } }, 'Move down'),
          el(Button, { variant: 'ghost', disabled: last, onClick: function () { change(ops.mergeWithNext(draft, i)); } }, 'Merge with next'),
          el(Button, { variant: 'ghost', onClick: function () { change(ops.deleteSection(draft, i)); } }, 'Delete section')));
    }

    return el('div', { className: 'fs-tpl-digitise' },
      el('p', { className: 'fs-tpl-digitise__banner', role: 'note' }, TD.BANNER),
      el(Flags, { flags: draft.flags }),
      el('div', { className: 'fs-tpl-digitise__panes' },
        el(SourcePane, { sources: props.sources }),
        el('div', { className: 'fs-tpl-digitise__draft' },
          el('p', { className: 'fs-tpl-digitise__count' }, sections.length + ' sections · ' + total + ' items'),
          sections.map(sectionCard))),
      props.error ? el('p', { className: 'fs-tpl-upload__error', role: 'alert' }, props.error) : null,
      el('div', { className: 'fs-tpl-upload__footer' },
        el(Button, { variant: 'ghost', onClick: props.onCancel, disabled: props.saving }, 'Cancel'),
        el(Button, { variant: 'primary', disabled: props.saving,
                     onClick: function () { props.onSave(draft); } },
           props.saving ? 'Saving…' : 'Save template')));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TemplateDigitiseReview = TemplateDigitiseReview;
})();
