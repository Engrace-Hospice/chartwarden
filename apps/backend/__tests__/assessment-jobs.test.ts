// apps/backend/__tests__/assessment-jobs.test.ts — M9-T06 (§4.8 BullMQ jobs). The three pure scans:
// license-status (daily, §2.2.3 transitions → license_* events), change-escalation (hourly, CRITICAL
// open > 24h → escalated + significant_change_escalated), reassessment-due (daily, cadence overdue).
// Each is deterministic over an injected `now`/`today` and idempotent (a re-run after the runner persists
// is a no-op). Also asserts the §2.4 events the scans plan use only catalogued `m9.*` names.
import { describe, expect, it } from "vitest";
import {
  ESCALATION_WINDOW_MS,
  M9_JOB_SCHEDULES,
  M9_QUEUES,
  REASSESSMENT_CADENCE_DAYS,
  type ReassessmentSnapshot,
  type ScaleLicenseSnapshot,
  type SignificantChangeSnapshot,
  effectiveCadenceDays,
  jobIdempotencyKey,
  planChangeEscalation,
  planLicenseStatusScan,
  planReassessmentDueScan,
} from "../src/modules/09-assessments/index";

describe("§4.8 queue catalog", () => {
  it("declares the five spec queues and their cron cadences", () => {
    expect(Object.values(M9_QUEUES)).toEqual([
      "assessment.license",
      "assessment.changes",
      "assessment.cadence",
      "assessment.summary",
      "assessment.eraser",
    ]);
    expect(M9_JOB_SCHEDULES.license).toBe("0 2 * * *");
    expect(M9_JOB_SCHEDULES.changes).toBe("0 * * * *");
    expect(M9_JOB_SCHEDULES.cadence).toBe("0 6 * * *");
  });

  it("idempotency key is a stable join of (scope, job, payloadHash)", () => {
    expect(jobIdempotencyKey({ scopeId: "pat-1", jobName: "cadence", payloadHash: "h" })).toBe(
      "pat-1:cadence:h",
    );
  });
});

describe("planLicenseStatusScan — §2.2.3 daily", () => {
  const lic = (over: Partial<ScaleLicenseSnapshot>): ScaleLicenseSnapshot => ({
    scaleLicenseId: "lic-1",
    scaleType: "pps",
    status: "active",
    effectiveDate: "2026-01-01",
    expiresAt: "2027-01-01",
    ...over,
  });

  it("emits license_pending_renewal on the active → pending_renewal edge (within 30d of expiry)", () => {
    const plan = planLicenseStatusScan([lic({ expiresAt: "2026-07-01" })], "2026-06-21");
    expect(plan.transitions[0]).toMatchObject({
      fromStatus: "active",
      toStatus: "pending_renewal",
      changed: true,
    });
    expect(plan.events).toEqual([
      {
        eventName: "m9.scale.license_pending_renewal",
        payload: { scaleType: "pps", expiresAt: "2026-07-01" },
      },
    ]);
  });

  it("emits license_lapsed on the edge into expiry", () => {
    const plan = planLicenseStatusScan(
      [lic({ status: "pending_renewal", expiresAt: "2026-06-01" })],
      "2026-06-21",
    );
    expect(plan.events).toEqual([
      {
        eventName: "m9.scale.license_lapsed",
        payload: { scaleType: "pps", expiredAt: "2026-06-01" },
      },
    ]);
  });

  it("is idempotent — a license already at its computed status does not re-emit", () => {
    const plan = planLicenseStatusScan(
      [lic({ status: "pending_renewal", expiresAt: "2026-07-01" })],
      "2026-06-21",
    );
    expect(plan.transitions[0]?.changed).toBe(false);
    expect(plan.events).toEqual([]);
  });
});

