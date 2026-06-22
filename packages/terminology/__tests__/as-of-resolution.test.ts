// @wardenx/terminology — M38-T04 unit tests (spec §2.1, §7.1–7.2; §9.1 ≥95% on as-of).
//
// Proves the pure as-of resolution engine without live infra:
//   • INCLUSION  — effectiveDate <= asOf <= endDate, inclusive upper bound (§2.5, §2.4.1).
//   • AS-OF (§7.1) — a since-retired code still resolves active at its service date; today's
//     read sees the deprecated/removed reality. Two versions coexist; older never deleted (§7.2).
//   • PRECEDENCE — overlapping coexisting rows resolve to the most-recently-effective one,
//     deterministically regardless of input order.
//   • VALIDATE   — the §7.1 status→validity mapping incl. deprecation successor passthrough.
//   • BATCH      — the lookupBatch hot path resolves each code at one shared asOf.
import { describe, expect, it } from "vitest";
import {
  type ConceptCandidate,
  type DeprecationMappingResponse,
  type ResolvedConcept,
  includesAsOf,
  isUsableStatus,
  normalizeAsOf,
  resolveAsOf,
  resolveBatchAsOf,
  toIsoDate,
  toValidateResult,
} from "../src/index";

// ── Fixtures: an ICD-10-CM code loaded in two coexisting versions (§7.2) ──────────────
// E11.9 active 2022→2023 in the 2022 version, then deprecated (end-dated 2024-09-30) in the
// 2024 version with a successor. The two rows coexist; neither is deleted.
function icd(
  overrides: Partial<ConceptCandidate<"icd10cm">> & { code: string; effectiveDate: string },
): ConceptCandidate<"icd10cm"> {
  return {
    systemId: "icd10cm",
    display: overrides.display ?? "placeholder",
    status: overrides.status ?? "active",
    endDate: overrides.endDate ?? null,
    properties: overrides.properties ?? { isBillableLeaf: true, chapter: null, parentCode: null },
    ...overrides,
  };
}

const RETIRED_2024: ConceptCandidate<"icd10cm">[] = [
  icd({
    code: "X-RETIRED",
    display: "Active until 2024",
    status: "active",
    effectiveDate: "2022-10-01",
    endDate: "2023-09-30",
  }),
  icd({
    code: "X-RETIRED",
    display: "Retired in 2024",
    status: "retired",
    effectiveDate: "2023-10-01",
    endDate: "2024-09-30",
  }),
];

const SUCCESSOR: DeprecationMappingResponse = {
  deprecatedCode: "X-RETIRED",
  deprecationEffective: "2024-10-01",
  successorCodes: ["X-NEW"],
  mappingKind: "equivalent",
  guidance: "Use X-NEW from FY2025.",
};

describe("toIsoDate / normalizeAsOf", () => {
  it("renders a Date as a UTC YYYY-MM-DD calendar day", () => {
    expect(toIsoDate(new Date("2024-06-15T23:30:00Z"))).toBe("2024-06-15");
  });

  it("normalizeAsOf passes an explicit date through unchanged", () => {
    expect(normalizeAsOf(new Date("2023-06-15T00:00:00Z"))).toBe("2023-06-15");
  });

  it("normalizeAsOf defaults to today when omitted", () => {
    expect(normalizeAsOf()).toBe(toIsoDate(new Date()));
  });
});

describe("includesAsOf — §2.5 inclusion, inclusive upper bound (§2.4.1)", () => {
  const row = { effectiveDate: "2023-01-01", endDate: "2023-12-31" };

  it("is true inside the range", () => {
    expect(includesAsOf(row, "2023-06-15")).toBe(true);
  });

  it("is true on the effectiveDate boundary (inclusive lower)", () => {
    expect(includesAsOf(row, "2023-01-01")).toBe(true);
  });

  it("is true on the endDate boundary (inclusive upper — the retired-at-service-date case)", () => {
    expect(includesAsOf(row, "2023-12-31")).toBe(true);
  });

  it("is false before effectiveDate", () => {
    expect(includesAsOf(row, "2022-12-31")).toBe(false);
  });

  it("is false after endDate", () => {
    expect(includesAsOf(row, "2024-01-01")).toBe(false);
  });

  it("treats a null endDate as still-current (open-ended)", () => {
    expect(includesAsOf({ effectiveDate: "2023-01-01", endDate: null }, "2099-01-01")).toBe(true);
  });
});

