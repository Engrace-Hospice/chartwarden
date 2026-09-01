import { describe, expect, it } from "vitest";
import {
  PROVISION_MINIO_PREFIXES,
  type ProvisionWorkerPorts,
  runTenantProvision,
} from "../src/services/provision-worker";

const job = {
  tenantAccountId: "00000000-0000-4000-9000-000000000011",
  organizationId: "00000000-0000-4000-9000-000000000022",
  legalBusinessName: "Example Hospice",
  billingContactEmail: "billing@example.invalid",
  firstAdminEmail: "admin@example.invalid",
  firstAdminFullName: "Ada Admin",
  actorMembershipId: "00000000-0000-4000-9000-000000000033",
  transitionReason: "accepted signup intent",
};

function ports(overrides: Partial<ProvisionWorkerPorts> = {}): ProvisionWorkerPorts {
  return {
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    currentStatus: async () => "provisioning",
    ensureTenantKeyRing: async () => ({ tenantKeyRingId: "key-ring-1" }),
    ensureTenantStoragePrefixes: async () => ({ prefixesEnsured: PROVISION_MINIO_PREFIXES }),
    ensureOrganization: async (input) => ({ organizationId: input.organizationId }),
    materializeOnboardingTasks: async () => ({ materialized: 11 }),
    ensureFirstAdminInvitation: async () => ({ invitationId: "invitation-1" }),
    commitProvisionedTransition: async () => {},
    ...overrides,
  };
}

describe("runTenantProvision", () => {
  it("asks the storage port to ensure every canonical logical prefix for the tenant organization", async () => {
    const seen: { organizationId: string; prefixes: readonly string[] }[] = [];
    const result = await runTenantProvision(
      job,
      ports({
        ensureTenantStoragePrefixes: async (input) => {
          seen.push(input);
          return { prefixesEnsured: input.prefixes };
        },
      }),
    );

    expect(seen).toEqual([
      { organizationId: job.organizationId, prefixes: PROVISION_MINIO_PREFIXES },
    ]);
    expect(result.minioPrefixesCreated).toEqual(PROVISION_MINIO_PREFIXES);
  });

  it("keeps completed provisioning replays as no-ops", async () => {
    let storageCalls = 0;
    const result = await runTenantProvision(
      job,
      ports({
        currentStatus: async () => "onboarding",
        ensureTenantStoragePrefixes: async () => {
          storageCalls += 1;
          return { prefixesEnsured: PROVISION_MINIO_PREFIXES };
        },
      }),
    );

    expect(result).toMatchObject({ ran: false, skippedReason: "already_provisioned" });
    expect(storageCalls).toBe(0);
  });
});
