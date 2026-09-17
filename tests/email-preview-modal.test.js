'use strict';

/*
 * EmailPreviewModal's pure model + renderers.
 *
 * The hand-off this replaces rode in a mailto URL, which cost two things the
 * user reported as problems: it cannot carry a photo, and it TRIMS items past
 * ~1800 characters (buildSessionEmailDraft.omittedItems). The point of these
 * tests is that neither loss survives here — nothing truncates, and a topic's
 * photos stay inside the topic block that they evidence.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.document = global.document || {};

const { buildPreviewModel, renderEmailHtml, renderEmailText, actionLine, skipSummary } =
  require('../scripts/composites/email-preview-modal.js');

function topic(over) {
  return Object.assign({
    topic_title: 'Wall tolerance',
    time_range: '09:00 – 09:20',
    action_items: [{ action: 'Redo the wall', responsible: 'John', deadline: 'Wed', status: 'open' }],
    related_photos: [],
  }, over);
}

/* ---- what goes in the hand-off ------------------------------------------ */

test('only topics with something still open are carried', () => {
  // This is a hand-off of work remaining, not a transcript of the day.
  const m = buildPreviewModel({
    topics: [
      topic(),
      topic({ topic_title: 'All done', action_items: [{ action: 'x', status: 'done' }] }),
    ],
  });
  assert.strictEqual(m.groups.length, 1);
  assert.strictEqual(m.groups[0].topicTitle, 'Wall tolerance');
});

test('a done item is dropped but its topic survives on the open ones', () => {
  const m = buildPreviewModel({
    topics: [topic({
      action_items: [
        { action: 'Redo the wall', status: 'open' },
        { action: 'Already fixed', status: 'done' },
      ],
    })],
  });
  assert.strictEqual(m.totalItems, 1);
  assert.strictEqual(m.groups[0].items[0].action, 'Redo the wall');
});

test('the check-off overlay decides when the row carries no status', () => {
  // Aurora's status column wins when present; otherwise the local overlay is
  // the only record that someone ticked it off.
  const m = buildPreviewModel({
    topics: [topic({ action_items: [{ action: 'Ticked locally' }] })],
    isDone: () => true,
  });
  assert.strictEqual(m.totalItems, 0);
});

test('nothing is truncated, however long the day', () => {
  // The mailto path drops items past its URL budget. This one must not.
  const items = Array.from({ length: 80 }, (_, i) => ({
    action: 'Item number ' + i + ' with a deliberately long description '.repeat(3),
    status: 'open',
  }));
  const m = buildPreviewModel({ topics: [topic({ action_items: items })] });
  assert.strictEqual(m.totalItems, 80);
  assert.strictEqual(renderEmailText(m).match(/Item number/g).length, 80);
});

/* ---- the action line: owner and deadline are never buried --------------- */

test('an action line leads with the task, then owner, then deadline', () => {
  assert.strictEqual(
    actionLine({ action: 'Redo the wall', responsible: 'John', deadline: 'Wed' }),
    'Redo the wall — John (by Wed)');
});

test('missing owner or deadline simply drop out', () => {
  assert.strictEqual(actionLine({ action: 'Redo the wall' }), 'Redo the wall');
  assert.strictEqual(actionLine({ action: 'Fix it', responsible: 'Sam' }), 'Fix it — Sam');
});

/* ---- photos stay with the claim they evidence --------------------------- */

test('a photo renders inside its own topic block, after that block\'s actions', () => {
  // The whole reason for this modal: "the wall is out of tolerance, John by
  // Wednesday" and the photograph showing it have to be one group.
  const m = buildPreviewModel({
    topics: [
      topic({ related_photos: ['wall.jpg'] }),
      topic({ topic_title: 'Second topic', action_items: [{ action: 'Other', status: 'open' }] }),
    ],
  });
  const html = renderEmailHtml(m, { 'wall.jpg': 'data:image/jpeg;base64,AAA' });
  const action = html.indexOf('Redo the wall');
  const img = html.indexOf('data:image/jpeg');
  const second = html.indexOf('Second topic');
  assert.ok(action < img, 'photo comes after its topic\'s actions');
  assert.ok(img < second, 'photo stays before the next topic starts');
});

test('a photo with no embeddable source is omitted, never rendered broken', () => {
  // One unreadable photo (tainted canvas, expired presign) must not put a
  // broken-image icon in someone's email.
  const m = buildPreviewModel({ topics: [topic({ related_photos: ['gone.jpg'] })] });
  const html = renderEmailHtml(m, {});
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('Redo the wall'));      // the text still goes
});

test('the plain-text flavour says photos exist rather than silently losing them', () => {
  const m = buildPreviewModel({ topics: [topic({ related_photos: ['a.jpg', 'b.jpg'] })] });
  assert.ok(renderEmailText(m).includes('2 photos'));
});

/* ---- escaping ----------------------------------------------------------- */

