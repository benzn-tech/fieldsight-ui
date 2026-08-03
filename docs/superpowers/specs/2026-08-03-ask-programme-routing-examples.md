# Ask → Programme: routing examples

Date: 2026-08-03
Status: **Revised 2026-08-03 against real query logs. The invented table in
§2 overstated demand for structured queries by roughly an order of magnitude —
read §2.5 before using it.**
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
| 18 | What should I worry about? | **ALERTS** | Re-labelled — see §3.5. It *does* have an implied filter; that filter just is not a WHERE clause. |
| 19 | What's happening tomorrow? | TABLE | Window of one day. |
| 20 | Did anyone mention the drainage? | RAG | Literally a question about whether something was said. |

As first drafted: nine TABLE, eight RAG, three BOTH. **Revised after §2.5 and
§3.5: eight TABLE, eleven RAG, one ALERTS.**

---

## 2.5 What the logs actually say — and what it costs the table above

`lambda_ask_agent.py:959` has been logging every question to CloudWatch all
along. Fifteen real ones, from `/aws/lambda/fieldsight-ask-agent`:

```
what is jack doing?
What was decided?                     (x3)
what this topic is about?
Were any risks flagged?
What happened with the concrete?
What was this training about?
what this topic is talking?
what ip issue was talking?
what happened on 9th feb?             (x2)
does today's door issue relevant with any previous issue?
What were the main action items?
```

**Fourteen are RAG. One — "what is jack doing?" — leans TABLE, and even that
is answerable from the reports.**

§2 above is 9 TABLE / 8 RAG / 3 BOTH. The real distribution is ~14:1. The
invented set overstates demand for structured queries by close to an order of
magnitude, which is exactly the failure mode §5 warned about and did not
avoid.

### The boundary on that evidence

These logs predate Programme being usable. **People do not ask questions
about a programme they do not have.** So this shows what is asked of
*today's* product, not what would be asked once tasks are allocated to
people. It does not falsify the value of a table branch. It does falsify
"needed now".

Two smaller caveats: the prod log group is empty (unused or expired), and
questions are truncated at 200 characters, so long ones lose their tails.

### What follows

Treat §2 as a **hypothesis to be tested, not a requirements list**. Pull the
logs again once Programme has real use, and *replace* it rather than extend
it — a set half-invented and half-observed is worse than either.

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

**BOTH is withdrawn.** The three BOTH rows are re-labelled RAG.

The first draft argued BOTH was "real work", which is not a reason to drop a
feature. The actual reason is that **it couples two failures**. In a combined
answer the table half may be incomplete and the retrieved half irrelevant,
and the reader cannot tell which part to distrust. A single route at least
preserves where the answer came from — and §1's whole principle is to prefer
the recoverable failure. BOTH converts a recoverable failure into an
unrecoverable one.

Revised: **8 TABLE / 12 RAG**, binary router. Revisit only if real programme
usage shows people asking "which *and* why" in one breath.

---

## 3.5 The third route: alerts

#18 *"What should I worry about?"* was first labelled RAG on the grounds that
it is open-ended and implies no filter. **That reasoning is wrong.** It does
imply a filter — the filter simply is not a `WHERE` clause:

- tasks nobody has mentioned in three weeks (shipped, ui#177)
- overdue tasks, blocked tasks
- days behind baseline (`programme-lateness`, shipped)
- delay flags raised by site managers

So there is a third route, and it is neither retrieval nor free-form query:
**hand back the alerts the programme has already computed.** It does not need
to understand the question, only to recognise the class of question and
return a set of existing signals.

**This is the route worth building first**, ahead of the table branch:

1. Every signal already exists and is already tested. No new query surface.
2. It is the only route that answers *"I don't know what to ask"*, which is
   the state a site manager is most often in.
3. It carries no routing downside. Misrouting *into* it shows a screen of
   genuinely useful information; misrouting *out of* it degrades to RAG,
   which is today's behaviour.

Contrast that with the table branch, whose failure mode is a silently
incomplete list.

---

## 4. How to know the router is right

The set above is the test fixture, not a description. Concretely:

- A unit test asserts each question routes to its label. Twenty assertions.
- **An accuracy floor is the wrong acceptance test.** 18/20 sounds fine and
  says nothing about *which* two failed. Getting #1 wrong ships a to-do list
  that silently omits work. So: **every TABLE row must pass**, and RAG rows
  may fall through to RAG's own behaviour today.
- Ambiguity is resolved to RAG, and the answer says which path it took, so a
  wrong route is visible rather than silent.

---

## 5. Open questions — resolved

All four questions from the first draft are now answered, three of them
against evidence rather than judgement. Kept here with their resolutions so
the reasoning is not lost.

1. ~~Are these the questions people actually ask?~~ **Answered: no.** The
   logs exist and say ~14:1 RAG. See §2.5, including why that does not
   settle the question for a programme people can actually use.
2. ~~Is #18 right?~~ **No.** It is a third route — §3.5.
3. ~~Does BOTH earn its complexity?~~ **Withdrawn** — §3, and not for the
   reason the first draft gave.
4. ~~Scope of the table branch.~~ **Narrowed to assignee + window.** The
   four-dimension scope was reverse-engineered from the nine invented TABLE
   rows, which §2.5 shows were overstated — using one's own invented
   requirements to justify a scope is circular. The single log line that
   leans TABLE, *"what is jack doing?"*, needs assignee and a current window
   and nothing else. `GET /programme/tasks?window=…&assignee=me` already
   exists, so two dimensions means this branch needs almost no new backend.
   Add zone and status when a real question asks for them.

## 6. Recommended sequencing

Build §3.5 (alerts) first. Defer the table branch until Programme has real
use and the logs can be pulled again — so that the binary router is decided
on observed questions rather than on the invented ones in §2.
