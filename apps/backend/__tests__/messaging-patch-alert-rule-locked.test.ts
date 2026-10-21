/**
 * M36 patchAlertRule (Drizzle service) vs migration 0334: a tenant that already holds an org clone of a
 * NOW-locked event with system_locked=false must be PROMOTED to locked on update (the trigger rejects an
 * unlocked tenant row for a locked platform event). Fake tx — no DB.
 */
import { describe, expect, it, vi } from "vitest";

const txHolder: { tx: unknown } = { tx: undefined };
vi.mock("@chartwarden/tenancy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn(txHolder.tx),
}));

import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";

const ORG = "11111111-1111-4111-8111-111111111111";
const RULE = "22222222-2222-4222-8222-222222222222";

function fakeTx(
  selects: unknown[][],
  captured: { set?: Record<string, unknown>; insert?: Record<string, unknown> },
) {
  let n = 0;
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = () => c;
    c.limit = async () => rows;
    return c;
  };
  return {
    select: () => chain(selects[n++] ?? []),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured.set = v;
        return {
          where: () => ({ returning: async () => [{ ...(selects[0]?.[0] as object), ...v }] }),
        };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.insert = v;
        return { returning: async () => [{ id: "new", ...v }] };
      },
    }),
  };
}

const legacyClone = {
  id: RULE,
  organizationId: ORG,
  eventType: "m3.breakglass.invoked",
  category: "administrative",
  severityFloor: "critical",
  recipientResolver: "role_set",
  resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
  channelsOverride: null,
  systemLocked: false,
  enabled: true,
};

describe("patchAlertRule promotes a legacy unlocked clone of a now-locked event", () => {
  it("sets system_locked=true on UPDATE so the 0334 trigger is satisfied", async () => {
    const captured: { set?: Record<string, unknown> } = {};
    txHolder.tx = fakeTx([[legacyClone], [{ id: RULE }]], captured);
    const svc = createDbMessagingRouteService({} as never);
    await svc.patchAlertRule(ORG, { ruleId: RULE, patch: { severityFloor: "critical" } });
    expect(captured.set?.systemLocked).toBe(true);
  });

  it("keeps an unlocked event's clone unlocked", async () => {
    const captured: { set?: Record<string, unknown> } = {};
    txHolder.tx = fakeTx(
      [[{ ...legacyClone, eventType: "m10.hope.sfv_created" }], [{ id: RULE }]],
      captured,
    );
    const svc = createDbMessagingRouteService({} as never);
    await svc.patchAlertRule(ORG, { ruleId: RULE, patch: { severityFloor: "warn" } });
    expect(captured.set?.systemLocked).toBe(false);
  });

  it("resets resolver_args and unions channels to the platform floor on UPDATE of a weak legacy clone", async () => {
    const captured: { set?: Record<string, unknown> } = {};
    const platformSos = {
      id: "33333333-3333-4333-8333-333333333333",
      organizationId: null,
      eventType: "field_safety.sos",
      category: "field_safety",
      severityFloor: "critical",
      recipientResolver: "provider_entity_admins",
      resolverArgs: { providerEntityIdPath: "providerEntityId" },
      channelsOverride: ["in_app", "push", "sms", "voice"],
      systemLocked: true,
      enabled: true,
    };
    const weak = {
      ...legacyClone,
      eventType: "field_safety.sos",
      recipientResolver: "provider_entity_admins",
      resolverArgs: { providerEntityIdPath: "somethingElse" },
      channelsOverride: ["in_app", "email"],
    };
    // selects: base, own row (channels read from it), platform floor row.
    txHolder.tx = fakeTx(
      [[weak], [{ id: RULE, channelsOverride: ["in_app", "email"] }], [platformSos]],
      captured,
    );
    const svc = createDbMessagingRouteService({} as never);
    await svc.patchAlertRule(ORG, { ruleId: RULE, patch: { severityFloor: "critical" } });
    expect(captured.set?.resolverArgs).toEqual({ providerEntityIdPath: "providerEntityId" });
    expect([...(captured.set?.channelsOverride as string[])].sort()).toEqual(
      ["email", "in_app", "push", "sms", "voice"].sort(),
    );
  });

  it("uses the platform channels when the legacy clone's channels_override is NULL", async () => {
    const captured: { set?: Record<string, unknown> } = {};
    const platform = {
      ...legacyClone,
      id: "44444444-4444-4444-8444-444444444444",
      organizationId: null,
      systemLocked: true,
      channelsOverride: ["in_app", "sms"],
    };
    txHolder.tx = fakeTx(
      [[legacyClone], [{ id: RULE, channelsOverride: null }], [platform]],
      captured,
    );
    const svc = createDbMessagingRouteService({} as never);
    await svc.patchAlertRule(ORG, { ruleId: RULE, patch: { severityFloor: "critical" } });
    expect(captured.set?.channelsOverride).toEqual(["in_app", "sms"]);
    expect(captured.set?.resolverArgs).toEqual(platform.resolverArgs);
  });

  it("does not touch channels/resolver_args for a non-locked event", async () => {
    const captured: { set?: Record<string, unknown> } = {};
    txHolder.tx = fakeTx(
      [[{ ...legacyClone, eventType: "m10.hope.sfv_created" }], [{ id: RULE }]],
      captured,
    );
    const svc = createDbMessagingRouteService({} as never);
    await svc.patchAlertRule(ORG, { ruleId: RULE, patch: { severityFloor: "warn" } });
    expect(captured.set).not.toHaveProperty("resolverArgs");
    expect(captured.set).not.toHaveProperty("channelsOverride");
  });
});
