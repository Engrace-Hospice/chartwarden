import type { AdmissionSiting, AdmissionSummary } from "@wardenx/types";
// apps/backend/__tests__/assessment-capture-siting.test.ts — the §3.3 capture-siting resolver M9's
// record/correct paths denormalize `provider_entity_id` through (capture-siting.ts). The resolution
// chain under test: the published M6 `AdmissionStatusReader` seam answers the capture's admission
// anchor → providerEntityId is taken (locationId stays null — no published seam carries a location);
// an org/patient mismatch, a seam that throws (deny-stub / M6 data-gap), or an unregistered seam all
// resolve to the UNSITED sentinel — never a fabricated siting, never a propagated error (recording
// must not be blocked by the denormalization).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import {
  UNSITED_CAPTURE,
  createSeamAssessmentSitingResolver,
  sudRedactionRequiredViaSeam,
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

/** The same admission's `getAdmissionSiting` answer (as stored) — the resolver reads only the summary. */
function admissionSiting(over: Partial<AdmissionSiting> = {}): AdmissionSiting {
  return {
    admissionId: ADMISSION,
    organizationId: ORG,
    providerEntityId: PE,
    locationId: null,
    admissionAt: "2026-01-05T08:00:00.000Z",
    activatedAt: "2026-01-05T08:00:00.000Z",
    ...over,
  };
}

describe("M9 capture-siting resolver (§3.3 — the M6 AdmissionStatusReader chain)", () => {
  afterEach(() => __resetSeamsForTest());

  it("resolves provider_entity_id from the admission summary; location_id stays null (no seam carries it)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async (id) => {
        expect(id).toBe(ADMISSION);
        return summary();
      },
      getAdmissionSiting: async () => admissionSiting(),
      getAdmissionPatientCare: async () => null,
    });
    const siting = await createSeamAssessmentSitingResolver().resolve(ORG, PATIENT, ADMISSION);
    expect(siting).toEqual({ providerEntityId: PE, locationId: null });
  });

  it("an admission belonging to another org never sites the row (UNSITED)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => summary({ organizationId: "org-b" } as never),
      getAdmissionSiting: async () => admissionSiting({ organizationId: "org-b" }),
      getAdmissionPatientCare: async () => null,
    });
    const siting = await createSeamAssessmentSitingResolver().resolve(ORG, PATIENT, ADMISSION);
    expect(siting).toEqual(UNSITED_CAPTURE);
  });

  it("an admission belonging to another patient never sites the row (UNSITED)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => summary({ patientId: "pat-other" } as never),
      getAdmissionSiting: async () => admissionSiting(),
      getAdmissionPatientCare: async () => null,
    });
    const siting = await createSeamAssessmentSitingResolver().resolve(ORG, PATIENT, ADMISSION);
    expect(siting).toEqual(UNSITED_CAPTURE);
  });

  it("a throwing seam (deny-stub / unknown admission / M6 data gap) degrades to UNSITED, never propagates", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        throw new Error("admission 'adm-1' not found");
      },
      getAdmissionSiting: async () => null,
      getAdmissionPatientCare: async () => null,
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

