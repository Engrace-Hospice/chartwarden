// @chartwarden/audit — M4-T07 unit tests (M4 spec §5.1, §5.2, §5.3; D10; W-M4-11).
//
// PHI denylist category behavior, layered on the M4-T02 trigger generator:
//   • §5.1 CATEGORY EXPANSION — named categories resolve to columns via the per-table catalog.
//   • §5.2 ROW-CONDITIONAL `sud_value` — `lab_observation_value.numeric_value`/`.string_value` are
//     scrubbed only when the parent observation was classified SUD at ingest; the generated
//     trigger gates the scrub with the catalog's `conditionalCheck` expression at runtime.
//   • §5.3 DEFENSE-IN-DEPTH — a `compliance_42cfr_part2` trigger scrubs `sud_value` even when the
//     call site never declared the category (W-M4-11).
import { describe, expect, it } from "vitest";
import {
  AUDIT_DENYLIST_CATALOG,
  type DenylistCatalogEntry,
  generateAuditTrigger,
  resolveCatalogDenylist,
} from "../src/index";

describe("resolveCatalogDenylist — §5.1 category → column expansion", () => {
  const catalog: readonly DenylistCatalogEntry[] = [
    { table: "patient", column: "ssn", category: "pii_high_sensitivity", registeredByModule: "m6" },
    { table: "patient", column: "mbi", category: "pii_high_sensitivity", registeredByModule: "m6" },
    {
      table: "lab_observation_value",
      column: "observation_value",
      category: "sud_value",
      conditionalCheck: "EXISTS (SELECT 1 FROM lab_observation lo WHERE lo.id = NEW.observation_id)",
      registeredByModule: "m29",
    },
  ];

  it("collapses static entries into a deduped, sorted column list", () => {
    const resolved = resolveCatalogDenylist({
      table: "patient",
      denylistCategories: ["pii_high_sensitivity"],
      catalog,
    });
    expect(resolved.staticColumns).toEqual(["mbi", "ssn"]);
    expect(resolved.conditional).toEqual([]);
  });

  it("groups row-conditional entries by their guard expression", () => {
    const resolved = resolveCatalogDenylist({
      table: "lab_observation_value",
      denylistCategories: ["sud_value"],
      catalog,
    });
    expect(resolved.staticColumns).toEqual([]);
    expect(resolved.conditional).toEqual([
      {
        check: "EXISTS (SELECT 1 FROM lab_observation lo WHERE lo.id = NEW.observation_id)",
        columns: ["observation_value"],
      },
    ]);
  });

  it("contributes nothing for a table/category the catalog doesn't register", () => {
    expect(resolveCatalogDenylist({ table: "patient", denylistCategories: ["sud_value"], catalog }))
      .toEqual({ staticColumns: [], conditional: [] });
    expect(resolveCatalogDenylist({ table: "patient", catalog })).toEqual({
      staticColumns: [],
      conditional: [],
    });
  });

  it("ships the canonical sud_value seed for lab_observation_value", () => {
    const seeds = AUDIT_DENYLIST_CATALOG.filter(
      (e) => e.table === "lab_observation_value" && e.category === "sud_value",
    );
    expect(seeds.map((s) => s.column).sort()).toEqual(["numeric_value", "string_value"]);
    for (const seed of seeds) {
      expect(seed.conditionalCheck).toContain("sud_redacted_at_ingest");
      expect(seed.registeredByModule).toBe("m29");
    }
  });
});

describe("generateAuditTrigger — §5.2 row-conditional sud_value scrub", () => {
  const ddl = generateAuditTrigger({
    table: "lab_observation_value",
    resourceKind: "lab_observation_value",
    denylistCategories: ["sud_value"],
  });

  it("declares a runtime denylist variable and gates the column behind the parent-class check", () => {
    expect(ddl).toContain("v_denylist text[] := ARRAY[]::text[];");
    expect(ddl).toContain("sud_redacted_at_ingest = true");
    expect(ddl).toContain("v_denylist := v_denylist || ARRAY['numeric_value', 'string_value']::text[];");
  });

  it("scrubs the before/after diff through the row-conditional denylist", () => {
    expect(ddl).toContain("audit_scrub(to_jsonb(OLD), v_denylist)");
    expect(ddl).toContain("audit_scrub(to_jsonb(NEW), v_denylist)");
  });

  it("leaves non-catalog tables on the static ARRAY literal (no runtime variable)", () => {
    const plain = generateAuditTrigger({
      table: "encounter",
      resourceKind: "encounter",
      denylist: ["narrative"],
    });
    expect(plain).not.toContain("v_denylist");
    expect(plain).toContain("audit_scrub(to_jsonb(NEW), ARRAY['narrative']::text[])");
  });
});

describe("generateAuditTrigger — §5.3 Part 2 defense-in-depth (W-M4-11)", () => {
  it("scrubs sud_value on a compliance_42cfr_part2 trigger even when the category is undeclared", () => {
    const ddl = generateAuditTrigger({
      table: "lab_observation_value",
      resourceKind: "lab_observation_value",
      retentionClass: "compliance_42cfr_part2",
      // NOTE: denylistCategories intentionally omitted — the retention class alone must imply it.
    });
    expect(ddl).toContain("'compliance_42cfr_part2'");
    expect(ddl).toContain("v_denylist := v_denylist || ARRAY['numeric_value', 'string_value']::text[];");
    expect(ddl).toContain("sud_redacted_at_ingest = true");
  });

  it("does not invent a sud_value scrub for a Part 2 table with no catalog entry", () => {
    const ddl = generateAuditTrigger({
      table: "lab_observation",
      resourceKind: "lab_observation",
      retentionClass: "compliance_42cfr_part2",
    });
    expect(ddl).toContain("'compliance_42cfr_part2'");
    expect(ddl).not.toContain("v_denylist");
    expect(ddl).toContain("audit_scrub(to_jsonb(NEW), ARRAY[]::text[])");
  });
});
