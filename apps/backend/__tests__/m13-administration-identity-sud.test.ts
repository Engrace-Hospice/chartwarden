// GAP-036 follow-up — M13 snapshots M12's `isSudTreatment` onto every administration row. M12 now writes the
// flag (it never did before), and M13's portal redaction + the M28 FHIR Part 2 gate read M13's OWN copy, which
// was never written either. The adapter that turns M12's administration context into the identity M13 files an
// administration under must carry the flag, and must fail closed (an order that does not say is not "non-SUD").
import type { MedicationOrderDto } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { toAdministrationIdentity } from "../src/modules/13-emar/administration-identity";

const baseOrder = {
  patientId: "pat-1",
  admissionId: "adm-1",
  drugName: "Methadone",
  route: "oral",
  medClass: "controlled_substance" as const,
  isControlledSubstance: true,
  sigStructured: { ivContinuousPolicy: null },
};

const asOrder = (o: object) => o as unknown as MedicationOrderDto;

describe("toAdministrationIdentity", () => {
  it("carries an SUD-treatment order's flag through (true)", () => {
    const identity = toAdministrationIdentity({
      order: asOrder({ ...baseOrder, isSudTreatment: true }),
      allowAdministration: true,
      blockedReasons: [],
    });
    expect(identity.isSudTreatment).toBe(true);
    expect(identity.drugName).toBe("Methadone");
  });

  it("carries a non-SUD order's flag through (false)", () => {
    const identity = toAdministrationIdentity({
      order: asOrder({ ...baseOrder, drugName: "Morphine", isSudTreatment: false }),
      allowAdministration: true,
      blockedReasons: [],
    });
    expect(identity.isSudTreatment).toBe(false);
  });

  it("fails closed: an order that does not state the flag is treated as SUD (redact), never as non-SUD", () => {
    const identity = toAdministrationIdentity({
      order: asOrder(baseOrder),
      allowAdministration: true,
      blockedReasons: [],
    });
    expect(identity.isSudTreatment).toBe(true);
  });

  it("maps the IV titration policy and the administrability verdict", () => {
    const identity = toAdministrationIdentity({
      order: asOrder({
        ...baseOrder,
        isSudTreatment: false,
        sigStructured: { ivContinuousPolicy: { minRate: 1, maxRate: 4, extra: "x" } },
      }),
      allowAdministration: false,
      blockedReasons: ["not_active"],
    });
    expect(identity.ivContinuousPolicy).toEqual({ minRate: 1, maxRate: 4 });
    expect(identity.allowAdministration).toBe(false);
    expect(identity.blockedReasons).toEqual(["not_active"]);
  });
});

describe("toAdministrationIdentity — order facts for the safety gates (GAP-020/021)", () => {
  const withSig = (sigStructured: object) =>
    toAdministrationIdentity({
      order: asOrder({
        ...baseOrder,
        isSudTreatment: false,
        rxnormRxcui: "rx-1",
        ndc: "ndc-1",
        sigStructured,
      }),
      allowAdministration: true,
      blockedReasons: [],
    });

  it("projects the authorised dose, the drug identities and the PRN minimum interval", () => {
    const identity = withSig({ doseQuantity: 5, doseUnit: "mg", prnMinimumIntervalMinutes: 240 });
    expect(identity).toMatchObject({
      doseAmount: 5,
      doseUnit: "mg",
      rxnormRxcui: "rx-1",
      ndc: "ndc-1",
      prnMinimumIntervalMinutes: 240,
    });
  });

  it("treats a neutral-empty sig dose as UNKNOWN (null), never as zero", () => {
    const identity = withSig({ doseQuantity: 0, doseUnit: "" });
    expect(identity.doseAmount).toBeNull();
    expect(identity.doseUnit).toBeNull();
    expect(identity.prnMinimumIntervalMinutes).toBeNull();
  });

  it("carries no wristband material: the order identity holds no patient-identity secrets (GAP-020)", () => {
    expect(Object.keys(withSig({ doseQuantity: 5, doseUnit: "mg" })).join(" ")).not.toMatch(
      /wristband/i,
    );
  });
});
