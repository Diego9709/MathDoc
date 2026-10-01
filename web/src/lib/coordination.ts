// Collaboration API (plan §6.3): the same /api/coordination endpoints serve people and
// agents. Commands carry the project revision (If-Match) and an idempotency key.
import { fetchJson } from "./api";
import { projectName } from "./project-path";

export type Trust = "claimed" | "audited" | "trusted";
export interface EnvironmentInput {
  base_key: number;
  context: Record<string, string[]>;
  options: Record<string, string | number | boolean>;
  minimum_trust: Trust;
}
export interface Environment extends EnvironmentInput {
  base: Record<string, unknown>;
  environment_id: string;
  replaces_environment_id?: string;
  updated_by: string;
}
export interface Goal { key: string; statement: string; status: "insufficient" | "derivable" | "certified"; identity?: unknown }
export interface Fact { id: string; goal: string; premises: string[]; trust: Trust; state: "active" | "paused" | "retired"; available: boolean }
export interface Task { id: string; goal: string; kind: "prove" | "decompose" | "formalize"; priority: number; state: "ready" | "leased" | "cancelled"; epoch: number; attempt?: string }
export interface Attempt { id: string; task: string; actor: string; epoch: number; expires: number; reserved: number; spent: number; outcome?: string }
export interface Run {
  id: string; component: string; plan_id?: string; status: "queued" | "running" | "failed" | "certified";
  /** Project boards: the branch whose route was assembled and which receives the writeback. */
  branch?: string;
  certification_id?: string; failure?: string; retryable?: boolean;
  route: { root: string; steps: { certificate_id: string; providers: Record<string, string> }[] };
}
export interface NodeBinding {
  node: string; title: string; role: "definition" | "theorem" | "unsupported";
  state: "open" | "submitted" | "registered" | "rejected" | "pending" | "certified";
  goal?: string; conclusion?: string; premises?: string[]; definition_ids?: string[];
  certificate?: string; reason?: string; details?: string;
}
export interface Writeback {
  batch_id: string; run: string; status: "committed" | "aborted"; version?: string;
  reason?: string; details?: string; created: string[]; updated: string[];
  contract?: { operations: { kind: string; node_id: string; certification_id?: string; definition_id?: string }[] };
}
export interface ProofRequest {
  database: string; branch: string; node: string; environment_id: string; bound: boolean;
  stale: boolean; identity?: string; error?: string; checked_version?: string;
}
/** One branch attached to a project board. */
export interface BranchState {
  request: ProofRequest;
  nodes: Record<string, NodeBinding>;
  /** goal → certificate this branch's route uses. */
  picks: Record<string, string>;
  writebacks: Record<string, Writeback>;
}
export interface Board {
  id: string; title: string; owner: string; members: string[]; revision: number;
  root: string; minimum_trust: Trust; notes: string; budget: number; spent: number;
  ready: boolean; last_sync?: number; sync_error?: string;
  goals: Record<string, Goal>; facts: Record<string, Fact>; tasks: Record<string, Task>;
  attempts: Record<string, Attempt>; runs: Record<string, Run>;
  /** A database's project: one root theorem, branches as routes over shared goals. */
  project?: { database: string; environment_id: string; root_node: string; superseded?: boolean };
  /** Branches the reader can read. */
  branches?: Record<string, BranchState>;
  /** Stage 4 per-branch proof requests (read-only). */
  request?: ProofRequest;
  nodes?: Record<string, NodeBinding>;
  writebacks?: Record<string, Writeback>;
}
export type Command =
  | { type: "sync" }
  | { type: "claim"; task: string; allocation: number; ttl: number }
  | { type: "heartbeat"; attempt: string; epoch: number; ttl: number }
  | { type: "finish"; attempt: string; epoch: number; spent: number; outcome: "no_progress" | "submitted" | "execution_failed" | "released" }
  | { type: "task"; goal: string; kind: "prove" | "decompose" | "formalize"; priority: number }
  | { type: "decomposition"; certificate: string; state: "active" | "paused" | "retired" }
  | { type: "attach"; branch: string }
  | { type: "pick"; branch: string; goal: string; certificate: string | null }
  | { type: "submit_node"; node: string; branch?: string }
  | { type: "assemble"; component: "lean-worker"; branch?: string }
  | { type: "retry"; run: string }
  | { type: "accept"; run: string }
  | { type: "notes"; notes: string };

