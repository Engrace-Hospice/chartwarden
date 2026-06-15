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
    for (const role of ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"]) {
      expect(rls).toContain(`CREATE ROLE ${role} NOLOGIN`);
    }
  });

  it("partitions audit_event by range and provides the monthly rotation helper", () => {
    expect(rls).toContain("PARTITION BY RANGE");
    expect(rls).toContain("FUNCTION create_audit_partition");
  });

  it("isolates the only NULL-org branch to the read-only global-flag policy", () => {
    // The global-read policy is SELECT-only and lives apart from any writable policy.
    expect(globalRead).toContain('FOR SELECT TO wardenx_app');
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

// LIVE cross-tenant isolation — un-skipped by M1-T12 once the Testcontainers PG
// harness lands. Documented here so the proof obligation is visible in the slice.
describe.skip("M1-T04 RLS cross-tenant isolation (live PG — owned by M1-T12 §7.2)", () => {
  it("denies SELECT of org A rows under org B context", async () => {
    // withOrgContext(orgA, db => insert row); withOrgContext(orgB, db => expect 0 rows).
  });
  it("rejects a tenant-context write to a global (org-NULL) feature_flag", async () => {
    // withOrgContext(orgB, db => insert feature_flag with organization_id NULL) → throws.
  });
});
