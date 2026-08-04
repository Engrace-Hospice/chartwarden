// M32-T02 — the DB-side / code-side drift guard for M32's thirteen owned tables.
//
// WHY IT LIVES HERE. The facts this compares sit in packages that cannot see each other:
// `M32_AUDIT_DENYLIST` / `M32_AUDIT_RETENTION_CLASS` / `M32_IMMUTABLE_COLUMNS` / `M32_TABLE_TENANCY` are
// in `@wardenx/types` (M32-T01) and the scrubs, policies and immutability triggers that must obey them
// are PL/pgSQL inside `packages/db/migrations/0113`–`0116`. `@wardenx/db` does not depend on
// `@wardenx/types`, so a test inside either package could only assert half of it. apps/backend imports
// both — the same reason M32-T01's pgEnum↔union lock-step test landed in `ai-platform-contracts.test.ts`.
//
// The failures this exists to catch are silent and one-directional: someone adds a PHI column to
// `ai_invocation` and to `M32_AUDIT_DENYLIST` (which is where a code reviewer looks) while the trigger
// keeps capturing the cleartext into an immutable audit row forever; or someone widens the frozen-column
// set in @wardenx/types without touching the trigger, so the constant claims a guarantee the database
// does not make. Nothing else in the build compares the two.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type M32TableName,
  M32_AUDIT_DENYLIST,
  M32_AUDIT_RETENTION_CLASS,
  M32_CIPHER_COLUMNS,
  M32_IMMUTABILITY_RULE,
  M32_IMMUTABLE_COLUMNS,
  M32_PARTITIONED_TABLES,
  M32_TABLE_NAMES,
  M32_TABLE_TENANCY,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const tables = readFileSync(join(MIGRATIONS, "0113_ai_platform_m32_enums_tables.sql"), "utf8");
const invocation = readFileSync(
  join(MIGRATIONS, "0114_ai_platform_m32_invocation_partitioned.sql"),
  "utf8",
);
const ledger = readFileSync(
  join(MIGRATIONS, "0115_ai_platform_m32_token_ledger_partitioned.sql"),
  "utf8",
);
const rls = readFileSync(join(MIGRATIONS, "0116_ai_platform_m32_rls_audit_triggers.sql"), "utf8");
/** Every M32 DDL file — a table lives in exactly one of the three. */
const ddl = `${tables}\n${invocation}\n${ledger}`;

/** The twenty-one §3.1 enum types. */
const M32_ENUM_TYPES = [
  "ai_capability_lifecycle_state",
  "ai_capability_risk_tier",
  "ai_capability_owning_role",
  "ai_fda_samd_classification",
  "ai_model_backend_kind",
  "ai_backend_health_status",
  "ai_prompt_template_status",
  "ai_tenant_opt_in_status",
  "ai_invocation_status",
  "ai_invocation_hitl_outcome",
  "ai_routing_decision",
  "ai_routing_reason",
  "ai_hallucination_severity",
  "ai_hallucination_kind",
  "ai_hallucination_triage_status",
  "ai_evaluation_run_stage",
  "ai_evaluation_run_status",
  "ai_evaluation_run_decision",
  "ai_kill_switch_reason",
  "ai_kill_switch_activation_actor_kind",
  "ai_lifecycle_approval_kind",
] as const;

/**
 * The eight tables 0116 gives a GENERATED audit function, and the function's name. The rule is stated
 * in the 0116 header and asserted below: a table gets one exactly when M1's baseline
 * `wardenx_audit_trigger()` would be WRONG — a non-empty §3.4 denylist (the baseline does not scrub), a
 * retention class other than the baseline's hard-coded 'compliance', or a PARTITIONED table (the
 * baseline stamps `TG_TABLE_NAME`, which on a partitioned write is the PARTITION).
 */
