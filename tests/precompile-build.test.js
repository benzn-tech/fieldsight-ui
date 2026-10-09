'use strict';
/*
 * Drives tools/precompile.js on a miniature dist/. Needs @babel/standalone,
 * which only the Amplify build installs; locally:
 *   npm install --no-save --no-package-lock @babel/standalone@7.29.0
 * Without it these tests are SKIPPED (reported as such, not passed).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
let hasBabel = true;
try { require.resolve('@babel/standalone', { paths: [ROOT] }); } catch (_) { hasBabel = false; }
const skip = hasBabel ? false : '@babel/standalone not installed';

const REACT = [
  '<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-x" crossorigin="anonymous"></script>',
  '<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-y" crossorigin="anonymous"></script>',
  '<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-z" crossorigin="anonymous"></script>',
].join('\n');

function makeDist(pages, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompile-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  for (const [name, html] of Object.entries(pages)) fs.writeFileSync(path.join(dir, name), html);
  return dir;
}
function run(dir) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'precompile.js'), dir], { cwd: ROOT, encoding: 'utf8' });
}

test('rewrites babel tags to defer, compiles JSX, swaps React, drops Babel', { skip }, () => {
  const dir = makeDist({
    'index.html': REACT + '\n<script src="scripts/plain.js?v=1"></script>\n'
      + '<script type="text/babel" src="scripts/a.js?v=3"></script>\n'
      + '<script type="text/babel">\n  const x = <b/>; window.boot = x;\n</script>\n',
  }, {
    'scripts/plain.js': 'window.p = 1;\n',
    'scripts/a.js': 'const A = () => <div className="a"/>;\n',
  });
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /<script src="scripts\/plain\.js\?v=1"><\/script>/);
  assert.match(html, /<script defer src="scripts\/a\.js\?v=3"><\/script>/);
  assert.match(html, /<script defer src="index\.boot\.js\?v=1"><\/script>/);
  assert.doesNotMatch(html, /text\/babel|@babel\/standalone/);
  assert.match(html, /react\.production\.min\.js" integrity="sha384-DGy/);
  assert.match(html, /react-dom\.production\.min\.js" integrity="sha384-gTG/);
  const a = fs.readFileSync(path.join(dir, 'scripts/a.js'), 'utf8');
  assert.match(a, /React\.createElement\("div"/);
  assert.match(a, /\bvar A\b/, 'preset-env must lower const to var like in-browser Babel did');
  assert.match(fs.readFileSync(path.join(dir, 'index.boot.js'), 'utf8'), /window\.boot = x/);
});

test('a file also loaded plain elsewhere keeps its source; compiled copy is .babel.js', { skip }, () => {
  const dir = makeDist({
    'index.html': REACT + '\n<script src="scripts/t.js?v=1"></script>\n',
    'preview.html': REACT + '\n<script type="text/babel" src="scripts/t.js?v=1"></script>\n',
  }, { 'scripts/t.js': 'const T = 1;\n' });
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'scripts/t.js'), 'utf8'), 'const T = 1;\n');
  assert.match(fs.readFileSync(path.join(dir, 'preview.html'), 'utf8'), /defer src="scripts\/t\.babel\.js\?v=1"/);
  assert.ok(fs.existsSync(path.join(dir, 'scripts/t.babel.js')));
});

test('fails the build on a babel tag it cannot convert', { skip }, () => {
  const dir = makeDist({ 'index.html': REACT + '\n<script type="text/babel" data-presets="react" src="scripts/a.js"></script>\n' },
    { 'scripts/a.js': 'var a;\n' });
  const r = run(dir);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /not converted/);
});

test('fails the build on a JSX syntax error', { skip }, () => {
  const dir = makeDist({ 'index.html': REACT + '\n<script type="text/babel" src="scripts/a.js"></script>\n' },
    { 'scripts/a.js': 'const a = <div>;\n' });
  const r = run(dir);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /compile failed in scripts\/a\.js/);
});
