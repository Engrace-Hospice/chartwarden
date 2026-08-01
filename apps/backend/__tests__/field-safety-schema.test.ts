// M20-T02 — the DB-side / code-side drift guard for M20's thirteen owned tables.
//
// WHY IT LIVES HERE. The two facts this compares sit in packages that cannot see each other:
// `M20_AUDIT_DENYLIST` / `M20_AUDIT_RETENTION_CLASS` are in `@wardenx/types` (M20-T01) and the scrub that
// must obey them is PL/pgSQL inside `packages/db/migrations/0111`. `@wardenx/db` does not depend on
// `@wardenx/types`, so a test inside either package could only assert half of it — the same reason M19-T02's
// equivalent landed in `apps/backend/__tests__`.
//
// The failure this exists to catch is silent and one-directional: someone adds a PHI column to
// `safety_incident`, adds it to `M20_AUDIT_DENYLIST` (which is where a code reviewer looks), and the trigger
// keeps capturing the cleartext into an immutable audit row forever. Nothing else in the build compares the
// two.
//
// It additionally pins the handful of DDL decisions this task made that a later edit could quietly undo and
// no other gate would notice: the `emergency_terminus` membership in the SLA-watchdog index, the M20-F04
// three-column schedule key, the NULLS NOT DISTINCT on the subscription pair, the absence of any org-NULL
// row, and the active-SOS guard on the location stream.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  M20_AUDIT_DENYLIST,
  M20_AUDIT_RETENTION_CLASS,
  M20_TABLE_NAMES,
  type M20TableName,
  SAFETY_SOS_OPEN_STATES,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const tables = readFileSync(join(MIGRATIONS, "0110_field_safety_m20_enums_tables.sql"), "utf8");
const rls = readFileSync(
  join(MIGRATIONS, "0111_field_safety_m20_rls_audit_triggers.sql"),
  "utf8",
);

/** The §3.2 Phase-A enum types, incl. the `emergency_terminus` value M20-T01 added to close S13. */
const M20_ENUM_TYPES = [
  "safety_check_in_kind",
  "safety_check_in_status",
  "safety_check_in_state",
  "safety_sos_lifecycle_state",
  "safety_sos_cancel_status",
  "safety_incident_category",
  "safety_incident_severity",
  "safety_incident_state",
  "safety_high_risk_category",
  "safety_subscription_model",
  "safety_acknowledgment_target_kind",
  "safety_emergency_contact_consent_status",
] as const;

/** The trigger function 0111 generates per table. */
const AUDIT_FN: Record<M20TableName, string> = {
  safety_acknowledgment: "audit_phi_write_safety_acknowledgment",
  safety_check_in: "audit_phi_write_safety_check_in",
  safety_check_in_schedule: "audit_phi_write_safety_check_in_schedule",
  safety_emergency_contact_consent: "audit_phi_write_safety_emergency_contact_consent",
  safety_high_risk_area: "audit_phi_write_safety_high_risk_area",
  safety_incident: "audit_phi_write_safety_incident",
  safety_incident_state_history: "audit_phi_write_safety_incident_state_history",
  safety_policy: "audit_phi_write_safety_policy",
  safety_policy_version: "audit_phi_write_safety_policy_version",
  safety_sos_alert: "audit_phi_write_safety_sos_alert",
  safety_sos_alert_state_history: "audit_phi_write_safety_sos_alert_state_history",
  safety_sos_location_stream: "audit_phi_write_safety_sos_location_stream",
  safety_supervisor_subscription: "audit_phi_write_safety_supervisor_subscription",
};

/** The `v_cols` array literal from one generated trigger function body. */
function denylistOf(fn: string): string[] {
  const body = new RegExp(
    `CREATE OR REPLACE FUNCTION ${fn}\\(\\)[\\s\\S]*?v_cols text\\[\\] := ARRAY\\[([^\\]]*)\\]`,
  ).exec(rls);
  expect(body, `no generated audit trigger for ${fn}`).not.toBeNull();
  return (body?.[1] ?? "")
    .split(",")
    .map((c) => c.trim().replace(/^'|'$/g, ""))
    .filter((c) => c.length > 0);
}

/** The column list of one CREATE TABLE block (everything before its first `);`). */
function tableBody(name: string): string {
  const start = tables.indexOf(`CREATE TABLE IF NOT EXISTS "${name}"`);
  expect(start, `no CREATE TABLE for ${name}`).toBeGreaterThan(-1);
  const block = tables.slice(start);
  return block.slice(0, block.indexOf(");"));
}

