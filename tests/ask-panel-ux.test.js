'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* Three complaints from the same session on site (2026-08-31), and all three
   regress silently — nothing throws, nothing logs, the panel just goes back to
   being annoying. So each is pinned to the property rather than to the code. */

const askChat = fs.readFileSync(
  require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
const palette = fs.readFileSync(
  require.resolve('../scripts/composites/search-palette.js'), 'utf8');
const css = fs.readFileSync(__dirname + '/../styles/composites.css', 'utf8');

/* ---- 1. the wait says what it is doing ---------------------------------- */

test('the pending state carries a label, not only dots', () => {
  /* p90 is 8.6s. Three silent dots over that long read as a stall. */
  assert.match(askChat, /fs-ask-chat__pending-label/);
  assert.match(askChat, /Looking through your records/);
});

test('the pending state is announced to a screen reader', () => {
  const block = askChat.slice(askChat.indexOf('fs-ask-chat__msg--pending'));
  assert.match(block.slice(0, 400), /'aria-live':\s*'polite'/);
  /* The dots are decoration; the label is the message. */
  assert.match(block.slice(0, 400), /'aria-hidden': 'true'/);
});

test('the dots move vertically, and stop entirely under reduced motion', () => {
  const kf = css.slice(css.indexOf('@keyframes fs-ask-pending'));
  assert.match(kf.slice(0, 200), /translateY/,
    'the dots pulse rather than bounce — a pulse reads as a status light');
  const rm = css.indexOf('.fs-ask-chat__pending-dot { animation: none');
  assert.ok(rm > 0, 'no prefers-reduced-motion override for the bounce');
  assert.match(css.slice(rm, rm + 120), /transform: none/,
    'a transformed end-state can survive when the animation is switched off');
});

/* ---- 2. reading starts at the question ---------------------------------- */

test('the view anchors on the question, not the bottom of the answer', () => {
  /* `scrollTop = scrollHeight` lands the reader at the last line of a long
     answer and makes them scroll up to find what they asked. */
  const effect = askChat.slice(askChat.indexOf('Put the QUESTION at the top'),
                               askChat.indexOf('When scope keys change'));
  assert.ok(effect.length > 0, 'the scroll effect was renamed or removed');
  assert.match(effect, /data-role="user"/,
    'nothing looks for the question — the anchor is gone');
  assert.match(effect, /offsetTop/);
  assert.match(effect, /scrollHeight/,
    'no fallback for a log with no question in it');
});

test('every message is tagged with its role so the anchor can be found', () => {
  assert.match(askChat, /'data-role': m\.role/);
});

/* ---- 3. one Escape, and it closes --------------------------------------- */

test('exactly one Escape handler exists in the palette', () => {
  const handlers = palette.match(/e\.key !== 'Escape'|case 'Escape'/g) || [];
  assert.strictEqual(handlers.length, 1,
    'two handlers race on the same key: ' + JSON.stringify(handlers));
});

test('Escape closes rather than stepping back through askMode', () => {
  const block = palette.slice(palette.indexOf("if (e.key !== 'Escape') return;"));
  const body = block.slice(0, 200);
  assert.match(body, /onClose\(\)/);
  assert.doesNotMatch(body, /setAskMode\(null\)/,
    'Escape still backs out of askMode first — that is the staircase that ' +
    'made leaving take several presses');
});
