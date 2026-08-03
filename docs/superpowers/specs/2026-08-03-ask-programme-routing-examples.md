# Ask → Programme: routing examples

Date: 2026-08-03
Status: **Draft for review — this is the input that makes Task 8 startable, not the design**
Scope: prerequisite for Task 8 of `plans/2026-08-03-programme-breakdown-allocation.md`

The breakdown/allocation spec §5.5 recommends a structured branch over
`programme_tasks` alongside `rag-search`, and open question 6 says the router
deserves real examples rather than a guess. This is that set of examples.

**Nothing here should be built until the labels below are agreed.** A wrong
router fails in both directions and both failures are quiet.

---

## 1. Why a router at all

Ask is retrieval-only today: embed the question → `rag-search` → cited
synthesis. There is no tool-calling loop. So a second branch has to be
*chosen* before the request, by looking at the question text.

The cost of each mistake is not symmetric:

- **Programme question sent to RAG** — the answer is incomplete and reads
  confident. `rag-search` defaults to k=8 and clamps to 32, so a person with
  twenty tasks is told about eight of them and has no way to know.
- **Narrative question sent to the table** — the answer is empty or a bare
  list of task names when the person asked *why*. Visibly unhelpful, so they
  rephrase.

**The second failure is recoverable and the first is not.** When the router
is unsure, it should prefer RAG and say what it did, not silently pick.

---

## 2. The labelled set

Twenty questions. `TABLE` = structured query over `programme_tasks`.
`RAG` = existing retrieval. `BOTH` = structured facts plus retrieved
narrative in one answer.

| # | Question | Label | Why |
|---|---|---|---|
| 1 | What am I supposed to do this week? | TABLE | Enumerative and time-bounded. Completeness is the whole answer. |
| 2 | What's on Level 3 next week? | TABLE | Zone + window filter. |
| 3 | What's overdue? | TABLE | Date comparison against today. Embeddings cannot do arithmetic. |
| 4 | Which of my tasks haven't started? | TABLE | Status filter, scoped to assignee. |
| 5 | How many tasks are we behind on? | TABLE | A count. A retrieved sample cannot produce one. |
| 6 | What's Ben working on? | TABLE | Assignee filter. |
| 7 | When does the slab pour finish? | TABLE | One field of one row. |
| 8 | What's left in Foundations? | TABLE | WBS subtree + status. |
| 9 | Show me everything due before the 20th | TABLE | Date bound. |
| 10 | What did we say about the crane last week? | RAG | Site speech. This is what RAG is for. |
| 11 | Why is the slab pour late? | RAG | Causal. The reason lives in what people said, not in a column. |
| 12 | Why did we break the pour into these steps? | RAG | The breakdown rationale — the only thing §5.5 puts into the index. |
| 13 | What did Ben say about the rebar? | RAG | Speech, by speaker. |
| 14 | Any safety issues on Level 2? | RAG | Topic-shaped; already answered well today. |
| 15 | What's blocking us? | **BOTH** | `status='blocked'` gives the list; the reason is in the reports. Table alone answers "which", RAG alone answers "why", and the question wants both. |
| 16 | How's the programme going? | **BOTH** | Overall progress and days-behind are computed; the colour is narrative. |
| 17 | Is Level 3 on track? | **BOTH** | Dates from the table, judgement from the reports. |
| 18 | What should I worry about? | RAG | Open-ended. No filter is implied; forcing it to a table would invent one. |
| 19 | What's happening tomorrow? | TABLE | Window of one day. |
| 20 | Did anyone mention the drainage? | RAG | Literally a question about whether something was said. |

Nine TABLE, eight RAG, three BOTH.

---

## 3. What the labels imply

**A keyword list is not enough.** #11 *"why is the slab pour late"* and #7
*"when does the slab pour finish"* share their only content words. The
distinguishing token is the interrogative — *why* versus *when* — plus
whether the question asks for a set or a reason.

**Three signals do most of the work:**

1. **Interrogative.** *when / what / which / how many / show me* lean TABLE;
   *why / how come / what happened* lean RAG.
2. **A filter the table can express** — a date range, an assignee, a zone, a
   status. If none is present and none is implied, TABLE has nothing to run.
3. **Speech verbs** — *say, said, mention, discuss, raise, tell* — are
   decisive for RAG. #20 is the clean case.

**BOTH is not a hedge.** The three BOTH rows are questions where a
table-only answer would be true and useless. It needs its own prompt that
takes a task list and retrieved passages together, and that is real work —
which is the main reason this document exists before the code.

---

## 4. How to know the router is right

The set above is the test fixture, not a description. Concretely:

- A unit test asserts each question routes to its label. Twenty assertions.
- **An accuracy floor is the wrong acceptance test.** 18/20 sounds fine and
  says nothing about *which* two failed. Getting #1 wrong ships a to-do list
  that silently omits work; getting #18 wrong shows an empty list. So:
  **every TABLE row must pass**, and RAG rows may fall back to BOTH.
- Ambiguity is resolved to RAG, and the answer says which path it took, so a
  wrong route is visible rather than silent.

---

## 5. Open questions for review

1. **Are these the questions people actually ask?** They are written from the
   product conversation and the existing fixtures, not from logs. If Ask has
   query logs, twenty real ones beat twenty invented ones and this table
   should be replaced rather than extended.
2. **Is #18 right?** *"What should I worry about?"* is labelled RAG, but the
   silent-task list (§2, shipped) is arguably the better answer. It may be a
   third route — "the programme's own alerts" — rather than either.
3. **Does BOTH earn its complexity now, or is it a phase 2?** Dropping it
   would make the router a binary decision and the three rows fall to RAG,
   which is the recoverable failure. That is a defensible first cut.
4. **Scope of the table branch.** Assignee, window, zone and status cover
   every TABLE row above. Anything beyond that is speculation until a
   question needs it.