// ── GAP-017 — the D10 / M09-F05 chart-read SUD disclosure gate ───────────────────────────────────
//
// The AIMS gate used to be a blanket `scaleType === "aims" && sudContext` with NO consent read of any
// kind, so an active 42 CFR Part 2 release the patient signed and the org recorded changed nothing and
// the row stayed hidden from every caller forever. These cases pin the seam glue: the decision comes
// from M39's `evaluateForIngressRedaction`, and every way of not getting an answer redacts.
describe("M9 SUD chart-read redaction (GAP-017 — the M39 ConsentEvaluator reach)", () => {
  afterEach(() => __resetSeamsForTest());

  it("un-redacts when M39 reports an active 42 CFR Part 2 release for the patient", async () => {
    registerSeam("ConsentEvaluator", {
      evaluateForIngressRedaction: async (args: { organizationId: string; patientId: string }) => {
        expect(args.organizationId).toBe(ORG);
        expect(args.patientId).toBe(PATIENT);
        return { redactSubstanceUseDisorderFields: false };
      },
    });
    await expect(sudRedactionRequiredViaSeam(ORG, PATIENT)).resolves.toBe(false);
  });

  it("redacts when no release is on file", async () => {
    registerSeam("ConsentEvaluator", {
      evaluateForIngressRedaction: async () => ({ redactSubstanceUseDisorderFields: true }),
    });
    await expect(sudRedactionRequiredViaSeam(ORG, PATIENT)).resolves.toBe(true);
  });

  it("names itself as the caller so M39's eval audit attributes the read to M9", async () => {
    let seen: string | undefined;
    registerSeam("ConsentEvaluator", {
      evaluateForIngressRedaction: async (args: { callerModule: string }) => {
        seen = args.callerModule;
        return { redactSubstanceUseDisorderFields: false };
      },
    });
    await sudRedactionRequiredViaSeam(ORG, PATIENT);
    expect(seen).toBe("m9");
  });

  it("a throwing evaluator redacts — an unanswerable disclosure gate never discloses", async () => {
    registerSeam("ConsentEvaluator", {
      evaluateForIngressRedaction: async () => {
        throw new Error("consent store unavailable");
      },
    });
    await expect(sudRedactionRequiredViaSeam(ORG, PATIENT)).resolves.toBe(true);
  });

  it("an unregistered seam redacts", async () => {
    await expect(sudRedactionRequiredViaSeam(ORG, PATIENT)).resolves.toBe(true);
  });
});

// ── #44 — a projection GAP must stay distinguishable from an absent admission ────────────────────
//
// Both used to arrive at the §10 gate as `anchor: null`, so a missing `provider_entity_id` was
// reported to the caller as "Patient's admission is not active" — for an admission whose status was
// verifiably `active`. That told a clinician something false about the chart and hid the real cause
// from whoever had to repair it. The siting half stays fail-OPEN either way; only the gate cares.
describe("#44 — projection gap vs absent admission", () => {
  afterEach(() => __resetSeamsForTest());

  function seamThrowing(error: unknown): void {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: () => Promise.reject(error),
    } as never);
  }

  /** The shape M6's store throws; matched structurally by `name` (M9 may not import M6 internals). */
  function dataGap(message: string): Error {
    const e = new Error(message);
    e.name = "AdmissionSeamDataGapError";
    return e;
  }

  it("surfaces the seam's own refusal message when it declines to project", async () => {
    seamThrowing(
      dataGap(
        "M6 seam projection gap: admission 'adm-1' is missing required fact(s): provider_entity_id",
      ),
    );
    const got = await createSeamAssessmentSitingResolver().resolveAnchor(ORG, PATIENT, ADMISSION);
    expect(got.anchor).toBeNull();
    expect(got.projectionGap).toContain("provider_entity_id");
  });

  it("reports NO gap when the admission is simply unknown", async () => {
    // An ordinary not-found throw is not a data gap: nothing is wrong with a record that is absent.
    seamThrowing(new Error("admission adm-1 not found"));
    const got = await createSeamAssessmentSitingResolver().resolveAnchor(ORG, PATIENT, ADMISSION);
    expect(got.anchor).toBeNull();
    expect(got.projectionGap).toBeUndefined();
  });

  it("reports NO gap for a cross-tenant admission", async () => {
    // The seam answered fine; the row just belongs to someone else. Reporting that as a gap would
    // leak that the admission exists at all (§6.6 existence-non-leak).
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: () => Promise.resolve(summary({ organizationId: "org-b" })),
    } as never);
    const got = await createSeamAssessmentSitingResolver().resolveAnchor(ORG, PATIENT, ADMISSION);
    expect(got.anchor).toBeNull();
    expect(got.projectionGap).toBeUndefined();
  });

  it("keeps the siting half fail-open on a gap — an unsited row is a reporting gap, not a block", async () => {
    seamThrowing(
      dataGap("M6 seam projection gap: admission 'adm-1' is missing required fact(s): x"),
    );
    const resolver = createSeamAssessmentSitingResolver();
    expect(await resolver.resolve(ORG, PATIENT, ADMISSION)).toEqual(UNSITED_CAPTURE);
  });

  it("carries no gap on the happy path", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: () => Promise.resolve(summary()),
    } as never);
    const got = await createSeamAssessmentSitingResolver().resolveAnchor(ORG, PATIENT, ADMISSION);
    expect(got.projectionGap).toBeUndefined();
    expect(got.anchor).toMatchObject({ status: "active" });
  });
});