const base = "/api/coordination";
const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
export function currentBranch(): { database: string; branch: string } | null {
  const name = projectName();
  if (!name) return null;
  const [database, branch] = name.split("/");
  return { database, branch };
}

export const coordination = {
  me: () => fetchJson<{ actor: string; admin: boolean }>("/api/me"),
  environment: (database: string) =>
    fetchJson<Environment>(`${base}/environments/${database}`),
  putEnvironment: (database: string, input: EnvironmentInput) =>
    fetchJson<Environment>(`${base}/environments/${database}`, json("PUT", input)),
  projects: (database: string, branch: string, node?: string) =>
    fetchJson<Board[]>(`${base}/projects?${new URLSearchParams({ database, branch, ...(node ? { node } : {}) })}`),
  project: (id: string) => fetchJson<Board>(`${base}/projects/${encodeURIComponent(id)}`),
  create: (input: { document: { database: string; branch: string; node: string }; members: string[]; budget: number; title?: string }) =>
    fetchJson<Board>(`${base}/projects`, json("POST", input, { "idempotency-key": crypto.randomUUID() })),
  command: (board: Pick<Board, "id" | "revision">, command: Command) =>
    fetchJson<{ revision: number; result: unknown; job?: string }>(
      `${base}/projects/${encodeURIComponent(board.id)}/commands`,
      json("POST", command, { "if-match": `"${board.revision}"`, "idempotency-key": crypto.randomUUID() }),
    ),
  jobs: (id: string) =>
    fetchJson<{ id: string; actor: string; kind: string; status: string; tries: number; error: string | null; created_at: string }[]>(
      `${base}/projects/${encodeURIComponent(id)}/jobs`,
    ),
};

/** A branch's view of a board: its own binding on a project board, the request itself on a stage 4 board. */
export function branchView(board: Board, branch: string): BranchState | null {
  if (board.project) return board.branches?.[branch] ?? null;
  if (!board.request) return null;
  return { request: board.request, nodes: board.nodes ?? {}, picks: {}, writebacks: board.writebacks ?? {} };
}
/**
 * Whether a branch's route reaches complete proofs: the root proved through active facts,
 * each picked goal only through its pick (the coordinator's route selection). A goal's own
 * status is shared by all branches; this is the branch's.
 */
export function routeCloses(board: Board, picks: Record<string, string>): boolean {
  const facts = Object.values(board.facts).filter(
    (f) => f.available && f.state === "active" && (!Object.hasOwn(picks, f.goal) || picks[f.goal] === f.id),
  );
  const solved = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of facts)
      if (!solved.has(f.goal) && f.premises.every((p) => solved.has(p))) {
        solved.add(f.goal);
        changed = true;
      }
  }
  return solved.has(board.root);
}
/** Why the board takes no commands, as shown to people; null when it does. */
export function readOnlyReason(board: Board): string | null {
  if (board.request)
    return "This per-branch proof request predates project boards and is read-only. Submit the root theorem to attach the branch to the database's project.";
  if (board.project?.superseded)
    return "The database's proof environment changed, so this project board is read-only. Submit the root theorem again to start a new one.";
  return null;
}
/** A readable name for a goal: a document node proving it, else its statement, else a short key. */
export function goalName(board: Board, goal: string): string {
  const views = [board.nodes ?? {}, ...Object.values(board.branches ?? {}).map((b) => b.nodes)];
  for (const nodes of views) {
    const node = Object.values(nodes).find((n) => n.goal === goal);
    if (node) return node.title;
  }
  return board.goals[goal]?.statement || `${goal.slice(0, 10)}...`;
}
