// GAP-049 - the repeat planner + run loop (pure, no DB), and the zero-recipient fallback the consumer and the sweep share.
import type { AlertEmitter } from "@wardenx/messaging";
import { M30_REPEAT_CADENCES } from "@wardenx/types";
import { describe, expect, it, vi } from "vitest";
import {
  type OpenAlertItem,
  repeatAlertsFor,
  runAlertRepeatSweeps,
} from "../src/modules/30-quality/jobs/alert-repeat-sweeps";
import {
  QUALITY_RECIPIENT_FALLBACK_EVENT_TYPE,
  emitWithRecipientFallback,
} from "../src/modules/36-messaging/alert-recipient-fallback";
import {
  buildM36QualityAlertConsumer,
  planQualityAlerts,
} from "../src/modules/36-messaging/outbox-consumers/quality-alerts";

const HOUR = 3_600_000;
const ORG = "11111111-1111-4111-8111-111111111111";
const ORIGIN = new Date("2026-10-08T00:00:00Z");
const at = (ms: number) => new Date(ORIGIN.getTime() + ms);

const item = (over: Partial<OpenAlertItem> = {}): OpenAlertItem => ({
  cadence: M30_REPEAT_CADENCES.incident_sentinel,
  key: "inc-1",
  originAt: ORIGIN,
  payload: { incidentId: "inc-1", deepLink: "/quality/incidents/inc-1" },
  ...over,
});

describe("repeatAlertsFor", () => {
  it("emits nothing inside the first interval (the consumer's page is bucket 0)", () => {
    expect(repeatAlertsFor([item()], at(4 * HOUR - 1))).toEqual([]);
  });
  it("emits one :r1 repeat 4h after the origin, same type and severity, with repeatOrdinal", () => {
    const [repeat, ...rest] = repeatAlertsFor([item()], at(4 * HOUR + 60_000));
    expect(rest).toEqual([]);
    expect(repeat).toMatchObject({
      eventType: "m30.alerts.incident_sentinel",
      severity: "critical",
      correlationId: "outbox:m30.alerts.incident_sentinel:inc-1:r1",
      payload: { incidentId: "inc-1", repeatOrdinal: 1, eventType: "m30.alerts.incident_sentinel" },
    });
  });
  it("catches up to the current bucket only after a missed run", () => {
    const due = repeatAlertsFor([item()], at(4 * HOUR * 3 + 1));
    expect(due.map((d) => d.correlationId)).toEqual([
      "outbox:m30.alerts.incident_sentinel:inc-1:r3",
    ]);
  });
  it("gives one incident that is both sentinel and abuse two independent cadences (4h vs 6h)", () => {
    const both = [item(), item({ cadence: M30_REPEAT_CADENCES.incident_abuse_allegation })];
    expect(repeatAlertsFor(both, at(4 * HOUR + 1)).map((d) => d.eventType)).toEqual([
      "m30.alerts.incident_sentinel",
    ]);
    expect(repeatAlertsFor(both, at(6 * HOUR + 1)).map((d) => d.correlationId)).toEqual([
      "outbox:m30.alerts.incident_sentinel:inc-1:r1",
      "outbox:m30.alerts.incident_abuse_allegation:inc-1:r1",
    ]);
  });
  it("collapses items sharing a key onto the earliest origin (one correlation id, one page)", () => {
    const threshold = M30_REPEAT_CADENCES.measure_threshold_breached;
    const items = [
      item({ cadence: threshold, key: "m:2026-09-30", originAt: at(0) }),
      item({ cadence: threshold, key: "m:2026-09-30", originAt: at(24 * HOUR) }),
    ];
    const due = repeatAlertsFor(items, at(7 * 24 * HOUR + 1));
    expect(due).toHaveLength(1);
    expect(due[0]?.correlationId).toBe(
      "outbox:m30.alerts.measure_threshold_breached:m:2026-09-30:r1",
    );
  });
  it("stops the threshold series past its 90-day ceiling but never the safety pages", () => {
    const day = 24 * HOUR;
    const threshold = item({ cadence: M30_REPEAT_CADENCES.measure_threshold_breached, key: "m" });
    expect(repeatAlertsFor([threshold], at(91 * day))).toEqual([]);
    expect(repeatAlertsFor([item()], at(400 * day))).toHaveLength(1);
  });
  it("is pure: the input is not mutated and a rerun gives the same answer", () => {
    const items = [item()];
    const frozen = JSON.stringify(items);
    const first = repeatAlertsFor(items, at(5 * HOUR));
    expect(JSON.stringify(items)).toBe(frozen);
    expect(repeatAlertsFor(items, at(5 * HOUR))).toEqual(first);
  });
});

