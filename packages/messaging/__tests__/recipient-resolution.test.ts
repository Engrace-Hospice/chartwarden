// @chartwarden/messaging — M36-T04 recipient-resolution tests (spec §2.1.3, §2.5, §4.6).
//
// Resolution is dynamic at emit time and consults the source-of-truth ports, dedupes, and
// refuses an unregistered resolver (§2.5). Fakes stand in for the M5/M19/M2 seams.
import { describe, expect, it, vi } from "vitest";
import {
  type RecipientSourcePorts,
  UnknownRecipientResolverError,
  createRecipientResolverRegistry,
  resolveRecipients,
} from "../src/index";

function fakePorts(over: Partial<RecipientSourcePorts> = {}): RecipientSourcePorts {
  return {
    careTeamMembers: vi.fn(async () => ["u-ct1", "u-ct2"]),
    onCallMembers: vi.fn(async () => ["u-oncall"]),
    disciplineMembers: vi.fn(async () => ["u-rn1", "u-rn2"]),
    roleSetMembers: vi.fn(async () => ["u-role"]),
    tenantAdmins: vi.fn(async () => ["u-admin"]),
    orgMembers: vi.fn(async () => ["u-a", "u-b"]),
    ...over,
  };
}

describe("role_set userIdPaths (per-event audience member on top of the role set)", () => {
  it("adds the user ids held at the named payload keys, deduped, skipping absent / non-string values", async () => {
    const ports = fakePorts({ roleSetMembers: vi.fn(async () => ["u-comp", "u-coord"]) });
    const registry = createRecipientResolverRegistry(ports);
    const out = await resolveRecipients(
      registry,
      "role_set",
      "org-1",
      { roleKeys: ["compliance_officer"], userIdPaths: ["coordinatorUserId", "missing", "num"] },
      { coordinatorUserId: "u-coord", num: 7 },
    );
    expect(out).toEqual(["u-comp", "u-coord"]);
    expect(ports.roleSetMembers).toHaveBeenCalledWith("org-1", ["compliance_officer"]);
  });

  it("a payload-only audience member is still resolved when the role set is empty", async () => {
    const ports = fakePorts({ roleSetMembers: vi.fn(async () => []) });
    const registry = createRecipientResolverRegistry(ports);
    const out = await resolveRecipients(
      registry,
      "role_set",
      "org-1",
      { roleKeys: [], userIdPaths: ["coordinatorUserId"] },
      { coordinatorUserId: "u-coord" },
    );
    expect(out).toEqual(["u-coord"]);
  });
});

