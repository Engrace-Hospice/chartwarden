// @wardenx/reporting — translator step 4: inject the `reportable_scope` envelope as an ADDITIONAL
// parameterized WHERE predicate (M33 §4.7 D8).
//
// `reportable_scope` is the single rule by which every M33 read is authorization-filtered (D8). The
// route handler resolves the actor into a SEALED envelope — self/team/location/org → membership_ids /
// location_ids / org — and this step lays that envelope down as one more bound predicate on the MV.
// The scope COLUMNS are structural columns of the MV, not tenant-selectable dimensions, so they are never
// tenant input; the scope VALUES are bound `$n` params. `org` scope adds NO predicate — the MV wrapper
// function `report_mv.select_<mvKey>(p_org_id)` already constrains to the org via its SECURITY DEFINER
// body, so org-wide is "no further narrowing". An empty membership/location list yields `FALSE` (deny —
// never "match everything"), the fail-closed posture D8 requires.
//
// F-059: the column names used to be two FILE-LEVEL CONSTANTS, `membership_id` / `location_id`, described
// as "platform-fixed structural columns of the MV wrapper". No shipped MV has either column —
// `mv_encounter_productivity_membership_day` calls its one `authored_by_membership_id`, and the census and
// EVV MVs are org-grain with no member column at all. So every narrowing branch here compiled a predicate
// against a column that does not exist: `self`, `team` and `location` scope would each have failed with
// `column t.membership_id does not exist`, on any base, always. Nothing surfaced it because nothing ever
// reached those branches — every read path built its own envelope with `scopeKind: "org"`, the one arm
// that emits no predicate (F-059's other half). Two dead halves that only fail when joined.
//
// The column is now DECLARED PER BASE (`report_base_catalog.scope_membership_column` /
// `scope_location_column`, migration 0224) and passed in, because which column carries the scope is a
// property of the MV, not of the platform. A base that declares NO column for the requested scope kind
// compiles to `FALSE` — an org-grain aggregate genuinely cannot be narrowed to one clinician, and the
// choice there is between denying and serving the whole org to a `self`-scoped actor. That is the same
// fail-closed rule the empty-id-list case already took, applied one level up.
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

/**
 * The per-base scope columns, read off `report_base_catalog` (§3.3). `null` means the base's MV has no
 * column of that kind — it is an org-grain aggregate — and a scope of that kind therefore denies.
 */
export interface ReportScopeColumns {
  /** The MV column carrying the authoring/owning membership (`self` / `team` scope). */
  readonly membership: string | null;
  /** The MV column carrying the location (`location` scope). */
  readonly location: string | null;
}

/** No scope column of either kind — every narrowing scope denies. The safe default for an unknown base. */
export const NO_SCOPE_COLUMNS: ReportScopeColumns = { membership: null, location: null };

/** A compiled scope fragment: predicate text (or null when org-wide adds nothing), bound params, next index. */
export interface CompiledScope {
  readonly sql: string | null;
  readonly params: string[];
  readonly nextIndex: number;
}

function inList(column: string | null, ids: readonly string[], startIndex: number): CompiledScope {
  // No column for this scope kind on this base, or an empty allowed-set → deny by construction (D8 fails
  // closed; never widens to all rows, and never emits a predicate naming a column the MV does not have).
  if (column === null || ids.length === 0) {
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
 *  - `self` / `team`    → `t."<membership column>" IN ($…)` over `membershipIds`
 *  - `location`         → `t."<location column>" IN ($…)` over `locationIds`
 *
 * A narrowing scope with an empty id list, or on a base declaring no column of that kind, compiles to
 * `FALSE`. Pure. The column names come from the base catalog (never tenant input); only the ids bind.
 */
export function injectScope(
  env: ReportableScopeEnvelope,
  startIndex = 1,
  columns: ReportScopeColumns = NO_SCOPE_COLUMNS,
): CompiledScope {
  switch (env.scopeKind) {
    case "org":
      return { sql: null, params: [], nextIndex: startIndex };
    case "self":
    case "team":
      return inList(columns.membership, env.membershipIds ?? [], startIndex);
    case "location":
      return inList(columns.location, env.locationIds ?? [], startIndex);
  }
}
