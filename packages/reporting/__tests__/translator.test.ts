// @wardenx/reporting — translator + spec-validator UNIT TESTS (M33 §2.3 / §4, D4 + D6 + D8).
//
// The PHI-safety crown jewel: prove the spec→SQL pipeline has NO raw-SQL surface and NO string
// interpolation of tenant values. These suites are pure — they NEVER touch a DB. They drive the real
// `packages/reporting/src/translator/*` functions against in-memory base-catalog fixtures and assert:
//   • semantic validation throws the exact §2.3 codes (DIMENSION/MEASURE_NOT_IN_BASE, FILTER_TYPE_MISMATCH,
//     ROW_LIMIT_EXCEEDED, BASE_NOT_ACTIVE) with the canonical HTTP status,
//   • every tenant value lands in params[] as a bound `$n` (never spliced into SQL text),
//   • the scope envelope injects a parameterized, bound, fail-closed predicate,
//   • a valid spec compiles to a SELECT through the SECURITY DEFINER wrapper FUNCTION
//     report_mv.select_<mvKey>(p_org_id) — NOT a direct MV select,
//   • a `registered`-MV base yields a forward-seam deny-stub (not SQL),
//   • injection attempts in an alias (quoteIdent regex) or a filter value (bound param) are neutralized.
import type { schema } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import {
  type ReportableScopeEnvelope,
  type TranslatorBaseCatalog,
  compileFilters,
  injectScope,
  quoteIdent,
  translateSpec,
  validateSpecAgainstBase,
} from "../src/translator/index";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

const ORG_ID = "00000000-0000-0000-0000-000000000aaa";

const DIMENSIONS: schema.DimensionCatalog[] = [
  { dimensionKey: "service_date", displayName: "Service Date", dataType: "date" },
  { dimensionKey: "team_name", displayName: "Team", dataType: "string" },
  { dimensionKey: "is_active", displayName: "Active", dataType: "boolean" },
  { dimensionKey: "region_id", displayName: "Region", dataType: "uuid" },
  { dimensionKey: "los_days", displayName: "LOS Days", dataType: "number" },
];

const MEASURES: schema.MeasureCatalog[] = [
  {
    measureKey: "census_count",
    displayName: "Census",
    metricKey: "m.census",
    unit: "count",
    aggregation: "sum",
  },
  {
    measureKey: "avg_los",
    displayName: "Avg LOS",
    metricKey: "m.los",
    unit: "days",
    aggregation: "avg",
  },
];

function makeBase(overrides: Partial<TranslatorBaseCatalog> = {}): TranslatorBaseCatalog {
  return {
    baseKey: "census_daily",
    status: "active",
    mvKey: "census_daily",
    mvSchemaName: "report_mv",
    mvStatus: "active",
    dimensions: DIMENSIONS,
    measures: MEASURES,
    maxRowLimit: 5000,
    drilldownUrlTemplate: "/patients?date={service_date}",
    ...overrides,
  };
}

function makeSpec(
  overrides: Partial<schema.ReportDefinitionSpec> = {},
): schema.ReportDefinitionSpec {
  return {
    dimensions: [{ dimensionKey: "team_name" }],
    measures: [{ measureKey: "census_count" }],
    filters: [],
    ...overrides,
  };
}

const DIM_TYPES = new Map<string, schema.DimensionCatalog["dataType"]>(
  DIMENSIONS.map((d) => [d.dimensionKey, d.dataType]),
);

// ── (A) spec-validator — §2.3 semantic codes ─────────────────────────────────────────────────────

