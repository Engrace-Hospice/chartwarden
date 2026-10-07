/**
 * FY2027 hospice CoP — M6 face-to-face R-F2F-05 (telehealth modality, 42 CFR 418.22(a)(4)(ii)) and R-F2F-06
 * (signed clinical-note attestation, § 418.22(b)(4)). PURE unit tests over the validators and the F2F machine.
 * Source: docs/research/FY2027_HOSPICE_COP_RESEARCH.md §3.
 */
import { describe, expect, it } from "vitest";
import type { AdmissionStateError } from "../src/modules/06-admission/state-machines/errors";
import {
  type SignedNoteFacts,
  TELEHEALTH_F2F_ALLOWED_THROUGH,
  TELEHEALTH_F2F_EXCLUSIONS_FROM,
  type TelehealthEligibilityAttestation,
  checkF2fModality,
  checkF2fSignedNote,
} from "../src/modules/06-admission/state-machines/f2f-attestation-rules";
import { transitionFaceToFace } from "../src/modules/06-admission/state-machines/face-to-face";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as AdmissionStateError).code;
  }
  return undefined;
};

const ELIGIBLE: TelehealthEligibilityAttestation = {
  patientInMoratoriumArea: false,
  hospiceUnderEnhancedOversight: false,
  performerMedicareEnrolledOrOptedOut: true,
};

const modality = (
  encounterDate: string,
  telehealthEligibility: TelehealthEligibilityAttestation | null = ELIGIBLE,
  encounterLocation: "telehealth" | "patient_home" | null = "telehealth",
) => code(() => checkF2fModality({ encounterLocation, encounterDate, telehealthEligibility }));

describe("R-F2F-05 checkF2fModality — telehealth sunset and (A)-(C) exclusions", () => {
  it("pins the regulatory dates", () => {
    expect(TELEHEALTH_F2F_ALLOWED_THROUGH).toBe("2027-12-31");
    expect(TELEHEALTH_F2F_EXCLUSIONS_FROM).toBe("2026-01-31");
  });

  it("allows telehealth on 2027-12-31 and refuses it on 2028-01-01 (sunset boundary)", () => {
    expect(modality("2027-12-31")).toBeUndefined();
    expect(modality("2028-01-01")).toBe("F2F_TELEHEALTH_NOT_PERMITTED");
  });

  it("in-person and unrecorded locations are never restricted, even after the sunset", () => {
    expect(modality("2028-06-01", null, "patient_home")).toBeUndefined();
    expect(modality("2028-06-01", null, null)).toBeUndefined();
  });

  it("requires the attestation from 2026-01-31, not before (exclusions boundary)", () => {
    expect(modality("2026-01-30", null)).toBeUndefined();
    expect(modality("2026-01-31", null)).toBe("F2F_TELEHEALTH_ATTESTATION_REQUIRED");
  });

  it.each([
    ["(A) moratorium area", { ...ELIGIBLE, patientInMoratoriumArea: true }],
    ["(B) enhanced oversight", { ...ELIGIBLE, hospiceUnderEnhancedOversight: true }],
    [
      "(C) performer not enrolled / opted out",
      { ...ELIGIBLE, performerMedicareEnrolledOrOptedOut: false },
    ],
  ])("refuses telehealth when %s", (_label, eligibility) => {
    expect(modality("2026-10-15", eligibility)).toBe("F2F_TELEHEALTH_NOT_PERMITTED");
  });

  it("accepts an eligible telehealth encounter inside the window", () => {
    expect(modality("2026-10-15")).toBeUndefined();
  });

  it("is enforced by the F2F machine's recordCompletion", () => {
    const complete = (encounterDate: string, periodStart: string) =>
      code(() =>
        transitionFaceToFace("scheduled", {
          type: "recordCompletion",
          performerRole: "hospice_md",
          periodStart,
          encounterDate,
          hasOverride: false,
          encounterLocation: "telehealth",
          telehealthEligibility: ELIGIBLE,
        }),
      );
    expect(complete("2027-12-20", "2028-01-05")).toBeUndefined();
    expect(complete("2028-01-02", "2028-01-20")).toBe("F2F_TELEHEALTH_NOT_PERMITTED");
  });
});