describe("recipient resolution (§2.1.3 / §4.6)", () => {
  it("care_team reads the patient id from the payload and queries the seam", async () => {
    const ports = fakePorts();
    const registry = createRecipientResolverRegistry(ports);
    const out = await resolveRecipients(registry, "care_team", "org-1", {}, { patientId: "p-9" });
    expect(out).toEqual(["u-ct1", "u-ct2"]);
    expect(ports.careTeamMembers).toHaveBeenCalledWith("org-1", "p-9");
  });

  it("care_team honors a custom patientIdPath arg", async () => {
    const ports = fakePorts();
    const registry = createRecipientResolverRegistry(ports);
    await resolveRecipients(
      registry,
      "care_team",
      "org-1",
      { patientIdPath: "subjectId" },
      { subjectId: "p-77" },
    );
    expect(ports.careTeamMembers).toHaveBeenCalledWith("org-1", "p-77");
  });

  it("care_team resolves to nobody when the payload has no patient id (no seam call)", async () => {
    const ports = fakePorts();
    const registry = createRecipientResolverRegistry(ports);
    const out = await resolveRecipients(registry, "care_team", "org-1", {}, {});
    expect(out).toEqual([]);
    expect(ports.careTeamMembers).not.toHaveBeenCalled();
  });

  it("on_call resolves who is on shift now (dynamic, not frozen on the rule)", async () => {
    const ports = fakePorts({ onCallMembers: vi.fn(async () => ["whoever-is-on-now"]) });
    const registry = createRecipientResolverRegistry(ports);
    const out = await resolveRecipients(
      registry,
      "on_call",
      "org-1",
      {},
      { providerEntityId: "prov-1" },
    );
    expect(out).toEqual(["whoever-is-on-now"]);
    expect(ports.onCallMembers).toHaveBeenCalledWith("org-1", "prov-1");
  });

  it("discipline + role_set pass their args through to the seam", async () => {
    const ports = fakePorts();
    const registry = createRecipientResolverRegistry(ports);
    await resolveRecipients(registry, "discipline", "org-1", { disciplines: ["clinical_rn"] }, {});
    expect(ports.disciplineMembers).toHaveBeenCalledWith("org-1", ["clinical_rn"]);
    await resolveRecipients(registry, "role_set", "org-1", { roleKeys: ["msw"] }, {});
    expect(ports.roleSetMembers).toHaveBeenCalledWith("org-1", ["msw"]);
  });

  it("user_list is static — resolves straight from args, no port", async () => {
    const ports = fakePorts();
    const registry = createRecipientResolverRegistry(ports);
    const out = await resolveRecipients(
      registry,
      "user_list",
      "org-1",
      { userIds: ["u-1", "u-2"] },
      {},
    );
    expect(out).toEqual(["u-1", "u-2"]);
  });

  it("tenant_admins + broadcast hit the org-scoped ports", async () => {
    const ports = fakePorts();
    const registry = createRecipientResolverRegistry(ports);
    expect(await resolveRecipients(registry, "tenant_admins", "org-1", {}, {})).toEqual([
      "u-admin",
    ]);
    expect(await resolveRecipients(registry, "broadcast", "org-1", {}, {})).toEqual(["u-a", "u-b"]);
  });

  it("de-duplicates recipients, preserving first-seen order", async () => {
    const ports = fakePorts({ careTeamMembers: vi.fn(async () => ["u-1", "u-2", "u-1", "u-3"]) });
    const registry = createRecipientResolverRegistry(ports);
    const out = await resolveRecipients(registry, "care_team", "org-1", {}, { patientId: "p" });
    expect(out).toEqual(["u-1", "u-2", "u-3"]);
  });

  it("throws on an unregistered resolver (§2.5 — never a silent empty fan-out)", async () => {
    const registry = createRecipientResolverRegistry(fakePorts());
    await expect(
      resolveRecipients(registry, "does_not_exist", "org-1", {}, {}),
    ).rejects.toBeInstanceOf(UnknownRecipientResolverError);
  });

  it("the registry is open — a composition resolver (ADR-0024) can be registered onto it", async () => {
    const registry = createRecipientResolverRegistry(fakePorts());
    registry.set("ordering_provider", async () => ["u-ordering"]);
    const out = await resolveRecipients(registry, "ordering_provider", "org-1", {}, {});
    expect(out).toEqual(["u-ordering"]);
  });
});

