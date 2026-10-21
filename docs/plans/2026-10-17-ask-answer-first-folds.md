# Ask answer first, details folded: plan

**Spec:** `docs/specs/2026-10-17-ask-answer-first-folds.md` (rev 2, Fable-reviewed). It is the authority for every rule.

## Global constraints

- No build step.
- BEM `fs-ask-fold__*`, tokens only, dark-mode overrides where warn styling exists.
- `node --check` every edited JS file.
- Run `node --test tests/*.test.js`.
- Stage named files only. Never `git stash`.

## Task 1: fold primitive and records fold

**Files:** `scripts/composites/ask-chat.js`, `styles/composites.css`.

1. Add a small `renderFold({id, summary, level, defaultOpen, body, foldable})` helper. Per message, store the open state in React state keyed by message id (or by row index when the message has no id). The body stays in the DOM with the `hidden` attribute when collapsed. Wire `aria-expanded` and `aria-controls`, and add the print rule.
2. Add the optional `count` argument to `formatAnswerBasis`.
3. Build the records fold (spec §4):
   - its default state follows `m.grounded`;
   - the widened line stays above the answer;
   - with no citations, there is no basis line.
4. Move the records fold below the answer for every message kind.
5. Tests first:
   - render order;
   - the offer turn;
   - widened with `citations: []`;
   - the records defaults, including mixed;
   - the `hidden` attribute.

   Then rewrite the listed old-order assertions (spec §7).

## Task 2: web fold and corroboration fold

**Files:** the same.

1. Web fold (spec §3):
   - the label stays above the answer, the details go in the fold;
   - presence rule, summary precedence, domains (distinct, in source order, max 3, `+N`), conflicts count, refused row, older-backend fallback.
2. Corroboration fold (spec §3a): pending, failed and timed-out show as plain non-foldable rows; otherwise a summary with disagree and not-checked counts. It stays below the citations.
3. Tests per spec §7.

## After both tasks

1. Run the whole suite.
2. Bump the cache busters for the edited files in `app-shell-preview.html` and `components-preview.html` if they load them.
3. Open a PR to `dev` and merge it.
4. Amplify auto-builds `dev`. Verify the build succeeds.