const GENERATED_AUDIT_FN: Partial<Record<M32TableName, string>> = {
  ai_capability_lifecycle_event: "audit_phi_write_ai_capability_lifecycle_event",
  ai_prompt_template: "audit_phi_write_ai_prompt_template",
  ai_invocation: "audit_phi_write_ai_invocation",
  ai_hallucination_report: "audit_phi_write_ai_hallucination_report",
  ai_tenant_opt_in_record: "audit_phi_write_ai_tenant_opt_in_record",
  ai_clinician_opt_out: "audit_phi_write_ai_clinician_opt_out",
  ai_routing_override: "audit_phi_write_ai_routing_override",
  ai_token_ledger: "audit_phi_write_ai_token_ledger",
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

/** The column block of one CREATE TABLE, across whichever DDL file owns it. */
function tableBody(t: M32TableName): string {
  const start = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${t}"`);
  expect(start, `table ${t} is not created in any M32 migration`).toBeGreaterThan(-1);
  const block = ddl.slice(start);
  // A partitioned table's block closes with `\n) PARTITION BY …`, an ordinary one with `\n);`.
  const ends = [block.indexOf("\n);"), block.indexOf("\n) PARTITION BY")].filter((i) => i > -1);
  expect(ends.length, `unterminated CREATE TABLE for ${t}`).toBeGreaterThan(0);
  return block.slice(0, Math.min(...ends));
}

describe("M32-T02 migrations 0113–0115 — the thirteen owned tables", () => {
  it("creates every §3.1 enum type exactly once", () => {
    expect(M32_ENUM_TYPES).toHaveLength(21);
    for (const t of M32_ENUM_TYPES) {
      const hits = ddl.match(new RegExp(`CREATE TYPE "public"\\."${t}" AS ENUM`, "g")) ?? [];
      expect(hits.length, `enum ${t}`).toBe(1);
    }
  });

  it("creates all thirteen manifest tables", () => {
    expect(M32_TABLE_NAMES).toHaveLength(13);
    for (const t of M32_TABLE_NAMES) {
      expect(ddl, `table ${t}`).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
    }
  });

  it("gives every tenant-scoped table organization_id NOT NULL and the platform-shared six none", () => {
    for (const t of M32_TABLE_NAMES) {
      const body = tableBody(t);
      const tenancy = M32_TABLE_TENANCY[t];
      if (tenancy === "platform_shared") {
        expect(body, `${t} is platform-shared`).not.toContain('"organization_id"');
      } else if (tenancy === "tenant_scoped") {
        expect(body, t).toContain('"organization_id" uuid NOT NULL');
      } else {
        // The one mixed table: the column exists and is NULLABLE — NULL is a platform-wide kill.
        expect(body, t).toContain('"organization_id" uuid,');
      }
    }
  });

  it("gives the two PHI-bearing tables the ARCH-011 three-column rule §3.2 omits", () => {
    for (const t of ["ai_invocation", "ai_hallucination_report"] as const) {
      const body = tableBody(t);
      expect(body, t).toContain('"organization_id" uuid NOT NULL');
      expect(body, t).toContain('"provider_entity_id" uuid NOT NULL');
      expect(body, t).toContain('"location_id" uuid');
    }
  });

  it("partitions exactly the two §3.8 tables, each on its own key, each in its own file", () => {
    expect(Object.keys(M32_PARTITIONED_TABLES).sort()).toEqual([
      "ai_invocation",
      "ai_token_ledger",
    ]);
    expect(invocation).toContain('PARTITION BY RANGE ("invoked_at")');
    expect(invocation).toContain('CONSTRAINT "ai_invocation_pkey" PRIMARY KEY ("id","invoked_at")');
    expect(ledger).toContain('PARTITION BY RANGE ("accrued_at")');
    expect(ledger).toContain('CONSTRAINT "ai_token_ledger_pkey" PRIMARY KEY ("id","accrued_at")');
    // The eleven tables in 0113 are keyed on `id` alone — a PARTITION BY there would make every one of
    // their PKs illegal under the same rule (check-ddl-legality derives one partition column per FILE).
    expect(tables.replace(/--[^\n]*/g, "")).not.toMatch(/PARTITION BY/i);
  });

  it("makes D19 a failed INSERT rather than a review finding", () => {
    // No cloud backend without a BAA and ZDR enabled…
    expect(tables).toContain(
      `CONSTRAINT "ai_backend_cloud_baa_check" CHECK ("kind" = 'local' OR ("baa_reference" IS NOT NULL AND "zdr_status" = 'enabled'))`,
    );
    // …and no local backend without a license and a stored artifact.
    expect(tables).toContain(
      `CONSTRAINT "ai_backend_local_license_check" CHECK ("kind" = 'cloud' OR ("license_terms" IS NOT NULL AND "artifact_storage_ref" IS NOT NULL))`,
    );
    // Per-CALL, not just per-registration: a backend whose ZDR was flipped after registration cannot
    // leave unmarked Anthropic-routed rows behind it.
    expect(invocation).toContain(`CONSTRAINT "ai_invocation_zdr_check"`);
  });

  it("keeps the kill switch's platform row unique — NULLs are distinct, so ONE index is not enough", () => {
    expect(tables).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "ai_kill_org_cap_idx" ON "ai_kill_switch_state" ("organization_id","capability_id") WHERE organization_id IS NOT NULL`,
    );
    expect(tables).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "ai_kill_platform_cap_idx" ON "ai_kill_switch_state" ("capability_id") WHERE organization_id IS NULL`,
    );
  });

  it("expresses the routing-override rule as an EXCLUDE, because `now()` in an index predicate is illegal", () => {
    // §3.2.13's `WHERE expires_at IS NULL OR expires_at > now()` cannot be created: an index predicate
    // may call only IMMUTABLE functions. The window EXCLUDE is the same rule a database can hold.
    expect(tables).toContain(`CONSTRAINT "ai_routing_override_no_overlap" EXCLUDE USING gist`);
    expect(tables).toContain("CREATE EXTENSION IF NOT EXISTS btree_gist");
    expect(tables).not.toMatch(/CREATE UNIQUE INDEX[^\n]*ai_routing_override[^\n]*now\(\)/);
  });

  it("registers every §3.6 cipher column as bytea, and only those", () => {
    for (const t of M32_TABLE_NAMES) {
      const body = tableBody(t);
      for (const col of M32_CIPHER_COLUMNS[t]) {
        expect(body, `${t}.${col}`).toContain(`"${col}" bytea`);
      }
      if (M32_CIPHER_COLUMNS[t].length === 0) expect(body, t).not.toContain(" bytea");
    }
  });
});

