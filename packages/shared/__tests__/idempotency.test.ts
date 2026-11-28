/**
 * M1-T08 — Idempotency helper (spec §3.10; W-M1-10, M01-F13/F15).
 *
 * Covers the fingerprint (keyed HMAC-SHA-256 of org_id+key+body), replay of a completed mutation,
 * the different-body conflict (SEC-025), and the concurrent-duplicate `pending` race.
 * Storage is an in-memory fake of the injected IdempotencyStore port.
 */
import { createHash } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import * as shared from "../src/index";
import {
  IDEMPOTENCY_PENDING_MAX_AGE_MS,
  IdempotencyConflictError,
  IdempotencyInFlightError,
  IdempotencyKeyStaleError,
  IdempotencyKeyStuckError,
  type IdempotencyRecord,
  type IdempotencyStore,
  type IdempotentResponse,
  claimIdempotencyKey,
  computeIdempotencyHash,
  idempotencyKeyId,
  idempotencyKeyIsStale,
  runIdempotent,
} from "../src/index";

function memoryStore(seed?: IdempotencyRecord): IdempotencyStore {
  let rec: IdempotencyRecord | null = seed ?? null;
  let claimId: string | null = seed?.state === "pending" ? "seed-generation" : null;
  let generation = 0;
  return {
    load: async () => rec,
    putPending: async (_o, _k, requestHash) => {
      if (rec) return null;
      claimId = `generation-${++generation}`;
      rec = { state: "pending", requestHash };
      return claimId;
    },
    complete: async (_o, _k, owner, response) => {
      if (rec?.state === "pending" && owner === claimId)
        rec = { state: "complete", requestHash: rec.requestHash, response };
    },
    release: async (_o, _k, owner, requestHash) => {
      if (rec?.state === "pending" && owner === claimId && rec.requestHash === requestHash) rec = null;
    },
  };
}

const ORG = "00000000-0000-0000-0000-000000000001";
const KEY = "server-side-fingerprint-key-for-tests-0001";
const h = (org: string, key: string, body: unknown) => computeIdempotencyHash(org, key, body, KEY);
/**
 * The unkeyed fingerprint the middleware stored before the keyed hash (plain SHA-256 of the canonical (org, key, body)): what a reader
 * of the table could test a guess against. Test-local on purpose: no source module computes it any more (CW-SEC-02).
 */
const plainSha256 = (org: string, key: string, body: unknown) =>
  createHash("sha256")
    .update(JSON.stringify({ organizationId: org, key, body: body ?? null }))
    .digest("hex");

describe("computeIdempotencyHash (SEC-025 / F13)", () => {
  it("is deterministic for the same (org, key, body, server key)", () => {
    const a = h(ORG, "k1", { amount: 10 });
    const b = h(ORG, "k1", { amount: 10 });
    expect(a).toBe(b);
    expect(a).toMatch(/^h1:[0-9a-f]{8}:[0-9a-f]{64}$/);
  });

  it("differs when org, key, or body differ", () => {
    const base = h(ORG, "k1", { amount: 10 });
    expect(h("other", "k1", { amount: 10 })).not.toBe(base);
    expect(h(ORG, "k2", { amount: 10 })).not.toBe(base);
    expect(h(ORG, "k1", { amount: 11 })).not.toBe(base);
  });

  it("normalizes undefined and null bodies to the same fingerprint", () => {
    expect(h(ORG, "k1", undefined)).toBe(h(ORG, "k1", null));
  });

  it("is a KEYED hash: the stored value cannot be tested against a guessed secret without the server key", () => {
    const body = { clinicKey: "a-guessable-clinic-key-1234" };
    const stored = h(ORG, "k1", body);
    // an attacker who can read the table and knows the org, the key and a candidate body computes plain SHA-256: no match
    expect(stored).not.toContain(plainSha256(ORG, "k1", body));
    expect(stored.split(":")[2]).not.toBe(plainSha256(ORG, "k1", body));
    // and a different server key (a rotated or wrong one) gives a different fingerprint
    expect(computeIdempotencyHash(ORG, "k1", body, "another-server-key-0000000000000002")).not.toBe(
      stored,
    );
    // the stored value carries no part of the secret
    expect(stored).not.toContain("guessable");
  });
});

describe("the server key id (told apart from a different body)", () => {
  const OTHER = "another-server-key-0000000000000002";

  it("is 8 hex characters, the same for every request under one key, different under another, and carries no part of the key", () => {
    const kid = idempotencyKeyId(KEY);
    expect(kid).toMatch(/^[0-9a-f]{8}$/);
    expect(h(ORG, "k1", { a: 1 }).startsWith(`h1:${kid}:`)).toBe(true);
    expect(h(ORG, "k2", { b: 2 }).startsWith(`h1:${kid}:`)).toBe(true);
    expect(idempotencyKeyId(OTHER)).not.toBe(kid);
    expect(kid).not.toContain(KEY.slice(0, 4));
  });

  it("a record under another key is STALE; a different body under the same key is not; a plain-SHA-256 or malformed record is not", () => {
    const stored = h(ORG, "k1", { a: 1 });
    const underOther = (body: unknown) => computeIdempotencyHash(ORG, "k1", body, OTHER);
    expect(idempotencyKeyIsStale(stored, underOther({ a: 1 }))).toBe(true);
    expect(idempotencyKeyIsStale(stored, underOther({ a: 2 }))).toBe(true); // the key changed: that is all anyone can say
    expect(idempotencyKeyIsStale(stored, h(ORG, "k1", { a: 2 }))).toBe(false);
    expect(idempotencyKeyIsStale(stored, stored)).toBe(false);
    expect(idempotencyKeyIsStale(plainSha256(ORG, "k1", { a: 1 }), stored)).toBe(false);
    expect(idempotencyKeyIsStale(`h1:${"0".repeat(64)}`, stored)).toBe(false);
  });
});