describe("role_set userIdPaths (array) + roleKeysPath (per-event tier)", () => {
  it("a user-id path may hold a LIST of ids (expected attendees), deduped with the role audience", async () => {
    const ports = fakePorts({ roleSetMembers: vi.fn(async () => ["u-a"]) });
    const registry = createRecipientResolverRegistry(ports);
    const out = await resolveRecipients(
      registry,
      "role_set",
      "org-1",
      { roleKeys: ["r"], userIdPaths: ["attendeeUserIds"] },
      { attendeeUserIds: ["u-a", "u-b", "", 7, "u-c"] },
    );
    expect(out).toEqual(["u-a", "u-b", "u-c"]);
  });

  it("roleKeysPath adds the payload's role keys to the static ones (deduped, non-strings skipped)", async () => {
    const ports = fakePorts({ roleSetMembers: vi.fn(async () => ["u-sup"]) });
    const registry = createRecipientResolverRegistry(ports);
    await resolveRecipients(
      registry,
      "role_set",
      "org-1",
      { roleKeys: ["a"], roleKeysPath: "audienceRoleKeys" },
      { audienceRoleKeys: ["clinical_supervisor", "a", 3] },
    );
    expect(ports.roleSetMembers).toHaveBeenCalledWith("org-1", ["a", "clinical_supervisor"]);
  });

  it("an absent / empty tier path resolves to the static role set only", async () => {
    const ports = fakePorts({ roleSetMembers: vi.fn(async () => []) });
    const registry = createRecipientResolverRegistry(ports);
    await resolveRecipients(
      registry,
      "role_set",
      "org-1",
      { roleKeys: [], roleKeysPath: "audienceRoleKeys" },
      { audienceRoleKeys: [] },
    );
    expect(ports.roleSetMembers).toHaveBeenCalledWith("org-1", []);
  });
});

describe("role_set provider-entity narrowing (biller_for_pe)", () => {
  const args = {
    providerEntityIdPath: "providerEntityId",
    providerEntityScopedRoleKeys: ["billing_manager", "biller"],
    providerEntityFallbackRoleKeys: ["billing_manager"],
  };

  it("resolves only the members assigned to the payload's provider entity", async () => {
    const forPe = vi.fn(async () => ["u-biller-pe"]);
    const ports = fakePorts({
      roleSetMembers: vi.fn(async (_o: string, keys: readonly string[]) =>
        keys.length === 0 ? [] : ["u-org-wide"],
      ),
      roleSetMembersForProviderEntity: forPe,
    });
    const out = await resolveRecipients(
      createRecipientResolverRegistry(ports),
      "role_set",
      "org-1",
      args,
      { providerEntityId: "pe-1" },
    );
    expect(out).toEqual(["u-biller-pe"]);
    expect(forPe).toHaveBeenCalledWith("org-1", ["billing_manager", "biller"], "pe-1");
    expect(ports.roleSetMembers).not.toHaveBeenCalledWith("org-1", ["billing_manager"]);
  });

  it("falls back to the org-wide fallback role keys when nobody is assigned to the PE", async () => {
    const roleSetMembers = vi.fn(async (_o: string, keys: readonly string[]) =>
      keys.length === 1 ? ["u-bm"] : [],
    );
    const ports = fakePorts({
      roleSetMembers,
      roleSetMembersForProviderEntity: vi.fn(async () => []),
    });
    const out = await resolveRecipients(
      createRecipientResolverRegistry(ports),
      "role_set",
      "org-1",
      args,
      { providerEntityId: "pe-1" },
    );
    expect(out).toEqual(["u-bm"]);
    expect(roleSetMembers).toHaveBeenCalledWith("org-1", ["billing_manager"]);
  });

  it("falls back when the payload carries no provider entity or the port is unbound", async () => {
    const forPe = vi.fn(async () => ["u-never"]);
    const ports = fakePorts({
      roleSetMembers: vi.fn(async (_o: string, keys: readonly string[]) =>
        keys.length === 1 ? ["u-bm"] : [],
      ),
      roleSetMembersForProviderEntity: forPe,
    });
    const registry = createRecipientResolverRegistry(ports);
    expect(await resolveRecipients(registry, "role_set", "org-1", args, {})).toEqual(["u-bm"]);
    expect(forPe).not.toHaveBeenCalled();

    const unbound = fakePorts({
      roleSetMembers: vi.fn(async (_o: string, keys: readonly string[]) =>
        keys.length === 1 ? ["u-bm"] : [],
      ),
    });
    const out = await resolveRecipients(
      createRecipientResolverRegistry(unbound),
      "role_set",
      "org-1",
      args,
      { providerEntityId: "pe-1" },
    );
    expect(out).toEqual(["u-bm"]);
  });
});
