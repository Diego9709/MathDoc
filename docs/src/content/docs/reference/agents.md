---
title: Agent interface
---

Agents use the same HTTP API and commands as people. An agent acts with a
token: best a [delegated token](../../concepts/workspaces/#delegated-tokens) of
the person running it (`mdc token new codex-1`, acting as `you/codex-1` with the
`work` scope), or an actor of its own in `MDC_ACTORS`. Either way it needs a role
on the database's branches (at least `viewer` on `main` to work on tasks,
`editor` on a branch to attach it or edit its documents) and membership in the
database's project
([Collaboration](../../concepts/collaboration/#projects-and-branches)); a
delegated token has its person's. This page
shows the request flow; placeholders are in capitals and no value here is a real
token.

## With `mdc`

An agent that can run commands needs only four:
`mdc pull GOAL`, `mdc split FILE -m DESCRIPTION`, `mdc prove FILE` and `mdc done`
([Proof work](../workspace-commands/#proof-work)). They claim and renew leases,
write a goal file with the project's context, definitions and the goal's notes,
check it locally, and make every submission safe to rerun after a lost reply.
`mdc note` (or `mdc done --note`) leaves what you learned for the next agent.
Chat clients without a shell use the same verbs as tools of `mdc mcp`
([MCP](../workspace-commands/#mcp)). The rest of this page is the HTTP flow
underneath, for agents that call the API directly.

## Conventions

```sh
export MDC=http://127.0.0.1:17843        # or your proxy's public origin
export AUTH="Authorization: Bearer YOUR_TOKEN"
P=$MDC/api/coordination/projects/PROJECT_ID
```

- Every request needs `Authorization: Bearer TOKEN`. Requests from a browser
  context must also be same-origin; plain HTTP clients send no `Origin` and pass.
- Each command is a `POST $P/commands` with `If-Match: "REVISION"` (the board's
  current `revision`, quoted) and `Idempotency-Key: KEY` (1–200 characters).
  Resending the same key with the same body returns the first response without
  running the command again; the same key with a different body or revision fails
  with `idempotency_conflict`. Use a new key for each new intent.
- A command made against an old revision fails with `409 revision_conflict`:
  read the board again and decide again.
- The response is `{revision, result, job}`. `job` is set for queued commands;
  their effect appears on the board after the worker runs, and failures appear in
  `GET $P/jobs` with an `error` code.
- Errors are `{reason}` (plus `issues` for invalid bodies, `retryable` for
  LeanGround failures).

## 1. Find work

```sh
curl -s -H "$AUTH" "$MDC/api/coordination/projects?database=DB&branch=BRANCH"
curl -s -H "$AUTH" "$P"
```

The first board in the list is the database's current project. It lists `goals`
(key, statement, `status`), `tasks` (`state` `ready` or `leased`), `attempts`,
`facts`, `branches` (per attached branch: `request`, `nodes` with each converted
document node's `goal`, `role`, `state`, and `picks`) and `revision`. Goals and
tasks are shared by all branches. Pick a `ready` task whose goal is not
`certified`.

## 2. Claim

```sh
curl -s -X POST "$P/commands" -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'If-Match: "REVISION"' -H 'Idempotency-Key: claim-TASK_ID-1' \
  -d '{"type":"claim","task":"TASK_ID","allocation":100,"ttl":300}'
```

`result` is the attempt: keep its `id` and `epoch`. Only one claimant wins a
task. While working, extend the lease before it expires:

```sh
curl -s -X POST "$P/commands" -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'If-Match: "REVISION"' -H 'Idempotency-Key: hb-ATTEMPT_ID-1' \
  -d '{"type":"heartbeat","attempt":"ATTEMPT_ID","epoch":EPOCH,"ttl":300}'
```

`stale_lease` means the lease expired or passed to someone else: stop scheduling
work on it. A proof you still submit is accepted if it checks.

## 3. Get the draft

For a goal that belongs to a document node of a branch (see
`branches.BRANCH.nodes`):

```sh
curl -s -H "$AUTH" "$P/nodes/NODE_UUID/draft?branch=BRANCH"
```

The draft has `goal` (the GoalKey), `proposition`, `premises` (node, name,
goal), `definitions` (definition IDs), `source` (premise placeholders followed by
the node's declarations), `expected_root`, `component` and `mode`. Replace the
conclusion's `sorry` in `source` with a proof. You may use the premises by name.
A different split is also allowed: add new `sorry` theorems as premises (a
sketch), or define new functions and list their names in `new_definitions`.

## 4. Submit

```sh
curl -s -X POST "$P/commands" -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'If-Match: "REVISION"' -H 'Idempotency-Key: submit-TASK_ID-1' \
  -d @- <<'EOF'
{"type": "submit",
 "goal": "GOAL_KEY",
 "source": "theorem helper (n : Nat) : n + 0 = n := sorry\ntheorem main_thm (n : Nat) : n + 0 + 0 = n := by rw [helper, helper]\n",
 "expected_root": "main_thm",
 "component": "lean-worker-sketch",
 "mode": "sketch",
 "definitions": ["DEFINITION_ID"],
 "new_definitions": [],
 "description": "reduce to helper twice"}
EOF
```

Use `lean-worker` with `leaf` for a proof without `sorry` premises and
`lean-worker-sketch` with `sketch` otherwise. `definitions` lists the definition
IDs the source uses (take them from the draft). `description` is optional and
says what a decomposition does; the owner sees it when reviewing. A sketch is
`proposed` until the owner activates it ([Review](../../concepts/collaboration/#review)),
so its new subgoals cannot be claimed before that. The worker submits to LeanGround and, if the
certificate is accepted, adds it to the board's `facts`; goal statuses update
accordingly. Keep the idempotency key and revision until you have the reply: if
it is lost, resend the same request with both, and you get the first result.

## 5. Finish

```sh
curl -s -X POST "$P/commands" -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'If-Match: "REVISION"' -H 'Idempotency-Key: finish-ATTEMPT_ID' \
  -d '{"type":"finish","attempt":"ATTEMPT_ID","epoch":EPOCH,"spent":40,"outcome":"submitted"}'
```

`spent` may not exceed the allocation; `outcome` is `submitted`, `no_progress`,
`execution_failed` or `released`. Add `"note": "…"` to keep what you learned on
the goal (or send `{"type": "note", "goal": GOAL_KEY, "text": "…"}` at any time). The task becomes ready again, for the next
attempt or for others, until its goal is certified.

## New subgoals

A sketch introduces premises that LeanGround knows only by GoalKey. They appear
on the board as goals with a `prove` task each, and the `submit` job states each
new one from its placeholder in the sketch
([New subgoals](../proofs/#new-subgoals)): the goal gets an `identity` and a
`declaration`. The job's `result` (`GET $P/jobs/JOB_ID`) lists every premise with
its name and whether its statement was `resolved`, and the sketch's `state`: a
`proposed` sketch's subgoals cannot be claimed (`inactive_goal`) until the owner
activates it.

To prove one, get its goal draft, which works for any goal with a statement, not
only for document nodes:

```sh
curl -s -H "$AUTH" "$P/goals/GOAL_KEY/draft?branch=BRANCH"
```

It has the conclusion's `name`, `binders` and `type`, the `definitions` with
their source, the context, and the goal's `task`. Write
`theorem NAME BINDERS : TYPE := PROOF`, claim the task and submit it with that
`goal` and the definition IDs.

If a premise could not be stated (its `statement` in the job result is not
`resolved` or `known`), resolve it yourself:

```sh
curl -s -X POST "$P/commands" -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'If-Match: "REVISION"' -H 'Idempotency-Key: resolve-GOAL_KEY' \
  -d '{"type":"resolve","goal":"GOAL_KEY","proposition":"∀ (n : Nat), n + 0 = n","definitions":[]}'
```

The worker computes the GoalKey of the proposition in the project environment
(with the given definition IDs) and records the statement only if it equals
`GOAL_KEY` (otherwise the job fails with `identity_mismatch`).

## Other reads

| Request | Returns |
| --- | --- |
| `GET $P/jobs` | The latest 100 jobs: kind, status, tries, error, result. |
| `GET $P/jobs/JOB_ID` | One job, with its `result` when done. |
| `GET $P/goals/GOAL_KEY/draft?branch=BRANCH` | A goal's statement, definitions, context and task. |
| `GET $P/history` | The latest 100 board events: actor, kind, revision. |
| `GET $P/facts/CERTIFICATE_ID` | A certificate of this project, with source. |
| `GET /api/me` | `{actor, admin}` for your token. |

Assembly, pausing and picking decompositions and accepting results are owner
commands; see [Proofs with LeanGround](../proofs/#commands).
