import { describe, expect, it } from "vitest";
import {
  planHopeWindowWatchdog,
  planM10AlertEmissions,
  planSfvWatchdog,
} from "../src/modules/10-hope/index";

describe("M10 SFV watchdog planner", () => {
  it("does not re-emit sfv_overdue when an overdue SFV remains overdue on a rerun", () => {
    const plan = planSfvWatchdog(
      [
        {
          sfvId: "sfv-1",
          patientId: "patient-1",
          admissionId: "admission-1",
          triggeringAssessmentId: "assessment-1",
          status: "overdue",
          dueAt: "2026-06-12T23:59:59.999Z",
          timeZone: "UTC",
        },
      ],
      "2026-06-13T10:00:00.000Z",
    );

    expect(plan.transitions).toEqual([
      {
        sfvId: "sfv-1",
        fromStatus: "overdue",
        toStatus: "overdue",
        changed: false,
        hoursPastDue: 10,
      },
    ]);
    expect(plan.events).toEqual([]);
  });

  it("emits exactly once on the open to overdue edge", () => {
    const plan = planSfvWatchdog(
      [
        {
          sfvId: "sfv-1",
          patientId: "patient-1",
          admissionId: "admission-1",
          triggeringAssessmentId: "assessment-1",
          status: "open",
          dueAt: "2026-06-12T23:59:59.999Z",
          timeZone: "UTC",
        },
      ],
      "2026-06-13T10:00:00.000Z",
    );

    expect(plan.transitions[0]?.changed).toBe(true);
    expect(plan.events).toEqual([
      {
        eventName: "m10.hope.sfv_overdue",
        payload: { sfvId: "sfv-1", hoursPastDue: 10 },
      },
    ]);
  });

  it("plans M36 SFV alert emissions from transition events with stable correlation ids", () => {
    const sfvs = [
      {
        sfvId: "sfv-1",
        patientId: "patient-1",
        admissionId: "admission-1",
        triggeringAssessmentId: "assessment-1",
        status: "open" as const,
        dueAt: "2026-06-12T23:59:59.999Z",
        timeZone: "UTC",
      },
    ];
    const plan = planSfvWatchdog(sfvs, "2026-06-13T10:00:00.000Z");

    expect(
      planM10AlertEmissions({
        organizationId: "org-1",
        schedules: [],
        sfvs,
        events: plan.events,
      }),
    ).toEqual([
      {
        eventType: "m10.hope.sfv_overdue",
        severity: "critical",
        correlationId: "org-1:m10.hope.sfv_overdue:sfv-1:overdue",
        payload: {
          patientId: "patient-1",
          admissionId: "admission-1",
          workflowType: "04_sfv",
          workflowItemId: "sfv-1",
          triggeringAssessmentId: "assessment-1",
          attentionState: "overdue",
          deadline: "2026-06-12T23:59:59.999Z",
          actionTarget: "/admissions/admission-1/hope/sfv/sfv-1",
        },
      },
    ]);
  });
});

describe("M10 fixed timepoint watchdog alerts", () => {
  it("plans M36 window-expired emissions without changing the fixed workflow status vocabulary", () => {
    const schedules = [
      {
        scheduleId: "schedule-1",
        patientId: "patient-1",
        admissionId: "admission-1",
        rfaKind: "02_huv1" as const,
        status: "open" as const,
        windowOpensAt: "2026-06-01T00:00:00.000Z",
        windowClosesAt: "2026-06-10T23:59:59.999Z",
        lateDeadlineAt: "2026-06-17T23:59:59.999Z",
      },
    ];
    const plan = planHopeWindowWatchdog(schedules, "2026-06-18T00:00:00.000Z");

    expect(plan.events).toEqual([
      {
        eventName: "m10.hope.timepoint_expired",
        payload: {
          scheduleId: "schedule-1",
          rfaKind: "02_huv1",
          expiredAt: "2026-06-18T00:00:00.000Z",
        },
      },
    ]);
    expect(
      planM10AlertEmissions({
        organizationId: "org-1",
        schedules,
        sfvs: [],
        events: plan.events,
      })[0],
    ).toMatchObject({
      eventType: "m10.hope.timepoint_expired",
      severity: "critical",
      correlationId: "org-1:m10.hope.timepoint_expired:schedule-1:window_expired",
      payload: {
        patientId: "patient-1",
        admissionId: "admission-1",
        workflowType: "02_huv1",
        workflowItemId: "schedule-1",
        attentionState: "window_expired",
        deadline: "2026-06-17T23:59:59.999Z",
        actionTarget: "/admissions/admission-1/hope",
      },
    });
  });
});