describe("M20-T02 migration 0110 — the thirteen owned tables", () => {
  it("creates every §3.2 Phase-A enum type exactly once", () => {
    for (const t of M20_ENUM_TYPES) {
      const hits = tables.match(new RegExp(`CREATE TYPE "public"\\."${t}" AS ENUM`, "g")) ?? [];
      expect(hits.length, `enum ${t}`).toBe(1);
    }
  });

  it("carries the `emergency_terminus` state §2.2.2 / S13 needs", () => {
    expect(tables).toContain("'escalation_tier_3', 'emergency_terminus', 'resolving'");
  });

  it("creates all thirteen manifest tables", () => {
    expect(M20_TABLE_NAMES).toHaveLength(13);
    for (const t of M20_TABLE_NAMES) {
      expect(tables, `table ${t}`).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
    }
  });

  it("gives every table organization_id NOT NULL — M20 has NO org-NULL row (M20-F03)", () => {
    for (const t of M20_TABLE_NAMES) {
      expect(tableBody(t), t).toContain('"organization_id" uuid NOT NULL');
    }
    // The dangerous shape ADR-0010 D3 forbids must not appear in either migration's DDL. Comments are
    // stripped first — both headers DISCUSS the shape at length, which is the point of them.
    expect(tables.replace(/--[^\n]*/g, "")).not.toMatch(/organization_id\s+IS\s+NULL/i);
    expect(rls.replace(/--[^\n]*/g, "")).not.toMatch(/organization_id\s+IS\s+NULL/i);
  });

  it("gives the eight patient-joinable tables the three-column rule (PE NOT NULL + location)", () => {
    for (const t of [
      "safety_check_in_schedule",
      "safety_check_in",
      "safety_sos_alert",
      "safety_sos_location_stream",
      "safety_sos_alert_state_history",
      "safety_incident",
      "safety_incident_state_history",
      "safety_acknowledgment",
    ]) {
      const body = tableBody(t);
      expect(body, t).toContain('"provider_entity_id" uuid NOT NULL');
      expect(body, t).toContain('"location_id" uuid');
    }
  });

  it("keys the check-in schedule on (visit_id, kind, expected_at) — M20-F04", () => {
    // Without expected_at a 2-hour visit cannot carry more than one mid_visit row, and D3/§7.1's
    // cadence — the module's core feature — is unbuildable.
    expect(tables).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "scis_visit_kind_expected_uniq" ON "safety_check_in_schedule" ("visit_id","kind","expected_at") WHERE visit_id IS NOT NULL`,
    );
  });

  it("scans `emergency_terminus` in the SLA-watchdog index", () => {
    // An index over only the three tier states leaves the terminus unscanned, which is exactly how an
    // unacknowledged 3 a.m. SOS stops re-escalating (M20-F05 / S13).
    const idx = tables.slice(tables.indexOf('"ssa_sla_scan_idx"'));
    expect(idx.slice(0, idx.indexOf(";"))).toContain("'emergency_terminus'");
  });

  it("makes the active-subscription pair unique with NULLS NOT DISTINCT", () => {
    // Three of the four key columns are nullable; under default NULL semantics two identical
    // location-scoped rows both insert and the supervisor is paged twice for every alert.
    expect(tables).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "sss_active_pair_uniq" ON "safety_supervisor_subscription" ("supervisor_membership_id","clinician_membership_id","location_id","provider_entity_id") NULLS NOT DISTINCT WHERE superseded_at IS NULL AND deactivated_at IS NULL`,
    );
  });

  it("enforces D9's OSHA sign-off pair and the submit gate at the DB", () => {
    expect(tables).toContain(`CONSTRAINT "m20_si_osha_signoff_pair"`);
    expect(tables).toContain(`CONSTRAINT "m20_si_osha_signoff_required"`);
  });

  it("enforces the acknowledgment's exactly-one-target rule in BOTH directions", () => {
    const c = tables.slice(tables.indexOf(`CONSTRAINT "m20_sack_one_target"`));
    const body = c.slice(0, c.indexOf("),\n"));
    // Each branch pins the discriminator AND the FK — a row cannot claim one kind and point at another.
    for (const kind of ["sos_alert", "incident", "overdue_check_in"]) {
      expect(body, kind).toContain(`"target_kind" = '${kind}'`);
    }
  });

  it("ships no PostGIS and no partitioning (M20-F07 / the 0110 header)", () => {
    const stripped = tables.replace(/--[^\n]*/g, "");
    expect(stripped).not.toMatch(/postgis|geometry\s*\(|ST_Within|ST_IsValid|USING\s+GIST/i);
    expect(stripped).not.toMatch(/PARTITION BY/i);
  });
});

