'use strict';

/*
 * The pluggable import format registry.
 *
 * The assertion this file exists for is that an unsupported file resolves to
 * NOTHING. The dispatch it replaces was `isXML ? parseMSProjectXML : parseCSV`
 * — CSV was the else, not a branch — so a .mpp, a .xer or a PDF was read as
 * text and run through the CSV parser, producing a preview of nonsense rows
 * instead of "not supported". The two formats deliberately deferred are the
 * two a planner is most likely to try.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  createRegistry, registerBuiltins,
} = require('../scripts/api/programme-format-registry.js');

const FAKE_IMPL = {
  parseCSV: t => ({ from: 'csv', t }),
  parseMSProjectXML: t => ({ from: 'mspdi', t }),
  parseXLSX: f => Promise.resolve({ from: 'xlsx', f }),
  parseXLSXWithMap: (f, m) => Promise.resolve({ from: 'xlsx-map', f, m }),
};

function built() {
  return registerBuiltins(createRegistry(), FAKE_IMPL);
}

/* ---- the refusal ---------------------------------------------------------- */

test('an unsupported format resolves to null, not to CSV', () => {
  const r = built();
  for (const name of ['plan.mpp', 'plan.xer', 'scan.pdf', 'photo.jpg', 'notes.docx']) {
    assert.strictEqual(r.resolve(name), null, `${name} must not resolve`);
  }
});

test('the two deferred formats are the ones that used to parse as CSV', () => {
  /* Named explicitly because they are the whole reason this matters: XER and
     MPP were deferred, and a deferred format that silently produces a
     plausible-looking preview is worse than one that is refused. */
  const r = built();
  assert.strictEqual(r.resolve('programme.xer'), null);
  assert.strictEqual(r.resolve('programme.mpp'), null);
});

test('a file with no extension resolves to null', () => {
  assert.strictEqual(built().resolve('programme'), null);
});

test('a dotfile has no extension', () => {
  /* '.gitignore' is a hidden file, not a file of type "gitignore". */
  assert.strictEqual(built().extensionOf('.gitignore'), null);
  assert.strictEqual(built().resolve('.gitignore'), null);
});

test('a trailing dot is not an extension', () => {
  assert.strictEqual(built().extensionOf('programme.'), null);
});

test('an empty or missing filename resolves to null rather than throwing', () => {
  const r = built();
  assert.strictEqual(r.resolve(''), null);
  assert.strictEqual(r.resolve(null), null);
  assert.strictEqual(r.resolve(undefined), null);
});

/* ---- resolution ----------------------------------------------------------- */

test('each supported extension reaches its own adapter', () => {
  const r = built();
  assert.strictEqual(r.resolve('a.csv').id, 'csv');
  assert.strictEqual(r.resolve('a.txt').id, 'csv');
  assert.strictEqual(r.resolve('a.xml').id, 'mspdi');
  assert.strictEqual(r.resolve('a.xlsx').id, 'xlsx');
  assert.strictEqual(r.resolve('a.xls').id, 'xlsx');
});

test('extensions are matched case-insensitively', () => {
  /* Windows hands over PROGRAMME.XLSX often enough to matter. */
  const r = built();
  assert.strictEqual(r.resolve('PROGRAMME.XLSX').id, 'xlsx');
  assert.strictEqual(r.resolve('Plan.CSV').id, 'csv');
});

test('only the last dot counts', () => {
  assert.strictEqual(built().resolve('rev.2026.04.29.csv').id, 'csv');
});

test('an adapter says how it wants the file handed over', () => {
  /* XLSX needs the File (it unzips it); CSV and XML want decoded text.
     Encoding that per adapter is what lets the caller stop knowing which. */
  const r = built();
  assert.strictEqual(r.resolve('a.csv').reads, 'text');
  assert.strictEqual(r.resolve('a.xml').reads, 'text');
  assert.strictEqual(r.resolve('a.xlsx').reads, 'file');
});

test('parsing routes to the right underlying parser', () => {
  const r = built();
  assert.strictEqual(r.resolve('a.csv').parse('x').from, 'csv');
  assert.strictEqual(r.resolve('a.xml').parse('x').from, 'mspdi');
});

test('only the adapter that needs a column map offers one', () => {
  const r = built();
  assert.strictEqual(typeof r.resolve('a.xlsx').remap, 'function');
  assert.strictEqual(r.resolve('a.csv').remap, undefined);
});

/* ---- registration --------------------------------------------------------- */

test('a new format is added without touching any existing code', () => {
  /* The point of the whole module: this is what adding XER later looks like. */
  const r = built();
  r.register({
    id: 'xer', label: 'Primavera XER', extensions: ['xer'], reads: 'text',
    parse: t => ({ from: 'xer', t }),
  });
  assert.strictEqual(r.resolve('plan.xer').id, 'xer');
  assert.strictEqual(r.resolve('plan.csv').id, 'csv', 'existing formats intact');
});

test('a duplicate extension throws instead of silently overriding', () => {
  /* Last-one-wins would send a whole format to the wrong parser, and the
     symptom is a bad preview rather than an error. */
  const r = built();
  assert.throws(() => r.register({
    id: 'other-csv', extensions: ['csv'], reads: 'text', parse: () => {},
  }), /already handled by csv/);
});

test('a malformed adapter is refused at registration', () => {
  const r = createRegistry();
  assert.throws(() => r.register({ extensions: ['a'], reads: 'text', parse: () => {} }), /id/);
  assert.throws(() => r.register({ id: 'x', reads: 'text', parse: () => {} }), /extensions/);
  assert.throws(() => r.register({ id: 'x', extensions: ['a'], reads: 'text' }), /parse/);
  assert.throws(() => r.register({ id: 'x', extensions: ['a'], parse: () => {} }), /text.*file/);
});

test('a leading dot in a declared extension is tolerated', () => {
  const r = createRegistry();
  r.register({ id: 'x', extensions: ['.foo'], reads: 'text', parse: () => 1 });
  assert.strictEqual(r.resolve('a.foo').id, 'x');
});

/* ---- the file picker ------------------------------------------------------ */

test('the accept string is derived from the registry, not written twice', () => {
  /* A hand-maintained accept="" is how a picker starts allowing a file the
     parser will then refuse, or refusing one it could read. */
  assert.strictEqual(built().accept(), '.csv,.txt,.xls,.xlsx,.xml');
});

test('registering a format widens the picker automatically', () => {
  const r = built();
  r.register({ id: 'xer', extensions: ['xer'], reads: 'text', parse: () => 1 });
  assert.ok(r.accept().includes('.xer'));
});

test('an empty registry accepts nothing rather than everything', () => {
  assert.strictEqual(createRegistry().accept(), '');
});

test('registerBuiltins with no implementation available is a no-op, not a crash', () => {
  /* In the browser this file loads after programme-import.js. If that order
     ever changes the registry comes up empty and every import reports
     "unsupported" — which is a visible failure, not a silent mis-parse. */
  const r = registerBuiltins(createRegistry(), null);
  assert.deepStrictEqual(r.list(), []);
});
