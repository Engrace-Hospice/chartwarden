// F-014 (#39) — the seed chain's shared auth retry, against BOTH limiters a sign-in can hit.
//
// `bun run db:reset` signs in roughly thirty times across its fourteen steps and every one of those
// requests is inherently pre-auth, so they all share the SD-055 unauthenticated bucket
// (`ip:<addr>`, 30/minute, bootstrap/plugins/security.ts). That limiter advertises the standard
// `Retry-After` header; Better Auth's own 3-per-10-seconds guard advertises `x-retry-after`. The
// helper read only the second, fell back to its 11-second Better Auth constant against a 60-second
// window, and burned its remaining attempts inside that window — each retry consuming another token
// of the budget it was waiting on. The chain stopped at step 13 of 14 with
// "exhausted rate-limit retries".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAuthWithRateLimitRetry } from "../db/lib/auth-rate-limit";

const tooManyRequests = (headers: Record<string, string>): Response =>
  new Response("rate limited", { status: 429, headers });

describe("fetchAuthWithRateLimitRetry", () => {
  const originalFetch = globalThis.fetch;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    log.mockRestore();
    globalThis.fetch = originalFetch;
  });

  /** Drive the helper to completion under fake timers (it awaits a real setTimeout between tries). */
  async function run(responses: Response[]): Promise<Response> {
    const queue = [...responses];
    globalThis.fetch = vi.fn(async () => queue.shift() ?? new Response("ok")) as typeof fetch;
    const pending = fetchAuthWithRateLimitRetry("http://x/api/auth/sign-in/email", {}, "sign-in");
    await vi.runAllTimersAsync();
    return pending;
  }

  it("waits the SD-055 window, not the Better Auth constant, when only `Retry-After` is present", async () => {
    // 60 + 1: both limiters compare their window with a strict `>`, so the extra second clears the edge.
    // Waiting 11s here is what made the retry land inside the same window and spend another token.
    const res = await run([tooManyRequests({ "retry-after": "60" }), new Response("ok")]);
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledWith("sign-in rate-limited; retrying in 61s");
  });

  it("still honours Better Auth's `x-retry-after` (the shorter 10s guard)", async () => {
    const res = await run([tooManyRequests({ "x-retry-after": "10" }), new Response("ok")]);
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledWith("sign-in rate-limited; retrying in 11s");
  });

  it("prefers the standard header when a response somehow carries both", async () => {
    const res = await run([
      tooManyRequests({ "retry-after": "60", "x-retry-after": "10" }),
      new Response("ok"),
    ]);
    expect(log).toHaveBeenCalledWith("sign-in rate-limited; retrying in 61s");
    expect(res.status).toBe(200);
  });

  it("falls back to the shorter window when neither header is sent (never stalls a seed)", async () => {
    const res = await run([tooManyRequests({}), new Response("ok")]);
    expect(log).toHaveBeenCalledWith("sign-in rate-limited; retrying in 11s");
    expect(res.status).toBe(200);
  });

  it("returns the last 429 rather than throwing when the ceiling never clears", async () => {
    // The caller turns this into a readable "sign-in failed … HTTP 429" with the server's own body,
    // which is more useful than the helper's own "exhausted retries".
    const res = await run(
      Array.from({ length: 5 }, () => tooManyRequests({ "retry-after": "60" })),
    );
    expect(res.status).toBe(429);
  });

  it("does not retry a non-429 (a wrong password must fail immediately, not five times)", async () => {
    const fetchSpy = vi.fn(async () => new Response("bad creds", { status: 401 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const res = await fetchAuthWithRateLimitRetry("http://x", {}, "sign-in");
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 5xx (the CI hash-wasm trap) and returns the next good response", async () => {
    const res = await run([new Response("null", { status: 500 }), new Response("ok")]);
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledWith("sign-in got HTTP 500; retrying in 2s");
  });

  it("gives up on a persistent 5xx after the bounded retries and returns it for a readable error", async () => {
    const fetchSpy = vi.fn(async () => new Response("null", { status: 500 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const pending = fetchAuthWithRateLimitRetry("http://x", {}, "sign-up");
    await vi.runAllTimersAsync();
    const res = await pending;
    expect(res.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not let 5xx retries spend the rate-limit budget", async () => {
    const res = await run([
      new Response("null", { status: 500 }),
      tooManyRequests({ "retry-after": "60" }),
      new Response("ok"),
    ]);
    expect(res.status).toBe(200);
  });
});