describe("validateSpecAgainstBase — §2.3 semantic validation", () => {
  it("accepts a well-formed spec and returns the effective row limit", () => {
    const out = validateSpecAgainstBase(makeSpec({ rowLimit: 250 }), makeBase());
    expect(out.effectiveRowLimit).toBe(250);
  });

  it("defaults rowLimit to 1000 when the spec omits it", () => {
    const out = validateSpecAgainstBase(makeSpec(), makeBase());
    expect(out.effectiveRowLimit).toBe(1000);
  });

  it("throws BASE_NOT_ACTIVE / 409 for a non-active base", () => {
    expect(() => validateSpecAgainstBase(makeSpec(), makeBase({ status: "seeded" }))).toThrowError(
      expect.objectContaining({ code: "BASE_NOT_ACTIVE", statusCode: 409 }),
    );
  });

  it("throws DIMENSION_NOT_IN_BASE / 422 for a dimension absent from the base", () => {
    const spec = makeSpec({ dimensions: [{ dimensionKey: "ssn" }] });
    expect(() => validateSpecAgainstBase(spec, makeBase())).toThrowError(
      expect.objectContaining({ code: "DIMENSION_NOT_IN_BASE", statusCode: 422 }),
    );
  });

  it("throws MEASURE_NOT_IN_BASE / 422 for a measure absent from the base", () => {
    const spec = makeSpec({ measures: [{ measureKey: "patient_name" }] });
    expect(() => validateSpecAgainstBase(spec, makeBase())).toThrowError(
      expect.objectContaining({ code: "MEASURE_NOT_IN_BASE", statusCode: 422 }),
    );
  });

  it("throws DIMENSION_NOT_IN_BASE for a filter referencing an unknown dimension", () => {
    const spec = makeSpec({
      filters: [{ dimensionKey: "ssn", comparator: "eq", value: "x" }],
    });
    expect(() => validateSpecAgainstBase(spec, makeBase())).toThrowError(
      expect.objectContaining({ code: "DIMENSION_NOT_IN_BASE", statusCode: 422 }),
    );
  });

  it("throws FILTER_TYPE_MISMATCH / 422 when a comparator is illegal for the dimension type (in on date)", () => {
    const spec = makeSpec({
      filters: [{ dimensionKey: "service_date", comparator: "in", value: ["2026-01-01"] }],
    });
    expect(() => validateSpecAgainstBase(spec, makeBase())).toThrowError(
      expect.objectContaining({ code: "FILTER_TYPE_MISMATCH", statusCode: 422 }),
    );
  });

  it("throws FILTER_TYPE_MISMATCH when a between is used on a string dimension", () => {
    const spec = makeSpec({
      filters: [{ dimensionKey: "team_name", comparator: "between", value: ["A", "B"] }],
    });
    expect(() => validateSpecAgainstBase(spec, makeBase())).toThrowError(
      expect.objectContaining({ code: "FILTER_TYPE_MISMATCH" }),
    );
  });

  it("throws FILTER_TYPE_MISMATCH when the value SHAPE does not match the comparator arity (eq with array)", () => {
    const spec = makeSpec({
      // comparator legal for string, but value is an array → arity mismatch.
      filters: [{ dimensionKey: "team_name", comparator: "eq", value: ["A", "B"] }],
    });
    expect(() => validateSpecAgainstBase(spec, makeBase())).toThrowError(
      expect.objectContaining({ code: "FILTER_TYPE_MISMATCH" }),
    );
  });

  it("accepts a legal typed filter (between on a date dimension)", () => {
    const spec = makeSpec({
      filters: [
        {
          dimensionKey: "service_date",
          comparator: "between",
          value: ["2026-01-01", "2026-02-01"],
        },
      ],
    });
    expect(() => validateSpecAgainstBase(spec, makeBase())).not.toThrow();
  });

  it("throws ROW_LIMIT_EXCEEDED / 422 when rowLimit exceeds the base max", () => {
    const spec = makeSpec({ rowLimit: 9000 }); // base max is 5000
    expect(() => validateSpecAgainstBase(spec, makeBase())).toThrowError(
      expect.objectContaining({ code: "ROW_LIMIT_EXCEEDED", statusCode: 422 }),
    );
  });
});

// ── (B) filter-compiler — bound params only, per-comparator SQL, column whitelist ─────────────────