const PERFORMER = "user-np-1";
const PATIENT = "patient-1";
const NOTE: SignedNoteFacts = {
  encounterId: "enc-1",
  patientId: PATIENT,
  serviceDate: "2026-09-20",
  signed: true,
  signedAt: "2026-09-20T18:00:00.000Z",
  signerUserId: PERFORMER,
};
const noteCheck = (note: SignedNoteFacts | null, encounterDate: string | null = "2026-09-20") =>
  code(() =>
    checkF2fSignedNote({ note, patientId: PATIENT, performerUserId: PERFORMER, encounterDate }),
  );

describe("R-F2F-06 checkF2fSignedNote — the § 418.22(b)(4) clinical-note attestation", () => {
  it("accepts a note signed by the performer on the encounter date for the same patient", () => {
    expect(noteCheck(NOTE)).toBeUndefined();
  });

  it.each([
    ["not found", null],
    ["unsigned", { ...NOTE, signed: false, signedAt: null }],
    ["signed flag with no signature date", { ...NOTE, signedAt: null }],
    ["signed by someone other than the performer", { ...NOTE, signerUserId: "user-rn-9" }],
    ["signer unresolved", { ...NOTE, signerUserId: null }],
    ["wrong visit date", { ...NOTE, serviceDate: "2026-09-21" }],
    ["another patient's note", { ...NOTE, patientId: "patient-2" }],
  ])("refuses a note that is %s", (_label, note) => {
    expect(noteCheck(note as SignedNoteFacts | null)).toBe("F2F_ATTESTATION_NOTE_INVALID");
  });

  it("refuses when the F2F has no recorded encounter date", () => {
    expect(noteCheck(NOTE, null)).toBe("F2F_ATTESTATION_NOTE_INVALID");
  });
});

describe("F2F attest — either the narrative or a linked signed note satisfies it", () => {
  const attest = (
    narrative: string | null,
    signedNote: Parameters<typeof checkF2fSignedNote>[0] | null,
  ) =>
    transitionFaceToFace("completed", {
      type: "attest",
      narrative,
      signedNote,
      performerIsActor: true,
    });

  it("a valid linked note attests with NO narrative", () => {
    const t = attest(null, {
      note: NOTE,
      patientId: PATIENT,
      performerUserId: PERFORMER,
      encounterDate: "2026-09-20",
    });
    expect(t.to).toBe("attested");
  });

  it("an invalid linked note refuses even with a long narrative alongside", () => {
    expect(
      code(() =>
        attest("x".repeat(200), {
          note: { ...NOTE, signerUserId: "someone-else" },
          patientId: PATIENT,
          performerUserId: PERFORMER,
          encounterDate: "2026-09-20",
        }),
      ),
    ).toBe("F2F_ATTESTATION_NOTE_INVALID");
  });

  it("the narrative path keeps its >= 100-character minimum", () => {
    expect(code(() => attest("too short", null))).toBe("F2F_ATTESTATION_TOO_SHORT");
    expect(code(() => attest(null, null))).toBe("F2F_ATTESTATION_TOO_SHORT");
    expect(attest("x".repeat(100), null).to).toBe("attested");
  });

  it("the attester must still be the performer on the note path", () => {
    expect(
      code(() =>
        transitionFaceToFace("completed", {
          type: "attest",
          narrative: null,
          signedNote: {
            note: NOTE,
            patientId: PATIENT,
            performerUserId: PERFORMER,
            encounterDate: "2026-09-20",
          },
          performerIsActor: false,
        }),
      ),
    ).toBe("F2F_INVALID_PERFORMER");
  });
});
