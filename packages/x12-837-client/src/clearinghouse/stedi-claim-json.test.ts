import { describe, expect, it } from "vitest";
import { Claim837iBuildError, build837iClaim } from "../claims/build-837i-claim";
import { CLAIM_INPUT, REPLACEMENT_INPUT, VOID_INPUT } from "../claims/claim-fixture-input";
import { compareStediClaimJsonToX12 } from "./stedi-claim-agreement";
import { type StediClaimJson, buildStediClaimJson } from "./stedi-claim-json";

const withClaim = (patch: object) => ({
  ...CLAIM_INPUT,
  claim: { ...CLAIM_INPUT.claim, ...patch },
});
const line = CLAIM_INPUT.claim.lines[0];

describe("buildStediClaimJson", () => {
  it("maps the sandbox claim onto Stedi's JSON shape", () => {
    const json = buildStediClaimJson(CLAIM_INPUT);
    expect(json).toMatchObject({
      tradingPartnerServiceId: "STEDI",
      usageIndicator: "T",
      submitter: { organizationName: "EXAMPLE HOSPICE OF OREGON", taxId: "931234567" },
      receiver: { organizationName: "STEDI TEST PAYER" },
      billing: {
        npi: "1234567893",
        employerId: "931234567",
        address: {
          address1: "100 MAIN ST",
          city: "PORTLAND",
          state: "OR",
          postalCode: "972011234",
        },
      },
      attending: { firstName: "ALAN", lastName: "SMITH", npi: "1245319599" },
      subscriber: {
        memberId: "1EG4TE5MK73",
        gender: "F",
        dateOfBirth: "19400315",
        paymentResponsibilityLevelCode: "P",
      },
    });
    expect(json.claimInformation).toMatchObject({
      claimFilingCode: "MA",
      claimChargeAmount: "1500.00",
      claimFrequencyCode: "3",
      placeOfServiceCode: "81",
      patientControlNumber: "WXHOSP0001",
      principalDiagnosis: { principalDiagnosisCode: "C3490", qualifierCode: "ABK" },
      claimCodeInformation: {
        admissionTypeCode: "1",
        admissionSourceCode: "1",
        patientStatusCode: "30",
      },
      claimDateInformation: {
        statementBeginDate: "20260101",
        statementEndDate: "20260131",
        admissionDateAndHour: "20260101",
      },
    });
    expect(json.claimInformation.serviceLines[1]).toEqual({
      serviceDate: "20260102",
      institutionalService: {
        serviceLineRevenueCode: "0652",
        procedureIdentifier: "HC",
        procedureCode: "Q5001",
        lineItemChargeAmount: "800.00",
        measurementUnit: "UN",
        serviceUnitCount: "32",
      },
    });
  });

  it("emits the HI lists as arrays of arrays, with amounts to two places, and omits empty lists", () => {
    const { claimInformation: c } = buildStediClaimJson(CLAIM_INPUT);
    expect(c.occurrenceInformationList).toEqual([
      [{ occurrenceSpanCode: "27", occurrenceSpanCodeDate: "20260101" }],
    ]);
    expect(c.valueInformationList).toEqual([
      [
        { valueCode: "61", valueCodeAmount: "38900.00" },
        { valueCode: "G8", valueCodeAmount: "38900.00" },
      ],
    ]);
    expect(c).not.toHaveProperty("conditionCodesList");
    expect(c).not.toHaveProperty("otherDiagnosisInformationList");
    expect(c).not.toHaveProperty("claimSupplementalInformation");
  });

  it("carries the payer claim control number, modifiers, discharge hour and extra codes", () => {
    const json = buildStediClaimJson({
      ...withClaim({
        frequency: "7",
        payerClaimControlNumber: "12345678901234",
        dischargeHour: "1430",
        patientStatus: "01",
        otherDiagnoses: ["I10", "E11.9"],
        conditionCodes: ["D0"],
        lines: [{ ...line, modifiers: ["PM"] }],
      }),
    } as never);
    const c = json.claimInformation;
    expect(c.claimSupplementalInformation).toEqual({ claimControlNumber: "12345678901234" });
    expect(c.claimDateInformation.dischargeHour).toBe("1430");
    expect(c.otherDiagnosisInformationList).toEqual([
      [
        { otherDiagnosisCode: "I10", qualifierCode: "ABF" },
        { otherDiagnosisCode: "E119", qualifierCode: "ABF" },
      ],
    ]);
    expect(c.conditionCodesList).toEqual([[{ conditionCode: "D0" }]]);
    expect(c.serviceLines[0]?.institutionalService.procedureModifiers).toEqual(["PM"]);
  });

  it("refuses anything the raw builder refuses, with the same field-only error", () => {
    expect(() => buildStediClaimJson(withClaim({ lines: [] }) as never)).toThrow(
      "invalid 837I claim input: claim.lines",
    );
  });

  it("refuses a patient control number over Stedi's 20-character limit", () => {
    expect(() =>
      buildStediClaimJson(withClaim({ controlNumber: "A".repeat(21) }) as never),
    ).toThrow(Claim837iBuildError);
    expect(() =>
      buildStediClaimJson(withClaim({ controlNumber: "A".repeat(20) }) as never),
    ).not.toThrow();
  });
});

