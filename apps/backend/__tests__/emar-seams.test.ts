import type { AdministrationDto, ReconciliationWorksheetDto } from "@chartwarden/types";
// apps/backend/__tests__/emar-seams.test.ts — M13-T07 (§2.12 D16 MedicationAdministrationProvider +
// ReconciliationProvider). Both seams are pure READ-only orchestration over an injected EmarSeamStore; these
// cover the administration read narrowing (by-id / by-patient / by-order / since / window), the M30 measure
// inputs (PRN-effectiveness rate, missed-dose rate with cancelled-dose exclusion, comfort-kit deployment
// interval), the M31 portal projection with the §7.8 / D12 SUD redaction + voided exclusion, the M28 FHIR status
// mapping, the M37 IV-continuous session projection, and the reconciliation read + 5-day-deadline timeliness —
// plus the boot wiring (registerEmarSeams replaces the deny-stubs; validateSeams passes; the deny-stubs deny).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  type EmarSeamSeed,
  createInMemoryEmarSeamStore,
  createMedicationAdministrationProvider,
  createReconciliationProvider,
  registerEmarSeams,
} from "../src/modules/13-emar/index";

const ORG = "org-1";
const PAT = "pat-1";
const ADM = "adm-1";

function admin(over: Partial<AdministrationDto>): AdministrationDto {
  return {
    id: "adm-rec-1",
    organizationId: ORG,
    patientId: PAT,
    admissionId: ADM,
    medicationOrderId: "med-1",
    scheduledDoseId: null,
    prnAdministrationId: null,
    encounterId: null,
    comfortKitDeploymentId: null,
    ivSessionId: null,
    mode: "single_dose",
    administeredAt: "2026-03-05T12:00:00.000Z",
    recordedAt: "2026-03-05T12:01:00.000Z",
    administeringClinicianMembershipId: "mem-rn",
    actorKind: "clinician",
    witnessMembershipId: null,
    status: "committed",
    lateEntryTier: "normal",
    requiresRnReview: false,
    data: {},
    drugNameSnapshot: "Morphine Sulfate",
    rxnormRxcuiSnapshot: "1049502",
    routeSnapshot: "oral",
    doseAmountSnapshot: 0.5,
    doseUnitSnapshot: "mL",
    isControlledSubstance: false,
    isSudTreatment: false,
    isComfortKitDrawdown: false,
    documentId: null,
    ...over,
  };
}

function worksheet(over: Partial<ReconciliationWorksheetDto>): ReconciliationWorksheetDto {
  return {
    id: "ws-1",
    organizationId: ORG,
    patientId: PAT,
    admissionId: ADM,
    triggerKind: "admission",
    triggeredAt: "2026-03-01T00:00:00.000Z",
    finalizedAt: null,
    finalizedByMembershipId: null,
    status: "pending",
    lineCount: 0,
    decisionCounts: {
      carry_forward: 0,
      discontinue: 0,
      hold: 0,
      new_order: 0,
      document_only: 0,
    },
    ...over,
  };
}

