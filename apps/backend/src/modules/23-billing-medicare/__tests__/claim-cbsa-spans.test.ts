// M23 — the facility spans G8 is read from: M37 (the system of record for an inpatient stay) wins for the stays it
// knows; M5's facility residence spans only stand in for stays M37 has no record of.
import { facilityPostalCodeForInpatientDates } from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import { composeFacilitySpans, toFacilitySpans } from "../services/claim-cbsa";

const STAY = { levelOfCarePeriodId: "loc-gip", from: "2026-11-10", to: "2026-11-14" };
const NURSING_HOME_OPEN = { effectiveFrom: "2026-01-01", effectiveTo: null, postalCode: "97801" };

describe("composeFacilitySpans", () => {
  it("uses the M37 facility for a stay, ignoring the nursing home's open M5 span (nursing-home resident, hospital GIP)", () => {
    const spans = composeFacilitySpans([STAY], new Map([["loc-gip", "97838"]]), [
      NURSING_HOME_OPEN,
    ]);
    expect(facilityPostalCodeForInpatientDates([STAY], spans)).toEqual({
      status: "found",
      postalCode: "97838",
    });
  });

  it("falls back to M5 spans only for a stay M37 does not know", () => {
    const known = { levelOfCarePeriodId: "loc-a", from: "2026-11-01", to: "2026-11-03" };
    const unknown = { levelOfCarePeriodId: "loc-b", from: "2026-11-10", to: "2026-11-14" };
    const spans = composeFacilitySpans([known, unknown], new Map([["loc-a", "97838"]]), [
      { effectiveFrom: "2026-11-09", effectiveTo: null, postalCode: "97801" },
    ]);
    // the LATEST stay (loc-b, M5-backed) wins
    expect(facilityPostalCodeForInpatientDates([known, unknown], spans)).toEqual({
      status: "found",
      postalCode: "97801",
    });
  });

  it("keeps an M37 facility with no recorded ZIP as a span with no ZIP, so G8 blocks rather than guessing", () => {
    const spans = composeFacilitySpans([STAY], new Map([["loc-gip", null]]), [NURSING_HOME_OPEN]);
    expect(facilityPostalCodeForInpatientDates([STAY], spans)).toEqual({
      status: "unresolved",
      reason: "no_zip_recorded",
    });
  });

  it("is empty when M37 knows nothing and no M5 span overlaps", () => {
    expect(
      composeFacilitySpans([STAY], new Map(), [
        { effectiveFrom: "2026-01-01", effectiveTo: "2026-11-09", postalCode: "97801" },
      ]),
    ).toEqual([]);
  });
});

describe("toFacilitySpans", () => {
  it("keeps only facility residences and joins the facility's postal code", () => {
    expect(
      toFacilitySpans(
        [
          { kind: "home", facilityId: null, effectiveFrom: "2026-01-01", effectiveTo: null },
          { kind: "facility", facilityId: "f1", effectiveFrom: "2026-02-01", effectiveTo: null },
          { kind: "facility", facilityId: "f2", effectiveFrom: "2026-03-01", effectiveTo: null },
        ],
        new Map([["f1", "97838"]]),
      ),
    ).toEqual([
      { effectiveFrom: "2026-02-01", effectiveTo: null, postalCode: "97838" },
      { effectiveFrom: "2026-03-01", effectiveTo: null, postalCode: null },
    ]);
  });
});
