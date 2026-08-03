/* ==========================================================================
   FieldSight Programme — pluggable import format registry
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-02-programme-foundation-design.md §5

   The supported set is CSV / XLSX / MSPDI XML, and XER / MPP are deferred
   ("先做A，基建搭完了我们再考虑拓宽"). Adding one later should be adding an
   adapter, not editing a chain of `if (ext === ...)` inside a React
   component — which is where format dispatch lived until now.

   --------------------------------------------------------------------------
   THE BUG THIS FIXES

   The old dispatch was:

       var isXML = /\.xml$/i.test(f.name);
       var parsed = isXML ? parseMSProjectXML(text) : parseCSV(text);

   CSV was not one branch of three. It was the ELSE. So dropping in a .mpp,
   a .xer, a .pdf or a photo read the bytes as text and ran the CSV parser
   over them, producing a preview of nonsense rows rather than "this format
   is not supported". The two formats explicitly deferred are exactly the two
   a planner is most likely to try.

   A registry makes the unsupported case an absence rather than a fallback:
   `resolve()` returns null and the caller says so.

   --------------------------------------------------------------------------
   ADAPTER SHAPE

     {
       id:         'csv',
       label:      'CSV',
       extensions: ['csv', 'txt'],   // lower case, no dot
       reads:      'text' | 'file',  // how the caller should hand it over
       parse:      (input) => parsed | Promise<parsed>,
       remap:      (file, columnMap) => Promise<parsed>   // optional
     }

   `reads` exists because XLSX needs the File itself (it unzips it) while CSV
   and XML want decoded text. Encoding that per adapter is what lets the
   caller stop knowing which is which.

   Pure: no React, no DOM. Registration order does not matter; extensions are
   unique per registry and a collision throws at registration rather than
   resolving to whichever won the race.

   Exported to:
     window.FS.api.programmeFormats   (browser)
     module.exports                   (node:test)
   ========================================================================== */

(function () {
  'use strict';

  function createRegistry() {
    var adapters = [];
    var byExt = {};

    function register(adapter) {
      if (!adapter || !adapter.id) throw new Error('an adapter needs an id');
      if (!adapter.extensions || !adapter.extensions.length) {
        throw new Error('adapter ' + adapter.id + ' claims no extensions');
      }
      if (typeof adapter.parse !== 'function') {
        throw new Error('adapter ' + adapter.id + ' has no parse()');
      }
      if (adapter.reads !== 'text' && adapter.reads !== 'file') {
        throw new Error('adapter ' + adapter.id + " must read 'text' or 'file'");
      }
      adapter.extensions.forEach(function (ext) {
        var e = String(ext).toLowerCase().replace(/^\./, '');
        /* Throwing beats last-one-wins: a silent override would send a whole
           format to the wrong parser, and the symptom is a bad preview
           rather than an error. */
        if (byExt[e]) {
          throw new Error('extension .' + e + ' is already handled by '
                          + byExt[e].id);
        }
        byExt[e] = adapter;
      });
      adapters.push(adapter);
      return adapter;
    }

    function extensionOf(filename) {
      var name = String(filename || '');
      var dot = name.lastIndexOf('.');
      /* A leading dot is a hidden file, not an extension: '.gitignore' has no
         format. */
      if (dot <= 0 || dot === name.length - 1) return null;
      return name.slice(dot + 1).toLowerCase();
    }

    /* null means "no adapter", which the caller must surface. It must never
       be read as "use the default one" — that fallback is the bug in the
       module header. */
    function resolve(filename) {
      var ext = extensionOf(filename);
      return ext ? (byExt[ext] || null) : null;
    }

    function list() { return adapters.slice(); }

    /* For an <input type="file" accept="..."> — derived from the registry so
       the picker and the parser can never disagree about what is allowed. */
    function accept() {
      return Object.keys(byExt).sort().map(function (e) { return '.' + e; }).join(',');
    }

    return {
      register: register, resolve: resolve, list: list, accept: accept,
      extensionOf: extensionOf,
    };
  }

  var registry = createRegistry();

  /* The three built-ins. They delegate to the existing parsers rather than
     reimplementing anything: this change is about dispatch, not parsing, and
     a refactor that also rewrote the parsers would make any regression
     impossible to attribute. */
  function _imp() {
    return (typeof window !== 'undefined' && window.FS && window.FS.api
            && window.FS.api.programmeImport) || null;
  }

  function registerBuiltins(target, impl) {
    var imp = impl || _imp();
    if (!imp) return target;
    target.register({
      id: 'csv', label: 'CSV', extensions: ['csv', 'txt'], reads: 'text',
      parse: function (text) { return imp.parseCSV(text); },
    });
    target.register({
      id: 'mspdi', label: 'MS Project XML (MSPDI)', extensions: ['xml'],
      reads: 'text',
      parse: function (text) { return imp.parseMSProjectXML(text); },
    });
    target.register({
      id: 'xlsx', label: 'Excel', extensions: ['xlsx', 'xls'], reads: 'file',
      parse: function (file) { return imp.parseXLSX(file); },
      remap: function (file, columnMap) {
        return imp.parseXLSXWithMap(file, columnMap);
      },
    });
    return target;
  }

  var api = {
    createRegistry:   createRegistry,
    registerBuiltins: registerBuiltins,
    registry:         registry,
    register:         function (a) { return registry.register(a); },
    resolve:          function (f) { return registry.resolve(f); },
    list:             function () { return registry.list(); },
    accept:           function () { return registry.accept(); },
    extensionOf:      function (f) { return registry.extensionOf(f); },
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeFormats = api;
    /* programme-import.js is registered before this file, so the built-ins
       can be wired at load. If that order ever changes the registry comes up
       empty and every import says "unsupported" — which the contract test
       pins. */
    registerBuiltins(registry);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
