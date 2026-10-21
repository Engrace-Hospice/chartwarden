import type {
  AdmissionSummary,
  CertificationSummary,
  FaceToFaceSummary,
  LevelOfCarePeriodSummary,
} from "@chartwarden/types";
// apps/backend/__tests__/admission-seams.test.ts — M6-T05 (§4.7 reader seams). Each seam is pure
// orchestration over an injected AdmissionReaderStore; these cover the projection + the derived facts
// (active-period containment, LOC-day counting, signed/attested booleans, current-LOC selection) and
// the boot wiring (registerAdmissionSeams replaces the deny-stubs; validateSeams passes).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  AdmissionNotFoundError,
  type AdmissionReaderSeed,
  type ElectionPeriodRecord,
  createAdmissionCensusReader,
  createAdmissionStatusReader,
  createCertificationReader,
  createElectionPeriodReader,
  createFaceToFaceReader,
  createInMemoryAdmissionReaderStore,
  createLevelOfCareReader,
  registerAdmissionSeams,
} from "../src/modules/06-admission/index";

const ORG = "org-1";
const ADM = "adm-1";
const PAT = "pat-1";
const PERIOD = "ep-1";

const admission: AdmissionSummary = {
  admissionId: ADM,
  patientId: PAT,
  organizationId: ORG,
  providerEntityId: "prov-1",
  status: "active",
  admissionAt: "2026-01-01",
  activatedAt: "2026-01-01",
  dischargedAt: null,
  currentElectionPeriodId: PERIOD,
  currentLevelOfCare: "routine_home_care",
};

const period: ElectionPeriodRecord = {
  periodId: PERIOD,
  admissionId: ADM,
  patientId: PAT,
  sequence: 1,
  periodKind: "ninety_day",
  status: "active",
  levelOfCare: "routine_home_care",
  startDate: "2026-01-01",
  endDate: "2026-03-31",
  actualEndDate: null,
};

const locPeriods: readonly LevelOfCarePeriodSummary[] = [
  {
    levelOfCarePeriodId: "loc-1",
    admissionId: ADM,
    levelOfCare: "routine_home_care",
    status: "ended",
    effectiveAt: "2026-01-01",
    endedAt: "2026-01-10",
  },
  {
    levelOfCarePeriodId: "loc-2",
    admissionId: ADM,
    levelOfCare: "general_inpatient_care",
    status: "active",
    effectiveAt: "2026-01-11",
    endedAt: null,
  },
];

const seed: AdmissionReaderSeed = {
  admissions: [admission],
  electionPeriods: [period],
  levelOfCarePeriods: locPeriods,
};

function store(extra: Partial<AdmissionReaderSeed> = {}) {
  return createInMemoryAdmissionReaderStore({ ...seed, ...extra }).store;
}

describe("ElectionPeriodReader (§4.7)", () => {
  it("returns the active period containing the queried date", async () => {
    const reader = createElectionPeriodReader(store());
    const active = await reader.findActivePeriodForPatient(PAT, "2026-02-01");
    expect(active).toEqual({
      periodId: PERIOD,
      sequence: 1,
      levelOfCare: "routine_home_care",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    });
  });

  it("returns null when no period contains the date", async () => {
    const reader = createElectionPeriodReader(store());
    expect(await reader.findActivePeriodForPatient(PAT, "2025-12-31")).toBeNull();
  });

  it("respects actualEndDate when present (early-ended period)", async () => {
    const ended: ElectionPeriodRecord = { ...period, actualEndDate: "2026-01-15" };
    const reader = createElectionPeriodReader(store({ electionPeriods: [ended] }));
    expect(await reader.findActivePeriodForPatient(PAT, "2026-02-01")).toBeNull();
    expect(await reader.findActivePeriodForPatient(PAT, "2026-01-10")).not.toBeNull();
  });

  it("lists periods for an admission as wire DTOs (no patientId/levelOfCare leak)", async () => {
    const reader = createElectionPeriodReader(store());
    const list = await reader.listPeriodsForAdmission(ADM);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("patientId");
    expect(list[0]).not.toHaveProperty("levelOfCare");
    expect(list[0]?.periodId).toBe(PERIOD);
  });
});

describe("AdmissionStatusReader (§4.7)", () => {
  it("returns the summary for a known admission", async () => {
    const reader = createAdmissionStatusReader(store());
    expect(await reader.getAdmissionSummary(ORG, ADM)).toEqual(admission);
  });

  it("throws AdmissionNotFoundError for an admission outside the requested org", async () => {
    const reader = createAdmissionStatusReader(store());
    await expect(reader.getAdmissionSummary("org-2", ADM)).rejects.toBeInstanceOf(
      AdmissionNotFoundError,
    );
  });

  it("throws AdmissionNotFoundError for an unknown admission", async () => {
    const reader = createAdmissionStatusReader(store());
    await expect(reader.getAdmissionSummary(ORG, "nope")).rejects.toBeInstanceOf(
      AdmissionNotFoundError,
    );
  });
});

