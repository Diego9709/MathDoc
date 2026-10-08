---
title: CLI commands
---

`mdc` is a client of the [HTTP API](../http-api/): each document and board
command is one or two requests made with your token, and the output is the JSON
response. Only the [proof work](#proof-work) commands keep local state, in a
`.mdc/` directory next to their goal files; it never holds a token.

## Setup

| Environment | Meaning |
| --- | --- |
| `MDC_URL` | Server origin; default `http://127.0.0.1:17843`, or the server a `.mdc/` workspace was created for. |
| `MDC_TOKEN` | Your access token (required). |
| `MDC_PROJECT` | Default `DATABASE/BRANCH` for branch, node and proof commands. |

`-p DATABASE/BRANCH` selects the branch explicitly and overrides `MDC_PROJECT`.
Flags may appear anywhere after `mdc`. From a checkout, run
`node coordinator/dist/cli.js`; in the Docker image `mdc` is on the `PATH`, and
a deployment's `mdc` wrapper (`scripts/mdc-docker` in a checkout) runs it in the
`runtime` container from the host.

Output is pretty-printed JSON on stdout. Exit code 2 means a usage error (the
usage text is printed); 1 means the command failed, with one line of JSON on
stderr: `{"reason": CODE, "status": HTTP_STATUS, "details": TEXT}` (`status` only
for HTTP errors). `mdc -h` prints the command list.

## Server and workspaces

| Command | Behavior |
| --- | --- |
| `mdc status` | `{server, projects}`: every branch you can read, with URL and your role. |
| `mdc init DATABASE` | Create a database with a `main` branch; you become its owner. Admin only. |
| `mdc remove DATABASE` | Delete the database, all branches and history, and its workspace record. Admin only; no prompt. |
| `mdc grant ACTOR owner\|editor\|viewer\|none -p DB/BRANCH` | Set ACTOR's role on that branch (`none` removes it). Owner or admin. |

Roles and their rights are listed in [Workspaces](../../concepts/workspaces/#workspaces-and-roles).

## Branches

| Command | Behavior |
| --- | --- |
| `mdc branch new NAME -p DB/BRANCH` | Fork the selected branch's current head as `DB/NAME`; the new branch copies its role rules. Editor or better. |
| `mdc branch del -p DB/BRANCH` | Delete a branch other than `main`. Owner or admin. |
| `mdc history -p DB/BRANCH` | The latest 50 TerminusDB commits. |
| `mdc export -p DB/BRANCH` | Whole-branch bundle ([Export and restore](../../concepts/import-export/)). |
| `mdc import FILE -p DB/BRANCH` | Load a bundle into an empty branch. Owner or admin. |
| `mdc project latex show -p DB/BRANCH` | `{revision, project}` with the shared macro file and bibliography. |
| `mdc project latex set --preamble FILE --bib FILE -p DB/BRANCH` | Upload both files (`.tex`/`.cls` and `.bib`). |

There is no merge, rebase or checkout command; use TerminusDB directly for those.

## Graph

| Command | Behavior |
| --- | --- |
| `mdc graph check` | Node and edge counts and graph issues. |
| `mdc graph roots` | Unreferenced nodes with depth and component size. |
| `mdc graph full` | All node summaries and index-pair edges. |
| `mdc search QUERY [-n N]` | Case-insensitive title/UUID matches, at most N (default and cap 200). |

See [Graph and metrics](../graph-and-metrics/).

## Nodes

References are exact titles or complete UUIDs.

| Command | Behavior |
| --- | --- |
| `mdc show REF` | The node with `revision`, blocks, dependencies and status. |
| `mdc new -t TITLE [--parent REF]` | Create and return a node; with `--parent`, also add the edge parent → new node in the same commit and return the updated parent (the new UUID is the last entry of its `depens`). |
| `mdc del REF` | Delete the node and every edge to it. |
| `mdc rename REF TITLE` | Change the title; the UUID stays. |
| `mdc edit REF [--type text\|lean\|rocq\|latex]` | Replace or create that block with stdin (default type `lean`). |
| `mdc edit REF --type TYPE --delete` | Delete the block; reads no stdin. |
| `mdc dep …`, `mdc metric ior REF` | See [Dependency commands](../dependency-commands/) and [Graph and metrics](../graph-and-metrics/). |

Every write command accepts `--revision REV`, the revision printed by `show` (for
`new --parent` and `dep` the parent's or source's revision; for
`project latex set` the branch revision from `project latex show`). A stale
revision fails with `412` without writing. Without `--revision` the CLI reads the
current revision immediately before writing.

```sh
mdc show -p myproject/main Lemma            # note "revision"
printf 'Explanation.\n' | mdc edit -p myproject/main Lemma --type text --revision REV
```

## Proofs

| Command | Behavior |
| --- | --- |
| `mdc proof env` | The database's proof environment (`404 environment_not_configured` if unset); `-p` names the database. |
| `mdc proof env set` | Set it from JSON on stdin; owner or admin. A change supersedes the current project board. |
| `mdc proof submit REF [--budget N] [--members a,b]` | Create the database's project rooted at REF (owners; budget default 1000), or attach the branch to the existing one. |
| `mdc proof list [REF]` | The database's project boards you are a member of (current first), and earlier per-branch requests; with REF, those that converted it on this branch. |
| `mdc proof status ID` | The whole project board. |
| `mdc proof command ID` | Send one command (JSON on stdin) at the board's current revision. |

```sh
echo '{"base_key": 1, "context": {"opens": ["Nat"]}}' | mdc proof env set -p myproject/main
mdc proof submit 'Main theorem' -p myproject/main --members bob,agent-1
echo '{"type": "sync"}' | mdc proof command PROJECT_ID
```

`proof command` reads the board first and sends its revision as `If-Match`, with
a fresh `Idempotency-Key`; rerunning the command is therefore a new request, not
a replay. For proving, use the [proof work](#proof-work) commands, which replay
safely; other agents can call the [HTTP API](../agents/) directly. Command types
are listed in [Proofs with LeanGround](../proofs/#commands).

## Proof work

Four commands take one goal of the database's current project from a claim to a
submitted proof or decomposition. They work on a **goal file**, a Lean file that
`mdc pull` writes, and keep its record in `.mdc/` (found in the current directory
or above, like `.git/`).

| Command | Behavior |
| --- | --- |
| `mdc pull GOAL [--branch B] [-o FILE] [--ttl S] [--allocation N] [--with K1,K2] [--no-claim]` | Claim the goal's task (lease of S seconds, default and maximum 3600; N budget units reserved, default 0) and write its goal file, by default `<first 8 digits of the GoalKey>-<conclusion>.lean`. Never overwrites a file (`file_exists`). `--with` adds more goals as available premises; `--no-claim` writes the file without a lease. |
| `mdc prove FILE [--wait] [--dry-run] [--again]` | Submit the file as a complete proof (`has_premises` if a `sorry` premise remains). |
| `mdc split FILE -m DESCRIPTION [--wait] [--dry-run] [--again]` | Submit the file as a decomposition (`no_premises` if none remains). Its new premises become goals of the project, stated automatically. |
| `mdc done [FILE] [--spent N] [--outcome O]` | End the lease, reporting `submitted` if the file was submitted under it and `no_progress` otherwise (or O). Without FILE, the one file holding your lease. |

GOAL is a full GoalKey, a unique prefix of at least 8 hex digits, or the title or
UUID of a converted node on the branch (`-p DATABASE/BRANCH`, or `--branch`).

```sh
mdc pull double_eq -p myproject/main      # writes 3f9a1c2e-double_eq.lean
# edit the proof below the line "-- mdc: edit below this line"
mdc split 3f9a1c2e-double_eq.lean -m "induction on n" --wait
mdc pull 9d02b7c1 -p myproject/main       # a new subgoal, by key prefix
mdc prove 9d02b7c1-double_succ.lean --wait
mdc done 9d02b7c1-double_succ.lean
mdc done                                  # the remaining lease
```

**The goal file.** Above the line `-- mdc: edit below this line` is a read-only
header: the format line `-- mdc-goal-file/1`, the goal, `import` of the base,
the project's context and the registered definitions the statements use, in the
order LeanGround checks them. Changing it fails with `prefix_modified`. Below
the line are the available premises (`theorem … := sorry`, one per line) and the
goal's theorem, whose proof is `sorry`. You may:

- replace the goal's proof; its name and signature must stay
  (`root_missing`, `root_duplicated`, `root_statement_changed`);
- use the available premises by name; those you do not mention are dropped when
  you submit;
- add premises (`theorem name … := sorry`): each becomes a subgoal;
- add proved lemmas and definitions (`def`, `abbrev`, `structure`, …);
  definitions a premise statement mentions are registered with the submission.

The body may not contain `import` or context commands (`context_in_body`),
`example`, `instance`, `namespace`, `#` commands, attributes or `private`
(`unsupported_declaration`); continuation lines must be indented; names must be
unique (`duplicate_name`) and free of `'` (`invalid_name`); a premise may not
state the goal itself (`premise_equals_root`). `--dry-run` prints what would be
submitted without sending it.

**Replays.** Before sending, `mdc` records the submission's idempotency key and
the board revision. If the reply is lost, run the same command again: it resends
the same request, and the server returns the first result instead of running it
twice. If the request never arrived and the board has moved on, the resend is
refused as outdated and a new submission is made. The same file submitted again
reports the earlier submission (`replayed: true`); `--again` sends it anew.
`--wait` waits for the worker and reports the certificate and each new premise
(`--timeout`, default 600 seconds).

**Leases.** Every `pull`, `prove`, `split` and `done` also renews your leases in
the workspace that are past half their time. A lease you let lapse only stops
reserving the task for you: a correct proof submitted later is still recorded.
If someone else holds the task, `pull` names them; `--no-claim` lets you work on
it anyway.
