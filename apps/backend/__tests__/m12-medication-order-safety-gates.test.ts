// GAP-036 — M12 requestSignature safety gates (SUD consent + allergy), proven without a database.
// The gates are pure over injected ports; the production backend binds them to the M39 ConsentEvaluator and
// M5 PatientAllergyReader seams and FAILS CLOSED on every uncertainty.
import { describe, expect, it, vi } from "vitest";
import { toPatientAllergyEntry } from "../src/modules/05-patient/allergy-reader";
import {
  allergyCheckPasses,
  drugConflictsWithAllergy,
  isSudTreatmentDrug,
  sudConsentSatisfied,
} from "../src/modules/12-dosespot/medication-order-safety-gates";

const ORG = "org-1";
const PAT = "pat-1";
const MEMBER = "mem-1";

const evaluator = (redact: boolean) => ({
  evaluateForInternalAccess: vi.fn(async () => ({
    redactSubstanceUseDisorderFields: redact,
    basis: redact ? ("no_active_release" as const) : ("release_covers_program" as const),
  })),
});

describe("isSudTreatmentDrug", () => {
  it.each([
    "Methadone",
    "buprenorphine/naloxone 8-2 mg",
    "NALTREXONE HCl",
    "Disulfiram",
    "acamprosate",
    "Lofexidine",
    "Varenicline",
  ])("recognises %s", (name) => expect(isSudTreatmentDrug(name)).toBe(true));
  it.each(["Morphine", "Lorazepam", "Haloperidol", ""])("does not flag %s", (name) =>
    expect(isSudTreatmentDrug(name)).toBe(false),
  );
});

describe("sudConsentSatisfied", () => {
  it("passes a non-SUD order without calling the evaluator", async () => {
    const ev = evaluator(true);
    const ok = await sudConsentSatisfied({
      isSudTreatment: false,
      organizationId: ORG,
      patientId: PAT,
      actorMembershipId: MEMBER,
      resolveEvaluator: () => ev,
    });
    expect(ok).toBe(true);
    expect(ev.evaluateForInternalAccess).not.toHaveBeenCalled();
  });

  it("denies a SUD order for a patient with no Part 2 release", async () => {
    const ev = evaluator(true);
    const ok = await sudConsentSatisfied({
      isSudTreatment: true,
      organizationId: ORG,
      patientId: PAT,
      actorMembershipId: MEMBER,
      resolveEvaluator: () => ev,
    });
    expect(ok).toBe(false);
  });

  it("passes a SUD order when M39 allows this actor, passing the SERVER-side membership", async () => {
    const ev = evaluator(false);
    const ok = await sudConsentSatisfied({
      isSudTreatment: true,
      organizationId: ORG,
      patientId: PAT,
      actorMembershipId: MEMBER,
      resolveEvaluator: () => ev,
    });
    expect(ok).toBe(true);
    expect(ev.evaluateForInternalAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        patientId: PAT,
        actor: { membershipId: MEMBER },
        callerModule: "m12",
      }),
    );
  });

  it("fails closed when the evaluator throws", async () => {
    const ok = await sudConsentSatisfied({
      isSudTreatment: true,
      organizationId: ORG,
      patientId: PAT,
      actorMembershipId: MEMBER,
      resolveEvaluator: () => ({
        evaluateForInternalAccess: async () => {
          throw new Error("M39 down");
        },
      }),
    });
    expect(ok).toBe(false);
  });

  it("fails closed when the seam cannot even be resolved", async () => {
    const ok = await sudConsentSatisfied({
      isSudTreatment: true,
      organizationId: ORG,
      patientId: PAT,
      actorMembershipId: MEMBER,
      resolveEvaluator: () => {
        throw new Error("ConsentEvaluator not implemented");
      },
    });
    expect(ok).toBe(false);
  });

  it("fails closed on a malformed verdict (flag not exactly false)", async () => {
    const ok = await sudConsentSatisfied({
      isSudTreatment: true,
      organizationId: ORG,
      patientId: PAT,
      actorMembershipId: MEMBER,
      resolveEvaluator: () => ({
        evaluateForInternalAccess: async () => ({}) as never,
      }),
    });
    expect(ok).toBe(false);
  });
});