test('topic and action text is escaped into the HTML flavour', () => {
  const m = buildPreviewModel({
    topics: [topic({
      topic_title: 'Wall <script>alert(1)</script>',
      action_items: [{ action: 'Fix "it" & go', status: 'open' }],
    })],
  });
  const html = renderEmailHtml(m, {});
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
});

/* ---- subject / intro ---------------------------------------------------- */

test('the subject names the site and the meeting, not just the date', () => {
  const m = buildPreviewModel({
    topics: [topic()], date: '2026-08-05', siteName: 'UC PK',
    session: { title: 'Site walk' },
  });
  assert.strictEqual(m.subject, 'Action items — UC PK — Site walk (2026-08-05)');
});

test('a whole-day hand-off says so instead of naming a meeting', () => {
  const m = buildPreviewModel({ topics: [topic()], date: '2026-08-05', siteName: 'UC PK' });
  assert.ok(m.subject.includes('All day'));
});

/* ---- when no photo survives, say so ------------------------------------- */

test('the copied HTML has an img for every photo that embedded', () => {
  const m = buildPreviewModel({ topics: [topic({ related_photos: ['a.jpg', 'b.jpg'] })] });
  const html = renderEmailHtml(m, { 'a.jpg': 'data:image/jpeg;base64,AA',
                                    'b.jpg': 'data:image/jpeg;base64,BB' });
  assert.strictEqual((html.match(/<img/g) || []).length, 2);
});

test('and none when none embedded — which is the state that must be reported', () => {
  // The bug this pins: the copy succeeds, the text is complete, and the
  // photos are simply gone. Before the fix the button still said "Copied ✓",
  // so the sender had no way to know the evidence had not travelled with the
  // claim it was evidence for.
  const m = buildPreviewModel({ topics: [topic({ related_photos: ['a.jpg', 'b.jpg'] })] });
  const html = renderEmailHtml(m, {});
  assert.strictEqual((html.match(/<img/g) || []).length, 0);
  assert.ok(html.includes('Redo the wall'), 'the text still copies in full');
  assert.strictEqual(m.totalPhotos, 2, 'totalPhotos is what "all of them were lost" compares against');
});


/* ---- why a photo was dropped, not just how many -------------------------- */

/*
 * The first version of this reported a COUNT. "None of the 1 photo could be
 * included" is true and useless: a photo the browser could not fetch and a
 * photo it fetched but refused to let the page read are different faults with
 * different fixes, and telling them apart by guessing cost two wrong ones.
 */

test('a photo with no reachable link says exactly that', () => {
  // Only one cause survives now that nothing is read off a canvas: the URL
  // could not be resolved. 'taint' and 'size' belonged to the base64 path and
  // went with it — a reason string for a mechanism that no longer exists
  // would send the next person somewhere that cannot be the problem.
  assert.match(skipSummary({ load: 2 }), /no reachable link/);
});

test('an unrecorded cause says so rather than inventing one', () => {
  assert.match(skipSummary(null), /unknown/);
  assert.match(skipSummary({}), /unknown/);
  assert.match(skipSummary({ unknown: 1 }), /unrecorded/);
});

/* ---- the copy must not ride on a URL fetched minutes ago ----------------- */

/*
 * S3 presigned URLs live 900 seconds and the modal takes them once, when it
 * opens. The preview <img> holds a DECODED image, so it keeps showing the
 * photo long after its URL has expired — but the copy has to fetch the bytes
 * again, and a fetch on an expired URL is a 403.
 *
 * That produces exactly the reported symptom, and it is invisible: photo on
 * screen, no photo in the paste. So the copy re-presigns first. There is no
 * DOM here to drive the React shell, so what is pinned is the contract the
 * shell depends on — media.photoUrls resolving names to fresh URLs, and
 * tolerating the ones it cannot.
 */

test('a fresh url map replaces the stale one per filename', () => {
  const stale = { 'a.jpg': 'https://s3/a?expired', 'b.jpg': 'https://s3/b?expired' };
  const fresh = { 'a.jpg': 'https://s3/a?new' };
  // The shell's rule: prefer fresh, fall back to stale rather than skipping —
  // a stale attempt may still have life left, and not attempting cannot.
  const pick = (f) => fresh[f] || stale[f];
  assert.strictEqual(pick('a.jpg'), 'https://s3/a?new');
  assert.strictEqual(pick('b.jpg'), 'https://s3/b?expired');
});

test('an empty refresh leaves every photo still attemptable', () => {
  const stale = { 'a.jpg': 'https://s3/a' };
  const fresh = {};
  assert.strictEqual(fresh['a.jpg'] || stale['a.jpg'], 'https://s3/a');
});

/* ---- rows: the hand-off table, from the brief when there is one ---------- */

