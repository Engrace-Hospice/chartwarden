/**
 * M40-T07 — Module 40 permission-key registration into Module 3's catalog (the §4.4 binding
 * cross-module handshake). M40's MDM routes are authorized BY M3, so their permission keys must
 * live in M3's catalog and mirror to the DB `permission` table.
 *
 * Accept (M40-T07): the 29 §4.4 keys are registered, single-owner, and namespaced under `mdm.`;
 * three keys per entity kind (read/propose/overlay) for the seven kinds, plus the BAA / license /
 * platform-ops governance keys, plus the two GAP-158 grief-resource catalog keys; all pure RBAC (`abac: 'none'`); the platform-only keys
 * (`mdm.canonical.write` / `mdm.merge.read` / `mdm.merge.approve`) carry the `platform` category so
 * they are never assigned to a tenant role; and they all flow into `allPermissionMirrorRows()`
 * without breaking key uniqueness.
 */
import { describe, expect, it } from "vitest";
import {
  M40_CONTRIBUTED_PERMISSIONS,
  allPermissionMirrorRows,
  m40ContributedPermissionMirrorRows,
} from "../src/permissions";

const KINDS = [
  "physician",
  "facility",
  "pharmacy",
  "referral_source",
  "payer",
  "dme_vendor",
  "funeral_home",
];

describe("M40-T07 MDM permission keys (§4.4 handshake)", () => {
  it("registers three keys per kind plus the governance keys (29 total)", () => {
    const expected = [
      ...KINDS.flatMap((k) => [`mdm.${k}.read`, `mdm.${k}.propose`, `mdm.${k}.overlay`]),
      "mdm.baa.read",
      "mdm.baa.manage",
      "mdm.license.manage",
      "mdm.canonical.write",
      "mdm.merge.read",
      "mdm.merge.approve",
      "mdm.grief_resource.read",
      "mdm.grief_resource.manage",
    ];
    expect(Object.keys(M40_CONTRIBUTED_PERMISSIONS).sort()).toEqual(expected.sort());
    expect(Object.keys(M40_CONTRIBUTED_PERMISSIONS)).toHaveLength(29);
  });

  it("every key is namespaced under `mdm.` and dot-segmented", () => {
    for (const key of Object.keys(M40_CONTRIBUTED_PERMISSIONS)) {
      expect(key).toMatch(/^mdm\.[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it("all keys are pure RBAC (canonical is public / overlay is org-scoped by RLS)", () => {
    for (const def of Object.values(M40_CONTRIBUTED_PERMISSIONS)) {
      expect(def.abac).toBe("none");
    }
  });

  it("the platform-only governance keys carry the `platform` category (never tenant-granted)", () => {
    for (const key of ["mdm.canonical.write", "mdm.merge.read", "mdm.merge.approve"] as const) {
      expect(M40_CONTRIBUTED_PERMISSIONS[key].category).toBe("platform");
    }
  });

  it("projects one mirror row per key, flowing into the consolidated mirror single-owner", () => {
    const rows = m40ContributedPermissionMirrorRows();
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(M40_CONTRIBUTED_PERMISSIONS).sort());
    const all = allPermissionMirrorRows().map((r) => r.key);
    for (const key of Object.keys(M40_CONTRIBUTED_PERMISSIONS)) expect(all).toContain(key);
    expect(new Set(all).size).toBe(all.length); // no collision with any other module's set
  });
});
