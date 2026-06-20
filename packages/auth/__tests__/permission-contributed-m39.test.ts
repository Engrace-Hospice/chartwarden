/**
 * M39-T07 — Module 39 permission-key registration into Module 3's catalog (the §4.7 binding
 * cross-module handshake). M39's consent routes are authorized BY M3, so their permission keys must
 * live in M3's catalog and mirror to the DB `permission` table.
 *
 * Accept: the 15 §4.7 keys are registered, single-owner, `consent.`-resourced, key === resource.action,
 * and flow into allPermissionMirrorRows() without breaking key uniqueness.
 */
import { describe, expect, it } from "vitest";
import {
  M39_CONTRIBUTED_PERMISSIONS,
  allPermissionMirrorRows,
  m39ContributedPermissionMirrorRows,
} from "../src/permissions";

describe("M39-T07 consent permission keys (§4.7 handshake)", () => {
  it("registers the 15 §4.7 keys", () => {
    const expected = [
      "consent.read_catalog",
      "consent.read",
      "consent.read_history",
      "consent.read_phi_content",
      "consent.read_eval_audit",
      "consent.author",
      "consent.sign",
      "consent.revoke",
      "consent.manage_overlay",
      "consent.admin_re_render",
      "consent.delegate_assignment",
      "consent.portal_self_service",
      "consent.read_bereavement_outreach",
      "consent.bereavement_outreach_author",
      "consent.cascade_admin",
    ];
    expect(Object.keys(M39_CONTRIBUTED_PERMISSIONS).sort()).toEqual(expected.sort());
    expect(Object.keys(M39_CONTRIBUTED_PERMISSIONS)).toHaveLength(15);
  });

  it("every key is `consent.<action>` and reconstructs from resource/action", () => {
    for (const [key, def] of Object.entries(M39_CONTRIBUTED_PERMISSIONS)) {
      expect(key).toMatch(/^consent\.[a-z_]+$/);
      expect(key).toBe(`${def.resource}.${def.action}`);
      expect(def.resource).toBe("consent");
    }
  });

  it("the platform/admin governance keys carry a non-clinical category", () => {
    expect(M39_CONTRIBUTED_PERMISSIONS["consent.cascade_admin"].category).toBe("platform");
    expect(M39_CONTRIBUTED_PERMISSIONS["consent.manage_overlay"].category).toBe("admin");
    expect(M39_CONTRIBUTED_PERMISSIONS["consent.admin_re_render"].category).toBe("admin");
  });

  it("projects one mirror row per key, flowing into the consolidated mirror single-owner", () => {
    const rows = m39ContributedPermissionMirrorRows();
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(M39_CONTRIBUTED_PERMISSIONS).sort());
    const all = allPermissionMirrorRows().map((r) => r.key);
    for (const key of Object.keys(M39_CONTRIBUTED_PERMISSIONS)) expect(all).toContain(key);
    expect(new Set(all).size).toBe(all.length); // no collision with any other module's set
  });
});
