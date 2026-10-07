// GAP-161 - the 21 m32 events are catalogued exactly once, the emitter publishes platform-scoped events with a null
// org and an `orgId: null` payload, and the two §4.8 workers (token-ledger rollup, triage follow-up) decide correctly.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import { M32_EVENT_NAMES } from "../event-names";
import { createM32EventEmitter } from "../events";
import { M32_OUTBOX_EVENTS } from "../events-by-m32";
import { runTokenLedgerRollup, tokenCapAlertFor } from "../jobs/token-ledger-rollup";
import { runTriageFollowUp } from "../jobs/triage-followup-worker";

describe("m32 event catalog", () => {
  it("catalogs exactly the 21 names the emitter is typed against", () => {
    expect(M32_OUTBOX_EVENTS.map((e) => e.eventName).sort()).toEqual([...M32_EVENT_NAMES].sort());
    expect(M32_EVENT_NAMES).toHaveLength(21);
  });

  it("a platform-scoped emit publishes with a null org and carries orgId: null (never omitted)", async () => {
    const publish = vi.fn(async () => undefined);
    await createM32EventEmitter({ publish }).emitInTx(
      {},
      {
        name: "m32.capability.created",
        organizationId: null,
        aggregate: { kind: "ai_capability", id: "c1" },
        payload: {
          capabilityId: "c1",
          capabilityKey: "k",
          riskTier: "high",
          lifecycleState: "PROPOSED",
          createdByMembershipId: "m1",
        },
      },
    );
    const call = (publish.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(call.organizationId).toBeNull();
    const payload = call.payload as Record<string, unknown>;
    expect(payload.orgId).toBeNull();
    const schema = M32_OUTBOX_EVENTS.find((e) => e.eventName === "m32.capability.created")
      ?.payloadSchema as never;
    expect(Value.Check(schema, payload)).toBe(true);
  });
});

const window = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" };
const spend = (n: number) => ({ capabilityId: "c1", capabilityKey: "k", spentTokens: n });
const budget = { hardCapTokens: 1000, softCapTokens: 800 };

describe("tokenCapAlertFor", () => {
  it("is silent within budget and when no budget is configured", () => {
    expect(tokenCapAlertFor({ organizationId: "o", spend: spend(100), budget, window })).toBeNull();
    expect(
      tokenCapAlertFor({ organizationId: "o", spend: spend(10_000), budget: null, window }),
    ).toBeNull();
  });
  it("warns at the soft cap and pages at the hard cap", () => {
    expect(
      tokenCapAlertFor({ organizationId: "o", spend: spend(800), budget, window })?.alertType,
    ).toBe("ai.token_soft_cap_warning");
    const hard = tokenCapAlertFor({ organizationId: "o", spend: spend(1000), budget, window });
    expect(hard).toMatchObject({ alertType: "ai.token_hard_cap_breached", fallbackEngaged: true });
  });
});

describe("runTokenLedgerRollup", () => {
  it("alerts per breaching capability, counts undelivered, and survives a failing org", async () => {
    const emit = vi.fn(async () => ({}));
    const warn = vi.fn();
    const result = await runTokenLedgerRollup({
      listActiveOrgs: async () => [{ organizationId: "o1" }, { organizationId: "o2" }],
      spendForOrg: async (org) => {
        if (org === "o2") throw new Error("db");
        return [spend(900)];
      },
      budgetFor: async () => budget,
      alerts: { emit },
      now: () => new Date("2026-10-10T00:00:00Z"),
      warn,
    });
    expect(result).toEqual({ orgs: 2, alerts: 1, undelivered: 0, failedOrgs: 1 });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "o1", eventType: "ai.token_soft_cap_warning" }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("runTriageFollowUp", () => {
  const plan = (action: string, killSwitchReason: string | null, demotes: boolean) =>
    ({ action, killSwitchReason, demotesCapability: demotes }) as never;

  it("does nothing for a recorded 'none' decision", async () => {
    const result = await runTriageFollowUp(
      { safety: {} as never, governance: {} as never },
      { organizationId: "o", reportId: "r", capabilityId: "c", plan: plan("none", null, false) },
    );
    expect(result).toMatchObject({
      action: "none",
      killSwitchActivated: false,
      alertEmitted: false,
    });
  });

  it("notify_clinical_lead raises the system-locked escalation alert and touches no switch", async () => {
    const emit = vi.fn(async () => ({}));
    const result = await runTriageFollowUp(
      {
        safety: {
          registry: { findCapabilityById: async () => ({ lifecycleState: "APPROVED" }) },
          killSwitches: {},
        } as never,
        governance: {
          registry: { findCapabilityById: async () => ({ capabilityKey: "k" }) },
        } as never,
        alerts: { emit },
      },
      {
        organizationId: "o",
        reportId: "r",
        capabilityId: "c",
        plan: plan("notify_clinical_lead", null, false),
      },
    );
    expect(result).toMatchObject({
      killSwitchActivated: false,
      demotedTo: null,
      alertEmitted: true,
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "ai.hallucination_triage_escalation" }),
    );
  });
});
