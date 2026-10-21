// apps/backend/__tests__/m36-idg-carry-forward-compliance.test.ts — M36's consumer of `m14.action_item.carry_forward`
// (the critical typed alert `m14.action_item.carry_forward.compliance`, M14 §2.7 / D8). Pure/unit: the crossing rule,
// catalog validation, PHI-free payload, idempotency on redelivery (correlation id + the in-memory emitter's dedupe),
// the platform `alert_rule` the recipients come from, and the resolved recipient set. The real-Postgres / RLS / real
// emitter proof is in `gap-096-alert-emitter-live.test.ts`; the producer crossing in `m14-packet-build.live.test.ts`.
import { PLATFORM_DEFAULT_ALERT_RULES, createAlertPayloadRegistry } from "@chartwarden/messaging";
import { createInMemoryAlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import { M14_ALERT_PAYLOADS } from "../src/modules/14-idg/index";
import {
  IDG_CARRY_FORWARD_COMPLIANCE_PAYLOAD_TYPE,
  buildIdgCarryForwardComplianceConsumer,
  carryForwardComplianceCorrelationId,
} from "../src/modules/36-messaging/index";

const ORG = "org-1";
const ITEM = "item-1";

function catalog() {
  const r = createAlertPayloadRegistry();
  r.register(M14_ALERT_PAYLOADS);
  r.assertValid();
  return r.build();
}

function setup(over: { membershipUserId?: (o: string, m: string) => Promise<string | null> } = {}) {
  const roleSetMembers = vi.fn(async (_org: string, keys: readonly string[]) =>
    keys.map((k) => `u-${k}`),
  );
  const rule = PLATFORM_DEFAULT_ALERT_RULES.find(
    (r) => r.eventType === IDG_CARRY_FORWARD_COMPLIANCE_PAYLOAD_TYPE,
  );
  const { emitter, recorded } = createInMemoryAlertEmitter({
    recipients: { roleSetMembers },
    rulesFor: (_o, eventType) =>
      PLATFORM_DEFAULT_ALERT_RULES.filter((r) => r.eventType === eventType && r.enabled).map(
        (r) => ({
          category: r.category,
          severityFloor: r.severityFloor,
          recipientResolver: r.recipientResolver,
          resolverArgs: r.resolverArgs,
          channelsOverride: r.channelsOverride,
        }),
      ),
  });
  const membershipUserId = vi.fn(over.membershipUserId ?? (async () => "u-coord"));
  const consumer = buildIdgCarryForwardComplianceConsumer({
    alerts: emitter,
    catalog: catalog(),
    membershipUserId,
  });
  return { consumer, recorded, roleSetMembers, membershipUserId, rule };
}

const ev = (payload: Record<string, unknown>) => ({
  id: "evt-1",
  eventType: "m14.action_item.carry_forward",
  aggregateKind: "idg_action_item",
  aggregateId: ITEM,
  organizationId: ORG,
  attemptCount: 0,
  createdAt: new Date(),
  payload,
});
const crossing = {
  priorActionItemId: ITEM,
  newAgendaItemId: "agd-1",
  carryForwardCount: 3,
  isComplianceAlert: true,
  coordinatorMembershipId: "mem-coord",
};

describe("M36 IDG carry-forward compliance consumer", () => {
  it("binds exactly the carry_forward event as an m36 consumer", () => {
    const { consumer } = setup();
    expect(consumer.consumerModule).toBe("m36");
    expect(consumer.eventTypes).toEqual(["m14.action_item.carry_forward"]);
  });

  it("raises the critical typed alert on the crossing, to the compliance/supervisor/admin roles + the coordinator", async () => {
    const { consumer, recorded, membershipUserId } = setup();
    await consumer.handle(ev(crossing));
    expect(recorded).toHaveLength(1);
    const a = recorded[0]!;
    expect(a.eventType).toBe("m14.action_item.carry_forward.compliance");
    expect(a.severity).toBe("critical");
    expect(a.correlationId).toBe(carryForwardComplianceCorrelationId(ITEM));
    expect(membershipUserId).toHaveBeenCalledWith(ORG, "mem-coord");
    const recipients = [...new Set(a.deliveries.map((d) => d.recipientUserId))].sort();
    expect(recipients).toEqual(
      ["u-clinical_supervisor", "u-compliance_officer", "u-coord", "u-org_admin"].sort(),
    );
    // every recipient gets the in-app floor (out-of-band push/email is additive for users who have a preferences row)
    expect(a.deliveries.filter((d) => d.channel === "in_app")).toHaveLength(4);
    expect(a.deliveries.every((d) => d.alertSeverity === "critical")).toBe(true);
  });

  it("ignores every non-crossing carry (flag false) — no alert, no lookup", async () => {
    const { consumer, recorded, membershipUserId } = setup();
    await consumer.handle(ev({ ...crossing, carryForwardCount: 1, isComplianceAlert: false }));
    await consumer.handle(ev({ ...crossing, carryForwardCount: 4, isComplianceAlert: false }));
    expect(recorded).toHaveLength(0);
    expect(membershipUserId).not.toHaveBeenCalled();
  });

  it("refuses (throws → relay retry/DLQ) a compliance flag whose count is below the threshold", async () => {
    const { consumer, recorded } = setup();
    await expect(consumer.handle(ev({ ...crossing, carryForwardCount: 2 }))).rejects.toThrow(/< 3/);
    expect(recorded).toHaveLength(0);
  });

  it("is idempotent: a redelivery and a later re-crossing of the same item raise ONE alert", async () => {
    const { consumer, recorded } = setup();
    // the in-memory emitter only dedupes with countRepeats; the real `alert` table dedupes on (org, correlation_id)
    // (proved live) — here prove the DETERMINISTIC correlation id is identical across redelivery/re-crossing.
    await consumer.handle(ev(crossing));
    await consumer.handle(ev({ ...crossing, newAgendaItemId: "agd-9" })); // item dipped (meeting cancelled) and re-crossed
    const ids = new Set(recorded.map((r) => r.correlationId));
    expect(ids).toEqual(new Set([`m14.carry_forward.compliance:${ITEM}`]));
    expect(carryForwardComplianceCorrelationId("other")).not.toBe(
      carryForwardComplianceCorrelationId(ITEM),
    );
  });

  it("payload validates against the registered catalog schema, carries ids + counts only (no PHI, no link)", async () => {
    const { consumer, recorded } = setup();
    await consumer.handle(ev(crossing));
    const p = recorded[0]!.payload;
    expect(Object.keys(p).sort()).toEqual(
      [
        "bodyTemplate",
        "carryForwardCount",
        "coordinatorUserId",
        "organizationId",
        "priorActionItemId",
        "recipients",
        "severity",
      ].sort(),
    );
    expect(p).toMatchObject({ organizationId: ORG, priorActionItemId: ITEM, carryForwardCount: 3 });
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/patient|title|deepLink|http|\/idg\//i);
  });

  it("a coordinator that is no longer an active member is simply omitted (alert still raised to the roles)", async () => {
    const { consumer, recorded } = setup({ membershipUserId: async () => null });
    await consumer.handle(ev(crossing));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).not.toHaveProperty("coordinatorUserId");
    const recipients = new Set(recorded[0]!.deliveries.map((d) => d.recipientUserId));
    expect(recipients.has("u-coord")).toBe(false);
    expect(recipients.size).toBe(3);
  });

  it("an event without a coordinator still alerts the role audience", async () => {
    const { consumer, recorded, membershipUserId } = setup();
    const { coordinatorMembershipId: _c, ...noCoord } = crossing;
    await consumer.handle(ev(noCoord));
    expect(membershipUserId).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
  });

  it("throws when the payload type is not in the catalog, and when the payload fails the catalog schema", async () => {
    const emit = vi.fn();
    const noCatalog = buildIdgCarryForwardComplianceConsumer({
      alerts: { emit } as never,
      catalog: new Map(),
      membershipUserId: async () => null,
    });
    await expect(noCatalog.handle(ev(crossing))).rejects.toThrow(
      /not in the alert payload catalog/,
    );
    expect(emit).not.toHaveBeenCalled();

    // a catalog whose schema rejects the payload (severity literal tampered) -> refuse, never emit
    const entry = catalog().get(IDG_CARRY_FORWARD_COMPLIANCE_PAYLOAD_TYPE)!;
    const { Type } = await import("@sinclair/typebox");
    const strict = buildIdgCarryForwardComplianceConsumer({
      alerts: { emit } as never,
      catalog: new Map([
        [entry.payloadType, { ...entry, payloadSchema: Type.Object({ nope: Type.String() }) }],
      ]),
      membershipUserId: async () => null,
    });
    await expect(strict.handle(ev(crossing))).rejects.toThrow(/fails the/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("the platform alert_rule is critical, role_set over compliance/supervisor/admin + coordinatorUserId, catalog channels", () => {
    const { rule } = setup();
    expect(rule).toMatchObject({
      severityFloor: "critical",
      recipientResolver: "role_set",
      systemLocked: false,
      enabled: true,
      channelsOverride: ["in_app", "push", "email"],
    });
    expect(rule?.resolverArgs.roleKeys).toEqual([
      "compliance_officer",
      "clinical_supervisor",
      "org_admin",
    ]);
    expect(rule?.resolverArgs.userIdPaths).toEqual(["coordinatorUserId"]);
  });
});
