import type { MedicationOrderDto, RefillRequestDto } from "@wardenx/types";
// apps/backend/__tests__/dosespot-seams.test.ts — M12-T07 (§2.10 D17 MedicationOrderProvider +
// RefillInboxProvider). Both seams are pure READ-only orchestration over an injected DoseSpotSeamStore; these
// cover the medication-order read narrowing (active / since / by-admission / by-id), the M13 administration-
// context gate (active ⇒ allowed; discontinued / replaced / expired / nack ⇒ blocked), the derived signals
// (controlled-substance flag, comfort-kit timeline, cost-basis rollup), the M31 portal projection with the §7.8
// SUD redaction, the M28 FHIR status mapping, and the refill-inbox pending narrowing — plus the boot wiring
// (registerDoseSpotSeams replaces the deny-stubs; validateSeams passes; the deny-stubs deny).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  DoseSpotSeamGapError,
  type DoseSpotSeamSeed,
  costBasisOfLines,
  createInMemoryDoseSpotSeamStore,
  createMedicationOrderProvider,
  createRefillInboxProvider,
  registerDoseSpotSeams,
} from "../src/modules/12-dosespot/index";

const ORG = "org-1";
const PAT = "pat-1";
const ADM = "adm-1";

function medOrder(over: Partial<MedicationOrderDto>): MedicationOrderDto {
  return {
    id: "med-1",
    organizationId: ORG,
    patientId: PAT,
    admissionId: ADM,
    medClass: "standard",
    status: "active",
    rxnormRxcui: "1049502",
    ndc: "00093-0058-01",
    drugName: "Morphine Sulfate",
    strength: "20 mg/mL",
    doseForm: "oral solution",
    route: "oral",
    sigStructured: {
      doseQuantity: 0.5,
      doseUnit: "mL",
      route: "by mouth",
      frequencyCode: "every 4 hours",
      asNeeded: false,
    },
    prescriberMembershipId: "mem-md",
    prescribingPhysicianMdmId: "phys-1",
    dispensingPharmacyMdmId: "pharm-1",
    refillsRemaining: 0,
    signedAt: "2026-03-01T12:00:00.000Z",
    transmittedAt: "2026-03-01T12:05:00.000Z",
    activatedAt: "2026-03-01T12:10:00.000Z",
    discontinuedAt: null,
    isControlledSubstance: false,
    deaSchedule: null,
    isSudTreatment: false,
    derivedFromRefillId: null,
    derivedFromHistoryId: null,
    replacesMedicationOrderId: null,
    documentId: null,
    ...over,
  };
}

function refill(over: Partial<RefillRequestDto>): RefillRequestDto {
  return {
    id: "rf-1",
    organizationId: ORG,
    patientId: PAT,
    sourceMedicationOrderId: "med-1",
    status: "pending",
    requestedAt: "2026-03-04T08:00:00.000Z",
    requestedQuantity: 30,
    prescriberMembershipId: "mem-md",
    resultingMedicationOrderId: null,
    ...over,
  };
}

function seed(): DoseSpotSeamSeed {
  return {
    medicationOrders: [
      medOrder({ id: "med-active", status: "active", activatedAt: "2026-03-01T12:10:00.000Z" }),
      medOrder({
        id: "med-dc",
        status: "discontinued",
        discontinuedAt: "2026-03-06T00:00:00.000Z",
      }),
      medOrder({
        id: "med-sud",
        status: "active",
        isSudTreatment: true,
        drugName: "Buprenorphine",
      }),
      medOrder({
        id: "med-cs",
        status: "active",
        medClass: "controlled_substance",
        isControlledSubstance: true,
        deaSchedule: "II",
      }),
      // a replacement chain: med-new replaces med-old (med-old stays status=active but is superseded).
      medOrder({ id: "med-old", status: "active", activatedAt: "2026-02-20T00:00:00.000Z" }),
      medOrder({
        id: "med-new",
        status: "active",
        replacesMedicationOrderId: "med-old",
        activatedAt: "2026-03-09T00:00:00.000Z",
      }),
      // a different patient/admission, to prove filtering:
      medOrder({ id: "med-other", patientId: "pat-2", admissionId: "adm-2", status: "active" }),
    ],
    refillRequests: [
      refill({ id: "rf-pending", status: "pending" }),
      refill({ id: "rf-approved", status: "approved", resultingMedicationOrderId: "med-new" }),
      refill({
        id: "rf-other",
        patientId: "pat-2",
        prescriberMembershipId: "mem-md2",
        status: "pending",
      }),
    ],
    comfortKitTimelines: [
      {
        admissionId: ADM,
        deployedAt: "2026-03-02T00:00:00.000Z",
        firstAdministrationAt: "2026-03-02T06:00:00.000Z",
      },
    ],
    costBasis: [
      {
        admissionId: ADM,
        monthIso: "2026-03-01T00:00:00.000Z",
        totalCostCents: 42050,
        lineCount: 7,
      },
    ],
  };
}

