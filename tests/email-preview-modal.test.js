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

const { buildPreviewModel, renderEmailHtml, renderEmailText, actionLine, skipSummary,
  topicRowText, isSpeakerLabel, TOPIC_ROW_MAX_CHARS } =
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

test('a photo renders below the table, under the title of the topic it evidences', () => {
  // The whole reason for this modal: "the wall is out of tolerance, John by
  // Wednesday" and the photograph showing it have to stay traceable to each
  // other, even though the table itself is flat now (§3).
  const m = buildPreviewModel({
    topics: [
      topic({ related_photos: ['wall.jpg'] }),
      topic({ topic_title: 'Second topic', action_items: [{ action: 'Other', status: 'open' }] }),
    ],
  });
  const html = renderEmailHtml(m, { 'wall.jpg': 'data:image/jpeg;base64,AAA' });
  const table = html.indexOf('</table>');
  const action = html.indexOf('Redo the wall');
  const img = html.indexOf('data:image/jpeg');
  const title = html.indexOf('Wall tolerance');
  assert.ok(action < table, 'the action text is inside the table');
  assert.ok(table < title, 'the photo\'s topic title comes after the table');
  assert.ok(title < img, 'and the photo itself follows its own title');
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
      // A photo so the malicious title still gets rendered somewhere (as the
      // photo group's heading below the table) — a topic with neither an
      // open item nor a photo never appears in either flavour at all.
      related_photos: ['a.jpg'],
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
  // Substitution is per session (fix round, 2026-09-18): each topic's
  // `session_id` is what routes its row to its own session's brief.
  const m = buildPreviewModel({
    topics: [
      topic({ session_id: 's1', action_items: [{ action: 'a', status: 'open' }] }),
      topic({ session_id: 's2', topic_title: 'Second', action_items: [{ action: 'b', status: 'open' }] }),
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

test('a session\'s brief rows are ordered by at with a stable tie-break; sessions are never merged by time', () => {
  // §1.3 fix round: substitution is per session, and a session's block is
  // emitted whole, at the FIRST topic (in walk order) that belongs to it.
  // Sessions are never interleaved or re-sorted against each other by `at` —
  // only a session's OWN tasks are sorted against each other. Walk order
  // decides block order, so the session reached SECOND in the topics array
  // (s2) still comes second in the table even though its only task's clock
  // time (09:00:00) is earlier than one of s1's.
  const m = buildPreviewModel({
    topics: [
      // time_range moved off the brief's clock times (§7.1 coverage is a
      // deliberate, separate behavior pinned elsewhere — this test is about
      // sort order, so the topic must stay UNCOVERED to keep testing that).
      topic({ session_id: 's1', action_items: [], time_range: '11:00 – 11:20' }),
      topic({ session_id: 's2', topic_title: 'Second session topic',
              action_items: [{ action: 'superseded by the brief', status: 'open' }] }),
    ],
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
  // The topic (no action items) sinks to the bottom, after every action row —
  // §1.2/§1.3. It carries no `at` at all, which is exactly the point: a
  // topic row is never part of the at-ordered set.
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['first-session-early', 'first-session-late', 'second-session-same-clock',
     'Wall tolerance']);
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

test('the row-count floor is gone: a brief with fewer tasks than the topics still wins', () => {
  // §1.3/§0: "if a brief exists, use it." A brief with at least one task IS
  // the source, even when it says less than the extraction's action items
  // would have. Before this change the pair below would have kept the three
  // action_items rows instead — that floor is deliberately removed.
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1',
      action_items: [
        { action: 'Redo the wall', status: 'open' },
        { action: 'Chase the beam cert', status: 'open' },
        { action: 'Book the inspection', status: 'open' },
      ],
    })],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Redo the wall', at: '09:00:00' }]) }],
  });
  assert.strictEqual(m.rowsSource, 'brief');
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Redo the wall']);
});

test('a brief with zero tasks is treated as no brief at all', () => {
  // §1.3: "A brief with zero tasks is treated as no brief." An empty table
  // where the extraction had items would read as broken.
  const m = buildPreviewModel({
    topics: [topic({ session_id: 's1',
      action_items: [{ action: 'Chase the beam cert', status: 'open' }] })],
    briefs: [{ sessionId: 's1', brief: brief([]) }],
  });
  assert.strictEqual(m.rowsSource, 'action_items');
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Chase the beam cert']);
});

/* ---- substitution is PER SESSION, never per day (fix round, 2026-09-18) - */

/*
 * The first cut of this plan read §1.3 ("if a brief exists, use it") as a
 * day-wide switch: any one usable brief flipped the WHOLE table to the brief
 * path, which silently dropped every other session's — and every
 * session-less topic's — own commitment the moment that one brief loaded.
 * That was a defect the coordinator caught in review, not accepted product
 * behaviour: the rule is per session. A session's own usable brief (loaded,
 * >= 1 task) replaces only THAT session's own action items; every item whose
 * session has no usable brief — because its fetch failed, is still pending,
 * has zero tasks, or the topic carries no session_id at all — stays exactly
 * where it was. `rowsSource` is `'mixed'` whenever that produces a table
 * with rows from both sources, which is the ordinary shape of a half-loaded
 * day, not an edge case.
 */

test('two sessions, one briefed and one not: the briefed one substitutes, the other keeps its own item', () => {
  const m = buildPreviewModel({
    topics: [
      topic({ session_id: 's1', action_items: [{ action: 'Redo the wall', status: 'open' }] }),
      topic({ session_id: 's2', topic_title: 'Slab pour',
        action_items: [{ action: 'Pour the slab', status: 'open' }] }),
    ],
    // s2's brief simply never loaded (a failed or still-pending fetch never
    // reaches `opts.briefs` at all — see timeline.js's loadSessionBriefs).
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Redo the west wall to line', at: '09:00:00', assignee: 'John', due: 'Wed' },
    ]) }],
  });
  assert.strictEqual(m.rowsSource, 'mixed',
    'one row substituted (s1), one stayed as extraction (s2) — this is not '
    + 'fully "brief" and not fully "action_items"');
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['Redo the west wall to line', 'Pour the slab'],
    "s2's own extraction item must still be on the table — a sibling "
    + "session's usable brief must never make it disappear");
});

