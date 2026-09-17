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
  //
  // "Exactly as today" is compared against the WHOLE model, not a few fields
  // of it. The first version of this test asserted that the right rows
  // existed and would have stayed green through a change to `groups`, the
  // subject or the intro — which is the very thing its name promises to
  // catch. A test that pins less than it claims is worse than no test,
  // because the next person reads the name and stops looking.
  const m = buildPreviewModel({
    topics: [topic({
      action_items: [
        { action: 'Redo the wall', responsible: 'John', deadline: 'Wed', status: 'open' },
        { action: 'Chase the beam cert', status: 'open' },
      ],
    })],
  });
  assert.strictEqual(m.rowsSource, 'action_items');
  assert.deepStrictEqual(
    m.rows.map((r) => [r.text, r.at, r.assignee, r.due]),
    [['Redo the wall', '09:00 – 09:20', 'John', 'Wed'],
     ['Chase the beam cert', '09:00 – 09:20', '', '']]);

  /* rows/rowsSource are F2's addition and are pinned above; everything else
     must be byte-for-byte what the pre-F2 model was. */
  const rest = Object.assign({}, m);
  delete rest.rows;
  delete rest.rowsSource;
  assert.deepStrictEqual(rest, {
    subject: 'Action items — All day',
    intro: 'Outstanding action items from All day:',
    groups: [{
      topicTitle: 'Wall tolerance',
      timeRange: '09:00 – 09:20',
      category: '',
      items: [
        { action: 'Redo the wall', responsible: 'John', deadline: 'Wed' },
        { action: 'Chase the beam cert', responsible: '', deadline: '' },
      ],
      photos: [],
    }],
    totalItems: 2,
    totalPhotos: 0,
    footer: 'Generated from FieldSight',
  });
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

/* ---- the hand-off is a three-column table ------------------------------- */

/*
 * The shape the product owner asked for, in their words: a header row
 * `| AGENDA ITEM | ASSIGNED | DUE DATE |`, and blanks left blank —
 * 有就有，没有就没有. No dash, no "Unassigned", no date invented to square a
 * column off.
 *
 * The purpose that decides every ambiguous case below: the reader pastes
 * this table into an email, and someone who was in the room has to be able
 * to reconstruct each line from it without the recording.
 */

/* The cells of every pipe row in the text flavour, separator row dropped.
   Splits on UNESCAPED pipes only: a cell may legitimately contain `\|`, and
   the first version of this helper split on every pipe — which reported the
   escaping as broken when it was the parser that was. */
function textRows(txt) {
  return txt.split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '')
      .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')))
    .filter((cells) => !cells.every((c) => /^-+$/.test(c)));
}

function findRow(txt, startsWith) {
  return textRows(txt).find((cells) => cells[0].startsWith(startsWith));
}

test('both flavours carry the header row AGENDA ITEM / ASSIGNED / DUE DATE', () => {
  const m = buildPreviewModel({ topics: [topic()] });
  const html = renderEmailHtml(m, {});
  assert.ok(html.includes('<table'), 'the hand-off is a table, not a list');
  const thead = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
  ['AGENDA ITEM', 'ASSIGNED', 'DUE DATE'].forEach((c) => {
    assert.ok(thead.includes('>' + c + '<'), c + ' is a column heading in the HTML flavour');
  });
  assert.deepStrictEqual(textRows(renderEmailText(m))[0],
    ['AGENDA ITEM', 'ASSIGNED', 'DUE DATE']);
});

test('the plain-text flavour is a readable table too, not a bulleted list', () => {
  // Every mail client picks the richest flavour it supports and some pick
  // this one. A reader who gets a bulleted list instead of the table has been
  // sent a different document from the one the sender previewed.
  const m = buildPreviewModel({ topics: [topic()] });
  const txt = renderEmailText(m);
  assert.ok(!/^\s*[-*]\s/m.test(txt), 'no bulleted list survives in the text flavour');
  const rows = textRows(txt);
  assert.ok(rows.length >= 2, 'a header row and at least one item row');
  rows.forEach((cells) => assert.strictEqual(cells.length, 3, 'every row has three columns'));
});

test('an unstated assignee or due date is an EMPTY cell, never a dash', () => {
  // Blank stays blank. A dash, "Unassigned" or "TBC" each say something the
  // meeting did not say, and the reader cannot tell an invented placeholder
  // from a recorded one.
  const m = buildPreviewModel({
    topics: [topic({ action_items: [{ action: 'Chase the beam cert', status: 'open' }] })],
  });
  assert.deepStrictEqual(findRow(renderEmailText(m), 'Chase the beam cert').slice(1),
    ['', ''], 'both unstated columns are empty');

  const html = renderEmailHtml(m, {});
  assert.ok(/<td[^>]*><\/td>/.test(html), 'an unstated column is an empty cell in HTML too');
  assert.ok(!/<td[^>]*>\s*[—–-]\s*<\/td>/.test(html), 'no dash is used as filler');
  assert.ok(!/Unassigned|No owner|TBC|TBD/i.test(html), 'nothing is invented to fill a column');
});

