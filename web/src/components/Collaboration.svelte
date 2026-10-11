<script lang="ts">
  // The four collaboration views (docs/mathdoc.md §4.8): proof overview, task board,
  // certificates, and assembly and writeback. People use the same commands as agents. A
  // project board is shared by the database's branches; this dialog shows the current
  // branch's view, under one line saying what its proof waits for. Proposed decompositions
  // wait for the owner's review (§2.7.3); notes stay on goals.
  import { onDestroy, onMount } from "svelte";
  import { activeGoals, branchView, branchesNeeding, coordination, currentBranch, goalName, goalStatement, goalStatusHelp, nextStep, nodeStateHelp, readOnlyReason, branchRoute, routeCloses, solvedGoals, spentBy, writtenBack, type Board, type CollabView, type Command, type PlannedChange, type WritebackPreview } from "../lib/coordination";
  import { lineDiff } from "../lib/diff";
  import { errMsg } from "../lib/format";
  import { projectsApi } from "../lib/api";
  import { modal } from "../lib/modal";
  let { project = null, onClose, onOpenNode, onDocumentChanged }: {
    project?: string | null; onClose: () => void; onOpenNode?: (fnode: string) => void;
    /** A writeback was committed into this branch while the dialog was open. */
    onDocumentChanged?: () => void;
  } = $props();
  const branch = currentBranch();
  let tab = $state<CollabView>("overview");
  const views: Record<CollabView, string> = {
    overview: "Proof overview", tasks: "Task board", decompositions: "Certificates", review: "Assemble & write back",
  };
  let boards = $state<Board[]>([]), selected = $state<string | null>(null);
  let board = $state<Board | null>(null), me = $state<string>("");
  // A delegated token (`person/name`) acts for its person, within its scopes (§2.7.4).
  let principal = $state<string>(""), scopes = $state<string[] | null>(null);
  // §2.7.7: editors of this branch pick its route too; the role comes from the directory.
  let writesBranch = $state(false);
  // A refused command stays until the next command; a failed load clears on the next good load.
  let refused = $state<string | null>(null), loadError = $state<string | null>(null), busy = $state(false);
  let jobs = $state<Awaited<ReturnType<typeof coordination.jobs>>>([]);
  // §2.7.5: the task board follows the server's recommendation order.
  let ranking = $state<Map<string, number>>(new Map());
  let allocation = $state(100), ttl = $state(300);
  let comments = $state<Record<string, string>>({});
  let noteFor = $state<string | null>(null), noteText = $state("");
  let alive = true, timer: ReturnType<typeof setInterval> | undefined;
  // What accepting each assembly would write, loaded on request (§4.9).
  let previews = $state<Record<string, WritebackPreview | "loading" | { error: string }>>({});
  // Writebacks committed into this branch as of the first load; a new one means the document changed.
  let committed: Set<string> | null = null;
  const now = () => Date.now();

  async function refresh() {
    if (!branch) return;
    try {
      boards = await coordination.projects(branch.database, branch.branch);
      selected ??= project ?? boards[0]?.id ?? null;
      if (selected) {
        board = await coordination.project(selected);
        jobs = await coordination.jobs(selected);
        const now = new Set(Object.values(branchView(board, branch.branch)?.writebacks ?? {})
          .filter((w) => w.status === "committed").map((w) => w.batch_id));
        if (committed && [...now].some((id) => !committed!.has(id))) onDocumentChanged?.();
        committed = now;
        if (board.project && !board.project.superseded)
          ranking = new Map((await coordination.next(selected)).candidates.map((c, i) => [c.task, i + 1]));
      }
      loadError = null;
    } catch (e) { if (alive) loadError = errMsg(e); }
  }
  onMount(async () => {
    try {
      const who = await coordination.me();
      me = who.actor;
      principal = who.principal ?? who.actor;
      scopes = who.scopes ?? null;
      const role = branch ? (await projectsApi.list()).projects[`${branch.database}/${branch.branch}`]?.role : undefined;
      writesBranch = role === "admin" || role === "owner" || role === "editor";
    } catch { /* shown by refresh */ }
    await refresh();
    timer = setInterval(() => void refresh(), 5000);
  });
  onDestroy(() => { alive = false; clearInterval(timer); });

  async function togglePreview(run: string) {
    if (!board) return;
    if (previews[run]) { delete previews[run]; return; }
    previews[run] = "loading";
    try { previews[run] = await coordination.preview(board.id, run); }
    catch (e) { previews[run] = { error: errMsg(e) }; }
  }
  const changeLabel: Record<PlannedChange["kind"], string> = {
    update_lean_block: "Update the Lean block of",
    create_goal_node: "Create the goal node",
    create_definition_node: "Create the definition node",
  };

  async function run(command: Command) {
    if (!board || busy || frozen) return;
    busy = true; refused = null;
    try { await coordination.command(board, command); }
    catch (e) { refused = errMsg(e); }
    await refresh();
    busy = false;
  }
  const isOwner = $derived(board !== null && board.owner === principal && (scopes === null || scopes.includes("maintain")));
  const canPick = $derived(isOwner || (board !== null && board.members.includes(principal) && writesBranch && (scopes === null || scopes.includes("edit"))));
  const goals = $derived(board ? Object.values(board.goals) : []);
  const facts = $derived(board ? Object.values(board.facts) : []);
  const openAttempts = $derived(board ? Object.values(board.attempts).filter((a) => !a.outcome) : []);
  const reserved = $derived(openAttempts.reduce((sum, a) => sum + a.reserved, 0));
  const name = (goal: string) => (board ? goalName(board, goal) : goal);
  const failures = $derived(jobs.filter((j) => j.status === "failed").slice(0, 5));
  const statusOf = (goal: string) => board?.goals[goal]?.status ?? "insufficient";
  const view = $derived(board && branch ? branchView(board, branch.branch) : null);
  // The certificates "Assemble a route" would use on this branch, as the coordinator chooses them.
  const onRoute = $derived((board && view ? branchRoute(board, view.picks) : null) ?? new Set<string>());
  const frozen = $derived(board ? readOnlyReason(board) : null);
  // Commands that act on a branch name the current one on project boards.
  const here = $derived(board?.project && branch ? { branch: branch.branch } : {});
  const active = $derived(board ? activeGoals(board) : new Set<string>());
  const proposed = $derived(facts.filter((f) => f.state === "proposed"));
  const when = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString() : "");
  async function review(fact: string, state: "active" | "retired") {
    const comment = comments[fact]?.trim();
    await run({ type: "decomposition", certificate: fact, state, ...(comment ? { comment } : {}) });
  }
  async function addNote(goal: string) {
    const text = noteText.trim();
    if (!text) return;
    await run({ type: "note", goal, text });
    if (!refused) { noteFor = null; noteText = ""; }
  }
  // Where a certificate came from: an assembly's result, a document node, a submission, or LeanGround.
  function origin(f: Board["facts"][string]) {
    if (!board) return "";
    const run = Object.values(board.runs).find((r) => r.certification_id === f.id);
    if (run) return `result of assembly ${run.id.slice(0, 8)}${run.branch ? ` on ${run.branch}` : ""}`;
    const node = Object.values(board.branches ?? {}).flatMap((b) => Object.values(b.nodes)).find((n) => n.certificate === f.id);
    if (node) return `from the document node ${node.title}`;
    if (f.submitter) return `${f.premises.length ? "split" : "proved"} by ${f.submitter}${f.submitted_at ? ` · ${when(f.submitted_at)}` : ""}`;
    return "found in LeanGround";
  }
  const pickedBy = (fact: string) =>
    Object.entries(board?.branches ?? {}).filter(([, s]) => Object.values(s.picks).includes(fact)).map(([name]) => name);
  const step = $derived(board && branch ? nextStep(board, branch.branch, isOwner) : null);
  // Tasks whose goal no active certificates prove yet; the others are done and folded away.
  const solved = $derived(board ? solvedGoals(board) : new Set<string>());
  const tasks = $derived(board ? Object.values(board.tasks).filter((t) => t.state !== "cancelled")
    .sort((x, y) => (ranking.get(x.id) ?? Infinity) - (ranking.get(y.id) ?? Infinity)) : []);
  const openTasks = $derived(tasks.filter((t) => !solved.has(t.goal)));
  const doneTasks = $derived(tasks.filter((t) => solved.has(t.goal)));
  // Runs newest first; this branch's certified ones not yet written back await the owner.
  const runs = $derived(board ? Object.values(board.runs).reverse() : []);
  const awaiting = $derived(board ? runs.filter((r) => r.status === "certified" && r.branch === branch?.branch && !writtenBack(board!, r)).length : 0);
  const badges = $derived<Record<CollabView, { count: number; title: string }>>({
    overview: { count: 0, title: "" },
    tasks: { count: openTasks.length, title: "Tasks whose goal has no proof yet" },
    decompositions: { count: proposed.length, title: "Proposed decompositions awaiting the owner's review" },
    review: { count: awaiting, title: "Certified assemblies not written back yet" },
  });
  const branchState = (s: NonNullable<Board["branches"]>[string]) =>
    s.request.bound ? (s.request.stale ? "changed since converted" : "converted") : s.request.error ?? "converting…";
  const kindHelp: Record<string, string> = {
    prove: "Prove the goal outright (mdc prove)",
    decompose: "Split the goal into smaller goals (mdc split)",
    formalize: "State the goal in Lean",
  };
  // A delegated token acts as `person/name`: the person, through that token.
  const actor = (a: string) => (a.includes("/") ? `${a.slice(0, a.indexOf("/"))} (token ${a.slice(a.indexOf("/") + 1)})` : a);
  const kindOf = (fact: string) => {
    const f = board?.facts[fact];
    return !f ? "" : f.premises.length ? `decomposition ⇐ ${f.premises.map(name).join(", ")}` : "complete proof";
  };
  const assembleBlocked = $derived.by(() => {
    if (!board || !board.root) return "There is no root goal yet.";
    if (!board.project) return statusOf(board.root) === "insufficient" ? "The root goal has no proof yet." : null;
    if (!view?.request.bound) return "This branch is not converted yet.";
    if (!routeCloses(board, view.picks)) return `Some goal on ${branch?.branch}'s route has no proof yet; see the task board.`;
    return null;
  });
  const opLabel = (kind: string) =>
    ({ update_lean_block: "updated the Lean block of", create_goal_node: "created the goal node", create_definition_node: "created the definition node" })[kind] ?? kind.replaceAll("_", " ");
