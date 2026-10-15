# Ask: answer first, details folded (design)

**Date:** 2026-10-17. **Status:** rev 2, after Fable review of rev 1 (APPROVE WITH CHANGES; §9 maps each finding to its fix).
**Repo:** fieldsight-ui `dev`.
**Owner request (2026-10-17, after manual testing):** the record sources and the basis line ("Based on all records you can see · 5 excerpts") go at the END of each reply, not the top. The web details fold into a one-line summary that can be expanded, like Claude's "Ran 6 commands ›".

## 1. What the owner saw (TEST, legacy path, `FS_ASK_WEB_OFFER` on)

Question: "What is the minimum concrete cover for a slab on grade?", account `Ben_Lin_test2`.

**Turn 1, the offer.** The result has `citations: []` and `basis.chunks: 5`. `formatAnswerBasis` renders "Based on all records you can see · 5 excerpts" above "Your site records don't cover that." The line counts excerpts that the reply neither shows nor uses.

**Turn 2, the button's re-ask.** The result has `from_web: true` **and** `grounded: true` (`web.kind: "mixed"`), with 5 record `citations`. `answer` opens "Project records do not contain …", carries inline `[1]…[5]` pointing at the record cards, and restates the web facts. `web.answer` holds the full web prose. Top to bottom it renders:
1. the basis line;
2. "Sources · 5", numbered record cards (`renderCitations(m.citations, !m.grounded)`, above the web block per spec 2026-09-22);
3. the web status and "From the open web" label;
4. the full `web.answer` (it differs from `m.text`, so `renderWebOrigin` shows it);
5. the source domains;
6. `m.text`.

The reader scrolls past five cards before any answer, and then reads the web facts twice.

## 2. Rule

Every assistant message renders in this order:

1. **Above the answer**, only one-line context that changes how the answer must be read:
   - the scope line and "Searched for:" (unchanged);
   - the widened basis line (§4);
   - when `m.fromWeb`, the one-line provenance label (`fs-ask-web__label`: "From the open web — not from your recordings", or "Model knowledge — not verified online"). It stays above the answer, per the ruling pinned in `tests/ask-says-when-it-came-from-the-web.test.js` ("a caveat reached after three sentences has already been read past").
2. **The answer** (`m.text`).
3. The **Search the web** offer button (unchanged).
4. **Records fold** (§4).
5. **Web fold** (§3).
6. The "Ask across everything" button (unchanged).
7. **Corroboration fold** (§3a). It stays below the citations, per the existing comment ("citations point back into the customer's recordings, this points out of them").

**Rulings this reverses, and why that is safe:**
- **2026-08-31 (basis line above the answer).** The answer's first sentence now says it: v2 judge rule 1, and on legacy the widened prompt line in `build_rag_prompt`. The one case where the reader must know first, `basis.widened`, keeps its line above (§4).
- **2026-09-22 (records first, web after).** The point of that rule was the union, so records are never discarded. The union stays; only the position moves below the answer.

## 3. Web fold

**Shown when** any of these is true:
- `m.fromWeb`;
- `webStatusLine(m.web)` is non-null;
- `m.web.conflicts` is non-empty;
- `m.web.refused`.

**Collapsed by default.** The row is a native `<button aria-expanded aria-controls>` with a chevron. The summary text, in order of precedence:

| Case | Summary text |
|---|---|
| `web.refused` with no `status` | the refused sentence itself. It is short, and a guard must not read as an outage, so the refusal is never hidden. |
| A status line exists | `webStatusLine` text (e.g. "Checked against 4 web sources"), then ` · ` and the first 3 distinct `sourceDomain(s)` values **in source order**, then `+N` for the rest. Warn-level statuses keep their warn class on the row, including the existing dark-mode override. |
| No status line, `fromWeb` (older backend) | `From the open web · N sources · <domains>` |
| `web.conflicts` non-empty | append ` · 1 conflict` / ` · N conflicts` |

**Expanded:** `web.answer` when it differs from `m.text` (the existing rule), the conflicts list, the refused line, and the source links. This is the content of `renderWebOrigin` and `renderWebStatus` minus the label, which now sits above the answer.

## 3a. Corroboration fold

**Shown when** any of these is true:
- `m.corrob._pending`;
- `m.corrob._failed`;
- `!hasNothingToShow(m.corrob)`.

Corroboration runs only on a non-`fromWeb` answer, so it has its own fold and summary.

**Summary text:**

| Case | Summary text |
|---|---|
| `_pending` | `Checking the web…` (not foldable; it shows as today) |
| `_failed` | `Web check unavailable` (not foldable) |
| `timed_out` | `Web check timed out` (not foldable) |
| otherwise | `Checked on the web · N claims` |

The "otherwise" text is followed by:
- ` · K disagree` when any item's state is the conflicts state (`CORROB_STATE`);
- ` · M not checked` when anything was truncated or `dropped`.

A row that only carries a status is a plain line, not a button. **Expanded** shows today's `renderCorroboration` body, unchanged.

## 4. Records fold

**Shown when** `m.citations` is non-empty.

**Summary row** (`<button aria-expanded aria-controls>`):
- When `m.grounded`: `Sources · 5 · Based on all records you can see`. The basis part is `formatAnswerBasis(m.basis, m.zh, countOverride)` with its own excerpt tail omitted.
- When not grounded: `What we found in your records · 5`.
- Chinese variants: the same structure, built with the existing zh strings. "Sources" stays English, as it is today.