describe("M32-T02 migration 0116 — RLS, grants and the M4 write-audit denylists", () => {
  it("enables RLS on all thirteen tables and keys every policy on app.org_id alone", () => {
    for (const t of M32_TABLE_NAMES) {
      expect(rls, t).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(rls, t).toMatch(new RegExp(`CREATE POLICY "[a-z_0-9]+" ON "${t}"`));
    }
    for (const s of rls.match(/current_setting\(\s*'app\.[a-z_]+'/g) ?? []) {
      // The only non-org vars permitted are the M4 audit ATTRIBUTION context (ADR-0010 D2).
      expect(s).toMatch(/'app\.(org_id|user_id|correlation_id|provider_entity_id|location_id)'/);
    }
  });

  it("gives the platform-shared six read-only access and writes via wardenx_admin alone", () => {
    for (const t of M32_TABLE_NAMES) {
      if (M32_TABLE_TENANCY[t] !== "platform_shared") continue;
      expect(rls, t).toMatch(
        new RegExp(`ON "${t}"\\n  FOR SELECT TO wardenx_app USING \\(true\\)`),
      );
      expect(rls, t).toContain(`GRANT SELECT ON "${t}" TO wardenx_app;`);
      expect(rls, t).toContain(`GRANT ALL ON "${t}" TO wardenx_admin;`);
    }
  });

  it("splits the mixed kill switch BY COMMAND so a tenant can read the platform row but never write one", () => {
    expect(rls).toContain(
      `USING (organization_id IS NULL OR organization_id = current_setting('app.org_id', true)::uuid)`,
    );
    expect(rls).toContain(
      `CREATE POLICY "ai_kill_switch_insert" ON "ai_kill_switch_state"\n  FOR INSERT`,
    );
    expect(rls).toContain(
      `CREATE POLICY "ai_kill_switch_update" ON "ai_kill_switch_state"\n  FOR UPDATE`,
    );
    // A single FOR ALL policy here would let any tenant admin mint a NULL-org platform-wide kill.
    expect(rls).not.toMatch(/ON "ai_kill_switch_state"\n\s*FOR ALL/);
  });

  it("never grants DELETE to wardenx_app anywhere in M32, and no UPDATE on the append-only pair", () => {
    const grants = rls.split("\n").filter((l) => /^GRANT/.test(l) && /wardenx_app/.test(l));
    expect(grants.length).toBe(13);
    for (const g of grants) expect(g).not.toMatch(/\bDELETE\b/);
    expect(rls).toContain(`GRANT SELECT, INSERT ON "ai_token_ledger" TO wardenx_app;`);
    expect(rls).toContain(`GRANT SELECT ON "ai_capability_lifecycle_event" TO wardenx_app;`);
  });

  it("generates an audit function exactly where M1's baseline trigger would be wrong", () => {
    const partitioned = new Set<string>(Object.keys(M32_PARTITIONED_TABLES));
    for (const t of M32_TABLE_NAMES) {
      // The third condition is the one a real PostgreSQL found: the baseline stamps TG_TABLE_NAME, and
      // a write to a partitioned table fires with TG_TABLE_NAME = the PARTITION, so the audit row would
      // read `ai_token_ledger_2026_08` and change name every month.
      const needsGenerated =
        M32_AUDIT_DENYLIST[t].length > 0 ||
        M32_AUDIT_RETENTION_CLASS[t] !== "compliance" ||
        partitioned.has(t);
      expect(Boolean(GENERATED_AUDIT_FN[t]), `${t} generated-vs-baseline`).toBe(needsGenerated);
      if (!needsGenerated) {
        expect(rls, t).toContain(
          `AFTER INSERT OR UPDATE OR DELETE ON ${t}\n  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();`,
        );
      }
    }
  });

  it("mirrors M32_AUDIT_DENYLIST into the generated trigger bodies VERBATIM", () => {
    for (const t of M32_TABLE_NAMES) {
      const fn = GENERATED_AUDIT_FN[t];
      if (!fn) continue;
      expect(denylistOf(fn), t).toEqual([...M32_AUDIT_DENYLIST[t]]);
    }
  });

  it("stamps M32_AUDIT_RETENTION_CLASS on every generated audit row", () => {
    for (const t of M32_TABLE_NAMES) {
      const fn = GENERATED_AUDIT_FN[t];
      if (!fn) continue;
      const body = rls.slice(rls.indexOf(`CREATE OR REPLACE FUNCTION ${fn}()`));
      const upToEnd = body.slice(0, body.indexOf("END $$;"));
      expect(upToEnd, t).toContain(`'${M32_AUDIT_RETENTION_CLASS[t]}'`);
      expect(upToEnd, t).toContain(`'${t}.' || lower(TG_OP)`);
    }
  });

  it("hard-codes the PARENT table name in both partitioned tables' audit functions", () => {
    // The baseline's `TG_TABLE_NAME` would be the monthly partition, so an audit query for the parent
    // returns nothing and the resource kind renames itself every month.
    for (const t of ["ai_invocation", "ai_token_ledger"] as const) {
      const fn = GENERATED_AUDIT_FN[t];
      expect(fn, `${t} must not use the baseline trigger`).toBeDefined();
      const body = rls.slice(rls.indexOf(`CREATE OR REPLACE FUNCTION ${fn}()`));
      const upToEnd = body.slice(0, body.indexOf("END $$;"));
      expect(upToEnd, t).toContain(`'${t}.' || lower(TG_OP)`);
      expect(upToEnd, t).toContain(`    '${t}',`);
      expect(upToEnd, t).not.toContain("TG_TABLE_NAME");
    }
  });

  it("resolves organization_id from the SESSION in the two platform-shared audit functions", () => {
    for (const fn of [
      "audit_phi_write_ai_capability_lifecycle_event",
      "audit_phi_write_ai_prompt_template",
    ]) {
      const body = rls.slice(rls.indexOf(`CREATE OR REPLACE FUNCTION ${fn}()`));
      const upToEnd = body.slice(0, body.indexOf("END $$;"));
      // The tables have no organization_id column, so the generator's row-read would not compile.
      expect(upToEnd, fn).toContain(`NULLIF(current_setting('app.org_id', true), '')::uuid`);
      expect(upToEnd, fn).not.toContain("NEW.organization_id");
    }
  });

  it("does NOT scrub the fields a §164.528 accounting or an FDA inquiry actually reads", () => {
    // `zdr_confirmed` is the whole D19 claim; a scrubbed marker would make the ledger useless.
    for (const col of [
      "zdr_confirmed",
      "routing_decision",
      "routing_reason",
      "model_version_pin",
      "status",
      "hitl_outcome",
    ]) {
      expect(M32_AUDIT_DENYLIST.ai_invocation, col).not.toContain(col);
    }
    expect(denylistOf("audit_phi_write_ai_invocation")).toEqual([
      "prompt_payload_cipher",
      "response_payload_cipher",
      "chart_context_cipher",
      "error_message",
    ]);
  });
});

describe("M32-T02 migration 0116 — the §3.5 immutability triggers", () => {
  it("refuses UPDATE and DELETE on both append-only tables", () => {
    for (const [t, fn] of [
      ["ai_capability_lifecycle_event", "m32_ai_cap_lifecycle_event_append_only"],
      ["ai_token_ledger", "m32_ai_token_ledger_append_only"],
    ] as const) {
      expect(M32_IMMUTABILITY_RULE[t]).toBe("append_only");
      expect(rls, t).toContain(
        `BEFORE UPDATE OR DELETE ON ${t}\n  FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
    }
  });

  it("freezes exactly the M32_IMMUTABLE_COLUMNS set on each column-restricted table", () => {
    for (const [t, fn] of [
      ["ai_invocation", "m32_ai_invocation_immutable_columns"],
      ["ai_capability_calibration", "m32_ai_cap_calibration_immutable_columns"],
      ["ai_prompt_template", "m32_ai_prompt_template_immutable_columns"],
    ] as const) {
      expect(M32_IMMUTABILITY_RULE[t]).toBe("column_restricted");
      const body = rls.slice(rls.indexOf(`CREATE OR REPLACE FUNCTION ${fn}()`));
      const upToEnd = body.slice(0, body.indexOf("END $$;"));
      for (const col of M32_IMMUTABLE_COLUMNS[t]) {
        expect(upToEnd, `${t}.${col}`).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
      }
      // DELETE is refused on all three — destruction is §3.7's shred, archival or supersession.
      expect(upToEnd, t).toContain("IF TG_OP = 'DELETE' THEN");
    }
  });

  it("admits exactly ONE cipher write: the §3.7 shred sentinel, never a replacement", () => {
    const body = rls.slice(
      rls.indexOf("CREATE OR REPLACE FUNCTION m32_ai_invocation_immutable_columns()"),
    );
    const upToEnd = body.slice(0, body.indexOf("END $$;"));
    // The NOT NULL prompt cipher may only become the empty bytea…
    expect(upToEnd).toContain("AND NEW.prompt_payload_cipher IS DISTINCT FROM ''::bytea");
    // …and the two optional ciphers may only become NULL.
    expect(upToEnd).toContain("AND NEW.response_payload_cipher IS NOT NULL");
    expect(upToEnd).toContain("AND NEW.chart_context_cipher IS NOT NULL");
  });

  it("enforces the D3 one-way prompt-template status walk", () => {
    const body = rls.slice(
      rls.indexOf("CREATE OR REPLACE FUNCTION m32_ai_prompt_template_immutable_columns()"),
    );
    const upToEnd = body.slice(0, body.indexOf("END $$;"));
    expect(upToEnd).toContain("OLD.status = 'active' AND NEW.status = 'deprecated'");
    expect(upToEnd).toContain("OLD.status = 'deprecated' AND NEW.status = 'archived'");
    // Un-deprecating would silently return a withdrawn prompt to AIPromptRegistry's active set.
    expect(upToEnd).not.toContain("NEW.status = 'active'");
  });
});
