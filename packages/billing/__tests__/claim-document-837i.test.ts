import { describe, expect, it } from "vitest";
import {
  type BuildClaimDocumentInput,
  type ClaimDocumentClaimSource,
  type ClaimDocumentLineSource,
  buildClaimDocument837iDetail,
  noncoveredCentsForLine,
} from "../src/claim-document";

const claim: ClaimDocumentClaimSource = {
  id: "claim-1",
  tob: "813",
  serviceFrom: "2026-01-01",
  serviceTo: "2026-01-31",
  totalChargeCents: 150_000,
  patientStatusCode: "30",
  conditionCodes: [],
  occurrenceCodes: [{ code: "27", date: "2026-01-01" }],
  occurrenceSpans: [],
  valueCodes: [{ code: "61", cbsaCode: "38900" }],
  admissionTypeCode: "1",
  admissionSourceCode: "1",
  attendingPhysicianNpi: "1245319599",
  certifyingPhysicianNpi: null,
  attendingPhysicianFirstName: "Alan",
  attendingPhysicianLastName: "Smith",
  certifyingPhysicianFirstName: null,
  certifyingPhysicianLastName: null,
  diagnosisSnapshot: [
    { icd10Code: "I50.9", sequence: 2, qualifier: "ABF" },
    { icd10Code: "C34.90", sequence: 1, qualifier: "ABK" },
  ],
};

const line = (n: number, over: Partial<ClaimDocumentLineSource> = {}): ClaimDocumentLineSource => ({
  lineNumber: n,
  revenueCode: "0651",
  qCode: "Q5001",
  hcpcsCode: null,
  modifiers: [],
  unitCount: 1,
  unitRateCents: 20_000,
  lineChargeCents: 20_000,
  serviceDateFrom: "2026-01-01",
  serviceDateTo: "2026-01-01",
  ...over,
});

const lines = [
  line(2, {
    revenueCode: "0652",
    unitCount: 32,
    unitRateCents: 2_500,
    lineChargeCents: 80_000,
    serviceDateFrom: "2026-01-02",
    serviceDateTo: "2026-01-02",
  }),
  line(1),
  line(3, {
    revenueCode: "0655",
    qCode: "Q5006",
    unitRateCents: 50_000,
    lineChargeCents: 50_000,
    serviceDateFrom: "2026-01-10",
    serviceDateTo: "2026-01-10",
  }),
];

const input = (over: Partial<BuildClaimDocumentInput> = {}): BuildClaimDocumentInput => ({
  claim,
  lines,
  claimControlNumber: "WXHOSP0001",
  admissionDate: "2026-01-01",
  predecessorPayerClaimControlNumber: null,
  ...over,
});

const gapsOf = (r: ReturnType<typeof buildClaimDocument837iDetail>) =>
  r.ok ? [] : r.gaps.map((g) => `${g.field}:${g.reason}`);

