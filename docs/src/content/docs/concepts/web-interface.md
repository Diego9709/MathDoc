---
title: Web interface
---

## Sign in

The API process serves the editor at `/`. On load the page checks the stored
token against `/api/me`; without a valid one it asks for an **access token**,
which it then keeps in this browser's `localStorage`. Any later `401` response
clears it and returns to the sign-in page. A delegated token works too; the page
then acts as `PERSON/NAME` within the token's scopes. Both page headers show the
actor you are signed in as; **Sign out** next to it forgets the token in this
browser and returns to the sign-in page, for example to continue as someone
else. Use a private browser profile on shared machines.

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
and clickable cross-node references ([LaTeX](../latex/)). Text blocks are
GitHub-flavoured Markdown and add Edit/Preview too: math in `$…$`, `\(…\)`,
`$$…$$` or `\[…\]` is typeset with MathJax, raw HTML is sanitized, and links
open in a new tab. As for LaTeX, the preview shows the unsaved draft and
switching nodes keeps the mode.

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
| Not accepted | The converter or LeanGround rejected the node; the reason is shown, and hovering the light shows LeanGround's explanation (Lean's errors for a refused proof). |
| Registered definition | A definition node whose definitions LeanGround registered; definitions have no goal to prove. |

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
the board's owner (a delegated token also needs `maintain`). A refused command
shows its reason until the next command or **×**; a command sent while a
background job changed the board is sent again at the latest revision (up to
three times), so a sync does not make a click fail.

Above the tabs, one line says what the current branch's proof waits for and
links the tab that does it: an open goal to prove (the first few, by name), a
proposed decomposition to review, a route ready to assemble, a running or failed
assembly, a certified assembly to write back, or **Done** once a certified
assembly is written into the document (or the root is refuted). Owners read
"your review"; members read what waits for the owner. A tab shows a count when
something there waits: open tasks, decompositions pending review, certified
assemblies not written back.

| Tab | Contents |
| --- | --- |
| Proof overview | Root status; warnings for a read-only board, a stale or failed conversion of this branch, or a failed sync; **Attach this branch** when the branch is not attached; with more than one branch, each branch's document state, number of picks and whether its route is complete; the document nodes the current branch converted, with kind, submission state and reason, goal status and **Resubmit** for theorem nodes, and **What these words mean** for the submission states and goal statuses; recent failed jobs with LeanGround's explanation (Lean's errors for a refused proof); the project — owner, members, budget (spent, reserved, total), minimum trust, review policy (owners: **Require review** / **Waive review**), last sync — folded under one summary line; **Sync now**. |
| Task board | Open tasks, whose goal active certificates do not prove yet, in the server's recommended order, with goal (and the goal a negation refutes), kind, status (**inactive**, and not claimable, when no active decomposition leads to the goal), who holds the claim and its time left, and notes (**Add note**); the budget a claim reserves and how long it lasts; **Claim**, and **Extend** / **Release** for your own claim; done tasks folded away; budget by participant (a delegated token as its person and token name); owners add **Decompose** tasks for unproved goals. |
| Certificates | **Pending review**: proposed decompositions with premises, description, submitter and the branches that need them; owners **Activate** or **Retire** them with an optional comment. Then each goal with its statement and its certificates in two groups, **Complete proofs** and **Decompositions** (⇐ premises with their status), each with its origin (proved or split by an actor, result of an assembly, from a document node, or found in LeanGround), its state and trust when not active and trusted, refuted goals and premises, cycles, certificates no longer shared, the last review, **on BRANCH's route** for the certificates **Assemble a route** would use on the current branch (its picks, elsewhere the fewest premises first), and the branches picking each; owners activate, pause or retire. **Use on this branch** / **Unpick** set the current branch's pick of an active certificate, for the owner and for members who can write the branch (a delegated token needs `edit`). |
| Assemble & write back | What assembling and writing back do; owners **Assemble a route** for the current branch once its route is complete (otherwise why not yet), **Retry same plan** after a retryable failure and **Accept and write back** into the assembly's branch (not while it is stale); every assembly, newest first, with its route (each goal's certificate, complete proof or decomposition), a failed one with LeanGround's explanation, and its writebacks — what a committed one wrote, or why one aborted — instead of the button once written back; **Preview changes** on a certified assembly shows what accepting writes, read against the branch as it is now — each node's Lean text as a line diff (new nodes as added lines) and the assembled proof — or why the batch would abort, and writes nothing. When a writeback is committed into the current branch while the dialog is open, the open node and the graph reload; with unsaved edits, a banner asks you to save or discard them and refresh instead. |

Read-only boards (a superseded project, or a per-branch proof request of an
earlier version) say why and disable their commands. Without a project, the
dialog says how to start one.

See [Collaboration](../collaboration/) for what these operations mean.