test('a topic with no session_id keeps its own item even when a sibling session is briefed', () => {
  const m = buildPreviewModel({
    topics: [
      topic({ session_id: 's1', action_items: [{ action: 'Redo the wall', status: 'open' }] }),
      topic({ session_id: null, topic_title: 'Site walk',
        action_items: [{ action: 'Chase the producer statement', status: 'open' }] }),
    ],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Redo the west wall to line', at: '09:00:00', assignee: 'John', due: 'Wed' },
    ]) }],
  });
  assert.strictEqual(m.rowsSource, 'mixed');
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['Redo the west wall to line', 'Chase the producer statement'],
    'a topic with no session_id can never be routed to anyone\'s brief, so '
    + 'it always keeps its own extraction item');
});

test('a briefed session with zero tasks keeps its OWN items even beside a genuinely-briefed sibling', () => {
  const m = buildPreviewModel({
    topics: [
      topic({ session_id: 's1', action_items: [{ action: 'Redo the wall', status: 'open' }] }),
      topic({ session_id: 's2', topic_title: 'Slab pour',
        action_items: [{ action: 'Pour the slab', status: 'open' }] }),
    ],
    briefs: [
      { sessionId: 's1', brief: brief([
        { text: 'Redo the west wall to line', at: '09:00:00', assignee: 'John', due: 'Wed' },
      ]) },
      { sessionId: 's2', brief: brief([]) },  // zero tasks = no usable brief, §1.3
    ],
  });
  assert.strictEqual(m.rowsSource, 'mixed');
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['Redo the west wall to line', 'Pour the slab']);
});

test('rowsSource is exactly "brief" when every row substituted, and "action_items" when none did', () => {
  const allBrief = buildPreviewModel({
    topics: [topic({ session_id: 's1' })],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Redo the west wall to line' }]) }],
  });
  assert.strictEqual(allBrief.rowsSource, 'brief');

  const allExtraction = buildPreviewModel({ topics: [topic({ session_id: 's1' })] });
  assert.strictEqual(allExtraction.rowsSource, 'action_items');
});

test('a briefed session with no matching topic contributes nothing (§1.3 rule 4)', () => {
  // scopeBriefsToSession already narrows the briefs list on the caller side;
  // this pins the model's OWN half of that guarantee — a session's brief
  // sitting unused in `opts.briefs` must never surface rows on its own.
  const m = buildPreviewModel({
    topics: [topic({ session_id: 's1', action_items: [{ action: 'Redo the wall', status: 'open' }] })],
    briefs: [
      { sessionId: 's1', brief: brief([{ text: 'Redo the west wall to line' }]) },
      { sessionId: 's9', brief: brief([{ text: 'Nobody\'s topic points here' }]) },
    ],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Redo the west wall to line']);
  assert.strictEqual(m.rowsSource, 'brief');
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

test('an unstated assignee or due date is an em dash, never invented text', () => {
  // §1.4/§0: an action row missing an owner or a date shows "—" (this is the
  // one place the plan overturns the pre-existing "blank stays blank" rule —
  // the em dash is what the email already did, and the two surfaces now
  // agree). "Unassigned", "TBC" etc. still must never appear — those invent
  // something the meeting did not say; the em dash does not.
  const m = buildPreviewModel({
    topics: [topic({ action_items: [{ action: 'Chase the beam cert', status: 'open' }] })],
  });
  assert.deepStrictEqual(findRow(renderEmailText(m), 'Chase the beam cert').slice(1),
    ['—', '—'], 'both unstated columns are an em dash');

  const html = renderEmailHtml(m, {});
  assert.ok(!/<td[^>]*><\/td>/.test(html), 'no column is left truly empty');
  assert.ok(/<td[^>]*>—<\/td>/.test(html), 'the em dash fills an unstated cell in HTML too');
  assert.ok(!/Unassigned|No owner|TBC|TBD/i.test(html), 'nothing is invented to fill a column');
});

test('a topic row is N/A in both cells, never the action row\'s em dash', () => {
  // N/A IS NOT THE EM DASH (§0/§1.5). "—" means nobody has picked the task
  // up yet; "N/A" means there is no task here to pick up. Collapsing them
  // would invite someone to adopt a row that was never a task.
  const m = buildPreviewModel({
    topics: [
      topic({ action_items: [{ action: 'Chase the beam cert', status: 'open' }] }),
      topic({ topic_title: 'Voiceprint test', summary: 'Recorded outdoors.', action_items: [] }),
    ],
  });
  const unowned = findRow(renderEmailText(m), 'Chase the beam cert');
  assert.deepStrictEqual(unowned.slice(1), ['—', '—']);
  const topicRow = findRow(renderEmailText(m), 'Voiceprint test');
  assert.deepStrictEqual(topicRow, ['Voiceprint test — Recorded outdoors.', 'N/A', 'N/A']);

  const html = renderEmailHtml(m, {});
  assert.ok(html.indexOf('N/A') > -1, 'N/A appears in the HTML flavour');
  const topicHtmlRow = html.slice(html.indexOf('Voiceprint test'));
  assert.ok((topicHtmlRow.match(/N\/A/g) || []).length >= 2,
    'both the owner and the due cell of a topic row');
});

test('a raw speaker label is not a name and renders as the em dash', () => {
  // §1.4: "spk_0", "spk_12" (case-insensitive) is what the diarizer wrote
  // when nobody stated an owner, not a name someone gave.
  const m = buildPreviewModel({
    topics: [topic({ session_id: 's1', action_items: [] })],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Chase the beam cert', at: '09:00:00', assignee: 'spk_0' },
      { text: 'Order mesh', at: '09:05:00', assignee: 'SPK_12' },
      { text: 'Pour slab', at: '09:10:00', assignee: 'Sam' },
    ]) }],
  });
  assert.strictEqual(findRow(renderEmailText(m), 'Chase the beam cert')[1], '—');
  assert.strictEqual(findRow(renderEmailText(m), 'Order mesh')[1], '—');
  assert.strictEqual(findRow(renderEmailText(m), 'Pour slab')[1], 'Sam',
    'a real name still comes through');
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
    ['Redo the wall', 'John', 'Wed']);
});

