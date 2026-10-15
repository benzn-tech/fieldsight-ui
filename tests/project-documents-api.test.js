'use strict';

/*
 * Project documents, the api layer (backend spec 2026-10-16-project-documents-design).
 * THE test is that "off" -- the server's own 404 {"error": "not found"} -- hides the
 * feature without uploading anything, while any other 404 is shown to the person.
 */
const test = require('node:test');
const assert = require('node:assert');

let calls, puts;
const OFF = { _notFound: true, status: 404, raw: { error: 'not found' } };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function load(reply) {
  calls = []; puts = [];
  global.window = { FS: { api: {
    orgRequest: async function (p, o) {
      calls.push({ path: p, method: (o && o.method) || 'GET', body: o && o.body, retry: o && o.retry });
      return reply(p, o || {});
    },
  } } };
  delete require.cache[require.resolve('../scripts/api/project-documents.js')];
  require('../scripts/api/project-documents.js');
  return global.window.FS.api.projectDocuments;
}

const okFetch = async (url, o) => { puts.push({ url, o }); return { ok: true, status: 200 }; };
function file(name, size, type) { return { name, size: size || 10, type: type === undefined ? 'x' : type }; }

test('THE: switched off, the list says off and an upload sends nothing', async () => {
  const PD = load(() => OFF);
  assert.deepStrictEqual(await PD.list('s1'), { off: true });
  assert.deepStrictEqual(await PD.upload('s1', file('a.pdf'), { fetch: okFetch }), { off: true });
  assert.strictEqual(puts.length, 0);
});

test('a 404 with its own message is shown, not read as off', async () => {
  const PD = load(() => ({ _notFound: true, status: 404, raw: { error: 'project not found' } }));
  await assert.rejects(PD.list('s1'), /Project not found\./);
});

test('list returns the documents and whether this person may change them', async () => {
  const PD = load(() => ({ documents: [{ id: 'd1' }], canWrite: true }));
  assert.deepStrictEqual(await PD.list('s 1'), { documents: [{ id: 'd1' }], canWrite: true });
  assert.strictEqual(calls[0].path, '/sites/s%201/documents');
});

test('history asks for one series', async () => {
  const PD = load(() => ({ documents: [] }));
  await PD.history('s1', 'ser-1');
  assert.strictEqual(calls[0].path, '/sites/s1/documents?series=ser-1');
});

test('upload: signed type from the extension, PUT, then create -- never retried', async () => {
  const PD = load((p) => p.endsWith('/upload-url')
    ? { uploadUrl: 'https://s3/put', sourceKey: 'project_doc_sources/c/d.docx', documentId: 'd' }
    : { id: 'd', status: 'pending', seriesId: 'ser', revision: 2 });
  const out = await PD.upload('s1', file('Spec.DOCX', 99, ''), { fetch: okFetch, seriesId: 'ser' });
  assert.deepStrictEqual(calls[0].body, { filename: 'Spec.DOCX', contentType: DOCX, size: 99 });
  assert.strictEqual(puts[0].o.headers['Content-Type'], DOCX);
  assert.deepStrictEqual(calls[1], { path: '/sites/s1/documents', method: 'POST', retry: false,
    body: { sourceKey: 'project_doc_sources/c/d.docx', filename: 'Spec.DOCX', title: 'Spec.DOCX', seriesId: 'ser' } });
  assert.ok(calls.every((c) => c.retry === false));
  assert.strictEqual(out.revision, 2);
});

test('a failed PUT stops before the document is created', async () => {
  const PD = load(() => ({ uploadUrl: 'u', sourceKey: 'k' }));
  await assert.rejects(PD.upload('s1', file('a.md'), { fetch: async () => ({ ok: false, status: 403 }) }), /failed \(403\)/);
  assert.strictEqual(calls.length, 1);
});

test('checkFile refuses other types and files over 50 MB', () => {
  const PD = load(() => ({}));
  assert.match(PD.checkFile(file('plan.dwg')), /Word file/);
  assert.match(PD.checkFile(file('a.pdf', 50 * 1024 * 1024 + 1)), /larger than 50 MB/);
  assert.strictEqual(PD.checkFile(file('notes.txt')), null);
});

