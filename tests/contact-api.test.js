'use strict';

/*
 * Contact FieldSight, API layer (spec 2026-11-08 contact-fieldsight, plan
 * task 5). FS.api.contact rides FS.api.request at FS.api.orgBaseUrl -- the
 * gateway that hosts /api/org/* -- with no retry and a long timeout, because
 * a retried POST can send a second email and a transcribe can take ~20 s.
 *
 * - The body is a whitelist: a caller passing anything else (an email, a sub)
 *   must not reach the server, which trusts only the authorizer claims anyway.
 * - available() is false in mock mode or with an empty orgBaseUrl, so the
 *   window offers the mailto instead of posting nowhere.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ORG = 'https://org.example/prod/api';

function load(apiOverrides) {
  const calls = [];
  global.window = {
    FS: {
      api: Object.assign({
        useMocks: false,
        orgBaseUrl: ORG,
        request: async function (p, opts) { calls.push({ path: p, opts: opts }); return { id: 'srv', text: 'hello' }; },
      }, apiOverrides || {}),
    },
    crypto: { randomUUID: function () { return '11111111-2222-4333-8444-555555555555'; } },
  };
  delete require.cache[require.resolve('../scripts/api/contact.js')];
  require('../scripts/api/contact.js');
  return { contact: global.window.FS.api.contact, calls: calls };
}

function blobOf(text) { return new Blob([text], { type: 'audio/webm' }); }

test('send builds body from whitelisted keys only', async () => {
  const { contact, calls } = load();
  await contact.send({
    id: 'abc', text: 'Hi', transcript: 'hi', blob: blobOf('AUDIO'), mime: 'audio/webm;codecs=opus',
    context: { name: 'Sam', company: 'Co', project: 'P1', page: '/today', email: 'evil@x', extra: 1 },
    email: 'spoof@x', sub: 'spoof',
  });
  assert.strictEqual(calls.length, 1);
  const body = calls[0].opts.body;
  assert.deepStrictEqual(Object.keys(body).sort(), ['audio', 'context', 'id', 'mime', 'text', 'transcript']);
  assert.deepStrictEqual(Object.keys(body.context).sort(), ['company', 'name', 'page', 'project']);
  assert.strictEqual(body.audio, Buffer.from('AUDIO').toString('base64'));
  assert.strictEqual(body.mime, 'audio/webm;codecs=opus');
  assert.strictEqual(body.id, 'abc');
});

test('send without a recording sends audio and mime as null', async () => {
  const { contact, calls } = load();
  await contact.send({ id: 'abc', text: 'Hi', context: {} });
  const body = calls[0].opts.body;
  assert.strictEqual(body.audio, null);
  assert.strictEqual(body.mime, null);
  assert.strictEqual(body.transcript, null);
});

test('send passes retry:false and timeoutMs 28000 and orgBaseUrl', async () => {
  const { contact, calls } = load();
  await contact.send({ id: 'abc', text: 'Hi', context: {} });
  assert.strictEqual(calls[0].path, '/contact/messages');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.baseUrl, ORG);
  assert.strictEqual(calls[0].opts.retry, false);
  assert.strictEqual(calls[0].opts.timeoutMs, 28000);
});

test('transcribe passes the same options', async () => {
  const { contact, calls } = load();
  const res = await contact.transcribe(blobOf('AUDIO'), 'audio/mp4');
  assert.strictEqual(calls[0].path, '/contact/transcribe');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.baseUrl, ORG);
  assert.strictEqual(calls[0].opts.retry, false);
  assert.strictEqual(calls[0].opts.timeoutMs, 28000);
  assert.deepStrictEqual(Object.keys(calls[0].opts.body).sort(), ['audio', 'mime']);
  assert.strictEqual(calls[0].opts.body.mime, 'audio/mp4');
  assert.strictEqual(res.text, 'hello');
});

test('send passes a 404 envelope through as _notFound', async () => {
  const { contact } = load({ request: async function () { return { _notFound: true, status: 404 }; } });
  const res = await contact.send({ id: 'abc', text: 'Hi', context: {} });
  assert.strictEqual(res._notFound, true);
});

test('send rethrows a 429 with its status and body', async () => {
  const { contact } = load({ request: async function () {
    const e = new Error('rate_limited'); e.status = 429; e.body = { retry_after_s: 61 }; throw e;
  } });
  await assert.rejects(contact.send({ id: 'abc', text: 'Hi', context: {} }), function (e) {
    return e.status === 429 && e.body.retry_after_s === 61;
  });
});

test('available is false with empty orgBaseUrl', () => {
  assert.strictEqual(load({ orgBaseUrl: '' }).contact.available(), false);
});

test('available is false in mock mode and true when live', () => {
  assert.strictEqual(load({ useMocks: true }).contact.available(), false);
  assert.strictEqual(load().contact.available(), true);
});

test('newId is a uuid from crypto.randomUUID', () => {
  assert.strictEqual(load().contact.newId(), '11111111-2222-4333-8444-555555555555');
});

test('blobToBase64 round-trips binary bytes larger than one chunk', async () => {
  const { contact } = load();
  const bytes = Buffer.alloc(100000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const b64 = await contact.blobToBase64(new Blob([bytes]));
  assert.ok(Buffer.from(b64, 'base64').equals(bytes));
});

test('the page loads api/contact.js after api/index.js and _fetch.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app-shell-preview.html'), 'utf8');
  const idx = html.indexOf('scripts/api/index.js');
  const fetchAt = html.indexOf('scripts/api/_fetch.js');
  const at = html.indexOf('scripts/api/contact.js');
  assert.ok(idx > 0 && fetchAt > 0);
  assert.ok(at > idx && at > fetchAt, 'contact.js missing or loaded before api/index.js/_fetch.js');
});
