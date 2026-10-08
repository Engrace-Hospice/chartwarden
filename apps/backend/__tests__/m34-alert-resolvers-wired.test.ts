// apps/backend/__tests__/m34-alert-resolvers-wired.test.ts — GAP-057.
//
// M34's two recipient resolvers were written but never registered, so every rule naming them stayed
// unseeded and no tenant-lifecycle / security alert reached anyone. This drives the REAL M36 emitter
// (`createAlertEmitter`) with M34's extension over fake ports, seeded with the real M34 rule rows, and
// proves an `m34.tenant.shred_pending_approval` emit resolves the platform security owners and delivers.
import { createAlertEmitter } from "@wardenx/messaging";
import type { AlertEmitterPorts, EmitAlertRule, PersistedAlert } from "@wardenx/messaging";
import { describe, expect, it } from "vitest";
import {
  M34_ALERT_RULES,
  type M34AlertResolverPorts,
} from "../src/modules/34-saas-tenant-platform/alert-rules";
import { m34ResolverExtension } from "../src/modules/34-saas-tenant-platform/alert-resolver-ports";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OFFICER = "00000000-0000-4000-8000-0000000000aa";
const OWNER = "00000000-0000-4000-8000-0000000000bb";

function harness() {
  const persisted: PersistedAlert[] = [];
  const officerCalls: Array<{ orgId: string; roleKeys: readonly string[] }> = [];
  const m34Ports: M34AlertResolverPorts = {
    complianceOfficersForOrg: async (orgId, roleKeys) => {
      officerCalls.push({ orgId, roleKeys });
      return [OFFICER];
    },
    platformSecurityOwners: async () => [OWNER],
  };
  const emitter = createAlertEmitter({
    recipients: {
      careTeamMembers: async () => [],
      onCallMembers: async () => [],
      disciplineMembers: async () => [],
      roleSetMembers: async () => [],
      roleSetMembersForProviderEntity: async () => [],
      tenantAdmins: async () => [],
      orgMembers: async () => [],
    },
    rulesFor: async (_org, eventType) =>
      M34_ALERT_RULES.filter((r) => r.eventType === eventType).map(
        (r): EmitAlertRule => ({
          category: r.category,
          severityFloor: r.severityFloor,
          recipientResolver: r.recipientResolver,
          resolverArgs: r.resolverArgs,
          channelsOverride: r.channelsOverride,
        }),
      ),
    preferencesFor: async () => new Map(),
    persist: async (record) => {
      persisted.push(record);
      return { alertId: "alert-1" };
    },
    now: () => new Date("2026-10-08T12:00:00Z"),
    extendResolvers: m34ResolverExtension(m34Ports),
  } satisfies AlertEmitterPorts);
  return { emitter, persisted, officerCalls };
}

describe("M34 alert resolvers are registered on the emitter registry (GAP-057)", () => {
  it("delivers m34.tenant.retention_window_reached to the platform security owner", async () => {
    const { emitter, persisted } = harness();
    const rule = M34_ALERT_RULES.find((r) => r.recipientResolver === "platform_security_owner");
    expect(rule).toBeDefined();
    const result = await emitter.emit(TENANT, {
      eventType: rule?.eventType ?? "",
      payload: { orgId: TENANT },
      severity: "critical",
      correlationId: "gap-057-owner",
    });
    expect(result.resolvedRecipientCount).toBeGreaterThanOrEqual(1);
    expect(persisted[0]?.deliveries.map((d) => d.recipientUserId)).toContain(OWNER);
  });

  it("scopes compliance_officer_for_tenant to the tenant org carried in the payload", async () => {
    const { emitter, persisted, officerCalls } = harness();
    const rule = M34_ALERT_RULES.find(
      (r) => r.recipientResolver === "compliance_officer_for_tenant",
    );
    const result = await emitter.emit("00000000-0000-4000-8000-0000000000ff", {
      eventType: rule?.eventType ?? "",
      payload: { orgId: TENANT },
      severity: "warn",
      correlationId: "gap-057-officer",
    });
    expect(result.resolvedRecipientCount).toBeGreaterThanOrEqual(1);
    expect(officerCalls[0]?.orgId).toBe(TENANT);
    expect(persisted[0]?.deliveries.map((d) => d.recipientUserId)).toContain(OFFICER);
  });

  it("every M34-named rule resolves (no UnknownRecipientResolverError) through the extended registry", async () => {
    const { emitter } = harness();
    for (const rule of M34_ALERT_RULES) {
      await expect(
        emitter.emit(TENANT, {
          eventType: rule.eventType,
          payload: { orgId: TENANT },
          severity: "critical",
          correlationId: `gap-057-${rule.ruleKey}-${rule.severityFloor}`,
        }),
      ).resolves.toBeDefined();
    }
  });
});
