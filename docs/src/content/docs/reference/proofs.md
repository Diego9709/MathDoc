---
title: Proofs with LeanGround
---

MathDoc stores Lean source; LeanGround checks it. This page covers the proof
environment, how nodes are converted and submitted, what the statuses mean and
how results are written back. The collaboration model (goals, tasks, leases) is
explained in [Collaboration](../../concepts/collaboration/); the request flow for
agents in [Agent interface](../agents/).

## Proof environment

Each database has at most one proof environment, stored in PostgreSQL and shared
by all its branches. It fixes what the project's goals mean:

| Field | Meaning |
| --- | --- |
| `base_key` | Key of a LeanGround base (Lean version and library). MathDoc reads the base from LeanGround's `/v1/bases/<key>` and stores it. |
| `context` | Lines every node's context must equal: `opens`, `local_options` (`set_option …`), `universes`, `variables`. The schema also accepts `raw`, `local_notation`, `local_attrs`; `namespaces` must be empty. |
| `options` | Lean options, a JSON object of string, number or boolean values. |
| `minimum_trust` | `claimed`, `audited` (default) or `trusted`; weaker certificates are ignored. |

```sh
mdc proof env -p myproject/main
cat <<'EOF' | mdc proof env set -p myproject/main
{"base_key": 1, "context": {"opens": ["Nat"]}, "options": {}, "minimum_trust": "audited"}
EOF
```

`-p` only names the database here; any branch selects the same environment.
Reading needs read access on `main`; setting needs owner or admin. The response
adds `base`, `environment_id` (a digest of base, context, options and trust),
`updated_by` and, after a change, `replaces_environment_id`. A database without
an environment of its own uses the one MathDoc stored for its `main` branch
before environments moved to databases.

Changing the environment changes every GoalKey, so it **supersedes** the
current project board: it stays readable but accepts no commands, and the next
submission creates a new board. Setting an earlier environment again revives the
board made in it. Instances and classes cannot be registered;
they must already exist in the base.

## Submitting a branch

