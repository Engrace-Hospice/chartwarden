import { describe, expect, it } from "vitest";

import {
  CENTRALIZED_TOP_N_MEDICATIONS,
  HIPAA_AGE_AGGREGATION_FLOOR,
  HYBRID_TOP_N_MEDICATIONS,
  type TriageVendorSourceContext,
  VENDOR_DENYLISTED_SOURCE_FIELDS,
  VendorPhiMinimizationError,
  assertVendorPayloadMinimized,
  findLeakedSourceValues,
  minimizeForVendor,
  toVendorAge,
} from "../src/minimization";

/** The §7.5 walkthrough's patient, with every denylisted field populated so a leak is detectable. */
const ctx: TriageVendorSourceContext = {
  patientId: "8f1b0f2e-4c2a-4a51-9f4d-1c0a2b3c4d5e",
  firstName: "Mary",
  lastName: "Chen",
  medicalRecordNumber: "MRN-40182",
  ageYears: 78,
  dateOfBirth: "1948-03-14",
  addressLine1: "1420 Alder Court",
  addressLine2: "Apt 3B",
  city: "Beaverton",
  postalCode: "97005",
  phoneE164: "+15035550142",
  caregiverName: "Denise Chen",
  caregiverPhoneE164: "+15035550188",
  codeStatusDnr: true,
  allergies: ["penicillin"],
  currentMedications: [
    "morphine sulfate ER",
    "sennosides",
    "lorazepam",
    "haloperidol",
    "oxygen 2L",
    "acetaminophen",
    "polyethylene glycol",
  ],
  primaryDiagnosisLabel: "Lung cancer, stage IV",
  primaryDiagnosisIcd10: "C34.90",
  levelOfCare: "routine_home_care",
  recentVitalsSummary: "HR 88, RR 22, SpO2 91% on 2L",
  activeProblemLabels: ["dyspnea", "cancer pain"],
  rawChartNotes: "Daughter Denise reports patient slept poorly; see 03/14 note.",
};

const REF = "call-scoped-opaque-ref";

describe("D13 §7.5 hybrid_phi_min projection", () => {
  const body = minimizeForVendor("hybrid_phi_min", ctx, REF);

  it("carries exactly the six permitted clinical facts and the opaque ref", () => {
    expect(body).toEqual({
      profile: "hybrid_phi_min",
      patientRef: REF,
      firstName: "Mary",
      age: { kind: "years", years: 78 },
      codeStatusDnr: true,
      allergies: ["penicillin"],
      currentMedications: [
        "morphine sulfate ER",
        "sennosides",
        "lorazepam",
        "haloperidol",
        "oxygen 2L",
      ],
      primaryDiagnosisLabel: "Lung cancer, stage IV",
      primaryDiagnosisIcd10: "C34.90",
    });
  });

  it("truncates the med list to the §7.5 top-5", () => {
    expect(body.currentMedications).toHaveLength(HYBRID_TOP_N_MEDICATIONS);
  });

  it("sends the OPAQUE ref, never the internal patient uuid", () => {
    expect(JSON.stringify(body)).not.toContain(ctx.patientId);
  });

  it("withholds the structured chart context centralized vendors get", () => {
    expect(body).not.toHaveProperty("levelOfCare");
    expect(body).not.toHaveProperty("recentVitalsSummary");
    expect(body).not.toHaveProperty("activeProblemLabels");
  });
});

describe("D13 centralized_phi_min projection", () => {
  const body = minimizeForVendor("centralized_phi_min", ctx, REF);

  it("adds the disposition-supporting chart fields on top of the hybrid set", () => {
    expect(body).toMatchObject({
      profile: "centralized_phi_min",
      levelOfCare: "routine_home_care",
      recentVitalsSummary: "HR 88, RR 22, SpO2 91% on 2L",
      activeProblemLabels: ["dyspnea", "cancer pain"],
    });
  });

  it("still withholds every denylisted identifier — 'more context' is not 'the chart'", () => {
    expect(findLeakedSourceValues(ctx, body)).toEqual([]);
    expect(body.currentMedications.length).toBeLessThanOrEqual(CENTRALIZED_TOP_N_MEDICATIONS);
  });
});

describe("§164.514(b)(2)(i)(C) age aggregation", () => {
  it("bands an age at or over 90 rather than transmitting the number", () => {
    expect(toVendorAge(HIPAA_AGE_AGGREGATION_FLOOR)).toEqual({ kind: "ninety_plus" });
    expect(toVendorAge(103)).toEqual({ kind: "ninety_plus" });
  });

  it("passes an under-90 age through as whole years", () => {
    expect(toVendorAge(89)).toEqual({ kind: "years", years: 89 });
    expect(toVendorAge(78.7)).toEqual({ kind: "years", years: 78 });
  });

  it("refuses an age it cannot represent rather than guessing", () => {
    const err = (() => {
      try {
        toVendorAge(-1);
        return null;
      } catch (e) {
        return e as VendorPhiMinimizationError;
      }
    })();
    expect(err).toBeInstanceOf(VendorPhiMinimizationError);
    expect(err?.code).toBe("VENDOR_PHI_MINIMIZATION_VIOLATION");
  });
});

