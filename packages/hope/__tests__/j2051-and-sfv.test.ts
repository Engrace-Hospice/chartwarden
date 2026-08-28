// @wardenx/hope — J2051 trigger (D4) + SFV engine (§2.2.3, D3) — M10-T03.
import { describe, expect, it } from "vitest";
import {
  SFV_DUE_CALENDAR_DAYS,
  SFV_MISSED_AFTER_DAYS,
  type SfvCompletionTarget,
  decideSfvWatchdogStatus,
  planSfvCompletion,
  planSfvCreation,
} from "../src/sfv/sfv";
import { evaluateJ2051Trigger } from "../src/triggers/j2051";

const UTC = "UTC";

describe("evaluateJ2051Trigger — server-authoritative per-symptom severity (D4)", () => {
  it("fires on any moderate symptom; maxSeverity is the highest", () => {
    const v = evaluateJ2051Trigger({
      entries: [
        { symptomCode: "pain", severity: "mild" },
        { symptomCode: "anxiety", severity: "moderate" },
      ],
    });
    expect(v.triggerFired).toBe(true);
    expect(v.maxSeverity).toBe("moderate");
    expect(v.contributingSymptoms).toEqual([{ symptomCode: "anxiety", severity: "moderate" }]);
  });

  it("fires on severe and lists every contributing symptom (one SFV per source, D4)", () => {
    const v = evaluateJ2051Trigger({
      entries: [
        { symptomCode: "pain", severity: "severe" },
        { symptomCode: "shortness_of_breath", severity: "moderate" },
        { symptomCode: "nausea_vomiting", severity: "mild" },
      ],
    });
    expect(v.maxSeverity).toBe("severe");
    expect(v.contributingSymptoms.map((s) => s.symptomCode)).toEqual([
      "pain",
      "shortness_of_breath",
    ]);
  });

  it("does NOT fire when all symptoms are below moderate", () => {
    const v = evaluateJ2051Trigger({
      entries: [
        { symptomCode: "pain", severity: "none" },
        { symptomCode: "anxiety", severity: "mild" },
      ],
    });
    expect(v.triggerFired).toBe(false);
    expect(v.maxSeverity).toBe("mild");
    expect(v.contributingSymptoms).toEqual([]);
  });

  it("an empty reading yields none / no trigger", () => {
    expect(evaluateJ2051Trigger({ entries: [] })).toEqual({
      maxSeverity: "none",
      triggerFired: false,
      contributingSymptoms: [],
    });
  });
});

describe("planSfvCreation — ADR-0018 D1 2-calendar-day window off the ASSESSMENT date", () => {
  it("due_at is end of (assessment local date + 2 calendar days)", () => {
    expect(SFV_DUE_CALENDAR_DAYS).toBe(2);
    const sfv = planSfvCreation({
      triggeringAssessmentId: "a-1",
      assessmentDate: "2026-06-10T15:00:00.000Z",
      signedAt: "2026-06-10T15:00:00.000Z",
      timeZone: UTC,
    });
    expect(sfv.dueAt).toBe("2026-06-12T23:59:59.999Z");
    expect(sfv.triggeredAt).toBe("2026-06-10T15:00:00.000Z");
  });

  it("a LATE signature does not move the deadline (the ADR-0018 D1 point)", () => {
    // Assessment done Jun 10; signed Jun 13. Due stays end-of Jun 12 — already overdue at signing.
    const sfv = planSfvCreation({
      triggeringAssessmentId: "a-3",
      assessmentDate: "2026-06-10T15:00:00.000Z",
      signedAt: "2026-06-13T09:00:00.000Z",
      timeZone: UTC,
    });
    expect(sfv.dueAt).toBe("2026-06-12T23:59:59.999Z");
    expect(sfv.triggeredAt).toBe("2026-06-13T09:00:00.000Z");
  });

  it("anchors on the org-local day (a late-evening LA assessment stays on its local date)", () => {
    // 2026-06-10T05:00Z == 2026-06-09 22:00 LA → local date Jun 9 → due Jun 11
    const sfv = planSfvCreation({
      triggeringAssessmentId: "a-2",
      assessmentDate: "2026-06-10T05:00:00.000Z",
      signedAt: "2026-06-10T05:00:00.000Z",
      timeZone: "America/Los_Angeles",
    });
    expect(sfv.dueAt).toBe("2026-06-12T06:59:59.999Z"); // 23:59:59.999 LA on Jun 11 == 06:59:59.999Z Jun 12
  });
});