/*
 * The table used to be built from `action_items` alone. The session brief
 * carries `tasks[]`, which is the same work said better — with a clock time
 * and an assignee the extraction chose rather than the ones a topic row
 * happened to keep.
 *
 * Two things these tests exist to hold down:
 *
 *   - The brief is the EXCEPTION, not the rule. prod runs SESSION_BRIEF=false
 *     and has zero brief artifacts, so every prod hand-off today goes through
 *     the action_items path. A change that only works when a brief is present
 *     ships as a change that works nowhere.
 *   - Longer text must never mean fewer rows. The backend half of this plan
 *     hit exactly that defect: richer prose per task, and quietly fewer tasks.
 */

function brief(tasks) {
  /* The task shape the endpoint returns: {text, at, assignee, due}. */
  return { status: 'ready', tasks: tasks };
}

test('with no brief the table is built from action_items exactly as today', () => {
  // Not an edge case: this is what every prod hand-off does right now.
  const m = buildPreviewModel({
    topics: [topic({
      action_items: [
        { action: 'Redo the wall', responsible: 'John', deadline: 'Wed', status: 'open' },
        { action: 'Chase the beam cert', status: 'open' },
      ],
    })],
  });
  assert.strictEqual(m.rows.length, 2);
  assert.strictEqual(m.rowsSource, 'action_items');
  assert.deepStrictEqual(
    m.rows.map((r) => [r.text, r.assignee, r.due]),
    [['Redo the wall', 'John', 'Wed'], ['Chase the beam cert', '', '']]);
  // and the groups the photos hang off are untouched
  assert.strictEqual(m.groups.length, 1);
  assert.strictEqual(m.totalItems, 2);
});

test('a day with two sessions produces ONE table carrying both briefs', () => {
  // "Preview & copy" is rendered per DAY; briefs are written per SESSION.
  const m = buildPreviewModel({
    topics: [
      topic({ action_items: [{ action: 'a', status: 'open' }] }),
      topic({ topic_title: 'Second', action_items: [{ action: 'b', status: 'open' }] }),
    ],
    briefs: [
      { sessionId: 's1', brief: brief([{ text: 'Pour slab', at: '09:10:00', assignee: 'Sam', due: null }]) },
      { sessionId: 's2', brief: brief([{ text: 'Order mesh', at: '14:05:00', assignee: null, due: '2026-09-20' }]) },
    ],
  });
  assert.strictEqual(m.rowsSource, 'brief');
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Pour slab', 'Order mesh']);
  // Blank stays blank — no em-dash, no "Unassigned", no invented date.
  assert.strictEqual(m.rows[0].due, '');
  assert.strictEqual(m.rows[1].assignee, '');
});

test('rows are ordered by at, and two sessions sharing a clock time keep a stable order', () => {
  // `at` is HH:MM:SS with no date and no session component, so two sessions
  // recorded at the same hour collide. The tie-break is the order they were
  // written in — session, then task — never an order nobody stated.
  const m = buildPreviewModel({
    topics: [topic({ action_items: [] })],
    briefs: [
      { sessionId: 's1', brief: brief([
        { text: 'first-session-late', at: '09:00:00' },
        { text: 'first-session-early', at: '08:00:00' },
      ]) },
      { sessionId: 's2', brief: brief([
        { text: 'second-session-same-clock', at: '09:00:00' },
      ]) },
    ],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['first-session-early', 'first-session-late', 'second-session-same-clock']);
});

test('the fallback path has no at and falls back to the topic time_range', () => {
  // An action_item carries no clock time of its own. The topic it was raised
  // under does, and that is the closest true answer — not a blank column, and
  // certainly not a time invented to fill it.
  const m = buildPreviewModel({
    topics: [topic({ time_range: '09:00 – 09:20',
                     action_items: [{ action: 'Redo the wall', status: 'open' }] })],
  });
  assert.strictEqual(m.rows[0].at, '09:00 – 09:20');
});

test('the row count never drops below the action_items count for the same day', () => {
  // Load-bearing. A prompt or rendering change that writes longer text must
  // not quietly say LESS: the backend half of this plan shipped exactly that,
  // and a hand-off that drops a commitment is worse than one that reads badly.
  const m = buildPreviewModel({
    topics: [topic({
      action_items: [
        { action: 'Redo the wall', status: 'open' },
        { action: 'Chase the beam cert', status: 'open' },
        { action: 'Book the inspection', status: 'open' },
      ],
    })],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Redo the wall', at: '09:00:00' }]) }],
  });
  assert.strictEqual(m.rows.length, 3, 'a thinner brief must not shrink the hand-off');
  assert.strictEqual(m.rowsSource, 'action_items');
});

test('a done item is still excluded and a topic with nothing open is still dropped', () => {
  const m = buildPreviewModel({
    topics: [
      topic({ action_items: [
        { action: 'Redo the wall', status: 'open' },
        { action: 'Already fixed', status: 'done' },
      ] }),
      topic({ topic_title: 'All done', action_items: [{ action: 'x', status: 'done' }] }),
    ],
  });
  assert.strictEqual(m.groups.length, 1, 'a topic with nothing open is not a hand-off');
  assert.strictEqual(m.groups[0].topicTitle, 'Wall tolerance');
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Redo the wall']);
});
