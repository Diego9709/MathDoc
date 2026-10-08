---
title: Collaboration
---

A database's **project** lets several people and agents prove one theorem
together. Everyone uses the same commands, whether through the browser's
**Collaboration** dialog, `mdc proof command` or the
[HTTP API](../../reference/agents/). LeanGround checks every proof; MathDoc keeps
track of goals, tasks, budgets, which decompositions each branch uses, and what
is written back.

## Projects and branches

A project belongs to one database and proves one theorem, its **root**. Its
**project board** holds everything the participants share: the goals, every
certificate LeanGround accepted for them (complete proofs and decompositions),
tasks, leases and the budget. Each branch of the database is a different way to
the same root: a **route** through the shared goals, together with the branch's
own document (statements, explanations, LaTeX).

A project is fixed by:

- the database's **proof environment**: LeanGround base, context, options and
  minimum trust ([Proofs](../../reference/proofs/#proof-environment));
- the **root node**, the theorem node chosen when the project was created;
- the **owner** (the creator), **members** and a **budget**.

**Submit to LeanGround**, `mdc proof submit REF` or `POST
/api/coordination/projects` on a branch does one of two things:

- If the database has no project in its current environment, it creates one
  rooted at that node. Only the database owner can do this, because it fixes
  the theorem for every branch.
- Otherwise it **attaches** the branch (editors can). The branch must contain
  the root node; every branch is converted from it, whichever node the button
  was pressed on.

Attaching converts the branch: the worker reads the root and every Lean node it
depends on on that branch, registers definition nodes in LeanGround, resolves
theorem statements, and submits nodes that carry a proof. Nodes whose proof is
`sorry` become open goals. The rules are in
[Proofs with LeanGround](../../reference/proofs/#node-conversion). If the root on
the branch resolves to a different statement than the project's root, the branch
is refused (`root_statement_differs`) and nothing of it is submitted. Attaching
again converts the branch anew, for example after editing it.

Until the first conversion finishes, the board is *initializing* and only `sync`
is accepted.

## Goals and GoalKey sharing

A **goal** is a proposition to prove. LeanGround assigns each proposition a
**GoalKey** computed from the statement and its environment; the same statement
gets the same key. Goals are deduplicated by GoalKey across the whole project, so
two nodes, two decompositions or two branches that need the same lemma share one
goal, one set of tasks and every result for it: a lemma proved on one branch is
proved on all of them, without importing anything.

Each goal has a derived status, shared by every branch:

| Status | Meaning |
| --- | --- |
| `insufficient` | No chain of accepted certificates proves it yet. |
| `derivable` | Provable by combining conditional certificates whose leaves are complete proofs. |
| `certified` | A complete certificate (no premises) exists. |

A **conditional certificate** (a *sketch*) proves a goal from premises that are
themselves goals. A cycle of sketches without a complete proof at its leaves
never makes a goal `derivable`.

A goal's status says whether *some* combination of certificates proves it. A
branch's **route** may still be open: see [Routes](#routes-and-picks).

## Tasks, leases and budgets

Every new goal gets a `prove` task; the owner can add `decompose` or `formalize`
tasks. Work on a task follows a lease:

1. `claim` a ready task with an **allocation** (budget reserved) and a lease
   time of 30–3600 seconds (default 300). Only one participant holds a task's
   lease; concurrent claims yield one winner.
2. `heartbeat` extends the lease while working.
3. `finish` reports what was spent (at most the allocation) and an outcome:
   `submitted`, `no_progress`, `execution_failed` or `released`, optionally with
   a [note](#notes). The task becomes ready again.

A lease that expires is recorded at the next state change: the attempt is marked
`expired`, charged its whole reservation, and the task becomes ready. Expiry only
withdraws the right to schedule the task; a proof submitted late is still
accepted if it checks. Claims fail with `budget_exhausted` once spent plus
reserved plus the new allocation would exceed the project budget. Budget units
are whatever the team agrees on; MathDoc only adds up what participants report.

Leases use an epoch: `heartbeat` and `finish` must quote the attempt's `epoch`,
so a participant whose lease was reassigned cannot overwrite the new holder
(`stale_lease`).

## Decompositions

A **decomposition** is a conditional certificate for a goal: its source proves
the goal from new premise statements written as `sorry` theorems, and may
introduce new definitions. LeanGround's sketch component checks that the
premises imply the conclusion, not that the premises are true or easier. New
premises arrive in the project as goals; MathDoc states each from its
placeholder in the sketch, so they can be pulled and proved at once
([New subgoals](../../reference/proofs/#new-subgoals)).

Each certificate has a state. Only `active` certificates count for scheduling and
assembly; tasks can be claimed only for goals reachable from the root through
active certificates (otherwise `inactive_goal`).

| State | Meaning |
| --- | --- |
| `proposed` | A new decomposition waiting for the owner's [review](#review). Recorded, but schedules nothing. |
| `active` | Used for scheduling, routes and assembly. |
| `paused` | Kept aside; can be made active again. |
| `retired` | Not wanted; can still be made active again. |

No state deletes a fact, and no state changes what a goal's status says: a
proposed or paused decomposition can still make its goal `derivable`.

## Review

Checking a proof needs no person: assembly rechecks the whole route. What does
need one is whether a decomposition is worth working on, so on a project board:

- a complete proof is `active` at once;
- a decomposition from a document node (attaching or resubmitting a branch) is
  `active`, because the branch's editors wrote it;
- any other decomposition (an agent's or member's `submit`, an `import`, or one
  found by sync) is `proposed`;
- a decomposition one of whose premises is the goal itself is `retired` on
  arrival, since it can never help.

The owner reviews a proposed decomposition with the `decomposition` command,
setting it `active` or `retired` with an optional comment; in the browser,
**Decompositions** lists them under **Pending review** with each premise's
statement, the description given by the submitter, who submitted it and which
branches' routes can need its goal. The board keeps the last review on the
certificate. The owner can switch a project to `policy` `review: none`, so that
new decompositions are active at once; existing ones keep their state.
Certificates recorded before reviews existed stay active.

## Notes

LeanGround keeps only successful certificates, so what did not work is kept on
the goal instead: anyone working on it can add a **note** (what was tried, where
it got stuck), with the `note` command, with `finish`, with `mdc note`, or in the
browser's **Task board**. Each goal keeps its latest 50 notes of at most 500
characters. `mdc pull` writes the latest 20 into the goal file, and the task board
shows them all.

## Routes and picks

Each branch **picks** decompositions: a map from goals to the certificate its
route uses there. Converting or resubmitting a node records the node's own
certificate as the branch's pick for its goal, so a branch's document is its
route. The owner can change a pick with the `pick` command (in the browser,
**Use on this branch** and **Unpick** in Decompositions).

A branch's route uses the picked certificate at every picked goal, and chooses
automatically elsewhere (active certificates with the fewest premises). The
Collaboration overview shows, per branch, whether its route **closes**, that is,
reaches complete proofs. Two branches can therefore share every proved lemma and
still differ in how they split the root.

## Assembly

When a branch's route closes, the owner **assembles** for that branch: MathDoc
selects the route from the branch's picks and asks LeanGround to combine the
certificates into one source without premises, checked from scratch by
`lean-worker`. A failed assembly marked retryable can be retried with the same
plan; a new route is a new assembly.

## Writeback

Accepting a certified assembly writes its sources back into **the assembly's
branch** as one batch, in a single TerminusDB commit; other branches are not
touched.

- Every existing node on the route must still have the Lean text it had when the
  branch was converted; otherwise the whole batch is `aborted` with
  `document_conflict` and nothing is written. Restore or resubmit, then accept
  again.
- Nodes whose own text was certified get only metadata. Nodes proved elsewhere,
  by a participant or on another branch, get the certified declarations, keeping
  their `import` and context lines; the conclusion's name must stay the same.
- Subgoals from decompositions without a node, and definitions without a node,
  become new nodes with edges to what they use.
- Lean block metadata records `certification_id`, `certified_lean_sha256` and the
  batch ID; the root records the final assembly certificate.

Replaying a batch never creates nodes twice. See
[Proofs with LeanGround](../../reference/proofs/#assembly-and-writeback) for details.

## Staleness

A branch becomes **stale** when a sync finds that the Lean text of its root, a
direct premise or a definition it uses has changed since the branch was
converted. Its results stay in history, but `accept` into that branch is refused
(`proof_request_stale`); submit the root again to convert the branch anew. Other
branches are unaffected. Independently, a node whose text or definitions changed
shows **Changed since submission** instead of Certified. A writeback's own
changes are the new baseline and do not make the branch stale.

A node on a branch that is not attached, or that its branch never converted,
shows the status of the same node on an attached branch when its Lean text and
the definitions it uses are identical there.

## Read-only boards

Two kinds of boards stay readable but accept no commands:

- **Superseded projects.** Changing the database's proof environment changes
  every GoalKey, so the old board is marked superseded (`project_superseded`).
  The next submission creates a new project board in the new environment.
- **Per-branch proof requests** from MathDoc before project boards
  (`proof_request_read_only`). Their node statuses are still shown until a
  project board converts the same nodes.

## Permissions

Collaboration never widens document access:

- The project board is visible to its members who can read the database's
  `main` branch; branches a member cannot read, with their assemblies, are left
  out of what they see. Goals and certificates are shared by the whole project,
  including those that came from such a branch: keep branches that some members
  must not read in a separate database.
- Creating a project needs `owner` on `main`; attaching a branch needs `editor`
  or better on that branch; accepting writes needs `editor` on the assembly's
  branch.
- Every member must be able to read `main`; adding one who cannot fails with
  `member_lacks_document_access`.
- The owner alone changes members, adds tasks, reviews and manages
  decompositions, sets the review policy, picks, assembles, retries and accepts.
  Members claim tasks, submit, resolve, add notes, attach branches they can edit
  and sync.

Changing members revokes the open leases of removed members (charged their
reservation).
