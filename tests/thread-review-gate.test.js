'use strict';

/*
 * The "Came up again" queue is held back from customers (2026-08-16): it asks a
 * person to judge whether one topic restates an earlier one, and that judgement
 * is being exercised on dev first.
 *
 * These pin the two things that decide whether a customer sees it, and the
 * direction of the default. This repo's standing failure mode is a switch whose
 * middle segment goes missing and silently takes the DEFAULT — so what matters
 * is not that the flag works when set, but that ABSENCE means hidden.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function apiFlagFor(env) {
  /* Drive the real api/index.js rather than restating its expression here — a
     copy of the rule would keep passing after the rule changed. */
  global.window = { FS_ENV: env, FieldSight: {} };
  delete require.cache[require.resolve('../scripts/api/index.js')];
  require('../scripts/api/index.js');
  return global.window.FS.api.threadReview;
}

test('absence hides the queue; only an explicit true opens it', () => {
  assert.strictEqual(apiFlagFor({}), false, 'no flag at all must hide it');
  assert.strictEqual(apiFlagFor({ orgWrites: true }), false,
    'an unrelated flag must not open it');
  assert.strictEqual(apiFlagFor({ threadReview: false }), false);
  assert.strictEqual(apiFlagFor({ threadReview: true }), true);
});

test('the build writes the flag, and writes false when the variable is unset', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'amplify.yml'), 'utf8');
  assert.ok(/threadReview: %s/.test(yml),
    'env.js must carry threadReview, or the UI reads undefined on every branch');
  assert.ok(/\$\{FS_THREAD_REVIEW:-false\}/.test(yml),
    'the shell default must be false: an unset variable has to hide the feature');
});

test('the section is gated on the flag in BOTH the fetch and the render', () => {
  /* Rendering nothing while still polling the endpoint is a feature that is
     only invisible — the request still goes out on every site change. */
  const src = fs.readFileSync(path.join(ROOT, 'scripts/pages/timeline.js'), 'utf8');
  const fn = src.slice(src.indexOf('function ThreadReviewSection'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.ok(/var enabled = /.test(body), 'the flag must be read in the section');
  assert.ok(/if \(!enabled \|\| !Queue \|\| !org\.getThreadSuggestions\)/.test(body),
    'the fetch must be gated, not just the render');
  assert.ok(/if \(!enabled \|\| !Queue \|\| !rows/.test(body),
    'the render must be gated too');
});