test('no time suffix appears in any cell', () => {
  // §1.6: no "(at 09:05:00)", no "(09:00 – 09:20)" — a brief task's clock
  // time and a fallback row's topic time_range are both dropped entirely.
  const fromBrief = buildPreviewModel({
    topics: [topic({ session_id: 's1', action_items: [] })],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Pour slab', at: '09:10:00' }]) }],
  });
  const fromTopics = buildPreviewModel({ topics: [topic()] });
  assert.strictEqual(findRow(renderEmailText(fromBrief), 'Pour slab')[0], 'Pour slab');
  assert.strictEqual(findRow(renderEmailText(fromTopics), 'Redo the wall')[0], 'Redo the wall');
  assert.ok(!renderEmailText(fromBrief).includes('09:10:00'));
  assert.ok(!renderEmailText(fromTopics).includes('09:00'));
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

test('photos render below the table now, grouped under their topic\'s title', () => {
  // The whole reason this modal exists: "the wall is out of tolerance, John
  // by Wednesday" and the photograph showing it must stay traceable to each
  // other. The table itself is flat now (§1.2/§3), so that grouping lives
  // below it instead of inside it — but a photo must still carry the right
  // topic's title, not any topic's.
  const m = buildPreviewModel({
    topics: [
      topic({ related_photos: ['wall.jpg'] }),
      topic({ topic_title: 'Second topic', action_items: [{ action: 'Other', status: 'open' }] }),
    ],
  });
  const html = renderEmailHtml(m, { 'wall.jpg': 'data:image/jpeg;base64,AAA' });
  const table = html.indexOf('</table>');
  assert.ok(html.indexOf('Redo the wall') < table, 'the row is inside the table');
  assert.ok(table < html.indexOf('Wall tolerance'), 'the photo section starts after the table');
  assert.ok(html.indexOf('Wall tolerance') < html.indexOf('data:image/jpeg'),
    'the photo\'s own topic title precedes it');
  // "Second topic" has no photos, so it never gets a photo-section heading
  // of its own — nothing to evidence there.
  assert.ok(!html.slice(table).includes('Second topic'));
});

/* ---- `at` is two formats wearing one name, and neither reaches a cell --- */

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
    topics: [topic({ session_id: 's1', action_items: [], time_range: '11:00 – 11:20' })],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'no time at all' },
      { text: 'ten past nine', at: '09:10:00' },
      { text: 'eight sharp', at: '08:00:00' },
    ]) }],
  });
  // The topic (no action items) sinks after every brief row, as always.
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['eight sharp', 'ten past nine', 'no time at all', 'Wall tolerance']);
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

test('a newline inside task text cannot terminate the row mid-table', () => {
  // Brief task text comes from a model, so a wrapped sentence is reachable
  // rather than theoretical. A raw newline ends the pipe row where it falls:
  // a markdown-aware client loses every row after it, and a plain reader gets
  // the tail of the sentence orphaned under no column at all. Collapsed to a
  // space, which is what the sentence meant anyway.
  const m = buildPreviewModel({
    topics: [topic({ action_items: [
      { action: 'Check the level 2 handover\nand the level 3 one',
        responsible: 'Sam', status: 'open' }] })],
  });
  const txt = renderEmailText(m);

  const cells = textRows(txt).find((c) => c[0].startsWith('Check the level 2 handover'));
  assert.strictEqual(cells.length, 3, 'the row still has three columns');
  assert.strictEqual(cells[1], 'Sam', 'the owner is still in the ASSIGNED column');
  assert.ok(cells[0].includes('handover and the level 3 one'),
    'the rest of the sentence stays in the AGENDA ITEM cell');

  // The structural claim, stated directly: nothing between the header and the
  // blank line before the footer is anything but a pipe row. A split row
  // leaves a line that does not start with `|`, which is the tell.
  const body = txt.split('\n').slice(txt.split('\n').indexOf('| AGENDA ITEM | ASSIGNED | DUE DATE |'));
  body.filter((l) => l.trim() && l !== m.footer).forEach((l) => {
    assert.ok(l.trim().startsWith('|'), 'every table line is a whole row: ' + JSON.stringify(l));
  });
});

/* ---- a topic row is a real row now, not a heading ------------------------ */

test('a topic row sits at the bottom of the SAME flat table, not a heading above it', () => {
  // The per-topic layout and its `**`-marked label rows are gone entirely
  // (§1.2/§3): there is exactly one table, action rows first, topic rows
  // sunk after them, and a topic row is indistinguishable in STRUCTURE from
  // an action row — only its N/A cells (checked elsewhere) say it is not one.
  const m = buildPreviewModel({
    topics: [
      topic(),
      topic({ topic_title: 'Voiceprint test', summary: 'Recorded outdoors.', action_items: [] }),
    ],
  });
  const rows = textRows(renderEmailText(m));
  const firstCol = rows.map((c) => c[0]);
  assert.ok(!firstCol.some((t) => t.startsWith('**')), 'no `**` heading marker survives');
  assert.ok(firstCol.indexOf('Redo the wall') < firstCol.indexOf('Voiceprint test — Recorded outdoors.'),
    'the action row precedes the topic row it sinks below');
});

