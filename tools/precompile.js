#!/usr/bin/env node
'use strict';
/*
 * Build-time JSX compile for the Amplify artifact (dist/). The SOURCE html
 * keeps its `type="text/babel"` tags so file:// and `python -m http.server`
 * still work with in-browser Babel; only the deployed copy is rewritten.
 *
 * Why: every page load downloaded @babel/standalone (~3MB) and compiled ~3MB
 * of scripts on the device before anything rendered — slow on phones.
 *
 * Same compiler, same options: this uses the @babel/standalone version the
 * page loads from the CDN and replicates its buildBabelOptions() for classic
 * (non-module) script tags, so the emitted code is what the browser ran.
 * Notably preset-env with no targets lowers `const`/`let` to `var`, which the
 * scripts rely on: they share one global scope and some top-level names
 * repeat across files.
 *
 * Ordering: Babel ran every text/babel script after all plain scripts (it
 * fetches them by XHR once the document is parsed), in document order.
 * `defer` keeps exactly that: plain scripts run while parsing, deferred
 * scripts run afterwards in document order. The inline boot block becomes
 * `<page>.boot.js`, deferred, in its original (last) position.
 *
 * Usage: node tools/precompile.js <distDir>
 */
const fs = require('fs');
const path = require('path');
const Babel = require('@babel/standalone');

const BABEL_VERSION = '7.29.0';
const REACT_PROD = {
  'react@18.3.1/umd/react.development.js': {
    file: 'react@18.3.1/umd/react.production.min.js',
    sri: 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z',
  },
  'react-dom@18.3.1/umd/react-dom.development.js': {
    file: 'react-dom@18.3.1/umd/react-dom.production.min.js',
    sri: 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1',
  },
};

/* @babel/standalone buildBabelOptions(), classic script branch, minus the
   inline source map. */
function babelOptions(filename) {
  return {
    filename: filename,
    presets: ['react', 'env'],
    plugins: ['transform-class-properties', 'transform-object-rest-spread', 'transform-flow-strip-types'],
    targets: { browsers: undefined },
    sourceMaps: false,
  };
}

function fail(msg) {
  console.error('precompile: ' + msg);
  process.exit(1);
}

function main(distDir) {
  if (!distDir || !fs.existsSync(distDir)) fail('dist dir not found: ' + distDir);
  if (Babel.version !== BABEL_VERSION) {
    fail('@babel/standalone ' + Babel.version + ' installed, page uses ' + BABEL_VERSION);
  }

  const pages = fs.readdirSync(distDir).filter(f => f.endsWith('.html'));

  /* A file some page loads as a PLAIN script must keep its source bytes
     there (e.g. toast.js: plain in the app, text/babel in the components
     preview). Its compiled copy goes to a sibling `.babel.js` instead. */
  const plainRefs = new Set();
  for (const page of pages) {
    const html = fs.readFileSync(path.join(distDir, page), 'utf8');
    for (const m of html.matchAll(/<script src="([^"?]+)[^"]*"><\/script>/g)) plainRefs.add(m[1]);
  }

  const compiled = new Map();   // source path -> output path
  let scriptCount = 0, inlineCount = 0;

  /* Returns the src the rewritten tag should point at. */
  function compileFile(rel) {
    const q = rel.indexOf('?');
    const clean = q < 0 ? rel : rel.slice(0, q);
    const query = q < 0 ? '' : rel.slice(q);
    if (!compiled.has(clean)) {
      const abs = path.join(distDir, clean);
      if (!fs.existsSync(abs)) fail('referenced script missing: ' + clean);
      const src = fs.readFileSync(abs, 'utf8');
      let out;
      try { out = Babel.transform(src, babelOptions(clean)).code; }
      catch (e) { fail('compile failed in ' + clean + ': ' + e.message); }
      const outRel = plainRefs.has(clean) ? clean.replace(/\.js$/, '.babel.js') : clean;
      fs.writeFileSync(path.join(distDir, outRel), out);
      compiled.set(clean, outRel);
      scriptCount++;
    }
    return compiled.get(clean) + query;
  }

  for (const page of pages) {
    const pagePath = path.join(distDir, page);
    let html = fs.readFileSync(pagePath, 'utf8');
    if (!/<script[^>]*type="text\/babel"/.test(html)) continue;

    html = html.replace(/<script type="text\/babel" src="([^"]+)"><\/script>/g, (_, src) => {
      return '<script defer src="' + compileFile(src) + '"></script>';
    });

    let n = 0;
    html = html.replace(/<script type="text\/babel">([\s\S]*?)<\/script>/g, (_, body) => {
      const name = page.replace(/\.html$/, '') + (n ? '.boot' + n : '.boot') + '.js';
      n++;
      let out;
      try { out = Babel.transform(body, babelOptions(name)).code; }
      catch (e) { fail('compile failed in inline block of ' + page + ': ' + e.message); }
      fs.writeFileSync(path.join(distDir, name), out);
      inlineCount++;
      /* ?v=1 so the cache-stamp step below rewrites it like every other asset. */
      return '<script defer src="' + name + '?v=1"></script>';
    });

    if (/<script[^>]*type="text\/babel"/.test(html)) {
      fail(page + ': a text/babel script tag was not converted (unexpected attribute form)');
    }

    /* Nothing left for in-browser Babel to do. */
    html = html.replace(/[ \t]*<script src="https:\/\/unpkg\.com\/@babel\/standalone@[^"]+"[^>]*><\/script>\r?\n?/g, '');
    if (/@babel\/standalone/.test(html.replace(/<!--[\s\S]*?-->/g, ''))) {
      fail(page + ': @babel/standalone tag not removed');
    }

    for (const dev of Object.keys(REACT_PROD)) {
      const re = new RegExp('src="https://unpkg\\.com/' + dev.replace(/[.@/]/g, '\\$&') + '" integrity="[^"]+"');
      if (!re.test(html)) fail(page + ': expected React tag not found: ' + dev);
      html = html.replace(re, 'src="https://unpkg.com/' + REACT_PROD[dev].file + '" integrity="' + REACT_PROD[dev].sri + '"');
    }

    fs.writeFileSync(pagePath, html);
    console.log('precompile: ' + page + ' rewritten');
  }
  console.log('precompile: ' + scriptCount + ' scripts + ' + inlineCount + ' inline blocks compiled');
}

main(process.argv[2]);
