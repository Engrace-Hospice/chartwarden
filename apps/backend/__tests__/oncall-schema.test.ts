// M19-T02 — the DB-side / code-side drift guard for M19's ten owned tables.
//
// WHY IT LIVES HERE. The two facts this compares sit in packages that cannot see each other:
// `M19_AUDIT_DENYLIST` / `M19_AUDIT_RETENTION_CLASS` are in `@wardenx/types` (M19-T01) and the scrub that
// must obey them is PL/pgSQL inside `packages/db/migrations/0108`. `@wardenx/db` does not depend on
// `@wardenx/types`, so a test inside either package could only assert half of it. apps/backend imports both
// — the same reason M19-T01's pgEnum↔union lock-step test landed in `oncall-contracts.test.ts`.
//
// The failure this exists to catch is silent and one-directional: someone adds a PHI column to
// `triage_call`, adds it to `M19_AUDIT_DENYLIST` (which is where a code reviewer looks), and the trigger
// keeps capturing the cleartext into an immutable audit row forever. Nothing else in the build compares
// the two.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type M19TableName,
  M19_AUDIT_DENYLIST,
  M19_AUDIT_RETENTION_CLASS,
  M19_TABLE_NAMES,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const tables = readFileSync(join(MIGRATIONS, "0107_oncall_m19_enums_tables.sql"), "utf8");
const rls = readFileSync(join(MIGRATIONS, "0108_oncall_m19_rls_audit_triggers.sql"), "utf8");

/** The original ten M19-T01 tables migrations 0107/0108 created — `on_call_roster_sync_queue`
 *  (F-165, #248) is a later addition (migration 0256, its own separate trigger) this file's
 *  0107/0108-scoped checks below cannot see. */
const M19_T01_TABLE_NAMES = M19_TABLE_NAMES.filter(
  (t): t is Exclude<M19TableName, "on_call_roster_sync_queue"> => t !== "on_call_roster_sync_queue",
);

/** The §3.2 Phase-A enum types, incl. the `paper_origin` value M19-T01 added to make §2.7 implementable. */
const M19_ENUM_TYPES = [
  "oncall_model",
  "oncall_shift_status",
  "oncall_shift_discipline",
  "triage_call_state",
  "triage_call_caller_kind",
  "triage_call_inbound_channel",
  "triage_call_source",
  "triage_disposition",
  "triage_escalation_tier",
  "triage_escalation_trigger",
  "triage_protocol_answer_type",
  "triage_risk_band",
  "triage_ai_confidence",
] as const;

/** The trigger function name 0108 generates per table (abbreviated where the 63-char limit bites).
 *  `on_call_roster_sync_queue` (F-165, #248) is excluded — it's a later addition (migration 0256), whose
 *  own trigger this file's `tables`/`rls` reads (pinned to 0107/0108) cannot see. */
const AUDIT_FN: Record<Exclude<M19TableName, "on_call_roster_sync_queue">, string> = {
  tenant_oncall_policy: "audit_phi_write_tenant_oncall_policy",
  external_triage_vendor: "audit_phi_write_external_triage_vendor",
  on_call_shift: "audit_phi_write_on_call_shift",
  triage_protocol: "audit_phi_write_triage_protocol",
  triage_protocol_question: "audit_phi_write_triage_protocol_question",
  triage_call: "audit_phi_write_triage_call",
  triage_call_answer: "audit_phi_write_triage_call_answer",
  triage_escalation: "audit_phi_write_triage_escalation",
  triage_call_state_history: "audit_phi_write_triage_call_state_history",
  triage_paper_reentry_worklist: "audit_phi_write_triage_paper_reentry",
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

describe("M19-T02 migration 0107 — the ten owned tables", () => {
  it("creates every §3.2 Phase-A enum type exactly once", () => {
    for (const t of M19_ENUM_TYPES) {
      const hits = tables.match(new RegExp(`CREATE TYPE "public"\\."${t}" AS ENUM`, "g")) ?? [];
      expect(hits.length, `enum ${t}`).toBe(1);
    }
  });

  it("carries the `paper_origin` source §2.7 needs and the CHECK that pins it to the flag", () => {
    expect(tables).toContain("'m36_delivery_failure', 'paper_origin'");
    expect(tables).toContain(
      `CONSTRAINT "m19_triage_call_paper_origin_pair" CHECK (("source" = 'paper_origin') = "paper_origin_flag")`,
    );
  });

  it("creates all ten manifest tables", () => {
    expect(M19_T01_TABLE_NAMES).toHaveLength(10);
    for (const t of M19_T01_TABLE_NAMES) {
      expect(tables, `table ${t}`).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
    }
  });

  it("gives every call table the three-column rule (org NOT NULL + PE NOT NULL + location)", () => {
    for (const t of [
      "triage_call",
      "triage_call_answer",
      "triage_escalation",
      "triage_call_state_history",
    ]) {
      const block = tables.slice(tables.indexOf(`CREATE TABLE IF NOT EXISTS "${t}"`));
      const body = block.slice(0, block.indexOf(");"));
      expect(body, t).toContain('"organization_id" uuid NOT NULL');
      expect(body, t).toContain('"provider_entity_id" uuid NOT NULL');
      expect(body, t).toContain('"location_id" uuid');
    }
  });

  it("keeps the two uniqueness guarantees partitioning would have destroyed", () => {
    // D10 / §2.6 — one call per inbound outbox event.
    expect(tables).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "triage_call_source_dedupe_uq" ON "triage_call" ("source_outbox_event_id") WHERE source_outbox_event_id IS NOT NULL`,
    );
    // §2.2.3 — one ORIGINAL answer per question per call; corrections are additional rows.
    expect(tables).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "triage_call_answer_latest_per_q_uq" ON "triage_call_answer" ("triage_call_id","triage_protocol_question_id") WHERE correction_of_answer_id IS NULL`,
    );
    // …which is only true while nothing here is partitioned (see the 0107 header).
    expect(tables.replace(/--[^\n]*/g, "")).not.toMatch(/PARTITION BY/i);
  });

  it("makes the D4 platform floor unwritable in BOTH directions", () => {
    for (const t of ["triage_protocol", "triage_protocol_question"]) {
      expect(tables, t).toContain(`CONSTRAINT "m19_${t}_floor_orgless"`);
      expect(tables, t).toContain(`CONSTRAINT "m19_${t}_tenant_has_org"`);
    }
  });
});