describe("compileFilters — every value binds as $n, never interpolated", () => {
  it("binds an eq scalar as $1 and never inlines the value", () => {
    const out = compileFilters(
      [{ dimensionKey: "team_name", comparator: "eq", value: "Alpha" }],
      DIM_TYPES,
      1,
    );
    expect(out.sql).toBe('t."team_name" = $1');
    expect(out.params).toEqual(["Alpha"]);
    expect(out.nextIndex).toBe(2);
    expect(out.sql).not.toContain("Alpha");
  });

  it("emits the correct SQL operator for each scalar comparator (ne/lt/le/gt/ge)", () => {
    const cases: { comparator: schema.FilterComparator; op: string }[] = [
      { comparator: "ne", op: "<>" },
      { comparator: "lt", op: "<" },
      { comparator: "le", op: "<=" },
      { comparator: "gt", op: ">" },
      { comparator: "ge", op: ">=" },
    ];
    for (const c of cases) {
      const out = compileFilters(
        [{ dimensionKey: "los_days", comparator: c.comparator, value: 30 }],
        DIM_TYPES,
        1,
      );
      expect(out.sql).toBe(`t."los_days" ${c.op} $1`);
      expect(out.params).toEqual([30]);
    }
  });

  it("expands an IN list into one bound placeholder per member", () => {
    const out = compileFilters(
      [{ dimensionKey: "team_name", comparator: "in", value: ["A", "B", "C"] }],
      DIM_TYPES,
      1,
    );
    expect(out.sql).toBe('t."team_name" IN ($1, $2, $3)');
    expect(out.params).toEqual(["A", "B", "C"]);
    expect(out.nextIndex).toBe(4);
  });

  it("emits NOT IN for not_in", () => {
    const out = compileFilters(
      [{ dimensionKey: "team_name", comparator: "not_in", value: ["A", "B"] }],
      DIM_TYPES,
      1,
    );
    expect(out.sql).toBe('t."team_name" NOT IN ($1, $2)');
    expect(out.params).toEqual(["A", "B"]);
  });

  it("binds both bounds of a BETWEEN", () => {
    const out = compileFilters(
      [
        {
          dimensionKey: "service_date",
          comparator: "between",
          value: ["2026-01-01", "2026-02-01"],
        },
      ],
      DIM_TYPES,
      1,
    );
    expect(out.sql).toBe('t."service_date" BETWEEN $1 AND $2');
    expect(out.params).toEqual(["2026-01-01", "2026-02-01"]);
    expect(out.nextIndex).toBe(3);
  });

  it("emits IS NULL / IS NOT NULL with NO bound params", () => {
    const a = compileFilters([{ dimensionKey: "los_days", comparator: "is_null" }], DIM_TYPES, 1);
    expect(a.sql).toBe('t."los_days" IS NULL');
    expect(a.params).toEqual([]);
    expect(a.nextIndex).toBe(1);

    const b = compileFilters(
      [{ dimensionKey: "los_days", comparator: "is_not_null" }],
      DIM_TYPES,
      1,
    );
    expect(b.sql).toBe('t."los_days" IS NOT NULL');
    expect(b.params).toEqual([]);
  });

  it("chains placeholder indices across multiple filters from the given startIndex", () => {
    const out = compileFilters(
      [
        { dimensionKey: "team_name", comparator: "eq", value: "Alpha" },
        { dimensionKey: "los_days", comparator: "in", value: [10, 20] },
      ],
      DIM_TYPES,
      2, // SQL step reserves $1 for p_org_id
    );
    expect(out.sql).toBe('t."team_name" = $2 AND t."los_days" IN ($3, $4)');
    expect(out.params).toEqual(["Alpha", 10, 20]);
    expect(out.nextIndex).toBe(5);
  });

  it("rejects a filter on a non-whitelisted column with COLUMN_NOT_WHITELISTED / 500", () => {
    expect(() =>
      compileFilters([{ dimensionKey: "ssn", comparator: "eq", value: "x" }], DIM_TYPES, 1),
    ).toThrowError(expect.objectContaining({ code: "COLUMN_NOT_WHITELISTED", statusCode: 500 }));
  });

  it("never interpolates a malicious value — it binds as a param verbatim", () => {
    const evil = "Alpha'; DROP TABLE patient;--";
    const out = compileFilters(
      [{ dimensionKey: "team_name", comparator: "eq", value: evil }],
      DIM_TYPES,
      1,
    );
    expect(out.sql).toBe('t."team_name" = $1');
    expect(out.sql).not.toContain("DROP TABLE");
    expect(out.params).toEqual([evil]);
  });
});

// ── (C) scope-injector — parameterized, bound, fail-closed (D8) ───────────────────────────────────