describe("runAlertRepeatSweeps", () => {
  it("emits per org, and a failing org is counted without stopping the rest", async () => {
    const emit = vi.fn().mockResolvedValue({});
    const warn = vi.fn();
    const summary = await runAlertRepeatSweeps({
      listActiveOrgs: async () => [{ organizationId: "bad" }, { organizationId: ORG }],
      scanOpenItems: async (organizationId) => {
        if (organizationId === "bad") throw new Error("boom");
        return [item()];
      },
      emit,
      now: () => at(4 * HOUR + 1),
      warn,
    });
    expect(summary).toEqual({ orgs: 2, repeatsRaised: 1, failedOrgs: 1 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe(ORG);
    expect(warn).toHaveBeenCalledWith("m30.alert_repeat_sweep: org sweep failed", {
      organizationId: "bad",
      error: "Error",
    });
  });
});

function fakeEmitter(counts: number[]) {
  const emitted: { orgId: string; eventType: string; correlationId: string; severity: string }[] =
    [];
  const emitter: AlertEmitter = {
    async emit(orgId, input) {
      emitted.push({
        orgId,
        eventType: input.eventType,
        correlationId: input.correlationId,
        severity: input.severity,
      });
      return { alertId: `a${emitted.length}`, resolvedRecipientCount: counts.shift() ?? 0 };
    },
  };
  return { emitter, emitted };
}

describe("emitWithRecipientFallback", () => {
  const input = {
    eventType: "m30.alerts.incident_sentinel",
    severity: "critical" as const,
    correlationId: "outbox:m30.alerts.incident_sentinel:inc-1",
    payload: { incidentId: "inc-1" },
  };
  it("does nothing extra when the page resolved recipients", async () => {
    const { emitter, emitted } = fakeEmitter([2]);
    await emitWithRecipientFallback(emitter, ORG, input);
    expect(emitted).toHaveLength(1);
  });
  it("re-emits ONCE under the fallback type and its OWN correlation id when nobody was resolved", async () => {
    const { emitter, emitted } = fakeEmitter([0, 3]);
    const warn = vi.fn();
    const result = await emitWithRecipientFallback(emitter, ORG, input, warn);
    expect(emitted.map((e) => [e.eventType, e.correlationId, e.severity])).toEqual([
      [input.eventType, input.correlationId, "critical"],
      [QUALITY_RECIPIENT_FALLBACK_EVENT_TYPE, `${input.correlationId}:fb`, "critical"],
    ]);
    expect(result.resolvedRecipientCount).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("incidentId");
  });
  it("warns loudly a second time when even the tenant admins resolve to nobody", async () => {
    const { emitter } = fakeEmitter([0, 0]);
    const warn = vi.fn();
    await emitWithRecipientFallback(emitter, ORG, input, warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("the quality consumer routes every alert type through the fallback", () => {
  const events = [
    {
      eventType: "m30.incident.submitted",
      payload: {
        incidentId: "i1",
        kind: "allegation_of_abuse",
        severity: "critical",
        reportedAt: "2026-10-08T00:00:00.000Z",
      },
      expect: ["m30.alerts.incident_sentinel", "m30.alerts.incident_abuse_allegation"],
    },
    {
      eventType: "m30.infection.outbreak_opened",
      payload: { caseId: "c1", pathogen: "mrsa", bodySite: "skin" },
      expect: ["m30.alerts.outbreak_detected"],
    },
    {
      eventType: "m30.measure.threshold_breached",
      payload: { indicatorId: "hvldl", measureId: "hvldl", periodEnd: "2026-09-30T00:00:00.000Z" },
      expect: ["m30.alerts.measure_threshold_breached"],
    },
    {
      eventType: "m30.cahps.sample_ready",
      payload: { samplePeriod: { start: "2026-09-01", end: "2026-09-30" } },
      expect: ["m30.alerts.cahps_sample_ready"],
    },
  ];
  it.each(events)("$eventType with 0 recipients pages the tenant admins", async (ev) => {
    const { emitter, emitted } = fakeEmitter(ev.expect.flatMap(() => [0, 1]));
    const consumer = buildM36QualityAlertConsumer(emitter);
    await consumer.handle({
      eventType: ev.eventType,
      payload: ev.payload,
      organizationId: ORG,
    } as never);
    const fallbacks = emitted.filter((e) => e.eventType === QUALITY_RECIPIENT_FALLBACK_EVENT_TYPE);
    expect(fallbacks).toHaveLength(ev.expect.length);
    for (const f of fallbacks) expect(f.correlationId.endsWith(":fb")).toBe(true);
    expect(
      emitted
        .filter((e) => e.eventType !== QUALITY_RECIPIENT_FALLBACK_EVENT_TYPE)
        .map((e) => e.eventType),
    ).toEqual(ev.expect);
  });
  it("keeps the original correlation id format (bucket 0) so repeats can extend it", () => {
    const [plan] = planQualityAlerts({
      eventType: "m30.incident.submitted",
      payload: {
        incidentId: "i1",
        kind: "fall",
        severity: "critical",
        reportedAt: "2026-10-08T00:00:00.000Z",
      },
      organizationId: ORG,
    } as never);
    expect(plan?.correlationKey).toBe("i1");
  });
});
