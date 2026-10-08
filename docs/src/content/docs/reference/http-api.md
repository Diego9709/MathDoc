---
title: HTTP API
---

One API process serves the editor, the document API and the collaboration API.
The CLI and the browser use the same endpoints.

## Authentication

Every `/api/…` and `/p/DB/BRANCH/api/…` request needs
`Authorization: Bearer TOKEN` with a token from `MDC_ACTORS` or a live
[delegated token](../../concepts/workspaces/#delegated-tokens); otherwise `401`.
Document requests also pass the same-origin check
([Configuration](../configuration/#reverse-proxy)); a rejected Host or Origin
gets `403`. `GET /api/me` returns `{actor, principal, admin, scopes}`; `scopes` is
`null` for one's own token.

| Method and path | Result |
| --- | --- |
| `GET /api/tokens` | Your delegated tokens: `name`, `actor`, `scopes`, `created_at`, `expires_at`, `revoked_at`. |
| `POST /api/tokens` | Body `{name, scopes?, expires_at?}` (`scopes` default `["work"]`; `expires_at` an ISO time in the future). `201 {token, actor, name, scopes, expires_at}`; the token is not shown again. `409 token_name_taken` while a token of that name is not revoked. |
| `DELETE /api/tokens/NAME` | Revoke it; `404` if there is no live token of that name. |

These need one's own token (`403 own_token_required`). A delegated token whose
scopes do not allow an action gets `403 token_scope_required` on collaboration
routes and `403` naming the scope on document routes.

Access to a branch follows the [workspace roles](../../concepts/workspaces/#workspaces-and-roles).
Without read access a branch answers `404 project not found`; with too low a
role, `403`.

## Directory

| Method and path | Result |
| --- | --- |
| `GET /api/status` | `{server: {running, port, url, on_demand: true}, projects}` where `projects` maps each readable `DB/BRANCH` to `{running: true, url, role}`. |
| `GET /api/projects` | The same, plus `nodes` and `edges` for branches already loaded. |
| `POST /api/projects` | A directory action, below. |

| Body | Permission | Effect |
| --- | --- | --- |
| `{"action": "init", "name": DB}` | admin | Create database `DB` with `main`; the caller owns it. |
| `{"action": "remove", "database": DB}` | admin | Delete the database, its history and its workspace record. |
| `{"action": "new_branch", "project": "DB/BRANCH", "name": NEW}` | editor+ on the source | Fork `DB/BRANCH` as `DB/NEW`, copying its role rules. |
| `{"action": "delete_branch", "project": "DB/BRANCH"}` | owner+ | Delete a non-`main` branch. |
| `{"action": "grant", "project": "DB/BRANCH", "actor": A, "role": R}` | owner+ | `R` is `owner`, `editor`, `viewer` or `none`. |
| `{"action": "set_owner", "database": DB, "owner": A}` | admin | Set the workspace owner; creates the workspace record for databases that lack one. |

Unknown fields are rejected. `start` and `stop` are answered with an error:
branches load on demand.

## Branch API

Paths are relative to `/p/DB/BRANCH/api`, for example
`/p/myproject/main/api/graph/check`. Node IDs in paths should be full UUIDs.
Permissions: `GET` needs read (history/export likewise), writes need `editor`,
import needs `owner`.

| Method and path | CLI | Result or behavior |
| --- | --- | --- |
| `GET /graph/check` | `graph check` | Counts and graph issues. |
| `GET /graph/roots` | `graph roots` | Roots with depth and component size. |
| `GET /graph/full` | `graph full` | Node summaries with `lean` (`no_code`/`unverified`) and index-pair edges. |
| `GET /search?q=TEXT&n=N` | `search` | Title/UUID matches; default and cap 200. |
| `GET /resolve?ref=TITLE_OR_UUID` | node commands | `{fnode, title}`. |
| `GET /node/ID/view` | `show` | `{node, referrers, children}`; see below. |
| `POST /node/new` | `new` | Body `{title, parent_fnode?}`; with a parent (guarded by its revision) the edge is added in the same commit and the parent is returned. |
| `DELETE /node/ID` | `del` | `{fnode, deleted: true, removed_edges}`. |
| `PUT /node/ID/title` | `rename` | Body `{title}`. |
| `PUT /node/ID/block/TYPE` | `edit` | Body `{content}`; TYPE is `text`, `lean`, `rocq` or `latex`. Block metadata is kept. |
| `DELETE /node/ID/block/TYPE` | `edit --delete` | Remove the block. |
| `POST /node/ID/dep/add` | `dep add` | Body `{dep_fnode}`. |
| `POST /node/ID/dep/rm` | `dep rm` | Body `{dep_fnodes: [...]}`; one commit. |
| `GET /node/ID/dep?mode=show\|refs\|leaf&depth=D` | `dep show/refs/leaf` | Reachable nodes with `depth`; D is -1 or nonnegative. |
| `GET /node/ID/dep/candidates?q=TEXT&n=N` | `dep candidates` | `{nodes, empty}`; default 50, cap 200. |
| `GET /node/ID/metric/ior` | `metric ior` | Degrees and IOR. |
| `GET /project/latex` | `project latex show` | `{revision, project}`. |
| `PUT /project/latex` | `project latex set` | `{preamble_name, preamble, bibliography_name, bibliography}`, guarded by the branch revision. |
| `GET /project/latex/catalog` | — | Citation and macro completions; `?known=KEY` returns `unchanged`. |
| `GET /node/ID/latex/context` | — | Imports and permitted labels; `?known=KEY` returns `unchanged`. |
| `POST /node/ID/latex/preview` | — | Body `{source}` (max 2 MiB); HTML, labels, diagnostics; nothing is saved. Needs read only. |
| `GET /project/lean`, `PUT /project/lean` | — | Legacy Lean project settings, preserved but unused. `PUT` is guarded by the branch revision. |
| `GET /export` | `export` | `{nodes, project, latex_project}`. |
| `POST /import` | `import` | A bundle into an empty branch; returns the graph report. |
| `GET /history` | `history` | The latest 50 commits. |
| `POST /branches` | — | Body `{name}`; fork this branch (as `new_branch`). |

A node in `view`, `show` and write responses has `fnode`, `title`, `depth`,
`revision`, `depens`, `blocks`, `module` and `formalization`:

```json
{"lean": "unverified", "rocq": "no_code",
 "lean_certification": {"status": "certified", "project": "mdc-…", "goal": "…",
   "minimum_trust": "audited", "checked_at": "2026-09-29T10:00:00.000Z", "truncated": false}}
```

`lean_certification` is `null` without a Lean block, `{"status": "not_submitted"}`
when no project conversion applies to the node, and otherwise one of the
[statuses](../proofs/#statuses), with `branch` (whose conversion is shown) and
`reason`/`details` when rejected or stale.

### Revisions, errors and limits

Node writes (title, blocks, dependencies, deletion, linked creation) need a
quoted `If-Match: "REVISION"` with the node revision; `PUT /project/latex` and
`PUT /project/lean` use the branch revision from their `GET`. Missing: `428`;
stale: `412`. Unlinked creation, import and branch creation take no revision; all
writes still commit against the TerminusDB data version they read.

| Status | Meaning |
| --- | --- |
| 400 | Malformed query. |
| 401 | Missing or unknown token. |
| 403 | Rejected Host/Origin, or role too low. |
| 404 | Unknown node or path, or no read access to the branch. |
| 409 | Nonempty import destination, changed LaTeX context during preview, or a concurrent commit. |
| 412 | Stale revision. |
| 413 | LaTeX source too large. |
| 422 | Invalid body, graph, block type or project settings. |
| 428 | Missing `If-Match`. |
| 502 | TerminusDB unreachable or failed. |

Errors are `{"error": "message"}`. Request bodies are limited to 2,200,000 bytes
(this includes imports); larger or malformed JSON bodies are currently answered
with `500 internal error` rather than a specific status.

## Collaboration

Paths are under `/api/coordination`. Errors are `{"reason": CODE}`, plus
`issues` for invalid bodies and `retryable` for LeanGround failures.

| Method and path | Permission | Behavior |
| --- | --- | --- |
| `GET /environments/DB` | read on `main` | The database's proof environment, or `404 environment_not_configured`. |
| `PUT /environments/DB` | owner+ on `main` | Body `{base_key, context?, options?, minimum_trust?}`. A changed environment supersedes the current project board. |
| `GET /projects` | — | Boards you are a member of. |
| `GET /projects?database=DB&branch=BRANCH[&node=UUID]` | read | The database's project boards (current first, then superseded), then the branch's per-branch proof requests of earlier versions; with `node`, those that converted it on that branch. |
| `POST /projects` | editor+ on the branch | Body `{document: {database, branch, node}, members?, budget, title?}`; header `Idempotency-Key`. Creates the database's project rooted at `node` (`201`, owner+ on `main`) or attaches the branch to it (`200`, members only); the same key and body again returns the first outcome ([Submitting a branch](../proofs/#submitting-a-branch)). |
| `GET /projects/ID` | member, read | The board, without the branches you cannot read. |
| `POST /projects/ID/commands` | member, read | Headers `If-Match: "REVISION"` (or `*` for lease and job commands, [Commands](../proofs/#commands)), `Idempotency-Key`. Returns `{revision, result, job}`. |
| `GET /projects/ID/next[?branch=BRANCH&limit=N]` | member, read (and read on `BRANCH`) | `{revision, candidates}`: free goals worth working on, best first (default 20, at most 500); each with `goal`, `task`, `score`, `branches` needing it, `failures`, `statement` and `negates` ([What to do next](../../concepts/collaboration/#what-to-do-next)). |
| `GET /projects/ID/jobs` | member, read | The latest 100 jobs. |
| `GET /projects/ID/jobs/JOB_ID` | member, read | One job: `kind`, `status` (`queued`, `running`, `done`, `failed`), `tries`, `error` and, when done, `result`. A `submit` job's result is `{certificate, goal, mode, premises}`; each premise has `goal`, its placeholder `name`, `new` (not on the board before) and `statement` (`resolved`, `known`, `identity_mismatch`, `placeholder_not_found` or a LeanGround reason). |
| `GET /projects/ID/history` | member, read | The latest 100 events. |
| `GET /projects/ID/facts/CERT_ID` | member, read | A certificate of this project, with source, from LeanGround. |
| `GET /projects/ID/nodes/UUID/draft?branch=BRANCH` | member, read on the branch | Submission draft for a theorem node of an attached branch ([Agent interface](../agents/#3-get-the-draft)). |
| `GET /projects/ID/goals/KEY/draft?branch=BRANCH[&with=KEY,…]` | member, read (and read on `BRANCH`) | The material of a goal file (`mdc pull`) for any goal with a statement: `root` (`name`, `binders`, `type`, `definitions`, and `from`: `node` for an unchanged converted node of `BRANCH`, `declaration` for the declaration recorded on the board, `proposition` for a bare resolved proposition), available `premises` (the node's premise nodes, then the `with` goals), `definitions` (`id`, `name`, `source`, dependencies first), `root_module`, `context`, `options`, `environment_id`, `revision`, `notes` and the goal's prove `task` with its lease. `409 goal_unresolved` for a goal without a statement. |

For a project board, "read" means read access on the database's `main` branch;
for a per-branch proof request, on its branch. Others get `404 not_found`.
Command bodies and their permissions are listed in
[Proofs with LeanGround](../proofs/#commands).

Some routes serve the archived prototype's projects created from a raw
proposition (admin-only `POST /projects` bodies without `document`, and
`GET /documents`, `/projects/ID/documents`, `/document-history`, `/branches`).
The editor does not use them.
