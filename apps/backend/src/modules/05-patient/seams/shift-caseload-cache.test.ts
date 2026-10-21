// wardenx -> chartwarden Valkey rename, release B: dual-write both hashes (same TTL), read the union of both, delete from both.
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import {
  readShiftAssignedPatientIds,
  removeShiftAssignment,
  writeShiftAssignment,
} from "./shift-caseload-cache";

function fakeRedis(failExec?: Array<[Error | null, number]> | null) {
  const hashes = new Map<string, Map<string, string>>();
  const ttl = new Map<string, number>();
  const redis = {
    async hset(k: string, f: string, v: string) {
      hashes.set(k, (hashes.get(k) ?? new Map()).set(f, v));
      return 1;
    },
    async expire(k: string, sec: number) {
      ttl.set(k, sec);
      return 1;
    },
    async hdel(k: string, f: string) {
      const h = hashes.get(k);
      const had = h?.delete(f) ?? false;
      if (h?.size === 0) hashes.delete(k);
      return had ? 1 : 0;
    },
    async hgetall(k: string) {
      return Object.fromEntries(hashes.get(k) ?? []);
    },
    multi() {
      const ops: Array<() => Promise<number>> = [];
      const tx = {
        hdel: (k: string, f: string) => {
          ops.push(() => redis.hdel(k, f));
          return tx;
        },
        async exec() {
          if (failExec) return failExec;
          const out: Array<[Error | null, number]> = [];
          for (const op of ops) out.push([null, await op()]);
          return out;
        },
      };
      return tx;
    },
  };
  return { redis: redis as unknown as Redis, hashes, ttl };
}

const LEGACY = "wardenx:m5:caseload-cache:org:u";
const RENAMED = "chartwarden:m5:caseload-cache:org:u";
const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe("shift caseload cache dual-write", () => {
  it("writes both hashes with the 24 h TTL, reads them, and removes from both", async () => {
    const f = fakeRedis();
    await writeShiftAssignment(f.redis, "org", "u", "v1", "p1", future());
    expect(f.hashes.get(LEGACY)?.get("v1")).toBeDefined();
    expect(f.hashes.get(RENAMED)?.get("v1")).toBe(f.hashes.get(LEGACY)?.get("v1"));
    expect(f.ttl.get(LEGACY)).toBe(86_400);
    expect(f.ttl.get(RENAMED)).toBe(86_400);
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual(["p1"]);
    await removeShiftAssignment(f.redis, "org", "u", "v1");
    expect(f.hashes.size).toBe(0);
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual([]);
  });

  const entry = (patientId: string) => JSON.stringify({ patientId, expiresAt: future() });

  it("reads a legacy-only hash (assignment written before release A)", async () => {
    const f = fakeRedis();
    f.hashes.set(LEGACY, new Map([["v1", entry("p1")]]));
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual(["p1"]);
  });

  it("reads a new-only hash", async () => {
    const f = fakeRedis();
    f.hashes.set(RENAMED, new Map([["v1", entry("p2")]]));
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual(["p2"]);
  });

  it("returns nothing when both miss", async () => {
    expect(await readShiftAssignedPatientIds(fakeRedis().redis, "org", "u")).toEqual([]);
  });

  it("unions a pre-A visit (legacy only) with a post-A visit (both), new field winning", async () => {
    const f = fakeRedis();
    f.hashes.set(
      LEGACY,
      new Map([
        ["old", entry("p-old")],
        ["v1", entry("p-stale")],
      ]),
    );
    f.hashes.set(RENAMED, new Map([["v1", entry("p-new")]]));
    const ids = [...(await readShiftAssignedPatientIds(f.redis, "org", "u"))].sort();
    expect(ids).toEqual(["p-new", "p-old"]);
  });
});

describe("shift caseload cache unassign is atomic and write order is new-first", () => {
  const seedBoth = (f: ReturnType<typeof fakeRedis>) => {
    const e = JSON.stringify({ patientId: "p1", expiresAt: future() });
    f.hashes.set(LEGACY, new Map([["v1", e]]));
    f.hashes.set(RENAMED, new Map([["v1", e]]));
  };

  it("throws when one of the two deletes errors, so the outbox retries", async () => {
    const f = fakeRedis([
      [null, 1],
      [new Error("READONLY"), 0],
    ]);
    seedBoth(f);
    await expect(removeShiftAssignment(f.redis, "org", "u", "v1")).rejects.toThrow("READONLY");
  });

  it("throws when the transaction was not executed", async () => {
    const f = fakeRedis(null as unknown as Array<[Error | null, number]>);
    // a null exec result must not be mistaken for success
    f.redis.multi = (() => ({ hdel() { return this; }, async exec() { return null; } })) as never;
    await expect(removeShiftAssignment(f.redis, "org", "u", "v1")).rejects.toThrow(/not executed/);
  });

  it("writes the new key before the legacy key", async () => {
    const order: string[] = [];
    const f = fakeRedis();
    const hset = f.redis.hset.bind(f.redis);
    f.redis.hset = (async (k: string, field: string, v: string) => {
      order.push(k);
      return hset(k, field, v);
    }) as never;
    await writeShiftAssignment(f.redis, "org", "u", "v1", "p1", future());
    expect(order).toEqual([RENAMED, LEGACY]);
  });
});
