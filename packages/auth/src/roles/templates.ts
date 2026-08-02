// @wardenx/auth · role catalog + `system_locked` permission floor (M3 — Authorization,
// M3-T02; spec §3.4, §3.4.1, M03-F06).
//
// The role catalog is the public surface every module binds permissions to. A role is a
// named set of permissions; a tenant may disable, rename, clone, or extend the defaults,
// but it **cannot delete a `system_locked` role or strip it below its CoP-required
// permission floor**. This file owns the floor — the load-bearing, normatively-specified
// part of §3.4.1 that §2.4 validation and the role editor (PATCH /roles/:id, M3-T08)
// enforce. The ≈60 default `system_default` templates are normatively enumerated in the
// spec's Appendix A (generated from this file, CI-checked); the concretely-specified
// `system_locked` roles below are the floor-bearing subset this task ships.

// NOTE: these two unions mirror the `role_category` / `scope_level` DB enums (spec §3.2,
// authored in packages/db/src/enums.ts under M3-T01). They are inlined rather than imported
// from `@wardenx/db` on purpose: M3 (dependsOn: [2]) may reach db only through the
// `packages/db/src/schema` type surface, not the `@wardenx/db` runtime barrel (the import
// boundary in .dependency-cruiser.cjs). check-ddl-legality.ts keeps the DB enum canonical.

/** The twelve role categories A–L (mirrors the `role_category` DB enum, spec §3.2). */
export type RoleCategory =
  | "clinical_staff"
  | "clinical_leadership"
  | "operations"
  | "admin_executive"
  | "billing_finance"
  | "compliance_quality"
  | "volunteer"
  | "patient_family"
  | "external_auditor"
  | "external_collaborator"
  | "platform_staff"
  | "temporary_special";
/** How broadly a role grants (mirrors the `scope_level` DB enum, spec §3.2). */
export type ScopeLevel = "organization" | "provider_entity" | "location" | "patient";

/**
 * A default role template. `key` is the stable catalog identifier (snake_case);
 * `floor` is the minimum permission-key set a `system_locked` role must always retain
 * (empty for non-locked roles). Floor entries are permission-key strings — many name
 * keys owned by *other* modules (e.g. `patient.read`, `cti.sign`), which those modules
 * register into the catalog (spec §3.3), so the floor is typed `readonly string[]`, not
 * the M3-only `PermissionKey` union.
 */
export interface RoleTemplate {
  key: string;
  name: string;
  category: RoleCategory;
  scopeLevel: ScopeLevel;
  systemDefault: boolean;
  systemLocked: boolean;
  description: string;
  /** CoP-required permission floor (minimum — may not be stripped below). */
  floor: readonly string[];
}

/**
 * The `system_locked` permission floor (spec §3.4.1, M03-F06). Each CoP-required role
 * maps to the minimum permission set it must always retain. A tenant may rename or
 * *extend* a locked role but may not delete it or remove any of these keys.
 */
export const SYSTEM_LOCKED_FLOORS = {
  // Medical Director — CoP 418.102.
  medical_director: [
    "patient.read",
    "cti.sign",
    "idg.participate",
    "order.cosign",
    "breakglass.invoke",
  ],
  // Director of Nursing (DON) — CoP 418.64(a).
  director_of_nursing: [
    "patient.read",
    "care_plan.manage",
    "idg.participate",
    "assignment.manage",
    "breakglass.invoke",
  ],
  // Administrator — CoP 418.100.
  administrator: ["org.manage", "member.manage", "role.read", "report.read"],
  // Compliance Officer — CoP 418.52 / HIPAA.
  compliance_officer: [
    "audit.read",
    "audit.disclosure_report",
    "breakglass.read",
    "breakglass.cosign",
    "engagement.manage",
    "legalhold.manage",
  ],
  // HIPAA Privacy Officer — §164.530(a).
  hipaa_privacy_officer: [
    "audit.read",
    "audit.disclosure_report",
    "consent.read",
    "legalhold.read",
  ],
  // HIPAA Security Officer — §164.308(a)(2).
  hipaa_security_officer: ["audit.read", "audit.integrity", "security_event.read"],
} as const satisfies Record<string, readonly string[]>;

