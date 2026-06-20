/**
 * M38-T06 — Module 38 permission-key registration into Module 3's catalog (the §4.4 binding
 * cross-module handshake). M38's terminology routes are authorized BY M3, so their permission
 * keys must live in M3's catalog and mirror to the DB `permission` table.
 *
 * Accept (M38-T06): the five §4.4 keys are registered, single-owner, and namespaced under
 * `terminology.`; all are pure RBAC (`abac: 'none'`) — platform tables are non-tenant reference
 * data and the extension table is org-scoped by RLS; the keys do not collide with M3's locked
 * catalog or the M1/M2/M4 contributed sets; and they all flow into the consolidated
 * `allPermissionMirrorRows()` projection without breaking key uniqueness.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTED_PERMISSIONS,
  M38_CONTRIBUTED_PERMISSIONS,
  M4_CONTRIBUTED_PERMISSIONS,
  PERMISSIONS,
  allPermissionMirrorRows,
  m38ContributedPermissionMirrorRows,
} from "../src/permissions";

describe("M38-T06 terminology permission keys (§4.4 handshake)", () => {
  it("registers exactly the five §4.4 terminology keys", () => {
    expect(Object.keys(M38_CONTRIBUTED_PERMISSIONS).sort()).toEqual(
      [
        "terminology.read",
        "terminology.value_set.extend",
        "terminology.deprecation_report",
        "terminology.admin.read",
        "terminology.admin.load",
      ].sort(),
    );
  });

  it("every key is `terminology.`-namespaced and dot-segmented", () => {
    for (const key of Object.keys(M38_CONTRIBUTED_PERMISSIONS)) {
      expect(key).toMatch(/^terminology\.[a-z_]+(\.[a-z_]+)*$/);
    }
  });

  it("all five are pure RBAC (no ABAC predicate; reference data + RLS-scoped extension)", () => {
    for (const def of Object.values(M38_CONTRIBUTED_PERMISSIONS)) {
      expect(def.abac).toBe("none");
    }
  });

  it("the admin keys are platform-category; read is clinical, extend is admin", () => {
    expect(M38_CONTRIBUTED_PERMISSIONS["terminology.admin.read"].category).toBe("platform");
    expect(M38_CONTRIBUTED_PERMISSIONS["terminology.admin.load"].category).toBe("platform");
    expect(M38_CONTRIBUTED_PERMISSIONS["terminology.read"].category).toBe("clinical");
    expect(M38_CONTRIBUTED_PERMISSIONS["terminology.value_set.extend"].category).toBe("admin");
  });

  it("does NOT collide with M3's locked catalog or the M1/M2/M4 contributed sets (single-owner)", () => {
    for (const key of Object.keys(M38_CONTRIBUTED_PERMISSIONS)) {
      expect(key in PERMISSIONS).toBe(false);
      expect(key in CONTRIBUTED_PERMISSIONS).toBe(false);
      expect(key in M4_CONTRIBUTED_PERMISSIONS).toBe(false);
    }
  });

  it("projects one mirror row per M38 key for the DB `permission` table sync", () => {
    const rows = m38ContributedPermissionMirrorRows();
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(M38_CONTRIBUTED_PERMISSIONS).sort());
    for (const row of rows) {
      const def =
        M38_CONTRIBUTED_PERMISSIONS[row.key as keyof typeof M38_CONTRIBUTED_PERMISSIONS];
      expect(row.defaultAbac).toBe(def.abac);
      expect(row.resource).toBe(def.resource);
      expect(row.action).toBe(def.action);
    }
  });

  it("flows into the consolidated mirror without breaking key uniqueness", () => {
    const keys = allPermissionMirrorRows().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of Object.keys(M38_CONTRIBUTED_PERMISSIONS)) {
      expect(keys).toContain(key);
    }
  });
});
