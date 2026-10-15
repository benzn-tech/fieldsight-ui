'use strict';

/*
 * The palette's "Project documents" group (backend R7): a separate group under the
 * recording results, each hit opening the original at its page. Documents are never
 * mixed into the Topics group.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const palette = fs.readFileSync(require.resolve('../scripts/composites/search-palette.js'), 'utf8');

test('search asks for documents beside the topics', async () => {
  let sent;
  global.window = { FS: { api: { useMocks: false, orgBaseUrl: 'https://x/prod/api',
    request: async (p, o) => { sent = o.body; return { results: [] }; } } } };
  delete require.cache[require.resolve('../scripts/api/search.js')];
  require('../scripts/api/search.js');
  await global.window.FS.api.search.topics({ q: 'formwork tolerance', site: null });
  assert.strictEqual(sent.include_documents, true);
});

test('documents have their own group, after Topics', () => {
  const topics = palette.indexOf("}, 'Topics')");
  const docs = palette.indexOf("}, 'Project documents')");
  assert.ok(topics > -1 && docs > topics);
});

test('the rows come from the search answer and are cleared with it', () => {
  assert.match(palette, /setDocRows\(\(r && r\.documents\) \|\| \[\]\)/);
  assert.ok((palette.match(/setDocRows\(\[\]\)/g) || []).length >= 3);
  assert.match(palette, /projectDocuments\.toPaletteItems\(docRows\)/);
});

test('choosing a document opens the original at its page', () => {
  const sel = palette.slice(palette.indexOf('function doSelect'));
  assert.match(sel.slice(0, 900), /item\.type === 'document'/);
  assert.match(sel.slice(0, 900), /projectDocuments\.open\(item\.siteId, item\.documentId, item\.page\)/);
});

test('"No results" waits for the documents too', () => {
  assert.match(palette, /!topicItems\.length && !docItems\.length/);
});

test('no document group where the org API is off (kill switch)', () => {
  assert.match(palette, /PD\.isLive && PD\.isLive\(\) && docRows\.length/);
});
