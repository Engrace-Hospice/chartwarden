/**
 * M1-T04 — RLS / append-only migration assertions (DRAFT toward M1-T12 §7.2).
 *
 * Two layers:
 *   1. STATIC (runs now, gate-green): parse the generated migrations and assert the
 *      tenancy-critical shapes are present — RLS enabled on every tenant-scoped table,
 *      every policy keyed on the canonical `app.org_id` var, the audit_event
 *      append-only grant (no UPDATE/DELETE to wardenx_app), and the four DB roles.
 *   2. LIVE (skipped until M1-T12): the cross-tenant denial proof on a real Postgres
 *      (Testcontainers) — set org A context, insert a row, switch to org B context,
 *      assert the row is invisible and a write under B's context is rejected. T12 owns
 *      the Testcontainers harness (PG + Valkey) and un-skips this block.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..");
const rls = readFileSync(join(MIGRATIONS, "0001_foundation_rls_roles_partitioning.sql"), "utf8");
const globalRead = readFileSync(join(MIGRATIONS, "0002_feature_flag_global_read.sql"), "utf8");
const m2 = readFileSync(join(MIGRATIONS, "0006_identity_m2_rls_audit_triggers.sql"), "utf8");
const m3 = readFileSync(join(MIGRATIONS, "0009_authorization_m3_rls_audit_triggers.sql"), "utf8");
const m3TemplateRead = readFileSync(
  join(MIGRATIONS, "0010_authorization_role_template_read.sql"),
  "utf8",
);
const m4Tables = readFileSync(join(MIGRATIONS, "0011_audit_m4_tables.sql"), "utf8");
const m4 = readFileSync(join(MIGRATIONS, "0012_audit_m4_rls_grants.sql"), "utf8");

const CANONICAL_VAR = "app.org_id";
const RLS_TABLES = [
  "organization",
  "provider_entity",
  "location",
  "membership",
  "audit_event",
  "feature_flag",
  "idempotency_key",
  "outbox_event",
];

describe("M1-T04 migration: RLS + append-only (static)", () => {
  it("enables row-level security on every tenant-scoped table", () => {
    for (const t of RLS_TABLES) {
      expect(rls).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    }
  });

  it("keys every policy on the canonical app.org_id session variable", () => {
    const settings = rls.match(/current_setting\(\s*'([^']+)'/g) ?? [];
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) {
      expect(s).toContain(CANONICAL_VAR);
    }
  });

  it("keeps audit_event append-only — no UPDATE/DELETE granted to wardenx_app", () => {
    expect(rls).toContain('GRANT INSERT, SELECT ON "audit_event" TO wardenx_app');
    // Inspect the actual GRANT statements (split on `;`, ignore comments) that target
    // audit_event for wardenx_app — none may carry UPDATE or DELETE.
    const grants = rls
      .split(";")
      .map((s) => s.replace(/--[^\n]*/g, "").trim())
      .filter((s) => /^GRANT\b/i.test(s) && /"audit_event"/.test(s) && /wardenx_app/.test(s));
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g).not.toMatch(/\bUPDATE\b/i);
      expect(g).not.toMatch(/\bDELETE\b/i);
    }
  });

  it("creates the four database roles", () => {
    for (const role of [
      "wardenx_app",
      "wardenx_admin",
      "wardenx_readonly",
      "wardenx_audit_writer",
    ]) {
      expect(rls).toContain(`CREATE ROLE ${role} NOLOGIN`);
    }
  });

  it("partitions audit_event by range and provides the monthly rotation helper", () => {
    expect(rls).toContain("PARTITION BY RANGE");
    expect(rls).toContain("FUNCTION create_audit_partition");
  });

  it("isolates the only NULL-org branch to the read-only global-flag policy", () => {
    // The global-read policy is SELECT-only and lives apart from any writable policy.
    expect(globalRead).toContain("FOR SELECT TO wardenx_app");
    expect(globalRead).not.toMatch(/WITH\s+CHECK/i);
    expect(globalRead).not.toMatch(/FOR\s+ALL/i);
  });
});

