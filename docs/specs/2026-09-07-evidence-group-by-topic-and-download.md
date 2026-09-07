# Evidence: group photos by topic, and hand the site manager a folder

**Date:** 2026-09-07
**Status:** design, SECOND draft. The first was reviewed and had three
blocking defects; all three are corrected below and recorded in §8. The first
of them inverted the spec's central claim, so read §2 before anything else.
**Scope:** frontend only — and that is now a *constraint on what the feature
can be*, not merely a note about where the code lives. §2.1.

---

## 1. What was asked

> 把 group 到一起的照片，在 evidence 里面以分类…加一个 button，sorting by
> action group 或者 topic…下载也能生成 Folder，比如说一个 topic 作为一个
> Folder 的名字…site manager 下载下来，分享到其他平台也会更便利。

Refined in conversation: **photos only**; one Download button with selection
(all of today / by topic / arbitrary multi-select); *"select all today"*
produces one zip whose folders are that day's topics; naming **simpler than
the website's**, carrying a date so a glance identifies it.

## 2. The premise, measured

The request rested on *"我相信我们的 metadata 已经能够把对应的信息和图片
group 到一起"*. Checked against prod rather than assumed:

| | |
|---|---|
| photos in the prod lake | **432** (across 11 user folders) |
| linked to a topic | **211 — 49 %** |
| topics carrying photos | **69 of 428** |
| photos per topic | mostly 1–5; two outliers at 15 and 25 |
| average photo size | **1.09 MB**, max 1.61 MB |
| busiest single day | **56 photos, 62.5 MB** (2026-08-20) |

Real topic titles, which become the folder names:

- *Laundry Equipment Overview and Lint Collection System* — 7 photos
- *Steam Heating and Energy Recovery System Explanation* — 4
- *Washing Machine Control Panel and Capacity Review* — 4

**The premise holds for topics.** It does not hold for the other two groupings
the request floated:

**There is no photo↔action-item link.** `topic_photos` (migration 0003) has
exactly `id / topic_id / s3_key / caption_text`. Nothing in the repo relates a
photo to an action item. "Sorting by action group" is not unimplemented UI, it
is absent data, and producing it is an extraction-layer change.

**"Room 101 / Room 102" is not a field.** Topic titles *sometimes* contain a
room or level because someone said it aloud; there is no structured location.
v1 uses the title verbatim and cannot promise tidy names.

### 2.1 The number that matters is 211, not 432 — and the first draft got this backwards

The table above measures the **lake**. The Evidence page does not read the
lake. Its only photo source is `report.topics[].related_photos`
(`evidence.js:302-309`), and `scripts/api/` contains **no endpoint that lists a
user's photo folder** — `media.js:80` only assembles a key from a filename it
has already been handed.

So every photo the page can see **has a topic by construction**. The 221
unlinked photos are not "photos the grouping would leave over"; they are
photos **Evidence has never shown at all, on any tab, since the page was
built**.

Two consequences, and the first draft got both wrong:

1. **There is no `Ungrouped` bucket to render.** The first draft specified one
   carrying 221 photos and argued at length that hiding it would repeat the
   collapse defect. That section would have shipped permanently empty. The
   argument was right and the data was imaginary.
2. **"Evidence hides half the lake" is already true, today, and this feature
   does not cause it or fix it.** It is a real pre-existing gap and it needs a
   list-photos endpoint — a backend change, and therefore out of this spec's
   scope. It is written down here so it stops being invisible.

The corrected framing: **this feature groups the 211 photos Evidence already
shows.** It neither adds nor removes a photo from the page.

## 3. Why this needs no backend

`evidence.js:301-309` already walks `report.topics` and pushes, for every
photo:

```js
photosForDate.push({
  filename: filename, topic_id: t.topic_id,
  topic_title: t.topic_title, userDisplayName: x.report.user_name,
});
```

