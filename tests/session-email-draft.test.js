'use strict';

/*
 * Unit tests for feat/session-export-mailto — a one-click `mailto:` draft of a
 * single meeting's OUTSTANDING action items (#10, v1 / mailto-first per
 * docs/superpowers/specs/2026-07-25-meeting-scoped-action-export.md §4).
 *
 * The draft is a PURE client-side transform over topics already in hand — it
 * calls no endpoint and resolves no recipient (name -> email is the deferred
 * privacy decision, §5), so the mailto `to:` field is ALWAYS empty.
 *
 * Covers scripts/pages/timeline.js's pure helpers:
 *   collectSessionActionItems — group open items by topic, exclude done +
 *                               redacted/non_work (belt-and-suspenders)
 *   formatActionLine          — "- [PRIORITY] <text> — <who> (due <date|—>)"
 *   assembleEmailBody         — group-by-topic body + "… +N more items"
 *   buildSessionEmailDraft    — subject/body/to/url; budget truncation; null
 *                               when nothing outstanding
 *
 * Same Node-under-a-window-stub posture as tests/session-picker.test.js. No
 * window.FS.api is provided, so resolveDueDisplay takes its raw-text fallback
 * (deterministic, no today-adapter load needed).
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || { FieldSight: {} };
global.React = global.React || {};

const {
  collectSessionActionItems,
  unionSessionParticipants,
  formatActionLine,
  assembleEmailBody,
  buildSessionEmailDraft,
} = require('../scripts/pages/timeline.js');

/* ---- fixtures ------------------------------------------------------------ */

function topics() {
  return [
    {
      topic_id: 0, topic_title: 'Scaffold check', session_id: 's1',
      participants: ['Ben', 'Neil'],
      action_items: [
        { id: 'a1', action: 'Fix the guardrail', responsible: 'Neil', priority: 'high', deadline: '2026-07-26', status: 'open' },
        { id: 'a2', action: 'Order safety netting', responsible: null, priority: 'medium', deadline: '', status: 'open' },
        { id: 'a3', action: 'Sweep the deck', responsible: 'Ben', priority: 'low', deadline: '', status: 'done' }, // done -> excluded
      ],
    },
    {
      topic_id: 1, topic_title: 'Delivery review', session_id: 's1',
      participants: ['James'],
      action_items: [
        { id: 'a4', action: 'Confirm crane slot', responsible: 'James', priority: 'medium', deadline: '', status: 'open' },
      ],
    },
  ];
}

/* =========================================================================
   formatActionLine
   ========================================================================= */

test('formatActionLine renders "- [PRIORITY] <text> — <responsible> (due <date>)"', () => {
  assert.strictEqual(
    formatActionLine({ action: 'Fix the guardrail', responsible: 'Neil', priority: 'high', deadline: '2026-07-26' }, '2026-07-25'),
    '- [HIGH] Fix the guardrail — Neil (due 2026-07-26)',
  );
});

test('formatActionLine falls back to Unassigned + (due —) and defaults priority MEDIUM', () => {
  assert.strictEqual(
    formatActionLine({ action: 'Order safety netting' }, '2026-07-25'),
    '- [MEDIUM] Order safety netting — Unassigned (due —)',
  );
});

test('formatActionLine reads a.text when a.action is absent', () => {
  assert.strictEqual(
    formatActionLine({ text: 'Legacy text field', responsible: 'Sam', priority: 'low' }, '2026-07-25'),
    '- [LOW] Legacy text field — Sam (due —)',
  );
});

/* =========================================================================
   collectSessionActionItems — grouping + done/personal exclusion
   ========================================================================= */

test('collectSessionActionItems groups OPEN items by topic, in topic order, dropping done items', () => {
  const groups = collectSessionActionItems(topics());
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].topicTitle, 'Scaffold check');
  assert.deepStrictEqual(groups[0].items.map(function (a) { return a.id; }), ['a1', 'a2']); // a3 done -> gone
  assert.strictEqual(groups[1].topicTitle, 'Delivery review');
  assert.deepStrictEqual(groups[1].items.map(function (a) { return a.id; }), ['a4']);
});

test('collectSessionActionItems drops a topic entirely once all its items are done', () => {
  const t = [{ topic_id: 9, topic_title: 'All finished', action_items: [
    { id: 'x1', action: 'done one', status: 'done' },
    { id: 'x2', action: 'done two', status: 'done' },
  ] }];
  assert.deepStrictEqual(collectSessionActionItems(t), []);
});

