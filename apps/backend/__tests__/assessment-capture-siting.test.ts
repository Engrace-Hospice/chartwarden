// apps/backend/__tests__/assessment-capture-siting.test.ts — the §3.3 capture-siting resolver M9's
// record/correct paths denormalize `provider_entity_id` through (capture-siting.ts). The resolution
// chain under test: the published M6 `AdmissionStatusReader` seam answers the capture's admission
// anchor → providerEntityId is taken (locationId stays null — no published seam carries a location);
// an org/patient mismatch, a seam that throws (deny-stub / M6 data-gap), or an unregistered seam all
// resolve to the UNSITED sentinel — never a fabricated siting, never a propagated error (recording
// must not be blocked by the denormalization).
import { afterEach, describe, expect, it } from "vitest";
import type { AdmissionSummary } from "@wardenx/types";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import {
  UNSITED_CAPTURE,
  createSeamAssessmentSitingResolver,
} from "../src/modules/09-assessments/capture-siting";

const ORG = "org-a";
const PATIENT = "pat-1";
const ADMISSION = "adm-1";
const PE = "pe-1";

function summary(over: Partial<AdmissionSummary> = {}): AdmissionSummary {
  return {
    admissionId: ADMISSION,
    patientId: PATIENT,
    organizationId: ORG,
    providerEntityId: PE,
    status: "active",
    admissionAt: "2026-01-05",
    activatedAt: "2026-01-05",
    dischargedAt: null,
    currentElectionPeriodId: null,
    currentLevelOfCare: "routine_home_care",
    ...over,
  } as AdmissionSummary;
}

describe("M9 capture-siting resolver (§3.3 — the M6 AdmissionStatusReader chain)", () => {
  afterEach(() => __resetSeamsForTest());

  it("resolves provider_entity_id from the admission summary; location_id stays null (no seam carries it)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async (id) => {
        expect(id).toBe(ADMISSION);
        return summary();
      },
    });
    const siting = await createSeamAssessmentSitingResolver().resolve(ORG, PATIENT, ADMISSION);
    expect(siting).toEqual({ providerEntityId: PE, locationId: null });
  });

  it("an admission belonging to another org never sites the row (UNSITED)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => summary({ organizationId: "org-b" } as never),
    });
    const siting = await createSeamAssessmentSitingResolver().resolve(ORG, PATIENT, ADMISSION);
    expect(siting).toEqual(UNSITED_CAPTURE);
  });

  it("an admission belonging to another patient never sites the row (UNSITED)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => summary({ patientId: "pat-other" } as never),
    });
    const siting = await createSeamAssessmentSitingResolver().resolve(ORG, PATIENT, ADMISSION);
    expect(siting).toEqual(UNSITED_CAPTURE);
  });

  it("a throwing seam (deny-stub / unknown admission / M6 data gap) degrades to UNSITED, never propagates", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        throw new Error("admission 'adm-1' not found");
      },
    });
    await expect(
      createSeamAssessmentSitingResolver().resolve(ORG, PATIENT, ADMISSION),
    ).resolves.toEqual(UNSITED_CAPTURE);
  });

  it("an unregistered seam (test/boot-less contexts) degrades to UNSITED, never propagates", async () => {
    await expect(
      createSeamAssessmentSitingResolver().resolve(ORG, PATIENT, ADMISSION),
    ).resolves.toEqual(UNSITED_CAPTURE);
  });
});
