'use strict';

/*
 * create() used to send the starting sections for the report type and DISCARD whatever
 * it was handed -- the API layer rebuilt the body. A digitised form's 115 items would
 * have been dropped on the way to the server with nothing anywhere saying so
 * (spec 2026-10-16 section 5). THE test reads the real request body.
 */
const test = require('node:test');
const assert = require('node:assert');

let calls;

function loadStore() {
  calls = [];
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.window = {
    FS: {
      api: {
        useMocks: false,
        orgBaseUrl: 'https://org.example/prod/api',
        orgRequest: async function (path, o) {
          calls.push({ path, method: (o && o.method) || 'GET', body: o && o.body });
          return { id: 't-9', company_id: 'c-1', scope: 'personal', slug: 's', name: 'n',
                   description: '', report_type: 'custom', current_version: 1,
                   created_at: 'now', updated_at: 'now' };
        },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/template-store.js')];
  require('../scripts/api/template-store.js');
  return global.window.FS.api.templates;
}

const CHECKLIST = {
  sections: [{ key: 'general-1', title: 'General', kind: 'checklist',
               purpose: "Record the inspector's answer to each item from the recording.",
               items: ['Gate locked?', 'Signage up?'] }],
  catch_all: { key: 'other', title: 'Anything else', purpose: 'x' },
  excluded_subjects: [], style: [],
};

test('THE: a full body is sent as given', async () => {
  const api = loadStore();
  await api.create({ scope: 'personal', report_type: 'custom', title: 'Site form', body: CHECKLIST });
  const sent = calls.find((c) => c.path === '/templates' && c.method === 'POST').body;
  assert.deepStrictEqual(sent.body, CHECKLIST);
  assert.strictEqual(sent.report_type, 'custom');
  assert.strictEqual(sent.name, 'Site form');
});

test('sections without a body go through the shape adapter and keep their items', async () => {
  const api = loadStore();
  await api.create({ title: 'x', sections: [{ title: 'General', kind: 'checklist',
    purpose: 'p', items: ['A?'] }] });
  const sent = calls.find((c) => c.method === 'POST').body.body;
  assert.deepStrictEqual(sent.sections[0].items, ['A?']);
  assert.strictEqual(sent.sections[0].kind, 'checklist');
  assert.strictEqual(sent.sections[0].key, 'general');
  assert.deepStrictEqual(sent.catch_all, api.DEFAULT_CATCH_ALL);
});

test('with neither, the starting sections for the report type are still sent', async () => {
  const api = loadStore();
  await api.create({ title: 'x', report_type: 'weekly' });
  const sent = calls.find((c) => c.method === 'POST').body.body;
  assert.strictEqual(sent.sections[0].title, 'Executive Summary');
});

test('the catch-all is exported and cannot be mutated through the export', () => {
  const api = loadStore();
  assert.strictEqual(api.DEFAULT_CATCH_ALL.key, 'other');
  api.DEFAULT_CATCH_ALL.title = 'changed';
  assert.notStrictEqual(api.DEFAULT_CATCH_ALL.title, 'changed');
});
