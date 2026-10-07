import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AlertEmitter, PLATFORM_DEFAULT_ALERT_RULES } from "@wardenx/messaging";
import {
  TRIAGE_AWAITING_CALLBACK_GRACE_MINUTES,
  TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES,
  TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES,
} from "@wardenx/types";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  M19_JOB_SCHEDULES,
  M19_OUTBOX_EVENTS,
  M19_QUEUES,
  M19_QUEUE_PARAMS,
} from "../src/modules/19-oncall/index";
import { M19_DLQ } from "../src/modules/19-oncall/jobs/index";
import {
  MANDATORY_ESCALATION_SLA_CEILING_MINUTES,
  resolveAwaitingCallbackGraceMinutes,
  resolveCallbackSlaMinutes,
  resolveEscalationSlaMinutes,
} from "../src/modules/19-oncall/jobs/triage-sla-policy";
import {
  TRIAGE_CALL_EDGES,
  autoTimeoutCallback,
  resolveEdge,
} from "../src/modules/19-oncall/lifecycle/triage-call";
import {
  M19_CALLBACK_SLA_ALERT_TYPE,
  M19_ESCALATION_SLA_ALERT_TYPE,
  buildM36OncallAlertConsumer,
} from "../src/modules/36-messaging/outbox-consumers/oncall-alerts";

describe("resolveCallbackSlaMinutes (§4.8 callback-sla target)", () => {
  it("prefers clinical_urgent, else the tightest usable value, else the platform floor", () => {
    expect(resolveCallbackSlaMinutes({ clinical_urgent: 20, clinical_routine: 120 })).toBe(20);
    expect(resolveCallbackSlaMinutes({ clinical_routine: 120, operational: 240 })).toBe(120);
    expect(resolveCallbackSlaMinutes({})).toBe(TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES);
    expect(resolveCallbackSlaMinutes(null)).toBe(TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES);
    expect(resolveCallbackSlaMinutes([5])).toBe(TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES);
  });

  it("ignores unusable values instead of disabling the page", () => {
    expect(resolveCallbackSlaMinutes({ clinical_urgent: 0, clinical_routine: "x" })).toBe(
      TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES,
    );
    expect(resolveCallbackSlaMinutes({ clinical_urgent: -5, operational: 45.9 })).toBe(45);
  });
});

describe("resolveAwaitingCallbackGraceMinutes (§4.8 timeout grace, tighten-only)", () => {
  it("defaults to 60, accepts a tighter override, never a looser one", () => {
    expect(resolveAwaitingCallbackGraceMinutes({})).toBe(TRIAGE_AWAITING_CALLBACK_GRACE_MINUTES);
    expect(resolveAwaitingCallbackGraceMinutes(undefined)).toBe(60);
    expect(resolveAwaitingCallbackGraceMinutes({ awaitingCallbackGraceMinutes: 20 })).toBe(20);
    expect(resolveAwaitingCallbackGraceMinutes({ awaiting_callback_grace_minutes: 15 })).toBe(15);
    expect(resolveAwaitingCallbackGraceMinutes({ awaitingCallbackGraceMinutes: 600 })).toBe(60);
    expect(resolveAwaitingCallbackGraceMinutes({ awaitingCallbackGraceMinutes: 0 })).toBe(60);
  });
});

describe("resolveEscalationSlaMinutes (§4.8 escalation-sla)", () => {
  it("uses the tenant ladder's slaMinutes, else the per-tier platform default", () => {
    const tiers = { tier_2_clinical_manager: { slaMinutes: 90 } };
    expect(resolveEscalationSlaMinutes(tiers, "tier_2_clinical_manager", false)).toBe(90);
    expect(resolveEscalationSlaMinutes(tiers, "tier_1_rn_supervisor", false)).toBe(
      TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES.tier_1_rn_supervisor,
    );
    expect(resolveEscalationSlaMinutes(undefined, "tier_4_compliance_officer", false)).toBe(60);
  });

  it("caps a mandatory row at the tightest default whatever the tenant says", () => {
    const tiers = { tier_3_medical_director: { slaMinutes: 240 } };
    expect(resolveEscalationSlaMinutes(tiers, "tier_3_medical_director", true)).toBe(
      MANDATORY_ESCALATION_SLA_CEILING_MINUTES,
    );
    expect(MANDATORY_ESCALATION_SLA_CEILING_MINUTES).toBe(15);
  });
});

