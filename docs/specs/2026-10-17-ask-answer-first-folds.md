# Ask: answer first, details folded (design)

**Date:** 2026-10-17. **Status:** rev 1, for Fable review.
**Repo:** fieldsight-ui `dev`. **Owner request (2026-10-17, after manual testing):** the record sources and the basis line ("Based on all records you can see · 5 excerpts") go at the END of each reply, not the top. The web details fold into a one-line summary that can be expanded, like Claude's "Ran 6 commands ›".

## 1. What the owner saw (TEST, legacy path, `FS_ASK_WEB_OFFER` on)

Question: "What is the minimum concrete cover for a slab on grade?", account `Ben_Lin_test2`.

**Turn 1, the offer.** The result has `citations: []` and `basis.chunks: 5`, so `formatAnswerBasis` renders "Based on all records you can see · 5 excerpts" above "Your site records don't cover that." The line counts excerpts that the reply neither shows nor uses.

**Turn 2, the button's re-ask.** The result has `from_web: true` and 5 record `citations`. `web.answer` holds the web prose and `answer` holds "Project records do not contain …" plus a condensed copy of the web prose. Top to bottom, it renders as:
1. the basis line;
2. "Sources · 5" record cards (`renderCitations(m.citations, …)` is placed above the web block on purpose, per spec 2026-09-22 "records first");
3. the web status and the "From the open web" label;
4. the full `web.answer`, which differs from `m.text`, so `renderWebOrigin` shows it;
5. the source domains;
6. `m.text`, which carries the same facts a second time.

The reader scrolls past five irrelevant cards and then reads the answer twice.

## 2. Rule

Every assistant message renders in this order:

1. Scope line and "Searched for:" (unchanged position; short, and they change how the answer must be read).
2. **The answer** (`m.text`).
3. The **Search the web** offer button (unchanged).
4. **Web fold** (§3), when the message has web content.
5. **Records fold** (§4), when the message has record citations.
6. The "Ask across everything" button (unchanged).
7. Corroboration (`renderCorroboration`), which moves inside the web fold (§3).

Nothing renders above the answer except item 1.

**This reverses two earlier rulings, and why that is safe now:**
- **2026-08-31, basis line above the answer, "learn the period was empty first".** The answer text now says this itself in its first sentence: it is rule 1 of the v2 judge, and on legacy the widened-basis prompt line in `build_rag_prompt` (`basis.widened`). The line therefore moves into the records fold summary. The one exception is `basis.widened`: then a short line stays above the answer (§4).
- **2026-09-22, records first, web after.** The point of that rule was the union, so that records are never thrown away. The union stays; only the order changes.

## 3. Web fold

Shown when `m.fromWeb`, or when `m.web` has a status line (`webStatusLine(m.web)` non-null), or when `m.corrob` has something to show.

- **Collapsed by default.** It is one row, a real `<button aria-expanded>` with a chevron, which reads:
  - `Checked against 4 web sources · placemakers.co.nz, scribd.com, atlasconcrete.co.nz`: the status text from `webStatusLine`, then up to 3 distinct domains, then `+N`.
  - `Model knowledge — not verified online` when `web.status === 'unverified'`.
  - `Web check unavailable` and the other existing status texts, unchanged.
  - Warn-level statuses keep their warn styling on the summary row, so a failure is visible without expanding.
- **Expanded:** the existing `renderWebOrigin` content (label, `web.answer` when it differs from `m.text`, source links), the conflicts list from `renderWebStatus`, the refused line, and `renderCorroboration`. The order inside is unchanged.
- **Conflicts:** when `web.conflicts` is non-empty, the summary row adds `· 1 conflict` / `· N conflicts`, so a disagreement is never hidden behind a fold.

## 4. Records fold

Shown when `m.citations` is non-empty.

- **Summary row,** a `<button aria-expanded>`. On a grounded answer it reads `Sources · 5 · Based on all records you can see`, reusing `formatAnswerBasis` minus its own excerpt tail; on a `fromWeb` answer it reads `What we found in your records · 5`.
- **Default state:**
  - **expanded** on a grounded records answer, because the inline `[n]` markers point at these cards;
  - **collapsed** on a `fromWeb` answer, because the records were judged not to answer the question.
- **Expanded:** the existing `renderCitations` cards, with the same numbering rules, including the bullet marker on `fromWeb`.
- **No citations, no basis line.** An offer turn, or any turn with `citations: []`, renders no basis line anywhere. This is the turn 1 fix.
- **`basis.widened`:** the existing widened text ("Nothing in the period asked about — based on X instead · N excerpts") still renders above the answer, as today. It is the one case where the reader must know before reading. Its count comes from `citations.length`, not `basis.chunks`, so it never counts excerpts that are not shown.

## 5. Fold state

- **Scope:** per message, in React state keyed by message id; it is not persisted. A new message starts with §3/§4 defaults.
- **Keyboard:** Enter/Space toggle (native button), and focus stays on the row.
- **Reduced motion:** the expand needs no animation. If the chevron rotates, it gets the `prefers-reduced-motion` override.
- **Print:** both folds print expanded, via `@media print`, so a shared or printed answer keeps its sources.

## 6. Out of scope

- Backend shape: no field changes. The duplicated web facts in `m.text` and `web.answer` are handled by the fold. Whether the legacy `compose` should stop restating the web prose is a backend question for later.
- The voice and device channels.
- Prod: lands on `dev`; `main` is the owner's merge.

## 7. Tests (`node --test`)

- **Render order:** for a grounded message, a `fromWeb` message and an offer message, the answer node precedes both folds, and nothing precedes the answer except the scope/asked lines and the widened basis line.
- **Offer turn** (`citations: []`, `basis.chunks: 5`): no basis line, no records fold.
- **Web summary text:** the domain list (distinct, max 3, `+N`); the unverified/failed/too_long texts; the conflict count.
- **Fold defaults:** web collapsed; records expanded when grounded and collapsed when `fromWeb`; the toggle flips `aria-expanded`.
- **Widened:** the line stays above the answer, and its count is `citations.length`.
- **Existing suites:** `ask-web-prose-inside-block`, `ask-web-offer` and the corroboration tests stay green. Edit an assertion only where it pinned the old order, and rewrite it to the new rule rather than deleting it.

## 8. Manual check on dev (owner)

Re-ask the concrete-cover question with the button:
- one answer;
- the web fold is closed and shows its domains;
- "What we found in your records · 5" sits at the bottom, closed;
- turn 1 shows no "5 excerpts".
