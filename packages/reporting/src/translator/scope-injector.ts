// @wardenx/reporting — translator step 4: inject the `reportable_scope` envelope as an ADDITIONAL
// parameterized WHERE predicate (M33 §4.7 D8).
//
// `reportable_scope` is the single rule by which every M33 read is authorization-filtered (D8). The
// route handler resolves the actor into a SEALED envelope — self/team/location/org → membership_ids /
// location_ids / org — and this step lays that envelope down as one more bound predicate on the MV.
// The scope COLUMNS (`membership_id`, `location_id`) are platform-fixed structural columns of the MV
// wrapper, not tenant-selectable dimensions, so they are constants here (never tenant input); the scope
// VALUES are bound `$n` params. `org` scope adds NO predicate — the MV wrapper function
// `report_mv.select_<mvKey>(p_org_id)` already constrains to the org via its SECURITY DEFINER body, so
// org-wide is "no further narrowing". An empty membership/location list yields `FALSE` (deny — never
// "match everything"), the fail-closed posture D8 requires.
import { REL_ALIAS } from "./filter-compiler";
import { quoteIdent } from "./spec-validator";

export type ReportScopeKind = "self" | "team" | "location" | "org";

/** The sealed scope envelope the route resolves from the actor's `reportable_scope` predicate (D8). */
export interface ReportableScopeEnvelope {
  readonly scopeKind: ReportScopeKind;
  /** The actor's org — bound as the MV wrapper's `p_org_id` ($1) by the SQL step, not re-emitted here. */
  readonly organizationId: string;
  /** Membership ids the actor may see (self → own; team → supervised set). Required for self/team. */
  readonly membershipIds?: readonly string[];
  /** Location ids the actor supervises. Required for location scope. */
  readonly locationIds?: readonly string[];
}

/** The structural scope columns the MV wrapper exposes (platform-fixed; never tenant input). */
export const SCOPE_MEMBERSHIP_COLUMN = "membership_id";
export const SCOPE_LOCATION_COLUMN = "location_id";

/** A compiled scope fragment: predicate text (or null when org-wide adds nothing), bound params, next index. */
export interface CompiledScope {
  readonly sql: string | null;
  readonly params: string[];
  readonly nextIndex: number;
}

function inList(column: string, ids: readonly string[], startIndex: number): CompiledScope {
  // Empty allowed-set → deny by construction (D8 fails closed; never widens to all rows).
  if (ids.length === 0) {
    return { sql: "FALSE", params: [], nextIndex: startIndex };
  }
  let idx = startIndex;
  const placeholders = ids.map(() => `$${idx++}`);
  const c = `${REL_ALIAS}.${quoteIdent(column)}`;
  return { sql: `${c} IN (${placeholders.join(", ")})`, params: [...ids], nextIndex: idx };
}

/**
 * Compiles the `reportable_scope` envelope into an additional parameterized predicate, starting at
 * `$startIndex`. Resolution:
 *  - `org`              → `{ sql: null }` (the MV wrapper's `p_org_id` already scopes to the org)
 *  - `self` / `team`    → `t."membership_id" IN ($…)` over `membershipIds` (empty → `FALSE`)
 *  - `location`         → `t."location_id" IN ($…)` over `locationIds` (empty → `FALSE`)
 *
 * Pure. The scope columns are constants; only the ids bind as params.
 */
export function injectScope(
  env: ReportableScopeEnvelope,
  startIndex = 1,
): CompiledScope {
  switch (env.scopeKind) {
    case "org":
      return { sql: null, params: [], nextIndex: startIndex };
    case "self":
    case "team":
      return inList(SCOPE_MEMBERSHIP_COLUMN, env.membershipIds ?? [], startIndex);
    case "location":
      return inList(SCOPE_LOCATION_COLUMN, env.locationIds ?? [], startIndex);
  }
}
