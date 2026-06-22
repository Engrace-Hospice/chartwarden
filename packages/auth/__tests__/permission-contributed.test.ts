/**
 * M3-T10 — M1/M2 permission-key back-fill into the now-real catalog (spec §3.3 / M03-F07;
 * M2 spec §4.7 handshake). Closes the M2-T08 deferral.
 *
 * Accept (M3-T10): the M1/M2 keys their flipped routes gate on are registered into M3's
 * catalog and mirror to the DB `permission` table alongside M3's own keys, single-owner
 * (no collision), with the canonical `caseload_membership` ABAC predicate on the
 * per-patient collaborator key.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTED_PERMISSIONS,
  M4_CONTRIBUTED_PERMISSIONS,
  M5_CONTRIBUTED_PERMISSIONS,
  M6_CONTRIBUTED_PERMISSIONS,
  M7_CONTRIBUTED_PERMISSIONS,
  M8_CONTRIBUTED_PERMISSIONS,
  M9_CONTRIBUTED_PERMISSIONS,
  M10_CONTRIBUTED_PERMISSIONS,
  M11_CONTRIBUTED_PERMISSIONS,
  M12_CONTRIBUTED_PERMISSIONS,
  M36_CONTRIBUTED_PERMISSIONS,
  M38_CONTRIBUTED_PERMISSIONS,
  M39_CONTRIBUTED_PERMISSIONS,
  M40_CONTRIBUTED_PERMISSIONS,
  PERMISSIONS,
  allPermissionMirrorRows,
  contributedPermissionMirrorRows,
} from "../src/permissions";

describe("M3-T10 contributed permission keys (M1/M2 back-fill)", () => {
  it("registers Module 2's §4.7 admin + collaborator keys", () => {
    expect(Object.keys(CONTRIBUTED_PERMISSIONS).sort()).toEqual(
      [
        "org.manage",
        "member.invite",
        "member.manage",
        "user.deactivate",
        "collaborator.invite",
      ].sort(),
    );
  });

  it("keys are `resource.action` namespaced and reconstruct from resource/action", () => {
    for (const [key, def] of Object.entries(CONTRIBUTED_PERMISSIONS)) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(key).toBe(`${def.resource}.${def.action}`);
    }
  });

  it("collaborator.invite carries the caseload_membership ABAC predicate (§4.7)", () => {
    expect(CONTRIBUTED_PERMISSIONS["collaborator.invite"].abac).toBe("caseload_membership");
  });

  it("does NOT leak into M3's locked cross-cutting catalog", () => {
    for (const key of Object.keys(CONTRIBUTED_PERMISSIONS)) {
      expect(key in PERMISSIONS).toBe(false);
    }
  });
});

describe("M3-T10 catalog ↔ DB mirror — merged M3 + contributed", () => {
  it("projects one mirror row per contributed key", () => {
    const rows = contributedPermissionMirrorRows();
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(CONTRIBUTED_PERMISSIONS).sort());
  });

  it("the full mirror is M3's keys plus every contributed (M1/M2 + M4 + M38 + M36 + M40 + M5 + M39 + M6 + M7 + M8 + M9 + M10 + M11 + M12) key, single-owner", () => {
    const rows = allPermissionMirrorRows();
    const keys = rows.map((r) => r.key);
    expect(keys.length).toBe(
      Object.keys(PERMISSIONS).length +
        Object.keys(CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M4_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M38_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M36_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M40_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M5_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M39_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M6_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M7_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M8_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M9_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M10_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M11_CONTRIBUTED_PERMISSIONS).length +
        Object.keys(M12_CONTRIBUTED_PERMISSIONS).length,
    );
    expect(new Set(keys).size).toBe(keys.length); // no collision across the fifteen sets
  });
});
