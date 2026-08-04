// @wardenx/emar — §2.5/§2.7 D14 admission-discharge + patient-deceased cascade — M13-T05.
import { describe, expect, it } from "vitest";
import {
  type CascadeActiveDeployment,
  type CascadeScheduledDose,
  type DischargeCascadeInput,
  RETURN_OVERDUE_DAYS,
  evaluateReturnOverdue,
  planDischargeCascade,
} from "../src/cascade";

const DISCHARGE_AT = "2026-06-22T04:10:00.000Z"; // W-EMAR-09: patient passes at 0345; discharge recorded 0410

// 0800 already past at discharge (administered or sweep-owned); the q4h/q6h doses through the next day future.
const DOSES: CascadeScheduledDose[] = [
  {
    scheduledDoseId: "sd-past-administered",
    medicationOrderId: "ord-mor",
    dueAt: "2026-06-22T04:00:00.000Z",
    status: "administered",
  },
  {
    scheduledDoseId: "sd-past-pending",
    medicationOrderId: "ord-mor",
    dueAt: "2026-06-22T00:00:00.000Z",
    status: "pending",
  },
  {
    scheduledDoseId: "sd-fut-1",
    medicationOrderId: "ord-mor",
    dueAt: "2026-06-22T08:00:00.000Z",
    status: "pending",
  },
  {
    scheduledDoseId: "sd-fut-2",
    medicationOrderId: "ord-lor",
    dueAt: "2026-06-22T12:00:00.000Z",
    status: "pending",
  },
  {
    scheduledDoseId: "sd-fut-cancelled",
    medicationOrderId: "ord-mor",
    dueAt: "2026-06-22T16:00:00.000Z",
    status: "cancelled",
  },
];

const DEPLOYMENTS: CascadeActiveDeployment[] = [
  { deploymentId: "dep-active", disposalStatus: "deployed", returnRequiredAt: null },
  {
    deploymentId: "dep-already-required",
    disposalStatus: "return_required",
    returnRequiredAt: "2026-06-22T04:10:00.000Z",
  },
  {
    deploymentId: "dep-returned",
    disposalStatus: "returned",
    returnRequiredAt: "2026-06-10T00:00:00.000Z",
  },
];

const BASE: DischargeCascadeInput = {
  patientId: "pat-1",
  admissionId: "adm-1",
  dischargeAt: DISCHARGE_AT,
  sourceEventId: "evt-discharge-1",
  source: "admission_discharged",
  scheduledDoses: DOSES,
  activeDeployments: DEPLOYMENTS,
};

describe("§2.5/§2.7 D14 planDischargeCascade", () => {
  it("cancels only FUTURE pending scheduled doses; never touches past or non-pending doses", () => {
    const plan = planDischargeCascade(BASE);
    expect(plan.cancellations.map((c) => c.scheduledDoseId).sort()).toEqual([
      "sd-fut-1",
      "sd-fut-2",
    ]);
  });
  it("stamps the cancellation reason and source event id onto every cancellation", () => {
    const plan = planDischargeCascade(BASE);
    for (const c of plan.cancellations) {
      expect(c.cancellationReason).toBe("admission_discharged");
      expect(c.sourceEventId).toBe("evt-discharge-1");
    }
  });
  it("emits return-required only for still-deployed kits with no prior return signal", () => {
    const plan = planDischargeCascade(BASE);
    expect(plan.returnRequired).toHaveLength(1);
    expect(plan.returnRequired[0]).toEqual({
      deploymentId: "dep-active",
      patientId: "pat-1",
      admissionId: "adm-1",
      returnRequiredAt: DISCHARGE_AT,
    });
  });
  it("is idempotent: re-running over already-cancelled doses + already-required kits yields an empty plan", () => {
    const plan = planDischargeCascade({
      ...BASE,
      scheduledDoses: DOSES.map((d) =>
        d.status === "pending" ? { ...d, status: "cancelled" as const } : d,
      ),
      activeDeployments: [DEPLOYMENTS[1]!, DEPLOYMENTS[2]!],
    });
    expect(plan.cancellations).toHaveLength(0);
    expect(plan.returnRequired).toHaveLength(0);
  });
  it("the patient-deceased source routes through the same plan (death is a discharge reason)", () => {
    const plan = planDischargeCascade({ ...BASE, source: "patient_deceased" });
    expect(plan.cancellations).toHaveLength(2);
    expect(plan.returnRequired).toHaveLength(1);
  });
});

describe("§2.7 evaluateReturnOverdue", () => {
  const REQUIRED_AT = "2026-06-22T00:00:00.000Z";
  it("is not overdue before the 30-day window", () => {
    const r = evaluateReturnOverdue("dep-1", REQUIRED_AT, "2026-07-10T00:00:00.000Z"); // 18 days
    expect(r.overdue).toBe(false);
    expect(r.daysOverdue).toBe(18);
    expect(r.signal).toBeNull();
  });
  it("emits the return-overdue signal at exactly 30 days", () => {
    const r = evaluateReturnOverdue("dep-1", REQUIRED_AT, "2026-07-22T00:00:00.000Z");
    expect(r.daysOverdue).toBe(RETURN_OVERDUE_DAYS);
    expect(r.overdue).toBe(true);
    expect(r.signal).toEqual({ deploymentId: "dep-1", daysOverdue: 30 });
  });
});
