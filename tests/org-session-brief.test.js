'use strict';

/*
 * GET /api/org/sessions/{id}/brief has existed on the backend since the brief
 * shipped, and no client had ever called it. lambda_session_finalize writes
 * one per session — sections with timestamps and verbatim quotes, entities
 * with the spellings the transcriber actually produced, tasks with the reason
 * each exists — and every one of them went to S3 and stopped there.
 *
 * The endpoint answers with `status` in ready | pending | removed, and none of
 * the three is an error: a brief not yet written, one that will never be
 * written, and one whose recordings were deleted are all just "no brief".
 *
 * Two of the tests below exist because of defects this repo has already paid
 * for, and both are invisible at load time:
 *
 *   - `FS.api` is assigned WHOLESALE by scripts/api/index.js:87, so a function
 *     that is defined but left out of org.js's export block simply is not
 *     there. Nothing throws until the first consumer reads undefined.
 *   - An empty read stub is not a neutral default. It is a claim that the
 *     feature is finished and the data is absent. getSessions and
 *     getSessionReportPreview both shipped that way and took four surfaces
 *     down with them.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const SOURCE = read('scripts', 'api', 'org.js');

/* ---------- loading org.js the way the browser does -------------------- */

let requests;

/* live=false gives the mock path with the REAL day fixture behind it, which
   is the only way test 4 can be about the fixture rather than about a stub
   invented in this file. */
function load(opts) {
  opts = opts || {};
  requests = [];
  global.window = {
    FieldSight: {},
    FS: {
      api: {
        useMocks: !opts.live,
        timelineSource: opts.live ? 'aurora' : 'mock',
        orgBaseUrl: opts.live ? 'https://org.example/api' : '',
        delay: () => Promise.resolve(),
        orgRequest: (p, o) => {
          requests.push({ path: p, params: o && o.params });
          return Promise.resolve(opts.response || { status: 'ready', headline: 'live' });
        },
      },
    },
  };
  for (const m of ['../scripts/mock/daily-report.fixture.js',
                   '../scripts/api/_cache.js',
                   '../scripts/api/org.js']) {
    delete require.cache[require.resolve(m)];
    require(m);
  }
  return window.FS.api.org;
}

/* The fixture's own first session for a day that has one, read out of
   getSessions rather than hardcoded, so the two cannot drift apart. */
const DAY = { date: '2026-04-29', user: 'Jarley_Trainor' };
async function firstFixtureSession(org) {
  const res = await org.getSessions(DAY);
  assert.ok(res.sessions && res.sessions.length,
    'the day fixture stopped producing sessions — every assertion below would '
    + 'be vacuous, so this is the self-check that keeps them honest');
  return res.sessions[0];
}

/* ---------- 1. it is actually reachable -------------------------------- */

/* scripts/api/index.js:87 is `window.FS.api = {` — a wholesale assign. A
   function defined in org.js but missing from its export block is not an
   error, it is an absence, and this is the only thing that notices. */
test('getSessionBrief is registered on FS.api.org', () => {
  const org = load();
  assert.strictEqual(typeof org.getSessionBrief, 'function',
    'org.getSessionBrief must be callable off the registered namespace');

  const block = SOURCE.match(/window\.FS\.api\.org = \{[\s\S]*?\n  \};/);
  assert.ok(block, 'org.js export block has moved or been renamed');
  assert.match(block[0], /getSessionBrief:\s*getSessionBrief,/,
    'defined-but-unexported is the exact defect the wholesale assign in '
    + 'api/index.js produces, and it throws nothing at load');
});

/* ---------- 2. the same gate as its neighbour -------------------------- */

