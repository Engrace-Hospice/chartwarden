/**
 * M1-T05 — RLS policy generator (spec §3.13).
 *
 * Accept criterion: "generates a policy that the tenancy check accepts." We assert
 * the generated DDL against the SAME invariants check-tenancy.ts enforces (ADR-0010):
 *   - canonical session variable is ONLY `app.org_id` (Rule 2),
 *   - no null-org disjunction in a tenant-writable policy (Rule 3a),
 *   - exactly one all-command policy per table (Rule 3b).
 * Mirroring the gate's regexes here makes the test fail the moment the generator
 * drifts away from a shape the gate would accept.
 */
import { describe, expect, it } from "vitest";
import { generateRlsPolicy, generateRlsPolicyViaJoin } from "../src/rls";

// Lifted verbatim from scripts/check-tenancy.ts so the test tracks the real gate.
const SESSION_VAR_RE = /current_setting\(\s*['"]((?:app|wardenx)\.[a-z_]+)['"]/g;
const OR_IS_NULL_WRITE_RE = /\bOR\s+\w*organization_id\s+IS\s+NULL\b/i;
const FORALL_RE = /CREATE\s+POLICY\s+\w+\s+ON\s+(\w+)\s+FOR\s+ALL/gi;

/** Replays the gate's static rules against a generated SQL string. */
function tenancyGateAccepts(sql: string): boolean {
  SESSION_VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp.exec iteration idiom.
  while ((m = SESSION_VAR_RE.exec(sql))) {
    if (m[1] !== "app.org_id") return false; // Rule 2
  }
  if (OR_IS_NULL_WRITE_RE.test(sql) && /\bWITH\s+CHECK\b|\bFOR\s+ALL\b/i.test(sql)) {
    return false; // Rule 3a
  }
  const counts = new Map<string, number>();
  for (const p of sql.match(FORALL_RE) ?? []) {
    const t = /ON\s+(\w+)/i.exec(p)?.[1] ?? "";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  for (const n of counts.values()) if (n > 1) return false; // Rule 3b
  return true;
}

describe("generateRlsPolicy (M1-T05 §3.13)", () => {
  it("emits canonical RLS the tenancy gate accepts", () => {
    const sql = generateRlsPolicy({ tableName: "patient" });
    expect(tenancyGateAccepts(sql)).toBe(true);
    expect(sql).toContain("ALTER TABLE patient ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("CREATE POLICY patient_org_isolation ON patient");
    expect(sql).toContain("FOR ALL TO chartwarden_app");
    expect(sql).toContain("current_setting('app.org_id', true)::uuid");
    // symmetric USING + WITH CHECK so a tenant can neither read nor write cross-org.
    expect(sql).toContain(
      "WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)",
    );
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON patient TO chartwarden_app;");
  });

  it("default policy never carries the banned OR-IS-NULL write shape", () => {
    const sql = generateRlsPolicy({ tableName: "encounter" });
    expect(OR_IS_NULL_WRITE_RE.test(sql)).toBe(false);
  });

  it("honors overrides (org column, role, policy name)", () => {
    const sql = generateRlsPolicy({
      tableName: "observation",
      orgIdColumn: "org_id",
      appRole: "wardenx_reporting",
      policyName: "observation_tenant_iso",
    });
    expect(tenancyGateAccepts(sql)).toBe(true);
    expect(sql).toContain("CREATE POLICY observation_tenant_iso ON observation");
    expect(sql).toContain("FOR ALL TO wardenx_reporting");
    expect(sql).toContain("org_id = current_setting('app.org_id', true)::uuid");
  });

  it("never keys on a non-canonical session variable", () => {
    const sql = generateRlsPolicy({ tableName: "claim" });
    SESSION_VAR_RE.lastIndex = 0;
    const vars: string[] = [];
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp.exec iteration idiom.
    while ((m = SESSION_VAR_RE.exec(sql))) vars.push(m[1]!);
    expect(vars.length).toBeGreaterThan(0);
    expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
  });
});

describe("generateRlsPolicyViaJoin (M1-T05 §3.13)", () => {
  it("anchors the parent subquery on the canonical variable and the gate accepts it", () => {
    const sql = generateRlsPolicyViaJoin({
      tableName: "care_plan_revision",
      joinTable: "care_plan",
      joinFkColumn: "care_plan_id",
    });
    expect(tenancyGateAccepts(sql)).toBe(true);
    expect(sql).toContain("ALTER TABLE care_plan_revision ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("care_plan_id IN (");
    expect(sql).toContain("SELECT id FROM care_plan");
    expect(sql).toContain("organization_id = current_setting('app.org_id', true)::uuid");
  });
});