describe("M2-T02 migration: identity RLS + audit triggers (static)", () => {
  // Org-scoped M2 tables get standard tenant isolation on the canonical var.
  const ORG_SCOPED = ["organization_invitation", "tenant_step_up_policy_override"];
  // User-owned, cross-org auth credentials — un-RLS'd (M1 user/session/account pattern).
  const USER_OWNED = ["two_factor", "passkey"];

  it("enables RLS + an app.org_id isolation policy on every org-scoped M2 table", () => {
    for (const t of ORG_SCOPED) {
      expect(m2).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(m2).toContain(`CREATE POLICY "${t}_org_isolation" ON "${t}"`);
    }
  });

  it("keys every M2 policy on the canonical app.org_id session variable", () => {
    const settings = m2.match(/current_setting\(\s*'([^']+)'/g) ?? [];
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) expect(s).toContain(CANONICAL_VAR);
  });

  it("does NOT place user-owned auth credentials under RLS (cross-org by design)", () => {
    for (const t of USER_OWNED)
      expect(m2).not.toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  });

  it("attaches the M1 write-audit trigger to all four M2 tables", () => {
    for (const t of [...ORG_SCOPED, ...USER_OWNED]) {
      expect(m2).toContain(`CREATE TRIGGER "${t}_audit" AFTER INSERT OR UPDATE OR DELETE ON ${t}`);
      expect(m2).toContain("EXECUTE FUNCTION wardenx_audit_trigger()");
    }
  });
});

describe("M3-T04 migration: authorization RLS + audit triggers (static · §3.6)", () => {
  // All five org-scoped M3 tables get RLS + a write-audit trigger. `permission` is the
  // platform-global, read-only catalog mirror (no org column → no RLS).
  const ORG_SCOPED = [
    "role",
    "role_permission",
    "membership_role",
    "break_glass_event",
    "auditor_engagement",
  ];

  it("enables RLS + an app.org_id isolation policy on every org-scoped M3 table", () => {
    for (const t of ORG_SCOPED) {
      expect(m3).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(m3).toContain(`CREATE POLICY "${t}_org" ON "${t}"`);
    }
  });

  it("keys every M3 policy on the canonical app.org_id session variable", () => {
    const settings = (m3 + m3TemplateRead).match(/current_setting\(\s*'([^']+)'/g) ?? [];
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) expect(s).toContain(CANONICAL_VAR);
  });

  it("never admits a NULL org in a tenant-writable M3 policy (no OR ... IS NULL in 0009)", () => {
    expect(m3.replace(/--[^\n]*/g, "")).not.toMatch(/IS\s+NULL/i);
  });

  it("isolates the platform-template (org-NULL) READ branch to a SELECT-only policy", () => {
    // The 0010 file is the single permitted `organization_id IS NULL` shape for M3, and it
    // carries no WITH CHECK / FOR ALL — templates are readable but not tenant-writable.
    // Assert on the executable SQL only (strip `--` comments, which discuss those shapes).
    const sql = m3TemplateRead.replace(/--[^\n]*/g, "");
    for (const t of ["role", "role_permission"]) {
      expect(sql).toContain(`CREATE POLICY "${t}_template_read" ON "${t}"`);
    }
    expect(sql).toContain("FOR SELECT TO wardenx_app");
    expect(sql).toMatch(/IS\s+NULL/i);
    expect(sql).not.toMatch(/WITH\s+CHECK/i);
    expect(sql).not.toMatch(/FOR\s+ALL/i);
  });

  it("does NOT place the read-only permission catalog mirror under RLS", () => {
    expect(m3).not.toContain('ALTER TABLE "permission" ENABLE ROW LEVEL SECURITY');
    expect(m3).toContain('GRANT SELECT ON "permission" TO wardenx_app');
  });

  it("attaches the baseline write-audit trigger to every org-scoped M3 table", () => {
    for (const t of ORG_SCOPED) {
      expect(m3).toContain(`CREATE TRIGGER "${t}_audit" AFTER INSERT OR UPDATE OR DELETE ON ${t}`);
    }
    expect(m3).toContain("EXECUTE FUNCTION wardenx_audit_trigger()");
  });
});

