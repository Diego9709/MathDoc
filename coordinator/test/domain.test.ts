import test from "node:test";
import assert from "node:assert/strict";
import {
  ingest,
  selectRoute,
  command,
  expire,
  activeGoals,
  commandSchema,
} from "../src/domain.js";
import { board, fact, projectBoard } from "./fixtures.js";
test("shared premises deduplicate, cycles cannot prove themselves, pause only affects selected route", () => {
  const b = board();
  ingest(b, fact("t", "T", ["A", "B"]));
  ingest(b, fact("a", "A", ["B"]));
  ingest(b, fact("cycle", "B", ["T"]));
  assert.equal(Object.keys(b.goals).length, 3);
  assert.equal(Object.keys(b.tasks).length, 3);
  assert.equal(b.goals.T.status, "insufficient");
  assert.throws(() => selectRoute(b), /no_active_route/);
  ingest(b, fact("b", "B"));
  assert.equal(b.goals.T.status, "derivable");
  assert.equal(selectRoute(b).steps.length, 3);
  command(
    b,
    "alice",
    { type: "decomposition", certificate: "a", state: "paused" },
    0,
  );
  assert.equal(b.goals.T.status, "derivable");
  assert.throws(() => selectRoute(b), /no_active_route/);
  assert(activeGoals(b).has("B"));
  ingest(b, fact("a2", "A"));
  assert(selectRoute(b).steps.some((s) => s.certificate_id === "a2"));
});
test("leases fence old worker, expired allocation is charged, agent outcomes never certify goals", () => {
  const b = board();
  const task = Object.values(b.tasks)[0];
  const a = command(
    b,
    "alice",
    { type: "claim", task: task.id, allocation: 40, ttl: 30 },
    0,
  ).result as { id: string; epoch: number };
  assert.throws(
    () =>
      command(
        b,
        "bob",
        { type: "claim", task: task.id, allocation: 10, ttl: 30 },
        1,
      ),
    /task_unavailable/,
  );
  expire(b, 30000);
  assert.equal(b.spent, 40);
  const second = command(
    b,
    "bob",
    { type: "claim", task: task.id, allocation: 50, ttl: 30 },
    31000,
  ).result as { id: string; epoch: number };
  assert.throws(
    () =>
      command(
        b,
        "alice",
        {
          type: "finish",
          attempt: a.id,
          epoch: a.epoch,
          spent: 10,
          outcome: "submitted",
        },
        32000,
      ),
    /stale_lease/,
  );
  command(
    b,
    "bob",
    {
      type: "finish",
      attempt: second.id,
      epoch: second.epoch,
      spent: 15,
      outcome: "submitted",
    },
    32000,
  );
  assert.equal(b.spent, 55);
  assert.equal(b.goals.T.status, "insufficient");
  assert.throws(
    () =>
      command(
        b,
        "alice",
        { type: "claim", task: task.id, allocation: 46, ttl: 30 },
        33000,
      ),
    /budget_exhausted/,
  );
});
test("reject private, foreign environment, low trust and non-member state updates", () => {
  const b = board();
  const f = fact("a", "T");
  f.access.visibility = "private";
  assert.throws(() => ingest(b, f), /fact_not_shared/);
  f.access.visibility = "project";
  f.request.goal.base_fingerprint = "other";
  assert.throws(() => ingest(b, f), /environment_mismatch/);
  f.request.goal.base_fingerprint = "base";
  f.trust = "claimed";
  assert.throws(() => ingest(b, f), /trust_rejected/);
  assert.throws(
    () => command(b, "mallory", { type: "notes", notes: "bad" }, 0),
    /not_found/,
  );
  assert.throws(
    () => command(b, "bob", { type: "assemble", component: "lean-worker" }, 0),
    /owner_required/,
  );
});
test("member removal fences leases immediately; owner remains and budget is conservative", () => {
  const b = board();
  const t = Object.values(b.tasks)[0];
  const a = command(
    b,
    "bob",
    { type: "claim", task: t.id, allocation: 35, ttl: 300 },
    0,
  ).result as { id: string };
  command(b, "alice", { type: "members", members: [] }, 1000);
  assert.deepEqual(b.members, ["alice"]);
  assert.equal(b.ready, false);
  assert.equal(b.attempts[a.id].outcome, "revoked");
  assert.equal(b.spent, 35);
  assert.throws(
    () => command(b, "bob", { type: "notes", notes: "after removal" }, 2000),
    /not_found/,
  );
  assert.equal(
    command(b, "alice", { type: "sync" }, 2000).job?.kind,
    "provision",
  );
});
test("retry pins the original plan and creates a new attempt identity", () => {
  const b = board();
  b.runs.first = {
    id: "first",
    route: { root: "t", steps: [] },
    component: "lean-worker",
    plan_id: "fixed",
    status: "failed",
    retryable: true,
  };
  const out = command(b, "alice", { type: "retry", run: "first" }, 0)
    .result as { id: string; plan_id: string };
  assert.notEqual(out.id, "first");
  assert.equal(out.plan_id, "fixed");
  assert.throws(
    () => command(b, "alice", { type: "retry", run: "first" }, 0),
    /assembly_in_progress/,
  );
});
test("project boards: a branch's picks choose its route; picks are checked and owner-only", () => {
  const b = projectBoard();
  ingest(b, fact("t1", "T", ["A", "B"]));
  ingest(b, fact("t2", "T", ["C"]));
  for (const g of ["A", "B", "C"]) ingest(b, fact(g.toLowerCase(), g));
  // Unpicked goals prefer fewer premises; a pick is strict.
  assert.equal(selectRoute(b).root, "t2");
  assert.equal(selectRoute(b, { T: "t1" }).root, "t1");
  b.facts.t1.state = "paused";
  assert.throws(() => selectRoute(b, { T: "t1" }), /no_active_route/);
  b.facts.t1.state = "active";
  const pick = (who: string, branch: string, certificate: string) =>
    command(b, who, { type: "pick", branch, goal: "T", certificate }, 0);
  assert.throws(() => pick("bob", "main", "t1"), /owner_required/);
  assert.throws(() => pick("alice", "main", "a"), /certificate_goal_mismatch/);
  assert.throws(() => pick("alice", "alt", "t1"), /branch_not_attached/);
  pick("alice", "main", "t1");
  const run = command(
    b,
    "alice",
    { type: "assemble", component: "lean-worker", branch: "main" },
    0,
  ).result as { branch: string; route: { root: string } };
  assert.deepEqual([run.branch, run.route.root], ["main", "t1"]);
  // Assembly on a project board names its branch.
  b.runs = {};
  assert.throws(
    () =>
      command(b, "alice", { type: "assemble", component: "lean-worker" }, 0),
    /branch_not_attached/,
  );
});
test("project boards: attach adds the branch; stage 4 requests and superseded boards are read-only", () => {
  const b = projectBoard();
  const out = command(b, "bob", { type: "attach", branch: "alt" }, 0);
  assert.deepEqual(out.job, { kind: "attach", payload: { branch: "alt" } });
  assert.equal(b.branches!.alt.request.node, b.project!.root_node);
  assert.equal(b.branches!.alt.request.bound, false);
  assert.throws(
    () =>
      command(
        b,
        "bob",
        { type: "submit_node", branch: "alt", node: b.project!.root_node },
        0,
      ),
    /branch_not_bound/,
  );
  assert.throws(
    () => commandSchema.parse({ type: "attach", branch: "__proto__" }),
    /reserved branch name/,
  );
  b.project!.superseded = true;
  assert.throws(
    () => command(b, "alice", { type: "sync" }, 0),
    /project_superseded/,
  );
  const legacy = board();
  legacy.request = {
    database: "d",
    branch: "main",
    node: "n",
    environment_id: "e",
    bound: true,
    stale: false,
  };
  assert.throws(
    () => command(legacy, "alice", { type: "notes", notes: "x" }, 0),
    /proof_request_read_only/,
  );
  // A free-standing board (no document binding) is unaffected.
  command(board(), "alice", { type: "notes", notes: "x" }, 0);
});