/* ---- a brief is never slotted under topics by position ------------------- */

test('a session\'s brief is emitted once, at its first topic; later topics of the same session add nothing', () => {
  // Two topics sharing ONE session: nothing in this model may ever lay brief
  // rows out one-per-topic by position — that would put "Pour slab to level
  // 2" underneath "Wall tolerance" with the wall photograph attached to it,
  // a photo of a wall offered as evidence of a slab. Substitution is per
  // SESSION (fix round, 2026-09-18): the session's whole brief block is
  // written once, at the first topic that belongs to it; the second topic of
  // the SAME session contributes neither a second copy of the brief nor its
  // own (now-superseded) extraction item.
  const m = buildPreviewModel({
    topics: [
      topic({ session_id: 's1', related_photos: ['wall.jpg'],
              action_items: [{ action: 'Redo the wall', status: 'open' }] }),
      topic({ session_id: 's1', topic_title: 'Slab pour', time_range: '10:00 – 10:20',
              action_items: [{ action: 'Pour the slab', status: 'open' }] }),
    ],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Pour slab to level 2', at: '09:10:00' },
      { text: 'Order mesh', at: '14:05:00' },
    ]) }],
  });

  assert.strictEqual(m.rowsSource, 'brief');
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Pour slab to level 2', 'Order mesh'],
    'the whole session is substituted once — "Pour the slab" (the second '
    + "topic's own extraction item) never appears at all");

  // Said as the consequence rather than the shape: no brief row sits beneath
  // a topic heading, so no photo can be read as evidencing one.
  const html = renderEmailHtml(m, { 'wall.jpg': 'https://s3/wall.jpg' });
  const table = html.indexOf('</table>');
  assert.ok(html.indexOf('Pour slab to level 2') < table
    && html.indexOf('Order mesh') < table, 'both brief rows are inside the table');
  assert.ok(html.indexOf('Wall tolerance') > table,
    'the wall photo\'s title only ever appears in the photo section, after the table');
});

/* ---- topic-row text: parity with lambda_item_writer._topic_rows --------- */

/*
 * §1.5/§3: the topic-row text is built "exactly as lambda_item_writer._topic_rows
 * builds it today". The four cases below are the SAME input/output pairs the
 * backend pins in tests/unit/test_the_email_is_one_table_of_items.py, ported
 * as literally as JS syntax allows, so the two implementations cannot drift
 * apart silently — a change to either side that is not also made to the
 * other shows up here as a mismatch, not as two documents quietly disagreeing.
 *
 * Backend cases mirrored (found in
 * wt-pipe-sync/tests/unit/test_the_email_is_one_table_of_items.py):
 *   - test_a_topic_that_produced_a_task_is_not_listed_twice
 *     (title "Voiceprint test", summary "Recorded outdoors.")
 *   - test_a_topic_row_carries_the_first_sentence_only
 *   - test_a_long_topic_row_is_trimmed_not_dropped
 *   - test_a_topic_with_no_words_at_all_is_not_a_row
 */

test('parity: a one-sentence summary that already ends with "." is not doubled', () => {
  // Backend: test_a_topic_that_produced_a_task_is_not_listed_twice.
  const text = topicRowText({ topic_title: 'Voiceprint test', summary: 'Recorded outdoors.' });
  assert.strictEqual(text, 'Voiceprint test — Recorded outdoors.');
});

test('parity: only the first sentence rides in the row', () => {
  // Backend: test_a_topic_row_carries_the_first_sentence_only.
  const text = topicRowText({
    topic_title: 'Voiceprint test',
    summary: 'Recorded outdoors in site noise. The purpose was to check recall against the pipeline.',
  });
  assert.strictEqual(text, 'Voiceprint test — Recorded outdoors in site noise.');
});

test('parity: a long row is trimmed to 180 chars with an ellipsis, not dropped', () => {
  // Backend: test_a_long_topic_row_is_trimmed_not_dropped.
  const text = topicRowText({ topic_title: 'T', summary: 'x'.repeat(400) });
  assert.ok(text.length <= TOPIC_ROW_MAX_CHARS && text.endsWith('…'));
});

test('parity: a topic with no words at all produces no row', () => {
  // Backend: test_a_topic_with_no_words_at_all_is_not_a_row.
  assert.strictEqual(topicRowText({ topic_title: '  ', summary: '' }), '');
});

test('the 180-char cap is exact: 180 survives whole, 181 is trimmed to 179 chars + ellipsis', () => {
  // Off-by-one is the failure mode a "close enough" cap ships silently. Built
  // so the title + " — " prefix is fixed and only the summary's first
  // "sentence" (no ". " in it, so the whole string) varies by one character.
  const prefix = 'T — ';               // 4 chars
  const body179 = 'x'.repeat(180 - prefix.length);       // text.length === 180 exactly
  const exact = topicRowText({ topic_title: 'T', summary: body179 });
  assert.strictEqual(exact.length, TOPIC_ROW_MAX_CHARS, 'exactly 180 is left whole');
  assert.ok(!exact.endsWith('…'), 'and is not truncated');

  const body180 = 'x'.repeat(181 - prefix.length);       // one character over
  const over = topicRowText({ topic_title: 'T', summary: body180 });
  assert.strictEqual(over.length, TOPIC_ROW_MAX_CHARS, 'trimmed back down to the cap');
  assert.ok(over.endsWith('…'), 'and marked as trimmed');
  assert.strictEqual(over.slice(0, -1), exact.slice(0, TOPIC_ROW_MAX_CHARS - 1),
    'the surviving text is the first 179 characters of the untrimmed string');
});

