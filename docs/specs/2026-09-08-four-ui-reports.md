# Four UI reports, three of which are not what they look like

**Date:** 2026-09-08
**Status:** design, SECOND draft. Review found six blocking defects; a
seventh was found while verifying the review's own conclusion and is the
reason §1b exists. All are recorded in §8.
**Scope:** frontend only. §2 finds a backend gap and deliberately does not
close it tonight; the reason is in that section.

Four things were reported from the running app. Each was traced to root cause
before any fix was designed, and three turned out to be a different defect
from the one described. One of them is a functional bug that has been in prod
since April.

---

## 1. Ask: the three dots do not move

**Reported:** "静态三个点 … 是否只需要像 claude 一样安排一个 animation?"

**No animation needs to be written.** `composites.css:3527-3548` defines a
staggered bounce (`fs-ask-pending`, 1.1s, `nth-child` delays 0.14s/0.28s),
`ask-chat.js:597-607` renders three dots plus a "Looking through your
records…" label, and prod serves all of it — `curl` of the live
`composites.css` returns the keyframe block verbatim.

### Root cause, measured in the browser on prod

```
prefersReducedMotion    : false      ← the obvious hypothesis, refuted
animationName           : "none"
animationDuration       : "0s"
animationIterationCount : "1"
width                   : "6.99px"   ← from the SAME rule, and it applied
background              : rgb(255,193,7)
```

`none / 0s / 1` are the initial values of the three `animation` longhands.
The declaration is `animation: fs-ask-pending 1.1s var(--easing-in-out)
infinite`, and an undefined `var()` with no fallback makes the whole
shorthand *invalid at computed-value time*, dropping every longhand to its
initial value. `width` and `background` in the same rule survive because they
contain no `var()`.

### It is a typo, not a missing design decision

The first draft proposed inventing two curves. That was wrong. The real
tokens exist:

```
tokens.css:280   --ease-out:    cubic-bezier(0, 0, 0.2, 1);   /* DEFAULT */
tokens.css:281   --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
```

mirrored in `fs-globals.js` as `easing.out` / `easing.inOut`, and used
correctly 17 times in `composites.css` itself. `--easing-out` / `--easing-in-out`
are misspellings of them.

`composites.css:265-271` **already documents the typo**:

> *"`--ease-out` is the real token … many existing call sites in this file …
> reference a nonexistent `--easing-out` instead (existing typo, out of scope
> to fix on those — dropping their transition entirely rather than actually
> breaking anything visible)."*

That parenthesis is the load-bearing error. §1b is what it missed.

### Scale

98 references, in **61 declarations** — 60 `transition:` and **one
`animation:`** — all in `styles/composites.css`. Verified across every file
`app-shell-preview.html` loads, its inline `<style>`, and `tokens.css`'s
`@media` block: `app-shell.css` 0, `components.css` 0, inline 0.

Verified dead against a control:

```
.fs-today__view-report-cta   → transitionProperty "all", duration 0s
.fs-nonexistent-class-xyz    → transitionProperty "all", duration 0s   ← identical
```

An earlier probe of `.fs-library__row` appeared to contradict this — it showed
a live 0.1s transition — but its transition comes from a different rule
carrying no easing token. Checking the exact selector rather than a nearby one
is what separated the two.

None of the 60 is `transition: all`. The Gantt bar carries only `transition:
filter` (`:4908`) and drag sets `transition: none` (`:4983`), so nothing will
fight `programme.js`'s drag. The three `transform` transitions are hover/active
only.

### The change

Two alias lines in `tokens.css`, next to the real tokens:

```css
--easing-out:    var(--ease-out);
--easing-in-out: var(--ease-in-out);
```

Aliases rather than a rename of the 99 call sites, for one concrete reason:
**PR #276 is open against `composites.css`** (§6). A 99-site sed in that file
is a guaranteed conflict; two additive lines in `tokens.css` are not. The
rename is the right cleanup later, on a quiet tree, together with deleting the
two now-stale comments at `:265-271` and `:373-375`.