</script>

<dialog class="modal-dialog collab" aria-label="Collaboration" use:modal oncancel={(e) => { e.preventDefault(); onClose(); }}>
  <header class="dialog-head">
    <h2>Collaboration</h2>
    {#if boards.length > 1}
      <select aria-label="Proof request" bind:value={selected} onchange={() => void refresh()}>
        {#each boards as b}<option value={b.id}>{b.title}</option>{/each}
      </select>
    {/if}
    <button class="close" onclick={onClose} aria-label="Close">×</button>
  </header>
  <div class="tabs" role="tablist" aria-label="Collaboration view">
    {#each Object.entries(views) as [key, label] (key)}
      {@const badge = badges[key as CollabView]}
      <button role="tab" aria-selected={tab === key} onclick={() => (tab = key as CollabView)}>{label}{#if badge.count}<span class="badge" title={badge.title}>{badge.count}</span>{/if}</button>
    {/each}
  </div>
  <div class="body">
    {#if step}
      <p class="next" data-tone={step.tone} role="status" aria-label="Next step">
        <strong>{step.tone === "done" ? "Done" : step.tone === "wait" ? "Waiting" : "Next"}:</strong> {step.text}
        {#if step.view && step.view !== tab}<button class="link" onclick={() => (tab = step!.view!)}>Open {views[step.view]} →</button>{/if}
      </p>
    {/if}
    {#if refused}<p class="error" role="alert">{refused} <button class="dismiss" onclick={() => (refused = null)} aria-label="Dismiss">×</button></p>{/if}
    {#if loadError}<p class="error" role="status">{loadError}</p>{/if}
    {#if !board}
      <p class="muted">{boards.length ? "Loading..." : "No project in this database yet. Open the root theorem's Lean node and use “Submit to LeanGround”."}</p>
    {:else if tab === "overview"}
      <section aria-label="Proof overview">
        <h3>{board.title} <span class="status" data-status={board.root ? statusOf(board.root) : "insufficient"} title={board.root ? goalStatusHelp[statusOf(board.root)] : "Converting the root node"}>{board.root ? statusOf(board.root) : "binding"}</span></h3>
        {#if frozen}<p class="warn" role="status">{frozen}</p>{/if}
        {#if view?.request.stale}<p class="warn" role="status">This branch's document changed after it was converted: its results stay in history but cannot certify the new text. Submit the root node again to convert the branch anew.</p>{/if}
        {#if view?.request.error}<p class="error">This branch: {view.request.error}</p>{/if}
        {#if board.sync_error}<p class="error">Sync: {board.sync_error}</p>{/if}
        {#if board.project}
          {#if branch && !view && !frozen}
            <p class="muted">This branch is not attached to the project yet.</p>
            <button disabled={busy || !board.ready} onclick={() => void run({ type: "attach", branch: branch.branch })}>Attach this branch</button>
          {/if}
          {#if Object.keys(board.branches ?? {}).length > 1}
            <p class="muted">Every branch of this database proves the same root theorem in its own way: it picks certificates for some goals, and assembly fills in the rest.</p>
            <table aria-label="Branches">
              <thead><tr><th>Branch</th><th>Document</th><th title="Goals for which the branch chose the certificate to use">Picks</th><th title="Whether every goal on the branch's route has a proof, so the route can be assembled">Route</th></tr></thead>
              <tbody>
                {#each Object.entries(board.branches ?? {}) as [name, s] (name)}
                  <tr class:current={name === branch?.branch}>
                    <td>{name}</td>
                    <td>{branchState(s)}</td>
                    <td>{Object.keys(s.picks).length}</td>
                    <td>{s.request.bound && board.root ? (routeCloses(board, s.picks) ? "complete: can be assembled" : "goals still open") : ""}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        {/if}
        {#if !board.ready && !board.sync_error}<p class="muted">Converting nodes and submitting them to LeanGround...</p>{/if}
        {#if Object.keys(view?.nodes ?? {}).length}
          <h4>Document nodes on this branch</h4>
          <table aria-label="Document nodes">
            <thead><tr><th>Node</th><th>Kind</th><th title="Where the node is in LeanGround">Submission</th><th title="Whether the goal the node states is proved">Goal</th><th></th></tr></thead>
            <tbody>
              {#each Object.values(view?.nodes ?? {}) as n (n.node)}
                <tr>
                  <td><button class="link" onclick={() => onOpenNode?.(n.node)}>{n.title}</button></td>
                  <td>{n.role}</td>
                  <td title={[nodeStateHelp[n.state], n.details].filter(Boolean).join("\n")}>{n.state}{n.reason ? ` · ${n.reason}` : ""}</td>
                  <td>{#if n.goal}<span class="status" data-status={statusOf(n.goal)} title={goalStatusHelp[statusOf(n.goal)]}>{statusOf(n.goal)}</span>{/if}</td>
                  <td>{#if n.role === "theorem" && !frozen}<button title="Read this node again from the branch and submit its current proof" disabled={busy || !board.ready} onclick={() => void run({ type: "submit_node", node: n.node, ...here })}>Resubmit</button>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <details class="legend">
            <summary>What these words mean</summary>
            <p class="group">Submission: where the node is in LeanGround</p>
            <dl>
              {#each Object.entries(nodeStateHelp) as [state, help] (state)}
                <dt>{state}</dt><dd>{help}</dd>
              {/each}
            </dl>
            <p class="group">Goal: whether the statement is proved, by any certificate</p>
            <dl>
              {#each Object.entries(goalStatusHelp) as [status, help] (status)}
                <dt><span class="status" data-status={status}>{status}</span></dt><dd>{help}</dd>
              {/each}
            </dl>
          </details>
        {/if}
        {#if failures.length}
          <h4>Recent failures</h4>
          <p class="muted">Background jobs (submissions, syncs, assemblies, writebacks) that failed, with LeanGround's explanation.</p>
          <ul class="failures">{#each failures as j}<li><code>{j.kind}</code> {j.error}{#if j.details}<pre class="messages">{j.details}</pre>{/if}</li>{/each}</ul>
        {/if}
        <details class="settings">
          <summary>Project: owner {board.owner} · budget {board.spent + reserved} of {board.budget} used{board.project ? ` · review ${board.review === "none" ? "waived" : "required"}` : ""}</summary>
          <dl>
            <dt>Owner</dt><dd>{board.owner}: reviews decompositions, assembles and writes back</dd>
            <dt>Members</dt><dd>{board.members.join(", ")}: can claim tasks and submit proofs</dd>
            <dt>Budget</dt><dd>{board.spent} spent · {reserved} reserved by open claims · {board.budget} in total. The units are whatever the team agrees on; claims fail once the budget would be exceeded.</dd>
            <dt>Trust</dt><dd>{board.minimum_trust}: certificates LeanGround trusts less than this do not count</dd>
            {#if board.project}
              <dt>Review</dt>
              <dd>
                {board.review === "none" ? "new decompositions count at once" : "new decompositions from agents wait for the owner's review before anyone works on their premises"}
                {#if isOwner && !frozen}
                  <button disabled={busy} onclick={() => void run({ type: "policy", review: board?.review === "none" ? "required" : "none" })}>{board.review === "none" ? "Require review" : "Waive review"}</button>
                {/if}
              </dd>
            {/if}
            <dt>Last sync</dt><dd>{board.last_sync ? new Date(board.last_sync).toLocaleTimeString() : "never"}</dd>
          </dl>
        </details>
        <button disabled={busy || !!frozen} onclick={() => void run({ type: "sync" })} title="Read this database's branches again and fetch new certificates from LeanGround">Sync now</button>
      </section>
    {:else if tab === "tasks"}
      <section aria-label="Task board">
        <p class="muted">Each goal without a proof has a task: <strong>prove</strong> it outright, or <strong>decompose</strong> it into smaller goals. Agents take tasks with <code>mdc pull</code>; you can claim one here. A claim holds the task for a while and reserves part of the budget until it finishes.</p>
        {#snippet row(t: Board["tasks"][string])}
          {@const a = t.attempt ? board!.attempts[t.attempt] : undefined}
          {@const notes = board!.goals[t.goal]?.notes ?? []}
          <tr>
            <td>{ranking.has(t.id) ? `#${ranking.get(t.id)}` : ""}</td>
            <td>{name(t.goal)}{#if board!.negations?.[t.goal]} <span class="muted">refutes {name(board!.negations[t.goal])}</span>{/if}</td>
            <td title={kindHelp[t.kind] ?? ""}>{t.kind}</td>
            <td>
              <span class="status" data-status={statusOf(t.goal)} title={goalStatusHelp[statusOf(t.goal)]}>{statusOf(t.goal)}</span>
              {#if !active.has(t.goal)}<span class="status" title="No active decomposition leads to this goal yet (for example, one awaiting review), so its task cannot be claimed">inactive</span>{/if}
            </td>
            <td>{#if a}{actor(a.actor)} · {Math.max(0, Math.round((a.expires - now()) / 1000))} s left{:else}<span class="muted">nobody</span>{/if}</td>
            <td class="notes">
              {#if notes.length}
                <details>
                  <summary>{notes.length} {notes.length === 1 ? "note" : "notes"}</summary>
                  <ul aria-label={`Notes on ${name(t.goal)}`}>
                    {#each [...notes].reverse() as n}<li><span class="muted">{n.actor} · {when(n.at)}</span> {n.text}</li>{/each}
                  </ul>
                </details>
              {/if}
              {#if noteFor === t.goal}
                <form class="note" onsubmit={(e) => { e.preventDefault(); void addNote(t.goal); }}>
                  <input aria-label={`Note on ${name(t.goal)}`} maxlength="500" placeholder="What was tried, where it got stuck" bind:value={noteText} />
                  <button type="submit" disabled={busy || !noteText.trim()}>Save note</button>
                </form>
              {:else if !frozen}
                <button class="link" onclick={() => { noteFor = t.goal; noteText = ""; }}>Add note</button>
              {/if}
            </td>
            <td>
              {#if !a && !solved.has(t.goal)}
                <button disabled={busy || !!frozen || !active.has(t.goal)} onclick={() => void run({ type: "claim", task: t.id, allocation, ttl })}>Claim</button>
              {:else if a && a.actor === me}
                <button disabled={busy || !!frozen} onclick={() => void run({ type: "heartbeat", attempt: a.id, epoch: a.epoch, ttl })}>Extend</button>
                <button disabled={busy || !!frozen} onclick={() => void run({ type: "finish", attempt: a.id, epoch: a.epoch, spent: 0, outcome: "released" })}>Release</button>
              {/if}
            </td>
          </tr>
        {/snippet}
        {#snippet head()}
          <thead><tr><th title="Recommended order: needed by the routes closest to closing, fewest failures first">Next</th><th>Goal</th><th>Kind</th><th>Status</th><th>Claimed by</th><th>Notes</th><th></th></tr></thead>
        {/snippet}
        {#if openTasks.length}
          {#if !frozen}
            <div class="controls">
              <label title="Budget units a claim reserves until it finishes">Claim reserving <input aria-label="Allocation" type="number" min="0" bind:value={allocation} /> units</label>
              <label title="A claim not extended within this time expires and the task is free again">for <input aria-label="Lease (s)" type="number" min="30" max="3600" bind:value={ttl} /> s</label>
            </div>
          {/if}
          <table aria-label="Open tasks">{@render head()}<tbody>{#each openTasks as t (t.id)}{@render row(t)}{/each}</tbody></table>
        {:else}
          <p class="muted">No open task: every goal with a task has a proof.</p>
        {/if}
        {#if doneTasks.length}
          <details class="done">
            <summary>Done ({doneTasks.length}): the goal has a proof</summary>
            <table aria-label="Done tasks">{@render head()}<tbody>{#each doneTasks as t (t.id)}{@render row(t)}{/each}</tbody></table>
          </details>
        {/if}
        {#if Object.keys(board.attempts).length}
          <h4>Budget by participant</h4>
          <table aria-label="Budget by participant">
            <thead><tr><th>Participant</th><th>Claims</th><th title="Reported by finished claims">Spent</th><th title="Held by claims still open">Reserved</th></tr></thead>
            <tbody>
              {#each spentBy(board) as r (r.actor)}
                <tr><td>{actor(r.actor)}</td><td>{r.attempts}</td><td>{r.spent}</td><td>{r.reserved}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}
        {#if isOwner && goals.some((g) => !solved.has(g.key))}
          <p class="muted">Ask for a goal to be split into smaller goals:</p>
          <div class="controls">
            {#each goals.filter((g) => !solved.has(g.key)).slice(0, 20) as g (g.key)}
              <button disabled={busy || !!frozen} onclick={() => void run({ type: "task", goal: g.key, kind: "decompose", priority: 0 })}>Decompose {name(g.key)}</button>
            {/each}
          </div>
        {/if}
      </section>
    {:else if tab === "decompositions"}
      <section aria-label="Certificates">
        <p class="muted">Every certificate LeanGround issued for this project's goals. A <strong>complete proof</strong> proves its goal by itself; a <strong>decomposition</strong> (⇐) proves it from premises, which become goals of their own. Only active certificates count: a proposed decomposition waits for the owner's review. Assembling this branch uses, for each goal, the certificate the branch picked, otherwise the one with the fewest premises; the list marks those as on this branch's route.</p>
        {#if proposed.length}
          <section class="pending" aria-label="Pending review">
            <h4>Pending review ({proposed.length})</h4>
            {#each proposed as f (f.id)}
              {@const needing = branchesNeeding(board, f.goal)}
              <article>
                <p><strong>{name(f.goal)}</strong> <code title={f.id}>{f.id.slice(0, 10)}</code> ⇐</p>
                <ul>{#each f.premises as p}<li><code>{goalStatement(board, p)}</code> <span class="status" data-status={statusOf(p)}>{statusOf(p)}</span></li>{/each}</ul>
                {#if f.description}<p class="description">{f.description}</p>{/if}
                <p class="muted">
                  {f.submitter ? `Submitted by ${f.submitter}` : "Found by sync"}{f.submitted_at ? ` · ${when(f.submitted_at)}` : ""}
                  · {needing.length ? `needed by ${needing.length === 1 ? "branch" : "branches"} ${needing.join(", ")}` : "no branch route reaches its goal"}
                </p>
                {#if isOwner && !frozen}
                  <div class="controls">
                    <input aria-label={`Review comment on ${f.id.slice(0, 10)}`} placeholder="Review comment (optional)" maxlength="2000" bind:value={comments[f.id]} />
                    <button disabled={busy} onclick={() => void review(f.id, "active")}>Activate</button>
                    <button disabled={busy} onclick={() => void review(f.id, "retired")}>Retire</button>
                  </div>
                {:else}
                  <p class="muted">Waiting for the owner's review.</p>
                {/if}
              </article>
            {/each}
          </section>
        {/if}
        {#each goals.filter((g) => facts.some((f) => f.goal === g.key)) as g (g.key)}
          <h4>{name(g.key)} <span class="status" data-status={g.status}>{g.status}</span>{#if g.refuted}<span class="status refuted" title={`Its negation is proved by ${g.refuted.certificate.slice(0, 10)}`}>refuted</span>{/if}</h4>
          <p class="statement"><code>{goalStatement(board, g.key)}</code></p>
          {#each [["Complete proofs", false], ["Decompositions", true]] as const as [heading, split]}
          {@const group = facts.filter((f) => f.goal === g.key && (f.premises.length > 0) === split)}
          {#if group.length}
          <p class="group">{heading} ({group.length})</p>
          <ul class="facts">
            {#each group as f (f.id)}
              <li class:paused={f.state !== "active"} class:unavailable={!f.available}>
                <code title={f.id}>{f.id.slice(0, 10)}</code>
                {#if f.premises.length}⇐ {#each f.premises as p, i}{i ? ", " : ""}{name(p)} <span class="status" data-status={statusOf(p)}>{statusOf(p)}</span>{/each}{/if}
                <span class="origin">{origin(f)}</span>
                {#if f.state !== "active"}<span class="status">{f.state}</span>{/if}
                {#if f.trust !== "trusted"}<span class="muted" title="LeanGround's trust level for this certificate">· {f.trust}</span>{/if}
                {#if !f.available}<span class="warn">· no longer shared</span>{/if}
                {#if f.refuted_by}<span class="warn">· its premise {name(f.refuted_by)} is false</span>{/if}
                {#if f.premises.includes(f.goal)}<span class="warn" title={f.retired_reason === "premise_is_goal" ? "A premise is the goal itself, so it was retired on arrival" : ""}>cycle</span>{/if}
                {#if f.description}<span class="description">· {f.description}</span>{/if}
                {#if f.review}<span class="muted" title={f.review.comment ?? ""}>· {f.review.state} by {f.review.actor}{f.review.comment ? `: ${f.review.comment}` : ""}</span>{/if}
                {#if onRoute.has(f.id)}<span class="route" title="Assemble a route on this branch uses this certificate: picked ones where the branch picked, elsewhere the fewest premises first">on {branch?.branch}'s route</span>{/if}
                {#each pickedBy(f.id) as name}<span class="route">picked by {name}</span>{/each}
                {#if canPick && view && board.project && branch}
                  {#if view.picks[f.goal] === f.id}
                    <button disabled={busy || !!frozen} onclick={() => void run({ type: "pick", branch: branch.branch, goal: f.goal, certificate: null })} title="Let assembly choose this goal's certificate again">Unpick</button>
                  {:else if f.state === "active"}
                    <button disabled={busy || !!frozen} onclick={() => void run({ type: "pick", branch: branch.branch, goal: f.goal, certificate: f.id })} title="This branch's route proves the goal with this certificate">Use on this branch</button>
                  {/if}
                {/if}
                {#if isOwner && f.state !== "refuted"}
                  {#each ["active", "paused", "retired"] as const as state}
                    {#if state !== f.state}<button disabled={busy || !!frozen} onclick={() => void run({ type: "decomposition", certificate: f.id, state })} title={state === "active" ? "Use it in routes and assembly again" : state === "paused" ? "Leave it out of routes and assembly until it is activated again" : "Withdraw it for good"}>{state === "active" ? "Activate" : state === "paused" ? "Pause" : "Retire"}</button>{/if}
                  {/each}
                {/if}
              </li>
            {/each}
          </ul>
          {/if}
          {/each}
        {/each}
      </section>
    {:else}
      <section aria-label="Assemble and write back">
        <p class="muted">
          Assembling joins the certificates on {board.project ? `${branch?.branch}'s route` : "the route"} (one per goal) into a single Lean file, which LeanGround checks with no premises left.
          A certified assembly can then be written back: <strong>Preview changes</strong> shows what it writes, and <strong>Accept and write back</strong> writes it into {board.project ? `branch ${branch?.branch}` : "the document"} in one commit.
        </p>
        {#if isOwner}
          <button disabled={busy || !!frozen || !!assembleBlocked} onclick={() => void run({ type: "assemble", component: "lean-worker", ...here })}>Assemble a route</button>
          {#if assembleBlocked && !frozen}<span class="muted">{assembleBlocked}</span>{/if}
        {:else}
          <p class="muted">Only the owner, {board.owner}, assembles and writes back.</p>
        {/if}
        {#each runs as r (r.id)}
          {@const target = r.branch ? board.branches?.[r.branch] : view}
          {@const batch = writtenBack(board, r)}
          {@const records = Object.values((r.branch ? board.branches?.[r.branch]?.writebacks : view?.writebacks) ?? {}).filter((w) => w.run === r.id)}
          <article class="run" data-status={batch ? "written" : r.status}>
            <h4>Assembly {r.id.slice(0, 8)}{r.branch ? ` · ${r.branch}` : ""} · <span class="status" data-status={r.status === "certified" ? "certified" : "insufficient"}>{r.status}</span>{#if batch}{" · written back"}{/if}</h4>
            {#if r.failure}<p class="error">{r.failure}{r.retryable ? " (retryable)" : ""}</p>{/if}
            {#if r.details}<pre class="messages">{r.details}</pre>{/if}
            <details class="route-steps" open={!batch}>
              <summary>Route: {r.route.steps.length} {r.route.steps.length === 1 ? "certificate" : "certificates"}</summary>
              <ol>{#each r.route.steps as s}<li>{name(board.facts[s.certificate_id]?.goal ?? "")}: {kindOf(s.certificate_id)} <code title={s.certificate_id}>{s.certificate_id.slice(0, 10)}</code></li>{/each}</ol>
            </details>
            {#if isOwner && r.status === "failed" && r.retryable}<button disabled={busy || !!frozen} onclick={() => void run({ type: "retry", run: r.id })}>Retry same plan</button>{/if}
            {#each records as w (w.batch_id)}
              {#if w.status === "committed"}
                <p class="written">Written back to {r.branch ? `branch ${r.branch}` : "the document"} (writeback {w.batch_id.slice(3, 11)}): {#each w.contract?.operations ?? [] as o, i}{i ? "; " : ""}{opLabel(o.kind)} <button class="link" onclick={() => onOpenNode?.(o.node_id)}>{target?.nodes[o.node_id]?.title ?? o.node_id.slice(0, 8)}</button>{/each}.</p>
              {:else}
                <p class="error">Writeback {w.batch_id.slice(3, 11)} aborted: {w.reason}: {w.details}. Nothing was written.</p>
              {/if}
            {/each}
            {#if !batch && r.status === "certified"}
              {@const p = previews[r.id]}
              <div class="controls">
                {#if board.project}<button onclick={() => void togglePreview(r.id)} aria-expanded={!!p}>{p ? "Hide preview" : "Preview changes"}</button>{/if}
                {#if isOwner}<button disabled={busy || !!frozen || !!target?.request.stale} onclick={() => void run({ type: "accept", run: r.id })} title={`Write the certified sources back to ${r.branch ? `branch ${r.branch}` : "the document"} in one batch`}>Accept and write back</button>{/if}
              </div>
              {#if p}
                <section class="preview" aria-label={`Preview of assembly ${r.id.slice(0, 8)}`}>
                  {#if p === "loading"}<p class="muted">Reading the branch and the certified sources…</p>
                  {:else if "error" in p}<p class="error">{p.error}</p>
                  {:else if p.status === "written"}<p class="muted">Already written back (writeback {p.writeback.batch_id.slice(3, 11)}).</p>
                  {:else}
                    {#if p.status === "conflict"}
                      <p class="error">Accepting would abort: {p.reason}: {p.details}. Nothing would be written.</p>
                    {:else}
                      <p>Accepting writes {p.changes.length} {p.changes.length === 1 ? "change" : "changes"} into branch {r.branch}, in one commit:</p>
                      {#each p.changes as c (c.node)}
                        <details class="change" open>
                          <summary>{changeLabel[c.kind]} {#if c.before === null}<strong>{c.title}</strong>{:else}<button class="link" onclick={() => onOpenNode?.(c.node)}>{c.title}</button>{/if}</summary>
                          <pre class="diff">{#each lineDiff(c.before ?? "", c.after) as l}<span class="line" data-op={l.op}>{l.op} {l.text}</span>{/each}</pre>
                        </details>
                      {/each}
                    {/if}
                    {#if p.assembled}
                      <details class="change">
                        <summary>The assembled proof, checked by LeanGround as one file without premises</summary>
                        <pre class="messages">{p.assembled}</pre>
                      </details>
                    {/if}
                  {/if}
                </section>
              {/if}
            {/if}
          </article>
        {/each}
        {#each Object.values(view?.writebacks ?? {}).filter((w) => !Object.hasOwn(board!.runs, w.run)) as w (w.batch_id)}
          <article class="batch" data-status={w.status}>
            <h4>Writeback {w.batch_id.slice(3, 11)} · {w.status}</h4>
            {#if w.status === "aborted"}<p class="error">{w.reason}: {w.details}. Nothing was written.</p>{/if}
            {#if w.contract}
              <ul>{#each w.contract.operations as o}<li>{opLabel(o.kind)} <button class="link" onclick={() => onOpenNode?.(o.node_id)}>{view?.nodes[o.node_id]?.title ?? o.node_id.slice(0, 8)}</button></li>{/each}</ul>
            {/if}
          </article>
        {/each}
      </section>
    {/if}
  </div>
</dialog>

<style>
  .collab { width:min(980px,95vw); max-height:92vh; overflow:auto; }
  .dialog-head { display:flex; align-items:center; gap:.75rem; }
  .dialog-head h2 { flex:1; }
  .close { border:none; background:none; font-size:1.3rem; cursor:pointer; color:var(--mdc-muted); }
  .tabs { display:flex; gap:.4rem; padding:.75rem 1rem 0; }
  .tabs button { padding:.4rem .9rem; border:1px solid var(--mdc-border); border-radius:var(--mdc-radius-sm); background:var(--mdc-bg); color:var(--mdc-muted); cursor:pointer; }
  .tabs button[aria-selected="true"] { color:var(--mdc-accent); border-color:var(--mdc-accent); background:var(--mdc-accent-soft); }
  .body { padding:1rem; font-size:.85rem; }
  table { width:100%; border-collapse:collapse; margin:.75rem 0; }
  th, td { text-align:left; padding:.3rem .4rem; border-bottom:1px solid var(--mdc-border); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:.2rem .8rem; }
  dt { color:var(--mdc-muted); }
  .status { padding:0 .35rem; border-radius:3px; font-size:.75rem; background:var(--mdc-bg); border:1px solid var(--mdc-border); }
  .status[data-status="certified"] { color:var(--mdc-accent-down); border-color:var(--mdc-accent-down); }
  .status[data-status="derivable"] { color:var(--mdc-accent); border-color:var(--mdc-accent); }
  .muted { color:var(--mdc-muted); }
  .warn { color:var(--mdc-warning); }
  .error { color:var(--mdc-error); }
  .error .dismiss { border:none; background:none; color:inherit; cursor:pointer; padding:0 .25rem; }
  .route { color:var(--mdc-accent); margin-left:.3rem; }
  tr.current td:first-child { font-weight:600; color:var(--mdc-accent); }
  .facts li.paused { opacity:.6; }
  .facts { margin:.2rem 0 .6rem; }
  .facts .origin { color:var(--mdc-muted); }
  .group { margin:.4rem 0 0; font-weight:600; font-size:.8rem; color:var(--mdc-muted); }
  .statement { margin:.1rem 0 .3rem; }
  .status.refuted { color:var(--mdc-error); border-color:var(--mdc-error); margin-left:.3rem; }
  .pending { border:1px solid var(--mdc-accent); border-radius:var(--mdc-radius-sm); padding:.5rem .75rem; margin:.6rem 0; }
  .pending article + article { border-top:1px solid var(--mdc-border); margin-top:.5rem; padding-top:.5rem; }
  .pending ul { margin:.2rem 0 .3rem; }
  .pending .controls input { width:18rem; }
  .description { font-style:italic; }
  td.notes ul { margin:.2rem 0; padding-left:1rem; max-width:22rem; }
  form.note { display:flex; gap:.3rem; }
  form.note input { width:14rem; }
  .facts li.unavailable { text-decoration:line-through; }
  .controls { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
  .controls input { width:6rem; }
  .link { border:none; background:none; color:var(--mdc-accent); cursor:pointer; padding:0; }
  .messages { margin:.3rem 0; padding:.4rem .6rem; max-height:14rem; overflow:auto; white-space:pre-wrap; font-family:var(--mdc-mono); font-size:.78rem; color:var(--mdc-code-fg); background:var(--mdc-code-bg); border-radius:var(--mdc-radius-sm); }
  .preview { margin:.5rem 0 .2rem; }
  .preview .change { margin:.35rem 0; }
  .preview summary { cursor:pointer; }
  .diff { margin:.3rem 0; padding:.4rem 0; max-height:22rem; overflow:auto; font-family:var(--mdc-mono); font-size:.78rem; background:var(--mdc-code-bg); color:var(--mdc-code-fg); border-radius:var(--mdc-radius-sm); }
  .diff .line { display:block; padding:0 .6rem; white-space:pre-wrap; }
  .diff .line[data-op="+"] { background:color-mix(in srgb, var(--mdc-accent-down) 18%, transparent); }
  .diff .line[data-op="-"] { background:color-mix(in srgb, var(--mdc-error) 16%, transparent); }
  .run, .batch { border:1px solid var(--mdc-border); border-radius:var(--mdc-radius-sm); padding:.5rem .75rem; margin:.6rem 0; }
  .run h4 { margin:.1rem 0 .3rem; }
  .run .route-steps summary, .legend summary, .settings summary, .done summary { cursor:pointer; color:var(--mdc-muted); }
  .run .route-steps ol { margin:.2rem 0 .3rem; }
  .written { margin:.3rem 0; color:var(--mdc-accent-down); }
  .next { margin:0 0 .8rem; padding:.5rem .75rem; border-radius:var(--mdc-radius-sm); border:1px solid var(--mdc-accent); background:var(--mdc-accent-soft); }
  .next[data-tone="done"] { border-color:var(--mdc-accent-down); background:color-mix(in srgb, var(--mdc-accent-down) 10%, transparent); }
  .next[data-tone="wait"] { border-color:var(--mdc-border); background:var(--mdc-bg); }
  .next .link { margin-left:.4rem; }
  .badge { display:inline-block; margin-left:.4rem; min-width:1.1rem; padding:0 .3rem; border-radius:999px; font-size:.72rem; line-height:1.1rem; text-align:center; color:#fff; background:var(--mdc-accent); }
  .legend, .settings, .done { margin:.5rem 0; }
  .legend dl, .settings dl { margin:.3rem 0 .2rem; }
  .batch[data-status="aborted"] { border-color:var(--mdc-error); }
  button { cursor:pointer; }
</style>
