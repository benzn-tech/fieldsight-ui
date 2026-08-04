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

const { buildPreviewModel, renderEmailHtml, renderEmailText, actionLine } =
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
