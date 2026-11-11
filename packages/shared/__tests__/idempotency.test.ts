/**
 * M1-T08 — Idempotency helper (spec §3.10; W-M1-10, M01-F13/F15).
 *
 * Covers the fingerprint (SHA-256 of org_id+key+body), replay of a completed mutation,
 * the different-body conflict (SEC-025), and the concurrent-duplicate `pending` race.
 * Storage is an in-memory fake of the injected IdempotencyStore port.
 */
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  IDEMPOTENCY_PENDING_MAX_AGE_MS,
  IdempotencyConflictError,
  IdempotencyInFlightError,
  IdempotencyKeyStuckError,
  type IdempotencyRecord,
  type IdempotencyStore,
  type IdempotentResponse,
  computeIdempotencyHash,
  runIdempotent,
} from "../src/index";

function memoryStore(seed?: IdempotencyRecord): IdempotencyStore {
  let rec: IdempotencyRecord | null = seed ?? null;
  return {
    load: async () => rec,
    putPending: async (_o, _k, requestHash) => {
      if (rec) return false;
      rec = { state: "pending", requestHash };
      return true;
    },
    complete: async (_o, _k, response) => {
      rec = rec ? { state: "complete", requestHash: rec.requestHash, response } : rec;
    },
    release: async (_o, _k, requestHash) => {
      if (rec?.state === "pending" && rec.requestHash === requestHash) rec = null;
    },
  };
}

const ORG = "00000000-0000-0000-0000-000000000001";

