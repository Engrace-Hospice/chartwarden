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

export type GrantScopeParse =
  | { readonly ok: true; readonly scope: RoleGrantScope }
  | { readonly ok: false; readonly reason: string };

/** Parse whatever is stored / submitted into a {@link RoleGrantScope}. `null`, `undefined` and `{}` mean "no narrowing". */
export function parseRoleGrantScope(raw: unknown): GrantScopeParse {
  if (raw === null || raw === undefined) return { ok: true, scope: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "scope must be an object" };
  }
  const record = raw as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((k) => !SCOPE_KEYS.has(k));
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
  if (!parsed.ok) return [{ code: "SCOPE_MALFORMED", message: parsed.reason }];
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

/**
 * The reach a member actually has, reduced from their LIVE role grants. `grants` are the live (enabled, unexpired,
 * conferring) grants' stored scopes; a malformed stored scope reads as "no narrowing" for that role (it can never
 * WIDEN: the result is always capped to the membership defaults when those are set).
 */
export function effectiveReach(
  defaults: MembershipReach,
  grants: readonly { readonly scope: unknown }[],
): MembershipReach {
  if (grants.length === 0) return defaults;
  const pe = new Set<string>();
  const loc = new Set<string>();
  for (const grant of grants) {
    const parsed = parseRoleGrantScope(grant.scope);
    const scope = parsed.ok ? parsed.scope : {};
    for (const id of scope.providerEntityIds ?? defaults.providerEntityIds) pe.add(id);
    for (const id of scope.locationIds ?? defaults.locationIds) loc.add(id);
  }
  const cap = (ids: Set<string>, within: readonly string[]): readonly string[] =>
    [...ids].filter((id) => within.length === 0 || within.includes(id));
  return {
    providerEntityIds: cap(pe, defaults.providerEntityIds),
    locationIds: cap(loc, defaults.locationIds),
  };
}