describe("§7.10 runtime guard — the packet-capture assertion", () => {
  it("passes a body the minimizer built, under both profiles", () => {
    expect(() =>
      assertVendorPayloadMinimized(
        "hybrid_phi_min",
        ctx,
        minimizeForVendor("hybrid_phi_min", ctx, REF),
      ),
    ).not.toThrow();
    expect(() =>
      assertVendorPayloadMinimized(
        "centralized_phi_min",
        ctx,
        minimizeForVendor("centralized_phi_min", ctx, REF),
      ),
    ).not.toThrow();
  });

  it("catches a hand-rolled body that widened the projection with an extra key", () => {
    const smuggled = { ...minimizeForVendor("hybrid_phi_min", ctx, REF), lastName: ctx.lastName };
    const err = (() => {
      try {
        assertVendorPayloadMinimized("hybrid_phi_min", ctx, smuggled);
        return null;
      } catch (e) {
        return e as VendorPhiMinimizationError;
      }
    })();
    expect(err).toBeInstanceOf(VendorPhiMinimizationError);
    expect(err?.leakedFields).toContain("lastName");
  });

  it("catches a PERMITTED key stuffed with a denylisted value — the union cannot see this one", () => {
    const stuffed = {
      ...minimizeForVendor("hybrid_phi_min", ctx, REF),
      firstName: "Mary Chen, MRN-40182",
    };
    // The value is not character-identical to `lastName`, so the key scan is clean and only the
    // value scan can fire; it fires on the MRN, which IS embedded verbatim.
    expect(findLeakedSourceValues(ctx, stuffed)).toContain("medicalRecordNumber");
    expect(() => assertVendorPayloadMinimized("hybrid_phi_min", ctx, stuffed)).toThrow(
      VendorPhiMinimizationError,
    );
  });

  it("catches the hybrid profile being handed a centralized body", () => {
    const wrong = minimizeForVendor("centralized_phi_min", ctx, REF);
    expect(() => assertVendorPayloadMinimized("hybrid_phi_min", ctx, wrong)).toThrow(
      VendorPhiMinimizationError,
    );
  });
});

describe("§7.10 property sweep — no input combination leaks a denylisted field", () => {
  /** Deterministic pseudo-random so a failure is reproducible (and so the suite never flakes). */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  it("holds across 500 generated contexts under both profiles", () => {
    const rnd = lcg(20260731);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const words = ["Chen", "Mary", "40182", "Alder", "97005", "", "Denise", "note", "C34.90"];
    const maybe = (): string | null => (rnd() < 0.2 ? null : `${pick(words)}${pick(words)}`);

    for (let i = 0; i < 500; i++) {
      const generated: TriageVendorSourceContext = {
        // Namespaced so the generator cannot manufacture a false positive: `patientId: "-106"` with
        // `patientRef: "ref-106"` is a substring match the scan is right to flag and the sweep would
        // be wrong to call a leak.
        patientId: `pid_${i}_${pick(words)}`,
        // The adversarial cases are the ones where a denylisted value is ALSO a plausible
        // permitted one — a surname used as a first name, a diagnosis label containing a postcode.
        firstName: `${pick(words)}`,
        lastName: `${pick(words)}${i}`,
        medicalRecordNumber: maybe(),
        ageYears: Math.floor(rnd() * 110),
        dateOfBirth: maybe(),
        addressLine1: maybe(),
        addressLine2: maybe(),
        city: maybe(),
        postalCode: maybe(),
        phoneE164: maybe(),
        caregiverName: maybe(),
        caregiverPhoneE164: maybe(),
        codeStatusDnr: rnd() < 0.5,
        allergies: [pick(words), pick(words)],
        currentMedications: Array.from({ length: Math.floor(rnd() * 12) }, () => pick(words)),
        primaryDiagnosisLabel: `${pick(words)} ${pick(words)}`,
        primaryDiagnosisIcd10: maybe(),
        levelOfCare: maybe(),
        recentVitalsSummary: maybe(),
        activeProblemLabels: [pick(words)],
        rawChartNotes: maybe(),
      };

      for (const profile of ["hybrid_phi_min", "centralized_phi_min"] as const) {
        const body = minimizeForVendor(profile, generated, `ref-${i}`);
        expect(() => assertVendorPayloadMinimized(profile, generated, body)).not.toThrow();
      }
    }
  });

  it("names every field the §7.10 packet capture must find zero of", () => {
    expect(VENDOR_DENYLISTED_SOURCE_FIELDS).toEqual([
      "patientId",
      "lastName",
      "medicalRecordNumber",
      "dateOfBirth",
      "addressLine1",
      "addressLine2",
      "city",
      "postalCode",
      "phoneE164",
      "caregiverName",
      "caregiverPhoneE164",
      "rawChartNotes",
    ]);
  });
});