/** Union of the `system_locked` role keys (the CoP-required floor-bearing roles). */
export type SystemLockedRoleKey = keyof typeof SYSTEM_LOCKED_FLOORS;

/**
 * The floor-bearing subset of the role catalog: the six CoP-required `system_locked`
 * roles (spec §3.4.1). The ≈60 `system_default` (non-locked) templates extend this array
 * — they are enumerated in Appendix A and carry an empty floor.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: "medical_director",
    name: "Medical Director",
    category: "clinical_leadership",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.102 hospice medical director.",
    floor: SYSTEM_LOCKED_FLOORS.medical_director,
  },
  {
    key: "director_of_nursing",
    name: "Director of Nursing",
    category: "clinical_leadership",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.64(a) director of nursing services.",
    floor: SYSTEM_LOCKED_FLOORS.director_of_nursing,
  },
  {
    key: "administrator",
    name: "Administrator",
    category: "admin_executive",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.100 hospice administrator.",
    floor: SYSTEM_LOCKED_FLOORS.administrator,
  },
  {
    // SaaS tenant/account administrator — the operational org-admin the platform's
    // authorization layer keys on: `isAdmin` derivation (rbac/drizzle-store.ts
    // ORG_ADMIN_ROLE_KEY), the M2 last-admin lockout guard, tenant provisioning's
    // first-admin, and the ~10 `hasRole(ctx,"org_admin")` ABAC predicates across
    // M20/M22/M23/M24/M25/M32/M33/M34. Distinct from the CoP-418.100 `administrator`
    // (clinical/regulatory) role: a tenant may hold either or both. Non-locked (no CoP
    // permission floor); grantable as a `system_default` template.
    key: "org_admin",
    name: "Organization Administrator",
    category: "admin_executive",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description: "SaaS tenant/account administrator (org-scoped platform authority).",
    floor: [],
  },
  {
    key: "compliance_officer",
    name: "Compliance Officer",
    category: "compliance_quality",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.52 / HIPAA compliance officer; default break-glass approver.",
    floor: SYSTEM_LOCKED_FLOORS.compliance_officer,
  },
  {
    key: "hipaa_privacy_officer",
    name: "HIPAA Privacy Officer",
    category: "compliance_quality",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "§164.530(a) privacy official.",
    floor: SYSTEM_LOCKED_FLOORS.hipaa_privacy_officer,
  },
  {
    key: "hipaa_security_officer",
    name: "HIPAA Security Officer",
    category: "compliance_quality",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "§164.308(a)(2) security official.",
    floor: SYSTEM_LOCKED_FLOORS.hipaa_security_officer,
  },
] as const;

/** True when `roleKey` names a CoP-required `system_locked` role. */
export function isSystemLocked(roleKey: string): roleKey is SystemLockedRoleKey {
  return Object.hasOwn(SYSTEM_LOCKED_FLOORS, roleKey);
}

/**
 * The required permission floor for a role, or `[]` for non-locked roles. The role
 * editor unions a proposed permission set with this to guarantee the floor is retained.
 */
export function floorFor(roleKey: string): readonly string[] {
  return isSystemLocked(roleKey) ? SYSTEM_LOCKED_FLOORS[roleKey] : [];
}

/**
 * Floor enforcement (spec §2.4 / §3.4.1): the permission keys that `proposedKeys` would
 * illegally strip from a `system_locked` role. A non-empty result means the edit must be
 * rejected (the role editor returns 409). Non-locked roles never violate (empty result).
 */
export function floorViolations(
  roleKey: string,
  proposedKeys: readonly string[],
): readonly string[] {
  const have = new Set(proposedKeys);
  return floorFor(roleKey).filter((key) => !have.has(key));
}

/** True when `proposedKeys` retains every floor permission of `roleKey` (§3.4.1). */
export function satisfiesFloor(roleKey: string, proposedKeys: readonly string[]): boolean {
  return floorViolations(roleKey, proposedKeys).length === 0;
}
