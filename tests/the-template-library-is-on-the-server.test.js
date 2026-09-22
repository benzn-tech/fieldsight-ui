'use strict';

/*
 * The Template Library talks to the org API, and nothing is lost on the way.
 *
 * It used to be localStorage: a template lived as long as the tab that made it
 * and was invisible to everyone else in the company. The store was written to
 * "mirror the real backend surface so the swap-in is a backend-only change
 * with no UI rework", and this file is where that promise is checked -- the
 * pages call the same names and get the same shapes back.
 *
 * THE test is `an editor field the backend does not read still survives a
 * round trip`. The editor speaks {title, kind, fields, prompt_hint} and the
 * backend body speaks {key, title, purpose}; they meet in this one adapter. A
 * field silently dropped between two shapes is exactly how the templateVersion
 * bug happened, and a `kind` lost on save turns every section into prose the
 * next time somebody opens the editor.
 */
const test = require('node:test');
const assert = require('node:assert');

let calls;

function loadStore(opts) {
  opts = opts || {};
  calls = [];
  global.localStorage = (function () {
    const mem = {};
    return {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
    };
  })();
  global.window = {
    FS: {
      api: {
        useMocks: !!opts.useMocks,
        orgBaseUrl: opts.orgBaseUrl === undefined ? 'https://org.example/prod/api' : opts.orgBaseUrl,
        /* async, like the real orgRequest: a reply that throws must come back
           as a REJECTED PROMISE, not as a synchronous throw. Getting that
           wrong here would make the degrade-on-failure path look broken when
           it is the double that is unfaithful. */
        orgRequest: async function (path, o) {
          calls.push({ path, method: (o && o.method) || 'GET', params: o && o.params,
                       body: o && o.body, retry: o && o.retry });
          return opts.reply ? opts.reply(path, o) : {};
        },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/template-store.js')];
  require('../scripts/api/template-store.js');
  return global.window.FS.api.templates;
}

const SERVER_TEMPLATE = {
  id: 't-1', company_id: 'c-1', scope: 'org', owner_user_id: null, slug: 'daily',
  name: 'Company Daily', description: 'the one we send', report_type: 'daily',
  current_version: 2, created_at: 'then', updated_at: 'now',
};

const SERVER_BODY = {
  sections: [{ key: 'safety', title: 'Safety', purpose: 'What was said about safety.',
               kind: 'list', fields: ['hazard'] }],
  catch_all: { key: 'other', title: 'Anything else', purpose: 'The rest.' },
  excluded_subjects: [{ covers: 'lunch' }],
  style: ['Keep it short.'],
};

function replyFor(path, o) {
  if (path === '/templates' && (!o || o.method !== 'POST')) return { templates: [SERVER_TEMPLATE] };
  if (path === '/templates' && o.method === 'POST') return SERVER_TEMPLATE;
  if (path === '/templates/bindings') return { bindings: [{ template_id: 't-1', report_type: 'daily' }] };
  if (/\/versions$/.test(path)) {
    return { versions: [{ id: 'v-2', version: 2, body: SERVER_BODY, change_note: 'n',
                          created_by: 'u-1', created_at: 'now' },
                        { id: 'v-1', version: 1, body: SERVER_BODY, change_note: null,
                          created_by: 'u-1', created_at: 'then' }] };
  }
  return SERVER_TEMPLATE;
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: an editor field the backend does not read survives a round trip', async () => {
  const api = loadStore({ reply: replyFor });
  const editorSchema = {
    sections: [{ title: 'Safety', kind: 'table', fields: ['hazard', 'owner'],
                 prompt_hint: 'What was said about safety.' }],
  };
  const body = api._toBackendBody(editorSchema);
  assert.strictEqual(body.sections[0].kind, 'table', 'kind must not be dropped');
  assert.deepStrictEqual(body.sections[0].fields, ['hazard', 'owner']);

  const back = api._toEditorSchema(body);
  assert.strictEqual(back.sections[0].kind, 'table');
  assert.deepStrictEqual(back.sections[0].fields, ['hazard', 'owner']);
  assert.strictEqual(back.sections[0].prompt_hint, 'What was said about safety.');
});

/* ---- the shape adapter ------------------------------------------------------ */

test('prompt_hint becomes the purpose the prompt actually reads', () => {
  const api = loadStore({ reply: replyFor });
  const body = api._toBackendBody({ sections: [{ title: 'Safety', prompt_hint: 'Hazards.' }] });
  assert.strictEqual(body.sections[0].purpose, 'Hazards.');
  assert.ok(!('prompt_hint' in body.sections[0]), 'one sentence, not two copies of it');
});

test('a section gets a key derived from its title', () => {
  const api = loadStore({ reply: replyFor });
  const body = api._toBackendBody({ sections: [{ title: 'Issues & Risks', prompt_hint: 'x' }] });
  assert.strictEqual(body.sections[0].key, 'issues-risks');
});

test('a title with no ascii still gets a usable key, never an empty one', () => {
  const api = loadStore({ reply: replyFor });
  const body = api._toBackendBody({ sections: [{ title: '安全', prompt_hint: 'x' }] });
  assert.ok(body.sections[0].key, 'an empty key would collide with every other one');
  assert.strictEqual(body.sections[0].key, 'section-1');
});

test('nested sections are converted too, not left in the editor shape', () => {
  const api = loadStore({ reply: replyFor });
  const body = api._toBackendBody({
    sections: [{ title: 'Works', prompt_hint: 'p',
                 children: [{ title: 'Level 1', prompt_hint: 'child hint' }] }],
  });
  assert.strictEqual(body.sections[0].children[0].purpose, 'child hint');
});

test('catch_all, style and excluded_subjects are preserved, never regenerated', () => {
  /* The editor has no control for these. Writing a default on every save would
     silently overwrite whatever the company put there by another route. */
  const api = loadStore({ reply: replyFor });
  const body = api._toBackendBody({ sections: [{ title: 'S', prompt_hint: 'p' }] }, SERVER_BODY);
  assert.deepStrictEqual(body.catch_all, SERVER_BODY.catch_all);
  assert.deepStrictEqual(body.style, SERVER_BODY.style);
  assert.deepStrictEqual(body.excluded_subjects, SERVER_BODY.excluded_subjects);
});

test('a template with no previous body still gets a catch_all', () => {
  /* render_prompt subscripts template["catch_all"]; without one the worker
     raises rather than producing a worse report. */
  const api = loadStore({ reply: replyFor });
  const body = api._toBackendBody({ sections: [{ title: 'S', prompt_hint: 'p' }] });
  assert.ok(body.catch_all && body.catch_all.title && body.catch_all.purpose);
});

/* ---- the pages' shape is unchanged ------------------------------------------ */

test('a server row renders as the row /library already knows', async () => {
  const api = loadStore({ reply: replyFor });
  const res = await api.list();
  assert.deepStrictEqual(Object.keys(res), ['templates']);
  const row = res.templates[0];
  assert.strictEqual(row.title, 'Company Daily', 'the page reads .title, not .name');
  assert.strictEqual(row.scope, 'org');
  assert.strictEqual(row._status, 'ready');
});

test('active means a schedule is bound to it', async () => {
  const api = loadStore({ reply: replyFor });
  const row = (await api.list()).templates[0];
  assert.strictEqual(row.active, true);
});

test('a bindings failure leaves the Library listed, with nothing marked active', async () => {
  /* Wrong in the safer direction: a bound template reading as unbound invites
     a second look, where an unbound one reading as bound invites nothing. */
  const api = loadStore({
    reply: (path, o) => {
      if (path === '/templates/bindings') throw new Error('boom');
      return replyFor(path, o);
    },
  });
  const res = await api.list();
  assert.strictEqual(res.templates.length, 1);
  assert.strictEqual(res.templates[0].active, false);
});

/* ---- the requests themselves ------------------------------------------------ */

test('list narrows by scope only when asked', async () => {
  const api = loadStore({ reply: replyFor });
  await api.list('org');
  assert.deepStrictEqual(calls[0].params, { scope: 'org' });
  calls.length = 0;
  await api.list();
  assert.strictEqual(calls[0].params, undefined, 'all = no filter, not scope=all');
});

test('saving a schema posts a NEW version and never retries', async () => {
  /* A retried save is a second version of somebody's edit. */
  const api = loadStore({ reply: replyFor });
  await api.updateSchema('t-1', { sections: [{ title: 'S', prompt_hint: 'p' }] }, 'why');
  const post = calls.filter((c) => c.method === 'POST')[0];
  assert.strictEqual(post.path, '/templates/t-1/versions');
  assert.strictEqual(post.retry, false);
  assert.strictEqual(post.body.change_note, 'why');
});

test('saving reads the current version first so it can preserve what it cannot see', async () => {
  const api = loadStore({ reply: replyFor });
  await api.updateSchema('t-1', { sections: [{ title: 'S', prompt_hint: 'p' }] });
  assert.strictEqual(calls[0].path, '/templates/t-1/versions');
  assert.strictEqual(calls[0].method, 'GET');
  const post = calls.filter((c) => c.method === 'POST')[0];
  assert.deepStrictEqual(post.body.body.style, SERVER_BODY.style);
});

test('restore sends the version NUMBER, not the row id', async () => {
  const api = loadStore({ reply: replyFor });
  await api.restore('t-1', 'v-1');
  const post = calls.filter((c) => c.method === 'POST')[0];
  assert.strictEqual(post.path, '/templates/t-1/versions/1/restore');
});

test('restoring a version that is not there fails rather than restoring another', async () => {
  const api = loadStore({ reply: replyFor });
  await assert.rejects(() => api.restore('t-1', 'v-nope'), (e) => e.status === 404);
});

test('delete is a DELETE and does not retry', async () => {
  const api = loadStore({ reply: replyFor });
  await api['delete']('t-1');
  assert.strictEqual(calls[0].method, 'DELETE');
  assert.strictEqual(calls[0].retry, false);
});

test('activate binds the schedule to the template', async () => {
  const api = loadStore({ reply: replyFor });
  await api.activate('t-1');
  const put = calls.filter((c) => c.method === 'PUT')[0];
  assert.strictEqual(put.path, '/templates/bindings/daily');
  assert.deepStrictEqual(put.body, { template_id: 't-1' });
});

test('a personal template cannot be activated, and says why', async () => {
  const api = loadStore({
    reply: (path, o) => (path === '/templates/t-1'
      ? Object.assign({}, SERVER_TEMPLATE, { scope: 'personal' })
      : replyFor(path, o)),
  });
  await assert.rejects(() => api.activate('t-1'),
    (e) => /organisation template/.test(e.message));
});

test('a session template cannot be activated: nothing schedules one', async () => {
  const api = loadStore({
    reply: (path, o) => (path === '/templates/t-1'
      ? Object.assign({}, SERVER_TEMPLATE, { report_type: 'session' })
      : replyFor(path, o)),
  });
  await assert.rejects(() => api.activate('t-1'), (e) => /schedule/.test(e.message));
});

/* ---- without the org API ---------------------------------------------------- */

test('no org API: a clear refusal, not a silently empty library', async () => {
  /* An empty list here would read as "your company has no templates", which is
     a different and wrong statement. */
  const api = loadStore({ orgBaseUrl: '' });
  await assert.rejects(() => api.list(), (e) => /needs the org API/.test(e.message));
});

/* ---- favourites stay local -------------------------------------------------- */

test('favourites are per-viewer and cost no request', async () => {
  const api = loadStore({ reply: replyFor });
  await api.addFavourite('t-1');
  assert.deepStrictEqual(await api.getFavourites(), ['t-1']);
  assert.strictEqual(calls.length, 0, 'no round trip for one person pinning a row');
});

test('favourites still cap at six', async () => {
  const api = loadStore({ reply: replyFor });
  for (let i = 0; i < 9; i += 1) await api.addFavourite('t-' + i);
  assert.strictEqual((await api.getFavourites()).length, api.FAVOURITES_CAP);
});

/* ---- the surface the pages import ------------------------------------------- */

test('every name the pages call is still exported', () => {
  const api = loadStore({ reply: replyFor });
  for (const name of ['list', 'get', 'create', 'updateSchema', 'activate', 'delete',
                      'listVersions', 'restore', 'usageStats', 'getFavourites',
                      'isFavourite', 'addFavourite', 'removeFavourite',
                      'toggleFavourite', 'FAVOURITES_CAP']) {
    assert.ok(api[name] !== undefined, name + ' is gone; a page calls it');
  }
});

test('creating still notifies the listeners /library re-renders on', async () => {
  const api = loadStore({ reply: replyFor });
  const seen = [];
  global.window.FS.templateStore.onExtracted((id) => seen.push(id));
  await api.create({ scope: 'org', report_type: 'daily', title: 'New' });
  assert.deepStrictEqual(seen, ['t-1']);
});

test('a new template is created with sections, not empty', async () => {
  const api = loadStore({ reply: replyFor });
  await api.create({ scope: 'org', report_type: 'weekly', title: 'New' });
  const post = calls.filter((c) => c.method === 'POST')[0];
  assert.ok(post.body.body.sections.length > 0);
  assert.ok(post.body.body.sections.every((s) => s.purpose),
    'the server rejects a section with no purpose');
});
