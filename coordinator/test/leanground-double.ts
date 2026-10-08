// A deterministic contract double of LeanGround's fact API (docs/12 of LeanGround) for
// tests without a Lean kernel. It checks shapes, not proofs: a GoalKey is a hash of the
// statement text and the environment, premises are the source's `sorry` theorems, and an
// assembly always certifies. Results are only as faithful as these rules.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { proposition, scan } from "../src/lean-source.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const BASE = {
  base_id: "double-base",
  base_key: 1,
  root_module: "Init",
  lean_version: "4.0.0",
  lean_githash: "0",
  package_revision: "0",
  package_manifest_hash: "0",
  module_list_hash: "0",
  build_flags_hash: "0",
  platform: "test",
  promotion_generation: 0,
  schema_version: 1,
};

type Body = Record<string, any>;

export async function leangroundDouble(port = 0) {
  const certificates = new Map<string, Body>();
  const definitions = new Map<string, Body>();
  const events: { sequence: number; kind: string; fact_id: string }[] = [];
  const calls: string[] = [];
  const identity = (statement: string, env: Body) => {
    const ctx = digest(env.context ?? {});
    const opts = digest(env.options ?? {});
    return {
      key: digest([statement.replace(/\s+/g, " ").trim(), ctx, opts]),
      base_fingerprint: "base",
      local_context_hash: ctx,
      relevant_options_hash: opts,
    };
  };
  const fail = (reason: string, status = 400) => ({ status, body: { reason } });
  const handle = (
    path: string,
    body: Body,
  ): { status: number; body: unknown } => {
    calls.push(path);
    if (path === "/v1/bases/1")
      return { status: 200, body: { base: { ...BASE, fingerprint: "base" } } };
    const op = path.replace("/v1/facts/", "");
    switch (op) {
      case "project":
        return { status: 200, body: { id: body.id } };
      case "resolve":
        // LeanGround reports the registered definitions the statement references; the
        // double approximates that by name.
        return {
          status: 200,
          body: {
            goal_key: identity(body.proposition, body),
            definitions: (body.definitions ?? []).filter((id: string) => {
              const d = definitions.get(id);
              return d && new RegExp(`\\b${d.name}\\b`).test(body.proposition);
            }),
          },
        };
      case "define": {
        const out = scan(body.request.source).decls.map((d) => {
          const text = body.request.source.slice(d.start, d.end);
          const id = digest(["definition", d.name, text]);
          definitions.set(id, {
            id,
            name: d.name,
            source: text,
            deps: body.request.definitions ?? [],
          });
          return { id, name: d.name };
        });
        return { status: 200, body: { definitions: out } };
      }
      case "submit": {
        const r = body.request;
        const s = scan(r.source);
        const root = s.decls.find((d) => d.name === r.expected_root);
        if (!root?.type) return fail("unsupported_source");
        if (root.sorry) return fail("invalid_bindings");
        const placeholders = s.decls.filter((d) => d.sorry && d !== root);
        if (r.mode === "sketch" && !placeholders.length)
          return fail("no_premises");
        if (r.mode !== "sketch" && placeholders.length)
          return fail("sorry_outside_subgoals");
        const goal = identity(proposition(root), r);
        if (r.goal && r.goal.key !== goal.key)
          return fail("proposition_differs");
        const premises = placeholders.map((d) => ({
          name: d.name,
          goal: identity(proposition(d), r),
        }));
        const id = digest([
          "certificate",
          body.component,
          r.source,
          goal.key,
          r.definitions ?? [],
        ]);
        const record = {
          id,
          goal: goal.key,
          premises: [...new Set(premises.map((p) => p.goal.key))],
          trust: "trusted",
          request: { goal },
          access: body.scope,
          caller_ref: body.caller_ref ?? null,
          source: r.source,
          bindings: [
            { name: root.name, role: "conclusion", goal: goal.key },
            ...premises.map((p) => ({
              name: p.name,
              role: "premise",
              goal: p.goal.key,
            })),
          ],
          definitions: r.definitions ?? [],
        };
        if (!certificates.has(id)) {
          certificates.set(id, record);
          events.push({
            sequence: events.length + 1,
            kind: "certificate",
            fact_id: id,
          });
        }
        return { status: 200, body: record };
      }
      case "read": {
        const store = body.kind === "definition" ? definitions : certificates;
        const value = store.get(body.id);
        return value ? { status: 200, body: value } : fail("not_found", 404);
      }
      case "events": {
        const page = events
          .filter((e) => e.sequence > body.after)
          .slice(0, body.limit ?? 100);
        return {
          status: 200,
          body: {
            cursor: page.at(-1)?.sequence ?? body.after,
            has_more: false,
            events: page,
          },
        };
      }
      case "plan":
        return {
          status: 200,
          body: { id: `plan-${digest(body.route).slice(0, 16)}` },
        };
      case "widen":
        return { status: 200, body: { id: body.id } };
    }
    return fail("unknown", 404);
  };
  // Plans remember their goal so that assemble can certify it.
  const plans = new Map<string, string>();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const path = req.url!.split("?")[0];
    let out: { status: number; body: unknown };
    if (path === "/v1/facts/plan") {
      out = handle(path, body);
      plans.set((out.body as Body).id, body.goal);
    } else if (path === "/v1/facts/assemble") {
      calls.push(path);
      const goal = plans.get(body.plan_id);
      const root = [...certificates.values()].find((c) => c.goal === goal);
      if (!goal || !root) out = fail("unknown_plan", 404);
      else {
        const id = `final-${body.plan_id}`;
        certificates.set(id, {
          ...root,
          id,
          premises: [],
          bindings: root.bindings.filter((b: Body) => b.role === "conclusion"),
        });
        out = {
          status: 200,
          body: {
            plan_id: body.plan_id,
            goal,
            status: "certified",
            certification_id: id,
          },
        };
      }
    } else out = handle(path, body);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    certificates,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
