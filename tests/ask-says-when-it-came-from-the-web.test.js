'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* An answer the records could not give must say so before it is read.
 *
 * The backend now answers from the open web when the retrieved excerpts do not
 * cover the question, and marks it `from_web: true` with a `web.sources` list.
 * Rendered without that marker the reader gets a fluent, correct-looking answer
 * and no reason to suspect it did not come out of their own meetings — which is
 * the one thing this product promises they can always tell.
 *
 * Placement is the substance, not styling. The basis line sits above the answer
 * for the same measured reason (user, 2026-08-31): a caveat reached after three
 * sentences has already been read past. Corroboration sits BELOW because it
 * annotates an answer that did come from the recordings; this sits ABOVE
 * because it says the answer did not.
 */

const askChat = fs.readFileSync(
  require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
const css = fs.readFileSync(__dirname + '/../styles/composites.css', 'utf8');

test('a web-derived answer is labelled before the prose, not after', () => {
  /* Anchored inside the RENDER TREE, not the whole file. The first version
     searched the file for `renderWebOrigin(m)` -- which the function's own
     definition also contains, several thousand characters earlier -- so moving
     the call below the answer left the test green. The mutation caught it. */
  const tree = askChat.slice(askChat.indexOf("m.role === 'assistant' && formatAnswerBasis"));
  const origin = tree.indexOf('? renderWebOrigin(m)');
  const body = tree.indexOf('renderMarkdown(m.text)');
  const corrob = tree.indexOf('? renderCorroboration(m.corrob)');
  assert.ok(origin > -1, 'nothing renders the web origin');
  assert.ok(origin < body, 'the label sits after the answer text');
  assert.ok(body < corrob, 'the corroboration block moved above the answer');
});

test('the label names both sides of the distinction', () => {
  /* "From the web" alone leaves the reader to infer what it is NOT. */
  assert.match(askChat, /From the open web .* not from your recordings/);
});

test('a normal answer renders no web block at all', () => {
  const block = askChat.slice(askChat.indexOf('function renderWebOrigin'));
  assert.match(block.slice(0, 200), /if \(!m\.fromWeb\) return null;/);
});

test('sources are named by publisher, not by the redirect they arrived through', () => {
  /* The search vendor returns Google grounding redirects; parsing the URL
     would attribute every source to vertexaisearch.cloud.google.com. */
  /* Sliced from the function's own start rather than to the next function:
     the two are not in source order, and slicing between them silently
     produced an empty string that passed every assertion. */
  const start = askChat.indexOf('function renderWebOrigin');
  const block = askChat.slice(start, start + 1200);
  assert.ok(block.length > 400, 'the slice found nothing to assert on');
  assert.match(block, /sourceDomain\(s\)/);
  assert.ok(!/sourceHost\(s\.url\)/.test(block), 'it parsed the redirect URL');
});

test('a web answer is never corroborated against the web', () => {
  const line = askChat.slice(askChat.indexOf('var wantsCorrob'),
                             askChat.indexOf('var wantsCorrob') + 320);
  assert.match(line, /!res\.from_web/);
});

test('the block is visually separated, not just labelled', () => {
  assert.match(css, /\.fs-ask-web \{/);
  const rule = css.slice(css.indexOf('.fs-ask-web {'), css.indexOf('.fs-ask-web__label'));
  assert.match(rule, /border-left/, 'nothing marks it apart from the answer');
});
