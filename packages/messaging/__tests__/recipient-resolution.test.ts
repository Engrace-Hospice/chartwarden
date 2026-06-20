// @wardenx/messaging — M36-T04 recipient-resolution tests (spec §2.1.3, §2.5, §4.6).
//
// Resolution is dynamic at emit time and consults the source-of-truth ports, dedupes, and
// refuses an unregistered resolver (§2.5). Fakes stand in for the M5/M19/M2 seams.
import { describe, expect, it, vi } from "vitest";
import {
  createRecipientResolverRegistry,
  resolveRecipients,
  UnknownRecipientResolverError,
  type RecipientSourcePorts,
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
    expect(await resolveRecipients(registry, "tenant_admins", "org-1", {}, {})).toEqual(["u-admin"]);
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
    await expect(resolveRecipients(registry, "does_not_exist", "org-1", {}, {})).rejects.toBeInstanceOf(
      UnknownRecipientResolverError,
    );
  });

  it("the registry is open — a composition resolver (ADR-0024) can be registered onto it", async () => {
    const registry = createRecipientResolverRegistry(fakePorts());
    registry.set("ordering_provider", async () => ["u-ordering"]);
    const out = await resolveRecipients(registry, "ordering_provider", "org-1", {}, {});
    expect(out).toEqual(["u-ordering"]);
  });
});
