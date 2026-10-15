'use strict';

/*
 * Reading a form into a draft template: upload -> request -> poll -> review -> Save
 * (pipeline spec 2026-10-16). The server's routes answer 404 when reading is switched
 * off, and orgRequest hands that back as { _notFound: true } rather than throwing --
 * THE test is that "off" falls back without uploading anything.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let calls, puts;

function load(reply) {
  calls = []; puts = [];
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.window = { FS: { api: {
    useMocks: false, orgBaseUrl: 'https://org.example/prod/api',
    orgRequest: async function (p, o) {
      calls.push({ path: p, method: (o && o.method) || 'GET', body: o && o.body, retry: o && o.retry });
      return reply(p, o || {});
    },
  } } };
  for (const f of ['../scripts/api/template-store.js', '../scripts/api/template-digitise.js']) {
    delete require.cache[require.resolve(f)];
    require(f);
  }
  return global.window.FS.api.templateDigitise;
}

function file(name, size, type) { return { name, size: size || 10, type: type === undefined ? 'x' : type }; }
const okFetch = async (url, o) => { puts.push({ url, o }); return { ok: true, status: 200 }; };
const noSleep = async () => {};
/* What orgRequest resolves for the server's flag-off answer, error("not found", 404). */
const OFF = { _notFound: true, status: 404, raw: { error: 'not found' } };

function server(results) {
  let n = 0; const seq = results.slice();
  return (p, o) => {
    if (p === '/templates/digitise/upload-url') { n += 1; return { uploadUrl: 'https://s3/put/' + n, sourceKey: 'template_sources/c/' + n + '.jpg', expiresIn: 900 }; }
    if (p === '/templates/digitise') return { id: 'r1', status: 'pending' };
    if (p === '/templates/digitise/r1') return seq.length > 1 ? seq.shift() : seq[0];
    throw new Error('unexpected ' + p);
  };
}

const DONE = { id: 'r1', status: 'done', name: 'Form', flags: [], counts: { sections: 1, items: 1 },
  sections: [{ title: 'General', items: [{ text: 'Gate locked?', flags: [] }], flags: [] }],
  sources: [{ key: 'k', contentType: 'image/jpeg', url: 'https://s3/get/k' }] };

test('THE: reading switched off falls back without uploading anything', async () => {
  const TD = load(() => OFF);
  const phases = [];
  const out = await TD.digitise([file('a.jpg')], 'Form', { onPhase: (p) => phases.push(p), fetch: okFetch, sleep: noSleep });
  assert.deepStrictEqual(out, { off: true });
  assert.strictEqual(puts.length, 0);
  assert.ok(!phases.includes('reading'), 'never claims to be reading a form it did not send');
});

test('photos are uploaded in order, read, and polled until done', async () => {
  const TD = load(server([{ id: 'r1', status: 'pending' }, { id: 'r1', status: 'pending' }, DONE]));
  const phases = []; const slept = [];
  const out = await TD.digitise([file('p1.jpg'), file('p2.png')], 'Form',
    { onPhase: (p) => phases.push(p), fetch: okFetch, sleep: async (ms) => { slept.push(ms); } });
  assert.strictEqual(out.status, 'done');
  assert.deepStrictEqual(phases, ['uploading', 'reading']);
  assert.deepStrictEqual(puts.map((p) => p.url), ['https://s3/put/1', 'https://s3/put/2']);
  assert.deepStrictEqual(puts.map((p) => p.o.headers['Content-Type']), ['image/jpeg', 'image/png']);
  const req = calls.find((c) => c.path === '/templates/digitise');
  assert.deepStrictEqual(req.body, { sourceKeys: ['template_sources/c/1.jpg', 'template_sources/c/2.jpg'], name: 'Form' });
  assert.strictEqual(req.retry, false, 'a POST is never retried (a 504 is not a failed write)');
  assert.deepStrictEqual(slept, [TD.POLL_MS, TD.POLL_MS]);
});

