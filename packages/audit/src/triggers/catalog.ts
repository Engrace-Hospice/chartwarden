// @wardenx/audit — PHI denylist category catalog (M4-T07, M4 spec §5.1, §5.2, D10).
//
// The code-owned mirror of the platform-shared `audit_denylist_catalog` table (§3.5): the
// per-table registry that resolves the three named denylist categories (`pii_high_sensitivity`,
// `sud_value`, `narrative_free_text`) to the concrete columns the write-audit trigger scrubs.
// Module owners contribute entries under their own `registeredByModule` prefix; M4 expands them
// at trigger-generation time (§5.1) — the same data the migration seeds into the DB table.
//
// Two shapes of entry (§5.2):
//   • STATIC — a column is always scrubbed for the category (no `conditionalCheck`).
//   • ROW-CONDITIONAL — a column is scrubbed only when a SQL boolean evaluates true on the
//     changed row. `sud_value` is row-conditional: `lab_observation_value.observation_value`
//     is Part 2 / SUD-sensitive only when its parent observation is SUD-class, so the same
//     column is scrubbed or not depending on the parent classification (§5.2, W-M4-11).
//
// `conditionalCheck` is a code-owned, trusted SQL fragment embedded verbatim into the generated
// trigger body. It must reference `NEW`/`OLD` of the audited row (never untrusted input).

import type { DenylistCategory } from "./scrub";

/** One row of the denylist category registry (mirrors `audit_denylist_catalog`, §3.5). */
export interface DenylistCatalogEntry {
  /** PHI table the audited column lives on. */
  readonly table: string;
  /** Column whose value is replaced with the change-marker when the category applies. */
  readonly column: string;
  /** Named category this mapping belongs to (§3.2 `phi_denylist_category`). */
  readonly category: DenylistCategory;
  /**
   * SQL boolean expression gating the scrub (§5.2). When present the column is scrubbed only on
   * rows where this evaluates true; when absent the column is always scrubbed for the category.
   * Trusted, code-owned SQL — embedded verbatim into the trigger body.
   */
  readonly conditionalCheck?: string;
  /** `mN` prefix of the module that registered this entry (namespace accountability, §4.6). */
  readonly registeredByModule: string;
}

/**
 * The seeded denylist category registry. Other modules' columns are appended here (and to the
 * DB seed) as their tables land; M4 ships the canonical row-conditional `sud_value` entry that
 * Part 2 scrubbing (§5.2) and the W-M4-11 acceptance depend on.
 */
export const AUDIT_DENYLIST_CATALOG: readonly DenylistCatalogEntry[] = [
  // M29 lab observation values are Part 2 / SUD-sensitive only when the parent observation was
  // classified SUD at ingest (`lab_observation.sud_redacted_at_ingest`, the actually-shipped
  // boolean — the richer `sud_redaction_status` enum T-29.11 proposed was never built; see
  // packages/db/src/schema/external-interfaces/lab-observation.ts). Scrub both value columns
  // row-conditionally so non-SUD results stay legible in the diff (§5.2). NOTE: the app-layer
  // ingest path (lab-attach-planner.ts) already replaces a SUD-class row's `numeric_value` with
  // NULL and `string_value` with the `[REDACTED_SUD]` sentinel BEFORE persist, so this trigger is
  // defense-in-depth against a future ingest-path bug, not the primary protection.
  {
    table: "lab_observation_value",
    column: "numeric_value",
    category: "sud_value",
    conditionalCheck:
      "EXISTS (SELECT 1 FROM lab_observation lo WHERE lo.id = COALESCE(NEW.observation_id, OLD.observation_id) AND lo.sud_redacted_at_ingest = true)",
    registeredByModule: "m29",
  },
  {
    table: "lab_observation_value",
    column: "string_value",
    category: "sud_value",
    conditionalCheck:
      "EXISTS (SELECT 1 FROM lab_observation lo WHERE lo.id = COALESCE(NEW.observation_id, OLD.observation_id) AND lo.sud_redacted_at_ingest = true)",
    registeredByModule: "m29",
  },
];

/** A set of columns scrubbed together behind one row-conditional SQL guard (§5.2). */
export interface ConditionalScrubGroup {
  /** SQL boolean expression; the columns are scrubbed only when it evaluates true on the row. */
  readonly check: string;
  /** Columns guarded by `check`, deduped and sorted for deterministic DDL. */
  readonly columns: string[];
}

/** The catalog resolution for one table: always-scrubbed columns plus row-conditional groups. */
export interface CatalogDenylist {
  /** Columns scrubbed unconditionally for the requested categories, deduped and sorted. */
  readonly staticColumns: string[];
  /** Row-conditional scrub groups, one per distinct guard expression, sorted by expression. */
  readonly conditional: ConditionalScrubGroup[];
}

/**
 * Resolve the requested denylist categories for `table` against the catalog (§5.1). Static
 * entries collapse into `staticColumns`; row-conditional entries are grouped by their guard
 * expression into `conditional`. Both are deterministic (deduped + sorted) so generated DDL is
 * stable. Categories with no catalog entry for the table contribute nothing.
 */
export function resolveCatalogDenylist(opts: {
  table: string;
  denylistCategories?: readonly DenylistCategory[];
  catalog?: readonly DenylistCatalogEntry[];
}): CatalogDenylist {
  const categories = new Set(opts.denylistCategories ?? []);
  if (categories.size === 0) return { staticColumns: [], conditional: [] };
  const catalog = opts.catalog ?? AUDIT_DENYLIST_CATALOG;

  const staticCols = new Set<string>();
  const byCheck = new Map<string, Set<string>>();
  for (const entry of catalog) {
    if (entry.table !== opts.table || !categories.has(entry.category)) continue;
    if (entry.conditionalCheck === undefined) {
      staticCols.add(entry.column);
    } else {
      const cols = byCheck.get(entry.conditionalCheck) ?? new Set<string>();
      cols.add(entry.column);
      byCheck.set(entry.conditionalCheck, cols);
    }
  }

  const conditional = [...byCheck.entries()]
    .map(([check, cols]) => ({ check, columns: [...cols].sort() }))
    .sort((a, b) => (a.check < b.check ? -1 : a.check > b.check ? 1 : 0));

  return { staticColumns: [...staticCols].sort(), conditional };
}
