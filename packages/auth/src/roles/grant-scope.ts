// @wardenx/auth · roles - what `membership_role.scope` means and how it is enforced (M3 spec §2.4, §3.4, §4.2; GAP-007).
//
// WHAT WAS MISSING. `membership_role.scope` and `role.scope_level` were write-only: the assign route stored any
// object in `scope`, and no authorization decision read it. Scoping a grant to a location did nothing, a
// `location`-scoped role could be granted org-wide, and a time-bound role carried no expiry.
//
// THE MODEL. A membership has DEFAULT reach (`default_provider_entity_id`, `default_location_ids`) - what the actor
// context stamps today for the `provider_entity_scope` / `location_scope` predicates. A grant's `scope` may NARROW
// that reach for the role it rides on:   { providerEntityIds?: uuid[], locationIds?: uuid[] }.
//   - effective reach = the UNION, over the member's live roles, of each role's reach, where a role's reach in a
//     dimension is its scope ids when it names any, else the membership defaults. A member whose every role is
//     scoped to location X can therefore act at X only; one unscoped role restores the defaults (a grant can only
//     ever NARROW a role, never widen the member beyond their defaults).
//   - a grant's ids must be a subset of the membership's defaults whenever those are set (spec: "narrower PE/location
//     ids than role default").
//   - role.scope_level bounds the grant (spec §2.4 "Role scope_level >= member scope"): a `location` role is never
//     granted org-wide - it needs location ids (explicit, or the membership's own default locations); a
//     `provider_entity` role needs provider-entity or location ids; a `location` role may not carry
//     provider-entity ids (that is WIDER than its level); a `patient` role is link-bound, never granted this way.
//   - roles of the time-bound category (`temporary_special`: on-call, locum, interim, travel, student supervision)
//     require a future `expires_at`; any `expires_at` must be in the future.
//   - PATIENT-LEVEL narrowing is NOT a role-scope dimension (M3 spec §3.4: "narrower PE/location ids than role
//     default"; §4.2/§4.2.1: patient reach is the caseload model, `caseload_membership` through the `CaseloadProvider`
//     seam, with ORG_WIDE_SCOPE_ROLES as the org-wide bypass). `scope.patientIds` is therefore refused with the
//     dedicated `PATIENT_SCOPE_UNSUPPORTED` code rather than stored and silently never enforced. A second patient
//     fence beside caseload could not be enforced centrally either: collection routes name no patient target.
//   - FAIL CLOSED ON READ. A stored scope that does not parse (a legacy blob, an out-of-band writer) contributes
//     NOTHING to the reach, not "no narrowing"; if every live grant is unreadable the actor reaches nothing, which is
//     expressed as {@link NO_REACH_ID} in both dimensions (never `[]`: several evaluators read an empty list as
//     "org-wide"). Migration 1050 also CHECKs the stored shape and quarantines legacy blobs, so this is the second wall.
//   - Writers that bypass the route (org-spine-facts, f2f-clinician-roles, proposed-role-attacher, auditor-access-grant,
//     SQL seeds) are bound by the DB CHECK on shape only; the semantic rules (subset of the membership defaults,
//     role.scope_level, expiry) stay route-only. That is safe because the read caps every reach to the membership
//     defaults: a direct writer can grant a scope no wider than the defaults, never wider.
// All pure: the route validates with {@link validateRoleGrant}; the actor-enrichment reader reduces with
// {@link effectiveReach}. Both live here so the write rule and the read rule cannot drift.

/** A grant's narrowing, normalized. Absent dimension = no narrowing in that dimension. */
export interface RoleGrantScope {
  readonly providerEntityIds?: readonly string[];
  readonly locationIds?: readonly string[];
}

/** The reach a membership carries by default. */
export interface MembershipReach {
  readonly providerEntityIds: readonly string[];
  readonly locationIds: readonly string[];
}

/** The role-category value that marks a time-bound role (spec §2.4: on-call, locum, interim, travel, student supervision). */
export const TIME_BOUND_ROLE_CATEGORY = "temporary_special";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_KEYS: ReadonlySet<string> = new Set(["providerEntityIds", "locationIds"]);
/**
 * The one extra key a STORED scope may carry: the auditor-link grant stamps `engagementId` as provenance (the engagement
 * itself is enforced from the session / `auditor_engagement`, never from this key). It is not a reach dimension, and a
 * SUBMITTED scope (the assign route) may not carry it.
 */