test('a Word file with no browser type still uploads with the signed type', async () => {
  const TD = load(server([DONE]));
  await TD.digitise([file('Form.DOCX', 10, '')], 'Form', { fetch: okFetch, sleep: noSleep });
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  assert.strictEqual(calls[0].body.contentType, DOCX);
  assert.strictEqual(puts[0].o.headers['Content-Type'], DOCX);
});

test('the poll gives up after three minutes', async () => {
  const TD = load(server([{ id: 'r1', status: 'pending' }]));
  let t = 0;
  await assert.rejects(
    TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: async (ms) => { t += ms; }, now: () => t }),
    /Taking too long — try again\./);
});

test('a draft that has gone (404 on the poll) is said so', async () => {
  const TD = load((p) => (p === '/templates/digitise/r1' ? OFF : server([DONE])(p)));
  await assert.rejects(TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep }),
    /no longer available/);
});

test('a failed upload stops before the read is requested', async () => {
  const TD = load(server([DONE]));
  await assert.rejects(TD.digitise([file('a.jpg')], 'Form',
    { fetch: async () => ({ ok: false, status: 403 }), sleep: noSleep }), /Upload of a\.jpg failed/);
  assert.ok(!calls.some((c) => c.path === '/templates/digitise'));
});

test('files are checked before anything is sent', () => {
  const TD = load(server([DONE]));
  assert.match(TD.checkFiles([file('a.md')]), /PDF/);
  assert.match(TD.checkFiles([file('a.pdf'), file('b.jpg')]), /not a mix/);
  assert.match(TD.checkFiles([file('a.pdf'), file('b.pdf')]), /one PDF/);
  assert.match(TD.checkFiles(Array.from({ length: 11 }, (_, i) => file(i + '.jpg'))), /Up to 10/);
  assert.match(TD.checkFiles([file('a.jpg', 20 * 1024 * 1024 + 1)]), /20 MB/);
  assert.strictEqual(TD.checkFiles([file('a.docx')]), null);
});

/* ---- the save mapping ------------------------------------------------------- */

test('the save body is checklist sections of plain strings with the house purpose', () => {
  const TD = load(server([DONE]));
  const body = TD.toTemplateBody({ sections: [
    { title: ' General ', items: [{ text: 'Gate  locked?', flags: ['truncated'] }, { text: '  ', flags: [] }], flags: [] },
    { title: 'Empty', items: [], flags: [] },
    { title: 'General', items: [{ text: 'Lights on?', flags: [] }], flags: ['split_section'] }] });
  assert.deepStrictEqual(body.sections, [
    { key: 'general-1', title: 'General', kind: 'checklist', purpose: TD.PURPOSE, items: ['Gate locked?'] },
    { key: 'general-2', title: 'General', kind: 'checklist', purpose: TD.PURPOSE, items: ['Lights on?'] }]);
  assert.strictEqual(TD.PURPOSE, "Record the inspector's answer to each item from the recording.");
  assert.deepStrictEqual(body.catch_all, window.FS.api.templates.DEFAULT_CATCH_ALL);
  assert.deepStrictEqual([body.excluded_subjects, body.style], [[], []]);
});

test('the body is refused here for every rule the server refuses', () => {
  const TD = load(server([DONE]));
  const sec = (title, n, len) => ({ title, items: Array.from({ length: n }, () => ({ text: 'x'.repeat(len || 5), flags: [] })), flags: [] });
  const P = (sections) => TD.bodyProblem(TD.toTemplateBody({ sections }));
  assert.strictEqual(P([sec('A', 3)]), null);
  assert.match(P([]), /at least one section/);
  assert.match(P(Array.from({ length: 41 }, (_, i) => sec('S' + i, 1))), /40 sections/);
  assert.match(P([sec('', 1)]), /needs a name/);
  assert.match(P([sec('T'.repeat(121), 1)]), /120 characters/);
  assert.match(P([sec('A', 121)]), /more than 120 items/);
  assert.match(P([sec('A', 1, 301)]), /300 characters/);
  assert.match(P(Array.from({ length: 3 }, (_, i) => sec('S' + i, 120, 200))), /longer than a template can hold/);
});

