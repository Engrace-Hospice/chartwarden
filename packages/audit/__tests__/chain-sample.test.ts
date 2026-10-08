// M4 §4.4 — the pure half of the sampled audit hash-chain verification.
import { describe, expect, it } from "vitest";
import {
  type AuditRowForHash,
  type StoredSeal,
  computeChainHash,
  compareSealToRecomputed,
  createChainHasher,
  hashAuditRow,
  monthBounds,
  monthForPartitionName,
  partitionNameForMonth,
  selectSealSample,
  verifySealLinkage,
} from "../src/index";

const row = (over: Partial<AuditRowForHash> = {}): AuditRowForHash => ({
  id: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-04-01T10:00:00.123456Z",
  organizationId: "00000000-0000-4000-8000-0000000000aa",
  actorUserId: "00000000-0000-4000-8000-0000000000bb",
  actorKind: "user",
  actorRole: null,
  eventType: "patient.updated",
  resourceKind: "patient",
  resourceId: "00000000-0000-4000-8000-0000000000cc",
  correlationId: "corr-1",
  outcome: "success",
  severity: "info",
  retentionClass: "compliance",
  beforeText: '{"status": "a"}',
  afterText: '{"status": "b"}',
  contextText: "{}",
  ...over,
});

describe("hashAuditRow", () => {
  it("is deterministic", () => {
    expect(hashAuditRow(row())).toBe(hashAuditRow(row()));
    expect(hashAuditRow(row())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY tamper-relevant column changes (including sub-millisecond time)", () => {
    const base = hashAuditRow(row());
    const variants: Array<Partial<AuditRowForHash>> = [
      { id: "00000000-0000-4000-8000-000000000002" },
      { createdAt: "2026-04-01T10:00:00.123457Z" },
      { organizationId: null },
      { actorUserId: null },
      { actorKind: "system" },
      { actorRole: "admin" },
      { eventType: "patient.deleted" },
      { resourceKind: "order" },
      { resourceId: null },
      { correlationId: "corr-2" },
      { outcome: "failure" },
      { severity: "critical" },
      { retentionClass: "operational" },
      { beforeText: null },
      { afterText: '{"status": "tampered"}' },
      { contextText: '{"x": 1}' },
    ];
    for (const v of variants) expect(hashAuditRow(row(v))).not.toBe(base);
  });
});

describe("createChainHasher", () => {
  it("equals computeChainHash over the same ordered hashes", () => {
    const hashes = ["aa", "bb", "cc"];
    const hasher = createChainHasher("prev");
    for (const h of hashes) hasher.add(h);
    expect(hasher.digest()).toBe(computeChainHash("prev", hashes));
    const genesis = createChainHasher(null);
    for (const h of hashes) genesis.add(h);
    expect(genesis.digest()).toBe(computeChainHash(null, hashes));
  });

  it("is order sensitive", () => {
    const a = createChainHasher(null);
    a.add("x");
    a.add("y");
    const b = createChainHasher(null);
    b.add("y");
    b.add("x");
    expect(a.digest()).not.toBe(b.digest());
  });
});

const seal = (partition: string, prev: string | null, chain: string): StoredSeal => ({
  partition,
  prevChainHash: prev,
  chainHash: chain,
  eventCount: 3,
  fromId: "f",
  toId: "t",
});

describe("verifySealLinkage", () => {
  it("accepts a genesis-rooted contiguous chain", () => {
    expect(
      verifySealLinkage([seal("p1", null, "h1"), seal("p2", "h1", "h2"), seal("p3", "h2", "h3")]),
    ).toEqual([]);
  });

  it("flags a removed, reordered or substituted seal", () => {
    expect(verifySealLinkage([seal("p1", null, "h1"), seal("p3", "h2", "h3")])).toEqual([
      { partition: "p3", reason: "prev_link_mismatch" },
    ]);
    expect(verifySealLinkage([seal("p2", "h1", "h2")])).toEqual([
      { partition: "p2", reason: "prev_link_mismatch" },
    ]);
  });
});

describe("selectSealSample", () => {
  const seals = ["a", "b", "c", "d", "e"];

  it("always includes the newest seal and never repeats", () => {
    const picked = selectSealSample(seals, 3, () => 0);
    expect(picked).toHaveLength(3);
    expect(picked).toContain("e");
    expect(new Set(picked).size).toBe(3);
  });

  it("returns everything when the sample covers the chain, and nothing for empty / zero", () => {
    expect(selectSealSample(seals, 10)).toEqual(seals);
    expect(selectSealSample([], 3)).toEqual([]);
    expect(selectSealSample(seals, 0)).toEqual([]);
  });
});

describe("compareSealToRecomputed", () => {
  const stored = seal("p", null, "h");
  it("returns null on a match and the FIRST divergence otherwise", () => {
    expect(
      compareSealToRecomputed(stored, { eventCount: 3, fromId: "f", toId: "t", chainHash: "h" }),
    ).toBeNull();
    expect(
      compareSealToRecomputed(stored, { eventCount: 4, fromId: "f", toId: "t", chainHash: "x" }),
    ).toBe("event_count_mismatch");
    expect(
      compareSealToRecomputed(stored, { eventCount: 3, fromId: "g", toId: "t", chainHash: "x" }),
    ).toBe("first_last_mismatch");
    expect(
      compareSealToRecomputed(stored, { eventCount: 3, fromId: "f", toId: "t", chainHash: "x" }),
    ).toBe("chain_hash_mismatch");
  });
});

describe("month helpers", () => {
  it("round-trips partition names and bounds months in UTC", () => {
    expect(partitionNameForMonth("2026-04")).toBe("audit_event_2026_04");
    expect(monthForPartitionName("audit_event_2026_04")).toBe("2026-04");
    expect(monthBounds("2026-12")).toEqual({
      start: "2026-12-01T00:00:00.000Z",
      next: "2027-01-01T00:00:00.000Z",
    });
  });

  it("refuses a malformed month before it can reach SQL", () => {
    for (const bad of ["2026-13", "2026-4", "x; DROP TABLE audit_event", ""]) {
      expect(() => monthBounds(bad)).toThrow();
    }
  });
});
