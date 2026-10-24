// M36 consumer plans for M6 milestone 10a (NOMNC / BFCC-QIO expedited review): two audiences per code, deterministic
// correlation keys per (deadline, boundary), PHI-free payloads, a malformed event throws.
import { describe, expect, it } from "vitest";
import {
  M36_ADMISSION_COMPLIANCE_ALERT_EVENT_TYPES,
  planAdmissionComplianceAlerts,
} from "../src/modules/36-messaging/outbox-consumers/admission-compliance-alerts";

const base = {
  expeditedDeadlineId: "d1",
  subject: "review",
  kind: "denc_delivery",
  admissionId: "a1",
  patientId: "p1",
  dueAt: "2026-07-15T23:00:00.000Z",
};

describe("expedited-review alerts", () => {
  it("subscribes to the three expedited events", () => {
    expect(M36_ADMISSION_COMPLIANCE_ALERT_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "m6.expedited_review.opened",
        "m6.expedited_deadline.approaching",
        "m6.expedited_deadline.overdue",
      ]),
    );
  });

  it("a review opening pages the care team and compliance", () => {
    const plans = planAdmissionComplianceAlerts({
      eventType: "m6.expedited_review.opened",
      payload: {
        expeditedReviewId: "r1",
        nomncNoticeId: "n1",
        admissionId: "a1",
        patientId: "p1",
        qioNotifiedAt: "2026-07-15T17:00:00.000Z",
      },
    });
    expect(plans.map((p) => [p.alertEventType, p.correlationKey])).toEqual([
      ["m6.expedited_review.opened", "r1:team"],
      ["m6.expedited_review.opened_compliance", "r1:compliance"],
    ]);
    expect(plans[0]?.safe.deepLink).toBe("/admissions/a1");
  });

  it("each boundary has its own correlation key (never collapses into the last)", () => {
    const keys = [24, 4, 1].flatMap((h) =>
      planAdmissionComplianceAlerts({
        eventType: "m6.expedited_deadline.approaching",
        payload: { ...base, boundaryHours: h },
      }).map((p) => p.correlationKey),
    );
    expect(new Set(keys).size).toBe(6);
    expect(keys).toContain("d1:24:team");
    expect(keys).toContain("d1:1:compliance");
  });

  it("overdue is its own key and the payload carries no names or notes", () => {
    const plans = planAdmissionComplianceAlerts({
      eventType: "m6.expedited_deadline.overdue",
      payload: base,
    });
    expect(plans.map((p) => p.correlationKey)).toEqual(["d1:overdue:team", "d1:overdue:compliance"]);
    expect(Object.keys(plans[0]?.safe ?? {}).sort()).toEqual(
      [
        "admissionId",
        "deepLink",
        "dueAt",
        "expeditedDeadlineId",
        "kind",
        "message",
        "patientId",
        "subject",
      ].sort(),
    );
  });

  it("throws on a malformed payload (retry then DLQ, never a dropped alert)", () => {
    expect(() =>
      planAdmissionComplianceAlerts({ eventType: "m6.expedited_deadline.overdue", payload: {} }),
    ).toThrow(/patientId/);
    expect(() =>
      planAdmissionComplianceAlerts({
        eventType: "m6.expedited_deadline.approaching",
        payload: base,
      }),
    ).toThrow(/boundaryHours/);
  });
});