test('collectSessionActionItems honours an injected isDone predicate (legacy check-off path)', () => {
  // isDone(action, topic_id, index) — the render site's real predicate shape:
  // column status wins, else a legacy check-off (here: index 0) counts as done.
  const groups = collectSessionActionItems(topics(), function (a, topicId, idx) {
    return a.status === 'done' || idx === 0;
  });
  assert.deepStrictEqual(groups[0].items.map(function (a) { return a.id; }), ['a2']); // a1 (idx 0) + a3 (done) gone
});

test('collectSessionActionItems NEVER emits a redacted or non_work topic — belt-and-suspenders', () => {
  const t = topics().concat([
    { topic_id: 2, topic_title: 'Personal chat', work_class: 'non_work',
      action_items: [{ id: 'p1', action: 'call the dentist', status: 'open' }] },
    { topic_id: 3, topic_title: 'Removed topic', redacted: true,
      action_items: [{ id: 'r1', action: 'something private', status: 'open' }] },
  ]);
  const groups = collectSessionActionItems(t);
  const allIds = groups.reduce(function (acc, g) { return acc.concat(g.items.map(function (a) { return a.id; })); }, []);
  assert.strictEqual(allIds.indexOf('p1'), -1, 'non_work item must never be collected');
  assert.strictEqual(allIds.indexOf('r1'), -1, 'redacted item must never be collected');
  assert.deepStrictEqual(groups.map(function (g) { return g.topicTitle; }), ['Scaffold check', 'Delivery review']);
});

/* =========================================================================
   unionSessionParticipants
   ========================================================================= */

test('unionSessionParticipants dedupes names across topics, order preserved, personal topics ignored', () => {
  const t = topics().concat([
    { topic_id: 5, topic_title: 'Personal', work_class: 'non_work', participants: ['Secret Person'], action_items: [] },
  ]);
  assert.deepStrictEqual(unionSessionParticipants(t), ['Ben', 'Neil', 'James']);
});

/* =========================================================================
   assembleEmailBody — grouping + overflow line
   ========================================================================= */

test('assembleEmailBody groups lines under their topic title and appends "… +N more items" on overflow', () => {
  const entries = [
    { topicTitle: 'Scaffold check', line: '- [HIGH] Fix the guardrail — Neil (due 2026-07-26)' },
    { topicTitle: 'Scaffold check', line: '- [MEDIUM] Order safety netting — Unassigned (due —)' },
    { topicTitle: 'Delivery review', line: '- [MEDIUM] Confirm crane slot — James (due —)' },
  ];
  const body = assembleEmailBody(entries.slice(0, 2), 1, {
    intro: 'Outstanding action items:', participants: ['Ben', 'Neil'], footer: 'Generated from FieldSight',
  });
  assert.ok(body.indexOf('Scaffold check\n- [HIGH] Fix the guardrail') !== -1, 'topic header precedes its items');
  assert.ok(body.indexOf('… +1 more item') !== -1, 'overflow line present (singular)');
  assert.ok(body.indexOf('Discussed with: Ben, Neil') !== -1, 'participant NAMES appear in the body');
  assert.ok(body.indexOf('Generated from FieldSight') !== -1, 'footer present');
});

/* =========================================================================
   buildSessionEmailDraft — the whole thing
   ========================================================================= */

test('buildSessionEmailDraft builds subject + grouped body for a session, to is empty', () => {
  const draft = buildSessionEmailDraft({
    topics: topics(), date: '2026-07-25', siteName: 'UC PK',
    session: { label: '13:05 – 14:22', participants: ['Ben', 'Neil', 'James'] },
    deepLink: 'https://app.example/#/timeline?date=2026-07-25',
  });
  assert.strictEqual(draft.subject, 'Action items — UC PK — 13:05 – 14:22 (2026-07-25)');
  assert.strictEqual(draft.totalItems, 3);   // a1 + a2 + a4 (a3 done)
  assert.strictEqual(draft.includedItems, 3);
  assert.strictEqual(draft.truncated, false);
  // grouped by topic, correct lines
  assert.ok(draft.body.indexOf('Scaffold check\n- [HIGH] Fix the guardrail — Neil (due 2026-07-26)') !== -1);
  assert.ok(draft.body.indexOf('- [MEDIUM] Order safety netting — Unassigned (due —)') !== -1);
  assert.ok(draft.body.indexOf('Delivery review\n- [MEDIUM] Confirm crane slot — James (due —)') !== -1);
  // participant names in the body, never in the recipient field
  assert.ok(draft.body.indexOf('Discussed with: Ben, Neil, James') !== -1);
});

