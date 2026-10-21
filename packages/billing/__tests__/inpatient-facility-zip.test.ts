// @chartwarden/billing — value code G8 comes from the facility where the INPATIENT (0655/0656) care was delivered:
// the facility residence span overlapping those line dates, not merely the patient's latest facility.
import { type FacilitySpan, facilityPostalCodeForInpatientDates } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

const NURSING_HOME = "97801"; // long-term residence
const HOSPITAL = "97838"; // where the GIP stay is delivered

const span = (from: string, to: string | null, postalCode: string | null): FacilitySpan => ({
  effectiveFrom: from,
  effectiveTo: to,
  postalCode,
});

const GIP = [{ from: "2026-11-10", to: "2026-11-14" }];

describe("facilityPostalCodeForInpatientDates", () => {
  it("takes the facility whose span overlaps the inpatient dates, not the nursing home before them", () => {
    const spans = [
      span("2026-01-01", "2026-11-09", NURSING_HOME),
      span("2026-11-10", "2026-11-14", HOSPITAL),
      span("2026-11-15", null, NURSING_HOME),
    ];
    expect(facilityPostalCodeForInpatientDates(GIP, spans)).toEqual({
      status: "found",
      postalCode: HOSPITAL,
    });
  });

  it("resolves when a single span overlaps the dates (an open-ended stay)", () => {
    expect(facilityPostalCodeForInpatientDates(GIP, [span("2026-11-01", null, HOSPITAL)])).toEqual({
      status: "found",
      postalCode: HOSPITAL,
    });
  });

  it("is ambiguous — never a guess — when facilities with different ZIPs both overlap", () => {
    const spans = [
      span("2026-01-01", null, NURSING_HOME),
      span("2026-11-10", "2026-11-14", HOSPITAL),
    ];
    expect(facilityPostalCodeForInpatientDates(GIP, spans)).toEqual({
      status: "unresolved",
      reason: "ambiguous_facility",
    });
  });

  it("takes the LATEST facility when the inpatient care spans two (Pub. 100-04 ch. 11 s30.3)", () => {
    const spans = [
      span("2026-11-10", "2026-11-11", NURSING_HOME),
      span("2026-11-12", "2026-11-14", HOSPITAL),
    ];
    expect(facilityPostalCodeForInpatientDates(GIP, spans)).toEqual({
      status: "found",
      postalCode: HOSPITAL,
    });
    expect(
      facilityPostalCodeForInpatientDates(GIP, [
        span("2026-11-10", "2026-11-12", HOSPITAL),
        span("2026-11-13", "2026-11-14", NURSING_HOME),
      ]),
    ).toEqual({ status: "found", postalCode: NURSING_HOME });
  });

  it("accepts two overlapping spans that share a ZIP (a re-recorded address)", () => {
    const spans = [span("2026-11-01", "2026-11-12", HOSPITAL), span("2026-11-12", null, HOSPITAL)];
    expect(facilityPostalCodeForInpatientDates(GIP, spans)).toEqual({
      status: "found",
      postalCode: HOSPITAL,
    });
  });

  it("is unresolved when no facility span overlaps the inpatient dates", () => {
    const spans = [
      span("2026-01-01", "2026-11-09", NURSING_HOME),
      span("2026-11-20", null, HOSPITAL),
    ];
    expect(facilityPostalCodeForInpatientDates(GIP, spans)).toEqual({
      status: "unresolved",
      reason: "no_facility_stay",
    });
  });

  it("is unresolved when there are no inpatient dates or no spans at all", () => {
    expect(facilityPostalCodeForInpatientDates([], [span("2026-01-01", null, HOSPITAL)])).toEqual({
      status: "unresolved",
      reason: "no_facility_stay",
    });
    expect(facilityPostalCodeForInpatientDates(GIP, [])).toEqual({
      status: "unresolved",
      reason: "no_facility_stay",
    });
  });

  it("blocks when an overlapping facility has no recorded ZIP rather than trusting the other one", () => {
    const spans = [span("2026-11-01", null, null), span("2026-11-10", "2026-11-14", HOSPITAL)];
    expect(facilityPostalCodeForInpatientDates(GIP, spans)).toEqual({
      status: "unresolved",
      reason: "ambiguous_facility",
    });
    expect(facilityPostalCodeForInpatientDates(GIP, [span("2026-11-01", null, null)])).toEqual({
      status: "unresolved",
      reason: "no_zip_recorded",
    });
  });

  it("compares ZIPs by their first five digits (ZIP+4 is the same facility)", () => {
    const spans = [
      span("2026-11-01", null, "97838-1234"),
      span("2026-11-10", "2026-11-14", "97838"),
    ];
    expect(facilityPostalCodeForInpatientDates(GIP, spans)).toEqual({
      status: "found",
      postalCode: "97838",
    });
  });
});
