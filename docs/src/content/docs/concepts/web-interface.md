---
title: Web interface
---

## Sign in

The API process serves the editor at `/`. On load the page checks the stored
token against `/api/me`; without a valid one it asks for an **access token**,
which it then keeps in this browser's `localStorage`. Any later `401` response
clears it and returns to the sign-in page. A delegated token works too; the page
then acts as `PERSON/NAME` within the token's scopes. Use a private browser
profile on shared machines.

## Project directory

The root page lists the branches you can read, grouped by database, with your
role on each and node/edge counts for branches already loaded by the server. It
refreshes every five seconds and filters by name. **Init project**
(administrators) and **New branch** (on any row) ask for a name; branch deletion
(not for `main`) and **Delete project** ask for confirmation. The server enforces
the role required for each. Branches load on demand, so there are no start or stop
controls. Workspace roles are managed with `mdc grant`; there is no role editor
in the browser.

## Editor

`/p/DATABASE/BRANCH/` opens the editor for one branch, at the node named by
`#ref=TITLE_OR_UUID` (with `&label=LABEL`, at that LaTeX label in Preview) or
else at the deepest root. The MathDoc logo returns to the directory; unsaved
drafts ask for confirmation.

| Toolbar control | Action |
| --- | --- |
| **Search nodes** (`/`) | Find a node by title or UUID. |
| **Back**, **Forward** | Move through the visited nodes (browser history). |
| **Create node** | A new node with a title only. |
| **Add dependency**, **Remove dependency** | Edit the current node's direct dependencies. |
| **Delete node** | Delete the node and every edge pointing to it, after confirmation. |
| **Knowledge**, **Graph** (`g`) | Switch between the column view and the graph view. |
| **Collaboration** | The project board dialog ([below](#collaboration-dialog)). |
| **Project settings** | Proof environment and LaTeX settings ([below](#lean-nodes-and-leanground)). |
| **Refresh database view** | Reload the current node and the branch's node and edge counts. |

The Knowledge view shows the node between its **Referrers** and
**Dependencies**; each entry shows its depth and Lean and Rocq lights, and each
column has a filter. Click the node title to rename it. The Graph view lays
nodes out by depth; there the editor takes 3/8 of the width and the graph 5/8.
Narrow screens stack graph and editor and hide the columns. Switching views keeps
unsaved edits. The status bar shows the current node and the branch's node and
edge counts.

All block types use Monaco editors with the same controls (**Save**, also
Ctrl/⌘+S; collapse; **Delete block**), fonts and light/dark themes; **Add source
block** adds a missing type. Lean blocks are plain source editors with syntax
highlighting. LaTeX blocks add Edit/Preview, reference and citation completion
and clickable cross-node references ([LaTeX](../latex/)).

## Node status

Each node shows a Lean and a Rocq status light. For Lean the light and label
come from LeanGround certification when the node has a Lean block:

| Label | Meaning |
| --- | --- |
| No code | No Lean block. |
| Not submitted to LeanGround | No conversion of the node on the database's project. |
| Insufficient evidence | Submitted; no accepted proof yet. |
| Derivable | Follows from certified results through conditional certificates, not yet assembled. |
| Certified | A certificate without open premises exists. |
| Changed since submission | The Lean text, or a definition it uses, changed after submission. |
| Not accepted | The converter or LeanGround rejected the node; the reason is shown. |

The graph view colors nodes only by whether they have Lean code (gray: none,
yellow: Lean block present) and counts each kind; certification is shown on
node cards and in the node header. Rocq is edited as source only: its light
reads No code or Unverified.

## Lean nodes and LeanGround

A Lean node's header has **Submit to LeanGround** while it is not submitted. It
asks for members and a budget (default 1000). In a database without a project it
creates one with this node as the root theorem (owners only); otherwise it
attaches the current branch to the project, converted from the root (you need
`editor` or better on the branch and membership in the project, and the branch
must contain the root node). Either way the database needs a proof environment.
Once the node has a status from the project, the button becomes
**Collaboration**.

**Project settings** has two tabs:

- **Proof environment**: LeanGround base key, context lines (`open`,
  `set_option`, `universe`, `variable`, one per line), Lean options as a JSON
  object, and minimum trust (`claimed`, `audited` by default, `trusted`), shared
  by all branches of the database. Owners only; a change makes the current
  project board read-only and the next submission starts a new one.
- **LaTeX**: the branch's shared macro file and bibliography.

## Collaboration dialog

The toolbar's **Collaboration** dialog shows the database's project boards you
are a member of, as seen from the current branch: the current board first, then
superseded boards and earlier per-branch proof requests, with a selector when
there are several. It refreshes every five seconds. Owner controls appear for
the board's owner (a delegated token also needs `maintain`).

| Tab | Contents |
| --- | --- |
| Proof overview | Root status; warnings for a read-only board, a stale or failed conversion of this branch, or a failed sync; **Attach this branch** when the branch is not attached; attached branches with state, number of picks and whether the route closes; owner, members, budget (spent, reserved, total), trust, review policy (owners: **Require review** / **Waive review**), last sync; every node the current branch converted, with role, state, reason and status, and **Resubmit** for theorem nodes; recent failed jobs; **Sync now**. |
| Task board | Allocation and lease length for claims; tasks in the server's recommended order, with goal (and the goal a negation refutes), kind, status (**inactive**, and not claimable, when no active decomposition leads to the goal), lease holder and time left, and notes (**Add note**); **Claim**, and **Extend** / **Release** for your own lease; budget by participant; owners add **Decompose** tasks. |
| Decompositions | **Pending review**: proposed decompositions with premises, description, submitter and the branches that need them; owners **Activate** or **Retire** them with an optional comment. Then certificates per goal with premises, trust and state, marking refuted goals and premises, cycles, certificates no longer shared, the last review, route membership and the branches picking each; owners activate, pause or retire. **Use on this branch** / **Unpick** set the current branch's pick of an active decomposition, for the owner and for members who can write the branch (a delegated token needs `edit`). |
| Review | Owners **Assemble a route** for the current branch once its route closes, **Retry same plan** after a retryable failure and **Accept and write back** into the assembly's branch (not while it is stale); every assembly with its route; the current branch's writeback batches with their operations or abort reason. |

Read-only boards (a superseded project, or a per-branch proof request of an
earlier version) say why and disable their commands. Without a project, the
dialog says how to start one.

See [Collaboration](../collaboration/) for what these operations mean.