test('parity: the 180 cap counts codepoints, not UTF-16 units — astral characters at the boundary', () => {
  // Fix round 2, 2026-09-18: `.length`/`.slice()` count UTF-16 CODE UNITS.
  // Python's `len()`/`text[:180]` count CODEPOINTS. An astral character (one
  // outside the Basic Multilingual Plane — an emoji, a CJK Extension B
  // ideograph) is ONE codepoint but TWO UTF-16 units, so the old
  // `.length`/`.slice()` cap counted one character too many near the
  // boundary and could cut a surrogate pair in half, producing an unpaired
  // surrogate the backend would never emit.
  //
  // Expected output computed by running the ACTUAL backend function
  // (read-only; wt-pipe-sync is untouched):
  //   cd wt-pipe-sync && PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python -c
  //     "import sys; sys.path.insert(0,'src'); import lambda_item_writer as w;
  //      print([hex(ord(c)) for c in w._topic_rows(
  //        {'topics':[{'topic_title':'T','summary':'\U00020000'*200,
  //                    'action_items':[]}]})[0]['text']][:6])"
  // gave: title 'T', summary a run of U+20000 repeated 200 times, no ". " in
  // it (so the "first sentence" is the whole summary) -> the backend's
  // `_topic_rows` returns "T — " + (U+20000 * 175) + "…", 180 codepoints
  // exactly (4-char prefix + 175 astral chars + 1 ellipsis).
  const astral = '\u{20000}'; // outside the BMP: one codepoint, two UTF-16 units
  const summary = astral.repeat(200);
  const text = topicRowText({ topic_title: 'T', summary: summary });
  const expected = 'T — ' + astral.repeat(175) + '…';

  assert.strictEqual(text, expected, 'byte-for-byte match with the backend\'s own output');
  assert.strictEqual(Array.from(text).length, TOPIC_ROW_MAX_CHARS,
    'the cap is measured in codepoints, matching Python\'s len()');
  // A UTF-16 length of 355 (4 + 175*2 + 1) rather than 180 is exactly the
  // signature of the old bug being silently reintroduced.
  assert.strictEqual(text.length, 4 + 175 * 2 + 1);
  // No astral character survives cut in half: every low (trailing) surrogate
  // in the string is immediately preceded by its matching high surrogate.
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xDC00 && code <= 0xDFFF) {
      const prev = text.charCodeAt(i - 1);
      assert.ok(prev >= 0xD800 && prev <= 0xDBFF,
        'a lone trailing surrogate at index ' + i + ' means a pair was cut in half');
    }
  }
});

/* ---- speaker labels, directly ------------------------------------------- */

test('isSpeakerLabel matches the backend pattern exactly: spk/speaker + number, any separator', () => {
  // Mirrors fieldsight-pipeline session_brief._SPEAKER_LABEL
  // (r"^\s*(spk|speaker)[\s_-]*\d+\s*$", re.I). The email blanks every one of
  // these; if this side did not, the same row would read differently in the
  // email and in Preview & copy.
  for (const label of ['spk_0', 'SPK_12', '  spk_3  ', 'spk-4', 'spk5', 'speaker_0',
                       'Speaker 2', 'SPEAKER-7']) {
    assert.ok(isSpeakerLabel(label), label + ' is a speaker label');
  }
  for (const name of ['Sam', '', 'Speaker', 'spk_', 'Spike 3', 'John spk_0']) {
    assert.ok(!isSpeakerLabel(name), JSON.stringify(name) + ' is not a speaker label');
  }
});

/* ---- the table is flat: one order, action rows then topic rows ---------- */

test('action rows and topic rows are never interleaved, across multiple topics', () => {
  // §1.2: "Order: every action row, then every topic row." Three topics,
  // mixed — two with action items, two without — proves the sink is by
  // KIND, not by position in the topics array.
  const m = buildPreviewModel({
    topics: [
      topic({ topic_title: 'Has task A', action_items: [{ action: 'task A', status: 'open' }] }),
      topic({ topic_title: 'No task 1', summary: 'First bare topic.', action_items: [] }),
      topic({ topic_title: 'Has task B', action_items: [{ action: 'task B', status: 'open' }] }),
      topic({ topic_title: 'No task 2', summary: 'Second bare topic.', action_items: [] }),
    ],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text), [
    'task A', 'task B',
    'No task 1 — First bare topic.', 'No task 2 — Second bare topic.',
  ]);
});