describe("M19-T02 migration 0108 — RLS, grants and the M4 write-audit denylists", () => {
  it("enables RLS on all ten tables and keys every policy on app.org_id alone", () => {
    for (const t of M19_T01_TABLE_NAMES) {
      expect(rls, t).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(rls, t).toMatch(new RegExp(`CREATE POLICY "${t}_(org|read)"`));
    }
    for (const s of rls.match(/current_setting\(\s*'app\.[a-z_]+'/g) ?? []) {
      // The only non-org vars permitted are the M4 audit ATTRIBUTION context (ADR-0010 D2).
      expect(s).toMatch(/'app\.(org_id|user_id|correlation_id|provider_entity_id|location_id)'/);
    }
  });

  it("never grants DELETE to wardenx_app, and no UPDATE on the two append-only tables", () => {
    const grants = rls.split("\n").filter((l) => /^GRANT/.test(l) && /wardenx_app/.test(l));
    expect(grants.length).toBe(10);
    for (const g of grants) expect(g).not.toMatch(/\bDELETE\b/);
    for (const t of ["triage_call_answer", "triage_call_state_history"]) {
      expect(rls, t).toContain(`GRANT SELECT, INSERT ON "${t}" TO wardenx_app;`);
    }
  });

  it("mirrors M19_AUDIT_DENYLIST into the generated trigger bodies VERBATIM", () => {
    for (const t of M19_T01_TABLE_NAMES) {
      expect(denylistOf(AUDIT_FN[t]), t).toEqual([...M19_AUDIT_DENYLIST[t]]);
    }
  });

  it("stamps the M19_AUDIT_RETENTION_CLASS on every table's audit row", () => {
    for (const t of M19_T01_TABLE_NAMES) {
      const fnBody = rls.slice(rls.indexOf(`CREATE OR REPLACE FUNCTION ${AUDIT_FN[t]}()`));
      const upToEnd = fnBody.slice(0, fnBody.indexOf("END $$;"));
      expect(upToEnd, t).toContain(`'${M19_AUDIT_RETENTION_CLASS[t]}'`);
      expect(upToEnd, t).toContain(`'${t}.' || lower(TG_OP)`);
    }
  });

  it("does NOT scrub red_flag_hit — the D5 suppression-investigation evidence", () => {
    expect(M19_AUDIT_DENYLIST.triage_call_answer).not.toContain("red_flag_hit");
    expect(denylistOf(AUDIT_FN.triage_call_answer)).toEqual(["answer_value_text"]);
  });

  it("encodes §2.2.1's transition table as a whitelist, incl. the two legal 'backwards' moves", () => {
    const guard = rls.slice(rls.indexOf("m19_enforce_triage_call_forward_state"));
    // The §2.3 documented exception: the caller rang back.
    expect(guard).toContain(
      `WHEN 'awaiting_callback' THEN ARRAY['protocol_in_progress','abandoned']`,
    );
    // The move a rank ordering would have silently forbidden.
    expect(guard).toContain(
      `WHEN 'escalated_unresolved' THEN ARRAY['documented_pending_encounter','abandoned']`,
    );
    // Terminal states have no outgoing transitions.
    expect(guard).toContain("ELSE ARRAY[]::text[]");
    expect(guard).toContain("BEFORE UPDATE OF state ON triage_call");
  });
});