describe("resolveAsOf — §7.1 as-of honored, §7.2 versions coexist", () => {
  it("resolves the active 2023 row for a 2023 service date even after 2024 loads", () => {
    const r = resolveAsOf(RETIRED_2024, new Date("2023-06-15T00:00:00Z"));
    expect(r?.status).toBe("active");
    expect(r?.display).toBe("Active until 2024");
  });

  it("resolves the retired row for an asOf inside its end-dated range (historical read)", () => {
    const r = resolveAsOf(RETIRED_2024, new Date("2024-06-15T00:00:00Z"));
    expect(r?.status).toBe("retired");
    expect(r?.display).toBe("Retired in 2024");
  });

  it("returns null for an asOf earlier than any loaded version (§7.10 NOT_FOUND)", () => {
    expect(resolveAsOf(RETIRED_2024, new Date("2020-01-01T00:00:00Z"))).toBeNull();
  });

  it("returns null for an asOf after every row's endDate", () => {
    expect(resolveAsOf(RETIRED_2024, new Date("2025-01-01T00:00:00Z"))).toBeNull();
  });

  it("returns null for an empty candidate set", () => {
    expect(
      resolveAsOf([] as ConceptCandidate<"icd10cm">[], new Date("2024-01-01T00:00:00Z")),
    ).toBeNull();
  });

  it("picks the most-recently-effective row when versions overlap, regardless of input order", () => {
    const overlap: ConceptCandidate<"icd10cm">[] = [
      icd({ code: "E11.9", display: "v2022", effectiveDate: "2022-10-01", endDate: null }),
      icd({ code: "E11.9", display: "v2024", effectiveDate: "2024-10-01", endDate: null }),
    ];
    expect(resolveAsOf(overlap, new Date("2025-01-01T00:00:00Z"))?.display).toBe("v2024");
    // reversed input — selection is order-independent
    expect(resolveAsOf([...overlap].reverse(), new Date("2025-01-01T00:00:00Z"))?.display).toBe(
      "v2024",
    );
  });

  it("breaks an effectiveDate tie toward the later (or open) endDate", () => {
    const tie: ConceptCandidate<"icd10cm">[] = [
      icd({
        code: "E11.9",
        display: "ends-soon",
        effectiveDate: "2024-01-01",
        endDate: "2024-06-30",
      }),
      icd({ code: "E11.9", display: "open", effectiveDate: "2024-01-01", endDate: null }),
    ];
    expect(resolveAsOf(tie, new Date("2024-03-01T00:00:00Z"))?.display).toBe("open");
  });

  it("defaults asOf to today when omitted", () => {
    const current: ConceptCandidate<"icd10cm">[] = [
      icd({ code: "E11.9", display: "current", effectiveDate: "2000-01-01", endDate: null }),
    ];
    expect(resolveAsOf(current)?.display).toBe("current");
  });
});

describe("resolveBatchAsOf — §4.5 lookupBatch hot path", () => {
  const batch: ConceptCandidate<"icd10cm">[] = [
    ...RETIRED_2024,
    icd({ code: "A00", display: "Cholera", effectiveDate: "2015-10-01", endDate: null }),
  ];

  it("resolves each code at one shared asOf", () => {
    const m = resolveBatchAsOf(batch, new Date("2023-06-15T00:00:00Z"));
    expect(m.get("X-RETIRED")?.display).toBe("Active until 2024");
    expect(m.get("A00")?.display).toBe("Cholera");
    expect(m.size).toBe(2);
  });

  it("omits codes with no row covering the asOf", () => {
    const m = resolveBatchAsOf(batch, new Date("2016-01-01T00:00:00Z"));
    expect(m.has("X-RETIRED")).toBe(false); // X-RETIRED's earliest row starts 2022
    expect(m.get("A00")?.display).toBe("Cholera");
    expect(m.size).toBe(1);
  });

  it("returns an empty map for no candidates", () => {
    expect(resolveBatchAsOf([] as ConceptCandidate<"icd10cm">[]).size).toBe(0);
  });
});

describe("isUsableStatus — §2.4.1 / §7.1", () => {
  it("active and deprecated are usable; retired is not", () => {
    expect(isUsableStatus("active")).toBe(true);
    expect(isUsableStatus("deprecated")).toBe(true);
    expect(isUsableStatus("retired")).toBe(false);
  });
});

describe("toValidateResult — §7.1 status→validity mapping", () => {
  function resolved(status: ResolvedConcept<"icd10cm">["status"]): ResolvedConcept<"icd10cm"> {
    return icd({ code: "X-RETIRED", status, effectiveDate: "2023-01-01" });
  }

  it("null resolution → { valid: false } with no status", () => {
    expect(toValidateResult(null)).toEqual({ valid: false });
  });

  it("active → valid true, no successor even if one is supplied", () => {
    expect(toValidateResult(resolved("active"), SUCCESSOR)).toEqual({
      valid: true,
      status: "active",
    });
  });

  it("deprecated → valid true with successor passthrough (§7.1)", () => {
    expect(toValidateResult(resolved("deprecated"), SUCCESSOR)).toEqual({
      valid: true,
      status: "deprecated",
      successor: SUCCESSOR,
    });
  });

  it("deprecated with no mapping → valid true, status only", () => {
    expect(toValidateResult(resolved("deprecated"))).toEqual({
      valid: true,
      status: "deprecated",
    });
  });

  it("retired → valid false, status retired, successor when mapped", () => {
    expect(toValidateResult(resolved("retired"), SUCCESSOR)).toEqual({
      valid: false,
      status: "retired",
      successor: SUCCESSOR,
    });
  });

  it("§7.1 end-to-end: same code, valid at 2023 service date, invalid/deprecated today", () => {
    const at2023 = toValidateResult(resolveAsOf(RETIRED_2024, new Date("2023-06-15T00:00:00Z")));
    expect(at2023).toEqual({ valid: true, status: "active" });

    const atRetirement = toValidateResult(
      resolveAsOf(RETIRED_2024, new Date("2024-06-15T00:00:00Z")),
      SUCCESSOR,
    );
    expect(atRetirement).toEqual({ valid: false, status: "retired", successor: SUCCESSOR });
  });
});
