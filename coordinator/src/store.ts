import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import {
  Board,
  Command,
  command,
  member,
  principalOf,
  requireThat,
} from "./domain.js";
import { ENVIRONMENT_MIGRATION } from "./proof.js";
import { TOKEN_MIGRATION } from "./identity.js";
export interface Job {
  id: string;
  project: string;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  epoch: number;
  tries: number;
}
export const migration = `
CREATE TABLE IF NOT EXISTS mdc_workspace(database text PRIMARY KEY, body jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS mdc_project(id text PRIMARY KEY, body jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS mdc_command(project text NOT NULL REFERENCES mdc_project(id), actor text NOT NULL, key text NOT NULL, hash text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(project,actor,key));
CREATE TABLE IF NOT EXISTS mdc_event(sequence bigserial PRIMARY KEY, project text NOT NULL REFERENCES mdc_project(id), actor text NOT NULL, kind text NOT NULL, revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mdc_job(id text PRIMARY KEY, project text NOT NULL REFERENCES mdc_project(id), actor text NOT NULL, kind text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', epoch integer NOT NULL DEFAULT 0, tries integer NOT NULL DEFAULT 0, expires timestamptz, available_at timestamptz NOT NULL DEFAULT now(), error text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS mdc_job_queue ON mdc_job(status,available_at);
ALTER TABLE mdc_job ADD COLUMN IF NOT EXISTS result jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS mdc_project_scope ON mdc_project((body->'project'->>'database'),(body->'project'->>'environment_id'));
${ENVIRONMENT_MIGRATION}${TOKEN_MIGRATION}`;
// Boards that take part in scheduling: not a stage 4 proof request, not superseded.
const LIVE = `NOT (p.body ? 'request') AND NOT COALESCE((p.body->'project'->>'superseded')::boolean,false)`;
export class Store {
  pool: pg.Pool;
  constructor(dsn: string) {
    this.pool = new pg.Pool({ connectionString: dsn, max: 10 });
  }
  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(682193117)");
      await c.query(migration);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async create(b: Board) {
    await this.transaction(async (c) => {
      await c.query("INSERT INTO mdc_project VALUES($1,$2)", [b.id, b]);
      await this.enqueue(c, b.id, b.owner, "provision", {});
    });
  }
  /**
   * The actor's boards; with a branch, the database's project boards (current first, then
   * superseded) followed by the branch's stage 4 proof requests.
   */
  async list(
    actor: string,
    document?: { database: string; branch: string; node?: string },
  ): Promise<Board[]> {
    if (document)
      return (
        await this.pool.query(
          `SELECT p.body FROM mdc_project p WHERE p.body->'members' ? $1 AND (
             (p.body->'project'->>'database'=$2 AND ($4::text IS NULL OR p.body->'branches'->$3->'nodes' ? $4))
             OR (p.body->'request'->>'database'=$2 AND p.body->'request'->>'branch'=$3 AND ($4::text IS NULL OR p.body->'nodes' ? $4)))
           ORDER BY CASE WHEN ${LIVE} THEN 0 WHEN p.body ? 'project' THEN 1 ELSE 2 END, p.id`,
          [
            principalOf(actor),
            document.database,
            document.branch,
            document.node ?? null,
          ],
        )
      ).rows.map((r) => r.body);
    return (
      await this.pool.query(
        "SELECT body FROM mdc_project WHERE body->'members' ? $1 ORDER BY id",
        [principalOf(actor)],
      )
    ).rows.map((r) => r.body);
  }
  /** Boards that can certify a branch's nodes: the database's project boards and the branch's bound proof requests. */
  async bound(database: string, branch: string): Promise<Board[]> {
    return (
      await this.pool.query(
        `SELECT body FROM mdc_project WHERE body->'project'->>'database'=$1
           OR (body->'request'->>'database'=$1 AND body->'request'->>'branch'=$2 AND (body->'request'->>'bound')::boolean)
         ORDER BY id`,
        [database, branch],
      )
    ).rows.map((r) => r.body);
  }
  /** The database's project board for an environment, if it exists. */
  async project(database: string, environmentId: string) {
    return (
      await this.pool.query(
        "SELECT body FROM mdc_project WHERE body->'project'->>'database'=$1 AND body->'project'->>'environment_id'=$2",
        [database, environmentId],
      )
    ).rows[0]?.body as Board | undefined;
  }
  /**
   * Submit a branch: create the database's project board (its provision job attaches the
   * branch), or attach the branch to the existing board. Replaying (actor, key) with the
   * same request returns the first outcome without queuing another attach.
   */
  async submitBranch(input: {
    actor: string;
    key: string;
    hash: string;
    database: string;
    environmentId: string;
    branch: string;
    create: () => Board;
  }): Promise<{ board: Board; created: boolean }> {
    const { actor, key, hash } = input;
    for (let attempt = 0; ; attempt++)
      try {
        return await this.transaction(async (c) => {
          const row = (
            await c.query(
              "SELECT body FROM mdc_project WHERE body->'project'->>'database'=$1 AND body->'project'->>'environment_id'=$2 FOR UPDATE",
              [input.database, input.environmentId],
            )
          ).rows[0];
          if (!row) {
            const b = input.create();
            await c.query("INSERT INTO mdc_project VALUES($1,$2)", [b.id, b]);
            await this.enqueue(c, b.id, b.owner, "provision", {});
            await c.query("INSERT INTO mdc_command VALUES($1,$2,$3,$4,$5)", [
              b.id,
              actor,
              key,
              hash,
              { created: true },
            ]);
            return { board: b, created: true };
          }
          const b: Board = row.body;
          const old = (
            await c.query(
              "SELECT hash,result FROM mdc_command WHERE project=$1 AND actor=$2 AND key=$3",
              [b.id, actor, key],
            )
          ).rows[0];
          if (old) {
            requireThat(old.hash === hash, "idempotency_conflict");
            return { board: b, created: old.result.created === true };
          }
          // Reading main already shows the board exists; joining it is the owner's decision.
          requireThat(
            b.members.includes(principalOf(actor)),
            "not_a_project_member",
            403,
          );
          const out = command(
            b,
            actor,
            { type: "attach", branch: input.branch },
            await this.now(c),
          );
          const job = await this.enqueue(
            c,
            b.id,
            actor,
            out.job!.kind,
            out.job!.payload,
          );
          await this.save(c, b, actor, "attach");
          await c.query("INSERT INTO mdc_command VALUES($1,$2,$3,$4,$5)", [
            b.id,
            actor,
            key,
            hash,
            { created: false, job },
          ]);
          return { board: b, created: false };
        });
      } catch (e) {
        // Two first submissions raced; the scope index admitted one board. Attach to it.
        if ((e as { code?: string }).code === "23505" && attempt === 0)
          continue;
        throw e;
      }
  }
  /**
   * After an environment change, the database's boards for other environments stop
   * accepting commands; returning to an earlier environment revives its board, whose
   * goals mean the same again.
   */
  async supersede(
    c: pg.PoolClient,
    database: string,
    environmentId: string,
    actor: string,
  ) {
    const rows = (
      await c.query(
        "SELECT body FROM mdc_project WHERE body->'project'->>'database'=$1 FOR UPDATE",
        [database],
      )
    ).rows;
    for (const r of rows) {
      const b: Board = r.body;
      const superseded = b.project!.environment_id !== environmentId;
      if (Boolean(b.project!.superseded) === superseded) continue;
      if (superseded) b.project!.superseded = true;
      else delete b.project!.superseded;
      await this.save(c, b, actor, superseded ? "superseded" : "revived");
    }
  }
  private async now(c: pg.PoolClient) {
    return Number(
      (await c.query("SELECT extract(epoch FROM clock_timestamp())*1000 AS ms"))
        .rows[0].ms,
    );
  }
  async get(id: string, actor: string): Promise<Board> {
    const row = (
      await this.pool.query("SELECT body FROM mdc_project WHERE id=$1", [id])
    ).rows[0];
    requireThat(row, "not_found", 404);
    member(row.body, actor);
    return row.body;
  }
  private async enqueue(
    c: pg.PoolClient,
    project: string,
    actor: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    const id = randomUUID();
    await c.query(
      "INSERT INTO mdc_job(id,project,actor,kind,payload) VALUES($1,$2,$3,$4,$5)",
      [id, project, actor, kind, payload],
    );
    return id;
  }
  async apply(
    id: string,
    actor: string,
    revision: number,
    key: string,
    input: Command,
  ) {
    const hash = createHash("sha256")
      .update(JSON.stringify({ revision, input }))
      .digest("hex");
    return this.transaction(async (c) => {
      const row = (
        await c.query("SELECT body FROM mdc_project WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      requireThat(row, "not_found", 404);
      const b: Board = row.body;
      member(b, actor);
      const old = (
        await c.query(
          "SELECT hash,result FROM mdc_command WHERE project=$1 AND actor=$2 AND key=$3",
          [id, actor, key],
        )
      ).rows[0];
      if (old) {
        requireThat(old.hash === hash, "idempotency_conflict");
        return old.result;
      }
      requireThat(b.revision === revision, "revision_conflict");
      const out = command(b, actor, input, await this.now(c));
      const job = out.job
        ? await this.enqueue(c, id, actor, out.job.kind, out.job.payload)
        : undefined;
      await this.save(c, b, actor, input.type);
      const response = { revision: b.revision, result: out.result, job };
      await c.query("INSERT INTO mdc_command VALUES($1,$2,$3,$4,$5)", [
        id,
        actor,
        key,
        hash,
        response,
      ]);
      return response;
    });
  }
  private async save(c: pg.PoolClient, b: Board, actor: string, kind: string) {
    b.revision++;
    await c.query("UPDATE mdc_project SET body=$2 WHERE id=$1", [b.id, b]);
    await c.query(
      "INSERT INTO mdc_event(project,actor,kind,revision) VALUES($1,$2,$3,$4)",
      [b.id, actor, kind, b.revision],
    );
  }
  async claim(): Promise<Job | undefined> {
    return this.transaction(async (c) => {
      // A short global claim lock closes the NOT EXISTS race between workers.
      await c.query("SELECT pg_advisory_xact_lock(682193118)");
      const row = (
        await c.query(
          `SELECT j.* FROM mdc_job j WHERE (j.status='queued' AND j.available_at<=now() OR j.status='running' AND j.expires<=now()) AND NOT EXISTS(SELECT 1 FROM mdc_job x WHERE x.project=j.project AND x.id<>j.id AND x.status='running' AND x.expires>now()) ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
        )
      ).rows[0];
      if (!row) return;
      const r = (
        await c.query(
          "UPDATE mdc_job SET status='running',epoch=epoch+1,tries=tries+1,expires=now()+interval '90 seconds' WHERE id=$1 RETURNING *",
          [row.id],
        )
      ).rows[0];
      return r;
    });
  }
  async renew(j: Job) {
    return (
      (
        await this.pool.query(
          "UPDATE mdc_job SET expires=now()+interval '90 seconds' WHERE id=$1 AND epoch=$2 AND status='running' AND expires>now()",
          [j.id, j.epoch],
        )
      ).rowCount === 1
    );
  }
  /** Apply `fn` to the board under the job's claim; `done` ends the job with `result`. */
  async checkpoint(
    j: Job,
    fn: (b: Board) => void,
    done = false,
    result?: unknown,
  ) {
    await this.transaction(async (c) => {
      const lock = (
        await c.query(
          "SELECT id FROM mdc_job WHERE id=$1 AND epoch=$2 AND status='running' AND expires>now() FOR UPDATE",
          [j.id, j.epoch],
        )
      ).rows[0];
      requireThat(lock, "stale_job");
      const b: Board = (
        await c.query("SELECT body FROM mdc_project WHERE id=$1 FOR UPDATE", [
          j.project,
        ])
      ).rows[0].body;
      member(b, j.actor);
      fn(b);
      await this.save(c, b, j.actor, `job:${j.kind}`);
      if (done)
        await c.query(
          "UPDATE mdc_job SET status='done',expires=NULL,error=NULL,result=$2 WHERE id=$1",
          [j.id, result ?? null],
        );
    });
  }
  async fail(j: Job, error: string, retry: boolean) {
    await this.transaction(async (c) => {
      const valid = (
        await c.query(
          "SELECT id FROM mdc_job WHERE id=$1 AND epoch=$2 AND status='running' AND expires>now() FOR UPDATE",
          [j.id, j.epoch],
        )
      ).rows[0];
      if (!valid) return;
      const willRetry = retry && j.tries < 5;
      await c.query(
        "UPDATE mdc_job SET status=$3,error=$4,expires=NULL,available_at=now()+interval '5 seconds' WHERE id=$1 AND epoch=$2",
        [j.id, j.epoch, willRetry ? "queued" : "failed", error],
      );
      const b: Board = (
        await c.query("SELECT body FROM mdc_project WHERE id=$1 FOR UPDATE", [
          j.project,
        ])
      ).rows[0].body;
      if (j.kind === "sync" || j.kind === "provision") b.sync_error = error;
      const name = String(j.payload.branch);
      if (j.kind === "attach" && b.branches && Object.hasOwn(b.branches, name))
        if (!willRetry) b.branches[name].request.error = error;
      if (j.kind === "assemble" && !willRetry) {
        const r = b.runs[String(j.payload.run)];
        if (r) {
          r.status = "failed";
          r.failure = error;
          r.retryable = retry;
        }
      }
      await this.save(c, b, j.actor, "job:failed");
    });
  }
  async scheduleSync() {
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(682193119)");
      await c.query(
        `INSERT INTO mdc_job(id,project,actor,kind,payload) SELECT 'sync-'||p.id||'-'||gen_random_uuid(),p.id,p.body->>'owner','sync','{}'::jsonb FROM mdc_project p WHERE p.body->>'ready'='true' AND ${LIVE} AND COALESCE((p.body->>'last_sync')::bigint,0)<extract(epoch FROM now())*1000-15000 AND NOT EXISTS(SELECT 1 FROM mdc_job j WHERE j.project=p.id AND j.kind='sync' AND (j.status IN ('queued','running') OR j.created_at>now()-interval '15 seconds'))`,
      );
    });
  }
  async jobs(id: string, actor: string) {
    await this.get(id, actor);
    return (
      await this.pool.query(
        "SELECT id,actor,kind,status,tries,error,result,created_at FROM mdc_job WHERE project=$1 ORDER BY created_at DESC LIMIT 100",
        [id],
      )
    ).rows;
  }
  async job(id: string, actor: string, job: string) {
    await this.get(id, actor);
    const row = (
      await this.pool.query(
        "SELECT id,actor,kind,status,tries,error,result,created_at FROM mdc_job WHERE project=$1 AND id=$2",
        [id, job],
      )
    ).rows[0];
    requireThat(row, "not_found", 404);
    return row;
  }
  async history(id: string, actor: string) {
    await this.get(id, actor);
    return (
      await this.pool.query(
        "SELECT sequence,actor,kind,revision,created_at FROM mdc_event WHERE project=$1 ORDER BY sequence DESC LIMIT 100",
        [id],
      )
    ).rows;
  }
}