describe("buildClaimDocument837iDetail", () => {
  it("builds the document with ordered lines, ordered diagnoses and the frequency from the TOB", () => {
    const r = buildClaimDocument837iDetail(input());
    if (!r.ok) throw new Error(JSON.stringify(r.gaps));
    expect(r.value.frequency).toBe("3");
    expect(r.value.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
    expect(r.value.diagnoses.map((d) => d.icd10Code)).toEqual(["C34.90", "I50.9"]);
    expect(r.value.attendingPhysician).toEqual({
      npi: "1245319599",
      firstName: "Alan",
      lastName: "Smith",
    });
    expect(r.value.certifyingPhysician).toBeNull();
    expect(r.value.payerClaimControlNumber).toBeNull();
    expect(r.value.admissionDate).toBe("2026-01-01");
  });

  it("totals the lines in integer cents and equals the claim total", () => {
    const r = buildClaimDocument837iDetail(input());
    if (!r.ok) throw new Error("unexpected gaps");
    expect(r.value.totalChargeCents).toBe(150_000);
    expect(r.value.totalChargeCents).toBe(r.value.lines.reduce((s, l) => s + l.chargeCents, 0));
  });

  it("uses the line's own HCPCS for a visit line and the Q code for a per-diem line", () => {
    const r = buildClaimDocument837iDetail(
      input({
        lines: [line(1), line(2, { revenueCode: "0551", hcpcsCode: "G0299", modifiers: ["GT"] })],
        claim: { ...claim, totalChargeCents: 40_000 },
      }),
    );
    if (!r.ok) throw new Error("unexpected gaps");
    expect(r.value.lines.map((l) => l.hcpcs)).toEqual(["Q5001", "G0299"]);
    expect(r.value.lines[1]?.modifiers).toEqual(["GT"]);
  });

  it("reports a total that disagrees with the lines", () => {
    const r = buildClaimDocument837iDetail(input({ claim: { ...claim, totalChargeCents: 1 } }));
    expect(gapsOf(r)).toEqual(["totalChargeCents:inconsistent"]);
  });

  it.each([
    ["admissionDate", input({ admissionDate: null }), "admissionDate:missing"],
    ["lines", input({ lines: [] }), "lines:missing"],
    [
      "admission type",
      input({ claim: { ...claim, admissionTypeCode: null } }),
      "admissionTypeCode:missing",
    ],
    [
      "admission source",
      input({ claim: { ...claim, admissionSourceCode: null } }),
      "admissionSourceCode:missing",
    ],
    [
      "patient status",
      input({ claim: { ...claim, patientStatusCode: null } }),
      "patientStatusCode:missing",
    ],
    [
      "attending npi",
      input({ claim: { ...claim, attendingPhysicianNpi: null } }),
      "attendingPhysician.npi:missing",
    ],
    [
      "attending name",
      input({ claim: { ...claim, attendingPhysicianLastName: null } }),
      "attendingPhysician.name:missing",
    ],
    [
      "certifying name",
      input({ claim: { ...claim, certifyingPhysicianNpi: "1982736455" } }),
      "certifyingPhysician.name:missing",
    ],
    ["diagnoses", input({ claim: { ...claim, diagnosisSnapshot: [] } }), "diagnoses:missing"],
    [
      "principal",
      input({
        claim: {
          ...claim,
          diagnosisSnapshot: [{ icd10Code: "I50.9", sequence: 1, qualifier: "ABF" }],
        },
      }),
      "diagnoses.principal:invalid",
    ],
    ["tob", input({ claim: { ...claim, tob: "81Z" } }), "tob:invalid"],
    [
      "replacement without a predecessor control number",
      input({ claim: { ...claim, tob: "817" } }),
      "payerClaimControlNumber:missing",
    ],
  ])("reports a gap for %s", (_name, bad, expected) => {
    expect(gapsOf(buildClaimDocument837iDetail(bad))).toEqual([expected]);
  });

  it("collects every gap at once", () => {
    const r = buildClaimDocument837iDetail(
      input({ admissionDate: null, claim: { ...claim, attendingPhysicianNpi: null } }),
    );
    expect(gapsOf(r)).toEqual(["admissionDate:missing", "attendingPhysician.npi:missing"]);
  });

  it("carries the predecessor's payer control number on a replacement or void, and only then", () => {
    const replacement = buildClaimDocument837iDetail(
      input({
        claim: { ...claim, tob: "817" },
        predecessorPayerClaimControlNumber: "12345678901234",
      }),
    );
    const original = buildClaimDocument837iDetail(
      input({ predecessorPayerClaimControlNumber: "12345678901234" }),
    );
    if (!replacement.ok || !original.ok) throw new Error("unexpected gaps");
    expect(replacement.value.frequency).toBe("7");
    expect(replacement.value.payerClaimControlNumber).toBe("12345678901234");
    expect(original.value.payerClaimControlNumber).toBeNull();
  });

  it("carries the certifying physician only with its own NPI and name", () => {
    const r = buildClaimDocument837iDetail(
      input({
        claim: {
          ...claim,
          certifyingPhysicianNpi: "1982736455",
          certifyingPhysicianFirstName: "Grace",
          certifyingPhysicianLastName: "Hopper",
        },
      }),
    );
    if (!r.ok) throw new Error("unexpected gaps");
    expect(r.value.certifyingPhysician).toEqual({
      npi: "1982736455",
      firstName: "Grace",
      lastName: "Hopper",
    });
  });

  it("derives non-covered cents from the late-NOE span and sums them", () => {
    const span = [{ code: "77", from: "2026-01-01", through: "2026-01-05" }];
    const perDiem = line(1, {
      unitCount: 10,
      unitRateCents: 1_000,
      lineChargeCents: 10_000,
      serviceDateFrom: "2026-01-01",
      serviceDateTo: "2026-01-10",
    });
    const visit = line(2, {
      revenueCode: "0551",
      hcpcsCode: "G0299",
      serviceDateFrom: "2026-01-03",
      serviceDateTo: "2026-01-03",
    });
    const outside = line(3, { serviceDateFrom: "2026-01-20", serviceDateTo: "2026-01-20" });
    const r = buildClaimDocument837iDetail(
      input({
        claim: { ...claim, occurrenceSpans: span, totalChargeCents: 50_000 },
        lines: [perDiem, visit, outside],
      }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.gaps));
    expect(r.value.lines.map((l) => l.noncoveredCents)).toEqual([5_000, 20_000, 0]);
    expect(r.value.nonCoveredChargeCents).toBe(25_000);
    expect(r.value.occurrenceSpans).toEqual(span);
  });

  it("refuses to apportion a partially covered line that is not a per-diem line", () => {
    const span = [{ code: "77", from: "2026-01-01", through: "2026-01-02" }];
    const chc = line(1, {
      revenueCode: "0652",
      unitCount: 96,
      unitRateCents: 100,
      lineChargeCents: 9_600,
      serviceDateFrom: "2026-01-01",
      serviceDateTo: "2026-01-04",
    });
    expect(noncoveredCentsForLine(chc, span)).toBeNull();
    const r = buildClaimDocument837iDetail(
      input({
        claim: { ...claim, occurrenceSpans: span, totalChargeCents: 9_600 },
        lines: [chc],
      }),
    );
    expect(gapsOf(r)).toEqual(["lines[0].noncoveredCents:invalid"]);
  });

  it("reports a zero-charge line", () => {
    const r = buildClaimDocument837iDetail(
      input({
        lines: [line(1, { lineChargeCents: 0, unitRateCents: 0 })],
        claim: { ...claim, totalChargeCents: 0 },
      }),
    );
    expect(gapsOf(r)).toEqual(["lines[0].chargeCents:invalid"]);
  });
});