No `fs-globals.js` mirror edit is needed — these are aliases of tokens the
mirror already carries, not new values.

---

## 1b. The typo is not cosmetic: task check-off has been broken since April

This is the finding the first draft missed and the review only half-found.

`composites.css:596-598`:

```css
.fs-task-card--checking-off {
  animation: fs-task-checkoff 900ms var(--easing-out) forwards;
  pointer-events: none;
}
```

That is the one `animation:` among the 61 dead declarations, and it is not
decoration — it is the trigger for removing the row:

```
task-card.js:177-179   onAnimationEnd() { if (checkingOff && props.onCheckedOff) props.onCheckedOff(task); }
today.js:2185-2187     onCheckedOff → removeMy(task.id)
tasks.js:777           onCheckedOff → ctx.removeRow(t.id)
```

With `animation-name: none` no `animationend` ever fires, so a single
check-off leaves the row on screen — line-through, `pointer-events: none`
(that declaration has no `var()` and does apply), never removed — until the
page remounts. The batch path is unaffected; it calls `removeMy` directly
(`today.js:2141`).

### But fixing the token does NOT fix this, and the review said it would

Two further defects sit on the same path, and both had to be checked rather
than assumed:

**(a) The handler is never attached to any DOM node.** `onAnimationEnd` is
passed to `Card.Body` (`task-card.js:234-235`), and `CardBody`
(`components/card.js:123-131`) reads exactly three props:

```js
function CardBody(props) {
  var className = props.className;
  var style     = props.style;
  var children  = props.children;
  return React.createElement('div', { className: cls, style: style }, children);
}
```

There is no rest spread. `onAnimationEnd` is silently discarded.

