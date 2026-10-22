// wardenx -> chartwarden Valkey rename, release C: only the chartwarden hash is written, read and deleted; a legacy hash is ignored.
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import {
  readShiftAssignedPatientIds,
  removeShiftAssignment,
  writeShiftAssignment,
} from "./shift-caseload-cache";

function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const ttl = new Map<string, number>();
  const writes: string[] = [];
  const redis = {
    async hset(k: string, f: string, v: string) {
      writes.push(k);
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
  };
  return { redis: redis as unknown as Redis, hashes, ttl, writes };
}

const LEGACY = "wardenx:m5:caseload-cache:org:u";
const KEY = "chartwarden:m5:caseload-cache:org:u";
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const entry = (patientId: string) => JSON.stringify({ patientId, expiresAt: future() });

describe("shift caseload cache (chartwarden key only)", () => {
  it("writes only the chartwarden hash with the 24 h TTL, reads it, and removes it", async () => {
    const f = fakeRedis();
    await writeShiftAssignment(f.redis, "org", "u", "v1", "p1", future());
    expect([...f.hashes.keys()]).toEqual([KEY]);
    expect(f.writes).toEqual([KEY]);
    expect(f.ttl.get(KEY)).toBe(86_400);
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual(["p1"]);
    await removeShiftAssignment(f.redis, "org", "u", "v1");
    expect(f.hashes.size).toBe(0);
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual([]);
  });

  it("ignores a legacy-only hash", async () => {
    const f = fakeRedis();
    f.hashes.set(LEGACY, new Map([["v1", entry("p1")]]));
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual([]);
  });

  it("reads only the chartwarden hash when both exist", async () => {
    const f = fakeRedis();
    f.hashes.set(LEGACY, new Map([["old", entry("p-old")]]));
    f.hashes.set(KEY, new Map([["v1", entry("p-new")]]));
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual(["p-new"]);
  });

  it("unassign deletes only the chartwarden entry and leaves a legacy hash untouched", async () => {
    const f = fakeRedis();
    f.hashes.set(LEGACY, new Map([["v1", entry("p1")]]));
    f.hashes.set(KEY, new Map([["v1", entry("p1")]]));
    await removeShiftAssignment(f.redis, "org", "u", "v1");
    expect(f.hashes.has(KEY)).toBe(false);
    expect(f.hashes.get(LEGACY)?.has("v1")).toBe(true);
  });

  it("propagates a delete error so the outbox retries", async () => {
    const f = fakeRedis();
    f.redis.hdel = (async () => {
      throw new Error("READONLY");
    }) as never;
    await expect(removeShiftAssignment(f.redis, "org", "u", "v1")).rejects.toThrow("READONLY");
  });

  it("degrades to no contribution on a read error", async () => {
    const f = fakeRedis();
    f.redis.hgetall = (async () => {
      throw new Error("down");
    }) as never;
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual([]);
  });
});