describe("injectScope — reportable_scope envelope binds ids, never interpolates", () => {
  const baseEnv: ReportableScopeEnvelope = { scopeKind: "org", organizationId: ORG_ID };

  it("org scope adds NO predicate (the MV wrapper already scopes to the org)", () => {
    const out = injectScope({ ...baseEnv, scopeKind: "org" }, 5);
    expect(out.sql).toBeNull();
    expect(out.params).toEqual([]);
    expect(out.nextIndex).toBe(5);
  });

  it("self scope binds membership ids as $n on the membership_id column", () => {
    const out = injectScope(
      { ...baseEnv, scopeKind: "self", membershipIds: ["mem-1", "mem-2"] },
      5,
    );
    expect(out.sql).toBe('t."membership_id" IN ($5, $6)');
    expect(out.params).toEqual(["mem-1", "mem-2"]);
    expect(out.nextIndex).toBe(7);
    expect(out.sql).not.toContain("mem-1");
  });

  it("team scope binds the supervised membership set on membership_id", () => {
    const out = injectScope({ ...baseEnv, scopeKind: "team", membershipIds: ["mem-9"] }, 2);
    expect(out.sql).toBe('t."membership_id" IN ($2)');
    expect(out.params).toEqual(["mem-9"]);
  });

  it("location scope binds the location set on location_id", () => {
    const out = injectScope(
      { ...baseEnv, scopeKind: "location", locationIds: ["loc-a", "loc-b"] },
      3,
    );
    expect(out.sql).toBe('t."location_id" IN ($3, $4)');
    expect(out.params).toEqual(["loc-a", "loc-b"]);
    expect(out.sql).not.toContain("loc-a");
  });

  it("fails CLOSED — an empty membership set yields FALSE (deny), never 'match all'", () => {
    const out = injectScope({ ...baseEnv, scopeKind: "self", membershipIds: [] }, 5);
    expect(out.sql).toBe("FALSE");
    expect(out.params).toEqual([]);
  });

  it("fails CLOSED — an empty location set yields FALSE", () => {
    const out = injectScope({ ...baseEnv, scopeKind: "location", locationIds: [] }, 5);
    expect(out.sql).toBe("FALSE");
    expect(out.params).toEqual([]);
  });
});

// ── (D) sql-translator — wrapper FUNCTION, deny-stub, injection neutralization ─────────────────────