describe("M4-T05 migration: audit RLS + append-only + immutability (static · §3.6/§3.7/§12.3)", () => {
  // The four genuinely org-scoped M4 lifecycle/integrity tables get RLS + a policy.
  const ORG_SCOPED = ["legal_hold", "destruction_certificate", "audit_export", "audit_seal"];
  // Platform-reference catalogs: NON_ORG_SCOPED (check-tenancy allowlist) → no RLS, read-all.
  const PLATFORM_REF = [
    "state_retention_override",
    "audit_denylist_catalog",
    "audit_action_catalog",
  ];

  it("enables RLS + an app.org_id isolation policy on every org-scoped M4 table", () => {
    for (const t of ORG_SCOPED) {
      expect(m4).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(m4).toContain(`CREATE POLICY "${t}_org" ON "${t}"`);
    }
  });

  it("keys every M4 policy on the canonical app.org_id session variable", () => {
    const settings = m4.match(/current_setting\(\s*'([^']+)'/g) ?? [];
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) expect(s).toContain(CANONICAL_VAR);
  });

  it("never admits a NULL org in a tenant-writable M4 policy (no OR ... IS NULL in 0012)", () => {
    // audit_seal carries a nullable org (platform-scope partitions), but the writable policy
    // keys strictly on equality — a NULL row never matches, so it is unreachable to tenants.
    expect(m4.replace(/--[^\n]*/g, "")).not.toMatch(/IS\s+NULL/i);
  });

  // Strip `--` line comments BEFORE splitting on `;` — SQL comments legitimately contain
  // semicolons (e.g. state-machine prose), which would otherwise fragment a statement.
  const m4Statements = m4
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim());

  it("keeps audit_seal append-only — INSERT/SELECT only, no UPDATE/DELETE to wardenx_app", () => {
    const grants = m4Statements.filter(
      (s) => /^GRANT\b/i.test(s) && /"audit_seal"/.test(s) && /\bwardenx_app\b/.test(s),
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g).not.toMatch(/\bUPDATE\b/i);
      expect(g).not.toMatch(/\bDELETE\b/i);
    }
  });

  it("wires the deferred audit_event INSERT grant to wardenx_audit_writer (§3.7 step 2)", () => {
    // 0001 created the role but deferred this grant to "M4's migration" (0001 line 9).
    expect(m4).toContain('GRANT INSERT ON "audit_event" TO wardenx_audit_writer');
    // …and M4 never widens wardenx_app's audit_event grant beyond the 0001 INSERT/SELECT.
    const appAudit = m4Statements.filter(
      (s) => /^GRANT\b/i.test(s) && /"audit_event"/.test(s) && /\bwardenx_app\b/.test(s),
    );
    for (const g of appAudit) {
      expect(g).not.toMatch(/\bUPDATE\b/i);
      expect(g).not.toMatch(/\bDELETE\b/i);
    }
  });

  it("ships the IMMUTABLE audit_scrub() denylist helper (§3.7 step 3)", () => {
    expect(m4).toMatch(/CREATE OR REPLACE FUNCTION audit_scrub\(doc jsonb, denylist text\[\]\)/);
    expect(m4).toMatch(/LANGUAGE sql IMMUTABLE/);
  });

  it("does NOT place the platform-reference catalogs under RLS; grants them read-only", () => {
    for (const t of PLATFORM_REF) {
      expect(m4).not.toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(m4).toContain(`GRANT SELECT ON "${t}" TO wardenx_app`);
      expect(m4).toContain(`REVOKE INSERT, UPDATE, DELETE ON "${t}" FROM wardenx_app`);
    }
  });

  it("attaches the baseline write-audit trigger to every M4 table (org-scoped + catalog)", () => {
    for (const t of [...ORG_SCOPED, ...PLATFORM_REF]) {
      expect(m4).toContain(`CREATE TRIGGER "${t}_audit" AFTER INSERT OR UPDATE OR DELETE ON ${t}`);
    }
    expect(m4).toContain("EXECUTE FUNCTION wardenx_audit_trigger()");
  });

  it("creates all seven M4 ownedTables in 0011 (tables migration)", () => {
    for (const t of [...ORG_SCOPED, ...PLATFORM_REF]) {
      expect(m4Tables).toContain(`CREATE TABLE "${t}"`);
    }
  });
});

// ── Tracked §12.3 immutability obligations gated on a real Postgres (M4-T11 / live harness) ──
describe("M4-T05 — deferred immutability proof obligation (infra-gated)", () => {
  // §12.3: wardenx_app UPDATE/DELETE on audit_event raises a permission error — provable only
  // against a real engine with grants applied (the static draft above proves the GRANT shape).
  it.todo("§12.3 live: wardenx_app UPDATE/DELETE on audit_event → permission denied");
  // (Phase 2) the audit_seal hash chain breaks on any simulated row modification.
  it.todo("§12.3 live: audit_seal chain verification fails after a tampered seal row");
});

// LIVE cross-tenant isolation against a real Postgres is now implemented in
// rls-isolation.live.test.ts (applies the migrations, exercises the policies as the
// unprivileged wardenx_app role). It runs when CHARTWARDEN_TEST_DATABASE_URL is set
// (CI `rls-live` job); the previous empty `describe.skip` placeholder is removed —
// an empty skipped block reads as "covered" when it asserted nothing.