describe("the legacy plain-SHA-256 fingerprint is gone (CW-SEC-02)", () => {
  it("the module exports no legacy hash, no removal date and no matcher that falls back to one", () => {
    for (const name of [
      "legacyIdempotencyHash",
      "LEGACY_ARM_REMOVE_AFTER",
      "idempotencyHashMatches",
    ]) {
      expect(Object.keys(shared), name).not.toContain(name);
    }
  });

  it("a record stored under the plain SHA-256 of the SAME request never matches: it is a conflict, never a replay and never a re-run", async () => {
    const store = memoryStore({
      state: "complete",
      requestHash: plainSha256(ORG, "k1", { a: 1 }),
      response: { status: "201", body: { id: "x" } },
    });
    const handler = vi.fn(async () => ({ status: "500", body: null }));
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("the same holds for a still-pending plain record: a conflict, not in flight, and the claim is not taken", async () => {
    const store = memoryStore({ state: "pending", requestHash: plainSha256(ORG, "k1", { a: 1 }) });
    await expect(
      claimIdempotencyKey(store, ORG, "k1", h(ORG, "k1", { a: 1 })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe("runIdempotent", () => {
  const ok: IdempotentResponse = { status: "201", body: { id: "x" } };

  it("runs the handler once on a first call and returns its response", async () => {
    const store = memoryStore();
    const handler = vi.fn(async () => ok);
    const res = await runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY);
    expect(res).toEqual(ok);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays the cached response for a same-body retry without re-running the handler", async () => {
    const hash = h(ORG, "k1", { a: 1 });
    const store = memoryStore({ state: "complete", requestHash: hash, response: ok });
    const handler = vi.fn(async () => ({ status: "500", body: null }));
    const res = await runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY);
    expect(res).toEqual(ok);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a record stored under a DIFFERENT server key is a clean mismatch (409), never a replay and never a re-run", async () => {
    const other = computeIdempotencyHash(
      ORG,
      "k1",
      { a: 1 },
      "another-server-key-0000000000000002",
    );
    const store = memoryStore({ state: "complete", requestHash: other, response: ok });
    const handler = vi.fn(async () => ok);
    const error = await runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY).catch((e) => e);
    // its own error, not "a different body": the body is the same, the server's key changed
    expect(error).toBeInstanceOf(IdempotencyKeyStaleError);
    expect(error).not.toBeInstanceOf(IdempotencyConflictError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("throws IdempotencyConflictError when the key is reused with a different body", async () => {
    const hash = h(ORG, "k1", { a: 1 });
    const store = memoryStore({ state: "complete", requestHash: hash, response: ok });
    await expect(
      runIdempotent(store, ORG, "k1", { a: 2 }, async () => ok, KEY),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("throws IdempotencyInFlightError on a concurrent duplicate (pending) (F15)", async () => {
    const hash = h(ORG, "k1", { a: 1 });
    const store = memoryStore({ state: "pending", requestHash: hash });
    const handler = vi.fn(async () => ok);
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY)).rejects.toBeInstanceOf(
      IdempotencyInFlightError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("never runs the handler when the claim is lost, and replays the winner's response (GAP-007)", async () => {
    const hash = h(ORG, "k1", { a: 1 });
    const loads: Array<IdempotencyRecord | null> = [
      null,
      { state: "complete", requestHash: hash, response: ok },
    ];
    const store: IdempotencyStore = {
      load: async () => loads.shift() ?? null,
      putPending: async () => null,
      complete: vi.fn(async () => undefined),
      release: async () => undefined,
    };
    const handler = vi.fn(async () => ({ status: "500", body: null }));
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY)).resolves.toEqual(ok);
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
    const hash = h(ORG, "k1", { a: 1 });
    const loads: Array<IdempotencyRecord | null> = [null, { state: "pending", requestHash: hash }];
    const store: IdempotencyStore = {
      load: async () => loads.shift() ?? null,
      putPending: async () => null,
      complete: async () => undefined,
      release: async () => undefined,
    };
    const handler = vi.fn(async () => ok);
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY)).rejects.toBeInstanceOf(
      IdempotencyInFlightError,
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("a claim that stays pending past the bound is stuck, not in flight", () => {
  const ok: IdempotentResponse = { status: "201", body: { id: 1 } };
  const hash = h(ORG, "k1", { a: 1 });
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
      KEY,
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
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY)).rejects.toBeInstanceOf(
      IdempotencyKeyStuckError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("a different body is still IDEMPOTENCY_CONFLICT, whatever the age", async () => {
    const store = memoryStore(pendingFor(IDEMPOTENCY_PENDING_MAX_AGE_MS * 10));
    await expect(
      runIdempotent(store, ORG, "k1", { a: 2 }, async () => ok, KEY),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("the age is read when the claim is lost to a winner too", async () => {
    const loads: Array<IdempotencyRecord | null> = [
      null,
      pendingFor(IDEMPOTENCY_PENDING_MAX_AGE_MS + 1),
    ];
    const store: IdempotencyStore = {
      load: async () => loads.shift() ?? null,
      putPending: async () => null,
      complete: async () => undefined,
      release: async () => undefined,
    };
    await expect(
      runIdempotent(store, ORG, "k1", { a: 1 }, async () => ok, KEY),
    ).rejects.toBeInstanceOf(IdempotencyKeyStuckError);
  });
});
