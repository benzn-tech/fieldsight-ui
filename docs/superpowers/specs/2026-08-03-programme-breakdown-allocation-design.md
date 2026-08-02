# Programme Breakdown, Allocation & Site-Speech Linking — Design

Date: 2026-08-03
Status: Draft — the AI breakdown section needs field validation before build
Scope: Project 3 of 3
Repos: `fieldsight-ui`, `fieldsight-pipeline`

Follows Projects 1 and 2. This is the one that turns an imported programme
into work people can actually be given.

---

## 1. What was asked for

Three things, from the design conversation:

> 有的时候这个 program 是非常 high level，比如说 pour concrete，它不会说很细节，
> 前面的准备工作。我需要用 construction intelligent 的 agent 去做 analysis，
> 给它模拟分析出这些潜在的步骤。

> 可能是按 level 来的，可能是按 area 或者是 Grades to Grades。把一个大的 building
> 分成五块，分给五个不同的 Site Manager。

> 我这些已经转化成了一个 breakdown，其实 breakdown 分给了每个人，就是他自己的
> to do list 对不对？这个要跟他的 to do list 做一个交互。

And, on the existing matcher:

> 它系统识别了，但是我感觉没有和 Programme 里面的内容做上一个对比、做上一个连接。

Four features. The last one is the cheapest and probably the most valuable,
which is why it is specified first.

---

## 2. Matcher visibility — placement, not intelligence

`lambda_programme_matcher.py` already works: site speech → embedding recall →
Claude discrimination → double gate → `programme_progress_suggestions`. The
complaint is not that it misses things. It is that **the result is invisible**.

Today a suggestion lands in a review queue while the programme task itself
shows nothing. You can look straight at `Pour concrete` and have no idea
anyone mentioned it this morning.

Nothing here changes the matcher's algorithm. Three placements:

**On the task.** Inline on the row: *"3/12 Ben on site: 'slab is about half
poured, east side tomorrow' → suggest 50%"*, with accept/reject in place. No
navigation to a queue.

**On the report topic.** *"→ linked to programme: Pour concrete (Level 3)"*,
deep-linking into the Gantt. The person who spoke sees that their words landed
on the plan.

**On the timeline.** A marker on task bars that were mentioned. This one is
the least obvious and the most useful: **tasks with no site mention for weeks
are the ones worth attention**, and that is currently invisible. It is the
only view that answers "what is nobody talking about".

Backend: none. The suggestions table already carries everything; this is
reading it in three more places.

---

## 3. AI breakdown

A client programme says `Pour concrete, 4 weeks`. It does not say formwork,
rebar, inspection, pour, cure. Those are what actually get assigned.

### Shape

- Trigger: explicit, per task. **Never automatic.** A PM asks for it on a task
  they choose.
