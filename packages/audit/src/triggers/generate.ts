// @wardenx/audit — PHI write-audit trigger generator (M4-T02 ⟵ core, M4 spec §3.3, M04-F06).
//
// The mechanism that guarantees no clinical mutation escapes the log. Every PHI module calls
// `generateAuditTrigger()` in its migration — the same way it calls M1's RLS generator — to emit
// an append-only, SECURITY DEFINER trigger that writes a scrubbed before/after diff into the
// M1-owned `audit_event` table on every INSERT/UPDATE/DELETE.
//
// This is the canonical mechanism the M1–M3 baseline triggers normalize to (the back-fill that
// regenerates them through this generator is M4-T10).
//
// M04-F06 — the SECURITY DEFINER machinery is made to work *and stay least-privilege*:
//   • `ALTER FUNCTION ... OWNER TO wardenx_audit_writer` — without this the function would be
//     owned by the migration runner (wardenx_admin) and run with full RLS-bypassing admin rights
//     on every PHI write. wardenx_audit_writer holds INSERT-only on audit_event (no UPDATE/DELETE,
//     no BYPASSRLS), so the definer can append to the log and nothing more.
//   • `SET search_path = pg_catalog, public` on every definer function (standard PG hardening).
//   • The INSERT-only RLS policy + grant that lets the writer role append are emitted once by
//     `auditWriterGrantsDDL()` (audit_event has RLS with policies only TO wardenx_app, so without
//     this the definer's inserts are denied).

import {
  type CatalogDenylist,
  type DenylistCatalogEntry,
  resolveCatalogDenylist,
} from "./catalog";
import {
  AUDIT_SCRUB_FUNCTION_DDL,
  type DenylistCategory,
  resolveDenylist,
} from "./scrub";

/** Retention class a generated trigger files its events under (M4 spec §3.2; §3.3 `retentionClass`). */
export type TriggerRetentionClass =
  | "operational"
  | "compliance"
  | "compliance_42cfr_part2";

export interface GenerateAuditTriggerOptions {
  /** Target PHI table the trigger is attached to. */
  table: string;
  /** `event_type` prefix, e.g. `encounter` → `encounter.insert` / `.update` / `.delete`. */
  resourceKind: string;
  /** High-sensitivity columns whose values are replaced with `<changed>` in the diff. */
  denylist?: readonly string[];
  /** Named denylist categories resolved against the denylist catalog and unioned with `denylist` (§5.1, D10). */
  denylistCategories?: readonly DenylistCategory[];
  /** Per-table category → column map merged on top of the catalog (explicit override; legacy M4-T02 shape). */
  categoryColumns?: Partial<Record<DenylistCategory, readonly string[]>>;
  /** Denylist category registry the categories resolve against (§5.1); defaults to `AUDIT_DENYLIST_CATALOG`. */
  catalog?: readonly DenylistCatalogEntry[];
  /** Retention class for emitted events; defaults to `compliance` (the trigger-write default, §2.3). */
  retentionClass?: TriggerRetentionClass;
}

// A safe SQL identifier: lowercase letter-led, alphanumeric + underscore, ≤63 chars (PG's limit).
// The generator's inputs come from trusted migration call sites, but validating here keeps a
// malformed table/column name from silently producing broken — or injectable — DDL.
const IDENT = /^[a-z_][a-z0-9_]*$/;

function assertIdent(value: string, what: string): string {
  if (!IDENT.test(value) || value.length > 63) {
    throw new Error(
      `generateAuditTrigger: invalid ${what} '${value}' — expected a lowercase snake_case SQL identifier (≤63 chars)`,
    );
  }
  return value;
}

/** SQL array literal for a list of (validated) column identifiers, e.g. `ARRAY['a','b']::text[]`. */
function denylistArrayLiteral(columns: string[]): string {
  if (columns.length === 0) return "ARRAY[]::text[]";
  const quoted = columns.map((c) => `'${assertIdent(c, "denylist column")}'`).join(", ");
  return `ARRAY[${quoted}]::text[]`;
}

