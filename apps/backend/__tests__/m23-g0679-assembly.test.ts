/**
 * FY2027 CR 14495 — claim assembly emits one separately dated G0679 line (revenue code 0657) per TELEHEALTH
 * recertification face-to-face whose encounter date falls in the claim span, for dates of service on/after
 * 2027-01-01 only. Pure test of `buildG0679LineInputs` (the helper `assemble()` appends after the per-diem
 * lines). Units / charge are the UNCONFIRMED constants from `@wardenx/billing`.
 */
import {
  type FaceToFaceSnapshot,
  G0679_UNITS_PER_ENCOUNTER,
  G0679_UNIT_CHARGE_CENTS,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import { buildG0679LineInputs } from "../src/modules/23-billing-medicare/services/claim-assembly";

const LOC = [
  {
    levelOfCarePeriodId: "loc-1",
    levelOfCare: "routine_home_care" as const,
    from: "2026-11-01",
    to: "2027-03-31",
  },
];

const f2f = (overrides: Partial<FaceToFaceSnapshot>): FaceToFaceSnapshot => ({
  electionPeriodSequence: 3,
  attested: true,
  encounterDate: "2027-01-20",
  modality: "telehealth",
  ...overrides,
});

const build = (
  faceToFace: readonly FaceToFaceSnapshot[],
  serviceFrom = "2027-01-01",
  serviceTo = "2027-01-31",
) =>
  buildG0679LineInputs({
    orgId: "org-1",
    faceToFace,
    serviceFrom,
    serviceTo,
    resolvedLoc: LOC,
    qCode: "Q5001",
    icdPointerPositions: [1],
    firstLineNumber: 2,
  });

describe("buildG0679LineInputs (CR 14495)", () => {
  it("emits a dated G0679 / 0657 line for a telehealth encounter in a 2027 span", () => {
    const lines = build([f2f({})]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      lineNumber: 2,
      revenueCode: "0657",
      hcpcsCode: "G0679",
      serviceDateFrom: "2027-01-20",
      serviceDateTo: "2027-01-20",
      unitCount: G0679_UNITS_PER_ENCOUNTER,
      unitRateCents: G0679_UNIT_CHARGE_CENTS,
      lineChargeCents: G0679_UNITS_PER_ENCOUNTER * G0679_UNIT_CHARGE_CENTS,
      levelOfCare: "routine_home_care",
      levelOfCarePeriodId: "loc-1",
      qCode: "Q5001",
    });
  });

  it("emits nothing for an in-person or unrecorded-modality encounter", () => {
    expect(build([f2f({ modality: "in_person" }), f2f({ modality: null })])).toEqual([]);
  });

  it("emits nothing for a telehealth encounter dated before 2027-01-01", () => {
    expect(build([f2f({ encounterDate: "2026-12-15" })], "2026-12-01", "2026-12-31")).toEqual([]);
  });

  it("emits nothing for a telehealth encounter outside the claim span", () => {
    expect(build([f2f({ encounterDate: "2027-02-10" })])).toEqual([]);
  });

  it("numbers multiple lines consecutively after the per-diem lines", () => {
    const lines = build([
      f2f({ encounterDate: "2027-01-25", electionPeriodSequence: 4 }),
      f2f({ encounterDate: "2027-01-05" }),
    ]);
    expect(lines.map((l) => [l.lineNumber, l.serviceDateFrom])).toEqual([
      [2, "2027-01-05"],
      [3, "2027-01-25"],
    ]);
  });

  it("refuses when no level-of-care period covers the encounter date", () => {
    expect(() =>
      buildG0679LineInputs({
        orgId: "org-1",
        faceToFace: [f2f({})],
        serviceFrom: "2027-01-01",
        serviceTo: "2027-01-31",
        resolvedLoc: [],
        qCode: "Q5001",
        icdPointerPositions: [],
        firstLineNumber: 1,
      }),
    ).toThrow(/no level-of-care period/);
  });
});
