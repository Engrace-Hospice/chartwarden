// GAP-026 — compliance-window escalation planner (every window kind) + the recert-due opener + M36 plan.
import { describe, expect, it } from "vitest";
import {
  type EscalationRow,
  planRecertDueWindows,
  planWindowEscalation,
} from "../src/modules/06-admission/jobs/window-escalation";
import { planAdmissionComplianceAlerts } from "../src/modules/36-messaging/outbox-consumers/admission-compliance-alerts";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const row = (over: Partial<EscalationRow>): EscalationRow => ({
  complianceWindowId: "w1",
  admissionId: "a1",
  patientId: "p1",
  windowKind: "notice_of_rights",
  status: "open",
  severity: "warning",
  autoAcknowledge: false,
  dueAt: "2026-10-10T00:00:00.000Z",
  ...over,
});

describe("planWindowEscalation", () => {
  it("leaves a window with plenty of time untouched", () => {
    const plan = planWindowEscalation([row({})], NOW);
    expect(plan.toClosingSoon).toEqual([]);
    expect(plan.toOverdue).toEqual([]);
  });
  it("moves a window inside the 24h lead to closing_soon without an event", () => {
    const plan = planWindowEscalation([row({ dueAt: "2026-10-07T06:00:00.000Z" })], NOW);
    expect(plan.toClosingSoon.map((r) => r.complianceWindowId)).toEqual(["w1"]);
    expect(plan.toOverdue).toEqual([]);
  });
  it("moves open and closing_soon windows past due to overdue for CTI/NOE/NOR kinds alike", () => {
    const rows = [
      row({
        complianceWindowId: "nor",
        windowKind: "notice_of_rights",
        dueAt: "2026-10-05T00:00:00.000Z",
      }),
      row({
        complianceWindowId: "cti",
        windowKind: "cti_signature_lookahead_14d",
        status: "closing_soon",
        dueAt: "2026-10-06T11:00:00.000Z",
      }),
      row({
        complianceWindowId: "ia",
        windowKind: "initial_assessment_48h",
        dueAt: "2026-10-06T12:00:00.000Z",
      }),
    ];
    const plan = planWindowEscalation(rows, NOW);
    expect(plan.toOverdue.map((r) => r.complianceWindowId).sort()).toEqual(["cti", "ia", "nor"]);
  });
  it("never re-selects an overdue or closed window (idempotent)", () => {
    const plan = planWindowEscalation(
      [
        row({ status: "overdue", dueAt: "2026-10-01T00:00:00.000Z" }),
        row({ complianceWindowId: "c", status: "closed", dueAt: "2026-10-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(plan.toOverdue).toEqual([]);
    expect(plan.toClosingSoon).toEqual([]);
  });
  it("skips addendum kinds (own scan), info severity and auto-acknowledged windows", () => {
    const past = "2026-10-01T00:00:00.000Z";
    const plan = planWindowEscalation(
      [
        row({ complianceWindowId: "ea", windowKind: "election_addendum_initial", dueAt: past }),
        row({
          complianceWindowId: "info",
          severity: "info",
          windowKind: "external_discharge_notice",
          dueAt: past,
        }),
        row({ complianceWindowId: "auto", autoAcknowledge: true, dueAt: past }),
      ],
      NOW,
    );
    expect(plan.toOverdue).toEqual([]);
  });
});

describe("planRecertDueWindows", () => {
  const period = (over: Record<string, unknown> = {}) => ({
    electionPeriodId: "e1",
    admissionId: "a1",
    scheduledEndAt: "2026-10-15",
    hasOpenWindow: false,
    ...over,
  });
  it("opens a recert_due_14d window for a period ending within 14 local days", () => {
    const out = planRecertDueWindows([period()], "2026-10-06");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ electionPeriodId: "e1", mustCompleteBy: "2026-10-15" });
  });
  it("does not open early, past the end, or twice", () => {
    expect(planRecertDueWindows([period({ scheduledEndAt: "2026-11-30" })], "2026-10-06")).toEqual(
      [],
    );
    expect(planRecertDueWindows([period({ scheduledEndAt: "2026-10-05" })], "2026-10-06")).toEqual(
      [],
    );
    expect(planRecertDueWindows([period({ hasOpenWindow: true })], "2026-10-06")).toEqual([]);
  });
});

describe("M36 generic window-overdue alert plan", () => {
  const base = {
    complianceWindowId: "w1",
    admissionId: "a1",
    patientId: "p1",
    windowKind: "notice_of_rights",
    dueAt: "2026-10-05T00:00:00.000Z",
    severity: "alert",
  };
  it("raises a care-team and a compliance alert keyed on the window", () => {
    const plans = planAdmissionComplianceAlerts({
      eventType: "m6.compliance.window.overdue",
      payload: base,
    });
    expect(plans.map((p) => p.alertEventType)).toEqual([
      "m6.compliance.window.overdue",
      "m6.compliance.window.overdue_compliance",
    ]);
    expect(plans[0]?.correlationKey).toBe("w1:team");
  });
  it("is a no-op for the addendum kinds (their own event pages) and for legacy payloads", () => {
    expect(
      planAdmissionComplianceAlerts({
        eventType: "m6.compliance.window.overdue",
        payload: { ...base, windowKind: "election_addendum_initial" },
      }),
    ).toEqual([]);
    expect(
      planAdmissionComplianceAlerts({
        eventType: "m6.compliance.window.overdue",
        payload: { complianceWindowId: "w1", severity: "alert" },
      }),
    ).toEqual([]);
  });
});