describe("MedicationOrderProvider (§2.10 D17)", () => {
  const provider = () =>
    createMedicationOrderProvider(createInMemoryDoseSpotSeamStore(seed()).store);

  it("getActiveMedications returns only active orders for the patient", async () => {
    const out = await provider().getActiveMedications(ORG, PAT);
    expect(out.map((m) => m.id).sort()).toEqual([
      "med-active",
      "med-cs",
      "med-new",
      "med-old",
      "med-sud",
    ]);
    expect(out.some((m) => m.id === "med-dc")).toBe(false);
    expect(out.some((m) => m.patientId === "pat-2")).toBe(false);
  });

  it("getMedicationsSince returns orders anchored on/after the cutoff ascending", async () => {
    const out = await provider().getMedicationsSince(ORG, PAT, "2026-03-05T00:00:00.000Z");
    expect(out.map((m) => m.id)).toEqual(["med-new"]); // med-old anchored 2026-02-20 is excluded
  });

  it("getMedicationOrder / listForAdmission resolve + narrow by status", async () => {
    expect((await provider().getMedicationOrder(ORG, "med-active"))?.id).toBe("med-active");
    expect(await provider().getMedicationOrder(ORG, "missing")).toBeNull();
    const dc = await provider().listForAdmission(ORG, ADM, ["discontinued"]);
    expect(dc.map((m) => m.id)).toEqual(["med-dc"]);
    const all = await provider().listForAdmission(ORG, ADM);
    expect(all.every((m) => m.admissionId === ADM)).toBe(true);
  });

  it("getAdministrationContext allows an active order and blocks discontinued / replaced / unsigned", async () => {
    expect(
      (await provider().getAdministrationContext(ORG, "med-active"))?.allowAdministration,
    ).toBe(true);
    const dc = await provider().getAdministrationContext(ORG, "med-dc");
    expect(dc?.allowAdministration).toBe(false);
    expect(dc?.blockedReasons).toEqual(["discontinued"]);
    // med-old is itself status=active but superseded by med-new → blocked as 'replaced'.
    const old = await provider().getAdministrationContext(ORG, "med-old");
    expect(old?.allowAdministration).toBe(false);
    expect(old?.blockedReasons).toEqual(["replaced"]);
    expect(await provider().getAdministrationContext(ORG, "missing")).toBeNull();
  });

  it("getControlledSubstanceFlag reads the DEA schedule", async () => {
    expect(await provider().getControlledSubstanceFlag(ORG, "med-cs")).toEqual({
      isControlled: true,
      schedule: "II",
    });
    expect(await provider().getControlledSubstanceFlag(ORG, "med-active")).toEqual({
      isControlled: false,
      schedule: null,
    });
  });

  it("getComfortKitDeploymentTimeline + getCostBasisSummary read the derived rollups", async () => {
    expect(await provider().getComfortKitDeploymentTimeline(ORG, ADM)).toEqual({
      deployedAt: "2026-03-02T00:00:00.000Z",
      firstAdministrationAt: "2026-03-02T06:00:00.000Z",
    });
    expect(await provider().getComfortKitDeploymentTimeline(ORG, "adm-none")).toBeNull();
    expect(await provider().getCostBasisSummary(ORG, ADM, "2026-03-15T00:00:00.000Z")).toEqual({
      totalCostCents: 42050,
      lineCount: 7,
    });
    expect(await provider().getCostBasisSummary(ORG, ADM, "2026-04-01T00:00:00.000Z")).toEqual({
      totalCostCents: 0,
      lineCount: 0,
    });
  });

  it("getPortalMedicationSummary projects lay-language and redacts SUD-treatment meds (§7.8 / D7)", async () => {
    const { summary } = await provider().getPortalMedicationSummary(ORG, PAT);
    const sud = summary.find((s) => s.medicationOrderId === "med-sud");
    expect(sud).toEqual({
      medicationOrderId: "med-sud",
      displayName: "Confidential medication",
      instructions: "Details restricted",
      status: "active",
      isRedacted: true,
    });
    const plain = summary.find((s) => s.medicationOrderId === "med-active");
    expect(plain?.isRedacted).toBe(false);
    expect(plain?.displayName).toBe("Morphine Sulfate 20 mg/mL");
    expect(plain?.instructions).toBe("Take 0.5 mL by by mouth, every 4 hours");
  });

  it("asFhirMedicationRequest maps the lifecycle status onto the FHIR value set", async () => {
    expect((await provider().asFhirMedicationRequest(ORG, "med-active"))?.status).toBe("active");
    expect((await provider().asFhirMedicationRequest(ORG, "med-dc"))?.status).toBe("stopped");
    expect(await provider().asFhirMedicationRequest(ORG, "missing")).toBeNull();
  });
});

