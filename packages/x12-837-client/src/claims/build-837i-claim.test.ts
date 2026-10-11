import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStediEdits } from "../clearinghouse/stedi-edit-rules";
import { X12BuildError } from "../x12/writer";
import { Claim837iBuildError, build837iClaim } from "./build-837i-claim";
import { CLAIM_INPUT, REPLACEMENT_INPUT, VOID_INPUT } from "./claim-fixture-input";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "..", "clearinghouse", "__fixtures__", name), "utf8");
const pretty = (x12: string): string => x12.replaceAll("~", "~\n").trimEnd();
const lines = (x12: string): string[] => x12.split("~").filter((s) => s.length > 0);

// The sandbox payloads carry ISA/GS/SE control numbers 0101/0301/0302; the ST02 is the ICN.
describe("build837iClaim — goldens from the Stedi sandbox", () => {
  it.each([
    ["claim (freq 3)", CLAIM_INPUT, "stedi-claim.x12"],
    ["replacement (freq 7)", REPLACEMENT_INPUT, "stedi-adjust_817.x12"],
    ["void (freq 8)", VOID_INPUT, "stedi-cancel_818.x12"],
  ] as const)("matches the validated %s payload byte for byte", (_n, input, file) => {
    expect(pretty(build837iClaim(input))).toBe(fixture(file).trimEnd());
  });

  it.each([
    ["claim", CLAIM_INPUT],
    ["replacement", REPLACEMENT_INPUT],
    ["void", VOID_INPUT],
  ] as const)("passes every Stedi edit rule for the %s", (_n, input) => {
    expect(checkStediEdits(build837iClaim(input))).toEqual([]);
  });
});

const claimWith = (patch: object) => ({
  ...CLAIM_INPUT,
  claim: { ...CLAIM_INPUT.claim, ...patch },
});

describe("build837iClaim — claim rules", () => {
  it("sets CLM02 to the sum of the line charges", () => {
    expect(lines(build837iClaim(CLAIM_INPUT))).toContain("CLM*WXHOSP0001*1500.00***81:A:3**A*Y*Y");
  });

  it("places REF*F8 immediately after CL1 on a replacement and a void only", () => {
    const segs = lines(build837iClaim(REPLACEMENT_INPUT));
    expect(segs[segs.findIndex((s) => s.startsWith("CL1*")) + 1]).toBe("REF*F8*12345678901234");
    expect(lines(build837iClaim(CLAIM_INPUT)).some((s) => s.startsWith("REF*F8"))).toBe(false);
  });

  it("serialises line modifiers into SV2-02", () => {
    const x12 = build837iClaim(
      claimWith({
        lines: [
          {
            revenueCode: "0651",
            hcpcs: "Q5001",
            modifiers: ["PM"],
            chargeCents: 100,
            units: 1,
            serviceDate: "2026-01-01",
          },
        ],
      }),
    );
    expect(lines(x12)).toContain("SV2*0651*HC:Q5001:PM*1.00*UN*1");
  });

  it("emits other diagnoses, condition codes and the discharge hour as TM", () => {
    const x12 = build837iClaim(
      claimWith({
        frequency: "1",
        patientStatus: "40",
        otherDiagnoses: ["I10", "E11.9"],
        conditionCodes: ["D0"],
        dischargeHour: "1430",
      }),
    );
    const segs = lines(x12);
    expect(segs).toContain("HI*ABF:I10*ABF:E119");
    expect(segs).toContain("HI*BG:D0");
    expect(segs).toContain("DTP*096*TM*1430");
    expect(checkStediEdits(x12)).toEqual([]);
  });
});