test('the contract: the Penina form saves as exactly the committed body', () => {
  const TD = load(server([DONE]));
  const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'template-digitise.truth-penina.json'), 'utf8'));
  const draft = TD.fromResult({ name: 'Penina', flags: [], sections: truth.sections.map((s) => ({
    title: s.title, flags: [], items: s.items.map((t) => ({ text: t, flags: [] })) })) });
  const body = TD.toTemplateBody(draft);
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'template-digitise.save-body.json'), 'utf8'));
  assert.deepStrictEqual(body, committed);
  assert.strictEqual(TD.bodyProblem(body), null);
});

/* ---- review edits ----------------------------------------------------------- */

test('the review edits never mutate the draft they are given', () => {
  const TD = load(server([DONE]));
  const d = { sections: [
    { title: 'A', items: [{ text: 'a1', flags: ['truncated'] }, { text: 'a2', flags: [] }], flags: ['split_section'] },
    { title: 'A', items: [{ text: 'b1', flags: [] }], flags: ['split_section'] }], flags: [] };
  const frozen = JSON.stringify(d);
  const merged = TD.ops.mergeWithNext(d, 0);
  assert.deepStrictEqual(merged.sections.map((s) => s.items.map((i) => i.text)), [['a1', 'a2', 'b1']]);
  assert.deepStrictEqual(merged.sections[0].flags, []);
  assert.deepStrictEqual(TD.ops.editItem(d, 0, 0, 'A1').sections[0].items[0], { text: 'A1', flags: [] });
  assert.deepStrictEqual(TD.ops.moveItem(d, 0, 0, 1).sections[0].items.map((i) => i.text), ['a2', 'a1']);
  assert.deepStrictEqual(TD.ops.moveSection(d, 1, -1).sections.map((s) => s.items[0].text), ['b1', 'a1']);
  assert.strictEqual(TD.ops.addItem(d, 1).sections[1].items.length, 2);
  assert.strictEqual(TD.ops.deleteItem(d, 0, 1).sections[0].items.length, 1);
  assert.strictEqual(TD.ops.deleteSection(d, 0).sections.length, 1);
  assert.deepStrictEqual(TD.ops.renameSection(d, 0, 'Z').sections[0].flags, []);
  assert.strictEqual(JSON.stringify(d), frozen);
});

test('every flag the server can send has words for the person', () => {
  const TD = load(server([DONE]));
  for (const f of ['label_kept', 'near_duplicate_section', 'split_section', 'truncated',
                   'split_for_limit', 'too_many_sections', 'too_long']) {
    assert.ok(TD.FLAG_TEXT[f], f + ' has no wording');
  }
});

/* ---- Close stops the work (fix round 1) ------------------------------------- */

test('cancelled during the upload: no further page is sent and the read is never requested', async () => {
  const TD = load(server([DONE]));
  let closed = false;
  const fetchThenClose = async (url, o) => { puts.push({ url, o }); closed = true; return { ok: true, status: 200 }; };
  const out = await TD.digitise([file('p1.jpg'), file('p2.jpg'), file('p3.jpg')], 'Form',
    { fetch: fetchThenClose, sleep: noSleep, cancelled: () => closed });
  assert.deepStrictEqual(out, { cancelled: true });
  assert.strictEqual(puts.length, 1, 'pages after Close were still uploaded');
  assert.ok(!calls.some((c) => c.path === '/templates/digitise'), 'the billed read was requested after Close');
});

test('cancelled while polling: polling stops', async () => {
  const TD = load(server([{ id: 'r1', status: 'pending' }]));
  let polls = 0; let closed = false;
  const out = await TD.digitise([file('p1.jpg')], 'Form', {
    fetch: okFetch, cancelled: () => closed, now: () => polls * 10000,
    sleep: async () => { polls += 1; if (polls === 2) closed = true; },
  });
  assert.deepStrictEqual(out, { cancelled: true });
  assert.strictEqual(calls.filter((c) => c.path === '/templates/digitise/r1').length, 2);
});