**The topic title is already attached to every photo object.** Then
`evidence.js:501` throws it away — `day.photos.map(function (p) { return
p.filename; })` — and hands PhotoGrid a list of bare strings.

So grouping is not a feature to build so much as a discard to stop. This is the
fourth instance in two days of one shape: *the data is in hand and the render
drops it* (the others: the sort key's time-of-day, findings' severity/domain,
the thread's date span — `docs/specs/2026-09-07-payload-fields-the-ui-never-read
s.md`).

Downloading likewise needs nothing new:

- `FS.api.media.photoKey({userDisplayName, date, filename})` rebuilds the full
  S3 key `users/{folder}/pictures/{date}/{filename}` (`photo-grid.js:91-93`).
  It takes the DISPLAY NAME and applies `folderName()` itself (`media.js:78-81`)
  — the first draft wrote `{folder, ...}`. Passing an already-derived folder
  happens to survive because `folderName` is idempotent, but the signature in
  the draft did not exist and copying it into code would have read as correct.
- `FS.api.media.getUrl(key)` presigns it, with a cache and a **900 s** TTL.
- The data bucket already answers cross-origin `GET`/`HEAD` for both Amplify
  origins — CORS rule `amplify-read-for-canvas`, added so the email preview
  could read photo bytes into a canvas. The same rule is what lets the browser
  read bytes to build an archive.

⚠️ **That CORS rule is out-of-band** — it is on the bucket, not in any
template, and `git grep` finds no trace of it. A new Amplify domain silently
breaks this feature. Noted here because the next person to debug "download
produces an empty zip" will otherwise look in the wrong repo.

## 4. Grouping

A control on the Photos tab, matching the chip vocabulary already used by
Today's order and aged filters:

```
Group   [ By day ]  [ By topic ]
```

`By day` is today's behaviour and stays the default: it is the order the page
has always had, and a default that changes under a returning user is its own
defect.

Under `By topic`, within each section (§5 — a section is one date for one
person, not one date):

- one sub-section per topic, headed by the topic title and its count
- topics ordered by **first photo time** — the order the day happened in, not
  alphabetical, which would scatter the morning through the afternoon

**There is no `Ungrouped` sub-section.** Every photo the page holds carries a
topic by construction (§2.1), so one would render permanently empty. If a
list-photos endpoint is ever added it comes back, and then it must carry its
count, for the reason the first draft gave.

**The ordering key has to be parsed, and the first draft treated it as free.**
The photo object is exactly `{filename, topic_id, topic_title,
userDisplayName}` (`evidence.js:304-309`) — **no timestamp**. The topic's
`time_range` is free text and is not attached to photos. So first-photo-time
comes from the filename:

- `{device}_{YYYY-MM-DD}_{HH-MM-SS}.jpg` — every photo on prod today
- `..._kf_s{HHMMSS}.jpg` — auto-keyframes (`photo-grid.js:44`). **Zero of these
  exist on prod**, so it is a latent format rather than a live one; handled
  anyway, because the code path that produces them ships.

Anything matching neither keeps the order the payload gave it and sorts after
the timestamped ones. Guessing a time would put an invention into the folder
numbering, which is the one thing the numbering must not do.

The request said to stop ordering by timestamp and filename. Within a topic the
order stays chronological, because that is the sequence the photos were taken
in and it is the only order a reader can check against their own memory. What
goes away is timestamp ordering *across* topics.

## 5. Selection and download

**A section is one date FOR ONE PERSON.** `evidence.js:297-323` pushes one row
per `(date, user)` pair, and only `role === 'worker'` is forced to their own
folder (`evidence.js:174-178`) — a site manager, the role this feature is for,
fans out across every user on the site and therefore sees **several sections
carrying the same date**.

The first draft said "the day section's own checkbox" and named the archive
`{date} {user}.zip`, which is coherent only for a worker. For a site manager
"all of today" spans several sections with different owners, so there is no
single `{user}` and no single day section.

**The rule: the section is the selection unit.** One Download button per
section, selecting within that section only.

That is a deliberate limit rather than an oversight. The alternative — one
selection across sections — needs a `{user}/` level above the topic folders,
a nesting level nobody asked for, on top of the archive the request described.
A site manager wanting a whole day for three people gets three files, each
already named for whose day it is.

Within a section:

- **Select all** — the section's own checkbox ("select all today", for that
  person's day)
- **Select by topic** — the topic sub-section's checkbox
- **Arbitrary** — per-photo checkboxes, which the two above simply set

The button reads `Download (N)` and is disabled at zero — a download button
that produces an empty file is worse than one that refuses.

**Pre-existing bug found while checking this, worth fixing in the same PR:**
both photo section renders key on `key: day.date` (`evidence.js:492`,
`evidence.js:701`) while rows are per `(date, user)`. On any multi-user day
React sees duplicate keys. Independent of this feature, and one line.

### 5.1 The archive

```
2026-09-02 Ben Lin.zip
├── 01 Laundry Equipment Overview/
│   ├── Benl1_2026-09-02_09-55-26.jpg
│   ├── Benl1_2026-09-02_09-55-33.jpg
│   └── Benl1_2026-09-02_09-56-14.jpg
├── 02 Steam Heating and Energy/
└── 03 Washing Machine Control Panel/
```

**Zip name** — `{date} {user}.zip`, which is exactly the section's own identity
(§5) and therefore always unambiguous. The date is the point: it is what makes
the file identifiable in a Downloads folder six weeks later.

**Folder names** — `NN ` + the topic title truncated to ~28 characters at a
word boundary. The number is the day's chronological order, so the folders sort
the way the day ran. Truncation is deliberate: prod titles run to 52 characters
and a folder name that needs horizontal scrolling is not "一眼就知道是什么".
Two topics that truncate to the same string are already distinguished by the
number.

**Photo names — unchanged.** `Benl1_2026-09-02_09-55-26.jpg` stays exactly as
it is in S3, so anything found in the zip can be traced back. This also removes
the need for a manifest file, which a renaming scheme would have required.

**Illegal characters** are replaced, not dropped: `/ \ : * ? " < > |` become
`-`. Dropping them silently merges *"Level 1/2 inspection"* and *"Level 12
inspection"* into one folder.

### 5.2 The zip is written by hand, and that is the simple option

No library, no build step (a repo constraint), and no vendored blob.

**The photos are JPEGs, so the archive uses `store` — no compression.**
Deflating an already-compressed JPEG gains nothing measurable and costs CPU on
a field laptop. A store-only ZIP is a local file header per entry, the bytes,
and a central directory — roughly a hundred lines, all of it format-following
rather than invention. Choosing `store` is what makes writing it by hand the
*simpler* choice rather than the clever one.

CRC-32 is still required per entry; a 256-entry table computed once covers it.

### 5.3 Size, and where it stops

The busiest real day is 56 photos / 62.5 MB, so a day's archive is comfortably
in-memory. **The day is therefore the maximum unit** — there is no "select all
photos across every day", which for one prod user would be 253 MB of source
bytes and roughly double that while the archive is assembled.

If a future selection exceeds **150 MB**, the button says so and refuses rather
than freezing the tab. A number that has to change later is better than a
browser that dies without saying why.

### 5.4 Failures are reported, never quietly dropped

A photo whose presign fails, or whose fetch 403s, **still gets an entry** — a
`_MISSING/` folder holding a text file naming each one and why.

This is the load-bearing rule of the whole feature. A zip that silently
contains 47 of 53 photos is indistinguishable from a complete one, and the
person who shares it with the client will not find out. The repo has shipped
this exact shape twice: the todo collapse whose merged rows vanished, and the
1078 uploads that logged nothing on success so "nothing was lost" and "nothing
ran" looked identical.

Presign TTL is 900 s and a day's fetch is far inside it, but the URLs are
requested in bounded batches as the archive is built rather than all up front,
so a slow connection expires nothing.

## 6. Testing

- **Grouping is a pure function** — `groupPhotosByTopic(dayPhotos)` in
  `scripts/api/evidence-grouping.js`, returning ordered groups plus the
  ungrouped remainder. Assert: nothing is dropped (input count equals the sum of
  all groups), topic order is by first photo time, a filename in neither known
  format keeps its payload order and sorts last, and the SAME filename appearing
  under two topics yields two entries rather than one — `media.js:90-91` says
  that is real, and de-duplicating it would drop a photo from a folder that
  should have it.

  The ungrouped remainder is asserted **empty for every input the page can
  produce** (§2.1): the function still returns it, so the assertion is a
  tripwire — if a list-photos endpoint later feeds this function topic-less
  photos, the test goes red and forces the UI decision rather than letting them
  vanish.
- **Folder naming is a pure function** — truncation at a word boundary, illegal
  characters replaced not dropped, two colliding titles distinguished by the
  number.
- **The zip writer is a pure function** — bytes in, bytes out. Assert the local
  header signature, that the central directory entry count matches the number
  of files, and that the CRC of a known payload matches a value computed
  independently. Read the archive back with a second implementation —
  `unzip -l`, which exists on this machine under Git's usr/bin. **Not Node's
  `zlib`**: it has no ZIP-container parser, and a store-only archive contains no
  zlib streams at all, so the only thing it could contribute is `zlib.crc32` for
  the checksum. Asserting only that the writer agrees with itself pins nothing.
- **A failed photo appears in `_MISSING/`.** Drive the real assembler with one
  presign rejection and assert the entry exists, because "it should be fine" is
  what the collapse defect said too.
- **Browser:** group toggle switches and switches back; every topic sub-section
  header's count equals the tiles under it; the ungrouped count equals the
  remainder; a real download opens and its folder names match the sub-section
  headers.

## 7. Not in scope

- **Grouping by action item** — the data does not exist (§2). Needs an
  extraction-layer link first, which is a backend spec of its own.
- **Room / level as structured fields** — same.
- **Audio and video** — a single recording is far larger than a day of photos;
  a browser-assembled archive is the wrong mechanism and a backend one is a
  different design.
- **Multi-day archives** — §5.3.
- **Captions.** `topic_photos.caption_text` exists and is not measured here. If
  it is populated it belongs in the zip as a per-folder text file; that is a
  small follow-up, and it should be measured before being designed.

## 8. What the first draft got wrong

Fourth spec running to be reviewed, and the failure keeps the same shape: it
described what the data *means* and never checked what the consumer *receives*.

| claim | reality |
|---|---|
| `Ungrouped - 221` carries every photo with no topic | the page's only photo source is `report.topics[].related_photos`, so every photo it holds has a topic **by construction**. That section would have shipped permanently empty. The 221 are a pre-existing invisibility, not a grouping leftover. |
| "frontend only, no backend change" | true of what the spec now builds - but the first draft's own headline section silently required a list-photos endpoint. The scope line was right and the design under it was not. |
| "select all today - the day section's checkbox" | rows are per `(date, user)`; a site manager, the target user, sees several sections per date. No single day section for them, and no single `{user}` for the zip name. |
| topics ordered by first photo time, grouping being "a discard to stop" | the photo object carries **no timestamp**. The key has to be parsed out of the filename, in two formats. |
| `photoKey({folder, date, filename})` | the real signature is `{userDisplayName, date, filename}`; `folderName()` is applied inside `media.js`. Survives by luck, because that function is idempotent. |
| read the archive back with "Node's zlib" | `zlib` has no ZIP-container parser, and a store-only archive has no zlib streams. `unzip` is the second implementation. |

The measurement in section 2 was real; it measured the **lake**. The spec was
written about the **page**. Nothing in a schema or a comment would have caught
that - only following the one array the page actually reads.