describe("planChangeEscalation — §2.2.2 / §4.8 hourly", () => {
  const now = new Date("2026-06-21T12:00:00.000Z");
  const change = (over: Partial<SignificantChangeSnapshot>): SignificantChangeSnapshot => ({
    eventId: "evt-1",
    ruleId: "pps_drop_20_in_14d",
    status: "open",
    detectedAt: "2026-06-20T11:00:00.000Z", // 25h before now
    ...over,
  });

  it("escalates a CRITICAL open change past 24h no-ack and emits significant_change_escalated", () => {
    const plan = planChangeEscalation([change({})], now);
    expect(plan.escalations[0]).toMatchObject({
      eventId: "evt-1",
      fromStatus: "open",
      toStatus: "escalated",
      originalDetectedAt: "2026-06-20T11:00:00.000Z",
      escalatedAt: now.toISOString(),
    });
    expect(plan.events).toEqual([
      {
        eventName: "m9.assessment.significant_change_escalated",
        payload: {
          eventId: "evt-1",
          originalDetectedAt: "2026-06-20T11:00:00.000Z",
          escalatedAt: now.toISOString(),
        },
      },
    ]);
  });

  it("does not escalate a non-CRITICAL rule even past 24h", () => {
    const plan = planChangeEscalation([change({ ruleId: "esas_symptom_ge_7" })], now);
    expect(plan.escalations).toEqual([]);
    expect(plan.events).toEqual([]);
  });

  it("does not escalate inside the 24h window, nor an already-escalated/acknowledged row", () => {
    const recent = change({ detectedAt: "2026-06-21T00:00:00.000Z" }); // 12h before now
    expect(planChangeEscalation([recent], now, ESCALATION_WINDOW_MS).escalations).toEqual([]);
    expect(planChangeEscalation([change({ status: "escalated" })], now).escalations).toEqual([]);
    expect(planChangeEscalation([change({ status: "acknowledged" })], now).escalations).toEqual([]);
  });
});

describe("planReassessmentDueScan — §418.54(d) daily", () => {
  const snap = (lastCapturedAt: string): ReassessmentSnapshot => ({
    patientId: "pat-1",
    scaleType: "esas_r",
    lastCapturedAt,
  });

  it("flags overdue when now > lastCapturedAt + 15-day cadence", () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    const overdue = planReassessmentDueScan([snap("2026-06-01T00:00:00.000Z")], now);
    expect(overdue[0]).toMatchObject({ patientId: "pat-1", scaleType: "esas_r", overdue: true });
    expect(overdue[0]?.dueAt).toBe("2026-06-16T00:00:00.000Z");
  });

  it("is not overdue inside the cadence window", () => {
    const now = new Date("2026-06-10T00:00:00.000Z");
    expect(planReassessmentDueScan([snap("2026-06-01T00:00:00.000Z")], now)[0]?.overdue).toBe(
      false,
    );
    expect(REASSESSMENT_CADENCE_DAYS).toBe(15);
  });
});

describe("effectiveCadenceDays — tenant may only TIGHTEN the 15-day floor (GAP-181)", () => {
  it("uses the floor with no override", () => {
    expect(effectiveCadenceDays("braden", undefined)).toBe(15);
    expect(effectiveCadenceDays("braden", {})).toBe(15);
  });
  it("honours a tighter override", () => {
    expect(effectiveCadenceDays("braden", { braden: 7 })).toBe(7);
  });
  it("clamps a looser override to the floor", () => {
    expect(effectiveCadenceDays("braden", { braden: 30 })).toBe(15);
  });
  it("ignores a malformed override rather than disabling the cadence", () => {
    for (const bad of [0, -3, 2.5, "7", null, Number.NaN]) {
      expect(effectiveCadenceDays("braden", { braden: bad })).toBe(15);
    }
  });
  it("applies per scale in the due scan", () => {
    const now = new Date("2026-06-10T00:00:00.000Z");
    const latest = [
      { patientId: "p", scaleType: "braden" as const, lastCapturedAt: "2026-06-01T00:00:00.000Z" },
      { patientId: "p", scaleType: "pps" as const, lastCapturedAt: "2026-06-01T00:00:00.000Z" },
    ];
    const flags = planReassessmentDueScan(latest, now, (scale) =>
      effectiveCadenceDays(scale, { braden: 7 }),
    );
    expect(flags.map((f) => [f.scaleType, f.cadenceDays, f.overdue])).toEqual([
      ["braden", 7, true],
      ["pps", 15, false],
    ]);
  });
});
