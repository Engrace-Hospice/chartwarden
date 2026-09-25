import { describe, expect, it } from "vitest";
import type {
  PatientCoverage,
  PatientHopeAdmissionPrefillFacts,
} from "@wardenx/types";
import {
  buildHopeAdmissionPrefillAnswers,
  isHopeCoverageInForceOn,
  mapHopeCoverageKind,
  mapHopeEthnicityCodes,
  mapHopePreferredLanguage,
  mapHopeRaceCodes,
  mapHopeResidenceSite,
  mapHopeSexAssignedAtBirth,
  shouldApplyHopeAdmissionPrefill,
} from "../src/modules/10-hope/hope-admission-prefill-service";

function patient(
  overrides: Partial<PatientHopeAdmissionPrefillFacts> = {},
): PatientHopeAdmissionPrefillFacts {
  return {
    patientId: "patient-1",
    organizationId: "org-1",
    legalFirstName: "Ada",
    legalMiddleName: "Marie",
    legalLastName: "Lovelace",
    legalNameSuffix: "Jr",
    dob: "1815-12-10",
    sexAssignedAtBirth: "F",
    raceCodes: ["2106-3"],
    ethnicityCodes: ["2186-5"],
    preferredLanguageCode: "en",
    identifiers: [],
    ...overrides,
  };
}

