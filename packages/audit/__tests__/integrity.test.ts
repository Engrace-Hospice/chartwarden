// @chartwarden/audit — M4-T11 integrity & tamper-evidence tests (M4 spec §10.4, §12.3).
//
// The security-critical §12.3 controls: the append-only GRANT model holds (no app-role UPDATE/
// DELETE/TRUNCATE on the audit log), the sample-vs-backup check detects an altered backup row, and
// the Phase-2 hash-chain seal breaks on any simulated modification.
import { describe, expect, it } from "vitest";
import {
  type GrantSnapshot,
  type IntegritySampleRow,
  compareSampleToBackup,
  computeChainHash,
  hashEvent,
  sealPartition,
  verifyAppendOnly,
  verifySealChain,
} from "../src/index";

describe("§12.3 append-only GRANT verification", () => {
  it("passes when the app role holds only SELECT/INSERT on audit_event", () => {
    const grants: GrantSnapshot[] = [
      { role: "wardenx_app", table: "audit_event", privileges: ["SELECT", "INSERT"] },
      { role: "wardenx_audit_writer", table: "audit_event", privileges: ["INSERT"] },
    ];
    expect(verifyAppendOnly(grants)).toEqual([]);
  });

  it("flags an app-role UPDATE/DELETE/TRUNCATE on the audit log (immutability breach)", () => {
    const grants: GrantSnapshot[] = [
      { role: "wardenx_app", table: "audit_event", privileges: ["SELECT", "UPDATE", "DELETE"] },
    ];
    const violations = verifyAppendOnly(grants);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ role: "wardenx_app", table: "audit_event" });
    expect(violations[0]!.forbidden.sort()).toEqual(["DELETE", "UPDATE"]);
  });

  it("ignores non-app roles and tables outside the audit allowlist", () => {
    const grants: GrantSnapshot[] = [
      { role: "wardenx_migrator", table: "audit_event", privileges: ["UPDATE"] },
      { role: "wardenx_app", table: "patient", privileges: ["UPDATE"] },
    ];
    expect(verifyAppendOnly(grants, { auditTables: ["audit_event"] })).toEqual([]);
  });

  it("is case-insensitive on role and privilege names", () => {
    const grants: GrantSnapshot[] = [
      { role: "WARDENX_APP", table: "audit_event", privileges: ["delete"] },
    ];
    expect(verifyAppendOnly(grants)).toHaveLength(1);
  });
});

describe("§12.3 sample-vs-backup integrity check", () => {
  const live: IntegritySampleRow[] = [
    { id: "e1", hash: "h1" },
    { id: "e2", hash: "h2" },
    { id: "e3", hash: "h3" },
  ];

  it("returns no mismatch when live and backup hashes agree", () => {
    expect(compareSampleToBackup(live, live)).toEqual([]);
  });

  it("detects a deliberately altered backup row (negative test)", () => {
    const backup: IntegritySampleRow[] = [
      { id: "e1", hash: "h1" },
      { id: "e2", hash: "TAMPERED" },
      { id: "e3", hash: "h3" },
    ];
    const mismatches = compareSampleToBackup(live, backup);
    expect(mismatches).toEqual([
      { id: "e2", kind: "altered", liveHash: "h2", backupHash: "TAMPERED" },
    ]);
  });

  it("flags rows missing from either side", () => {
    const backup: IntegritySampleRow[] = [
      { id: "e1", hash: "h1" },
      { id: "e4", hash: "h4" },
    ];
    const mismatches = compareSampleToBackup(live, backup);
    expect(mismatches.find((m) => m.id === "e2")?.kind).toBe("missing_in_backup");
    expect(mismatches.find((m) => m.id === "e3")?.kind).toBe("missing_in_backup");
    expect(mismatches.find((m) => m.id === "e4")?.kind).toBe("missing_in_live");
  });
});

describe("§3.5 hash-chain seal (Phase 2)", () => {
  const ev = (id: string, eventType: string) =>
    hashEvent({ id, createdAt: `2026-06-0${id.slice(-1)}T00:00:00.000Z`, eventType });

  it("hashes an event deterministically and independent of object key order", () => {
    const a = hashEvent({ id: "x", createdAt: "2026-01-01T00:00:00Z", eventType: "t", after: { a: 1, b: 2 } });
    const b = hashEvent({ id: "x", createdAt: "2026-01-01T00:00:00Z", eventType: "t", after: { a: 1, b: 2 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seals a partition over its ordered events with the prior chain link", () => {
    const events: IntegritySampleRow[] = [
      { id: "e1", hash: ev("e1", "patient.viewed") },
      { id: "e2", hash: ev("e2", "patient.updated") },
    ];
    const seal = sealPartition({
      partition: "audit_event_2026_06",
      organizationId: "org_1",
      events,
      prevChainHash: null,
    });
    expect(seal).toMatchObject({
      partition: "audit_event_2026_06",
      fromId: "e1",
      toId: "e2",
      eventCount: 2,
      prevChainHash: null,
      algorithm: "sha256",
    });
    expect(seal.chainHash).toBe(computeChainHash(null, [events[0]!.hash, events[1]!.hash]));
  });

  it("refuses to seal an empty partition", () => {
    expect(() =>
      sealPartition({ partition: "p", organizationId: null, events: [], prevChainHash: null }),
    ).toThrow(/empty partition/);
  });

  it("verifies an intact two-partition chain", () => {
    const p1: IntegritySampleRow[] = [{ id: "a1", hash: "ha1" }, { id: "a2", hash: "ha2" }];
    const p2: IntegritySampleRow[] = [{ id: "b1", hash: "hb1" }];
    const s1 = sealPartition({ partition: "p1", organizationId: null, events: p1, prevChainHash: null });
    const s2 = sealPartition({ partition: "p2", organizationId: null, events: p2, prevChainHash: s1.chainHash });
    const hashes: Record<string, string[]> = { p1: ["ha1", "ha2"], p2: ["hb1"] };
    expect(verifySealChain([s1, s2], (p) => hashes[p]!)).toEqual([]);
  });

  it("breaks the chain when a sealed event is modified after the fact", () => {
    const p1: IntegritySampleRow[] = [{ id: "a1", hash: "ha1" }, { id: "a2", hash: "ha2" }];
    const s1 = sealPartition({ partition: "p1", organizationId: null, events: p1, prevChainHash: null });
    // Recompute with a tampered event hash → the seal's chainHash no longer matches.
    const tampered: Record<string, string[]> = { p1: ["ha1", "TAMPERED"] };
    const breaks = verifySealChain([s1], (p) => tampered[p]!);
    expect(breaks).toEqual([{ partition: "p1", reason: "chain_hash_mismatch" }]);
  });

  it("breaks the chain when a prior seal is removed (prev-link mismatch)", () => {
    const p1: IntegritySampleRow[] = [{ id: "a1", hash: "ha1" }];
    const p2: IntegritySampleRow[] = [{ id: "b1", hash: "hb1" }];
    const s1 = sealPartition({ partition: "p1", organizationId: null, events: p1, prevChainHash: null });
    const s2 = sealPartition({ partition: "p2", organizationId: null, events: p2, prevChainHash: s1.chainHash });
    const hashes: Record<string, string[]> = { p2: ["hb1"] };
    // Verify s2 alone: its prevChainHash points at the (now-absent) s1, so the prev link is broken.
    expect(verifySealChain([s2], (p) => hashes[p]!)).toContainEqual({
      partition: "p2",
      reason: "prev_link_mismatch",
    });
  });
});
