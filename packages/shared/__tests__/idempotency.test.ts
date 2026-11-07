/**
 * M1-T08 — Idempotency helper (spec §3.10; W-M1-10, M01-F13/F15).
 *
 * Covers the fingerprint (SHA-256 of org_id+key+body), replay of a completed mutation,
 * the different-body conflict (SEC-025), and the concurrent-duplicate `pending` race.
 * Storage is an in-memory fake of the injected IdempotencyStore port.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  IdempotencyConflictError,
  IdempotencyInFlightError,
  IdempotencyKeyStaleError,
  type IdempotencyRecord,
  type IdempotencyStore,
  type IdempotentResponse,
  computeIdempotencyHash,
  idempotencyHashMatches,
  idempotencyKeyId,
  idempotencyKeyIsStale,
  legacyIdempotencyHash,
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
  };
}

const ORG = "00000000-0000-0000-0000-000000000001";
const KEY = "server-side-fingerprint-key-for-tests-0001";
const h = (org: string, key: string, body: unknown) => computeIdempotencyHash(org, key, body, KEY);

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
    expect(stored).not.toContain(legacyIdempotencyHash(ORG, "k1", body));
    expect(stored.split(":")[2]).not.toBe(legacyIdempotencyHash(ORG, "k1", body));
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

  it("a record under another key is STALE; a different body under the same key is not; a legacy or malformed record is not", () => {
    const stored = h(ORG, "k1", { a: 1 });
    const underOther = (body: unknown) => computeIdempotencyHash(ORG, "k1", body, OTHER);
    expect(idempotencyKeyIsStale(stored, underOther({ a: 1 }))).toBe(true);
    expect(idempotencyKeyIsStale(stored, underOther({ a: 2 }))).toBe(true); // the key changed: that is all anyone can say
    expect(idempotencyKeyIsStale(stored, h(ORG, "k1", { a: 2 }))).toBe(false);
    expect(idempotencyKeyIsStale(stored, stored)).toBe(false);
    expect(idempotencyKeyIsStale(legacyIdempotencyHash(ORG, "k1", { a: 1 }), stored)).toBe(false);
    expect(idempotencyKeyIsStale(`h1:${"0".repeat(64)}`, stored)).toBe(false);
  });
});

describe("a fingerprint stored before the keyed hash (plain SHA-256)", () => {
  it("legacyIdempotencyHash is the old SHA-256 of the canonical (org, key, body)", () => {
    const canonical = JSON.stringify({ organizationId: ORG, key: "k1", body: { a: 1 } });
    expect(legacyIdempotencyHash(ORG, "k1", { a: 1 })).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
  });

  it("still matches the SAME request for one TTL, and never a different one; a keyed value never matches the legacy form", () => {
    const legacy = legacyIdempotencyHash(ORG, "k1", { a: 1 });
    const keyed = h(ORG, "k1", { a: 1 });
    const legacyOf = (body: unknown) => () => legacyIdempotencyHash(ORG, "k1", body);
    expect(idempotencyHashMatches(legacy, keyed, legacyOf({ a: 1 }))).toBe(true);
    expect(idempotencyHashMatches(legacy, h(ORG, "k1", { a: 2 }), legacyOf({ a: 2 }))).toBe(false);
    expect(idempotencyHashMatches(keyed, keyed, legacyOf({ a: 1 }))).toBe(true);
    // a keyed record is compared as keyed only: a request under another server key is a mismatch, cleanly
    const rotated = computeIdempotencyHash(
      ORG,
      "k1",
      { a: 1 },
      "another-server-key-0000000000000002",
    );
    expect(idempotencyHashMatches(keyed, rotated, legacyOf({ a: 1 }))).toBe(false);
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

  it("replays a record stored under the legacy SHA-256 (a deploy mid-TTL does not double-execute a retry), and still conflicts on another body", async () => {
    const legacy = legacyIdempotencyHash(ORG, "k1", { a: 1 });
    const store = memoryStore({ state: "complete", requestHash: legacy, response: ok });
    const handler = vi.fn(async () => ({ status: "500", body: null }));
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY)).resolves.toEqual(ok);
    await expect(runIdempotent(store, ORG, "k1", { a: 2 }, handler, KEY)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
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
      putPending: async () => false,
      complete: vi.fn(async () => undefined),
    };
    const handler = vi.fn(async () => ({ status: "500", body: null }));
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY)).resolves.toEqual(ok);
    expect(handler).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("reports in-flight when the claim is lost to a still-pending winner", async () => {
    const hash = h(ORG, "k1", { a: 1 });
    const loads: Array<IdempotencyRecord | null> = [null, { state: "pending", requestHash: hash }];
    const store: IdempotencyStore = {
      load: async () => loads.shift() ?? null,
      putPending: async () => false,
      complete: async () => undefined,
    };
    const handler = vi.fn(async () => ok);
    await expect(runIdempotent(store, ORG, "k1", { a: 1 }, handler, KEY)).rejects.toBeInstanceOf(
      IdempotencyInFlightError,
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