- Output: **~4 steps, coarse** (the user's instruction: *"稍微粗糙一点"*).
  Names, rough sequence, rough durations summing to the parent's span.
- Every generated row is `origin='local'` under the imported parent — so it is
  ours, it survives re-import, and Project 1's rules already govern it.
- **Nothing is written until the PM accepts.** The proposal is shown, edited
  if wanted, then committed.

### What it must not do

**Not invent dependencies as data.** If the breakdown implies sequence, that
sequence is a *suggestion the PM accepts*, stored as user-authored — the same
rule Project 2 set for inferred dependencies. A generated `depends_on` that
silently feeds CPM would put a fabricated critical path back in through a side
door.

**Not re-plan silently on re-import.** Project 1 built `programme_rebase` for
exactly this: above a 20% parent-duration change the breakdown is flagged
invalidated and the PM is offered a re-plan. Wiring that flag to this feature
is what finally makes `rebase_children` reachable — it has been written and
tested since Plan C and deliberately left uncalled.

### The prompt

One backend Lambda, non-VPC (the matcher's constraint applies: in-VPC has no
egress). Input: task name, duration, dates, the parent WBS path, and the site's
trade context if known. Output: strict JSON, 3–6 steps.

**Deliberately not built yet:** the prompt itself. The user's answer was *"咱们
写一个 prompt 先按，比如说拆个 4 条，稍微粗糙一点"* — which is a starting point,
not a spec. Getting it right needs real programmes to try it against, and a
prompt tuned on invented examples will read plausibly and be wrong in ways
only a builder would notice.

### Cost and failure

- One Claude call per breakdown, on demand — no background fan-out.
- A failed or nonsense response shows an error and writes nothing. There is no
  partial state to clean up because nothing is written before acceptance.

---

## 4. Zone split and allocation

Splitting one contract task into five, one per site manager.

### Data model — already built

Project 1's §5 settled this: the imported row **stays as the client issued
it** (contract dates), and the splits become `origin='local'` children beneath
it. `programme_tasks.zone` is free text (the user's call: Level 3, Grid A-E,
whatever the site uses). `programme_task_assignees` carries the allocation.

So the split needs **no schema change**. It is a UI that creates N local
children, sets their `zone` and assignee, and divides the parent's span.

### Copy-paste

The user asked for quick duplication. The operation is: take a task (or a
task plus its breakdown), duplicate it N times, and set a zone and assignee
per copy. Duplicating a breakdown copies the whole subtree.

Division of dates across copies is a **default, not a decision**: split the
parent's span evenly, then let the PM drag. Guessing that Level 1 takes longer
than Level 5 is exactly the kind of invention this design keeps refusing.

### What it means for rollup

The parent's dates are **not** recomputed from its children (Project 1 §5), so
after a split the contract dates stay put and the internal plan sits beneath
them. If the five zones together run past the contract end, that divergence is
visible — which is the point.

---

## 5. Breakdown → to-do

The user's third ask, and the one that closes the loop.

**No new surface.** A `local` task with an assignee already appears in that
person's **My Work** (Project 1 shipped it: the window endpoint with
`assignee='me'`), and in **Today** when it falls inside the three-day horizon.
A breakdown subtask allocated to a site manager is already on their list the
moment it is created.

What is missing is the other direction: **ticking it off should move the
programme.** A local subtask marked complete rolls up into the imported
parent's progress. Project 1's `PATCH /programme/tasks/{id}` already accepts
`progress_pct` from an assignee, so this is a rollup rule, not a new write
path.

Explicitly deferred: automatic status inference from the daily report's action
items. Project 1's PLAN.md deferred reverse-linking for the same reason it
should stay deferred — *"field-test programme UX first; UX not validated"*.

---

## 6. Order

| # | Piece | Why this order |
|---|---|---|
| 1 | Matcher visibility | No backend, no new model, immediate value. Also the fastest way to learn whether the matcher is actually any good, which everything else assumes. |
| 2 | Zone split + allocation | No schema change. Turns the programme into assignable work — the point of Projects 1–2. |
| 3 | Breakdown → to-do rollup | Small, and completes the loop that makes allocation worth doing. |
| 4 | AI breakdown | Last on purpose. It is the only piece that needs a model, a prompt tuned against real programmes, and field validation to know whether the output is worth accepting. |

Doing 4 first would be building the most speculative thing on the least
evidence.

---

## 7. Open questions

1. **Does the matcher actually match well enough?** Its quality has never been
   observed in use, because the results were invisible. §2 makes it observable.
   If it turns out to be poor, §3's value drops sharply — a breakdown is only
   useful if progress against it can be captured without typing.
2. **Breakdown granularity.** "About 4, coarse" is the stated starting point.
   Whether that survives contact with a real `Pour concrete` is unknown.
3. **Who may run a breakdown?** Currently manager-only would be consistent
   (`_MANAGER_ROLES`), but a site manager breaking down their own allocated
   work is a reasonable thing to want.
4. **Should a zone split copy the breakdown, or breakdown each zone
   separately?** Copying is cheaper and probably right; per-zone breakdown
   would let Level 1 differ from Level 5, which is sometimes real.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Generated steps read as authoritative | Nothing is written before the PM accepts; generated rows are `origin='local'` and visibly ours |
| Generated dependencies feed CPM | Never stored as data; only as a proposal a human accepts, same rule as Project 2 |
| A re-import silently re-plans allocated work | `programme_rebase` flags invalidation above 20%; the PM decides |
| Building the AI piece on invented examples | Ordered last, and the prompt is explicitly not written until there are real programmes to try |
| Matcher turns out to be poor | Surfaced by §2 before §3 is built, which is why §2 is first |