/**
 * Emit the per-table append-only write-audit trigger DDL (function + owner change + trigger) for
 * one PHI table, per M4 spec §3.3. The returned string is ready to embed in a Drizzle migration
 * (statements separated by `--> statement-breakpoint`). Depends on `audit_scrub` and the
 * `wardenx_audit_writer` grants being present — see `auditScrubFunctionDDL()` / `auditWriterGrantsDDL()`.
 */
export function generateAuditTrigger(opts: GenerateAuditTriggerOptions): string {
  const table = assertIdent(opts.table, "table");
  const resourceKind = assertIdent(opts.resourceKind, "resourceKind");
  // The append-only log must never carry a per-table PHI trigger of its own: a write to
  // audit_event (or a dated partition) would recurse through this trigger forever. audit_event
  // is captured by the app-side audit() helper, not this generator.
  if (table === "audit_event" || table.startsWith("audit_event_")) {
    throw new Error(
      `generateAuditTrigger: refusing to attach a write-audit trigger to '${table}' — the audit log is append-only and self-auditing would recurse`,
    );
  }
  const retentionClass: TriggerRetentionClass = opts.retentionClass ?? "compliance";

  // §5.3 defense-in-depth: a Part 2 trigger is subject to `sud_value` scrubbing even when the
  // call site didn't declare the category — the retention class alone implies it.
  const categories = new Set<DenylistCategory>(opts.denylistCategories ?? []);
  if (retentionClass === "compliance_42cfr_part2") categories.add("sud_value");

  // §5.1 expand the named categories against the per-table catalog into always-scrubbed
  // columns and row-conditional scrub groups (§5.2).
  const catalogDenylist: CatalogDenylist = resolveCatalogDenylist({
    table,
    denylistCategories: [...categories],
    catalog: opts.catalog,
  });

  // Always-scrubbed columns: explicit denylist ∪ legacy per-call categoryColumns ∪ catalog statics.
  const denylist = resolveDenylist({
    denylist: [...(opts.denylist ?? []), ...catalogDenylist.staticColumns],
    denylistCategories: opts.denylistCategories,
    categoryColumns: opts.categoryColumns,
  });
  const fn = `audit_phi_write_${table}`;
  const trg = `trg_audit_${table}`;

  // The scrub-column argument the trigger passes to audit_scrub. With no row-conditional groups it
  // is a static ARRAY literal (the M4-T02 shape); with conditional groups we build a `v_denylist`
  // variable, appending each group's columns inside its guard so the same column is scrubbed only
  // when the row warrants it (§5.2).
  const conditional = catalogDenylist.conditional;
  const scrubArg = conditional.length === 0 ? denylistArrayLiteral(denylist) : "v_denylist";
  const conditionalDecl =
    conditional.length === 0
      ? ""
      : `\n  v_denylist text[] := ${denylistArrayLiteral(denylist)};`;
  const conditionalBlocks = conditional
    .map(
      (group) =>
        `  IF ${group.check} THEN\n    v_denylist := v_denylist || ${denylistArrayLiteral(
          group.columns,
        )};\n  END IF;\n`,
    )
    .join("");

  return `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;${conditionalDecl}
BEGIN
${conditionalBlocks}  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ${scrubArg}) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ${scrubArg}) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    '${resourceKind}.' || lower(TG_OP),
    '${resourceKind}',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    '${retentionClass}'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION ${fn}() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "${trg}" AFTER INSERT OR UPDATE OR DELETE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION ${fn}();`;
}

/**
 * The one-time `audit_scrub(jsonb, text[])` helper DDL the generated triggers call. Apply once
 * per database (M4-T05 migration) ahead of any `generateAuditTrigger()` output.
 */
export function auditScrubFunctionDDL(): string {
  return AUDIT_SCRUB_FUNCTION_DDL;
}

/**
 * The one-time grants that let the SECURITY DEFINER trigger functions (owned by
 * wardenx_audit_writer) actually append to audit_event (M04-F06 #2): a table-level INSERT grant
 * plus an INSERT-only RLS policy. audit_event's M1 policies are all `TO wardenx_app`, so without
 * this the definer's inserts are denied. No BYPASSRLS — the targeted INSERT policy is the
 * least-privilege path. Idempotent: the policy is dropped-if-exists first.
 */
export function auditWriterGrantsDDL(): string {
  return `GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);`;
}
