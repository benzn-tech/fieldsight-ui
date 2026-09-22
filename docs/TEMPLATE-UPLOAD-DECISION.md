# The template upload control: a decision that has not been made

**Status:** open. The wording has been fixed; the control itself has not been touched.
**Raised:** 2026-09-23, after an owner testing on TEST spent his time changing files to find the format the "extraction" liked.

## What the control does today

`scripts/composites/template-upload-modal.js` asks for a file, **requires** one
(`Create template` is disabled until a file is chosen), validates its extension
and size, and then **drops it**.

- it is never read — no `FileReader`, no `.arrayBuffer()`, no `.text()`
- it is never sent — no `FormData`, no `fetch`, nothing in the request body
- there is no backend endpoint that could receive it

The sections a new template starts with come from `STARTING_SECTIONS` in
`scripts/api/template-store.js`, chosen by report type. Four sets: daily,
weekly, monthly, incident. The file has no influence on any of it.

## Why this needs a decision rather than a fix

The copy has been corrected, so nothing on screen claims otherwise any more.
What remains is a control that **demands a document and does nothing with it**.

Two costs, and the second is the one that matters:

1. It is the next misunderstanding waiting to happen. "It asked for my report,
   so it must be using it somehow."
2. **People will assume their file left the building.** These are real reports
   about real client sites. The owner's first question on seeing this was
   whether he could use genuine content. The answer is yes — nothing leaves the
   browser — but a control that takes a file and says nothing is not a good
   place to have to explain that.

## Options

**A — Remove the file picker.** The modal becomes "pick a report type, name it".
Honest, smallest surface, and nothing is lost, because nothing was being used.
Cost: when a real extraction arrives it has to be rebuilt, and anybody who
remembers the control will wonder where it went.

**B — Keep it, make it optional, say plainly that it is not read yet.**
Keeps the shape of the eventual feature. Cost: a control that is present and
inert is exactly what this document is about, and the explanation has to be on
screen forever until the extraction exists.

**C — Keep it exactly as is, with the corrected wording.** Cheapest today.
Cost: it still *requires* a file it discards, which is the worst of both — the
person must produce a document to get past a screen that will ignore it.

## Recommendation

**A.** The control's only current function is to stop people who have no file to
hand, and to raise a privacy question that has no upside to balance it. B is
defensible if a real extraction is close; nothing on the current plan says it
is. C should not survive contact with a second user.

This is a product call. Nobody should remove it on a developer's judgement —
which is why it is written down instead of done.

## Not to be lost with the wording

Real extraction — read an uploaded report and derive its sections — is still a
thing worth building. It needs a backend endpoint, document parsing (`.pdf`,
`.docx` at least) and a model call, which puts it next door to the section
fragment library rather than in this batch.

The risk this file exists to prevent: the copy is now honest, so the pressure
to build the real thing has gone away, and the idea quietly disappears with the
sentence that promised it.
