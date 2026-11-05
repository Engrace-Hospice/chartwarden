import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAttemptStore } from "./attempt-store";
import {
  CLAIMMD_RATE_WINDOW_MS,
  CLAIMMD_REQUESTS_PER_WINDOW,
  type ClaimMdRequestCounter,
  createInProcessClaimMdCounter,
} from "./claimmd-rate-limit";
import { ClaimMdTransport } from "./claimmd-transport";
import { DEFAULT_SCOPE } from "./conformance";
import { CH, type ClearinghouseContext, type ClearinghouseSubmission } from "./types";

// Claim.MD's per-account budget (100 a minute, then a 403 block for every tenant on the account). Synthetic values only.

const TEST_KEY = "claimmd_test_key_do_not_leak";
const PROD_KEY = "claimmd_prod_key_do_not_leak";
const NPI = DEFAULT_SCOPE.billingNpi as string;

const ctx = (over: Partial<ClearinghouseContext> = {}): ClearinghouseContext => ({
  ...DEFAULT_SCOPE,
  payerId: "15004",
  correlationId: "corr-rl",
  ...over,
});
const claim = (cn: string): ClearinghouseSubmission => ({
  kind: "claim",
  controlNumber: cn,
  idempotencyKey: `idem-${cn}`,
  payload: { format: "json", document: { claim: [{ pcn: cn, bill_npi: NPI, claim_form: "UB" }] } },
});

/** A fake Claim.MD that records what actually left: an upload names our claim, a read answers an empty list. */
function fakeClaimMd() {
  const sent: string[] = [];
  const keysSeen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(/^https:\/\/svc\.claim\.md\/services\//, "").replace(/\/$/, "");
    sent.push(path);
    const body = init?.body as URLSearchParams | FormData;
    keysSeen.push(String(body.get("AccountKey")));
    if (path === "upload") {
      const doc = JSON.parse(await (body.get("File") as Blob).text()) as { claim: { pcn: string }[] };
      return Response.json({ claim: [{ pcn: doc.claim[0]?.pcn, claimid: `C${sent.length}` }] });
    }
    return Response.json({});
  }) as typeof fetch;
  return { fetchImpl, sent, keysSeen };
}

/** A counter the test drives: exhausted, healthy, or failing like an unreachable Valkey. Records the keys it saw. */
function scriptedCounter() {
  let state: "ok" | "exhausted" | "down" = "ok";
  const keys: string[] = [];
  const counter: ClaimMdRequestCounter = {
    async increment(key) {
      keys.push(key);
      if (state === "down") throw new Error("connect ECONNREFUSED");
      return state === "exhausted" ? CLAIMMD_REQUESTS_PER_WINDOW + 1 : 1;
    },
  };
  return { counter, keys, set: (s: typeof state) => (state = s) };
}

function transport(fetchImpl: typeof fetch, requestCounter: ClaimMdRequestCounter) {
  return new ClaimMdTransport({
    keys: { test: TEST_KEY, production: PROD_KEY },
    attempts: new InMemoryAttemptStore(),
    fetch: fetchImpl,
    requestCounter,
    now: () => new Date("2026-11-04T17:00:00.000Z"),
  });
}

