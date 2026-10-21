// GAP-008 — the pure inviter-ceiling rule (apps/backend/src/modules/03-authorization/proposed-role-ceiling.ts).
import type { AuditExecutor } from "@chartwarden/audit";
import { describe, expect, it } from "vitest";
import {
  type ProposableRole,
  ROLE_ASSIGN_PERMISSION,
  checkRoleCeiling,
  createProposedRoleGuard,
} from "../src/modules/03-authorization/proposed-role-ceiling";

const role = (
  key: string,
  permissionKeys: string[],
  category = "clinical_staff",
): ProposableRole => ({
  id: key,
  key,
  category,
  permissionKeys,
});

describe("checkRoleCeiling", () => {
  it("allows an empty proposal without needing any permission", () => {
    expect(checkRoleCeiling(new Set(), [])).toEqual({ ok: true });
  });

  it("requires role.assign to propose anything", () => {
    const verdict = checkRoleCeiling(new Set(["member.invite", "patient.read"]), [
      role("reader", ["patient.read"]),
    ]);
    expect(verdict).toEqual({ ok: false, reason: "role_assign_missing" });
  });

  it("blocks a role carrying a permission the inviter lacks", () => {
    const held = new Set([ROLE_ASSIGN_PERMISSION, "member.invite"]);
    expect(checkRoleCeiling(held, [role("org_admin", ["member.invite", "org.manage"])])).toEqual({
      ok: false,
      reason: "escalation",
      roleKey: "org_admin",
      permission: "org.manage",
    });
  });

  it("blocks a reserved platform role even when the inviter holds every permission", () => {
    const held = new Set([ROLE_ASSIGN_PERMISSION]);
    expect(checkRoleCeiling(held, [role("platform_admin", [])])).toMatchObject({
      ok: false,
      reason: "reserved",
    });
    expect(checkRoleCeiling(held, [role("x", [], "platform_staff")])).toMatchObject({
      ok: false,
      reason: "reserved",
    });
  });

  it("allows a role whose permissions are a subset of the inviter's", () => {
    const held = new Set([ROLE_ASSIGN_PERMISSION, "patient.read", "patient.edit"]);
    expect(checkRoleCeiling(held, [role("reader", ["patient.read"])])).toEqual({ ok: true });
  });

  it("one over-ceiling role blocks the whole proposal", () => {
    const held = new Set([ROLE_ASSIGN_PERMISSION, "patient.read"]);
    const verdict = checkRoleCeiling(held, [
      role("reader", ["patient.read"]),
      role("org_admin", ["org.manage"]),
    ]);
    expect(verdict).toMatchObject({ ok: false, reason: "escalation", roleKey: "org_admin" });
  });
});

describe("createProposedRoleGuard — reserved keys", () => {
  // The org has NO role by this key (platform roles are organization_id NULL), so the DB lookup returns
  // nothing. A reserved key must still be refused by name: "confers nothing here" is not "safe to store".
  const guard = createProposedRoleGuard({
    lookup: async () => [],
    effectivePermissions: async () => new Set([ROLE_ASSIGN_PERMISSION]),
    audit: {} as AuditExecutor,
  });
  const input = (roleKeys: string[]) => ({
    organizationId: "org_a",
    inviterUserId: "u1",
    roleKeys,
    auditContext: {} as never,
  });

  it.each(["platform_admin", "platform_ops", "ai_safety_owner"])(
    "refuses %s with 422 RESERVED_ROLE although the org has no such role",
    async (key) => {
      await expect(guard.assertProposable(input(["clinician", key]))).rejects.toMatchObject({
        code: "RESERVED_ROLE",
        statusCode: 422,
      });
    },
  );

  it("still allows an unknown non-reserved key (it confers nothing and is re-checked at accept)", async () => {
    await expect(guard.assertProposable(input(["no_such_role"]))).resolves.toBeUndefined();
  });
});