function seed(): EmarSeamSeed {
  return {
    administrations: [
      admin({ id: "rec-early", administeredAt: "2026-03-01T08:00:00.000Z" }),
      admin({ id: "rec-mid", administeredAt: "2026-03-05T12:00:00.000Z" }),
      admin({
        id: "rec-late",
        administeredAt: "2026-03-09T20:00:00.000Z",
        medicationOrderId: "med-2",
      }),
      admin({
        id: "rec-sud",
        administeredAt: "2026-03-06T10:00:00.000Z",
        isSudTreatment: true,
        drugNameSnapshot: "Buprenorphine",
      }),
      admin({ id: "rec-void", administeredAt: "2026-03-07T10:00:00.000Z", status: "voided" }),
      admin({
        id: "rec-iv-stop",
        administeredAt: "2026-03-08T10:00:00.000Z",
        mode: "iv_continuous_stop",
      }),
      admin({
        id: "rec-iv-start",
        administeredAt: "2026-03-08T06:00:00.000Z",
        mode: "iv_continuous_start",
      }),
      // a different patient, to prove filtering:
      admin({ id: "rec-other", patientId: "pat-2", administeredAt: "2026-03-05T12:00:00.000Z" }),
    ],
    prnEffectiveness: [
      { patientId: PAT, administeredAt: "2026-03-02T00:00:00.000Z", hasReassessment: true },
      { patientId: PAT, administeredAt: "2026-03-03T00:00:00.000Z", hasReassessment: false },
      { patientId: PAT, administeredAt: "2026-03-04T00:00:00.000Z", hasReassessment: true },
      // out of window:
      { patientId: PAT, administeredAt: "2026-02-01T00:00:00.000Z", hasReassessment: false },
    ],
    doseSchedule: [
      { patientId: PAT, dueAt: "2026-03-02T08:00:00.000Z", status: "administered" },
      { patientId: PAT, dueAt: "2026-03-02T12:00:00.000Z", status: "administered" },
      { patientId: PAT, dueAt: "2026-03-02T16:00:00.000Z", status: "missed" },
      { patientId: PAT, dueAt: "2026-03-02T20:00:00.000Z", status: "cancelled" }, // excluded from denominator
    ],
    comfortKitTimelines: [
      {
        admissionId: ADM,
        deployedAt: "2026-03-02T00:00:00.000Z",
        firstAdministrationAt: "2026-03-02T02:30:00.000Z",
      },
    ],
    ivSessions: [
      {
        sessionId: "iv-1",
        medicationOrderId: "med-iv",
        startedAt: "2026-03-08T06:00:00.000Z",
        endedAt: "2026-03-08T10:00:00.000Z",
        segments: [
          {
            kind: "iv_continuous_start",
            recordedAt: "2026-03-08T06:00:00.000Z",
            rate: 2,
            rateUnit: "mL/hr",
          },
          { kind: "iv_continuous_stop", recordedAt: "2026-03-08T10:00:00.000Z" },
        ],
        pumpVerifiedByMembershipId: null,
      },
    ],
    worksheets: [
      worksheet({
        id: "ws-final",
        status: "finalized",
        finalizedAt: "2026-03-03T00:00:00.000Z",
        finalizedByMembershipId: "mem-cm",
      }),
      worksheet({ id: "ws-other", admissionId: "adm-2", status: "pending" }),
    ],
    reconciliationTimeliness: [
      {
        admissionId: ADM,
        admissionAt: "2026-03-01T00:00:00.000Z",
        reconciliationFinalizedAt: "2026-03-03T00:00:00.000Z",
      },
      {
        admissionId: "adm-late",
        admissionAt: "2026-03-01T00:00:00.000Z",
        reconciliationFinalizedAt: "2026-03-08T00:00:00.000Z",
      },
      {
        admissionId: "adm-open",
        admissionAt: "2026-03-01T00:00:00.000Z",
        reconciliationFinalizedAt: null,
      },
    ],
  };
}

