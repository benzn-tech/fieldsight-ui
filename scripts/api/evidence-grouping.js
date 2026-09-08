/* ==========================================================================
   api/evidence-grouping.js — the Photos tab, grouped by topic.

   Every photo the Evidence page holds arrives from
   report.topics[].related_photos (evidence.js:302-309), so it carries a topic
   BY CONSTRUCTION. `ungrouped` is therefore always empty in practice; it
   exists so that a future list-photos endpoint fails a test rather than
   silently dropping photos into nothing. See the spec's §2.1.

   Registers as FS.api.evidenceGrouping.
   ========================================================================== */
(function () {
  'use strict';

  var STAMP_RE = /_(\d{2})-(\d{2})-(\d{2})\.[a-z]+$/i;
  var KEYFRAME_RE = /_kf_s(\d{2})(\d{2})(\d{2})\.[a-z]+$/i;
  var MAX_FOLDER = 28;
  var ILLEGAL = /[\\/:*?"<>|]/g;

  /* 'HH-MM-SS', or null. Deliberately NOT a Date: the only thing needed is a
     sortable key within one day, and building a Date would drag in the NZDT
     trap (BUG-19) for no gain. Null means "no time in this name" and the
     caller sorts those last rather than guessing one. */
  function photoTime(filename) {
    var s = String(filename || '');
    var m = s.match(KEYFRAME_RE) || s.match(STAMP_RE);
    return m ? (m[1] + '-' + m[2] + '-' + m[3]) : null;
  }

  function byTime(a, b) {
    var ta = photoTime(a.filename), tb = photoTime(b.filename);
    if (ta && tb) return ta < tb ? -1 : (ta > tb ? 1 : a._i - b._i);
    if (ta) return -1;
    if (tb) return 1;
    return a._i - b._i;          /* both unknown: payload order */
  }

  function groupByTopic(photos) {
    var list = (photos || []).map(function (p, i) {
      return Object.assign({}, p, { _i: i });
    });
    var order = [], byId = {}, ungrouped = [];
    list.forEach(function (p) {
      /* `== null`, NOT falsiness. `topic_id` is the payload's LOOP INDEX
         (`render_report_shape` emits "topic_id": i; the durable id is
         `topic_row_id`), so the FIRST topic of every day is 0 — and a
         falsy check dropped its photos on every single day. The unit test
         asserting input-count equals sum-of-groups did not catch it because
         its fixture used invented string ids and never a 0. */
      if (p.topic_id == null || p.topic_id === '') { ungrouped.push(p); return; }
      if (!byId[p.topic_id]) {
        byId[p.topic_id] = { topic_id: p.topic_id,
                             topic_title: p.topic_title || '',
                             photos: [] };
        order.push(byId[p.topic_id]);
      }
      byId[p.topic_id].photos.push(p);
    });
    order.forEach(function (g) { g.photos.sort(byTime); });
    /* Groups ordered by their FIRST photo — the order the day happened in.
       A group whose photos all lack a time sorts last, by the order the
       payload gave, for the same reason a photo does. */
    order.sort(function (a, b) {
      var ta = photoTime(a.photos[0].filename);
      var tb = photoTime(b.photos[0].filename);
      if (ta && tb) return ta < tb ? -1 : (ta > tb ? 1 : 0);
      if (ta) return -1;
      if (tb) return 1;
      return a.photos[0]._i - b.photos[0]._i;
    });
    return { groups: order, ungrouped: ungrouped };
  }

  /* 'NN Title'. The number is the day's order, so a file manager sorting
     alphabetically still shows the day in sequence — and it is what keeps two
     titles that truncate to the same 28 characters apart. */
  function folderName(title, index) {
    var n = String(index + 1);
    if (n.length < 2) n = '0' + n;
    var t = String(title == null ? '' : title).replace(ILLEGAL, '-').trim();
    if (!t) return n + ' Untitled';
    if (t.length > MAX_FOLDER) {
      var cut = t.slice(0, MAX_FOLDER);
      var sp = cut.lastIndexOf(' ');
      t = (sp > 8 ? cut.slice(0, sp) : cut).replace(/[\s.-]+$/, '');
    }
    return n + ' ' + t;
  }

  /* Every photo a report carries, bound or not.

     A photo used to reach Evidence ONLY as `topic.related_photos` — only if it
     happened to be taken while somebody was talking about something that
     became a topic. Measured on prod 2026-09-07: of the photos stored on days
     that HAVE a report, 71 of 90 were unreachable from any screen. 37 % of
     topic time windows are a single instant and 76 % are narrower than the
     +/-2 minute binding tolerance, so photographing a room in silence produced
     shots that existed nowhere on screen.

     `photo_filenames` (backend 2026-09-07, pipeline #762) is the whole day,
     tombstone-filtered, and a SUPERSET of the bound ones — so the unbound set
     is a difference, never a concat. A concat would show every bound photo
     twice: once under its topic and once under No topic.

     The bound rows are emitted exactly as before, INCLUDING the same photo
     appearing under two topics, which media.js:90-91 records as real. Those
     are not duplicates — they are one photo in two folders. Only the unbound
     computation dedupes.

     A day without the field (an older backend, or a verbatim-history day)
     yields precisely what it yielded before. */
  function photosForReport(report) {
    if (!report) return [];
    var rows = [], bound = {};
    (report.topics || []).forEach(function (t) {
      (t.related_photos || []).forEach(function (filename) {
        bound[filename] = true;
        rows.push({
          filename: filename,
          topic_id: t.topic_id,
          topic_title: t.topic_title,
          userDisplayName: report.user_name,
        });
      });
    });
    var seen = {};
    (report.photo_filenames || []).forEach(function (filename) {
      if (bound[filename] || seen[filename]) return;
      seen[filename] = true;
      /* `null`, not undefined and not a sentinel string: groupByTopic tests
         `== null`, and a topic_id of 0 is a real topic (that distinction cost
         a day's first topic its photos once already). */
      rows.push({
        filename: filename,
        topic_id: null,
        topic_title: null,
        userDisplayName: report.user_name,
      });
    });
    return rows;
  }

  /* A day with photos and NO report, in the shape photosForReport reads.
     Returns null when there is nothing to show, so the caller's existing
     "skip this day" branch keeps working unchanged.

     Why a reshape and not a straight pass-through of the 404 body: the body
     spells the folder `user`, photosForReport reads `user_name`, and
     PhotoGrid builds the S3 key from the `userDisplayName` that comes off
     it — handing over `raw` gives every row `undefined` there and no photo
     resolves. The two other 404s the backend can emit (cross-user clip,
     deleted sources) carry `user` but deliberately carry no filenames, and
     fall out here as null rather than being special-cased. */
  function reportFromUploadFacts(raw) {
    var names = (raw && raw.photo_filenames) || [];
    if (!names.length) return null;
    return {
      photo_filenames: names,
      user_name: String(raw.user || '').replace(/_/g, ' '),
    };
  }

  var mod = { photoTime: photoTime, groupByTopic: groupByTopic,
              folderName: folderName,
              photosForReport: photosForReport,
              reportFromUploadFacts: reportFromUploadFacts };
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.evidenceGrouping = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