**Default state** follows `m.grounded`, not `m.fromWeb`. A `mixed` web answer cites the cards inline.

| | Default | Cards |
|---|---|---|
| `m.grounded` | **expanded** | numbered `[n]`, as today |
| not grounded | **collapsed** | bullets, as today |

**Basis line rules:**
- **No citations, no basis line**, except the widened case below. This fixes turn 1.
- **`basis.widened`** always renders its line above the answer, even with `citations: []`, because that is the case where the reader must know first. Its count tail is the shown-citation count; the tail is omitted when that count is 0.
- **Count:** `formatAnswerBasis` keeps its `(basis, zh)` signature and gains an optional third argument, `count`. When given, the count replaces `basis.chunks` in the tail; when absent, today's output is unchanged. `tests/ask-timezone-and-basis.test.js` keeps passing `m.zh` on every call.

**Mixed answers:** the backend numbering those cards in a `mixed` answer is why they open by default here. Whether `mixed` answers should cite records at all is a backend question (§6).

## 5. Fold mechanics

- **State:** per message, in React state keyed by message id. Error rows carry no id, so the plan guards for that, falling back to the row index. Nothing is persisted, and a new message starts with the defaults above.
- **Collapsed body:** stays in the DOM with the `hidden` attribute, not removed and not visually hidden. Citation cards are `role=button tabIndex=0`, and `hidden` takes them out of the tab order.
- **Accessibility:** `aria-controls` points at the body id. Enter and Space toggle via the native button.
- **Print:** `@media print { .fs-ask-fold__body[hidden] { display: block } }`, so a printed answer keeps its sources.
- **Reduced motion:** there is no expand animation. A chevron rotation gets the `prefers-reduced-motion` override.
- **Tokens:**
  - semantic tokens only (`--text-*`, `--surface-*`, `--border-*`);
  - no palette-scale token on any new foreground;
  - the existing `--color-accent-600` on the records label is left as it is and not copied.
- **Mounts:** both live AskChat mounts get this, since they are the same component:
  - the timeline dock (`timeline.js:1355`);
  - the search palette (`search-palette.js:514`, `--compact`, `max-height: 480px`).

  The palette has to be checked by eye with a default-expanded fold of 5 cards.

## 6. Out of scope

- **Backend shape:** no field changes.
  - The legacy `compose` restating the web prose in `answer` is a backend follow-up.
  - So is whether a `mixed` answer should number its record cards.
- The voice and device channels.
- **Prod:** this lands on `dev`; `main` is the owner's merge.

## 7. Tests (`node --test`)

**New:**
- **Render order:** for a grounded message, a grounded + fromWeb (mixed) message, a not-grounded fromWeb message, an offer message and a corroboration message:
  - the answer node precedes every fold;
  - above the answer, only the scope/asked lines, the widened line and the provenance label.
- **Offer turn** (`citations: []`, `basis.chunks: 5`): no basis line, no records fold.
- **Widened with `citations: []`:** the line renders above the answer with no count tail.
- **Web summary text:**
  - domains: distinct, in source order, max 3, `+N`;
  - the unverified, failed, too_long and refused texts;
  - the older-backend fallback;
  - the conflict count.
- **Corroboration summary:**
  - pending, failed and timed_out are not foldable;
  - "· K disagree" and "· M not checked".
- **Fold defaults:**
  - web collapsed;
  - records expanded when `grounded` (including mixed) and collapsed when not;
  - the toggle flips `aria-expanded`;
  - a collapsed body has the `hidden` attribute and stays in the DOM.

**Rewritten to the new rule** (an intended reversal: rewrite the assertion, do not delete the test):
- `ask-says-when-it-came-from-the-web.test.js:187-199`: records now come after the answer. The label-above-the-answer assertion at `:25-36` stays as it is.
- `ask-timezone-and-basis.test.js:153-163`: the basis line now precedes the answer only when widened.
- `ask-timezone-and-basis.test.js:186-233`: exact strings stay; add the `count` cases.
- `ask-web-status-line.test.js:78`: keep the `!m.grounded` numbering contract wherever the call moves.

**Must stay green unchanged:** `ask-web-prose-inside-block`, `ask-web-offer`, the corroboration suites. The baseline is 201/201 ask suites.

## 8. Manual check on dev (owner)

Re-ask the concrete-cover question with the button:
- the provenance line, then the answer, once;
- the records fold below the answer, open with numbered cards, because this is a mixed answer that cites them;
- the web fold closed, reading "Checked against 4 web sources · placemakers.co.nz, scribd.com, …";
- turn 1 shows no "5 excerpts".

Then ask a project question, e.g. "What did we do yesterday?": the answer first, then the sources, open.

## 9. Rev 1 review (Fable) → rev 2

| Finding | Fix |
|---|---|
| B1 the real turn is grounded + fromWeb with inline [n] | §4: defaults and labels keyed on `m.grounded`; §1/§8 corrected |
| M2 the provenance label ruling was reversed silently | §2: the label stays above the answer |
| M3 corroboration and refused states hidden by a fold | §3 refused row; §3a own fold, non-foldable failure rows; order kept below citations |
| M4 widened vs no-citations; count source | §4: widened wins; optional `count` argument; suite listed in §7 |
| m5 older-backend summary | §3 fallback row |
| m6 domain order | §3: first 3 in source order |
| m7 print and tab order | §5: `hidden` attribute, print rule |
| m8 zh | §4 |
| m9 error rows without id | §5 |
| m10 palette mount | §5 |
| m11 dark mode and tokens | §3, §5 |