describe("build837iClaim — fail closed, field names only", () => {
  const bad = (input: unknown, field: string): void => {
    let caught: unknown;
    try {
      build837iClaim(input as typeof CLAIM_INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Claim837iBuildError);
    expect(caught).toBeInstanceOf(X12BuildError);
    expect((caught as Error).message).toBe(`invalid 837I claim input: ${field}`);
  };
  const line = CLAIM_INPUT.claim.lines[0];

  it.each([
    [claimWith({ frequency: "5" }), "claim.frequency"],
    [claimWith({ frequency: "toString" }), "claim.frequency"],
    [claimWith({ frequency: "1" }), "claim.patientStatus"], // final bill while still a patient
    [claimWith({ frequency: "4", patientStatus: "30" }), "claim.patientStatus"],
    [claimWith({ patientStatus: "01" }), "claim.patientStatus"], // interim claim must be 30
    [claimWith({ admissionSource: "" }), "claim.admissionSource"],
    [claimWith({ frequency: "7" }), "claim.payerClaimControlNumber"],
    [claimWith({ payerClaimControlNumber: "123" }), "claim.payerClaimControlNumber"],
    [claimWith({ lines: [] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, chargeCents: 0 }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, chargeCents: 1.5 }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, units: 0 }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, revenueCode: "65" }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, hcpcs: "q5001" }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, modifiers: ["P*"] }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, serviceDate: "2026-02-30" }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, serviceDate: "2025-12-31" }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, serviceDate: "2026-02-01" }] }), "claim.lines"],
    [claimWith({ principalDiagnosis: "123" }), "claim.principalDiagnosis"],
    [claimWith({ otherDiagnoses: ["bad!"] }), "claim.otherDiagnoses"],
    [claimWith({ statementThroughDate: "2025-12-31" }), "claim.statementThroughDate"],
    [claimWith({ valueCodes: [{ code: "61", amount: "1*2" }] }), "claim.valueCodes"],
    [claimWith({ occurrenceCodes: [{ code: "2", date: "2026-01-01" }] }), "claim.occurrenceCodes"],
    [claimWith({ conditionCodes: ["d0"] }), "claim.conditionCodes"],
    [claimWith({ dischargeHour: "25:00" }), "claim.dischargeHour"],
    [claimWith({ controlNumber: "bad number!" }), "claim.controlNumber"],
    [
      { ...CLAIM_INPUT, attendingPhysician: { ...CLAIM_INPUT.attendingPhysician, npi: "123" } },
      "attendingPhysician.npi",
    ],
    [
      { ...CLAIM_INPUT, subscriber: { ...CLAIM_INPUT.subscriber, mbi: "SECRET" } },
      "subscriber.mbi",
    ],
  ])("refuses %#", (input, field) => bad(input, field));

  it.each([
    [claimWith({ controlNumber: undefined }), "claim.controlNumber"],
    [claimWith({ controlNumber: null }), "claim.controlNumber"],
    [claimWith({ controlNumber: ["AB"] }), "claim.controlNumber"],
    [claimWith({ frequency: "7", payerClaimControlNumber: null }), "claim.payerClaimControlNumber"],
    [claimWith({ lines: undefined }), "claim.lines"],
    [claimWith({ lines: [null] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, modifiers: "PM" }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, modifiers: ["A1", "B2", "C3", "D4", "E5"] }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, units: 1_000_000 }] }), "claim.lines"],
    [claimWith({ lines: [{ ...line, chargeCents: 10_000_000_000 }] }), "claim.lines"],
    [claimWith({ principalDiagnosis: 123 }), "claim.principalDiagnosis"],
    [claimWith({ otherDiagnoses: undefined }), "claim.otherDiagnoses"],
    [claimWith({ otherDiagnoses: Array(13).fill("I10") }), "claim.otherDiagnoses"],
    [claimWith({ occurrenceCodes: [null] }), "claim.occurrenceCodes"],
    [claimWith({ valueCodes: [{ code: "61", amount: "1234567890" }] }), "claim.valueCodes"],
    [claimWith({ controlNumber: "A".repeat(39) }), "claim.controlNumber"],
    [claimWith({ admissionDate: "2026-03-01" }), "claim.admissionDate"],
    [{ ...CLAIM_INPUT, subscriber: { ...CLAIM_INPUT.subscriber, mbi: null } }, "subscriber.mbi"],
    [
      { ...CLAIM_INPUT, billingProvider: { ...CLAIM_INPUT.billingProvider, taxId: undefined } },
      "billingProvider.taxId",
    ],
  ])("refuses untyped or boundary input %#", (input, field) => bad(input, field));

  it("accepts the boundaries: 38-char control number, 12 other diagnoses, 4 modifiers, lines on the statement edges", () => {
    const edge = [
      { ...line, serviceDate: "2026-01-01" },
      { ...line, serviceDate: "2026-01-31", modifiers: ["A1", "B2", "C3", "D4"], units: 999_999 },
    ];
    expect(() =>
      build837iClaim(
        claimWith({
          controlNumber: "A".repeat(38),
          otherDiagnoses: Array(12).fill("I10"),
          lines: edge,
        }) as never,
      ),
    ).not.toThrow();
  });

  it("emits DTP*096 before the statement dates (Loop 2300 order)", () => {
    const segs = lines(
      build837iClaim(
        claimWith({ frequency: "1", patientStatus: "40", dischargeHour: "1430" }) as never,
      ),
    );
    const at = (p: string): number => segs.findIndex((x) => x.startsWith(p));
    expect(at("DTP*096")).toBeGreaterThan(at("CLM*"));
    expect(at("DTP*096")).toBeLessThan(at("DTP*434"));
  });

  it("never echoes the offending value", () => {
    const input = { ...CLAIM_INPUT, subscriber: { ...CLAIM_INPUT.subscriber, mbi: "SECRETVALUE" } };
    expect(() => build837iClaim(input)).toThrow(/^((?!SECRETVALUE).)*$/s);
  });
});
