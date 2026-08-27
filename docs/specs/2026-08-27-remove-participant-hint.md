# Remove `participantHint`: it invents an attribution from two unrelated orderings

**Date:** 2026-08-27
**Change:** delete the positional name overlay in `scripts/composites/transcript-list.js`.
**Owner asked for this after hitting it on a real meeting.**

---

## What it does

```js
var participantHint = {};
var participants = props.participants || [];
Object.keys(labelToIdx).forEach(function (label, i) {
  if (participants[i]) participantHint[label] = participants[i];
});
```

`labelToIdx` is keyed in **order of first appearance** in the transcript. `participants` is
the array the extraction model produced, in **whatever order it listed them**. The two are
zipped by index.

Nothing connects them. `spk_0` gets `participants[0]` because both happen to be first in
their own list, and that is the entire basis for putting a person's name against a sentence.

The file already calls it *"a positional guess"* and *"best-effort"*. The reader is not told
that. What renders is a name.

---

## What it did on a real meeting, 2026-08-27

The owner's account of the symptom matched the mechanism exactly: *"有些内容没错，的确是我说的。
但有些不是我说的部分也被放进了 Ben 的名字下面。而有些的确是我说的，却没有被 detect 成我的名字。"*

The backend payload for that session, read directly:

* 318 segments, two labels — `spk_0` (165), `spk_1` (153)
* **zero segments carry `speaker_name`**
* `unmatchedNames` absent — the naming feature is `off` on prod, so nothing server-side wrote
  a name or could have

So every "Ben" on that screen came from this function. Some were right, because a guess
sometimes is.

---

## Why removing beats softening

The obvious alternative is to keep the hint and mark it uncertain — italics, a tooltip, a
"probably". That does not fix the failure. The user's task is **recall**: reading the
transcript to reconstruct who said what. A name that is right two thirds of the time
corrupts recall more thoroughly than no name at all, because there is no way to tell which
third is wrong, and the wrong ones are indistinguishable from memory.

An unnamed transcript says *"we do not know"* and the reader goes and checks. A wrongly
named one says *"Ben said this"* and the reader believes it.

**The apparently safe case is not safe either.** One speaker label plus one participant looks
like a pairing that cannot be wrong — there is only one way to do it. But the label comes from
the provider's diarisation, and this pipeline has recorded it collapsing three people into two
labels and producing label counts that were right while the content was scrambled. A single
label can hold two people, and then the single name is wrong for half of what it covers.

---

## What replaces it

Nothing, for now — `sn.displayLabel(s, ...)` already falls back to the diarisation label, so
removing the hint yields `Speaker 1` / `Speaker 2`, which is what the data supports.

`speaker_name` continues to win where it exists. That path is real: it descends from a human
assertion, propagates by voiceprint agreement, and carries a `speaker_state` that separates
`confirmed` from `tentative`. It is off on prod today, and turning it on is a separate
decision documented in the pipeline repo — but when it arrives it fills exactly this space,
which is the other reason not to invest in making the guess look better.

---

## Scope

One function and its uses (`participantHint` at ~612, `nameHint` at ~694). The precedence
comment at the top of the file (~44) describes `speaker_name` winning over the hint; with the
hint gone, that clause goes with it.

Whatever test asserts the hint's behaviour should be replaced by one asserting the opposite:
that a segment with no `speaker_name` renders the diarisation label and never a participant
name. It is the same test file that would otherwise quietly keep the guess alive.