describe("autoTimeoutCallback (§4.8 awaiting-callback-timeout transition)", () => {
  const call = {
    state: "awaiting_callback",
    version: 3,
    selectedProtocolId: null,
    linkedEncounterId: null,
    firstResponseAt: null,
    documentedAt: null,
    paperOriginFlag: false,
  } as const;

  it("moves awaiting_callback -> disposition_pending as a system transition flagged auto_timeout", () => {
    const t = autoTimeoutCallback(call);
    expect(t.to).toBe("disposition_pending");
    expect(t.effects).toContainEqual({
      kind: "state_history",
      from: "awaiting_callback",
      to: "disposition_pending",
      systemActor: true,
      autoTimeout: true,
    });
    expect(t.effects).toContainEqual({ kind: "audit" });
  });

  it("is refused from any other state", () => {
    expect(() => autoTimeoutCallback({ ...call, state: "protocol_in_progress" })).toThrow();
    expect(() => resolveEdge("closed", "autoTimeoutCallback")).toThrow();
  });

  it("every app edge is accepted by the DB forward-transition whitelist (0108 + 0362 redefinition)", () => {
    const dir = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
    // 0362 REPLACES the function body; the latest definition is the one in force.
    const sql = readFileSync(join(dir, "0362_m19_cron_sla_markers_auto_timeout.sql"), "utf8");
    const allowed = new Map<string, readonly string[]>();
    for (const m of sql.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)) {
      allowed.set(
        m[1] as string,
        [...(m[2] as string).matchAll(/'(\w+)'/g)].map((x) => x[1] as string),
      );
    }
    for (const edge of TRIAGE_CALL_EDGES) {
      expect(allowed.get(edge.from) ?? []).toContain(edge.to);
    }
  });
});

describe("§4.8 non-Tier-1 queue catalog", () => {
  it("declares the four queues with the spec's priority/attempts/backoff, no ':' in any name", () => {
    for (const q of Object.values(M19_QUEUES)) expect(q).not.toContain(":");
    for (const q of Object.values(M19_DLQ)) expect(q).not.toContain(":");
    expect(M19_QUEUE_PARAMS.callbackSla).toMatchObject({
      priority: 2,
      attempts: 2,
      backoff: "fixed 15s",
    });
    expect(M19_QUEUE_PARAMS.awaitingCallbackTimeout).toMatchObject({
      priority: 3,
      attempts: 2,
      backoff: "fixed 30s",
    });
    expect(M19_QUEUE_PARAMS.closeDocumented).toMatchObject({
      priority: 3,
      attempts: 2,
      backoff: "fixed 30s",
    });
    expect(M19_QUEUE_PARAMS.escalationSla).toMatchObject({
      priority: 2,
      attempts: 2,
      backoff: "fixed 30s",
    });
    expect(M19_JOB_SCHEDULES.callbackSlaEveryMs).toBe(60_000);
    expect(M19_JOB_SCHEDULES.awaitingCallbackTimeoutEveryMs).toBe(10 * 60_000);
    expect(M19_JOB_SCHEDULES.closeDocumentedEveryMs).toBe(15 * 60_000);
    expect(M19_JOB_SCHEDULES.escalationSlaEveryMs).toBe(5 * 60_000);
    expect(M19_DLQ.callbackSla).toBe("oncall.callback-sla.dlq");
    expect(M19_DLQ.awaitingCallbackTimeout).toBe("oncall.callback-timeout.dlq");
  });

  it("the catalog names M36 as the declared consumer of both SLA-breach events", () => {
    for (const name of [
      "m19.triage_call.callback_sla_breached",
      "m19.triage_call.escalation_sla_breached",
    ]) {
      expect(M19_OUTBOX_EVENTS.find((e) => e.eventName === name)?.declaredConsumers).toContain(
        "m36",
      );
    }
  });
});