const STORED_ONLY_KEYS: ReadonlySet<string> = new Set(["engagementId"]);

/**
 * A uuid that matches no real location or provider entity. {@link effectiveReach} stamps it in both dimensions when no
 * live grant is readable, so every `includes`-style scope predicate denies and no `length === 0 => org-wide` reading applies.
 */
export const NO_REACH_ID = "00000000-0000-0000-0000-000000000000";

const PATIENT_SCOPE_MESSAGE =
  "patient-level access is granted through caseload assignment (patient.assign), not role scope";

export type GrantScopeParse =
  | { readonly ok: true; readonly scope: RoleGrantScope }
  | { readonly ok: false; readonly reason: string; readonly code?: "PATIENT_SCOPE_UNSUPPORTED" };

/**
 * Parse whatever is stored / submitted into a {@link RoleGrantScope}. `null`, `undefined` and `{}` mean "no narrowing".
 * `source: "stored"` additionally tolerates the auditor grant's provenance `engagementId` (ignored).
 */
export function parseRoleGrantScope(
  raw: unknown,
  source: "submitted" | "stored" = "submitted",
): GrantScopeParse {
  if (raw === null || raw === undefined) return { ok: true, scope: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "scope must be an object" };
  }
  const record = raw as Record<string, unknown>;
  if (Object.hasOwn(record, "patientIds")) {
    return { ok: false, reason: PATIENT_SCOPE_MESSAGE, code: "PATIENT_SCOPE_UNSUPPORTED" };
  }
  const unknownKey = Object.keys(record).find(
    (k) => !SCOPE_KEYS.has(k) && !(source === "stored" && STORED_ONLY_KEYS.has(k)),
  );
  if (unknownKey !== undefined) {
    return {
      ok: false,
      reason: `unknown scope key '${unknownKey}' (allowed: providerEntityIds, locationIds)`,
    };
  }
  const out: { providerEntityIds?: string[]; locationIds?: string[] } = {};
  for (const key of ["providerEntityIds", "locationIds"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !UUID_SHAPE.test(v))) {
      return { ok: false, reason: `scope.${key} must be an array of uuids` };
    }
    // An EMPTY list would read as "reaches nothing" to some and "no narrowing" to others: refuse the ambiguity.
    if (value.length === 0) return { ok: false, reason: `scope.${key} must not be empty` };
    out[key] = [...new Set(value as string[])];
  }
  return { ok: true, scope: out };
}

/** One rule a grant broke. `code` is the stable machine-readable reason. */
export interface GrantViolation {
  readonly code:
    | "SCOPE_MALFORMED"
    | "PATIENT_SCOPE_UNSUPPORTED"
    | "ROLE_NOT_ASSIGNABLE"
    | "SCOPE_WIDER_THAN_ROLE"
    | "ROLE_REQUIRES_NARROWING"
    | "SCOPE_OUTSIDE_MEMBERSHIP"
    | "EXPIRY_REQUIRED"
    | "EXPIRY_NOT_FUTURE";
  readonly message: string;
}

export interface GrantInput {
  readonly role: { readonly scopeLevel: string; readonly category: string };
  readonly scope: unknown;
  readonly membership: MembershipReach;
  readonly expiresAt: Date | null;
  readonly now: Date;
}

const subset = (ids: readonly string[], within: readonly string[]): boolean =>
  ids.every((id) => within.includes(id));