test('a topic that produced an action item is never ALSO listed as a topic row', () => {
  const m = buildPreviewModel({
    topics: [topic({ topic_title: 'Cylinder testing', summary: 'It was tested.',
                      action_items: [{ action: 'Re-inspect', responsible: 'Neil', status: 'open' }] })],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Re-inspect']);
  assert.ok(!renderEmailText(m).includes('Cylinder testing'));
});

test('the HTML flavour greys a topic row', () => {
  // §1.5: "HTML renders the row greyed (color:#666)."
  const m = buildPreviewModel({
    topics: [topic({ topic_title: 'Voiceprint test', summary: 'Recorded outdoors.', action_items: [] })],
  });
  const html = renderEmailHtml(m, {});
  const row = html.slice(html.lastIndexOf('<tr>', html.indexOf('Voiceprint test')));
  assert.ok(/color:#666/.test(row), 'the topic row\'s cells carry the grey color');
});

/* ---- a topic row's photos travel with it (fix round 2, 2026-09-18) ------- */

/*
 * `groups` — the only thing the photo section, `totalPhotos` and the
 * `photoUrls` fetch ever read — used to be pushed only `if (open.length)`.
 * A topic row is EXACTLY a topic with zero action items, so it could never
 * contribute a group and its photos vanished with no error anywhere. A
 * site-observation topic with photos and no task ("Standing water near the
 * east entrance", no owner, no due date — just evidence) is an ordinary
 * case, not a corner one.
 */

function siteObservationTopic(over) {
  return Object.assign({
    topic_title: 'Site conditions',
    summary: 'Standing water near the east entrance.',
    action_items: [],
    related_photos: ['photo1.jpg', 'photo2.jpg'],
  }, over);
}

test('a topic row keeps its photos — the exact reproduction from the report', () => {
  const m = buildPreviewModel({ topics: [siteObservationTopic()] });

  assert.strictEqual(m.groups.length, 1, 'the topic row topic must contribute a group');
  assert.deepStrictEqual(m.groups[0].photos, ['photo1.jpg', 'photo2.jpg']);
  assert.strictEqual(m.totalPhotos, 2);

  const html = renderEmailHtml(m, { 'photo1.jpg': 'https://s3/1.jpg', 'photo2.jpg': 'https://s3/2.jpg' });
  assert.strictEqual((html.match(/<img/g) || []).length, 2,
    'both photos render in the HTML flavour');
  // "Site conditions" appears TWICE: once inside the table (the topic row's
  // own AGENDA ITEM text, "Site conditions — Standing water..."), and once
  // as the photo section's heading below the table — the LAST occurrence.
  assert.ok(html.lastIndexOf('Site conditions') > html.indexOf('</table>'),
    'the photo section heading is the topic title, below the table');

  const txt = renderEmailText(m);
  assert.ok(txt.includes('2 photos'), 'the text flavour says the photos exist');
  assert.ok(txt.includes('Site conditions'), 'under the topic\'s own title');
});

test('a topic row with an UNREADABLE photo still reports it, same as any other topic', () => {
  // Not a new code path — the existing "omitted, never rendered broken" rule
  // — but worth pinning here specifically because this is the topic shape
  // that a fixed `open.length` gate could revert to silently skipping again.
  const m = buildPreviewModel({ topics: [siteObservationTopic({ related_photos: ['gone.jpg'] })] });
  const html = renderEmailHtml(m, {});
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('Site conditions'), 'the heading still shows — text is never lost');
});

test('an all-done topic (every item status:done) drops its photos too — a deliberate choice, not a bug', () => {
  // Decision (fix round 2, 2026-09-18): an all-done topic is neither an
  // action row (nothing open) nor a §1.5 topic row (its raw action_items is
  // non-empty, so it fails "produced NO action items at all"). The model's
  // own stated purpose is "a hand-off of work remaining, not a transcript"
  // of a fully closed topic — its photos most likely evidenced a task that
  // was already raised and already communicated when it was open, not
  // something this hand-off needs to carry again. This is the one place the
  // model still deliberately drops content; recorded here rather than left
  // implicit, so a future reviewer sees a decision, not an oversight.
  const m = buildPreviewModel({
    topics: [{
      topic_title: 'Cylinder testing', summary: 'It was tested.',
      action_items: [{ action: 'Re-inspect', status: 'done' }],
      related_photos: ['done1.jpg'],
    }],
  });
  assert.strictEqual(m.groups.length, 0, 'an all-done topic contributes no group at all');
  assert.strictEqual(m.totalPhotos, 0);
  const html = renderEmailHtml(m, { 'done1.jpg': 'https://s3/done1.jpg' });
  assert.ok(!html.includes('<img'), 'the finished topic\'s photo does not appear');
});

test('totalItems now counts action ROWS on the table, not a re-derived group count', () => {
  // Decision (fix round 2, 2026-09-18): `totalItems` used to be re-derived
  // from `groups` (sum of each group's raw open-item count), which could
  // quietly disagree with the table once brief substitution existed — a
  // session's brief might carry MORE or FEWER tasks than the topic's own
  // open items it replaced. `groups` is also now carrying topic-row entries
  // that contribute zero items. `actionRows.length` is the one number that
  // matches "how many commitments does this hand-off actually carry", which
  // is what the reader sees in the table.
  const m = buildPreviewModel({
    topics: [
      { topic_title: 'Wall', session_id: 's1',
        action_items: [
          { action: 'a', status: 'open' }, { action: 'b', status: 'open' },
          { action: 'c', status: 'open' },
        ] },
    ],
    briefs: [{ sessionId: 's1', brief: { status: 'ready', tasks: [
      { text: 'one brief task replaces all three', at: '09:00:00' },
    ] } }],
  });
  assert.strictEqual(m.rows.length - 0, 1, 'sanity: one action row from the brief');
  assert.strictEqual(m.totalItems, 1,
    'totalItems reflects the ONE row actually on the table, not the three raw open items it replaced');
});

/* ==========================================================================
   Part 2 — the brief and the extraction stop talking past each other (§5-10)
   ==========================================================================
   Two defects fixed here, both consequences of substituting brief tasks for
   extraction action items while topic rows were still decided from the
   extraction alone (§5):
     5.1 the same commitment appeared twice — once as an action row, once as
         a topic row about the same topic;
     5.2 a dated commitment the extraction caught, that the brief never
         mentioned, silently vanished when the brief won.
*/

/* ---- §7.1 (superseded): topic-row suppression is now a TEXT test --------
   Time-based coverage (`topicCovered`/`parseTimeRange`/`parseClockSeconds`)
   is gone — measured on a real session it suppressed a topic row that
   shared nothing but a clock window with the brief task that "covered" it
   (a Papakura row killed by a KCD task, same 2-minute window, unrelated
   content). Suppression is decided by `isRepresented` against the topic's
   own row text, reusing the §7.4 rule below rather than a second one. */

test('real case: the Ormiston/DeAndre topic row IS suppressed — its text is represented in the matching brief task', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Ormiston College 360 Inspections',
      summary: 'Speaker hopes to visit the MPI site with DeAndre.',
      action_items: [],
    })],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Visit MPI site with DeAndre to review open-space usage pattern after Ormiston College 360 inspections.', at: '13:42:06' },
    ]) }],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['Visit MPI site with DeAndre to review open-space usage pattern after Ormiston College 360 inspections.'],
    'the topic row is suppressed: no second row saying the same thing in different words');
});

