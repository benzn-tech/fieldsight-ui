'use strict';

/*
 * "New project" collects eight things and, against the real backend, stores
 * five of them. Region, Project value and Planned completion are read off the
 * form and never sent: `createOrgSite` posts name/location/client/address/
 * latitude/longitude/icon_s3_key, and `sites` has had no column for any of
 * the three since 0002_core_relational.sql.
 *
 * The reported symptom was much smaller -- "the amount has no thousands
 * separators and is hard to read" -- and fixing only that would have polished
 * a control whose value is discarded.
 *
 * Two things are pinned here:
 *
 *   1. The money field formats as you type WITHOUT corrupting what is stored.
 *      This is not decoration: `api/sites.js` does Number(project_value_nzd)
 *      on the mock path, and Number("12,400,000") is NaN, which that code
 *      turns into 0. Storing the separated string would silently zero every
 *      project value on the dashboards that DO read it.
 *
 *   2. The unsaved-field marking is gated on orgLive(). On the mock path all
 *      three fields ARE stored and feed the Portfolio/Executive rollups, so a
 *      blanket disable would break controls that work in the demo build.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SITES = path.join(__dirname, '..', 'scripts', 'pages', 'sites.js');

/* NEWLINES ARE NORMALISED BEFORE ANY MATCHING. This repo is developed on
   Windows with core.autocrlf=true, so the same file is LF in one checkout and
   CRLF in the next -- a `git stash pop` is enough to flip it. A pattern
   containing `\n  }` then matches when the file happens to be LF and fails
   when it happens to be CRLF, which reads as "the code changed" when nothing
   changed at all. */
const source = fs.readFileSync(SITES, 'utf8').replace(/\r\n/g, '\n');

/* sites.js is a browser IIFE with no export. Rather than assert on its text
   (which pins wiring, not behaviour), lift the two pure helpers out and run
   them -- they are self-contained and this executes the real definitions. */
function loadHelpers() {
  const digits = source.match(/function digitsOnly\([\s\S]*?\n  \}/);
  const fmt = source.match(/function formatThousands\([\s\S]*?\n  \}/);
  assert.ok(digits, 'digitsOnly has moved or been renamed');
  assert.ok(fmt, 'formatThousands has moved or been renamed');
  // eslint-disable-next-line no-new-func
  return new Function(digits[0] + '\n' + fmt[0]
    + '\nreturn { digitsOnly: digitsOnly, formatThousands: formatThousands };')();
}

const { digitsOnly, formatThousands } = loadHelpers();

/* ---------- what the reader sees -------------------------------------- */

test('a value reads with thousands separators', () => {
  assert.strictEqual(formatThousands('12400000'), '12,400,000');
  assert.strictEqual(formatThousands('1234'), '1,234');
});

test('groups start only above three digits', () => {
  assert.strictEqual(formatThousands('999'), '999');
  assert.strictEqual(formatThousands('1000'), '1,000');
});

test('an empty field stays empty rather than becoming a zero', () => {
  assert.strictEqual(formatThousands(''), '');
  assert.strictEqual(formatThousands(null), '');
  assert.strictEqual(formatThousands(undefined), '');
});

/* ---------- what gets stored ------------------------------------------ */

test('what is stored carries no separators, so Number() still parses it', () => {
  const typed = '12,400,000';
  const stored = digitsOnly(typed);
  assert.strictEqual(stored, '12400000');
  assert.strictEqual(Number(stored), 12400000);

  /* The failure this guards: api/sites.js:74 does Number(...) || 0 on the
     mock path. Storing the formatted string turns every value into 0. */
  assert.ok(Number.isNaN(Number(typed)),
    'precondition: the separated form really is unparseable, which is why '
    + 'the stored form must stay unseparated');
});

test('re-formatting an already formatted value is stable', () => {
  const once = formatThousands('12400000');
  assert.strictEqual(formatThousands(once), once,
    'the field re-formats its own value on every keystroke; a formatter that '
    + 'is not idempotent multiplies separators as you type');
});

test('typing anything that is not a digit cannot reach the stored value', () => {
  assert.strictEqual(digitsOnly('$12,400,000 NZD'), '12400000');
  assert.strictEqual(digitsOnly('abc'), '');
});

/* ---------- the fields that do not save -------------------------------- */

test('the money control is a text input, because a number input cannot hold separators', () => {
  const fn = source.match(/function fMoney\([\s\S]*?\n  \}/);
  assert.ok(fn, 'fMoney has moved or been renamed');
  assert.match(fn[0], /type:\s*'text'/,
    'a `type="number"` input sanitises "12,400,000" to empty — separators and '
    + 'type=number are mutually exclusive, and the separators are the point');
  assert.match(fn[0], /inputMode:\s*'numeric'/,
    'the numeric keypad should survive the switch to a text input');
});

test('the unsaved-field marking is gated on orgLive(), not applied unconditionally', () => {
  assert.match(source, /var unsaved = orgLive\(\);/,
    'the marking must key off the live backend');

  /* On the mock path FS.api.sites.createSite(form) keeps all three fields and
     the Portfolio/Executive rollups read them. A blanket disable breaks the
     demo build, which is the whole reason this is a gate and not a constant. */
  const create = source.match(/function NewProjectModal[\s\S]*?\n  \}\n/);
  assert.ok(create, 'NewProjectModal has moved');
  ['Region', 'Project value \\(NZD\\)', 'Planned completion'].forEach(function (label) {
    const row = new RegExp("fFieldRow\\('" + label + "'[\\s\\S]{0,400}?unsaved \\? UNSAVED_HINT : null\\)");
    assert.match(create[0], row,
      label + ' should carry the conditional hint; without it the form keeps '
      + 'accepting a value it silently discards');
  });
});

test('the hint is written once, so the three controls cannot drift apart', () => {
  const decl = source.match(/var UNSAVED_HINT = '([^']+)';/);
  assert.ok(decl, 'UNSAVED_HINT has moved or been renamed');
  assert.ok(decl[1].length > 10, 'the hint should say something');
  const inlineCopies = source.match(/Not stored yet/g) || [];
  assert.strictEqual(inlineCopies.length, 1,
    'the wording should exist in exactly one place');
});

test('Location and Address each explain what they are for', () => {
  const create = source.match(/function NewProjectModal[\s\S]*?\n  \}\n/);
  assert.match(create[0], /fFieldRow\('Location'[\s\S]{0,300}?project header/,
    'Location needs to say it is the human label');
  assert.match(create[0], /fFieldRow\('Address'[\s\S]{0,600}?coordinates the weather panel uses/,
    'Address needs to say it is what sets the coordinates — that is the '
    + 'difference between the two fields and the reason both exist');
});

/* ---------- the hint has somewhere to render --------------------------- */

test('the hint classes exist in the stylesheet', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'styles', 'composites.css'), 'utf8');
  ['.fs-settings__field-hint', '.fs-settings__field-stack'].forEach(function (cls) {
    assert.ok(css.indexOf(cls + ' {') !== -1,
      cls + ' is rendered by sites.js but has no rule — the hint would '
      + 'inherit body type and read as part of the field below it');
  });
});
