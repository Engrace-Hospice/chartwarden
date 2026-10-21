// @chartwarden/messaging - GAP-040: the `permission_holders` recipient resolver. A cap alert's audience is "whoever
// holds the permission", not a role-key list a tenant must have hand-created (the old seed named `cfo` /
// `billing_manager`, neither of which is a role template, so a fresh tenant paged nobody).
import { describe, expect, it, vi } from "vitest";
import {
  type RecipientSourcePorts,
  createRecipientResolverRegistry,
  resolveRecipients,
} from "../src/index";
import { BILLING_CAP_ALERT_RULES } from "../src/seed/alert-rules-billing-cap";

function fakePorts(over: Partial<RecipientSourcePorts> = {}): RecipientSourcePorts {
  return {
    careTeamMembers: vi.fn(async () => []),
    onCallMembers: vi.fn(async () => []),
    disciplineMembers: vi.fn(async () => []),
    roleSetMembers: vi.fn(async () => []),
    tenantAdmins: vi.fn(async () => ["u-admin"]),
    orgMembers: vi.fn(async () => []),
    permissionHolders: vi.fn(async () => ["u-holder"]),
    ...over,
  };
}

const resolve = (ports: RecipientSourcePorts, args: Record<string, unknown>) =>
  resolveRecipients(
    createRecipientResolverRegistry(ports),
    "permission_holders",
    "org-1",
    args,
    {},
  );

describe("permission_holders resolver", () => {
  it("resolves the holders of the named permission keys", async () => {
    const ports = fakePorts();
    const out = await resolve(ports, { permissionKeys: ["cap.event.read"] });
    expect(out).toEqual(["u-holder"]);
    expect(ports.permissionHolders).toHaveBeenCalledWith("org-1", ["cap.event.read"]);
  });

  it("unions in the members of alsoRoleKeys, deduped", async () => {
    const ports = fakePorts({
      permissionHolders: vi.fn(async () => ["u-holder", "u-both"]),
      roleSetMembers: vi.fn(async () => ["u-both", "u-compliance"]),
    });
    const out = await resolve(ports, {
      permissionKeys: ["cap.event.read"],
      alsoRoleKeys: ["compliance_officer"],
    });
    expect(out).toEqual(["u-holder", "u-both", "u-compliance"]);
    expect(ports.roleSetMembers).toHaveBeenCalledWith("org-1", ["compliance_officer"]);
  });

  it("falls back to the tenant admins ONLY when nobody holds the permission and the rule asks for it", async () => {
    const empty = fakePorts({ permissionHolders: vi.fn(async () => []) });
    expect(
      await resolve(empty, { permissionKeys: ["cap.event.read"], fallbackToTenantAdmins: true }),
    ).toEqual(["u-admin"]);
    expect(await resolve(empty, { permissionKeys: ["cap.event.read"] })).toEqual([]);
    const held = fakePorts();
    await resolve(held, { permissionKeys: ["cap.event.read"], fallbackToTenantAdmins: true });
    expect(held.tenantAdmins).not.toHaveBeenCalled();
  });

  it("an unbound permissionHolders port reads as nobody, so the floor still applies", async () => {
    const { permissionHolders: _unbound, ...rest } = fakePorts();
    expect(
      await resolve(rest as RecipientSourcePorts, {
        permissionKeys: ["cap.event.read"],
        fallbackToTenantAdmins: true,
      }),
    ).toEqual(["u-admin"]);
  });

  it("ignores malformed permissionKeys instead of resolving everyone", async () => {
    const ports = fakePorts();
    expect(await resolve(ports, { permissionKeys: "cap.event.read" })).toEqual([]);
    expect(await resolve(ports, { permissionKeys: [] })).toEqual([]);
    expect(await resolve(ports, { permissionKeys: [42] })).toEqual([]);
    expect(ports.permissionHolders).not.toHaveBeenCalled();
  });
});

describe("the seeded M26 cap alert audiences", () => {
  const capRules = BILLING_CAP_ALERT_RULES.filter((r) => r.eventType.startsWith("m26.cap."));

  it("every m26.cap.* rule resolves through permission_holders with a tenant-admin floor", () => {
    expect(capRules.length).toBeGreaterThan(0);
    for (const rule of capRules) {
      expect(rule.recipientResolver).toBe("permission_holders");
      expect(rule.resolverArgs.permissionKeys).toEqual(["cap.event.read"]);
      expect(rule.resolverArgs.fallbackToTenantAdmins).toBe(true);
    }
  });

  it("no cap rule names a role key that is not a real role template (cfo, billing_manager)", () => {
    for (const rule of capRules) {
      const keys = [
        ...((rule.resolverArgs.alsoRoleKeys as string[] | undefined) ?? []),
        ...((rule.resolverArgs.roleKeys as string[] | undefined) ?? []),
      ];
      expect(keys).not.toContain("cfo");
      expect(keys).not.toContain("billing_manager");
    }
  });

  it("breach rules keep escalating to compliance and org admins", () => {
    for (const rule of capRules.filter((r) => r.eventType.includes("breach"))) {
      expect(rule.resolverArgs.alsoRoleKeys).toEqual(["compliance_officer", "org_admin"]);
    }
  });
});