describe("costBasisOfLines (drug-cost rollup honesty kernel, mig 0158)", () => {
  const priced = (acquisitionCostCents: number | null) => ({ acquisitionCostCents });

  it("all lines priced → the correct cent sum and lineCount = priced lines", () => {
    expect(costBasisOfLines([priced(1250), priced(0), priced(99_999)], ADM, "2026-03")).toEqual({
      totalCostCents: 101_249,
      lineCount: 3,
    });
  });

  it("an explicit 0-cent line is a real price (free/rebated), never a refusal", () => {
    expect(costBasisOfLines([priced(0), priced(0)], ADM, "2026-03")).toEqual({
      totalCostCents: 0,
      lineCount: 2,
    });
  });

  it("ANY unpriced (NULL) line → the typed DoseSpotSeamGapError naming the counts, never a $0 fill", () => {
    let thrown: unknown;
    try {
      costBasisOfLines([priced(1250), priced(null), priced(null), priced(400)], ADM, "2026-03");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DoseSpotSeamGapError);
    const gap = thrown as DoseSpotSeamGapError;
    expect(gap.code).toBe("M12_SEAM_SCHEMA_GAP");
    expect(gap.method).toBe("costBasisForAdmissionMonth");
    expect(gap.message).toContain("2 of 4");
    expect(gap.message).toContain(ADM);
    expect(gap.message).toContain("2026-03");
  });

  it("an admission-month with zero lines is a REAL { 0, 0 } (port contract: empty, not fabricated)", () => {
    expect(costBasisOfLines([], ADM, "2026-04")).toEqual({ totalCostCents: 0, lineCount: 0 });
  });
});

describe("RefillInboxProvider (§2.10 D17)", () => {
  const provider = () => createRefillInboxProvider(createInMemoryDoseSpotSeamStore(seed()).store);

  it("getPendingRefillsForPrescriber returns only this prescriber's pending requests", async () => {
    const out = await provider().getPendingRefillsForPrescriber(ORG, "mem-md");
    expect(out.map((r) => r.id)).toEqual(["rf-pending"]); // rf-approved excluded; rf-other is a different prescriber
  });

  it("getPendingRefillsForPatient returns only pending requests for the patient", async () => {
    const out = await provider().getPendingRefillsForPatient(ORG, PAT);
    expect(out.map((r) => r.id)).toEqual(["rf-pending"]);
  });

  it("getRefillRequestById resolves any status; null when absent", async () => {
    expect((await provider().getRefillRequestById(ORG, "rf-approved"))?.status).toBe("approved");
    expect(await provider().getRefillRequestById(ORG, "missing")).toBeNull();
  });
});

describe("boot wiring (registerDoseSpotSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers both seams so validateSeams passes and they resolve as real impls", async () => {
    registerDoseSpotSeams({ store: createInMemoryDoseSpotSeamStore(seed()).store });
    expect(() => validateSeams()).not.toThrow();
    expect((await getSeam("MedicationOrderProvider").getActiveMedications(ORG, PAT)).length).toBe(
      5,
    );
    expect(
      (await getSeam("RefillInboxProvider").getPendingRefillsForPatient(ORG, PAT)).map((r) => r.id),
    ).toEqual(["rf-pending"]);
  });

  it("falls back to fail-closed deny-stubs when M12 does not register", () => {
    validateSeams();
    expect(() => getSeam("MedicationOrderProvider").getActiveMedications(ORG, PAT)).toThrow(
      /not implemented/,
    );
    expect(() => getSeam("RefillInboxProvider").getRefillRequestById(ORG, "rf-1")).toThrow(
      /not implemented/,
    );
  });
});