describe("LevelOfCareReader (§4.7)", () => {
  it("returns the OPEN level-of-care period as current", async () => {
    const reader = createLevelOfCareReader(store());
    const current = await reader.getCurrentLevelOfCare(ADM);
    expect(current?.levelOfCarePeriodId).toBe("loc-2");
    expect(current?.endedAt).toBeNull();
  });

  it("counts LOC-days inclusively per level, clipped to the range (M26 cap)", async () => {
    const reader = createLevelOfCareReader(store());
    // Range 2026-01-05..2026-01-15: RHC 01-05..01-10 = 6 days; GIP 01-11..01-15 = 5 days.
    const days = await reader.getLevelOfCareDays(ADM, { from: "2026-01-05", to: "2026-01-15" });
    expect(days.daysByLevel.routine_home_care).toBe(6);
    expect(days.daysByLevel.general_inpatient_care).toBe(5);
    expect(days.daysByLevel.continuous_home_care).toBe(0);
    expect(days.daysByLevel.inpatient_respite_care).toBe(0);
  });

  it("returns zero days when the range precedes all periods", async () => {
    const reader = createLevelOfCareReader(store());
    const days = await reader.getLevelOfCareDays(ADM, { from: "2025-01-01", to: "2025-12-31" });
    expect(Object.values(days.daysByLevel).every((d) => d === 0)).toBe(true);
  });
});

describe("CertificationReader (§4.7)", () => {
  const signed: CertificationSummary = {
    certificationId: "cti-1",
    electionPeriodId: PERIOD,
    status: "signed",
    hospiceMdSignedAt: "2026-01-02",
    signedLate: false,
    isRecert: false,
  };

  it("reports a signed period via the boolean shortcut", async () => {
    const reader = createCertificationReader(store({ certifications: [signed] }));
    expect(await reader.isCertificationSignedForPeriod(PERIOD)).toBe(true);
    expect((await reader.getActiveCertification(PERIOD))?.certificationId).toBe("cti-1");
  });

  it("is not signed when the active CTI is still drafted", async () => {
    const drafted: CertificationSummary = { ...signed, status: "drafted", hospiceMdSignedAt: null };
    const reader = createCertificationReader(store({ certifications: [drafted] }));
    expect(await reader.isCertificationSignedForPeriod(PERIOD)).toBe(false);
  });
});

describe("FaceToFaceReader (§4.7)", () => {
  const attested: FaceToFaceSummary = {
    faceToFaceEncounterId: "f2f-1",
    electionPeriodId: PERIOD,
    status: "attested",
    performerRole: "hospice_np",
    encounterDate: "2026-01-03",
    attestedAt: "2026-01-03",
    windowOverride: false,
  };

  it("returns only an ATTESTED F2F (a merely completed one does not satisfy the gate)", async () => {
    const completed: FaceToFaceSummary = { ...attested, status: "completed", attestedAt: null };
    const yes = createFaceToFaceReader(store({ faceToFace: [attested] }));
    const no = createFaceToFaceReader(store({ faceToFace: [completed] }));
    expect(await yes.isF2fAttestedForPeriod(PERIOD)).toBe(true);
    expect(await yes.getAttestedF2fForPeriod(PERIOD)).not.toBeNull();
    expect(await no.isF2fAttestedForPeriod(PERIOD)).toBe(false);
    expect(await no.getAttestedF2fForPeriod(PERIOD)).toBeNull();
  });
});

describe("AdmissionCensusReader (§4.7)", () => {
  it("lists active admissions in org scope, narrowing by providerEntityId", async () => {
    const reader = createAdmissionCensusReader(store());
    const all = await reader.listActiveAdmissions({ orgId: ORG });
    expect(all.map((a) => a.admissionId)).toEqual([ADM]);
    const narrowed = await reader.listActiveAdmissions({ orgId: ORG, providerEntityId: "other" });
    expect(narrowed).toHaveLength(0);
  });

  it("does not leak admissions from another org", async () => {
    const reader = createAdmissionCensusReader(store());
    expect(await reader.listActiveAdmissions({ orgId: "org-2" })).toHaveLength(0);
  });
});

describe("boot wiring (registerAdmissionSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers all six readers so validateSeams passes and they resolve as real impls", async () => {
    registerAdmissionSeams({ store: store() });
    expect(() => validateSeams()).not.toThrow();
    const status = getSeam("AdmissionStatusReader");
    expect((await status.getAdmissionSummary(ORG, ADM)).admissionId).toBe(ADM);
  });

  it("falls back to a fail-closed deny-stub when M6 does not register (default in-memory still works)", async () => {
    // Without registerAdmissionSeams, validateSeams applies the deny-stub: present but throws on call.
    validateSeams();
    const election = getSeam("ElectionPeriodReader");
    // The deny-stub throws SYNCHRONOUSLY on call (denies loudly), so assert a thrown error.
    expect(() => election.listPeriodsForAdmission(ADM)).toThrow(/not implemented/);
  });
});
