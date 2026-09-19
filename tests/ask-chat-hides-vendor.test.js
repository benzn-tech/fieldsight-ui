'use strict';
/*
 * Owner's ruling (2026-09-20): customers must never learn which LLM
 * model/vendor answers Ask. AskChat used to render `m.model` under an
 * assistant answer; that display is removed here. The backend is being
 * changed in parallel to stop sending `model` at all, so this file also
 * pins that the component reads `m.model` NOWHERE — not to render it, not
 * to branch on it — so it breaks on neither its presence nor its absence.
 *
 * ask-chat.js cannot be required under Node (no module.exports, attaches
 * to window at load, reads React/window at module scope — see
 * tests/ask-panel-ux.test.js for the same posture), so this is a source
 * scan, same convention as that file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const askChat = fs.readFileSync(
  require.resolve('../scripts/composites/ask-chat.js'), 'utf8');

/* Strip /* ... *\/ block comments and // line comments so a comment that
   merely TALKS ABOUT `m.model` (explaining why it is gone) cannot be
   mistaken for the live reference this test is guarding against. Good
   enough for this one file: no template literals or regex literals
   contain `/*`, `*/`, or `//` between real code tokens here. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const code = stripComments(askChat);

test('AskChat never reads m.model — not to render it, not to branch on it', () => {
  assert.doesNotMatch(code, /m\.model\b/,
    'a live (non-comment) reference to m.model was found — this must stay ' +
    'gone so the UI cannot depend on a field the backend is being changed ' +
    'to stop sending');
});

test('the old model-display element is gone: exactly one fs-ask-chat__model mount remains, and it is the route line, not a model name', () => {
  const mounts = code.match(/className: 'fs-ask-chat__model'/g) || [];
  assert.strictEqual(mounts.length, 1,
    'expected exactly the "from the programme, not the reports" route line; ' +
    'a second mount means the model display came back');
  assert.match(code, /'fs-ask-chat__model'\s*\},\s*\n\s*'from the programme, not the reports'\)/,
    'the one remaining fs-ask-chat__model mount must be the fixed route-line ' +
    'string, not a dynamic value');
});
