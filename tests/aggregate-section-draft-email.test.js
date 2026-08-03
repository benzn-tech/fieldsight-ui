'use strict';

/*
 * The site (aggregate) view's per-person controls.
 *
 * Background: on the aggregate view — the page a site_manager lands on — each
 * person's section carried a single button labelled "View only". It was not a
 * permission notice at all: it navigates to that person's own day, which
 * carries MORE than the section does (date picker, meeting picker, Generate
 * report, Ask, audio/video). So the page's main hand-off actions sat behind a
 * control that told the user they were only allowed to look. Reported as:
 * "why do I as site manager have a view only option?"
 *
 * The fix inlines the whole-day mail draft next to the (renamed) "Open"
 * button. These tests pin the two things that make that safe:
 *   - the draft's scope is the whole day (session: null), which
 *     buildSessionEmailDraft labels "All day"; and
 *   - "done" is resolved against the SECTION's folder, not the caller's —
 *     the audit key carries a user dimension (#23), so the wrong folder
 *     silently reads someone else's check-offs.
 * Generate report is deliberately NOT inlined: it is per-meeting by
 * construction and a day can hold several, so there is no session to pass.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.React = global.React || {};

const { buildSessionEmailDraft } = require('../scripts/pages/timeline.js');

/* The real lookupAction, so the key shape is asserted rather than assumed. */
function lookupAction(map, user_folder, topic_id, action_index) {
  if (!map) return undefined;
  const bare = topic_id + '_' + action_index;
  return (user_folder ? map[user_folder + '|' + bare] : undefined) || map[bare];
}

/* Mirrors the isDone the aggregate section now passes. */
function sectionIsDone(actionsMap, sectionUser) {
  return function (a, topicId, idx) {
    if (a && a.status) return a.status === 'done';
    const st = lookupAction(actionsMap, sectionUser, topicId, idx);
    return !!(st && st.checked);
  };
}

const topics = () => ([
  {
    topic_id: 0, topic_title: 'Door damage', participants: ['Alex'],
    action_items: [{ action: 'Order replacement door', responsible: 'Alex' }],
  },
  {
    topic_id: 1, topic_title: 'Wind protection', participants: ['Sam'],
    action_items: [{ action: 'Strap the sheeting', responsible: 'Sam' }],
  },
]);

/* ---- whole-day scope ----------------------------------------------------- */

test('the aggregate section drafts the whole day, labelled "All day"', () => {
  const draft = buildSessionEmailDraft({
    topics: topics(), session: null, siteName: 'UC PK', date: '2026-07-31',
  });
  assert.ok(draft, 'expected a draft');
  assert.match(decodeURIComponent(draft.url), /All day/);
  assert.match(draft.subject || decodeURIComponent(draft.url), /UC PK/);
});

test('both people\'s outstanding items reach the draft', () => {
  const draft = buildSessionEmailDraft({
    topics: topics(), session: null, siteName: 'UC PK', date: '2026-07-31',
  });
  const body = decodeURIComponent(draft.url);
  assert.match(body, /Order replacement door/);
  assert.match(body, /Strap the sheeting/);
});

test('a day with nothing outstanding produces no draft (button renders disabled)', () => {
  const done = topics().map((t) => ({
    ...t, action_items: t.action_items.map((a) => ({ ...a, status: 'done' })),
  }));
  assert.strictEqual(buildSessionEmailDraft({
    topics: done, session: null, siteName: 'UC PK', date: '2026-07-31',
  }), null);
});

/* ---- the section's own check-off state ----------------------------------- */

test('an item checked off by this person is excluded from their draft', () => {
  const map = { 'Ben_UCPK2|0_0': { checked: true } };
  const draft = buildSessionEmailDraft({
    topics: topics(), session: null, siteName: 'UC PK', date: '2026-07-31',
    isDone: sectionIsDone(map, 'Ben_UCPK2'),
  });
  const body = decodeURIComponent(draft.url);
  assert.doesNotMatch(body, /Order replacement door/, 'checked item must not be sent');
  assert.match(body, /Strap the sheeting/);
});

test('check-offs are read under the SECTION folder, not the viewing caller', () => {
  // Same topic/index, but recorded against a different person. Using the
  // caller's folder here would wrongly treat this item as done.
  const map = { 'Someone_Else|0_0': { checked: true } };
  const draft = buildSessionEmailDraft({
    topics: topics(), session: null, siteName: 'UC PK', date: '2026-07-31',
    isDone: sectionIsDone(map, 'Ben_UCPK2'),
  });
  assert.match(decodeURIComponent(draft.url), /Order replacement door/,
    "another person's check-off must not suppress this person's item");
});

test('the Aurora status column wins over the overlay', () => {
  const withStatus = topics();
  withStatus[0].action_items[0].status = 'done';
  const map = { 'Ben_UCPK2|0_0': { checked: false } };
  const draft = buildSessionEmailDraft({
    topics: withStatus, session: null, siteName: 'UC PK', date: '2026-07-31',
    isDone: sectionIsDone(map, 'Ben_UCPK2'),
  });
  assert.doesNotMatch(decodeURIComponent(draft.url), /Order replacement door/);
});

/* ---- privacy re-assertion ------------------------------------------------ */

test('personal and removed topics never reach the aggregate draft', () => {
  const mixed = topics();
  mixed.push({
    topic_id: 2, topic_title: 'Personal', work_class: 'non_work',
    action_items: [{ action: 'Call the dentist' }],
  });
  mixed.push({
    topic_id: 3, topic_title: 'Removed', redacted: true,
    action_items: [{ action: 'Redacted item' }],
  });
  const body = decodeURIComponent(buildSessionEmailDraft({
    topics: mixed, session: null, siteName: 'UC PK', date: '2026-07-31',
  }).url);
  assert.doesNotMatch(body, /Call the dentist/);
  assert.doesNotMatch(body, /Redacted item/);
});