describe("M36 oncall-alerts consumer (SLA breaches)", () => {
  const ENVELOPE_ORG = "11111111-1111-4111-8111-111111111111";
  const PAYLOAD_ORG = "99999999-9999-4999-8999-999999999999";
  const PE = "22222222-2222-4222-8222-222222222222";
  const CALL = "33333333-3333-4333-8333-333333333333";
  const EVENT_ID = "55555555-5555-4555-8555-555555555555";
  const event = (eventType: string, payload: unknown) =>
    ({
      id: EVENT_ID,
      organizationId: ENVELOPE_ORG,
      eventType,
      aggregateKind: "triage_call",
      aggregateId: CALL,
      payload,
      attemptCount: 0,
      createdAt: new Date("2026-10-06T02:10:00.000Z"),
    }) satisfies DispatchableOutboxEvent;
  const harness = () => {
    const emit = vi.fn(async () => ({}) as never);
    return { emit, consumer: buildM36OncallAlertConsumer({ emit } as unknown as AlertEmitter) };
  };
  const callbackPayload = {
    orgId: PAYLOAD_ORG,
    providerEntityId: PE,
    triageCallId: CALL,
    occurredAt: "2026-10-06T02:10:00.000Z",
    slaTargetMinutes: 30,
    minutesElapsed: 41,
  };
  const escalationPayload = {
    orgId: PAYLOAD_ORG,
    providerEntityId: PE,
    triageCallId: CALL,
    occurredAt: "2026-10-06T02:10:00.000Z",
    escalationId: "44444444-4444-4444-8444-444444444444",
    tier: "tier_3_medical_director",
    mandatory: true,
    slaTargetMinutes: 15,
    minutesOpen: 22,
  };

  it("callback breach: one warn alert under the ENVELOPE org, keyed on the outbox event id, PHI-free", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event("m19.triage_call.callback_sla_breached", callbackPayload));
    const [org, input] = emit.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(org).toBe(ENVELOPE_ORG);
    expect(input).toMatchObject({
      eventType: M19_CALLBACK_SLA_ALERT_TYPE,
      severity: "warn",
      correlationId: `outbox:${M19_CALLBACK_SLA_ALERT_TYPE}:${EVENT_ID}`,
    });
    expect(JSON.stringify(input)).not.toContain(PAYLOAD_ORG);
  });

  it("escalation breach: critical for a mandatory row, warn otherwise", async () => {
    const { emit, consumer } = harness();
    await consumer.handle(event("m19.triage_call.escalation_sla_breached", escalationPayload));
    await consumer.handle(
      event("m19.triage_call.escalation_sla_breached", { ...escalationPayload, mandatory: false }),
    );
    const severities = emit.mock.calls.map(
      (c) => (c as unknown as [string, { severity: string; eventType: string }])[1],
    );
    expect(severities.map((s) => s.severity)).toEqual(["critical", "warn"]);
    expect(severities[0]?.eventType).toBe(M19_ESCALATION_SLA_ALERT_TYPE);
  });

  it("throws on a malformed payload or an unexpected event (relay retry -> DLQ), never a dropped page", async () => {
    const { emit, consumer } = harness();
    await expect(
      consumer.handle(
        event("m19.triage_call.callback_sla_breached", { ...callbackPayload, triageCallId: "" }),
      ),
    ).rejects.toThrow(/triageCallId/);
    await expect(
      consumer.handle(
        event("m19.triage_call.escalation_sla_breached", {
          ...escalationPayload,
          minutesOpen: "soon",
        }),
      ),
    ).rejects.toThrow(/minutesOpen/);
    await expect(consumer.handle(event("m19.something.else", {}))).rejects.toThrow(/unexpected/);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("platform alert rules for the SLA pages", () => {
  const rule = (eventType: string) =>
    PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);

  it("callback breach is the §4.9 rule: warn, on_call, not system-locked", () => {
    expect(rule(M19_CALLBACK_SLA_ALERT_TYPE)).toMatchObject({
      severityFloor: "warn",
      recipientResolver: "on_call",
      systemLocked: false,
      enabled: true,
    });
  });

  it("escalation breach pages the supervisory role set, not the tier's own (unresponsive) recipient", () => {
    expect(rule(M19_ESCALATION_SLA_ALERT_TYPE)).toMatchObject({
      recipientResolver: "role_set",
      resolverArgs: { roleKeys: ["clinical_supervisor", "don", "org_admin"] },
      systemLocked: false,
    });
  });
});