function gateOf(name) {
  const fn = SOURCE.match(new RegExp('function ' + name + '\\(opts\\) \\{[\\s\\S]*?\\n  \\}'));
  assert.ok(fn, name + ' has moved or been renamed');
  const cond = fn[0].match(/if \(([\s\S]*?)\) \{/);
  assert.ok(cond, name + ' no longer opens with a live gate');
  return cond[1].replace(/\s+/g, ' ').trim();
}

/* Sessions are parsed from recording keys the legacy report gateway never
   exposed, so there is no legacy fallback — only the kill switch. A brief is
   read off the same sessions, so it must not answer to a different switch:
   one gate open and the other shut is a client calling a URL its own
   configuration says is unreachable. */
test('getSessionBrief is gated on the same predicate as getSessions', () => {
  assert.strictEqual(gateOf('getSessionBrief'), gateOf('getSessions'),
    'the brief read must be gated on the identical live predicate');
});

test('the live gate sends date and user, and passes a denial straight through', async () => {
  const org = load({ live: true, response: { _accessDenied: true } });
  const res = await org.getSessionBrief({ sessionId: 'sid123', date: '2026-04-29', user: 'Jarley_Trainor' });
  assert.deepStrictEqual(requests, [{
    path: '/sessions/sid123/brief',
    params: { date: '2026-04-29', user: 'Jarley_Trainor' },
  }]);
  /* Unswallowed, same posture as getSessions/getSiteMembers: the caller
     decides how to degrade, and "denied" here means no brief, not an error. */
  assert.strictEqual(res._accessDenied, true);
});

/* ---------- 3. load order -------------------------------------------- */

test('org.js still loads after api/index.js', () => {
  const html = read('app-shell-preview.html').split('\n');
  const lineOf = (needle) => {
    const i = html.findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, needle + ' is no longer loaded by app-shell-preview.html');
    return i + 1;
  };
  const index = lineOf('scripts/api/index.js?');
  const org = lineOf('scripts/api/org.js?');
  assert.ok(org > index,
    'org.js registers onto FS.api, which api/index.js assigns WHOLESALE — '
    + 'loading it first wipes getSessionBrief with no error at load '
    + `(index.js line ${index}, org.js line ${org})`);
});

/* ---------- 4. the mock serves a brief, not an empty one --------------- */

test('the mock serves a brief for a fixture session rather than an empty one', async () => {
  const org = load();
  const session = await firstFixtureSession(org);
  const brief = await org.getSessionBrief({
    sessionId: session.session_id, date: DAY.date, user: DAY.user,
  });

  assert.strictEqual(brief.status, 'ready');
  assert.ok(brief.sections.length, 'a brief with no sections is an empty read stub');
  assert.ok(brief.sections[0].bullets.length && brief.sections[0].bullets[0].text,
    'a section whose bullets carry no text says nothing');
  assert.ok(brief.tasks.length,
    'the fixture day carries action items — a brief with no tasks is the '
    + 'empty-stub claim that the feature is finished and the data absent');
  assert.ok(brief.tasks[0].why, 'the reason a task exists is the field the to-do list was missing');
  assert.ok(brief.headline, 'and it says what the meeting was about');
});

test('a session the fixture does not have reads as pending, not as an error', async () => {
  const org = load();
  const brief = await org.getSessionBrief({
    sessionId: 'sid-nothing-here', date: DAY.date, user: DAY.user,
  });
  assert.strictEqual(brief.status, 'pending',
    'not written yet and never will be are the same thing to a caller, and '
    + 'neither is a failure');
});

test('the mock invents no field the live endpoint does not return', async () => {
  const org = load();
  const session = await firstFixtureSession(org);
  const brief = await org.getSessionBrief({
    sessionId: session.session_id, date: DAY.date, user: DAY.user,
  });
  /* _BRIEF_DEFAULTS in lambda_org_api.py, plus `status`. A caller that grew
     to read brief.date off the mock would break the moment it went live. */
  const allowed = ['headline', 'sections', 'entities', 'tasks', 'stats',
                   'summary', 'open_todos', 'open_points', 'status'];
  const extra = Object.keys(brief).filter((k) => allowed.indexOf(k) < 0);
  assert.deepStrictEqual(extra, [], 'mock-only fields: ' + extra.join(', '));
});

test('the mock does not fabricate a verbatim quote it has no transcript for', async () => {
  const org = load();
  const session = await firstFixtureSession(org);
  const brief = await org.getSessionBrief({
    sessionId: session.session_id, date: DAY.date, user: DAY.user,
  });
  const quotes = brief.sections.reduce((acc, s) => acc.concat(s.bullets.map((b) => b.quote)), []);
  assert.ok(quotes.length, 'no bullets to check');
  assert.ok(quotes.every((q) => q === null),
    'on the real thing a quote is copied verbatim out of the transcript. The '
    + 'fixture has no transcript, and a plausible-looking quote attributed to '
    + 'nobody is the one thing a brief must never carry');
});