describe("translateSpec — composed parameterized SELECT via the MV wrapper FUNCTION", () => {
  const orgScope: ReportableScopeEnvelope = { scopeKind: "org", organizationId: ORG_ID };

  it("compiles a valid spec to a SELECT through report_mv.select_<mvKey>(p_org_id) with org as $1", () => {
    const t = translateSpec(makeSpec({ rowLimit: 100 }), makeBase(), orgScope);
    expect(t.kind).toBe("sql");
    if (t.kind !== "sql") throw new Error("expected sql");
    expect(t.sql).toContain('FROM "report_mv"."select_census_daily"($1) AS t');
    expect(t.params[0]).toBe(ORG_ID);
    expect(t.mvKey).toBe("census_daily");
    // LIMIT binds (no inlined integer).
    expect(t.sql).toMatch(/LIMIT \$\d+$/);
    expect(t.params[t.params.length - 1]).toBe(100);
  });

  it("NEVER selects the MV directly — it always goes through the select_ wrapper function", () => {
    const t = translateSpec(makeSpec(), makeBase(), orgScope);
    if (t.kind !== "sql") throw new Error("expected sql");
    // A direct MV select would be `FROM "report_mv"."census_daily"` (no select_ prefix, no call).
    expect(t.sql).not.toMatch(/FROM\s+"report_mv"\."census_daily"/);
    expect(t.sql).toContain('"select_census_daily"($1)');
  });

  it("aggregates measures and GROUP BYs the dimensions (aggregate-by-default, D6)", () => {
    const t = translateSpec(
      makeSpec({
        dimensions: [{ dimensionKey: "team_name" }],
        measures: [{ measureKey: "census_count" }],
      }),
      makeBase(),
      orgScope,
    );
    if (t.kind !== "sql") throw new Error("expected sql");
    expect(t.sql).toContain('SUM(t."census_count") AS "census_count"');
    expect(t.sql).toContain('GROUP BY t."team_name"');
  });

  it("threads filters ($2…) then scope then LIMIT into a single bound param array", () => {
    const t = translateSpec(
      makeSpec({
        filters: [{ dimensionKey: "team_name", comparator: "eq", value: "Alpha" }],
        rowLimit: 50,
      }),
      makeBase(),
      { scopeKind: "self", organizationId: ORG_ID, membershipIds: ["mem-1"] },
    );
    if (t.kind !== "sql") throw new Error("expected sql");
    // org($1), filter value($2), scope id($3), limit($4)
    expect(t.params).toEqual([ORG_ID, "Alpha", "mem-1", 50]);
    expect(t.sql).toContain('t."team_name" = $2');
    expect(t.sql).toContain('t."membership_id" IN ($3)');
    expect(t.sql).toContain("LIMIT $4");
  });

  it("returns a forward-seam DENY-STUB (not SQL) when the MV status is 'registered'", () => {
    const t = translateSpec(makeSpec(), makeBase({ mvStatus: "registered" }), orgScope);
    expect(t.kind).toBe("deny_stub");
    if (t.kind !== "deny_stub") throw new Error("expected deny_stub");
    expect(t.isForwardSeamDenyStub).toBe(true);
    expect(t.mvKey).toBe("census_daily");
    expect("sql" in t).toBe(false);
  });

  it("still rejects a malformed spec BEFORE the deny-stub gate (validation runs first)", () => {
    const spec = makeSpec({ dimensions: [{ dimensionKey: "ssn" }] });
    expect(() => translateSpec(spec, makeBase({ mvStatus: "registered" }), orgScope)).toThrowError(
      expect.objectContaining({ code: "DIMENSION_NOT_IN_BASE" }),
    );
  });

  it("neutralizes an injection attempt in a dimension ALIAS via the quoteIdent regex guard", () => {
    const spec = makeSpec({
      dimensions: [{ dimensionKey: "team_name", alias: 'team"; DROP TABLE patient;--' }],
    });
    expect(() => translateSpec(spec, makeBase(), orgScope)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_IDENTIFIER", statusCode: 500 }),
    );
  });

  it("neutralizes an injection attempt in a FILTER VALUE by binding it as a param (never in SQL text)", () => {
    const evil = "x'; DROP TABLE patient;--";
    const t = translateSpec(
      makeSpec({ filters: [{ dimensionKey: "team_name", comparator: "eq", value: evil }] }),
      makeBase(),
      orgScope,
    );
    if (t.kind !== "sql") throw new Error("expected sql");
    expect(t.sql).not.toContain("DROP TABLE");
    expect(t.params).toContain(evil);
    expect(t.sql).toContain('t."team_name" = $2');
  });

  it("rejects a sort key that is not a projected output column (SORT_KEY_NOT_IN_OUTPUT)", () => {
    const spec = makeSpec({ sort: [{ by: "los_days", direction: "desc" }] });
    expect(() => translateSpec(spec, makeBase(), orgScope)).toThrowError(
      expect.objectContaining({ code: "SORT_KEY_NOT_IN_OUTPUT", statusCode: 422 }),
    );
  });

  it("carries the base drilldown template through on a SQL translation", () => {
    const t = translateSpec(makeSpec(), makeBase(), orgScope);
    if (t.kind !== "sql") throw new Error("expected sql");
    expect(t.drilldownUrlTemplate).toBe("/patients?date={service_date}");
  });
});

// ── (E) quoteIdent — the whitelist's last mile ────────────────────────────────────────────────────

describe("quoteIdent — only lower-snake identifiers reach SQL text", () => {
  it("double-quotes a safe identifier", () => {
    expect(quoteIdent("service_date")).toBe('"service_date"');
  });

  it.each([
    'team"; DROP TABLE patient;--',
    "team name",
    "Team_Name", // upper-case rejected (lower-snake only)
    "1team",
    "team;",
    "",
  ])("throws UNSAFE_IDENTIFIER for %j", (bad) => {
    expect(() => quoteIdent(bad)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_IDENTIFIER", statusCode: 500 }),
    );
  });
});
