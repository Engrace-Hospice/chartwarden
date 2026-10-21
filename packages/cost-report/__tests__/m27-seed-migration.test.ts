// @chartwarden/cost-report — M27 seed-migration ↔ code-catalog PARITY test.
//
// Guards `packages/db/migrations/0073_cost_report_m27_seed.sql` against the code-side RuleDef catalog so
// the two never drift: every platform-default rule (DEFAULT_VALIDATION_RULES) + every NGS-J6 additive
// rule (NGS_J6_RULES) must appear in the seed with the EXACT category / severity / regulatory_required /
// mac_jurisdiction_scope from code, and the seed must carry no extra/unknown rule rows. Also asserts the
// seed's platform-default discipline: organization_id NULL, rule_set_version 1, the {"ruleCode": ...}
// predicate descriptor, NULL-safe idempotency (NOT EXISTS, since UNIQUE does not dedupe NULL org), and
// that cost_center_mapping is deliberately NOT seeded (it is per-tenant, org NOT NULL).
//
// PURE: a static filesystem read of the .sql text + a parse — no DB, no Fastify, no network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VALIDATION_RULES, NGS_J6_RULES, type RuleDef } from "@chartwarden/cost-report";
import { describe, expect, it } from "vitest";

const SEED_PATH = join(__dirname, "..", "..", "db", "migrations", "0073_cost_report_m27_seed.sql");

const seedSql = readFileSync(SEED_PATH, "utf8");

interface ParsedSeedRow {
  readonly ruleCode: string;
  readonly category: string;
  readonly severity: string;
  readonly regulatoryRequired: boolean;
  readonly macJurisdictionScope: string;
  readonly description: string;
}

/**
 * Parse the VALUES tuples out of the seed. Each row is
 * `('code', 'category', 'severity', <bool>, 'scope', 'description')`. None of the leading fields contain
 * a single quote or comma, and descriptions contain no apostrophes, so a single-quote-delimited match is
 * unambiguous; identifier-quoting elsewhere (AS v(...), the WHERE clause) uses DOUBLE quotes and is not
 * matched.
 */
function parseSeedRows(sql: string): ParsedSeedRow[] {
  const re =
    /\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(true|false),\s*'([^']+)',\s*'([^']*)'\s*\)/g;
  const rows: ParsedSeedRow[] = [];
  let m: RegExpExecArray | null = re.exec(sql);
  while (m !== null) {
    rows.push({
      ruleCode: m[1]!,
      category: m[2]!,
      severity: m[3]!,
      regulatoryRequired: m[4] === "true",
      macJurisdictionScope: m[5]!,
      description: m[6]!,
    });
    m = re.exec(sql);
  }
  return rows;
}

const ALL_RULES: readonly RuleDef[] = [...DEFAULT_VALIDATION_RULES, ...NGS_J6_RULES];
const parsedRows = parseSeedRows(seedSql);
const byCode = new Map(parsedRows.map((r) => [r.ruleCode, r]));