describe("planSfvCompletion — §2.2.3 completion guards", () => {
  const open: SfvCompletionTarget = {
    id: "sfv-1",
    status: "open",
    dueAt: "2026-06-12T23:59:59.999Z",
  };

  it("completes an open SFV before due", () => {
    const plan = planSfvCompletion(open, "rfa04-1", "2026-06-11T10:00:00.000Z");
    expect(plan).toEqual({ sfvId: "sfv-1", completingAssessmentId: "rfa04-1" });
  });

  it("rejects double-completion (409 M10_SFV_ALREADY_COMPLETED)", () => {
    expect(() =>
      planSfvCompletion({ ...open, status: "completed" }, "rfa04-1", "2026-06-11T10:00:00.000Z"),
    ).toThrowError(expect.objectContaining({ code: "M10_SFV_ALREADY_COMPLETED", statusCode: 409 }));
  });

  it("rejects past-due completion without an admin override (409 M10_SFV_PAST_DUE)", () => {
    expect(() => planSfvCompletion(open, "rfa04-1", "2026-06-13T10:00:00.000Z")).toThrowError(
      expect.objectContaining({ code: "M10_SFV_PAST_DUE", statusCode: 409 }),
    );
  });

  it("allows a past-due completion WITH an admin override", () => {
    const plan = planSfvCompletion(open, "rfa04-1", "2026-06-13T10:00:00.000Z", {
      adminOverride: true,
    });
    expect(plan.sfvId).toBe("sfv-1");
  });
});

describe("decideSfvWatchdogStatus — §2.2.3 time-based decay", () => {
  const dueAt = "2026-06-12T23:59:59.999Z";
  it("stays open before due", () => {
    expect(
      decideSfvWatchdogStatus({
        current: "open",
        dueAt,
        asOfInstant: "2026-06-12T10:00:00.000Z",
        timeZone: UTC,
      }),
    ).toBe("open");
  });
  it("open → overdue once due passes", () => {
    expect(
      decideSfvWatchdogStatus({
        current: "open",
        dueAt,
        asOfInstant: "2026-06-13T10:00:00.000Z",
        timeZone: UTC,
      }),
    ).toBe("overdue");
  });
  it("overdue → missed after 7 days past due", () => {
    expect(SFV_MISSED_AFTER_DAYS).toBe(7);
    expect(
      decideSfvWatchdogStatus({
        current: "overdue",
        dueAt,
        asOfInstant: "2026-06-20T00:00:00.001Z",
        timeZone: UTC,
      }),
    ).toBe("missed");
  });
  it("terminal states pass through unchanged", () => {
    expect(
      decideSfvWatchdogStatus({
        current: "completed",
        dueAt,
        asOfInstant: "2026-07-01T00:00:00.000Z",
        timeZone: UTC,
      }),
    ).toBe("completed");
    expect(
      decideSfvWatchdogStatus({
        current: "missed",
        dueAt,
        asOfInstant: "2026-07-01T00:00:00.000Z",
        timeZone: UTC,
      }),
    ).toBe("missed");
  });

  it("an already-overdue SFV remains overdue without inventing a new transition", () => {
    expect(
      decideSfvWatchdogStatus({
        current: "overdue",
        dueAt,
        asOfInstant: "2026-06-13T10:00:00.000Z",
        timeZone: UTC,
      }),
    ).toBe("overdue");
  });
});