**(b) Even if it were attached there, it would be on the wrong node.** The
class that animates is `fs-task-card--checking-off`, applied to the **Card
root** (`task-card.js:201` → `Card`'s `className`), while `Card.Body` renders
a nested `div.fs-card__body` **child**. `animationend` fires on the animating
element and propagates upward; a handler on a descendant can never see it.

`Card` itself *does* forward unknown props — `card.js:38-43` collects
everything outside a `known` list into `rest` and `:72` spreads it onto the
root element. So the fix is to move `onAnimationEnd` from `Card.Body` to
`Card`.

**Both changes are required, and neither alone is observable.** Fixing the
token without moving the handler leaves the row stuck exactly as today, while
now also playing a 900ms fade that ends with `opacity: 0` and
`pointer-events: none` — a row that is invisible, still present, and still
occupying layout. That is strictly worse than the current bug, which is why
this section is a blocker on §1 rather than a note beside it.

Users with `prefers-reduced-motion` have never seen a row vanish either:
their override (`:616-621`) sets `animation: none; opacity: 0`, which hides
the row without removing it.

---

## 2. New project: no thousands separators in Project value

**Reported:** "project value 里面的金额没有 ',' 不方便阅读。"

### The field does not save — in live mode

`NewProjectModal.submit` (`sites.js:332-334`) branches on `orgLive()`:

```js
live ? createOrgSite({ name, location, client, address, latitude, longitude, icon_s3_key })
     : FS.api.sites.createSite(form)
```

The live call drops `project_value_nzd`, `region` and `planned_completion`.
Nor could the backend receive them: `sites` is created by
`migrations/0002_core_relational.sql:20-29` as `(id, company_id, name,
location, client, industry, icon_s3_key, created_at)`, with later ALTERs
adding only `archived_at`, `slug`, `address`, `latitude`, `longitude`. There
is no value or completion column, and `grep -rn project_value src/` in the
pipeline returns nothing.

**In mock mode they are kept.** `api/sites.js:67-83` stores all three onto the
fixture, which is what `portfolio.js:223` and `executive.js:119` then display
— `strategic-aggregator.js:320` says so: *"fixture-only, not in leg-1
payload"*. So the fields are not dead code; they are live in the demo build
and dropped in production. Any "not saved" marking **must be gated on
`orgLive()`**, or the demo build disables controls that work.

`EditProjectModal` never offered the three fields at all
(`sites.js:386-395`), so it is already consistent with the backend.

### What this spec does, and does not

**Does:** thousands-separator formatting on the input. This requires changing
the control — it is currently `<input type="number">` (`sites.js:372` →
`fText(…, 'number')`), and a number input rejects `12,400,000` outright,
sanitising it to empty. It becomes `type="text"` with `inputmode="numeric"`,
formats on change, and strips separators before submit. The mock path does
`Number(input.project_value_nzd)` (`api/sites.js:74`), which turns a formatted
string into `NaN → 0`, so the strip must happen in `submit`, not only on
display.

**Does:** stop the form lying in live mode — the three unsaved controls get a
marker when `orgLive()` is true. See §7.1.

**Does not:** add the columns and the API. That is a migration on the shared
`sites` table while three sessions deploy to prod and test tonight — the
single highest-conflict action available. It is written up as the next piece
of work rather than smuggled in.

### And: what is `location` for?

| | `location` | `address` |
|---|---|---|
| input | free text (`sites.js:364`) | `AddressAutocomplete`, geocoded |
| stored | `sites.location` | `sites.address` + `latitude`/`longitude` |
| read by | the project header line (`sites.js:731`) | the weather coordinate (§4) |

`location` is a **human label** — "Building 2, Riccarton". `address` is a
**machine-resolvable place** yielding lat/lng. Nothing in the form says so, so
they read as duplicates. §4 gives `location` a second, load-bearing job, which
is the clearest possible answer to the question. Both fields get one-line
helper text.

---

## 3. Programme: ctrl+scroll to zoom the Gantt

Nothing is broken; this is a feature. Today zoom is three buttons
(`programme.js:1549-1559`) setting `tier` → `TIER_PIXELS = {day:24, week:6,
month:2}` (`:39`) → `ppd`, which drives `totalWidth`, `GanttStrip` and every
`GanttRow`. The 24→6 jump is 4×, which is why no intermediate scale exists.

### The change

Continuous zoom on ctrl+wheel over the timeline; the tier buttons stay as
presets.

- A `zoom` multiplier in the programme context; effective `ppd =
  TIER_PIXELS[tier] × zoom`, clamped to 2–64 px/day absolute.
- **`GanttStrip` does need to change** — the first draft said it did not.
  `gantt-strip.js:116-131` picks marker density from `tier`, not from
  `pixelsPerDay`: the `day` tier emits one label per calendar day at
  `x = i*ppd`. Zoomed out to 2 px/day that is a label every 2px; zoomed in to
  64 px/day on `month` it is one label per ~1900px. The strip must derive its
  label tier from the **effective ppd**, with thresholds at the `TIER_PIXELS`
  boundaries. Its `isUsableRange` guard is untouched.
- The wheel listener attaches via a ref with `addEventListener('wheel', h,
  { passive: false })` on the `.fs-gantt__timeline` node
  (`composites.css:4848-4852` confirms it is the `overflow-x: auto` scroller;
  the ref goes on `programme.js:1275`). React's `onWheel` cannot reliably
  `preventDefault()`, and without that ctrl+wheel is the browser's own page
  zoom.
- **Anchor at the cursor**, and the naive version does not work. The new
  `totalWidth` (`:1278`) exists only after React commits, so assigning
  `scrollLeft` inside the wheel handler is clamped to the *old* `scrollWidth`
  when zooming in. Store the anchor day in a ref and apply it in a
  `useLayoutEffect` keyed on `ppd`. Compute the pointer offset as
  `clientX - timeline.getBoundingClientRect().left`, **not** `event.offsetX`,
  which is relative to whichever bar happens to be under the pointer.
- **Reset `zoom` inside `setTier`, not in the button handlers.** `setTier` is
  also called at `:1588` by the Overview switch, which would otherwise inherit
  a stale multiplier.
- Trackpad pinch arrives as ctrl+wheel and works for free.

Verified not to break: virtualization is vertical-only
(`programme.js:1054-1118`, `scrollTop`/`ROW_H`); `todayOffset` (`:1041`),
`GanttRow` (`gantt-row.js:107-128`) and drag (`:1157`, deps include `ppd` at
`:1178`) all recompute from `ppd`; there is no horizontal tree↔timeline sync
to desynchronise — the tree is a fixed 240px grid column
(`composites.css:4727-4741`).

---

## 4. Weather: which place is this?

**Reported:** "点开后里面包含了项目 location，方便大家知道这个天气是哪里的。"

**The request understates the problem.** `app-shell.js:332-334`:

```js
const coord = siteCoord || (fixtureSite && fixtureSite.coord) || WEATHER_DEFAULT_COORD;
```

`WEATHER_DEFAULT_COORD` is `{lat:-43.5321, lng:172.6362}` — central
Christchurch (`:212`). A project whose address was never geocoded has NULL
lat/lng, `orgSiteCoordCache[siteId]` resolves to `null` (`:324-326`), and the
panel shows **Christchurch weather labelled as nothing at all**.
`WeatherPopover` (`:502-533`) renders temperature, condition, wind, humidity
and two forecast strips and never names a place; the trigger button's
`title`/`aria-label` (`:473-476`) name none either. So a user in Auckland can
be shown Christchurch's rain with no way to tell.

### The change

**The shell does not currently have the data.** In live mode it holds only
`activeSiteId` (`:281-283`) and `orgSiteCoordCache: site_id → {lat,lng}|null`
(`:319-326`); `getOrgSites` *does* return `name` and `location`
(`repositories/sites.py` `_COLS`) but the shell discards them, and
`fixtureSite` (`:297-300`) is `undefined` for real prod ids. So:

- widen the cache to `{lat, lng, name, location}`,
- pass a `place` prop into `WeatherPopover` (it currently receives only
  `{current, hourly, daily, onClose}` at `:488-493`),
- render a header line in three honest states:

| state | shown |
|---|---|
| site has lat/lng | its `location`, else its `name` |
| site has no coord | `"Christchurch · default location"` |
| no site selected | `"Christchurch · no project selected"` |

and include the place in the popover's `aria-label` (`:510`), which is
currently the generic `'Weather forecast'`.

**Unverified:** whether prod `sites.location` is actually populated. The seed
lambda passes it (`lambda_org_seed.py:94-97`) and org-api stores whatever the
form sent, but any project created with Location blank will fall back to
`name`. The plan's first step is `SELECT name, location FROM sites WHERE
archived_at IS NULL` against prod; if `location` is mostly NULL, the label
should prefer `name` and the §2 helper text matters more, not less.

---

## 5. What this does NOT change

Listed so it is not rediscovered as a new bug. 28 other custom properties are
referenced without ever being defined — `--surface-panelMuted` (16
no-fallback uses), `--text-sm`/`--text-xs`/`--text-lg` (16),
`--surface-hover`/`--raised`/`--subtle`/`--base` (12), `--font-weight-normal`
(1). These are cosmetic fall-throughs — a background that stays transparent,
a font-size that inherits — not dead behaviour. Changing 16 background
colours the night before a hand-test buys nothing.

---

## 6. Conflict surface with the parallel sessions

**Three** open PRs, not two.

| PR | files | overlap with this work |
|---|---|---|
| #274 staffing | `api/org.js`, `pages/team.js` | none |
| #275 ask timeout | `api/_fetch.js`, `api/ask.js`, `composites/ask-chat.js` | none — §1 does not touch `ask-chat.js` |
| #276 projects-not-primary-site | `app-shell-preview.html`, `api/staffing.js`, `pages/team.js`, **`styles/composites.css`** | see below |

Files this work touches: `styles/tokens.css`, `scripts/components/card.js`,
`scripts/composites/task-card.js`, `scripts/pages/sites.js`,
`scripts/pages/programme.js`, `scripts/composites/gantt-strip.js`,
`scripts/app-shell.js`.

**`composites.css` is deliberately not among them** — that is the entire
reason §1 uses aliases in `tokens.css` instead of renaming 99 call sites.
`tokens.css` is additive (two new properties, no existing declaration
changed), so any merge is textual.

If the plan bumps `?v=` on `tokens.css` in `app-shell-preview.html`, that file
is also touched by #276 — textual, one line, but worth ordering after #276
lands if it lands first. Per CLAUDE.md the deployed artifact is stamped by
`amplify.yml` regardless, so the bump only affects local previews.

---

## 7. Open decisions for review

1. **How to mark the three unsaved fields (live mode only).** Disable with a
   hint, annotate with "not saved yet", or remove until the backend lands.
   Recommendation: **disable with a one-line hint** — a disabled control still
   communicates the intent to support it, and removal is the most likely to
   be resented. Must be gated on `orgLive()` (§2).
2. **Whether to ship §1b tonight.** It restores a function that has been
   broken in prod since 2026-04-30 and is two small edits. Against: it changes
   Today/Tasks behaviour the night before a hand-test. Recommendation: ship
   it, because the alternative — shipping §1 alone — actively worsens the bug.

## 8. Hand-test in the morning

| what | where | what to look for |
|---|---|---|
| Ask dots | any page → Ask, send a question | dots bounce in sequence during the wait |
| **task check-off** | Today, and Tasks — check off a **single** item | row fades and is **removed** after ~1s. Batch check-off must be unchanged. This is the highest-risk change |
| **~60 transitions** | hover buttons/rows on Today, Library, Programme | hovers now ease over 100–150ms instead of snapping. App-wide |
| Project value | Sites → New project | types as `12,400,000`; unsaved fields marked (live only) |
| Gantt zoom | Programme → Gantt, ctrl+wheel | day under cursor stays under cursor; labels stay legible at both extremes; no browser page-zoom |
| Weather | header weather button, on a project with an address and one without | names the place; says "default location" when guessing |

## 9. What the review changed

1. **The tokens are typos of existing ones** (`--ease-out` / `--ease-in-out`,
   `tokens.css:280-281`), and `composites.css:265-271` already documents the
   typo. The first draft would have introduced a second, divergent easing
   pair. → §1.
2. **The dead declarations include an `animation:`, not only transitions**,
   and it drives task-card row removal. → §1b.
3. **`<input type="number">` cannot display separators.** → §2.
4. **The mock path keeps the three fields** and feeds the dashboards, so any
   "unsaved" marking must be gated on `orgLive()`. → §2.
5. **`GanttStrip` does need changing** — its label density comes from `tier`,
   not `ppd`. → §3.
6. **The shell has no site name or location to render** — only a coord cache.
   → §4.
7. **There is a third open PR** touching `composites.css`. → §6.

Found while verifying (2), which the review reported as fixed by the token
alone:

8. **The token fix does not restore check-off on its own.** `onAnimationEnd`
   is handed to `Card.Body`, which forwards only `className`/`style`/
   `children`, and the animation runs on the Card **root**, whose events
   cannot reach a descendant handler. Shipping §1 without §1b's handler move
   makes the bug worse, not better — the row would fade to `opacity: 0` and
   remain in layout. → §1b.

Corrections of counts and citations: 98 references sit in **61 declarations**
(60 transitions + 1 animation), all in `composites.css`; the §2 field lines
are `:370,372,373`, not `:368-370`.