**Submit to LeanGround**, `mdc proof submit REF`, or `POST
/api/coordination/projects` ([HTTP API](../http-api/#collaboration)) on a branch
either creates the database's project or attaches the branch to it
([Collaboration](../../concepts/collaboration/#projects-and-branches)):

| Case | Requirements | Response |
| --- | --- | --- |
| No project in the current environment | `owner` on `main` and `editor` on the branch; `REF` is a node with a Lean block (`root_has_no_lean_block`); members are known actors (`unknown_member`) who can read `main` (`member_lacks_document_access`) | `201`, the new board; the worker registers it in LeanGround with its service actor and members, then converts the branch |
| A project exists | `editor` on the branch, membership (`not_a_project_member`), the root node on the branch (`root_not_on_branch`) | `200`, the board; an `attach` job converts the branch from the root node |

Both need a configured environment (`environment_not_configured`). The request's
`Idempotency-Key` makes a retry return the first outcome without another
conversion. A board's `branches` map holds, per attached branch, its `request`
(root node, `bound`, `stale`, `error`, contract), converted `nodes`, `picks` and
`writebacks`.

## Node conversion

The worker collects the root and every node it reaches through dependencies that
have a Lean block; nodes without one are informal, and the walk does not continue
through them. Each Lean block is split into top-level commands and classified:

| Block contents | Treatment |
| --- | --- |
| Only `def`, `abbrev`, `noncomputable def`, `structure`, `inductive` | **Definition node**: registered in LeanGround in dependency order (`define`), giving definition IDs. |
| Exactly one `theorem`/`lemma`, or the metadata `lean_conclusion` names one | **Theorem node**: its statement is resolved to a GoalKey together with the IDs of the definitions it uses. |
| Theorem whose proof is `sorry` | Open goal with a `prove` task; nothing is submitted. |
| Theorem with a proof | Submitted: theorem dependencies become premise placeholders (their statement with proof `sorry`) ahead of the node's declarations. With premises it goes to `lean-worker-sketch` in `sketch` mode, otherwise to `lean-worker` in `leaf` mode. |
| Anything else | Rejected on that node with a reason (below). |

Further rules:

- `import` lines are dropped; dependencies come from graph edges and definition IDs.
- `open`, `set_option`, `universe` and `variable` lines in a node must equal the
  environment context line for line (`local_context_mismatch`).
- A definition node cannot depend on a theorem node.
- The mapping from nodes to definition IDs is kept in the project, not written into
  the document; definition IDs are content-addressed, so registering the same text
  again gives the same ID.

Rejection reasons recorded on a node include `multiple_conclusions`,
`mixed_declarations`, `unsupported_declaration` (`instance`, `class`, `namespace`,
attributes, `open … in`, …), `local_context_mismatch`, `premise_name_collision`,
`definition_name_taken` (a different definition with the same name in this
project, on any branch), `ambiguous_binding` and
`unregistered_statement_definition`. Nodes that depend on a rejected node are
rejected too, with the node named in `details`. LeanGround applies its own source
rules on submission, for example it rejects declaration names containing `'`.

If the root itself is rejected, the branch is not attached: its `request.error`
is `root_<reason>` (also `root_not_on_branch` and `root_statement_differs`). Fix
the node, then submit the branch again.

**Resubmit** (`submit_node` with the branch) re-reads one theorem node from the
branch, resolves it and its premises again and submits its current proof. Use it
after replacing a `sorry` in the document; a node still at `sorry` is rejected
with `open_goal`.

## Statuses

A node's LeanGround certification comes from its own branch's conversion on the
database's current project board; failing that, from the same node with the same
Lean text (and definitions) on another attached branch; failing that, from a
superseded board or a per-branch proof request of earlier MathDoc versions.
`branch` in the status names whose conversion is shown.

| Status | Meaning |
| --- | --- |
| `not_submitted` | The node has a Lean block but no conversion of it applies. |
| `insufficient` | No accepted chain of certificates proves its goal yet. |
| `derivable` | Its goal follows from conditional certificates whose leaves are complete. |
| `certified` | A complete certificate for its goal exists. |
| `stale` | The node's Lean text, or a definition it uses, changed after submission. |
| `rejected` | The converter or LeanGround refused the node; `reason` and `details` say why. |

Nodes without a Lean block have no certification. The local-check dimension is
always `unverified` or `no_code`: MathDoc performs no local checks. Statuses are
derived from project-visible certificates without calling LeanGround's query, so
`truncated` is always `false`.

The worker syncs each ready, current project board about every 15 seconds (and on
`sync`): it rereads known certificates, reads new LeanGround events, drops
certificates that are no longer shared, records expired leases and checks every
attached branch for staleness. A deleted branch is marked stale.

## Commands

Project commands are `POST /api/coordination/projects/<id>/commands` bodies with a
`type`. Commands marked *queued* return `{queued: true}` and are carried out by
the worker; watch `/jobs` or the board. A command naming a `branch` needs read
access to it (`attach`: `editor`). Superseded boards and per-branch proof
requests of earlier versions refuse every command (`project_superseded`,
`proof_request_read_only`).

| Type | Who | Fields | Effect |
| --- | --- | --- | --- |
| `members` | owner | `members` | Replace the member list; queued re-registration in LeanGround. |
| `notes` | member | `notes` | Save free-form project notes. |
| `task` | owner | `goal`, `kind` (`prove`/`decompose`/`formalize`), `priority` | Add a task. |
| `claim` | member | `task`, `allocation`, `ttl` | Take a lease ([Collaboration](../../concepts/collaboration/#tasks-leases-and-budgets)). |
| `heartbeat` | lease holder | `attempt`, `epoch`, `ttl` | Extend the lease. |
| `finish` | lease holder | `attempt`, `epoch`, `spent`, `outcome` | End the attempt. |
| `resolve` | member | `goal`, `proposition`, `definitions` | Queued: give a known GoalKey its statement. |
| `submit` | member | `goal`, `source`, `expected_root`, `component`, `mode`, `definitions`, `new_definitions` | Queued: submit a proof or sketch. |
| `submit_node` | member | `node`, `branch` | Queued: resubmit a theorem node of an attached branch. |
| `attach` | member, `editor` on the branch | `branch` | Queued: convert the branch from the root node (again). |
| `import` | member | `certificate` | Queued: bring a shared certificate into the project. |
| `sync` | member | — | Queued: sync now. |
| `decomposition` | owner | `certificate`, `state` (`active`/`paused`/`retired`) | Change a certificate's state. |
| `pick` | owner | `branch`, `goal`, `certificate` (or `null`) | Set or clear the branch's pick for a goal (`certificate_goal_mismatch`). |
| `assemble` | owner | `component` (`lean-worker`), `branch` | Queued: assemble the branch's route. |
| `retry` | owner | `run` | Queued: retry a failed, retryable assembly with the same plan. |
| `accept` | owner, `editor` on the run's branch | `run` | Queued: write a certified assembly into its branch. |

`component` and `mode` must pair: `lean-worker-sketch` with `sketch`,
`lean-worker` with `leaf` (`component_mode_mismatch`). `goal` may be omitted in
`submit` only when the conclusion uses a definition introduced by
`new_definitions` in the same submission.

## Assembly and writeback

`assemble` selects the branch's route through active certificates, from the root
to complete proofs: at a goal the branch picked, only the picked certificate;
elsewhere, preferring certificates with fewer premises. A route that does not
close fails at once with `no_active_route`. LeanGround combines the route into
one source without premises and checks it from scratch. The run (with its
`branch`) becomes `certified`, or `failed` with a reason and a `retryable` flag.

`accept` builds one writeback batch (`writeback-batch.v1`) for the run's branch,
with that branch's converted nodes; no other branch is written:

1. Every existing node on the route must still have the Lean text it had when it
   was converted; otherwise the batch is `aborted` with `document_conflict` and
   nothing is written.
2. A node whose own text was certified keeps its text and gets metadata only.
   A node proved by a participant gets the certified declarations, keeping its
   `import` and context lines. The conclusion name must survive
   (`public_declaration_renamed` otherwise).
3. Subgoals without a node become new goal nodes titled by their conclusion
   name; definitions without a node become definition nodes with metadata
   `definition_id`. New node UUIDs derive from the batch ID, so replays never
   duplicate them. Edges are added to the providing nodes and definitions.
4. Written Lean blocks get `certification_id`, `certified_lean_sha256` and
   `coordination_operation` (the batch ID); the root's `certification_id` is the
   final assembly certificate.
5. The batch is one TerminusDB commit guarded by the data version it read; a
   concurrent write makes the worker retry and check again. A batch already
   committed is recognized by the root's `coordination_operation`.

`accept` is refused on a stale branch (`proof_request_stale`). A branch is stale
when the Lean text of its root, its direct Lean dependencies or the definitions
those depend on differs from the text when it was converted. Edit deeper nodes,
or submit proofs through the API, to keep a branch usable; changing the root or
its direct dependencies means submitting the branch again. Writeback's own edits
become the new baseline.

## Running LeanGround

The worker calls LeanGround's fact API (`/v1/facts/…`) and `/v1/bases/<key>` with
`LEANGROUND_FACT_TOKEN`; `LEANGROUND_ACTOR` is added to every LeanGround project
the worker registers. Requirements on the LeanGround side are listed in
[Installation](../../getting-started/installation/#requirements). Each project
board is one LeanGround project, with a random ID (`mdc-…`), so definitions and
certificates of all its branches share one scope.
