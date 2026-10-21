import { computeOpioidOnAdmissionRate } from "@chartwarden/quality";
// apps/backend/__tests__/m30-opioid-on-admission.test.ts — opioid_on_admission_rate's resolver.
//
// Mirrors the HVLDL/HCI-10 shape: M6's AdmissionOnsetReader supplies the LIST of admissions started in
// the window; this resolver loops it and calls M12's EXISTING per-admission `listForAdmission` read —
// no new M12 seam surface, no bulk cross-module join.
import { describe, expect, it } from "vitest";
import { resolveOpioidOnAdmissionInput } from "../src/modules/30-quality/jobs/m30-jobs";

const REQUEST = {
  registration: { code: "opioid_on_admission_rate" } as never,
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-04-01T00:00:00.000Z",
};

type Admission = { admissionId: string; admissionAt: string };
type Order = { activatedAt: string | null; drugName: string };

function seams(admissions: Admission[], ordersByAdmission: Record<string, Order[]>) {
  return {
    admissionOnsetReader: {
      async listAdmissionsStartedInPeriod() {
        return admissions;
      },
    },
    medicationOrders: {
      async listForAdmission(_org: string, admissionId: string) {
        return ordersByAdmission[admissionId] ?? [];
      },
    },
  };
}

describe("opioid_on_admission_rate resolver", () => {
  it("counts an admission with an opioid order activated within the admission med-rec window", async () => {
    const input = await resolveOpioidOnAdmissionInput(
      REQUEST,
      seams(
        [
          { admissionId: "adm-1", admissionAt: "2026-02-01T00:00:00.000Z" },
          { admissionId: "adm-2", admissionAt: "2026-02-05T00:00:00.000Z" },
        ],
        {
          "adm-1": [{ activatedAt: "2026-02-01T10:00:00.000Z", drugName: "Oxycodone 5mg" }],
          "adm-2": [{ activatedAt: "2026-02-05T04:00:00.000Z", drugName: "Amoxicillin 500mg" }],
        },
      ),
    );
    expect(input).toMatchObject({ admissions: 2, admissionsWithOpioid: 1 });
    expect(computeOpioidOnAdmissionRate(input as never).rate).toBeCloseTo(0.5);
  });

  it("excludes an opioid order activated OUTSIDE the 48h admission med-rec window", async () => {
    const input = await resolveOpioidOnAdmissionInput(
      REQUEST,
      seams([{ admissionId: "adm-1", admissionAt: "2026-02-01T00:00:00.000Z" }], {
        // Activated 3 days after admission — a later prescription, not part of the admission med rec.
        "adm-1": [{ activatedAt: "2026-02-04T00:00:00.000Z", drugName: "Morphine 15mg" }],
      }),
    );
    expect(input).toMatchObject({ admissions: 1, admissionsWithOpioid: 0 });
  });

  it("excludes an order that was never activated (a draft), even if the drug name matches", async () => {
    const input = await resolveOpioidOnAdmissionInput(
      REQUEST,
      seams([{ admissionId: "adm-1", admissionAt: "2026-02-01T00:00:00.000Z" }], {
        "adm-1": [{ activatedAt: null, drugName: "Hydrocodone 5mg" }],
      }),
    );
    expect(input).toMatchObject({ admissions: 1, admissionsWithOpioid: 0 });
  });

  it("a period with no admissions produces an honest 0/0 (the calculator suppresses it)", async () => {
    const input = await resolveOpioidOnAdmissionInput(REQUEST, seams([], {}));
    const result = computeOpioidOnAdmissionRate(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });
});
