<script lang="ts">
  // The four collaboration views (docs/mathdoc.md §4.8): proof overview, task board,
  // decompositions and result review. People use the same commands as agents. A project
  // board is shared by the database's branches; this dialog shows the current branch's view.
  // Proposed decompositions wait for the owner's review (§2.7.3); notes stay on goals.
  import { onDestroy, onMount } from "svelte";
  import { activeGoals, branchView, branchesNeeding, coordination, currentBranch, goalName, goalStatement, readOnlyReason, routeCloses, spentBy, type Board, type Command } from "../lib/coordination";
  import { errMsg } from "../lib/format";
  import { projectsApi } from "../lib/api";
  import { modal } from "../lib/modal";
  let { project = null, onClose, onOpenNode }: {
    project?: string | null; onClose: () => void; onOpenNode?: (fnode: string) => void;
  } = $props();
  type Tab = "overview" | "tasks" | "decompositions" | "review";
  const branch = currentBranch();
  let tab = $state<Tab>("overview");
  let boards = $state<Board[]>([]), selected = $state<string | null>(null);
  let board = $state<Board | null>(null), me = $state<string>("");
  // A delegated token (`person/name`) acts for its person, within its scopes (§2.7.4).
  let principal = $state<string>(""), scopes = $state<string[] | null>(null);
  // §2.7.7: editors of this branch pick its route too; the role comes from the directory.
  let writesBranch = $state(false);
  let error = $state<string | null>(null), busy = $state(false);
  let jobs = $state<Awaited<ReturnType<typeof coordination.jobs>>>([]);
  // §2.7.5: the task board follows the server's recommendation order.
  let ranking = $state<Map<string, number>>(new Map());
  let allocation = $state(100), ttl = $state(300);
  let comments = $state<Record<string, string>>({});
  let noteFor = $state<string | null>(null), noteText = $state("");
  let alive = true, timer: ReturnType<typeof setInterval> | undefined;
  const now = () => Date.now();

  async function refresh() {
    if (!branch) return;
    try {
      boards = await coordination.projects(branch.database, branch.branch);
      selected ??= project ?? boards[0]?.id ?? null;
      if (selected) {
        board = await coordination.project(selected);
        jobs = await coordination.jobs(selected);
        if (board.project && !board.project.superseded)
          ranking = new Map((await coordination.next(selected)).candidates.map((c, i) => [c.task, i + 1]));
      }
      error = null;
    } catch (e) { if (alive) error = errMsg(e); }
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

  async function run(command: Command) {
    if (!board || busy || frozen) return;
    busy = true; error = null;
    let failed: string | null = null;
    try { await coordination.command(board, command); }
    catch (e) { failed = errMsg(e); }
    // Refreshing clears the last load error; a refused command must stay visible.
    await refresh();
    if (failed) error = failed;
    busy = false;
  }
  const isOwner = $derived(board !== null && board.owner === principal && (scopes === null || scopes.includes("maintain")));
  const canPick = $derived(isOwner || (board !== null && board.members.includes(principal) && writesBranch && (scopes === null || scopes.includes("edit"))));
  const goals = $derived(board ? Object.values(board.goals) : []);
  const facts = $derived(board ? Object.values(board.facts) : []);
  const openAttempts = $derived(board ? Object.values(board.attempts).filter((a) => !a.outcome) : []);
  const reserved = $derived(openAttempts.reduce((sum, a) => sum + a.reserved, 0));
  const certifiedRuns = $derived(board ? Object.values(board.runs).filter((r) => r.status === "certified") : []);
  const onRoute = $derived(new Set(certifiedRuns.flatMap((r) => r.route.steps.map((s) => s.certificate_id))));
  const name = (goal: string) => (board ? goalName(board, goal) : goal);
  const failures = $derived(jobs.filter((j) => j.status === "failed").slice(0, 5));
  const statusOf = (goal: string) => board?.goals[goal]?.status ?? "insufficient";
  const view = $derived(board && branch ? branchView(board, branch.branch) : null);
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
    if (!error) { noteFor = null; noteText = ""; }
  }
  const pickedBy = (fact: string) =>
    Object.entries(board?.branches ?? {}).filter(([, s]) => Object.values(s.picks).includes(fact)).map(([name]) => name);
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
    {#each [["overview", "Proof overview"], ["tasks", "Task board"], ["decompositions", "Decompositions"], ["review", "Review"]] as [key, label]}
      <button role="tab" aria-selected={tab === key} onclick={() => (tab = key as Tab)}>{label}</button>
    {/each}
  </div>
  <div class="body">
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if !board}
      <p class="muted">{boards.length ? "Loading..." : "No project in this database yet. Open the root theorem's Lean node and use “Submit to LeanGround”."}</p>
    {:else if tab === "overview"}
      <section aria-label="Proof overview">
        <h3>{board.title} <span class="status" data-status={board.root ? statusOf(board.root) : "insufficient"}>{board.root ? statusOf(board.root) : "binding"}</span></h3>
        {#if frozen}<p class="warn" role="status">{frozen}</p>{/if}
        {#if view?.request.stale}<p class="warn" role="status">This branch's document changed after it was converted: its results stay in history but cannot certify the new text. Submit the root node again to convert the branch anew.</p>{/if}
        {#if view?.request.error}<p class="error">This branch: {view.request.error}</p>{/if}
        {#if board.sync_error}<p class="error">Sync: {board.sync_error}</p>{/if}
        {#if board.project}
          {#if branch && !view && !frozen}
            <p class="muted">This branch is not attached to the project yet.</p>
            <button disabled={busy || !board.ready} onclick={() => void run({ type: "attach", branch: branch.branch })}>Attach this branch</button>
          {/if}
          <table aria-label="Branches">
            <thead><tr><th>Branch</th><th>State</th><th>Picked decompositions</th><th title="Whether this branch's route reaches complete proofs">Route</th></tr></thead>
            <tbody>
              {#each Object.entries(board.branches ?? {}) as [name, s] (name)}
                <tr class:current={name === branch?.branch}>
                  <td>{name}</td>
                  <td>{s.request.bound ? (s.request.stale ? "stale" : "attached") : s.request.error ?? "converting"}</td>
                  <td>{Object.keys(s.picks).length}</td>
                  <td>{s.request.bound && board.root ? (routeCloses(board, s.picks) ? "closed" : "open") : ""}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        {#if !board.ready && !board.sync_error}<p class="muted">Converting nodes and submitting them to LeanGround...</p>{/if}
        <dl>
          <dt>Owner</dt><dd>{board.owner}</dd>
          <dt>Members</dt><dd>{board.members.join(", ")}</dd>
          <dt>Budget</dt><dd>{board.spent} spent · {reserved} reserved · {board.budget} total</dd>
          <dt>Trust</dt><dd>{board.minimum_trust}</dd>
          {#if board.project}
            <dt>Review</dt>
            <dd>
              {board.review === "none" ? "new decompositions are active at once" : "new decompositions wait for the owner's review"}
              {#if isOwner && !frozen}
                <button disabled={busy} onclick={() => void run({ type: "policy", review: board?.review === "none" ? "required" : "none" })}>{board.review === "none" ? "Require review" : "Waive review"}</button>
              {/if}
            </dd>
          {/if}
          <dt>Last sync</dt><dd>{board.last_sync ? new Date(board.last_sync).toLocaleTimeString() : "never"}</dd>
        </dl>
        <table>
          <thead><tr><th>Node</th><th>Role</th><th>State</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {#each Object.values(view?.nodes ?? {}) as n (n.node)}
              <tr>
                <td><button class="link" onclick={() => onOpenNode?.(n.node)}>{n.title}</button></td>
                <td>{n.role}</td>
                <td title={n.details ?? ""}>{n.state}{n.reason ? ` · ${n.reason}` : ""}</td>
                <td>{#if n.goal}<span class="status" data-status={statusOf(n.goal)}>{statusOf(n.goal)}</span>{/if}</td>
                <td>{#if n.role === "theorem" && !frozen}<button title="Read this node again from the branch and submit its current proof" disabled={busy || !board.ready} onclick={() => void run({ type: "submit_node", node: n.node, ...here })}>Resubmit</button>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if failures.length}
          <h4>Recent failures</h4>
          <ul class="failures">{#each failures as j}<li><code>{j.kind}</code> {j.error}</li>{/each}</ul>
        {/if}
        <button disabled={busy || !!frozen} onclick={() => void run({ type: "sync" })}>Sync now</button>
      </section>
    {:else if tab === "tasks"}
      <section aria-label="Task board">
        <div class="controls">
          <label>Allocation <input type="number" min="0" bind:value={allocation} /></label>
          <label>Lease (s) <input type="number" min="30" max="3600" bind:value={ttl} /></label>
        </div>
        <table>
          <thead><tr><th title="Recommended order: needed by the routes closest to closing, fewest failures first">Next</th><th>Goal</th><th>Kind</th><th>Status</th><th>Lease</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {#each Object.values(board.tasks).filter((t) => t.state !== "cancelled").sort((x, y) => (ranking.get(x.id) ?? Infinity) - (ranking.get(y.id) ?? Infinity)) as t (t.id)}
              {@const a = t.attempt ? board.attempts[t.attempt] : undefined}
              {@const notes = board.goals[t.goal]?.notes ?? []}
              <tr>
                <td>{ranking.has(t.id) ? `#${ranking.get(t.id)}` : ""}</td>
                <td>{name(t.goal)}{#if board.negations?.[t.goal]} <span class="muted">refutes {name(board.negations[t.goal])}</span>{/if}</td>
                <td>{t.kind}</td>
                <td>
                  <span class="status" data-status={statusOf(t.goal)}>{statusOf(t.goal)}</span>
                  {#if !active.has(t.goal)}<span class="status" title="No active decomposition leads to this goal yet (for example, one awaiting review), so its task cannot be claimed">inactive</span>{/if}
                </td>
                <td>{#if a}{a.actor} · {Math.max(0, Math.round((a.expires - now()) / 1000))}s{:else}ready{/if}</td>
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
                  {#if !a && statusOf(t.goal) !== "certified"}
                    <button disabled={busy || !!frozen || !active.has(t.goal)} onclick={() => void run({ type: "claim", task: t.id, allocation, ttl })}>Claim</button>
                  {:else if a && a.actor === me}
                    <button disabled={busy || !!frozen} onclick={() => void run({ type: "heartbeat", attempt: a.id, epoch: a.epoch, ttl })}>Extend</button>
                    <button disabled={busy || !!frozen} onclick={() => void run({ type: "finish", attempt: a.id, epoch: a.epoch, spent: 0, outcome: "released" })}>Release</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if Object.keys(board.attempts).length}
          <table aria-label="Budget by participant">
            <thead><tr><th>Participant</th><th>Attempts</th><th>Spent</th><th>Reserved</th></tr></thead>
            <tbody>
              {#each spentBy(board) as row (row.actor)}
                <tr><td>{row.actor}</td><td>{row.attempts}</td><td>{row.spent}</td><td>{row.reserved}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}
        {#if isOwner}
          <p class="muted">Add a decomposition task for a goal:</p>
          <div class="controls">
            {#each goals.filter((g) => g.status !== "certified").slice(0, 20) as g (g.key)}
              <button disabled={busy || !!frozen} onclick={() => void run({ type: "task", goal: g.key, kind: "decompose", priority: 0 })}>Decompose {name(g.key)}</button>
            {/each}
          </div>
        {/if}
      </section>
    {:else if tab === "decompositions"}
      <section aria-label="Decompositions">
        <p class="muted">A decomposition is a conditional certificate: its goal follows from its premises. Only active ones are scheduled and assembled: proposed ones wait for the owner's review, paused and retired ones stay as facts. Each branch's route uses the decompositions it picked; other goals are chosen automatically.</p>
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
          <ul class="facts">
            {#each facts.filter((f) => f.goal === g.key) as f (f.id)}
              <li class:paused={f.state !== "active"} class:unavailable={!f.available}>
                <code title={f.id}>{f.id.slice(0, 10)}</code>
                {#if f.premises.length}⇐ {f.premises.map(name).join(", ")}{:else}complete proof{/if}
                · {f.trust} · {f.state}{f.available ? "" : " · no longer shared"}
                {#if f.refuted_by}<span class="warn">· its premise {name(f.refuted_by)} is false</span>{/if}
                {#if f.premises.includes(f.goal)}<span class="warn" title={f.retired_reason === "premise_is_goal" ? "A premise is the goal itself, so it was retired on arrival" : ""}>cycle</span>{/if}
                {#if f.description}<span class="description">· {f.description}</span>{/if}
                {#if f.submitter}<span class="muted">· by {f.submitter}</span>{/if}
                {#if f.review}<span class="muted" title={f.review.comment ?? ""}>· {f.review.state} by {f.review.actor}{f.review.comment ? `: ${f.review.comment}` : ""}</span>{/if}
                {#if onRoute.has(f.id)}<span class="route">on route</span>{/if}
                {#each pickedBy(f.id) as name}<span class="route">picked by {name}</span>{/each}
                {#if canPick && view && board.project && branch}
                  {#if view.picks[f.goal] === f.id}
                    <button disabled={busy || !!frozen} onclick={() => void run({ type: "pick", branch: branch.branch, goal: f.goal, certificate: null })} title="Let assembly choose this goal's decomposition">Unpick</button>
                  {:else if f.state === "active"}
                    <button disabled={busy || !!frozen} onclick={() => void run({ type: "pick", branch: branch.branch, goal: f.goal, certificate: f.id })} title="This branch's route uses this decomposition">Use on this branch</button>
                  {/if}
                {/if}
                {#if isOwner && f.state !== "refuted"}
                  {#each ["active", "paused", "retired"] as const as state}
                    {#if state !== f.state}<button disabled={busy || !!frozen} onclick={() => void run({ type: "decomposition", certificate: f.id, state })}>{state === "active" ? "Activate" : state === "paused" ? "Pause" : "Retire"}</button>{/if}
                  {/each}
                {/if}
              </li>
            {/each}
          </ul>
        {/each}
      </section>
    {:else}
      <section aria-label="Review">
        {#if isOwner}
          {#if board.project}<p class="muted">Assembly follows the route picked by branch {branch?.branch}; accepting writes into the run's branch.</p>{/if}
          <button disabled={busy || !!frozen || !board.root || (board.project ? !view?.request.bound || !routeCloses(board, view.picks) : statusOf(board.root) === "insufficient")} onclick={() => void run({ type: "assemble", component: "lean-worker", ...here })}>Assemble a route</button>
        {/if}
        {#each Object.values(board.runs) as r (r.id)}
          {@const target = r.branch ? board.branches?.[r.branch] : view}
          <article class="run">
            <h4>Assembly {r.id.slice(0, 8)}{r.branch ? ` · ${r.branch}` : ""} · <span class="status" data-status={r.status === "certified" ? "certified" : "insufficient"}>{r.status}</span></h4>
            {#if r.failure}<p class="error">{r.failure}{r.retryable ? " (retryable)" : ""}</p>{/if}
            <ol>{#each r.route.steps as s}<li>{name(board.facts[s.certificate_id]?.goal ?? "")} <code>{s.certificate_id.slice(0, 10)}</code></li>{/each}</ol>
            {#if isOwner && r.status === "failed" && r.retryable}<button disabled={busy || !!frozen} onclick={() => void run({ type: "retry", run: r.id })}>Retry same plan</button>{/if}
            {#if isOwner && r.status === "certified"}
              <button disabled={busy || !!frozen || !!target?.request.stale} onclick={() => void run({ type: "accept", run: r.id })} title={`Write the certified sources back to ${r.branch ? `branch ${r.branch}` : "the document"} in one batch`}>Accept and write back</button>
            {/if}
          </article>
        {/each}
        {#each Object.values(view?.writebacks ?? {}) as w (w.batch_id)}
          <article class="batch" data-status={w.status}>
            <h4>Writeback {w.batch_id.slice(3, 11)} · {w.status}</h4>
            {#if w.status === "aborted"}<p class="error">{w.reason}: {w.details}. Nothing was written.</p>{/if}
            {#if w.contract}
              <ul>{#each w.contract.operations as o}<li>{o.kind.replaceAll("_", " ")} <button class="link" onclick={() => onOpenNode?.(o.node_id)}>{view?.nodes[o.node_id]?.title ?? o.node_id.slice(0, 8)}</button></li>{/each}</ul>
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
  .route { color:var(--mdc-accent); margin-left:.3rem; }
  tr.current td:first-child { font-weight:600; color:var(--mdc-accent); }
  .facts li.paused { opacity:.6; }
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
  .run, .batch { border:1px solid var(--mdc-border); border-radius:var(--mdc-radius-sm); padding:.5rem .75rem; margin:.6rem 0; }
  .batch[data-status="aborted"] { border-color:var(--mdc-error); }
  button { cursor:pointer; }
</style>