describe("drugConflictsWithAllergy", () => {
  it("matches the same drug", () =>
    expect(drugConflictsWithAllergy("Morphine", "morphine")).toBe(true));
  it("matches through a salt/strength decoration", () =>
    expect(drugConflictsWithAllergy("Morphine Sulfate 20 mg/mL", "Morphine (hives)")).toBe(true));
  it("matches a free-text reaction line", () =>
    expect(drugConflictsWithAllergy("Penicillin V", "allergic to penicillin - rash")).toBe(true));
  it("does not match an unrelated drug", () =>
    expect(drugConflictsWithAllergy("Haloperidol", "morphine")).toBe(false));
  it("does not match on filler words only", () =>
    expect(drugConflictsWithAllergy("Morphine Sulfate", "sulfate allergy")).toBe(false));
  it("does not match NKDA", () => expect(drugConflictsWithAllergy("Morphine", "NKDA")).toBe(false));
});

describe("allergyCheckPasses", () => {
  const reader = (rows: unknown) => ({ activeAllergies: vi.fn(async () => rows as never) });
  const run = (r: ReturnType<typeof reader>, drugName = "Morphine") =>
    allergyCheckPasses({
      organizationId: ORG,
      patientId: PAT,
      drugName,
      resolveReader: () => r,
    });

  it("passes when the patient has no recorded allergy", async () => {
    expect(await run(reader([]))).toBe(true);
  });
  it("passes when no allergy matches the drug", async () => {
    expect(
      await run(
        reader([{ allergenText: "Penicillin", verificationStatus: "verified", severity: null }]),
      ),
    ).toBe(true);
  });
  it("blocks when a VERIFIED allergy matches", async () => {
    expect(
      await run(
        reader([{ allergenText: "Morphine", verificationStatus: "verified", severity: "severe" }]),
      ),
    ).toBe(false);
  });
  it("blocks when an UNVERIFIED allergy matches (hiding it is the unsafe failure)", async () => {
    expect(
      await run(
        reader([{ allergenText: "morphine", verificationStatus: "unverified", severity: null }]),
      ),
    ).toBe(false);
  });
  it("fails closed when the patient allergy data is unreadable (null)", async () => {
    expect(await run(reader(null))).toBe(false);
  });
  it("fails closed when the reader throws", async () => {
    const r = {
      activeAllergies: vi.fn(async () => {
        throw new Error("M5 down");
      }),
    };
    expect(await run(r as never)).toBe(false);
  });
  it("fails closed when the seam is unresolvable (deny-stub)", async () => {
    const ok = await allergyCheckPasses({
      organizationId: ORG,
      patientId: PAT,
      drugName: "Morphine",
      resolveReader: () => {
        throw new Error("PatientAllergyReader not implemented");
      },
    });
    expect(ok).toBe(false);
  });
  it("fails closed on a blank drug name (nothing to check against)", async () => {
    expect(await run(reader([]), "  ")).toBe(false);
  });
});

describe("toPatientAllergyEntry (M5 projection)", () => {
  it("drops entered_in_error rows", () =>
    expect(
      toPatientAllergyEntry({
        allergenText: "x",
        verificationStatus: "entered_in_error",
        severity: null,
      }),
    ).toBeNull());
  it("keeps an unverified row, projecting only text/status/severity", () =>
    expect(
      toPatientAllergyEntry({
        allergenText: "Latex",
        verificationStatus: "unverified",
        severity: "mild",
      }),
    ).toEqual({ allergenText: "Latex", verificationStatus: "unverified", severity: "mild" }));
});