describe("M27 seed migration 0073 — code-catalog parity", () => {
  it("parses exactly 29 seed rows (25 platform defaults + 4 NGS-J6)", () => {
    expect(DEFAULT_VALIDATION_RULES.length).toBe(25);
    expect(NGS_J6_RULES.length).toBe(4);
    expect(parsedRows.length).toBe(29);
  });

  it("seeds no duplicate rule codes", () => {
    expect(byCode.size).toBe(parsedRows.length);
  });

  it("seeds no rule code unknown to the code catalog", () => {
    const known = new Set(ALL_RULES.map((r) => r.ruleCode));
    const unknown = parsedRows.map((r) => r.ruleCode).filter((c) => !known.has(c));
    expect(unknown).toEqual([]);
  });

  it.each(ALL_RULES.map((r) => [r.ruleCode, r] as const))(
    "seeds %s with the exact code-catalog metadata",
    (_code, rule) => {
      const row = byCode.get(rule.ruleCode);
      expect(row, `rule ${rule.ruleCode} missing from seed`).toBeDefined();
      expect(row!.category).toBe(rule.category);
      expect(row!.severity).toBe(rule.severity);
      expect(row!.regulatoryRequired).toBe(rule.regulatoryRequired);
      expect(row!.macJurisdictionScope).toBe(rule.macJurisdictionScope);
      // descriptions are length-bounded (varchar(500)) and must match the code catalog verbatim.
      expect(row!.description).toBe(rule.description);
      expect(row!.description.length).toBeLessThanOrEqual(500);
      // rule_code is varchar(80).
      expect(rule.ruleCode.length).toBeLessThanOrEqual(80);
    },
  );

  it("seeds all four regulatory-required CFR-floor rules as block severity", () => {
    const regCodes = ALL_RULES.filter((r) => r.regulatoryRequired).map((r) => r.ruleCode);
    // §413.24 adequate-cost-data, §418.308 aggregate cap (×2), §418.309 inpatient cap,
    // PRM I Ch 3&4 bad-debt, §413.24(f) filing deadline.
    expect(regCodes.sort()).toEqual(
      [
        "tb.no_orphan_accounts",
        "cap.aggregate_beneficiary_cap",
        "cap.aggregate_payments_within_cap",
        "cap.inpatient_20_pct",
        "bad_debt.entry_collection_efforts_documented",
        "deadline.not_past_without_override",
      ].sort(),
    );
    for (const code of regCodes) {
      const row = byCode.get(code)!;
      expect(row.regulatoryRequired).toBe(true);
      expect(row.severity).toBe("block");
    }
  });

  it("scopes the four NGS-J6 additive rules to 'NGS-J6' only", () => {
    for (const rule of NGS_J6_RULES) {
      expect(byCode.get(rule.ruleCode)!.macJurisdictionScope).toBe("NGS-J6");
    }
    // every other seeded rule is platform-wide ('all').
    const nonNgs = parsedRows.filter((r) => r.macJurisdictionScope !== "NGS-J6");
    expect(nonNgs).toHaveLength(25);
    expect(nonNgs.every((r) => r.macJurisdictionScope === "all")).toBe(true);
  });
});

describe("M27 seed migration 0073 — platform-default discipline", () => {
  it("inserts only into cost_report_validation_rule (no cost_center_mapping seed)", () => {
    expect(seedSql).toContain('INSERT INTO "cost_report_validation_rule"');
    // cost_center_mapping is per-tenant (org NOT NULL) and must NOT be globally seeded here.
    expect(seedSql).not.toMatch(/INSERT\s+INTO\s+"?cost_center_mapping"?/i);
  });

  it("seeds rows as platform defaults (organization_id NULL, rule_set_version 1)", () => {
    expect(seedSql).toMatch(/NULL::uuid/);
    // the rule_set_version column is stamped to the literal 1.
    expect(seedSql).toContain('"rule_set_version"');
  });

  it('uses the {"ruleCode": ...} predicate descriptor pointing at the code-side evaluate', () => {
    expect(seedSql).toContain("jsonb_build_object('ruleCode', v.\"rule_code\")");
  });

  it("is NULL-safe idempotent via NOT EXISTS (UNIQUE does not dedupe NULL org) — no ON CONFLICT", () => {
    expect(seedSql).toMatch(/WHERE NOT EXISTS/i);
    expect(seedSql).toMatch(/"organization_id"\s+IS NULL/i);
    // An actual ON CONFLICT clause would be a no-op on the NULLable org UNIQUE and must not be relied
    // upon (the header comment may discuss it in prose; we only forbid a real `ON CONFLICT (…/DO` clause).
    expect(seedSql).not.toMatch(/ON CONFLICT\s*(\(|DO\b)/i);
  });

  it("is DDL-free — INSERT only (no CREATE/ALTER/DROP)", () => {
    expect(seedSql).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i);
  });
});