/** Runs `p` while fake time passes the bounded wait. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(CLAIMMD_RATE_WINDOW_MS + 1_000);
  return p;
}

describe("Claim.MD request budget", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("budget exhausted: the upload is never sent, its reservation is released, and the retry sends once", async () => {
    const server = fakeClaimMd();
    const budget = scriptedCounter();
    const t = transport(server.fetchImpl, budget.counter);
    budget.set("exhausted");

    const refused = await settle(t.submitClaim(ctx(), claim("CCN-RL1")));
    expect(!refused.ok && refused.degraded.code).toBe(CH.UNAVAILABLE);
    expect(server.sent).toEqual([]);

    budget.set("ok");
    const resent = await t.submitClaim(ctx(), claim("CCN-RL1"));
    expect(resent.ok).toBe(true);
    expect(server.sent).toEqual(["upload"]);
  });

  it("a read without budget is CH_UNAVAILABLE (never INVALID_REQUEST, which would reset a cursor)", async () => {
    const server = fakeClaimMd();
    const budget = scriptedCounter();
    const t = transport(server.fetchImpl, budget.counter);
    budget.set("exhausted");

    const acks = await settle(t.fetchAcknowledgments(ctx(), "42"));
    const eras = await settle(t.fetchRemittances(ctx(), null));
    expect(!acks.ok && acks.degraded.code).toBe(CH.UNAVAILABLE);
    expect(!eras.ok && eras.degraded.code).toBe(CH.UNAVAILABLE);
    expect(server.sent).toEqual([]);
  });

  it("a failing shared store refuses at once (fail closed, no wait, nothing sent) and recovers with it", async () => {
    const server = fakeClaimMd();
    const budget = scriptedCounter();
    const t = transport(server.fetchImpl, budget.counter);
    budget.set("down");

    // No timer advance: the refusal must not wait for a store that is down.
    const refused = await t.submitClaim(ctx(), claim("CCN-RL3"));
    expect(!refused.ok && refused.degraded.code).toBe(CH.UNAVAILABLE);
    expect(server.sent).toEqual([]);

    budget.set("ok");
    expect((await t.submitClaim(ctx(), claim("CCN-RL3"))).ok).toBe(true);
    expect(server.sent).toEqual(["upload"]);
  });

  it("keys the budget by usage mode, never by the account key", async () => {
    const server = fakeClaimMd();
    const budget = scriptedCounter();
    const t = transport(server.fetchImpl, budget.counter);
    await t.fetchAcknowledgments(ctx(), "1");
    await t.fetchAcknowledgments(ctx({ usage: "production" }), "1");
    expect(budget.keys).toEqual(["claimmd:test", "claimmd:production"]);
    expect(budget.keys.join()).not.toContain("key_do_not_leak");
  });

  it("two transports on one counter share the budget; the other usage mode keeps its own", async () => {
    const server = fakeClaimMd();
    const shared = createInProcessClaimMdCounter(() => 0); // frozen clock: the window never rolls over
    const a = transport(server.fetchImpl, shared);
    const b = transport(server.fetchImpl, shared);

    for (let i = 0; i < CLAIMMD_REQUESTS_PER_WINDOW; i += 1) {
      await (i % 2 === 0 ? a : b).fetchAcknowledgments(ctx(), "1");
    }
    expect(server.sent).toHaveLength(CLAIMMD_REQUESTS_PER_WINDOW);

    const over = await settle(b.fetchAcknowledgments(ctx(), "1"));
    expect(!over.ok && over.degraded.code).toBe(CH.UNAVAILABLE);
    expect(server.sent).toHaveLength(CLAIMMD_REQUESTS_PER_WINDOW);

    expect((await a.fetchAcknowledgments(ctx({ usage: "production" }), "1")).ok).toBe(true);
    expect(server.keysSeen.at(-1)).toBe(PROD_KEY);
  });

  it("waits briefly for the next window instead of refusing a sequential caller", async () => {
    let clock = 0;
    const server = fakeClaimMd();
    const t = transport(server.fetchImpl, createInProcessClaimMdCounter(() => clock));
    for (let i = 0; i < CLAIMMD_REQUESTS_PER_WINDOW; i += 1) await t.fetchAcknowledgments(ctx(), "1");

    const next = t.fetchAcknowledgments(ctx(), "1");
    clock = CLAIMMD_RATE_WINDOW_MS; // the window rolls over while the caller waits
    const r = await settle(next);
    expect(r.ok).toBe(true);
    expect(server.sent).toHaveLength(CLAIMMD_REQUESTS_PER_WINDOW + 1);
  });
});
