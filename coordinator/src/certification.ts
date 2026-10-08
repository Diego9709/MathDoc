// The formal-certification dimension of a node's status (docs/mathdoc.md §4.5), computed from the
// database's project boards and the branch's stage 4 proof requests. Local checks are a
// separate dimension.
import { leanContentSha256 } from "./contracts.js";
import type { Board } from "./domain.js";
import type { NodeBinding } from "./proof.js";
import type { Node } from "./docs/model.js";

export type LeanCertification =
  | null
  | { status: "not_submitted" }
  | {
      status: "insufficient" | "derivable" | "certified" | "stale" | "rejected";
      project: string;
      /** The branch whose conversion of this node is shown. */
      branch?: string;
      goal?: string;
      minimum_trust: string;
      checked_at: string | null;
      /** Local derivation over project-visible facts is never truncated. */
      truncated: boolean;
      reason?: string;
      details?: string;
    };

export type CertificationLookup = (node: Node) => LeanCertification;

interface Source {
  board: Board;
  branch?: string;
  nodes: Record<string, NodeBinding>;
}
/** Current project boards first, then superseded ones, then stage 4 requests; then the latest revision. */
const rank = (b: Board) => [
  b.project ? (b.project.superseded ? 1 : 2) : 0,
  b.revision,
];
const better = (a: Board, c: Board) => {
  const [x, y] = [rank(a), rank(c)];
  return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1];
};

/**
 * A node shows its own branch's conversion. A branch that is not attached, or that never
 * converted the node, shares the conversion of another attached branch when the node and
 * the definitions its statement uses have the same Lean text there.
 */
export function certificationLookup(
  boards: Board[],
  nodes: Map<string, Node>,
  branch: string,
): CertificationLookup {
  const own = new Map<string, Source>();
  const shared = new Map<string, Source[]>();
  const keep = (map: Map<string, Source>, id: string, s: Source) => {
    const prior = map.get(id);
    if (!prior || better(s.board, prior.board)) map.set(id, s);
  };
  for (const b of boards) {
    if (b.project)
      for (const [name, br] of Object.entries(b.branches ?? {}))
        for (const id of Object.keys(br.nodes)) {
          const s = { board: b, branch: name, nodes: br.nodes };
          if (name === branch) keep(own, id, s);
          else shared.set(id, [...(shared.get(id) ?? []), s]);
        }
    else if (b.request)
      for (const id of Object.keys(b.nodes ?? {}))
        keep(own, id, { board: b, nodes: b.nodes! });
  }
  const sha = (id: string) => {
    const n = nodes.get(id);
    return n ? leanContentSha256(n) : null;
  };
  const changed = (s: Source, id: string) =>
    sha(id) !== s.nodes[id].lean_content_sha256 ||
    (s.nodes[id].definition_nodes ?? []).some(
      (d) => sha(d) !== s.nodes[d]?.lean_content_sha256,
    );
  return (node) => {
    if (!node.blocks.some((b) => b.srctype === "lean")) return null;
    const id = node.fnode;
    let source = own.get(id);
    if (!source?.board.project) {
      // Prefer an identical conversion on the project board to a stage 4 request.
      const same = (shared.get(id) ?? []).filter((s) => !changed(s, id));
      for (const s of same)
        if (!source?.board.project || better(s.board, source.board)) source = s;
    }
    if (!source) return { status: "not_submitted" };
    const { board: b, nodes: bindings } = source;
    const binding = bindings[id];
    const base = {
      project: b.id,
      ...(source.branch ? { branch: source.branch } : {}),
      minimum_trust: b.minimum_trust,
      checked_at: b.last_sync ? new Date(b.last_sync).toISOString() : null,
      truncated: false,
    };
    if (changed(source, id))
      return {
        ...base,
        status: "stale",
        details:
          "the Lean text or a definition it uses changed after submission",
      };
    if (binding.state === "rejected" || !binding.goal)
      return {
        ...base,
        status: "rejected",
        reason: binding.reason,
        details: binding.details,
      };
    return {
      ...base,
      status: b.goals[binding.goal]?.status ?? "insufficient",
      goal: binding.goal,
    };
  };
}
