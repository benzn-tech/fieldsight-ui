'use strict';

/*
 * Clicking a template in the library gets you its sections.
 *
 * The list does not carry bodies -- returning every version of every template
 * to draw a list would be absurd -- so a row selected from it has no sections.
 * The panel needs them. Something has to complete the selection, and until
 * this existed nothing did.
 *
 * WHY THIS FILE IS SEPARATE FROM THE BACKEND'S. The API was fixed first: `get`
 * now returns the current version, and a backend test asserts it. That test
 * passed while the page was still blank, because **nothing called `get`**. The
 * endpoint was correct and unreachable.
 *
 * So the assertion here is not "the API returns sections" -- it is "opening a
 * template causes the request that gets them". A guard that catches something
 * is not the same as a feature that works, and the gap between those two is
 * exactly one unasked question.
 *
 * THE test is `selecting a row fetches the whole template`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/* The effect, lifted out of the provider and run by hand. React is not loaded
   here, so useEffect/useState are stubbed to invoke the body once with the
   state the test sets up -- which is all this needs: the question is which
   call the effect makes, not how React schedules it. */
function runEffect(sel, api) {
  const m = PAGE.match(/React\.useEffect\(function \(\) \{\n {6}if \(!sel \|\| !sel\.id\)[\s\S]*?\n {4}\}, \[sel && sel\.id[^\]]*\]\);/);
  assert.ok(m, 'the hydration effect has moved or been renamed');
  const calls = [];
  const setSel = (v) => calls.push(v);
  const states = [];
  const setFetchState = (v) => states.push(v);
  calls.states = states;
  const window = { FS: { api: { templates: api } } };
  // eslint-disable-next-line no-new-func
  const body = m[0]
    .replace(/^React\.useEffect\(function \(\) \{/, '')
    .replace(/\}, \[sel && sel\.id[^\]]*\]\);$/, '');
  // eslint-disable-next-line no-new-func
  const fn = new Function('sel', 'setSel', 'setFetchState', 'window', body);
  fn(sel, setSel, setFetchState, window);
  return calls;
}

function apiThatReturns(full) {
  const asked = [];
  return {
    asked,
    get(id) { asked.push(id); return Promise.resolve(full); },
  };
}

const ROW_FROM_LIST = { id: 't-1', title: 'Site Daily', current_version: 2, versions: [] };
const WHOLE = {
  id: 't-1', title: 'Site Daily', current_version: 2,
  versions: [{ id: 'v-2', version: 2, schema: { sections: [{ title: 'Safety' }] } }],
};

/* ---- THE test -------------------------------------------------------------- */

test('THE test: selecting a row fetches the whole template', async () => {
  const api = apiThatReturns(WHOLE);
  runEffect(ROW_FROM_LIST, api);
  assert.deepStrictEqual(api.asked, ['t-1'],
    'opening a template must ask for it; the list row has no sections');
});

test('what comes back replaces the selection', async () => {
  const api = apiThatReturns(WHOLE);
  const calls = runEffect(ROW_FROM_LIST, api);
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].versions.length, 1);
});

/* ---- when NOT to ask -------------------------------------------------------- */

test('a template that already has its sections is not fetched again', () => {
  /* Also what stops this looping: the fetch replaces the selection with a
     version-carrying copy, which must not trigger another fetch. */
  const api = apiThatReturns(WHOLE);
  runEffect(WHOLE, api);
  assert.deepStrictEqual(api.asked, []);
});

test('a template with no body yet is not fetched', () => {
  /* current_version 0 means there is nothing to complete. Asking would answer
     "no sections", which the panel already knows and says. */
  const api = apiThatReturns(WHOLE);
  runEffect({ id: 't-2', current_version: 0, versions: [] }, api);
  assert.deepStrictEqual(api.asked, []);
});

test('nothing selected asks for nothing', () => {
  const api = apiThatReturns(WHOLE);
  runEffect(null, api);
  assert.deepStrictEqual(api.asked, []);
});

/* ---- failure must not loop -------------------------------------------------- */

test('a response that still has no sections does not replace the selection', async () => {
  /* Swapping one empty copy for another would spin: new object, still no
     versions, effect runs again. The panel's own message covers the failure. */
  const api = apiThatReturns({ id: 't-1', current_version: 2, versions: [] });
  const calls = runEffect(ROW_FROM_LIST, api);
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(calls.length, 0, "setSel was not called");
});

test('a rejected fetch is swallowed, not thrown at the page', async () => {
  const api = { asked: [], get() { return Promise.reject(new Error('boom')); } };
  assert.doesNotThrow(() => runEffect(ROW_FROM_LIST, api));
  await Promise.resolve();
});

test('a store with no get at all does not crash the library', () => {
  assert.doesNotThrow(() => runEffect(ROW_FROM_LIST, {}));
});


/* ---- the panel is told the fetch is in flight ------------------------------- */

const tick = () => new Promise((r) => setImmediate(r));

test('the fetch is announced as loading, then cleared when the template arrives', async () => {
  /* Without this the panel showed "did not come back with this request" for
     the half second every fetch takes. */
  const full = { ...ROW_FROM_LIST, versions: [{ version: 2, schema: { sections: [] } }] };
  const calls = runEffect(ROW_FROM_LIST, apiThatReturns(full));
  assert.deepStrictEqual(calls.states[0], { id: 't-1', status: 'loading' });
  await tick();
  assert.deepStrictEqual(calls.states[calls.states.length - 1], null, 'cleared on arrival');
});

test('an answer without content is reported as empty, not left as loading', async () => {
  const calls = runEffect(ROW_FROM_LIST, apiThatReturns({ ...ROW_FROM_LIST, versions: [] }));
  await tick();
  assert.deepStrictEqual(calls.states[calls.states.length - 1], { id: 't-1', status: 'empty' });
});

test('a failed fetch is reported as failed, not left as loading', async () => {
  const calls = runEffect(ROW_FROM_LIST, { get() { return Promise.reject(new Error('502')); } });
  await tick();
  assert.deepStrictEqual(calls.states[calls.states.length - 1], { id: 't-1', status: 'failed' });
});