test('only a real 404 means reading is off; any other non-JSON answer is a failure', async () => {
  let TD = load(() => ({ _notFound: true, status: 502 }));
  await assert.rejects(TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep }), /unexpected answer \(502\)/);
  TD = load(() => ({ _notFound: true, status: 200 }));
  await assert.rejects(TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep }), /unexpected answer \(200\)/);
});

test('a 404 that explains itself is shown to the person, not taken for "off"', async () => {
  const msg = 'an uploaded file was not found — upload it again';
  const TD = load((p) => (p === '/templates/digitise'
    ? { _notFound: true, status: 404, raw: { error: msg } } : server([DONE])(p)));
  await assert.rejects(TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep }),
    (e) => e.message === 'An uploaded file was not found — upload it again.');
  assert.ok(puts.length === 1, 'the upload happened; only the read was refused');
});

test('a 404 with no JSON message is a failure, not "off"', async () => {
  const TD = load(() => ({ _notFound: true, status: 404 }));
  await assert.rejects(TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep }),
    /unexpected answer \(404\)/);
  const TD2 = load(() => ({ _notFound: true, status: 404, raw: { message: 'Not Found' } }));
  await assert.rejects(TD2.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep }),
    /unexpected answer \(404\)/);
});

test('an expired draft on the poll says what the server said', async () => {
  const TD = load((p) => (p === '/templates/digitise/r1'
    ? { _notFound: true, status: 404, raw: { error: 'this draft has expired — upload the form again' } }
    : server([DONE])(p)));
  await assert.rejects(TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep }),
    /This draft has expired — upload the form again\./);
});

test('the poll gives up at three minutes exactly', () => {
  const TD = load(server([DONE]));
  assert.strictEqual(TD.GIVE_UP_MS, 180000);
});

test('one 502 blip while polling is a missed poll, then done resolves done', async () => {
  let polls = 0;
  const TD = load((p) => {
    if (p !== '/templates/digitise/r1') return server([DONE])(p);
    polls += 1;
    if (polls === 1) { const e = new Error('HTTP 502'); e.status = 502; throw e; }
    return DONE;
  });
  const out = await TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep });
  assert.strictEqual(out.status, 'done');
  assert.strictEqual(polls, 2);
});

test('a non-JSON answer while polling is a missed poll too', async () => {
  let polls = 0;
  const TD = load((p) => {
    if (p !== '/templates/digitise/r1') return server([DONE])(p);
    polls += 1;
    return polls === 1 ? { _notFound: true, status: 504 } : DONE;
  });
  const out = await TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep });
  assert.strictEqual(out.status, 'done');
});

test('5xx on every poll still gives up at GIVE_UP_MS, not before', async () => {
  let t = 0; let polls = 0;
  const TD = load((p) => {
    if (p !== '/templates/digitise/r1') return server([DONE])(p);
    polls += 1;
    const e = new Error('HTTP 503'); e.status = 503; throw e;
  });
  await assert.rejects(
    TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: async (ms) => { t += ms; }, now: () => t }),
    /Taking too long — try again\./);
  assert.strictEqual(polls, TD.GIVE_UP_MS / TD.POLL_MS + 1);
});

test('a 4xx error while polling is still a failure at once', async () => {
  const TD = load((p) => {
    if (p !== '/templates/digitise/r1') return server([DONE])(p);
    const e = new Error('nope'); e.status = 400; throw e;
  });
  await assert.rejects(TD.digitise([file('a.jpg')], 'Form', { fetch: okFetch, sleep: noSleep }), /nope/);
});

test('the library names a digitised template "Custom" in a neutral badge', () => {
  const lib = fs.readFileSync(path.join(__dirname, '../scripts/pages/library.js'), 'utf8');
  assert.match(lib, /RT_LABEL = \{[^}]*custom: 'Custom'/);
  assert.match(lib, /RT_TONE  = \{[^}]*custom: 'neutral'/);
});