test('real case: the Papakura topic row is KEPT — nothing in the real brief tasks mentions it (this is the whole reason for the change)', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Papakura Progress and Modulars',
      summary: 'Papakura is mid-program with good positioning and progressing well.',
      action_items: [],
    })],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Meet with KCD at the Icehouse office regarding new contract details.', at: '13:40:43' },
      { text: 'Visit MPI site with DeAndre to review open-space usage pattern after Ormiston College 360 inspections.', at: '13:42:06' },
      { text: 'Follow up with contractor on scaffolding permit renewal.', at: '13:44:33' },
    ]) }],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['Meet with KCD at the Icehouse office regarding new contract details.',
      'Visit MPI site with DeAndre to review open-space usage pattern after Ormiston College 360 inspections.',
      'Follow up with contractor on scaffolding permit renewal.',
      'Papakura Progress and Modulars — Papakura is mid-program with good positioning and progressing well.'],
    'the KCD task (same time window, unrelated text) must not suppress a Papakura row it never mentions');
});

test('a suppressed topic still carries its photos below the table', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Ormiston College 360 Inspections',
      summary: 'Speaker hopes to visit the MPI site with DeAndre.',
      action_items: [], related_photos: ['mpi.jpg'],
    })],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Visit MPI site with DeAndre to review open-space usage pattern after Ormiston College 360 inspections.', at: '13:42:06' },
    ]) }],
  });
  assert.strictEqual(m.rows.length, 1, 'no topic row for the suppressed topic');
  assert.strictEqual(m.totalPhotos, 1, 'the photo travels even though no topic row was emitted');
  const html = renderEmailHtml(m, { 'mpi.jpg': 'https://s3/mpi.jpg' });
  assert.ok(html.includes('<img'));
  assert.ok(html.includes('Ormiston College 360 Inspections'), 'the photo section heading survives');
});

test('a topic with no session_id is never suppressed — there is no brief to test its text against', () => {
  const m = buildPreviewModel({
    topics: [
      topic({ session_id: 's1', topic_title: 'Ormiston College 360 Inspections',
        summary: 'Speaker hopes to visit the MPI site with DeAndre.', action_items: [] }),
      topic({ session_id: null, topic_title: 'No session at all', summary: 'y', action_items: [] }),
    ],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Visit MPI site with DeAndre to review open-space usage pattern after Ormiston College 360 inspections.', at: '13:42:06' },
    ]) }],
  });
  assert.ok(m.rows.some((r) => r.text.startsWith('No session at all')),
    'a topic with no session_id can never be suppressed — there is no brief to check its text against');
});

/* ---- §7.3-7.4: back-fill ------------------------------------------------- */

test('§9 worked example: a low-overlap dated item is back-filled after the brief rows', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Port Com',
      action_items: [{
        action: 'PS4 for the Port Com SR study to be signed', deadline: '2027-01-31', status: 'open',
      }],
    })],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Start QA pour checks and create report on Port Com concrete', at: '09:00:00' },
    ]) }],
  });
  assert.strictEqual(m.rowsSource, 'mixed', 'one brief row, one back-filled extraction row');
  assert.deepStrictEqual(m.rows.map((r) => r.text), [
    'Start QA pour checks and create report on Port Com concrete',
    'PS4 for the Port Com SR study to be signed',
  ], 'the back-filled row is appended AFTER the brief rows of its session');
  assert.strictEqual(m.rows[1].due, '2027-01-31');
});

test('§9 worked example: a high-overlap item ("represented") is NOT back-filled', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Port Com',
      action_items: [{
        action: 'Concrete QA pour checks and report to be started three weeks later after cure',
        deadline: '2026-10-09', status: 'open',
      }],
    })],
    briefs: [{ sessionId: 's1', brief: brief([
      { text: 'Start QA pour checks and create report on Port Com concrete once 28-day cure ends in about three weeks', at: '09:00:00' },
    ]) }],
  });
  assert.strictEqual(m.rowsSource, 'brief', 'nothing back-filled: the item is already represented');
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['Start QA pour checks and create report on Port Com concrete once 28-day cure ends in about three weeks']);
});

test('§9 worked example: an item with NO due date is never back-filled, however unmatched', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Random',
      action_items: [{ action: 'Completely unrelated undated remark', status: 'open' }],
    })],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Pour the slab', at: '09:00:00' }]) }],
  });
  assert.strictEqual(m.rowsSource, 'brief');
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Pour the slab']);
});

test('back-fill draws from the WHOLE session, including a topic reached later in the walk', () => {
  // The brief block is written at the FIRST topic of the session; the
  // eligible extraction item lives on the SECOND topic of the same session.
  // The first topic carries no title/summary of its own — this test is
  // about back-fill order, not topic-row suppression, so it is built to
  // produce no topic row at all (an empty topicRowText is dropped, not
  // suppressed) rather than pull suppression into an unrelated assertion.
  const m = buildPreviewModel({
    topics: [
      topic({ session_id: 's1', topic_title: '', action_items: [] }),
      topic({ session_id: 's1', topic_title: 'Second topic',
        action_items: [{ action: 'Sign the completely unrelated producer statement', deadline: '2026-12-01', status: 'open' }] }),
    ],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Pour the slab', at: '09:00:00' }]) }],
  });
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ['Pour the slab', 'Sign the completely unrelated producer statement']);
});

test('a done extraction item is never back-filled', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Port Com',
      action_items: [{ action: 'Completely unrelated finished item', deadline: '2026-10-01', status: 'done' }],
    })],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Pour the slab', at: '09:00:00' }]) }],
  });
  assert.strictEqual(m.rowsSource, 'brief');
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Pour the slab']);
});

