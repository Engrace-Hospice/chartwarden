import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TransferNotice837iBuildError,
  build837iTransferNotice,
  isValidNpi,
} from "./build-837i-transfer-notice";
import { ORIGINAL_8XC_INPUT } from "./transfer-notice-fixture-input";

const lines = (x12: string): string[] => x12.split("~").filter((s) => s.length > 0);

describe("build837iTransferNotice — TOB 81C (CMS Pub. 100-04 ch. 11 §20.1.3)", () => {
  it("matches the golden 81C interchange byte for byte", () => {
    // Arrange
    const golden = readFileSync(join(__dirname, "__fixtures__", "transfer-notice-81c.x12"), "utf8");

    // Act
    const x12 = build837iTransferNotice(ORIGINAL_8XC_INPUT);

    // Assert
    expect(x12.replaceAll("~", "~\n").trimEnd()).toBe(golden.trimEnd());
  });

  it("reports TOB 81C as CLM05 81:A:C with a zero charge, From only and the receiving hospice's admit date", () => {
    const segs = lines(build837iTransferNotice(ORIGINAL_8XC_INPUT));
    expect(segs).toContain("CLM*WX8C0001*0***81:A:C**A*Y*Y");
    expect(segs).toContain("DTP*434*RD8*20260110-20260110");
    expect(segs).toContain("DTP*435*D8*20260110");
    expect(segs).toContain("SV2*0650*HC:Q5009:::::NOE*0*UN*1");
  });

  it("never sends the segments the NOE companion guide forbids (2000C patient loop, payer/attending REF, CN1)", () => {
    const segs = lines(build837iTransferNotice(ORIGINAL_8XC_INPUT));
    expect(segs.some((s) => s.startsWith("PAT*"))).toBe(false);
    expect(segs.some((s) => s.startsWith("CN1*"))).toBe(false);
    expect(segs.filter((s) => s.startsWith("HL*"))).toEqual(["HL*1**20*1", "HL*2*1*22*0"]);
    expect(segs.filter((s) => s.startsWith("REF*"))).toEqual(["REF*EI*931234567"]);
  });

  it("counts every segment from ST to SE in SE01", () => {
    const segs = lines(build837iTransferNotice(ORIGINAL_8XC_INPUT));
    const st = segs.findIndex((s) => s.startsWith("ST*"));
    const se = segs.findIndex((s) => s.startsWith("SE*"));
    expect(segs[se]).toBe(`SE*${se - st + 1}*0042`);
  });

  it("omits Loop 2310F when the certifying physician is the attending", () => {
    const segs = lines(
      build837iTransferNotice({
        ...ORIGINAL_8XC_INPUT,
        otherPhysician: ORIGINAL_8XC_INPUT.attendingPhysician,
      }),
    );
    expect(segs.some((s) => s.startsWith("NM1*DN*"))).toBe(false);
  });

  it("renders a correction with OC 56 (the original date) and CC D0 together", () => {
    const segs = lines(
      build837iTransferNotice({
        ...ORIGINAL_8XC_INPUT,
        document: {
          ...ORIGINAL_8XC_INPUT.document,
          action: "correction",
          statementFromDate: "2026-01-11",
          admissionDate: "2026-01-11",
          conditionCodes: ["D0"],
          occurrenceCodes: [{ code: "56", date: "2026-01-10" }],
        },
      }),
    );
    expect(segs).toContain("DTP*434*RD8*20260111-20260111");
    expect(segs).toContain("HI*BH:56:D8:20260110");
    expect(segs).toContain("HI*BG:D0");
  });

  it.each([
    ["D0 without OC 56", ["D0"], []],
    ["OC 56 without D0", [], [{ code: "56", date: "2026-01-09" }]],
  ])("refuses a correction pair that is broken (%s)", (_label, conditionCodes, occurrenceCodes) => {
    expect(() =>
      build837iTransferNotice({
        ...ORIGINAL_8XC_INPUT,
        document: {
          ...ORIGINAL_8XC_INPUT.document,
          action: "correction",
          conditionCodes,
          occurrenceCodes,
        },
      }),
    ).toThrow(TransferNotice837iBuildError);
  });

  it("renders an 8xD void whose From and admit date are the transfer date (§20.1.4)", () => {
    const segs = lines(
      build837iTransferNotice({
        ...ORIGINAL_8XC_INPUT,
        document: {
          ...ORIGINAL_8XC_INPUT.document,
          action: "void",
          tob: "81D",
          frequencyCode: "D",
          occurrenceCodes: [],
        },
      }),
    );
    expect(segs).toContain("CLM*WX8C0001*0***81:A:D**A*Y*Y");
    expect(segs.some((s) => s.startsWith("HI*BH"))).toBe(false);
  });

  it("refuses a void whose admit date is not the transfer date", () => {
    expect(() =>
      build837iTransferNotice({
        ...ORIGINAL_8XC_INPUT,
        document: {
          ...ORIGINAL_8XC_INPUT.document,
          action: "void",
          tob: "81D",
          frequencyCode: "D",
          admissionDate: "2026-01-09",
          occurrenceCodes: [],
        },
      }),
    ).toThrow(/document.admissionDate/);
  });

  it("validates the MBI format and the NPI check digit, naming the field and never the value", () => {
    const badMbi = () =>
      build837iTransferNotice({
        ...ORIGINAL_8XC_INPUT,
        subscriber: { ...ORIGINAL_8XC_INPUT.subscriber, mbi: "1EG4TE5MKS3" },
      });
    expect(badMbi).toThrow("subscriber.mbi");
    expect(badMbi).not.toThrow(/1EG4TE5MKS3/);
    expect(() =>
      build837iTransferNotice({
        ...ORIGINAL_8XC_INPUT,
        attendingPhysician: { ...ORIGINAL_8XC_INPUT.attendingPhysician, npi: "1245319598" },
      }),
    ).toThrow("attendingPhysician.npi");
  });

  it("refuses an element containing an X12 delimiter", () => {
    expect(() =>
      build837iTransferNotice({
        ...ORIGINAL_8XC_INPUT,
        subscriber: { ...ORIGINAL_8XC_INPUT.subscriber, lastName: "DOE*SMITH" },
      }),
    ).toThrow("subscriber.lastName");
  });
});

describe("isValidNpi", () => {
  it("accepts a check-digit-valid NPI and rejects a one-digit change", () => {
    expect(isValidNpi("1234567893")).toBe(true);
    expect(isValidNpi("1234567894")).toBe(false);
    expect(isValidNpi("123456789")).toBe(false);
  });
});