function coverage(overrides: Partial<PatientCoverage>): PatientCoverage {
  return {
    id: "coverage-1",
    patientId: "patient-1",
    payerId: "payer-1",
    rank: 1,
    coverageKind: "medicare_ffs",
    subscriberId: "1EG4TE5MK73",
    groupNumber: null,
    current: true,
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

function answerMap(
  facts: PatientHopeAdmissionPrefillFacts,
  coverages: readonly PatientCoverage[] = [],
) {
  return new Map(
    buildHopeAdmissionPrefillAnswers({
      patient: facts,
      admissionDate: "2025-10-01",
      postalCode: "02139",
      residenceSite: "01",
      coverages,
    }).map((answer) => [answer.itemCode, answer]),
  );
}

describe("HOPE Admission prefill mappings", () => {
  it("prefills A0220 from admissionAt plus legal name, DOB, ZIP, sex, language, and residence site", () => {
    const answers = answerMap(patient());

    expect(answers.get("A0220")).toMatchObject({
      value: "2025-10-01",
      source: "admission_prefill",
    });
    expect(answers.get("A0500A")).toMatchObject({
      value: "Ada",
      source: "patient_prefill",
    });
    expect(answers.get("A0500B")).toMatchObject({
      value: "M",
      source: "patient_prefill",
    });
    expect(answers.get("A0500C")).toMatchObject({
      value: "Lovelace",
      source: "patient_prefill",
    });
    expect(answers.get("A0500D")).toMatchObject({
      value: "Jr",
      source: "patient_prefill",
    });
    expect(answers.get("A0900")).toMatchObject({
      value: "1815-12-10",
      source: "patient_prefill",
    });
    expect(answers.get("A0550")).toMatchObject({
      value: "02139",
      source: "patient_prefill",
    });
    expect(answers.get("A0810")).toMatchObject({
      value: "2",
      source: "patient_prefill",
    });
    expect(answers.get("A1110A")).toMatchObject({
      value: "en",
      source: "patient_prefill",
    });
    expect(answers.get("A0215")).toMatchObject({
      value: "01",
      source: "patient_prefill",
    });
  });

  it("selects only an active MBI and never confuses it with MRN, SSN, or Medicaid identifiers", () => {
    const answers = answerMap(
      patient({
        identifiers: [
          {
            kind: "mrn",
            value: "MRN-1",
            effectiveFrom: "2020-01-01",
            effectiveTo: null,
          },
          {
            kind: "ssn",
            value: null,
            effectiveFrom: "2020-01-01",
            effectiveTo: null,
          },
          {
            kind: "hospice_external",
            value: "MEDICAID-1",
            effectiveFrom: "2020-01-01",
            effectiveTo: null,
          },
          {
            kind: "mbi",
            value: "OLDMBI",
            effectiveFrom: "2020-01-01",
            effectiveTo: "2025-09-30",
          },
          {
            kind: "mbi",
            value: "1EG4TE5MK73",
            effectiveFrom: "2025-10-01",
            effectiveTo: null,
          },
        ],
      }),
    );

    expect(answers.get("A0600B")).toMatchObject({
      value: "1EG4TE5MK73",
      source: "patient_prefill",
    });
  });

  it("maps known race and ethnicity codes and leaves unknown values unanswered", () => {
    expect(mapHopeRaceCodes(["2106-3", "9999-9"])).toEqual({ A1010A: "1" });
    expect(mapHopeEthnicityCodes(["2186-5", "9999-9"])).toEqual({
      A1005A: "1",
    });
    expect(mapHopeRaceCodes(["not-known"])).toEqual({});
    expect(mapHopeEthnicityCodes(["not-known"])).toEqual({});
  });

  it("maps only deterministic sex, language, payer, and residence values", () => {
    expect(mapHopeSexAssignedAtBirth("M")).toBe("1");
    expect(mapHopeSexAssignedAtBirth("F")).toBe("2");
    expect(mapHopeSexAssignedAtBirth("U")).toBeNull();
    expect(mapHopePreferredLanguage(" es ")).toBe("es");
    expect(mapHopePreferredLanguage(" ")).toBeNull();
    expect(mapHopeCoverageKind("medicare_ffs")).toBe("A1400A");
    expect(mapHopeCoverageKind("medicare_advantage")).toBe("A1400B");
    expect(mapHopeCoverageKind("payer-display-name")).toBeNull();
    expect(mapHopeResidenceSite("home", null)).toBe("01");
    expect(mapHopeResidenceSite("facility", "facility-1")).toBeNull();
  });

  it("filters payer coverage by the admission effective date before building A1400 answers", () => {
    const inForce = [
      coverage({
        id: "old",
        coverageKind: "medicaid",
        effectiveFrom: "2024-01-01",
        effectiveTo: "2025-09-30",
      }),
      coverage({
        id: "current",
        coverageKind: "medicare_ffs",
        effectiveFrom: "2025-10-01",
        effectiveTo: null,
      }),
      coverage({
        id: "future",
        coverageKind: "commercial",
        effectiveFrom: "2025-10-02",
        effectiveTo: null,
      }),
    ].filter((row) => isHopeCoverageInForceOn(row, "2025-10-01"));
    const answers = answerMap(patient(), inForce);

    expect(answers.get("A1400A")).toMatchObject({
      value: "1",
      source: "patient_prefill",
    });
    expect(answers.has("A1400C")).toBe(false);
    expect(answers.has("A1400H")).toBe(false);
  });

  it("is a snapshot: later patient fact changes produce different candidates but do not imply live sync", () => {
    const initial = answerMap(patient({ legalLastName: "Lovelace" }));
    const later = answerMap(patient({ legalLastName: "Byron" }));

    expect(initial.get("A0500C")?.value).toBe("Lovelace");
    expect(later.get("A0500C")?.value).toBe("Byron");
  });

  it("does not overwrite clinician-entered user answers on a second prefill attempt", () => {
    expect(shouldApplyHopeAdmissionPrefill("user")).toBe(false);
    expect(shouldApplyHopeAdmissionPrefill("patient_prefill")).toBe(true);
    expect(shouldApplyHopeAdmissionPrefill("admission_prefill")).toBe(true);
    expect(shouldApplyHopeAdmissionPrefill(null)).toBe(true);
  });

  it("does not prefill Section F or diagnosis-category Section I answers from unrelated structured facts", () => {
    const answers = answerMap(patient(), [coverage({})]);

    expect(
      [...answers.keys()].filter((itemCode) => itemCode.startsWith("F")),
    ).toEqual([]);
    expect(
      [...answers.keys()].filter((itemCode) => itemCode.startsWith("I")),
    ).toEqual([]);
  });

  it("prefills only the Medicare number for a Medicare-only patient", () => {
    const answers = answerMap(
      patient({
        identifiers: [
          {
            kind: "mbi",
            value: "1EG4TE5MK73",
            effectiveFrom: "2025-01-01",
            effectiveTo: null,
          },
        ],
      }),
      [
        coverage({
          coverageKind: "medicare_ffs",
          subscriberId: "1EG4TE5MK73",
        }),
      ],
    );

    expect(answers.get("A0600B")).toMatchObject({
      value: "1EG4TE5MK73",
    });

    expect(answers.has("A0700")).toBe(false);
  });

  it("prefills only the Medicaid number for a Medicaid-only patient", () => {
    const answers = answerMap(patient(), [
      coverage({
        coverageKind: "medicaid",
        subscriberId: "MDCD123456",
      }),
    ]);

    expect(answers.has("A0600B")).toBe(false);

    expect(answers.get("A0700")).toMatchObject({
      value: "MDCD123456",
    });
  });

  it("prefills both Medicare and Medicaid numbers for dual coverage", () => {
    const answers = answerMap(
      patient({
        identifiers: [
          {
            kind: "mbi",
            value: "1EG4TE5MK73",
            effectiveFrom: "2025-01-01",
            effectiveTo: null,
          },
        ],
      }),
      [
        coverage({
          id: "medicare",
          coverageKind: "medicare_ffs",
          subscriberId: "1EG4TE5MK73",
          rank: 1,
        }),
        coverage({
          id: "medicaid",
          coverageKind: "medicaid",
          subscriberId: "MDCD123456",
          rank: 2,
        }),
      ],
    );

    expect(answers.get("A0600B")?.value).toBe("1EG4TE5MK73");
    expect(answers.get("A0700")?.value).toBe("MDCD123456");
  });
});
