// Project stage 6 (docs/mathdoc.md §2.7.7): LeanGround calls that run Lean may take as long as
// LeanGround allows, timeouts and refusals are retried with backoff, a job interrupted by a
// LeanGround outage completes once it is back, and TerminusDB's rolled-back conflicts are resent.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LeanGround, RemoteError } from "../src/remote.js";
import { Terminus } from "../src/docs/terminus.js";
import { JOB_TRIES, Store, retryDelay } from "../src/store.js";
import { main } from "../src/cli.js";
import { board } from "./fixtures.js";
import { actors, client, deploy, env, isolated } from "./harness.js";
import { leangroundDouble } from "./leanground-double.js";

const documents = Boolean(env.dsn && env.terminus && env.terminusPassword);

test("LeanGround calls that run Lean wait longer than reads; failures are retryable", async () => {
  // Every response takes 400 ms.
  const slow = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 400);
  });
  slow.listen(0, "127.0.0.1");
  await once(slow, "listening");
  const url = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;
  try {
    // A Lean limit of 150 ms: submit times out, a read (30 s limit) does not.
    const lean = new LeanGround(url, "t", 150);
    await assert.rejects(
      lean.fact("submit", {}),
      (e: unknown) =>
        e instanceof RemoteError &&
        e.code === "leanground_timeout" &&
        e.retryable,
    );
    assert.deepEqual(await lean.fact("read", {}), {});
    assert.deepEqual(
      await new LeanGround(url, "t", 2000).fact("submit", {}),
      {},
    );
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
  const closed = new LeanGround("http://127.0.0.1:9", "t");
  await assert.rejects(
    closed.fact("read", {}),
    (e: unknown) =>
      e instanceof RemoteError &&
      e.code === "leanground_unavailable" &&
      e.retryable,
  );
});

test("TerminusDB requests rolled back by its own retry limit are resent", async () => {
  const conflict = () =>
    new Response(
      JSON.stringify({
        "api:message": "Transaction retry count exceeded in internal operation",
        "api:status": "api:server_error",
      }),
      { status: 500 },
    );
  let calls = 0;
  const flaky = (failures: number, other = false) => {
    calls = 0;
    return (async () => {
      calls++;
      if (calls <= failures)
        return other ? new Response("boom", { status: 500 }) : conflict();
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
  };
  const config = { url: "http://terminus.test", user: "admin", password: "x" };
  // Two conflicts, then success: three sends.
  assert.equal(
    (await new Terminus(config, flaky(2)).request("GET", "db")).status,
    200,
  );
  assert.equal(calls, 3);
  // Four conflicts in a row: the first send and three resends, then the error.
  await assert.rejects(
    new Terminus(config, flaky(4)).request("GET", "db"),
    /Transaction retry count exceeded/,
  );
  assert.equal(calls, 4);
  // Other server errors are not resent.
  await assert.rejects(
    new Terminus(config, flaky(1, true)).request("GET", "db"),
    /boom/,
  );
  assert.equal(calls, 1);
});

test(
  "retryable job failures back off for JOB_TRIES tries",
  { skip: !env.dsn },
  async () => {
    const schema = await isolated();
    const store = new Store(schema.url);
    await store.migrate();
    try {
      const b = board(`p-${randomUUID().slice(0, 8)}`);
      await store.create(b);
      await store.pool.query("DELETE FROM mdc_job WHERE project=$1", [b.id]);
      await store.apply(b.id, "alice", null, "s", { type: "sync" });
      const waits: number[] = [];
      for (let i = 0; i < JOB_TRIES; i++) {
        await store.pool.query(
          "UPDATE mdc_job SET available_at=now() WHERE project=$1",
          [b.id],
        );
        const j = (await store.claim())!;
        assert.equal(j.tries, i + 1);
        await store.fail(j, "leanground_unavailable", true);
        const row = (
          await store.pool.query(
            "SELECT status, extract(epoch FROM available_at - now()) AS wait FROM mdc_job WHERE id=$1",
            [j.id],
          )
        ).rows[0];
        if (i + 1 < JOB_TRIES) {
          assert.equal(row.status, "queued");
          waits.push(Math.round(Number(row.wait)));
        } else assert.equal(row.status, "failed");
      }
      assert.deepEqual(waits, [5, 15, 45, 135, 405, 900, 900]);
      assert.deepEqual(
        waits,
        waits.map((_, i) => retryDelay(i + 1)),
      );
      // A failure that cannot succeed later is final at once.
      await store.apply(b.id, "alice", null, "s2", { type: "sync" });
      const j = (await store.claim())!;
      await store.fail(j, "invalid_upstream_contract", false);
      assert.equal(
        (
          await store.pool.query("SELECT status FROM mdc_job WHERE id=$1", [
            j.id,
          ])
        ).rows[0].status,
        "failed",
      );
    } finally {
      await store.pool.end();
      await schema.close();
    }
  },
);

test(
  "a proof submitted while LeanGround is down is checked once it is back",
  { skip: !documents, timeout: 120000 },
  async () => {
    let lean = await leangroundDouble();
    const port = Number(new URL(lean.url).port);
    const schema = await isolated();
    const dep = await deploy(schema.url, { url: lean.url, token: "double" });
    const db = `down${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const http = client(() => dep, db);
    const dir = await mkdtemp(join(tmpdir(), "mdc-down-"));
    const mdc = (...argv: string[]) =>
      main(
        argv,
        {
          MDC_URL: dep.base,
          MDC_TOKEN: actors.alice.token,
          MDC_PROJECT: `${db}/main`,
        },
        async () => "",
        { cwd: dir, sleep: () => delay(50) },
      ) as Promise<any>;
    try {
      await http.ok("alice", "POST", "/api/projects", {
        action: "init",
        name: db,
      });
      const root = await http.node("one", "theorem one_eq : 1 = 1 := sorry\n");
      await http.ok("alice", "PUT", `/api/coordination/environments/${db}`, {
        base_key: 1,
      });
      const id = (
        await http.ok(
          "alice",
          "POST",
          "/api/coordination/projects",
          {
            document: { database: db, branch: "main", node: root },
            budget: 10,
          },
          { "idempotency-key": "c" },
        )
      ).id as string;
      await dep.drain();
      const pulled = await mdc("pull", "one");
      const file = join(dir, pulled.file);
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace(
          ":= by\n  sorry\n",
          ":= by\n  rfl\n",
        ),
      );

      // LeanGround goes away; the submission is taken and its job waits instead of failing.
      await lean.close();
      const sent = await mdc("prove", pulled.file);
      assert.equal(sent.status, "queued");
      await dep.drain();
      const job = () =>
        http.ok(
          "alice",
          "GET",
          `/api/coordination/projects/${id}/jobs/${sent.job}`,
        );
      let j = await job();
      assert.deepEqual(
        [j.status, j.error],
        ["queued", "leanground_unavailable"],
      );

      // Back on the same address: the next try (after 5 s) checks the proof.
      lean = await leangroundDouble(port);
      await delay(5200);
      await dep.drain();
      j = await job();
      assert.equal(j.status, "done", JSON.stringify(j));
      const again = await mdc("prove", pulled.file);
      assert.deepEqual([again.replayed, again.status], [true, "certified"]);
    } finally {
      await lean.close();
      await dep.close();
      await schema.close();
    }
  },
);