describe("M20-T02 migration 0111 — RLS, grants and the M4 write-audit denylists", () => {
  it("enables RLS on all thirteen tables and keys every policy on app.org_id alone", () => {
    for (const t of M20_TABLE_NAMES) {
      expect(rls, t).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(rls, t).toContain(`CREATE POLICY "${t}_org"`);
    }
    for (const s of rls.match(/current_setting\(\s*'app\.[a-z_]+'/g) ?? []) {
      // The only non-org vars permitted are the M4 audit ATTRIBUTION context (ADR-0010 D2).
      expect(s).toMatch(/'app\.(org_id|user_id|correlation_id|provider_entity_id|location_id)'/);
    }
  });

  it("never grants DELETE to wardenx_app, and no UPDATE on the four append-only tables", () => {
    const grants = rls.split("\n").filter((l) => /^GRANT/.test(l) && /wardenx_app/.test(l));
    expect(grants.length).toBe(13);
    for (const g of grants) expect(g).not.toMatch(/\bDELETE\b/);
    for (const t of [
      "safety_policy_version",
      "safety_sos_location_stream",
      "safety_sos_alert_state_history",
      "safety_incident_state_history",
    ]) {
      expect(rls, t).toContain(`GRANT SELECT, INSERT ON "${t}" TO wardenx_app;`);
    }
  });

  it("mirrors M20_AUDIT_DENYLIST into the generated trigger bodies VERBATIM", () => {
    for (const t of M20_TABLE_NAMES) {
      expect(denylistOf(AUDIT_FN[t]), t).toEqual([...M20_AUDIT_DENYLIST[t]]);
    }
  });

  it("stamps the M20_AUDIT_RETENTION_CLASS on every table's audit row", () => {
    for (const t of M20_TABLE_NAMES) {
      const fnBody = rls.slice(rls.indexOf(`CREATE OR REPLACE FUNCTION ${AUDIT_FN[t]}()`));
      const upToEnd = fnBody.slice(0, fnBody.indexOf("END $$;"));
      expect(upToEnd, t).toContain(`'${M20_AUDIT_RETENTION_CLASS[t]}'`);
      expect(upToEnd, t).toContain(`'${t}.' || lower(TG_OP)`);
    }
  });

  it("stamps `safety_check_in` compliance — the SAFER side of a row-conditional class", () => {
    // §3.7 files SOS-bracketed rows compliance and routine `ok` rows operational; the M4 generator takes
    // no row predicate, so under-retaining would take the check-ins that BRACKET an SOS.
    expect(M20_AUDIT_RETENTION_CLASS.safety_check_in).toBe("compliance");
    // …and the purge that reclaims the routine rows must have an index to run on.
    expect(tables).toContain(
      `WHERE is_part_of_sos_bracket = false AND status = 'ok'`,
    );
  });

  it("does NOT scrub the fields a surveyor or insurer reads", () => {
    for (const c of ["lifecycle_state", "cancel_status", "outcome"]) {
      expect(M20_AUDIT_DENYLIST.safety_sos_alert).not.toContain(c);
    }
    for (const c of ["category", "severity", "osha_reportable", "lifecycle_state"]) {
      expect(M20_AUDIT_DENYLIST.safety_incident).not.toContain(c);
    }
    // The retention ROUTER: a trail that cannot say which class a row was filed under cannot prove the
    // purge was lawful.
    expect(M20_AUDIT_DENYLIST.safety_check_in).not.toContain("is_part_of_sos_bracket");
    // The one thing a consent dispute turns on.
    expect(M20_AUDIT_DENYLIST.safety_emergency_contact_consent).not.toContain(
      "acknowledgment_text_snapshot",
    );
  });

  it("guards the location stream on the FULL open-state set, terminus included (§2.3 / §8.7)", () => {
    const guard = rls.slice(rls.indexOf("CREATE OR REPLACE FUNCTION m20_enforce_sos_stream_active"));
    const body = guard.slice(0, guard.indexOf("END $$;"));
    for (const s of SAFETY_SOS_OPEN_STATES) expect(body, s).toContain(`'${s}'`);
    // Fails CLOSED: an unknown parent (or one RLS hides) raises rather than inserting.
    expect(body).toContain("M20_SOS_STREAM_UNKNOWN_ALERT");
    expect(guard).toContain("BEFORE INSERT ON safety_sos_location_stream");
  });
});
