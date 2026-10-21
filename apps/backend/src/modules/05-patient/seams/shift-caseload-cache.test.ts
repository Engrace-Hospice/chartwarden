// wardenx -> chartwarden Valkey rename, release A: dual-write both hashes (same TTL), read legacy, delete from both.
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
  };
  return { redis: redis as unknown as Redis, hashes, ttl };
}

const LEGACY = "wardenx:m5:caseload-cache:org:u";
const RENAMED = "chartwarden:m5:caseload-cache:org:u";
const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe("shift caseload cache dual-write", () => {
  it("writes both hashes with the 24 h TTL, reads legacy, and removes from both", async () => {
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

  it("reads only the legacy hash in release A", async () => {
    const f = fakeRedis();
    await writeShiftAssignment(f.redis, "org", "u", "v1", "p1", future());
    f.hashes.delete(LEGACY);
    expect(await readShiftAssignedPatientIds(f.redis, "org", "u")).toEqual([]);
  });
});
