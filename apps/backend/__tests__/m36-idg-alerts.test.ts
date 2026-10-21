// apps/backend/__tests__/m36-idg-alerts.test.ts — M36's consumers of M14's remaining typed alerts (packets ready /
// action item assigned / non-quorate decision / review-clock escalation / review-floor override). Pure/unit over the
// in-memory emitter: catalog validation, recipients (the platform `alert_rule` realisation of the catalog's resolver
// names — no enum migration), idempotency keys, anti-spam keys, PHI-free payloads. The real-Postgres / RLS / real
// emitter proof is in `gap-096-alert-emitter-live.test.ts`; the M14 emit sites in `m14-packet-build.live.test.ts`.
import { PLATFORM_DEFAULT_ALERT_RULES, createAlertPayloadRegistry } from "@chartwarden/messaging";
import { createInMemoryAlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import { M14_ALERT_PAYLOADS } from "../src/modules/14-idg/index";
import {
  IDG_ALERT_CONSUMERS,
  buildIdgAlertConsumers,
  idgActionItemCreatedCorrelationId,
  idgNonQuorateCorrelationId,
  idgPacketsReadyCorrelationId,
  idgReviewClockCorrelationId,
  idgReviewFloorOverrideCorrelationId,
} from "../src/modules/36-messaging/index";

const ORG = "org-1";

function catalog() {
  const r = createAlertPayloadRegistry();
  r.register(M14_ALERT_PAYLOADS);
  r.assertValid();
  return r.build();
}

interface Over {
  membershipUserId?: (o: string, m: string) => Promise<string | null>;
  meetingAttendees?: (o: string, l: string) => Promise<{ membershipId: string; userId: string }[]>;
}

function setup(over: Over = {}) {
  const roleSetMembers = vi.fn(async (_org: string, keys: readonly string[]) =>
    keys.map((k) => `u-${k}`),
  );
  const { emitter, recorded } = createInMemoryAlertEmitter({
    recipients: { roleSetMembers },
    // the REAL platform seed, exactly as the boot upsert ships it
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
  const membershipUserId = vi.fn(over.membershipUserId ?? (async (_o, m) => `u-${m}`));
  const meetingAttendees = vi.fn(
    over.meetingAttendees ??
      (async () => [
        { membershipId: "mem-rn", userId: "u-rn" },
        { membershipId: "mem-md", userId: "u-md" },
      ]),
  );
  const consumers = buildIdgAlertConsumers({
    alerts: emitter,
    catalog: catalog(),
    membershipUserId,
    meetingAttendees,
  });
  const by = (eventName: string) => consumers.find((c) => c.eventTypes[0] === eventName)!;
  return { by, recorded, roleSetMembers, membershipUserId, meetingAttendees, consumers };
}

const ev = (eventType: string, payload: Record<string, unknown>, id = "evt-1") => ({
  id,
  eventType,
  aggregateKind: "x",
  aggregateId: "agg",
  organizationId: ORG,
  attemptCount: 0,
  createdAt: new Date(),
  payload,
});
const recipientsOf = (a: { deliveries: readonly { recipientUserId: string }[] }) =>
  [...new Set(a.deliveries.map((d) => d.recipientUserId))].sort();

const packetsReady = {
  meetingId: "mtg-1",
  builtPacketCount: 4,
  scheduledAttendees: 0,
  locationId: "loc-1",
  scheduledStart: "2026-10-01T15:00:00.000Z",
  coordinatorMembershipId: "mem-coord",
};
const actionItem = {
  actionItemId: "act-1",
  meetingId: "mtg-1",
  decisionId: null,
  patientId: "pat-1",
  assignedToMembershipId: "mem-asg",
  dueDate: "2026-10-08T00:00:00.000Z",
  linkedArtifactKind: null,
  linkedArtifactId: null,
};
const decision = {
  decisionId: "dec-1",
  meetingId: "mtg-1",
  patientId: "pat-1",
  decisionKind: "care_plan_update",
  wasQuorate: false,
  recordedByMembershipId: "mem-x",
  recordedAt: "2026-10-01T15:00:00.000Z",
  coordinatorMembershipId: "mem-coord",
  missingDisciplines: ["msw"],
};
const clock = (stage: string, severity: string) => ({
  admissionId: "adm-1",
  patientId: "pat-1",
  locationId: "loc-1",
  lastIdgReviewedAt: "2026-09-01T00:00:00.000Z",
  floorAt: "2026-09-16T00:00:00.000Z",
  stage,
  severity,
  coordinatorMembershipId: "mem-coord",
});
const override = {
  meetingId: "mtg-1",
  actorMembershipId: "mem-actor",
  reason: "patient Jane Doe family request",
  breachingPatients: [{ patientId: "pat-1", floorAt: "2026-09-16T00:00:00.000Z" }],
  overriddenAt: "2026-09-15T00:00:00.000Z",
};

describe("M36 IDG alert consumers — bindings", () => {
  it("one m36 consumer per alert family, each on exactly its source event", () => {
    const { consumers } = setup();
    expect(consumers.map((c) => [c.consumerName, c.consumerModule, ...c.eventTypes])).toEqual([
      ["m36.idg-packets-ready-alert", "m36", "m14.packets.ready"],
      ["m36.idg-action-item-assigned-alert", "m36", "m14.action_item.created"],
      ["m36.idg-non-quorate-alert", "m36", "m14.decision.recorded_open"],
      ["m36.idg-review-clock-alert", "m36", "m14.review_clock.escalated"],
      ["m36.idg-review-floor-override-alert", "m36", "m14.review_floor.override_recorded"],
    ]);
    expect(IDG_ALERT_CONSUMERS).toHaveLength(5);
  });

  it("every alert type has a platform rule: role_set (no enum migration), only real role keys", () => {
    const real = new Set(["compliance_officer", "clinical_supervisor", "org_admin"]);
    for (const c of IDG_ALERT_CONSUMERS) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === c.payloadType);
      expect(rule?.recipientResolver).toBe("role_set");
      expect(rule?.enabled).toBe(true);
      for (const k of (rule?.resolverArgs.roleKeys ?? []) as string[])
        expect(real.has(k)).toBe(true);
    }
  });
});

describe("m14.packets.ready -> attendees", () => {
  it("alerts the derived roster + the coordinator, once per meeting, info, in_app+push", async () => {
    const { by, recorded, meetingAttendees } = setup();
    await by("m14.packets.ready").handle(ev("m14.packets.ready", packetsReady));
    expect(meetingAttendees).toHaveBeenCalledWith(ORG, "loc-1");
    expect(recorded).toHaveLength(1);
    const a = recorded[0]!;
    expect(a.eventType).toBe("m14.packets.ready");
    expect(a.severity).toBe("info");
    expect(a.correlationId).toBe(idgPacketsReadyCorrelationId("mtg-1"));
    expect(recipientsOf(a)).toEqual(["u-mem-coord", "u-md", "u-rn"].sort());
    expect(a.deliveries.filter((d) => d.channel === "in_app")).toHaveLength(3);
    expect(a.payload).toMatchObject({
      meetingId: "mtg-1",
      packetCount: 4,
      recipients: {
        attendeesByMembershipId: expect.arrayContaining(["mem-rn", "mem-md", "mem-coord"]),
      },
      deepLink: "/idg/meetings/mtg-1",
    });
  });

  it("is per MEETING: a second event (or redelivery) yields the same correlation id regardless of packet count", async () => {
    const { by, recorded } = setup();
    await by("m14.packets.ready").handle(ev("m14.packets.ready", packetsReady, "e1"));
    await by("m14.packets.ready").handle(
      ev("m14.packets.ready", { ...packetsReady, builtPacketCount: 9 }, "e2"),
    );
    expect(new Set(recorded.map((r) => r.correlationId))).toEqual(
      new Set([idgPacketsReadyCorrelationId("mtg-1")]),
    );
    expect(idgPacketsReadyCorrelationId("mtg-2")).not.toBe(idgPacketsReadyCorrelationId("mtg-1"));
  });

  it("the coordinator already on the roster is not looked up twice; an empty roster raises nothing", async () => {
    const dup = setup({
      meetingAttendees: async () => [{ membershipId: "mem-coord", userId: "u-coord" }],
    });
    await dup.by("m14.packets.ready").handle(ev("m14.packets.ready", packetsReady));
    expect(dup.membershipUserId).not.toHaveBeenCalled();
    expect(recipientsOf(dup.recorded[0]!)).toEqual(["u-coord"]);

    const none = setup({ meetingAttendees: async () => [], membershipUserId: async () => null });
    await none.by("m14.packets.ready").handle(ev("m14.packets.ready", packetsReady));
    expect(none.recorded).toHaveLength(0);
  });

  it("throws on a legacy/malformed event (no locationId / scheduledStart) — never a silent drop", async () => {
    const { by, recorded } = setup();
    const { locationId: _l, ...noLoc } = packetsReady;
    await expect(by("m14.packets.ready").handle(ev("m14.packets.ready", noLoc))).rejects.toThrow(
      /locationId/,
    );
    const { scheduledStart: _s, ...noStart } = packetsReady;
    await expect(by("m14.packets.ready").handle(ev("m14.packets.ready", noStart))).rejects.toThrow(
      /scheduledStart/,
    );
    expect(recorded).toHaveLength(0);
  });
});

describe("m14.action_item.created -> assignee", () => {
  it("DMs only the assignee; info; in_app; keyed on the action item", async () => {
    const { by, recorded, membershipUserId } = setup();
    await by("m14.action_item.created").handle(ev("m14.action_item.created", actionItem));
    expect(membershipUserId).toHaveBeenCalledWith(ORG, "mem-asg");
    const a = recorded[0]!;
    expect(a.correlationId).toBe(idgActionItemCreatedCorrelationId("act-1"));
    expect(a.severity).toBe("info");
    expect(recipientsOf(a)).toEqual(["u-mem-asg"]);
    expect(a.deliveries.every((d) => d.channel === "in_app")).toBe(true);
    expect(a.payload).toMatchObject({ actionItemId: "act-1", dueDate: actionItem.dueDate });
  });

  it("a departed assignee raises nothing; a patient-less item validates (patientId null)", async () => {
    const gone = setup({ membershipUserId: async () => null });
    await gone.by("m14.action_item.created").handle(ev("m14.action_item.created", actionItem));
    expect(gone.recorded).toHaveLength(0);
    const ok = setup();
    await ok
      .by("m14.action_item.created")
      .handle(ev("m14.action_item.created", { ...actionItem, patientId: null }));
    expect(ok.recorded[0]!.payload.patientId).toBeNull();
  });
});

describe("m14.decision.recorded_open -> non-quorate notice", () => {
  it("ignores every quorate decision (and an absent flag)", async () => {
    const { by, recorded, membershipUserId } = setup();
    await by("m14.decision.recorded_open").handle(
      ev("m14.decision.recorded_open", { ...decision, wasQuorate: true }),
    );
    await by("m14.decision.recorded_open").handle(
      ev("m14.decision.recorded_open", { decisionId: "d", meetingId: "m" }),
    );
    expect(recorded).toHaveLength(0);
    expect(membershipUserId).not.toHaveBeenCalled();
  });

  it("raises the low-severity notice to the coordinator with the missing disciplines", async () => {
    const { by, recorded } = setup();
    await by("m14.decision.recorded_open").handle(ev("m14.decision.recorded_open", decision));
    const a = recorded[0]!;
    expect(a.eventType).toBe("m14.decision.non_quorate");
    expect(a.severity).toBe("info");
    expect(a.correlationId).toBe(idgNonQuorateCorrelationId("dec-1"));
    expect(recipientsOf(a)).toEqual(["u-mem-coord"]);
    expect(a.payload).toMatchObject({ missingDisciplines: ["msw"], severity: "low" });
  });

  it("no resolvable coordinator => nothing to raise (the notice is to the coordinator, M14 §4.10)", async () => {
    const { by, recorded } = setup({ membershipUserId: async () => null });
    await by("m14.decision.recorded_open").handle(ev("m14.decision.recorded_open", decision));
    expect(recorded).toHaveLength(0);
  });
});

describe("m14.review_clock.escalated -> tiered audience", () => {
  it("T-3: coordinator only, warn", async () => {
    const { by, recorded, roleSetMembers } = setup();
    await by("m14.review_clock.escalated").handle(
      ev("m14.review_clock.escalated", clock("t_minus_3", "clinical_routine")),
    );
    const a = recorded[0]!;
    expect(a.severity).toBe("warn");
    expect(recipientsOf(a)).toEqual(["u-mem-coord"]);
    expect(roleSetMembers).toHaveBeenCalledWith(ORG, []);
  });

  it("T-0: coordinator + clinical supervisor, critical", async () => {
    const { by, recorded } = setup();
    await by("m14.review_clock.escalated").handle(
      ev("m14.review_clock.escalated", clock("t_zero", "critical")),
    );
    expect(recorded[0]!.severity).toBe("critical");
    expect(recipientsOf(recorded[0]!)).toEqual(["u-clinical_supervisor", "u-mem-coord"].sort());
  });

  it("T+1: + compliance inbox (and the org_admin backstop), critical, compliance flag set", async () => {
    const { by, recorded } = setup();
    await by("m14.review_clock.escalated").handle(
      ev("m14.review_clock.escalated", clock("t_plus_1", "critical")),
    );
    expect(recipientsOf(recorded[0]!)).toEqual(
      ["u-clinical_supervisor", "u-compliance_officer", "u-mem-coord", "u-org_admin"].sort(),
    );
    expect(recorded[0]!.payload.recipients).toMatchObject({ complianceInbox: true });
    expect(recorded[0]!.deliveries.every((d) => d.alertSeverity === "critical")).toBe(true);
  });

  it("a location with no coordinator still alerts the role tier", async () => {
    const { by, recorded } = setup();
    const { coordinatorMembershipId: _c, ...noCoord } = clock("t_zero", "critical");
    await by("m14.review_clock.escalated").handle(ev("m14.review_clock.escalated", noCoord));
    expect(recipientsOf(recorded[0]!)).toEqual(["u-clinical_supervisor"]);
  });

  it("dedupes per (patient, tier, clock cycle): distinct across tiers / patients / a new cycle, identical on redelivery", () => {
    const k = idgReviewClockCorrelationId("pat-1", "t_zero", "2026-09-16T00:00:00.000Z");
    expect(k).toBe(idgReviewClockCorrelationId("pat-1", "t_zero", "2026-09-16T00:00:00.000Z"));
    expect(k).not.toBe(
      idgReviewClockCorrelationId("pat-1", "t_plus_1", "2026-09-16T00:00:00.000Z"),
    );
    expect(k).not.toBe(idgReviewClockCorrelationId("pat-2", "t_zero", "2026-09-16T00:00:00.000Z"));
    expect(k).not.toBe(idgReviewClockCorrelationId("pat-1", "t_zero", "2026-10-01T00:00:00.000Z"));
  });

  it("rejects an unknown stage / severity (throws)", async () => {
    const { by, recorded } = setup();
    await expect(
      by("m14.review_clock.escalated").handle(
        ev("m14.review_clock.escalated", clock("t_plus_9", "critical")),
      ),
    ).rejects.toThrow(/unknown stage/);
    await expect(
      by("m14.review_clock.escalated").handle(
        ev("m14.review_clock.escalated", clock("t_zero", "low")),
      ),
    ).rejects.toThrow(/unknown severity/);
    expect(recorded).toHaveLength(0);
  });
});

describe("m14.review_floor.override_recorded -> compliance", () => {
  it("warns the compliance inbox + clinical supervisor (+ org_admin backstop), once per meeting, never carrying the free-text reason", async () => {
    const { by, recorded } = setup();
    await by("m14.review_floor.override_recorded").handle(
      ev("m14.review_floor.override_recorded", override),
    );
    const a = recorded[0]!;
    expect(a.severity).toBe("warn");
    expect(a.correlationId).toBe(idgReviewFloorOverrideCorrelationId("mtg-1"));
    expect(recipientsOf(a)).toEqual(
      ["u-clinical_supervisor", "u-compliance_officer", "u-org_admin"].sort(),
    );
    expect(a.deliveries.some((d) => d.channel === "email")).toBe(false); // no preferences row => in-app floor only
    expect(JSON.stringify(a.payload)).not.toMatch(/Jane|Doe|family request|reason/);
    expect(a.payload).toMatchObject({ breachingPatients: override.breachingPatients });
  });
});

describe("shared guarantees", () => {
  it("throws when a payload type is missing from the catalog, or fails its schema — never emits", async () => {
    const emit = vi.fn();
    const empty = buildIdgAlertConsumers({
      alerts: { emit } as never,
      catalog: new Map(),
      membershipUserId: async () => "u",
      meetingAttendees: async () => [],
    });
    await expect(empty[1]!.handle(ev("m14.action_item.created", actionItem))).rejects.toThrow(
      /not in the alert payload catalog/,
    );

    const { by } = setup();
    // breachingPatients malformed -> the catalog schema refuses
    await expect(
      by("m14.review_floor.override_recorded").handle(
        ev("m14.review_floor.override_recorded", { ...override, breachingPatients: "nope" }),
      ),
    ).rejects.toThrow(/fails the 'm14.review_floor.override_recorded' catalog schema/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("no payload carries names, titles or free text: ids, counts, dates and constant copy only", async () => {
    const { by, recorded } = setup();
    await by("m14.packets.ready").handle(ev("m14.packets.ready", packetsReady));
    await by("m14.action_item.created").handle(ev("m14.action_item.created", actionItem));
    await by("m14.decision.recorded_open").handle(ev("m14.decision.recorded_open", decision));
    await by("m14.review_clock.escalated").handle(
      ev("m14.review_clock.escalated", clock("t_plus_1", "critical")),
    );
    await by("m14.review_floor.override_recorded").handle(
      ev("m14.review_floor.override_recorded", override),
    );
    expect(recorded).toHaveLength(5);
    for (const r of recorded) {
      expect(JSON.stringify(r.payload)).not.toMatch(/Jane|Doe|title|firstName|lastName|http/i);
      expect(typeof r.payload.bodyTemplate).toBe("string");
    }
  });
});