test('buildSessionEmailDraft: the mailto to: field is ALWAYS empty and no email lookup occurs', () => {
  const draft = buildSessionEmailDraft({
    topics: topics(), date: '2026-07-25', siteName: 'UC PK',
    session: { label: '13:05 – 14:22', participants: ['Ben', 'Neil'] },
  });
  assert.strictEqual(draft.to, '');
  // No recipient before the '?': the char right after "mailto:" is "?".
  assert.strictEqual(draft.url.indexOf('mailto:?subject='), 0, 'no address between mailto: and ?');
  // Participant names live only in the encoded body param, never as a recipient.
  const beforeQuery = draft.url.slice('mailto:'.length, draft.url.indexOf('?'));
  assert.strictEqual(beforeQuery, '', 'the to: portion of the URL is empty');
  assert.ok(draft.url.indexOf('&body=') !== -1);
});

test('buildSessionEmailDraft uses "All day" as the label when no session is selected', () => {
  const draft = buildSessionEmailDraft({ topics: topics(), date: '2026-07-25', siteName: 'UC PK', session: null });
  assert.strictEqual(draft.subject, 'Action items — UC PK — All day (2026-07-25)');
  // participants fall back to the union over the topics
  assert.ok(draft.body.indexOf('Discussed with: Ben, Neil, James') !== -1);
});

test('buildSessionEmailDraft returns null when there is nothing outstanding to send', () => {
  assert.strictEqual(buildSessionEmailDraft({ topics: [], date: '2026-07-25', siteName: 'UC PK' }), null);
  const allDone = [{ topic_id: 0, topic_title: 'T', action_items: [{ id: 'z', action: 'x', status: 'done' }] }];
  assert.strictEqual(buildSessionEmailDraft({ topics: allDone, date: '2026-07-25', siteName: 'UC PK' }), null);
  // a redacted/non_work-only day also yields no draft (never an empty email)
  const personalOnly = [{ topic_id: 1, topic_title: 'P', work_class: 'non_work', action_items: [{ id: 'q', action: 'y', status: 'open' }] }];
  assert.strictEqual(buildSessionEmailDraft({ topics: personalOnly, date: '2026-07-25', siteName: 'UC PK' }), null);
});

test('buildSessionEmailDraft truncates to the budget, appends "+N more", and drops NOTHING silently', () => {
  // Twelve open items across two topics; a tight budget forces truncation.
  const many = [
    { topic_id: 0, topic_title: 'Morning walk', action_items: [] },
    { topic_id: 1, topic_title: 'Afternoon walk', action_items: [] },
  ];
  for (let i = 0; i < 6; i++) {
    many[0].action_items.push({ id: 'm' + i, action: 'Morning action item number ' + i + ' with some detail', responsible: 'Person ' + i, priority: 'medium', status: 'open' });
    many[1].action_items.push({ id: 'n' + i, action: 'Afternoon action item number ' + i + ' with some detail', responsible: 'Other ' + i, priority: 'high', status: 'open' });
  }
  const draft = buildSessionEmailDraft({
    topics: many, date: '2026-07-25', siteName: 'UC PK',
    session: { label: '09:00 – 17:00', participants: ['Ben'] },
    deepLink: 'https://app.example/#/timeline?date=2026-07-25',
    budget: 500,
  });
  assert.strictEqual(draft.totalItems, 12);
  assert.strictEqual(draft.truncated, true);
  assert.ok(draft.includedItems < 12 && draft.includedItems >= 0, 'some items trimmed');
  assert.ok(draft.omittedItems > 0, 'the trimmed count is positive');
  // accounting is exact — every item is either included or counted in "+N more"
  assert.strictEqual(draft.includedItems + draft.omittedItems, draft.totalItems);
  assert.ok(draft.body.indexOf('… +' + draft.omittedItems + ' more item') !== -1, 'visible overflow line naming the exact count');
  if (draft.includedItems > 0) assert.ok(draft.url.length <= 500, 'the chosen URL fits the budget');
});

test('buildSessionEmailDraft: a comfortably small meeting is never truncated', () => {
  const draft = buildSessionEmailDraft({
    topics: topics(), date: '2026-07-25', siteName: 'UC PK',
    session: { label: '13:05 – 14:22', participants: ['Ben', 'Neil', 'James'] },
  });
  assert.strictEqual(draft.truncated, false);
  assert.strictEqual(draft.body.indexOf('more item'), -1, 'no overflow line when everything fits');
});