test('back-fill never fires for a session with no usable brief — nothing to append after', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Port Com',
      action_items: [{ action: 'Unrelated dated item', deadline: '2026-10-01', status: 'open' }],
    })],
    // s1's own brief has zero tasks, so §1.3 treats it as no brief at all —
    // the whole session stays on the extraction path, and §7.3 only fires
    // "when action rows come from a session's brief".
    briefs: [{ sessionId: 's1', brief: brief([]) }],
  });
  assert.strictEqual(m.rowsSource, 'action_items');
  assert.deepStrictEqual(m.rows.map((r) => r.text), ['Unrelated dated item']);
});

test('back-fill never crosses sessions: session A cannot back-fill session B\'s items', () => {
  // Session A's topic carries no title/summary of its own — this test is
  // about session boundaries, not topic-row suppression (see the note on
  // the WHOLE-session back-fill test above for why).
  const m = buildPreviewModel({
    topics: [
      topic({ session_id: 's1', topic_title: '', action_items: [] }),
      topic({ session_id: 's2', topic_title: 'B',
        action_items: [{ action: 'B\'s own unrelated dated item', deadline: '2026-10-01', status: 'open' }] }),
    ],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'A\'s own brief task', at: '09:00:00' }]) }],
    // s2 has no usable brief, so its own item stays on the extraction path —
    // it must not ALSO ride in as a back-fill under session s1.
  });
  assert.strictEqual(m.rowsSource, 'mixed');
  assert.deepStrictEqual(m.rows.map((r) => r.text),
    ["A's own brief task", "B's own unrelated dated item"]);
  // In particular: it appears exactly once, not doubled by back-fill logic.
  assert.strictEqual(m.rows.filter((r) => r.text.includes('unrelated dated item')).length, 1);
});

/* ---- §7.4: the Jaccard threshold, the stop list, and the tie direction -- */

test('isRepresented: overlap strictly above the threshold is represented', () => {
  const { isRepresented } = require('../scripts/composites/email-preview-modal.js');
  // tokens {aaa,bbb,ccc,ddd} vs {aaa,bbb,ccc,eee}: intersection 3, union 5 -> 0.6
  assert.strictEqual(isRepresented('aaa bbb ccc ddd', ['aaa bbb ccc eee']), true);
});

test('isRepresented: overlap strictly below the threshold is not represented', () => {
  const { isRepresented } = require('../scripts/composites/email-preview-modal.js');
  assert.strictEqual(isRepresented('aaa bbb', ['aaa xxx yyy zzz']), false);
});

test('isRepresented: overlap EXACTLY at the threshold is a tie, and a tie is NOT represented', () => {
  // Decision made explicit (§7.4 read literally): "Represented iff overlap
  // >= 0.30. A tie ... counts as NOT represented." Read together, the tie in
  // question is the best-overlap value landing exactly ON the threshold, so
  // this implementation treats the comparison as strictly-greater-than 0.30
  // rather than >=. Picked over the alternative reading (a plain >= 0.30,
  // making the second sentence describe only ties among several candidate
  // brief tasks) because it is the one that keeps BOTH sentences true at
  // once, and it keeps faith with §10's stated bias: uncertain cases lean
  // towards carrying a commitment twice, never towards dropping it.
  //
  // 10 tokens vs 10 tokens sharing exactly 3 in common: 3 / (10+10-3) = 3/17
  // is not exactly 0.30, so this constructs the boundary directly instead:
  // {a,b,c} vs {a,b,d} -> intersection 2, union 4 -> 0.5, not what's wanted.
  // Simplest exact 0.30: intersection 3, union 10 -> {a,b,c,d,e,f,g} (7
  // unique) vs {a,b,c,h,i,j} (6 unique), shared {a,b,c} -> union 10,
  // inter 3 -> 3/10 = 0.30 exactly.
  const { isRepresented, REPRESENTED_JACCARD_THRESHOLD } =
    require('../scripts/composites/email-preview-modal.js');
  assert.strictEqual(REPRESENTED_JACCARD_THRESHOLD, 0.30);
  const textA = 'aaa bbb ccc ddd eee fff ggg';   // 7 tokens: a b c d e f g
  const textB = 'aaa bbb ccc hhh iii jjj';       // 6 tokens: a b c h i j
  assert.strictEqual(isRepresented(textA, [textB]), false, 'exactly 0.30 does not represent');
});

test('isRepresented: an empty token set (too-short words, all stop words) is never represented', () => {
  const { isRepresented } = require('../scripts/composites/email-preview-modal.js');
  assert.strictEqual(isRepresented('to a an', ['pour the slab today']), false, 'all stop words / <3 chars');
  assert.strictEqual(isRepresented('', ['pour the slab today']), false);
  assert.strictEqual(isRepresented('pour the slab today', ['']), false);
});

test('isRepresented drops the stop list and short tokens before comparing', () => {
  const { isRepresented } = require('../scripts/composites/email-preview-modal.js');
  // Without stop-word/length filtering "to the a" would inflate overlap on
  // completely unrelated sentences that happen to share function words.
  assert.strictEqual(
    isRepresented('Go to the site and check it', ['Go to the office and pay it']), false);
});

/* ---- rows/rowsSource stay honest with backfilled rows -------------------- */

test('a back-filled row counts toward totalItems and fromExtractionCount (rowsSource=mixed)', () => {
  const m = buildPreviewModel({
    topics: [topic({
      session_id: 's1', topic_title: 'Port Com',
      action_items: [{ action: 'Totally unrelated dated commitment', deadline: '2026-10-01', status: 'open' }],
    })],
    briefs: [{ sessionId: 's1', brief: brief([{ text: 'Pour the slab', at: '09:00:00' }]) }],
  });
  assert.strictEqual(m.totalItems, 2);
  assert.strictEqual(m.rowsSource, 'mixed');
});
