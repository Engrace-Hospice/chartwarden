// @chartwarden/audit — trigger-side denylist scrubbing (M4-T02, M4 spec §3.3, §5.1, D10).
//
// The PHI write-audit trigger writes a column-level before/after diff into audit_event, but
// the *values* of high-sensitivity columns must not be duplicated into the log (§2.3 "the fact
// of change is audited, the sensitive value is not"). Two pieces live here:
//
//   1. `AUDIT_SCRUB_FUNCTION_DDL` — the SQL `audit_scrub(jsonb, text[])` helper the generated
//      trigger calls: it replaces each denylisted column's value with the `<changed>` marker.
//   2. `resolveDenylist()` — the TS-side resolver the generator uses at DDL-emit time to expand
//      the named denylist categories (§5.1 / D10) into concrete column names and union them with
//      the explicit column list.
//
// Scope note (M4-T02): category → column expansion is driven here by an explicit per-table
// `categoryColumns` map. The DB-backed `audit_denylist_catalog` seed and the row-conditional
// `sud_value` scrub (§5.2) are layered on in M4-T07/T-M4-10 — this file ships the mechanism, not
// the catalog data.

/** The three named high-sensitivity column categories (M4 spec §3.2 `phi_denylist_category`, D10). */
export type DenylistCategory = "pii_high_sensitivity" | "sud_value" | "narrative_free_text";

/** The marker substituted for a scrubbed column value in the audit diff (§2.3, §3.3). */
export const CHANGE_MARKER = "<changed>";

/**
 * SQL DDL for the `audit_scrub(payload jsonb, denylist text[])` helper. Returns a copy of
 * `payload` with every top-level key named in `denylist` re-pointed to the `<changed>` marker;
 * NULL payloads (INSERT has no before / DELETE has no after) pass through as NULL. IMMUTABLE +
 * hardened `search_path` per the SECURITY DEFINER guidance (M04-F06 #3). Applied once per
 * database (the trigger generator references it by name).
 */
export const AUDIT_SCRUB_FUNCTION_DDL = `CREATE OR REPLACE FUNCTION audit_scrub(payload jsonb, denylist text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN payload IS NULL THEN NULL
    WHEN denylist IS NULL OR cardinality(denylist) = 0 THEN payload
    ELSE COALESCE(
      (SELECT jsonb_object_agg(
                key,
                CASE WHEN key = ANY (denylist) THEN to_jsonb('${CHANGE_MARKER}'::text) ELSE value END)
       FROM jsonb_each(payload)),
      payload)
  END
$$;`;

/**
 * Resolve the effective scrub column list for a table: the union of the explicit `denylist`
 * column names and the columns mapped from each named category in `denylistCategories`.
 * Names are de-duplicated and returned in stable (sorted) order so generated DDL is
 * deterministic. Unknown categories (no entry in `categoryColumns`) contribute nothing —
 * the catalog seed that fills them in is M4-T07.
 */
export function resolveDenylist(opts: {
  denylist?: readonly string[];
  denylistCategories?: readonly DenylistCategory[];
  categoryColumns?: Partial<Record<DenylistCategory, readonly string[]>>;
}): string[] {
  const cols = new Set<string>(opts.denylist ?? []);
  for (const category of opts.denylistCategories ?? []) {
    for (const col of opts.categoryColumns?.[category] ?? []) cols.add(col);
  }
  return [...cols].sort();
}