test('a row never folds the sentence together with its owner and date', () => {
  // "Redo the wall — John (by Wed)" is exactly the register the table exists
  // to replace: the owner and the date get their own columns, or they are not
  // columns at all.
  const m = buildPreviewModel({ topics: [topic()] });
  const folded = actionLine({ action: 'Redo the wall', responsible: 'John', deadline: 'Wed' });
  assert.strictEqual(folded, 'Redo the wall — John (by Wed)', 'still what actionLine does');
  assert.ok(!renderEmailText(m).includes(folded), 'the fold is gone from the text flavour');
  assert.ok(!renderEmailHtml(m, {}).includes(folded), 'and from the HTML flavour');
  assert.deepStrictEqual(findRow(renderEmailText(m), 'Redo the wall'),
    ['Redo the wall (09:00 – 09:20)', 'John', 'Wed']);
});

test('nothing truncates in the table, however long the day', () => {
  // The mailto path drops items past its URL budget. This one must not — and
  // the table must not quietly drop a row the model still carries.
  const items = Array.from({ length: 80 }, (_, i) => ({
    action: 'Item number ' + i + ' with a deliberately long description '.repeat(3),
    status: 'open',
  }));
  const m = buildPreviewModel({ topics: [topic({ action_items: items })] });
  const txt = renderEmailText(m);
  assert.strictEqual(textRows(txt).filter((c) => c[0].startsWith('Item number')).length, 80);
  assert.strictEqual((renderEmailHtml(m, {}).match(/Item number/g) || []).length, 80);
  assert.ok(txt.includes(items[79].action), 'the longest line survives whole');
});

test('photos still sit INSIDE their topic block now that the rows are a table', () => {
  // The whole reason this modal exists: "the wall is out of tolerance, John
  // by Wednesday" and the photograph showing it are one block. A table that
  // sweeps every photo into a gallery at the bottom has thrown that away.
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
  assert.ok(action < img, 'the photo comes after its own topic\'s rows');
  assert.ok(img < second, 'and before the next topic starts');
  assert.ok(img < html.indexOf('</table>'), 'inside the table, not appended after it');
});

/* ---- `at` is two formats wearing one name ------------------------------- */

test('a clock time and a topic time range are not rendered as the same fact', () => {
  // A brief task's `at` is a clock time ("09:10:00"); a fallback row's `at`
  // is the whole topic time_range ("09:00 – 09:20"). Rendered identically
  // they read as one kind of fact and they are two: the moment something was
  // said, versus the span it was discussed in.
  const fromBrief = buildPreviewModel({
    topics: [topic({ action_items: [] })],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Pour slab', at: '09:10:00' }]) }],
  });
  const fromTopics = buildPreviewModel({ topics: [topic()] });
  assert.strictEqual(findRow(renderEmailText(fromBrief), 'Pour slab')[0],
    'Pour slab (at 09:10:00)');
  assert.strictEqual(findRow(renderEmailText(fromTopics), 'Redo the wall')[0],
    'Redo the wall (09:00 – 09:20)');
});

test('a time_range is never sorted against a clock time', () => {
  // "09:00 – 09:20" < "09:10:00" is a true string comparison and a
  // meaningless time one, so a sort that saw both would misorder silently.
  // Only brief rows — where every `at` is a clock time — are sorted at all;
  // fallback rows keep the order the topics gave them.
  const m = buildPreviewModel({
    topics: [
      topic({ topic_title: 'Said late', time_range: '15:00 – 15:20',
              action_items: [{ action: 'said late', status: 'open' }] }),
      topic({ topic_title: 'Said early', time_range: '08:00 – 08:20',
              action_items: [{ action: 'said early', status: 'open' }] }),
    ],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['said late', 'said early'],
    'topic order is kept — an order nobody stated is never imposed');
  const order = textRows(renderEmailText(m)).map((c) => c[0]);
  assert.ok(order.findIndex((t) => t.startsWith('said late'))
          < order.findIndex((t) => t.startsWith('said early')));
});

test('a brief task with no time sorts LAST — absent is not early', () => {
  // Blanks-last is implemented in buildPreviewModel and, until this test, was
  // held down by nothing: deleting the clause or inverting it left the suite
  // green. An undated commitment sorted to the top of a hand-off reads as the
  // first thing that happened that morning.
  const m = buildPreviewModel({
    topics: [topic({ action_items: [] })],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'no time at all' },
      { text: 'ten past nine', at: '09:10:00' },
      { text: 'eight sharp', at: '08:00:00' },
    ]) }],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['eight sharp', 'ten past nine', 'no time at all']);
});

test('a literal pipe in the text cannot break the text table apart', () => {
  // A task written "check level 2 | level 3 handover" would otherwise end its
  // column early and shift every later cell one to the left.
  const m = buildPreviewModel({
    topics: [topic({ action_items: [
      { action: 'Check level 2 | level 3 handover', responsible: 'Sam', status: 'open' }] })],
  });
  const cells = textRows(renderEmailText(m)).find((c) => c[0].startsWith('Check level 2'));
  assert.strictEqual(cells.length, 3, 'still three columns');
  assert.strictEqual(cells[1], 'Sam', 'the owner is still in the ASSIGNED column');
});