test('rename, remove and retry use their routes and are never retried', async () => {
  const PD = load(() => ({}));
  await PD.rename('s1', 'd1', 'New');
  await PD.remove('s1', 'd1');
  await PD.retry('s1', 'd1');
  assert.deepStrictEqual(calls.map((c) => [c.method, c.path, c.retry]), [
    ['PATCH', '/sites/s1/documents/d1', false],
    ['DELETE', '/sites/s1/documents/d1', false],
    ['POST', '/sites/s1/documents/d1/retry', false],
  ]);
  assert.deepStrictEqual(calls[0].body, { title: 'New' });
});

test('statusOf: searchable, not readable, failed, indexing, and stuck after 20 minutes', () => {
  const PD = load(() => ({}));
  const now = Date.parse('2026-10-16T10:00:00Z');
  assert.strictEqual(PD.statusOf({ status: 'indexed' }, now).label, 'Searchable');
  assert.deepStrictEqual(PD.statusOf({ status: 'unreadable', reason: 'Scanned' }, now),
    { label: 'Not readable', tone: 'neutral', canRetry: false, detail: 'Scanned' });
  assert.strictEqual(PD.statusOf({ status: 'error', reason: 'x' }, now).canRetry, true);
  const fresh = { status: 'pending', requestedAt: '2026-10-16T09:50:00Z' };
  assert.deepStrictEqual(PD.statusOf(fresh, now), { label: 'Indexing…', tone: 'info', canRetry: false, detail: '' });
  const stuck = { status: 'pending', requestedAt: '2026-10-16T09:39:00Z' };
  assert.deepStrictEqual(PD.statusOf(stuck, now), { label: 'Taking too long', tone: 'warning', canRetry: true, detail: '' });
});

test('pageHref opens a PDF at the page and leaves anything else alone', () => {
  const PD = load(() => ({}));
  assert.strictEqual(PD.pageHref('https://s3/x', 'application/pdf', 4), 'https://s3/x#page=4');
  assert.strictEqual(PD.pageHref('https://s3/x', 'application/pdf', null), 'https://s3/x');
  assert.strictEqual(PD.pageHref('https://s3/x', DOCX, 4), 'https://s3/x');
});

test('open() opens the window before it awaits, then points it at the page', async () => {
  const order = [];
  const tab = { location: { href: '' }, close() { order.push('close'); } };
  const host = { open() { order.push('open'); return tab; } };
  const PD = load(() => { order.push('request'); return { url: 'https://s3/x', contentType: 'application/pdf' }; });
  const href = await PD.open('s1', 'd1', 7, { window: host });
  assert.deepStrictEqual(order, ['open', 'request']);
  assert.strictEqual(tab.location.href, 'https://s3/x#page=7');
  assert.strictEqual(href, 'https://s3/x#page=7');
  assert.strictEqual(calls[0].path, '/sites/s1/documents/d1/file');
});

test('a failed open() closes the blank tab and says why', async () => {
  const order = [];
  const tab = { location: { href: '' }, close() { order.push('close'); } };
  const PD = load(() => { throw new Error('boom'); });
  await assert.rejects(PD.open('s1', 'd1', null, { window: { open: () => tab } }), /boom/);
  assert.deepStrictEqual(order, ['close']);
});

test('labels and palette rows', () => {
  const PD = load(() => ({}));
  assert.strictEqual(PD.pageLabel(4, 4), 'p. 4');
  assert.strictEqual(PD.pageLabel(4, 6), 'pp. 4–6');
  assert.strictEqual(PD.pageLabel(null, null), '');
  assert.strictEqual(PD.citeLabel({ title: 'Spec', heading: '3.2 Formwork', page: 4, page_to: 4 }),
    'Spec · 3.2 Formwork · p. 4');
  const items = PD.toPaletteItems([{ document_id: 'd1', site_id: 's1', site_name: 'Tower',
    title: 'Spec', heading: '3.2 Formwork', page_from: 4, page_to: 5 }]);
  assert.deepStrictEqual(items, [{ type: 'document', id: 'doc_0_d1', title: 'Spec',
    subtitle: '3.2 Formwork · pp. 4–5 · Tower', siteId: 's1', documentId: 'd1', page: 4 }]);
});
