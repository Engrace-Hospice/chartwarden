// F-211 — the tenant-entered wage index's PURE rules: validation (plausible band, CCN/CBSA shape, fiscal-year window,
// source citation) and the lookup precedence (tenant, then AUTHORITATIVE platform, never a placeholder).
import { describe, expect, it } from "vitest";
import { type WageIndexEntry, resolveWageIndex, validateWageIndexEntry } from "../src";

const TODAY = "2026-09-29"; // fiscal year starting 2025 (FY2026)

const GOOD: WageIndexEntry = {
  ccn: "381240",
  fiscalYearStarting: 2025,
  cbsaCode: "38900",
  factorDecimal: "1.0342",
  sourceReference: "CMS FY2026 hospice wage index final rule, Table A",
};

describe("validateWageIndexEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(validateWageIndexEntry(GOOD, TODAY)).toEqual({ ok: true });
    expect(validateWageIndexEntry({ ...GOOD, cbsaCode: null }, TODAY).ok).toBe(true);
    expect(validateWageIndexEntry({ ...GOOD, cbsaCode: undefined }, TODAY).ok).toBe(true);
  });

  it("enforces the 0.5 - 2.5 plausible band inclusively", () => {
    for (const ok of ["0.5", "0.5000", "2.5", "2.5000", "0.7345", "1.9999"]) {
      expect(validateWageIndexEntry({ ...GOOD, factorDecimal: ok }, TODAY).ok, ok).toBe(true);
    }
    for (const bad of ["0.4999", "2.5001", "0", "10.34", "103.42", "abc", "", "1.03421", "-1"]) {
      expect(validateWageIndexEntry({ ...GOOD, factorDecimal: bad }, TODAY).ok, bad).toBe(false);
    }
  });

  it("requires a 6-character CCN and a 5-digit CBSA", () => {
    expect(validateWageIndexEntry({ ...GOOD, ccn: "38124" }, TODAY).ok).toBe(false);
    expect(validateWageIndexEntry({ ...GOOD, ccn: "3812401" }, TODAY).ok).toBe(false);
    expect(validateWageIndexEntry({ ...GOOD, ccn: "38 240" }, TODAY).ok).toBe(false);
    expect(validateWageIndexEntry({ ...GOOD, cbsaCode: "3890" }, TODAY).ok).toBe(false);
  });

  it("bounds the fiscal year: any past year, the current one, and next; not beyond", () => {
    expect(validateWageIndexEntry({ ...GOOD, fiscalYearStarting: 2010 }, TODAY).ok).toBe(true);
    expect(validateWageIndexEntry({ ...GOOD, fiscalYearStarting: 2026 }, TODAY).ok).toBe(true); // next FY
    expect(validateWageIndexEntry({ ...GOOD, fiscalYearStarting: 2027 }, TODAY).ok).toBe(false);
    expect(validateWageIndexEntry({ ...GOOD, fiscalYearStarting: 1999 }, TODAY).ok).toBe(false);
    expect(validateWageIndexEntry({ ...GOOD, fiscalYearStarting: 2025.5 }, TODAY).ok).toBe(false);
  });

  it("the fiscal-year window rolls with the clock at Oct 1", () => {
    // 2026-10-01 starts FY2027 (starting year 2026): next = 2027.
    expect(validateWageIndexEntry({ ...GOOD, fiscalYearStarting: 2027 }, "2026-10-01").ok).toBe(
      true,
    );
    expect(validateWageIndexEntry({ ...GOOD, fiscalYearStarting: 2028 }, "2026-10-01").ok).toBe(
      false,
    );
  });

  it("requires a non-blank source reference", () => {
    expect(validateWageIndexEntry({ ...GOOD, sourceReference: "" }, TODAY).ok).toBe(false);
    expect(validateWageIndexEntry({ ...GOOD, sourceReference: "   " }, TODAY).ok).toBe(false);
  });

  it("reports every error at once", () => {
    const r = validateWageIndexEntry(
      { ...GOOD, ccn: "x", factorDecimal: "99", sourceReference: "" },
      TODAY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(3);
  });
});

describe("resolveWageIndex — precedence", () => {
  const tenant = { factorDecimal: "1.0100", cbsaCode: "11111" };
  const platformAuth = { factorDecimal: "0.9900", cbsaCode: "22222", isAuthoritative: true };
  const placeholder = { factorDecimal: "1.0000", cbsaCode: null, isAuthoritative: false };

  it("prefers the tenant row over an authoritative platform row", () => {
    expect(resolveWageIndex({ tenant, platform: platformAuth })).toEqual({
      factorDecimal: "1.0100",
      cbsaCode: "11111",
      source: "tenant",
    });
  });
  it("falls back to an AUTHORITATIVE platform row", () => {
    expect(resolveWageIndex({ tenant: null, platform: platformAuth })).toEqual({
      factorDecimal: "0.9900",
      cbsaCode: "22222",
      source: "platform",
    });
  });
  it("NEVER falls back to a non-authoritative placeholder", () => {
    expect(resolveWageIndex({ tenant: null, platform: placeholder })).toBeNull();
  });
  it("a tenant row still wins over a placeholder", () => {
    expect(resolveWageIndex({ tenant, platform: placeholder })?.source).toBe("tenant");
  });
  it("returns null when nothing covers", () => {
    expect(resolveWageIndex({ tenant: null, platform: null })).toBeNull();
  });
});