describe("MedicationAdministrationProvider (§2.12 D16)", () => {
  const provider = () =>
    createMedicationAdministrationProvider(createInMemoryEmarSeamStore(seed()).store);

  it("getAdministration resolves by id; null when absent", async () => {
    expect((await provider().getAdministration(ORG, "rec-mid"))?.id).toBe("rec-mid");
    expect(await provider().getAdministration(ORG, "missing")).toBeNull();
  });

  it("getAdministrationsForPatient narrows by window and sorts ascending", async () => {
    const all = await provider().getAdministrationsForPatient(ORG, PAT);
    expect(all.every((a) => a.patientId === PAT)).toBe(true);
    expect(all.map((a) => a.administeredAt)).toEqual([...all.map((a) => a.administeredAt)].sort());
    const win = await provider().getAdministrationsForPatient(ORG, PAT, {
      sinceIso: "2026-03-05T00:00:00.000Z",
      untilIso: "2026-03-08T07:00:00.000Z",
    });
    expect(win.map((a) => a.id)).toEqual(["rec-mid", "rec-sud", "rec-void", "rec-iv-start"]);
  });

  it("getAdministrationsForOrder filters by medication order", async () => {
    expect((await provider().getAdministrationsForOrder(ORG, "med-2")).map((a) => a.id)).toEqual([
      "rec-late",
    ]);
  });

  it("getAdministrationsSince returns on/after the cutoff ascending", async () => {
    const out = await provider().getAdministrationsSince(ORG, PAT, "2026-03-08T00:00:00.000Z");
    expect(out.map((a) => a.id)).toEqual(["rec-iv-start", "rec-iv-stop", "rec-late"]);
  });

  it("getPrnEffectivenessSummary counts in-window PRN admins + reassessment rate", async () => {
    const out = await provider().getPrnEffectivenessSummary(ORG, PAT, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });
    expect(out).toEqual({ prnCount: 3, prnWithReassessmentCount: 2, reassessmentRate: 2 / 3 });
  });

  it("getPrnEffectivenessCountsForOrg joins in-window obligations against the M9 coverage reader (aggregate only)", async () => {
    const store = createInMemoryEmarSeamStore({
      prnObligations: [
        {
          patientId: PAT,
          scaleType: "esas_r",
          administeredAt: "2026-03-02T08:00:00.000Z",
          reassessmentDueAt: "2026-03-02T09:00:00.000Z",
        },
        {
          patientId: PAT,
          scaleType: "painad",
          administeredAt: "2026-03-03T08:00:00.000Z",
          reassessmentDueAt: "2026-03-03T09:00:00.000Z",
        },
        {
          patientId: "pat-2",
          scaleType: "esas_r",
          administeredAt: "2026-03-04T08:00:00.000Z",
          reassessmentDueAt: "2026-03-04T09:00:00.000Z",
        },
        // due in April — outside the window, so it is NOT part of the denominator.
        {
          patientId: PAT,
          scaleType: "esas_r",
          administeredAt: "2026-04-02T08:00:00.000Z",
          reassessmentDueAt: "2026-04-02T09:00:00.000Z",
        },
      ],
    }).store;
    // The reader marks the two esas_r obligations covered, the painad one not.
    const covered = new Set(["esas_r|2026-03-02T09:00:00.000Z", "esas_r|2026-03-04T09:00:00.000Z"]);
    const provider = createMedicationAdministrationProvider(store, {
      reassessmentCoverage: {
        async wasReassessed(_patientId, scaleType, _from, to) {
          return covered.has(`${scaleType}|${to}`);
        },
      },
    });
    const counts = await provider.getPrnEffectivenessCountsForOrg(ORG, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-04-01T00:00:00.000Z",
    });
    // 3 obligations in window (the April one excluded); 2 covered.
    expect(counts).toEqual({ numerator: 2, denominator: 3 });
  });

  it("getPrnEffectivenessCountsForOrg SUPPRESSES (throws) when the M9 coverage reader is unbound", async () => {
    const store = createInMemoryEmarSeamStore({
      prnObligations: [
        {
          patientId: PAT,
          scaleType: "esas_r",
          administeredAt: "2026-03-02T08:00:00.000Z",
          reassessmentDueAt: "2026-03-02T09:00:00.000Z",
        },
      ],
    }).store;
    const provider = createMedicationAdministrationProvider(store); // no coverage reader bound
    await expect(
      provider.getPrnEffectivenessCountsForOrg(ORG, {
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-04-01T00:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("getMissedDoseSummary excludes cancelled doses from the denominator (D14)", async () => {
    const out = await provider().getMissedDoseSummary(ORG, PAT, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });
    expect(out).toEqual({
      scheduledCount: 3,
      administeredCount: 2,
      missedCount: 1,
      missedRate: 1 / 3,
    });
  });

  it("getComfortKitDeploymentTimeline derives the interval in minutes", async () => {
    expect(await provider().getComfortKitDeploymentTimeline(ORG, ADM)).toEqual({
      deployedAt: "2026-03-02T00:00:00.000Z",
      firstAdministrationAt: "2026-03-02T02:30:00.000Z",
      intervalMinutes: 150,
    });
    expect(await provider().getComfortKitDeploymentTimeline(ORG, "adm-none")).toBeNull();
  });

  it("getPortalAdministrationSummary redacts SUD meds and excludes voided rows (§7.8 / D12)", async () => {
    const { summary } = await provider().getPortalAdministrationSummary(
      ORG,
      PAT,
      "2026-03-31T00:00:00.000Z",
    );
    expect(summary.some((s) => s.administrationRecordId === "rec-void")).toBe(false);
    const sud = summary.find((s) => s.administrationRecordId === "rec-sud");
    expect(sud).toEqual({
      administrationRecordId: "rec-sud",
      displayName: "Confidential medication",
      administeredAt: "2026-03-06T10:00:00.000Z",
      mode: "single_dose",
      isRedacted: true,
    });
    const plain = summary.find((s) => s.administrationRecordId === "rec-mid");
    expect(plain?.isRedacted).toBe(false);
    expect(plain?.displayName).toBe("Morphine Sulfate");
  });

  it("getIvContinuousSession projects the segment sequence", async () => {
    const session = await provider().getIvContinuousSession(ORG, "iv-1");
    expect(session?.sessionId).toBe("iv-1");
    expect(session?.segments).toEqual([
      {
        kind: "iv_continuous_start",
        recordedAt: "2026-03-08T06:00:00.000Z",
        rate: 2,
        rateUnit: "mL/hr",
      },
      { kind: "iv_continuous_stop", recordedAt: "2026-03-08T10:00:00.000Z" },
    ]);
    expect(await provider().getIvContinuousSession(ORG, "missing")).toBeNull();
  });

  it("asFhirMedicationAdministration maps lifecycle/mode onto the FHIR value set", async () => {
    expect((await provider().asFhirMedicationAdministration(ORG, "rec-mid"))?.status).toBe(
      "completed",
    );
    expect((await provider().asFhirMedicationAdministration(ORG, "rec-void"))?.status).toBe(
      "entered-in-error",
    );
    expect((await provider().asFhirMedicationAdministration(ORG, "rec-iv-start"))?.status).toBe(
      "in-progress",
    );
    expect((await provider().asFhirMedicationAdministration(ORG, "rec-iv-stop"))?.status).toBe(
      "completed",
    );
    const single = await provider().asFhirMedicationAdministration(ORG, "rec-mid");
    expect(single?.effectiveDateTime).toBe("2026-03-05T12:00:00.000Z");
    const iv = await provider().asFhirMedicationAdministration(ORG, "rec-iv-start");
    expect(iv?.effectiveDateTime).toBeNull();
    expect(await provider().asFhirMedicationAdministration(ORG, "missing")).toBeNull();
  });
});

describe("ReconciliationProvider (§2.12 D16)", () => {
  const provider = () => createReconciliationProvider(createInMemoryEmarSeamStore(seed()).store);

  it("getWorksheet / getWorksheetsForAdmission resolve + filter", async () => {
    expect((await provider().getWorksheet(ORG, "ws-final"))?.status).toBe("finalized");
    expect(await provider().getWorksheet(ORG, "missing")).toBeNull();
    const forAdm = await provider().getWorksheetsForAdmission(ORG, ADM);
    expect(forAdm.every((w) => w.admissionId === ADM)).toBe(true);
    expect(forAdm.some((w) => w.id === "ws-other")).toBe(false);
  });

  it("getReconciliationTimelinessByAdmission derives interval + 5-day deadline", async () => {
    const met = await provider().getReconciliationTimelinessByAdmission(ORG, ADM);
    expect(met).toEqual({
      admissionAt: "2026-03-01T00:00:00.000Z",
      reconciliationFinalizedAt: "2026-03-03T00:00:00.000Z",
      intervalHours: 48,
      metFiveDayDeadline: true,
    });
    const late = await provider().getReconciliationTimelinessByAdmission(ORG, "adm-late");
    expect(late.intervalHours).toBe(168);
    expect(late.metFiveDayDeadline).toBe(false);
    const open = await provider().getReconciliationTimelinessByAdmission(ORG, "adm-open");
    expect(open.intervalHours).toBeNull();
    expect(open.metFiveDayDeadline).toBeNull();
    // No anchor → null-safe shape (prod always resolves the admission anchor via M6).
    const none = await provider().getReconciliationTimelinessByAdmission(ORG, "adm-unknown");
    expect(none).toEqual({
      admissionAt: "",
      reconciliationFinalizedAt: null,
      intervalHours: null,
      metFiveDayDeadline: null,
    });
  });
});

describe("boot wiring (registerEmarSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers both seams so validateSeams passes and they resolve as real impls", async () => {
    registerEmarSeams({ store: createInMemoryEmarSeamStore(seed()).store });
    expect(() => validateSeams()).not.toThrow();
    expect(
      (await getSeam("MedicationAdministrationProvider").getAdministration(ORG, "rec-mid"))?.id,
    ).toBe("rec-mid");
    expect((await getSeam("ReconciliationProvider").getWorksheet(ORG, "ws-final"))?.status).toBe(
      "finalized",
    );
  });

  it("falls back to fail-closed deny-stubs when M13 does not register", () => {
    validateSeams();
    expect(() =>
      getSeam("MedicationAdministrationProvider").getAdministration(ORG, "rec-1"),
    ).toThrow(/not implemented/);
    expect(() => getSeam("ReconciliationProvider").getWorksheet(ORG, "ws-1")).toThrow(
      /not implemented/,
    );
  });
});
