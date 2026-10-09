// @wardenx/billing — the tenant-entered visit-charge schedule domain: validation of a keyed entry and the
// fail-closed resolution of the per-15-minute-unit charge a visit line is billed at. Pure; no DB, no clock.
import {
  VISIT_CHARGE_DISCIPLINES,
  VISIT_CHARGE_MAX_CENTS,
  type VisitChargeVersion,
  type VisitUnitCharges,
  buildVisitLines,
  missingVisitCharges,
  validateVisitChargeEntry,
  visitUnitChargeOn,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";

const none: VisitUnitCharges = {
  rn: null,
  lpn: null,
  chha: null,
  msw: null,
  pt: null,
  ot: null,
  slp: null,
};
const charges = (over: Partial<VisitUnitCharges>): VisitUnitCharges => ({ ...none, ...over });

describe("visit-charge disciplines", () => {
  it("covers every discipline a visit line can be coded from", () => {
    expect([...VISIT_CHARGE_DISCIPLINES]).toEqual(["rn", "lpn", "chha", "msw", "pt", "ot", "slp"]);
  });

  it("is the discipline every built visit line carries, so a charge can always be looked up", () => {
    const { lines } = buildVisitLines({
      encounters: (
        [
          ["rn", "routine_visit"],
          ["lpn", "lpn_visit"],
          ["chha", "chha_visit"],
          ["msw", "msw_followup"],
          ["msw", "telephonic"],
          ["pt", "pt_visit"],
          ["ot", "ot_visit"],
          ["slp", "slp_visit"],
        ] as const
      ).map(([discipline, encounterType], i) => ({
        encounterId: `e${i}`,
        serviceDate: "2026-10-05",
        billability: "billable" as const,
        discipline,
        encounterType,
        durationMinutes: 30,
      })),
      levelOfCarePeriods: [
        {
          levelOfCarePeriodId: "loc",
          levelOfCare: "routine_home_care",
          from: "2026-10-01",
          to: "2026-10-31",
        },
      ],
      inpatientHospiceFacility: false,
    });
    expect(lines.map((l) => l.discipline)).toEqual([
      "rn",
      "lpn",
      "chha",
      "msw",
      "msw",
      "pt",
      "ot",
      "slp",
    ]);
  });
});

describe("validateVisitChargeEntry", () => {
  const ok = { effectiveFrom: "2026-10-01", charges: charges({ rn: 2500 }) };

  it("accepts an open-ended entry with at least one discipline charge", () => {
    expect(validateVisitChargeEntry(ok)).toEqual({ ok: true, effectiveTo: null });
  });

  it("accepts a bounded window and an explicit zero charge (informational lines may be free)", () => {
    expect(
      validateVisitChargeEntry({
        effectiveFrom: "2026-10-01",
        effectiveTo: "2027-09-30",
        charges: charges({ msw: 0, rn: 3000 }),
      }),
    ).toEqual({ ok: true, effectiveTo: "2027-09-30" });
  });

  it("requires at least one charge", () => {
    const r = validateVisitChargeEntry({ effectiveFrom: "2026-10-01", charges: none });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/at least one/);
  });

  it.each([
    [-1, /whole number of cents/],
    [2.5, /whole number of cents/],
    [VISIT_CHARGE_MAX_CENTS + 1, /plausible band/],
  ])("rejects a charge of %s", (rn, pattern) => {
    const r = validateVisitChargeEntry({ ...ok, charges: charges({ rn }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(pattern);
  });

  it("rejects malformed or inverted windows", () => {
    expect(validateVisitChargeEntry({ ...ok, effectiveFrom: "10/01/2026" }).ok).toBe(false);
    const inverted = validateVisitChargeEntry({ ...ok, effectiveTo: "2026-09-30" });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.errors.join(" ")).toMatch(/must not precede/);
  });
});

describe("visitUnitChargeOn / missingVisitCharges — fail closed", () => {
  const v1: VisitChargeVersion = {
    effectiveFrom: "2026-10-01",
    effectiveTo: "2026-12-31",
    charges: charges({ rn: 2500, msw: 0 }),
  };
  const v2: VisitChargeVersion = {
    effectiveFrom: "2027-01-01",
    effectiveTo: null,
    charges: charges({ rn: 2600, pt: 3100 }),
  };

  it("reads the version covering the visit date", () => {
    expect(visitUnitChargeOn([v1, v2], "2026-11-15", "rn")).toBe(2500);
    expect(visitUnitChargeOn([v1, v2], "2027-02-01", "rn")).toBe(2600);
  });

  it("treats an explicit zero as a charge, and an unset discipline as missing", () => {
    expect(visitUnitChargeOn([v1], "2026-11-15", "msw")).toBe(0);
    expect(visitUnitChargeOn([v1], "2026-11-15", "pt")).toBeNull();
  });

  it("is null when no version covers the date", () => {
    expect(visitUnitChargeOn([v1, v2], "2026-09-30", "rn")).toBeNull();
    expect(visitUnitChargeOn([], "2026-11-15", "rn")).toBeNull();
  });

  it("lists each discipline with no charge on a billed date once, in vocabulary order", () => {
    const missing = missingVisitCharges(
      [v1, v2],
      [
        { serviceDate: "2026-11-15", discipline: "rn" }, // covered
        { serviceDate: "2026-11-16", discipline: "pt" }, // v1 has no pt charge
        { serviceDate: "2026-11-17", discipline: "pt" }, // (duplicate discipline)
        { serviceDate: "2027-02-01", discipline: "lpn" }, // v2 has no lpn charge
        { serviceDate: "2026-09-01", discipline: "msw" }, // before any version
      ],
    );
    expect(missing).toEqual(["lpn", "msw", "pt"]);
  });

  it("reports nothing missing when there is nothing to bill", () => {
    expect(missingVisitCharges([], [])).toEqual([]);
  });
});