/** Every rule the grant breaks (empty = the grant is acceptable). */
export function validateRoleGrant(input: GrantInput): readonly GrantViolation[] {
  const violations: GrantViolation[] = [];
  const parsed = parseRoleGrantScope(input.scope);
  if (!parsed.ok) return [{ code: parsed.code ?? "SCOPE_MALFORMED", message: parsed.reason }];
  const { scope } = parsed;
  const pe = scope.providerEntityIds ?? [];
  const loc = scope.locationIds ?? [];
  const defaults = input.membership;

  if (input.role.scopeLevel === "patient") {
    violations.push({
      code: "ROLE_NOT_ASSIGNABLE",
      message:
        "a patient-scoped role is bound to one patient through its link, not granted to a membership",
    });
  }
  if (input.role.scopeLevel === "location" && pe.length > 0) {
    violations.push({
      code: "SCOPE_WIDER_THAN_ROLE",
      message:
        "a location-scoped role cannot carry provider-entity ids (wider than the role's level)",
    });
  }
  const narrowed =
    input.role.scopeLevel === "location"
      ? loc.length > 0 || defaults.locationIds.length > 0
      : input.role.scopeLevel === "provider_entity"
        ? pe.length > 0 ||
          loc.length > 0 ||
          defaults.providerEntityIds.length > 0 ||
          defaults.locationIds.length > 0
        : true;
  if (!narrowed) {
    violations.push({
      code: "ROLE_REQUIRES_NARROWING",
      message: `a ${input.role.scopeLevel}-scoped role cannot be granted org-wide: name its ${
        input.role.scopeLevel === "location" ? "locationIds" : "providerEntityIds or locationIds"
      } in scope`,
    });
  }
  if (
    (defaults.providerEntityIds.length > 0 && !subset(pe, defaults.providerEntityIds)) ||
    (defaults.locationIds.length > 0 && !subset(loc, defaults.locationIds))
  ) {
    violations.push({
      code: "SCOPE_OUTSIDE_MEMBERSHIP",
      message: "scope names a provider entity or location outside the membership's own reach",
    });
  }
  if (input.role.category === TIME_BOUND_ROLE_CATEGORY && input.expiresAt === null) {
    violations.push({ code: "EXPIRY_REQUIRED", message: "a time-bound role requires expiresAt" });
  }
  if (input.expiresAt !== null && input.expiresAt.getTime() <= input.now.getTime()) {
    violations.push({ code: "EXPIRY_NOT_FUTURE", message: "expiresAt must be in the future" });
  }
  return violations;
}

/** The reduced reach plus how many live grants were unreadable and therefore contributed nothing. */
export interface ReachWithDiagnostics {
  readonly reach: MembershipReach;
  readonly malformedGrantCount: number;
}

/**
 * The reach a member actually has, reduced from their LIVE role grants. `grants` are the live (enabled, unexpired,
 * conferring) grants' stored scopes. A stored scope that fails to parse contributes NOTHING (fail closed: it neither
 * narrows nor widens), and when no live grant is readable the reach is {@link NO_REACH_ID} in both dimensions. The
 * result is always capped to the membership defaults when those are set.
 */
export function effectiveReachWithDiagnostics(
  defaults: MembershipReach,
  grants: readonly { readonly scope: unknown }[],
): ReachWithDiagnostics {
  if (grants.length === 0) return { reach: defaults, malformedGrantCount: 0 };
  const pe = new Set<string>();
  const loc = new Set<string>();
  let malformedGrantCount = 0;
  for (const grant of grants) {
    const parsed = parseRoleGrantScope(grant.scope, "stored");
    if (!parsed.ok) {
      malformedGrantCount += 1;
      continue;
    }
    for (const id of parsed.scope.providerEntityIds ?? defaults.providerEntityIds) pe.add(id);
    for (const id of parsed.scope.locationIds ?? defaults.locationIds) loc.add(id);
  }
  if (malformedGrantCount === grants.length) {
    return {
      reach: { providerEntityIds: [NO_REACH_ID], locationIds: [NO_REACH_ID] },
      malformedGrantCount,
    };
  }
  const cap = (ids: Set<string>, within: readonly string[]): readonly string[] =>
    [...ids].filter((id) => within.length === 0 || within.includes(id));
  return {
    reach: {
      providerEntityIds: cap(pe, defaults.providerEntityIds),
      locationIds: cap(loc, defaults.locationIds),
    },
    malformedGrantCount,
  };
}

/** {@link effectiveReachWithDiagnostics} without the diagnostics. */
export function effectiveReach(
  defaults: MembershipReach,
  grants: readonly { readonly scope: unknown }[],
): MembershipReach {
  return effectiveReachWithDiagnostics(defaults, grants).reach;
}
