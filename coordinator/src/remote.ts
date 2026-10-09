import { z } from "zod";
import { Fault } from "./domain.js";
export class RemoteError extends Fault {
  constructor(
    code: string,
    public retryable: boolean,
    public remoteStatus: number,
  ) {
    super(code, 502);
  }
}
export async function responseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > 4000000)
    throw new RemoteError("upstream_response_too_large", false, res.status);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RemoteError("invalid_upstream_json", false, res.status);
  }
  if (!res.ok) {
    const code = z
      .object({ reason: z.string().optional() })
      .passthrough()
      .safeParse(data);
    throw new RemoteError(
      code.success
        ? (code.data.reason ?? `upstream_${res.status}`)
        : `upstream_${res.status}`,
      res.status >= 500 || res.status === 429,
      res.status,
    );
  }
  return data;
}
/** Fact operations that run Lean: they may wait for a worker to start or a long check to end. */
const LEAN_OPERATIONS = new Set(["resolve", "submit", "define", "assemble"]);
/** Reads, queries, events and base lookups (docs/mathdoc.md §2.7.7). */
const SHORT_TIMEOUT_MS = 30000;
/** Slightly above LeanGround's own default wall-clock limit per request (900 s). */
export const DEFAULT_LEAN_TIMEOUT_S = 960;
export class LeanGround {
  constructor(
    private url: string,
    private token: string,
    private leanTimeoutMs = DEFAULT_LEAN_TIMEOUT_S * 1000,
  ) {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw new Error("invalid LeanGround URL");
  }
  async call(
    path: string,
    body?: unknown,
    timeoutMs = SHORT_TIMEOUT_MS,
  ): Promise<any> {
    // External payloads are validated at their domain boundary.
    try {
      const res = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      // The time limit covers reading the body too.
      return await responseJson(res);
    } catch (e) {
      if (e instanceof RemoteError) throw e;
      // A timeout may have left work running in LeanGround; jobs retry both.
      throw new RemoteError(
        (e as Error)?.name === "TimeoutError"
          ? "leanground_timeout"
          : "leanground_unavailable",
        true,
        0,
      );
    }
  }
  fact(operation: string, body: unknown) {
    return this.call(
      `/v1/facts/${operation}`,
      body,
      LEAN_OPERATIONS.has(operation) ? this.leanTimeoutMs : SHORT_TIMEOUT_MS,
    );
  }
}
