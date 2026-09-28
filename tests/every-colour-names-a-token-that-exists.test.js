'use strict';

/*
 * Every colour in the stylesheets names a design token that actually exists.
 *
 * `var(--surface-subtle, #f9fafb)` looks themed. It is not: `--surface-subtle`
 * was never defined, so the browser used the fallback -- a near-white -- in
 * BOTH themes, while the text on it (`--text-secondary`, which IS defined)
 * turned light grey in dark mode. The Library's read-only note rendered as
 * light grey on white and could not be read. Nothing failed; a missing custom
 * property is not an error anywhere.
 *
 * The audit on 2026-09-28 found 29 such names across 74 colour declarations --
 * typos (`--surface-panelMuted` for `--surface-panel-muted`, 16 of them, whose
 * backgrounds were simply transparent) and names from another naming scheme
 * (`--color-surface`, `--text-default`, `--accent-danger`). All now point at
 * tokens defined for both themes in styles/tokens.css.
 *
 * THE test fails on any `var(--x)` in a colour property whose `--x` is defined
 * nowhere. A fallback does not excuse it: the fallback IS the bug, because it
 * is one colour for two themes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const CSS = walk(path.join(ROOT, 'styles'), '.css');
const JS = walk(path.join(ROOT, 'scripts'), '.js');
const SOURCES = [...CSS, ...JS].map((f) => [f, fs.readFileSync(f, 'utf8')]);

const DEFINED = new Set();
for (const [, src] of SOURCES) {
  for (const m of src.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) DEFINED.add(m[1]);
  for (const m of src.matchAll(/setProperty\(\s*['"](--[A-Za-z0-9_-]+)/g)) DEFINED.add(m[1]);
}

const COLOUR = /\b(color|background|background-color|border|border-color|border-(?:top|bottom|left|right)(?:-color)?|outline|outline-color|fill|stroke|box-shadow|backgroundColor|borderColor)\s*:/i;

function undefinedColourRefs() {
  const out = [];
  for (const [file, src] of SOURCES) {
    src.split(/\r?\n/).forEach((line, i) => {
      if (!COLOUR.test(line)) return;
      for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
        if (!DEFINED.has(m[1])) {
          out.push(`${path.relative(ROOT, file)}:${i + 1}  ${m[1]}`);
        }
      }
    });
  }
  return out;
}

test('THE test: no colour names a token that is defined nowhere', () => {
  const bad = undefinedColourRefs();
  assert.deepStrictEqual(bad, [], 'undefined colour tokens:\n' + bad.join('\n'));
});

test('the tokens the fixes point at exist in both themes', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'styles', 'tokens.css'), 'utf8');
  const dark = tokens.slice(tokens.indexOf('[data-theme="dark"]'));
  for (const t of ['--surface-panel-muted', '--surface-panel', '--surface-panel-elevated',
    '--surface-input-hover', '--status-overdue-bg', '--border-default', '--border-subtle',
    '--text-primary', '--text-secondary', '--text-tertiary', '--text-danger',
    '--text-success', '--text-warning']) {
    assert.match(tokens, new RegExp(t + '\\s*:'), t + ' is defined');
    assert.match(dark, new RegExp(t + '\\s*:'), t + ' has a dark value');
  }
});

test('the Library read-only note sits on a themed surface', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'composites.css'), 'utf8');
  const rule = css.slice(css.indexOf('.fs-library__right-readonly {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /background:\s*var\(--surface-panel-muted/);
});

test('the shell takes its colours from the theme, not from the light-only FS.tokens', () => {
  /* FS.tokens holds the LIGHT theme's hex codes. The shell's inline style read
     its text colour from there, so every inherited text on every page was
     #111827 in dark mode too -- the My Work heading measured 1.08:1. */
  const shell = fs.readFileSync(path.join(ROOT, 'scripts', 'app-shell.js'), 'utf8');
  const block = shell.slice(shell.indexOf('var shellStyle = {'));
  const body = block.slice(0, block.indexOf('};'));
  assert.match(body, /background:\s*'var\(--surface-app\)'/);
  assert.match(body, /color:\s*'var\(--text-primary\)'/);
  assert.ok(!/FS\.tokens\.(surface|text|colors)/.test(body), 'no light-only colour in the shell');
});
