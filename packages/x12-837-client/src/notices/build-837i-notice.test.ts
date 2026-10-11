import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStediEdits } from "../clearinghouse/stedi-edit-rules";
import { X12BuildError } from "../x12/writer";
import { Notice837iBuildError, build837iNotice } from "./build-837i-notice";
import { NOE_INPUT, NOTR_INPUT } from "./notice-fixture-input";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "..", "clearinghouse", "__fixtures__", name), "utf8");
const pretty = (x12: string): string => x12.replaceAll("~", "~\n").trimEnd();
const lines = (x12: string): string[] => x12.split("~").filter((s) => s.length > 0);

describe("build837iNotice — goldens from the Stedi sandbox", () => {
  it("matches the validated NOE (81A) payload byte for byte", () => {
    expect(pretty(build837iNotice(NOE_INPUT))).toBe(fixture("stedi-NOE_81A.x12").trimEnd());
  });

  it("matches the validated NOTR (81B) payload byte for byte", () => {
    expect(pretty(build837iNotice(NOTR_INPUT))).toBe(fixture("stedi-NOTR_81B.x12").trimEnd());
  });

  it.each([
    ["NOE", NOE_INPUT],
    ["NOTR", NOTR_INPUT],
  ] as const)("passes every Stedi edit rule for a %s", (_k, input) => {
    expect(checkStediEdits(build837iNotice(input))).toEqual([]);
  });

  it("defaults BHT06 to RP (CH with a $0 charge is rejected by the sandbox)", () => {
    expect(lines(build837iNotice(NOE_INPUT))).toContainEqual(
      expect.stringMatching(/^BHT\*0019\*00\*WXNOE0001\*\d{8}\*\d{4}\*RP$/),
    );
  });

  it("carries the NOTR termination date as the statement through date and the line date", () => {
    const segs = lines(build837iNotice(NOTR_INPUT));
    expect(segs).toContain("DTP*434*RD8*20260101-20260131");
    expect(segs).toContain("DTP*472*D8*20260131");
    expect(segs).toContain("CLM*WXNOTR0001*0***81:A:B**A*Y*Y");
  });
});

describe("build837iNotice — input validation names the field, never the value", () => {
  const bad = (patch: object, field: string): void => {
    let caught: unknown;
    try {
      build837iNotice({ ...NOE_INPUT, ...patch } as typeof NOE_INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Notice837iBuildError);
    expect(caught).toBeInstanceOf(X12BuildError);
    expect((caught as Notice837iBuildError).message).toBe(`invalid 837I notice input: ${field}`);
  };

  it("refuses a NOTR without a termination date", () => {
    expect(() =>
      build837iNotice({
        ...NOTR_INPUT,
        notice: { kind: "NOTR", controlNumber: "X1", admissionDate: "2026-01-01" },
      } as never),
    ).toThrow(Notice837iBuildError);
  });

  it("refuses a NOE that carries a termination date", () => {
    bad(
      { notice: { ...NOE_INPUT.notice, terminationDate: "2026-01-31" } as never },
      "notice.terminationDate",
    );
  });

  it("refuses a termination date before the admission date", () => {
    expect(() =>
      build837iNotice({
        ...NOTR_INPUT,
        notice: { ...NOTR_INPUT.notice, terminationDate: "2025-12-31" } as never,
      }),
    ).toThrow(/notice\.terminationDate/);
  });

  it.each([
    [{ notice: { ...NOE_INPUT.notice, controlNumber: "bad number!" } }, "notice.controlNumber"],
    [{ subscriber: { ...NOE_INPUT.subscriber, mbi: "NOT-AN-MBI" } }, "subscriber.mbi"],
    [{ principalDiagnosis: "123" }, "principalDiagnosis"],
    [{ billingProvider: { ...NOE_INPUT.billingProvider, taxId: "12" } }, "billingProvider.taxId"],
    [{ submitter: { ...NOE_INPUT.submitter, contactPhone: "555" } }, "submitter.contactPhone"],
    [{ subscriber: { ...NOE_INPUT.subscriber, birthDate: "2030-01-01" } }, "subscriber.birthDate"],
  ])("refuses %#", (patch, field) => bad(patch, field));

  it("refuses a missing or null control number rather than coercing it", () => {
    for (const controlNumber of [undefined, null]) {
      bad({ notice: { ...NOE_INPUT.notice, controlNumber } as never }, "notice.controlNumber");
    }
  });

  it.each([
    [{ notice: { ...NOE_INPUT.notice, kind: "toString" } as never }, "notice.kind"],
    [{ notice: { ...NOE_INPUT.notice, kind: "FOO" } as never }, "notice.kind"],
    [{ subscriber: { ...NOE_INPUT.subscriber, sex: "F*X" as never } }, "subscriber.sex"],
    [{ envelope: { ...NOE_INPUT.envelope, createdAt: new Date("x") } }, "envelope.createdAt"],
    [{ envelope: { ...NOE_INPUT.envelope, usage: "Q" as never } }, "envelope.usage"],
    [
      { attendingPhysician: { ...NOE_INPUT.attendingPhysician, npi: "123" } },
      "attendingPhysician.npi",
    ],
    [{ billingProvider: { ...NOE_INPUT.billingProvider, npi: "123" } }, "billingProvider.npi"],
    [{ notice: { ...NOE_INPUT.notice, admissionDate: "2026-02-30" } }, "notice.admissionDate"],
    [
      { envelope: { ...NOE_INPUT.envelope, interchangeControlNumber: 0 } },
      "envelope.interchangeControlNumber",
    ],
  ])("refuses untyped input %#", (patch, field) => bad(patch, field));

  it("refuses a NOTR without a termination date, naming the field", () => {
    const notice = { kind: "NOTR", controlNumber: "X1", admissionDate: "2026-01-01" } as never;
    expect(() => build837iNotice({ ...NOTR_INPUT, notice })).toThrow(
      "invalid 837I notice input: notice.terminationDate",
    );
  });

  it("accepts a same-day termination and a birth date equal to the admission date", () => {
    const notice = { ...NOTR_INPUT.notice, terminationDate: "2026-01-01" } as never;
    expect(() => build837iNotice({ ...NOTR_INPUT, notice })).not.toThrow();
    const subscriber = { ...NOE_INPUT.subscriber, birthDate: "2026-01-01" };
    expect(() => build837iNotice({ ...NOE_INPUT, subscriber })).not.toThrow();
  });

  it("keeps the admit date and OC 27 on the admission date for a NOTR", () => {
    const segs = lines(build837iNotice(NOTR_INPUT));
    expect(segs).toContain("DTP*435*D8*20260101");
    expect(segs).toContain("HI*BH:27:D8:20260101");
  });

  it("never echoes the offending value", () => {
    const subscriber = { ...NOE_INPUT.subscriber, mbi: "SECRETVALUE" };
    expect(() => build837iNotice({ ...NOE_INPUT, subscriber })).toThrow(/^((?!SECRETVALUE).)*$/s);
  });
});