describe("computeIdempotencyHash (SEC-025 / F13)", () => {
  it("is deterministic for the same (org, key, body)", () => {
    const a = computeIdempotencyHash(ORG, "k1", { amount: 10 });
    const b = computeIdempotencyHash(ORG, "k1", { amount: 10 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when org, key, or body differ", () => {
    const base = computeIdempotencyHash(ORG, "k1", { amount: 10 });
    expect(computeIdempotencyHash("other", "k1", { amount: 10 })).not.toBe(base);
    expect(computeIdempotencyHash(ORG, "k2", { amount: 10 })).not.toBe(base);
    expect(computeIdempotencyHash(ORG, "k1", { amount: 11 })).not.toBe(base);
  });

  it("normalizes undefined and null bodies to the same fingerprint", () => {
    expect(computeIdempotencyHash(ORG, "k1", undefined)).toBe(
      computeIdempotencyHash(ORG, "k1", null),
    );
  });
});

describe("runIdempotent", () => {
  const ok: IdempotentResponse = { status: "201", body: { id: "x" } };

  it("runs the handler once on a first call and returns its response", async () => {
    const store = memoryStore();
    const handler = vi.fn(async () => ok);
    const res = await runIdempotent(store, ORG, "k1", { a: 1 }, handler);
    expect(res).toEqual(ok);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays the cached response for a same-body retry without re-running the handler", async () => {
    const hash = computeIdempotencyHash(ORG, "k1", { a: 1 });
    const store = memoryStore({ state: "complete", requestHash: hash, response: ok });
    const handler = vi.fn(async () => ({ status: "500", body: null }));
    const res = await runIdempotent(store, ORG, "k1", { a: 1 }, handler);
    expect(res).toEqual(ok);
    expect(handler).not.toHaveBeenCalled();
  });

  it("throws IdempotencyConflictError when the key is reused with a different body", async () => {
    const hash = computeIdempotencyHash(ORG, "k1", { a: 1 });
    const store = memoryStore({ state: "complete", requestHash: hash, response: ok });
    await expect(runIdempotent(store, ORG, "k1", { a: 2 }, async () => ok)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("throws IdempotencyInFlightError on a concurrent duplicate (pending) (F15)", async () => {
    const hash = computeIdempotencyHash(ORG, "k1", { a: 1 });
    const store = memoryStore({ state: "pending", requestHash: hash });
    const handler = vi.fn(async () => ok);
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler)).rejects.toBeInstanceOf(
      IdempotencyInFlightError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("never runs the handler when the claim is lost, and replays the winner's response (GAP-007)", async () => {
    const hash = computeIdempotencyHash(ORG, "k1", { a: 1 });
    const loads: Array<IdempotencyRecord | null> = [
      null,
      { state: "complete", requestHash: hash, response: ok },
    ];
    const store: IdempotencyStore = {
      load: async () => loads.shift() ?? null,
      putPending: async () => false,
      complete: vi.fn(async () => undefined),
      release: async () => undefined,
    };
    const handler = vi.fn(async () => ({ status: "500", body: null }));
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler)).resolves.toEqual(ok);
    expect(handler).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("the in-flight error carries its own code (IDEMPOTENCY_IN_FLIGHT, still a 409) and the same message", () => {
    const error = new IdempotencyInFlightError("k1");
    expect(error.code).toBe("IDEMPOTENCY_IN_FLIGHT");
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe("Idempotency-Key request is still being processed");
    expect(error.key).toBe("k1");
    expect(error).toBeInstanceOf(ChartWardenError);
  });

  it("reports in-flight when the claim is lost to a still-pending winner", async () => {
    const hash = computeIdempotencyHash(ORG, "k1", { a: 1 });
    const loads: Array<IdempotencyRecord | null> = [null, { state: "pending", requestHash: hash }];
    const store: IdempotencyStore = {
      load: async () => loads.shift() ?? null,
      putPending: async () => false,
      complete: async () => undefined,
      release: async () => undefined,
    };
    const handler = vi.fn(async () => ok);
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler)).rejects.toBeInstanceOf(
      IdempotencyInFlightError,
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("a claim that stays pending past the bound is stuck, not in flight", () => {
  const ok: IdempotentResponse = { status: "201", body: { id: 1 } };
  const hash = computeIdempotencyHash(ORG, "k1", { a: 1 });
  const pendingFor = (pendingForMs?: number): IdempotencyRecord => ({
    state: "pending",
    requestHash: hash,
    ...(pendingForMs === undefined ? {} : { pendingForMs }),
  });
  const claim = (record: IdempotencyRecord) =>
    runIdempotent(
      memoryStore(record),
      ORG,
      "k1",
      { a: 1 },
      vi.fn(async () => ok),
    );

  it("is its own code (IDEMPOTENCY_KEY_STUCK, still a 409) with a message that says the outcome is unknown and not to retry with the key", () => {
    const error = new IdempotencyKeyStuckError("k1");
    expect(error.code).toBe("IDEMPOTENCY_KEY_STUCK");
    expect(error.statusCode).toBe(409);
    expect(error.message).toMatch(/outcome is unknown/);
    expect(error.message).toMatch(/do not retry with this key/i);
    expect(error.message).toMatch(/read the resource/i);
    expect(error).toBeInstanceOf(ChartWardenError);
    expect(error).not.toBeInstanceOf(IdempotencyInFlightError);
  });

  it("a pending claim younger than the bound, or of unknown age, is still in flight", async () => {
    await expect(claim(pendingFor(0))).rejects.toBeInstanceOf(IdempotencyInFlightError);
    await expect(claim(pendingFor(IDEMPOTENCY_PENDING_MAX_AGE_MS))).rejects.toBeInstanceOf(
      IdempotencyInFlightError,
    );
    await expect(claim(pendingFor(undefined))).rejects.toBeInstanceOf(IdempotencyInFlightError);
  });

  it("a pending claim older than the bound is stuck, and the handler never runs", async () => {
    const handler = vi.fn(async () => ok);
    const store = memoryStore(pendingFor(IDEMPOTENCY_PENDING_MAX_AGE_MS + 1));
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler)).rejects.toBeInstanceOf(
      IdempotencyKeyStuckError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("a different body is still IDEMPOTENCY_CONFLICT, whatever the age", async () => {
    const store = memoryStore(pendingFor(IDEMPOTENCY_PENDING_MAX_AGE_MS * 10));
    await expect(runIdempotent(store, ORG, "k1", { a: 2 }, async () => ok)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("the age is read when the claim is lost to a winner too", async () => {
    const loads: Array<IdempotencyRecord | null> = [
      null,
      pendingFor(IDEMPOTENCY_PENDING_MAX_AGE_MS + 1),
    ];
    const store: IdempotencyStore = {
      load: async () => loads.shift() ?? null,
      putPending: async () => false,
      complete: async () => undefined,
      release: async () => undefined,
    };
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, async () => ok)).rejects.toBeInstanceOf(
      IdempotencyKeyStuckError,
    );
  });
});
