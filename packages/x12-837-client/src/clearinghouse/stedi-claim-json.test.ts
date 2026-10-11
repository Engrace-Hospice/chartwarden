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

  it("pads decimal value amounts and maps address2 and middle names", () => {
    const json = buildStediClaimJson({
      ...CLAIM_INPUT,
      subscriber: {
        ...CLAIM_INPUT.subscriber,
        middleInitial: "q",
        address: { ...CLAIM_INPUT.subscriber.address, line2: "apt 4" },
      },
      attendingPhysician: { ...CLAIM_INPUT.attendingPhysician, middleInitial: "r" },
      claim: { ...CLAIM_INPUT.claim, valueCodes: [{ code: "FC", amount: "7.5" }] },
    } as never);
    expect(json.subscriber.middleName).toBe("Q");
    expect(json.subscriber.address.address2).toBe("APT 4");
    expect(json.attending.middleName).toBe("R");
    expect(json.claimInformation.valueInformationList).toEqual([
      [{ valueCode: "FC", valueCodeAmount: "7.50" }],
    ]);
  });

  it.each([
    ["null input", null],
    ["missing claim", { ...CLAIM_INPUT, claim: undefined }],
    ["missing attendingPhysician", { ...CLAIM_INPUT, attendingPhysician: undefined }],
    ["missing submitter", { ...CLAIM_INPUT, submitter: undefined }],
    ["missing envelope", { ...CLAIM_INPUT, envelope: undefined }],
    [
      "numeric first name",
      { ...CLAIM_INPUT, subscriber: { ...CLAIM_INPUT.subscriber, firstName: 7 } },
    ],
  ])("fails as a build error, not a TypeError: %s", (_n, input) => {
    expect(() => buildStediClaimJson(input as never)).toThrow(Claim837iBuildError);
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

  it("flags a JSON total that disagrees with its own lines even when the raw agrees with the total", () => {
    // Only a line changes: the JSON total still equals the raw total, but no longer its own line sum.
    const t = tamper((j) => {
      claim(j).serviceLines[0].institutionalService.lineItemChargeAmount = "199.99";
    });
    expect(compareStediClaimJsonToX12(t, raw)).toContain("claim.totalCharge");
  });

  it("flags a JSON total that matches its lines but not the raw", () => {
    const t = tamper((j) => {
      claim(j).serviceLines[0].institutionalService.lineItemChargeAmount = "199.99";
      claim(j).claimChargeAmount = "1499.99";
    });
    expect(compareStediClaimJsonToX12(t, raw)).toContain("claim.totalCharge");
  });

  it.each([
    ["envelope.usage", (j: StediClaimJson) => Object.assign(j, { usageIndicator: "P" })],
    ["billingProvider.npi", (j: StediClaimJson) => Object.assign(j.billing, { npi: "1679576722" })],
    [
      "attendingPhysician.npi",
      (j: StediClaimJson) => Object.assign(j.attending, { npi: "1679576722" }),
    ],
    [
      "subscriber.mbi",
      (j: StediClaimJson) => Object.assign(j.subscriber, { memberId: "1AA0AA0AA00" }),
    ],
    [
      "subscriber.birthDate",
      (j: StediClaimJson) => Object.assign(j.subscriber, { dateOfBirth: "19400316" }),
    ],
    ["subscriber.sex", (j: StediClaimJson) => Object.assign(j.subscriber, { gender: "M" })],
    [
      "billingProvider.taxId",
      (j: StediClaimJson) => Object.assign(j.billing, { employerId: "000000000" }),
    ],
    [
      "payer.payerId",
      (j: StediClaimJson) => Object.assign(j, { tradingPartnerServiceId: "OTHER" }),
    ],
    [
      "claim.facilityType",
      (j: StediClaimJson) => Object.assign(j.claimInformation, { placeOfServiceCode: "82" }),
    ],
  ])("flags a tampered %s", (field, fn) => {
    expect(compareStediClaimJsonToX12(tamper(fn as never), raw)).toContain(field);
  });

  it("flags a raw interchange with a duplicate claim-level segment", () => {
    const dup = raw.replace("CL1*", "CL1*1*1*30~CL1*");
    expect(compareStediClaimJsonToX12(json, dup)).toContain("claim.structure");
    expect(
      compareStediClaimJsonToX12(
        json,
        raw.replace("DTP*434", "DTP*434*RD8*20260101-20260131~DTP*434"),
      ),
    ).toContain("claim.structure");
  });

  it("never reads an unparseable value amount as agreement", () => {
    const t = tamper((j) => {
      claim(j).valueInformationList = [
        [
          { valueCode: "61", valueCodeAmount: "x" },
          { valueCode: "G8", valueCodeAmount: "x" },
        ],
      ];
    });
    expect(
      compareStediClaimJsonToX12(
        t,
        raw.replace(/BE:61:::38900\*BE:G8:::38900/, "BE:61:::z*BE:G8:::z"),
      ),
    ).toContain("claim.valueCodes");
  });

  it("returns field names only, never a value", () => {
    const t = tamper((j) => {
      claim(j).patientControlNumber = "SECRETVALUE";
    });
    expect(JSON.stringify(compareStediClaimJsonToX12(t, raw))).not.toContain("SECRETVALUE");
  });
});