describe("compareStediClaimJsonToX12 — raw and JSON agree", () => {
  it.each([
    ["claim", CLAIM_INPUT],
    ["replacement", REPLACEMENT_INPUT],
    ["void", VOID_INPUT],
    [
      "claim with every optional field",
      withClaim({
        frequency: "1",
        patientStatus: "40",
        dischargeHour: "0905",
        otherDiagnoses: ["I10", "E11.9"],
        conditionCodes: ["D0"],
        lines: [{ ...line, modifiers: ["PM", "GA"] }],
      }),
    ],
  ] as const)("finds no disagreement for the %s", (_n, input) => {
    expect(
      compareStediClaimJsonToX12(
        buildStediClaimJson(input as never),
        build837iClaim(input as never),
      ),
    ).toEqual([]);
  });

  // Each tamper must be caught by the field that guards it (mutation check on the comparator).
  const raw = build837iClaim(CLAIM_INPUT);
  const json = buildStediClaimJson(CLAIM_INPUT);
  const tamper = (fn: (j: StediClaimJson) => unknown): StediClaimJson => {
    const copy = structuredClone(json) as StediClaimJson;
    fn(copy);
    return copy;
  };
  const claim = (j: StediClaimJson) => j.claimInformation as unknown as Record<string, any>;

  it.each([
    [
      "claim.totalCharge",
      (j: StediClaimJson) => {
        claim(j).claimChargeAmount = "1500.01";
      },
    ],
    [
      "claim.frequency",
      (j: StediClaimJson) => {
        claim(j).claimFrequencyCode = "4";
      },
    ],
    [
      "claim.controlNumber",
      (j: StediClaimJson) => {
        claim(j).patientControlNumber = "OTHER";
      },
    ],
    [
      "claim.statementFromDate",
      (j: StediClaimJson) => {
        claim(j).claimDateInformation.statementBeginDate = "20260102";
      },
    ],
    [
      "claim.statementThroughDate",
      (j: StediClaimJson) => {
        claim(j).claimDateInformation.statementEndDate = "20260130";
      },
    ],
    [
      "claim.admissionDate",
      (j: StediClaimJson) => {
        claim(j).claimDateInformation.admissionDateAndHour = "20251231";
      },
    ],
    [
      "claim.dischargeHour",
      (j: StediClaimJson) => {
        claim(j).claimDateInformation.dischargeHour = "1200";
      },
    ],
    [
      "claim.admissionSource",
      (j: StediClaimJson) => {
        claim(j).claimCodeInformation.admissionSourceCode = "2";
      },
    ],
    [
      "claim.patientStatus",
      (j: StediClaimJson) => {
        claim(j).claimCodeInformation.patientStatusCode = "01";
      },
    ],
    [
      "claim.payerClaimControlNumber",
      (j: StediClaimJson) => {
        claim(j).claimSupplementalInformation = { claimControlNumber: "1" };
      },
    ],
    [
      "claim.principalDiagnosis",
      (j: StediClaimJson) => {
        claim(j).principalDiagnosis.principalDiagnosisCode = "C3491";
      },
    ],
    [
      "claim.otherDiagnoses",
      (j: StediClaimJson) => {
        claim(j).otherDiagnosisInformationList = [
          [{ otherDiagnosisCode: "I10", qualifierCode: "ABF" }],
        ];
      },
    ],
    [
      "claim.occurrenceCodes",
      (j: StediClaimJson) => {
        claim(j).occurrenceInformationList[0][0].occurrenceSpanCodeDate = "20260102";
      },
    ],
    [
      "claim.valueCodes",
      (j: StediClaimJson) => {
        claim(j).valueInformationList[0][1].valueCodeAmount = "1.00";
      },
    ],
    [
      "claim.conditionCodes",
      (j: StediClaimJson) => {
        claim(j).conditionCodesList = [[{ conditionCode: "D0" }]];
      },
    ],
    [
      "claim.lines",
      (j: StediClaimJson) => {
        claim(j).serviceLines[2].institutionalService.lineItemChargeAmount = "499.99";
      },
    ],
    [
      "claim.lines",
      (j: StediClaimJson) => {
        claim(j).serviceLines[0].serviceDate = "20260103";
      },
    ],
    [
      "claim.lines",
      (j: StediClaimJson) => {
        claim(j).serviceLines.pop();
      },
    ],
    [
      "claim.lines",
      (j: StediClaimJson) => {
        claim(j).serviceLines[0].institutionalService.procedureModifiers = ["PM"];
      },
    ],
  ])("flags %s when the JSON is tampered", (field, fn) => {
    expect(compareStediClaimJsonToX12(tamper(fn), raw)).toContain(field);
  });

  it("flags a JSON total that is not the sum of its own lines", () => {
    const lines = (claim(json).serviceLines as unknown[]).length;
    expect(lines).toBe(3);
    const t = tamper((j) => {
      claim(j).claimChargeAmount = "1500.00";
      claim(j).serviceLines[0].institutionalService.lineItemChargeAmount = "199.99";
    });
    expect(compareStediClaimJsonToX12(t, raw)).toEqual(expect.arrayContaining(["claim.lines"]));
  });

  it("returns field names only, never a value", () => {
    const t = tamper((j) => {
      claim(j).patientControlNumber = "SECRETVALUE";
    });
    expect(JSON.stringify(compareStediClaimJsonToX12(t, raw))).not.toContain("SECRETVALUE");
  });
});
