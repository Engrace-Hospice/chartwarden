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

import { SYSTEM_ROLE_DISPLAY_NAMES } from "./display-names";

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
  /**
   * The default permission keys this template GRANTS out of the box (the seed a fresh org/platform
   * catalog materializes into `role_permission`). Distinct from `floor` (the un-strippable minimum a
   * `system_locked` role must retain): a non-locked template carries no floor but may still carry a
   * default grant — e.g. the §4.7 platform-ops roles below bind the M35 `billing_admin.*` keys here.
   * Absent → the template grants nothing by default (the historical behavior for the ≈60
   * `system_default` templates whose grants are assigned per-org at seed time). Every `grants` key is a
   * permission-key string owned by some module's catalog fragment (typed `readonly string[]`, not the
   * M3-only `PermissionKey` union), mirroring `floor`.
   */
  grants?: readonly string[];
}

// ── Platform-ops role catalog (§4.7, platform-owned) ───────────────────────────────────────────────────
//
// M35 (Subscription Billing) gates its cross-tenant `/api/admin` surface on the `platform_billing_scope`
// ABAC predicate, which admits any caller carrying a platform-ops role. Those roles are platform-owned (they
// live in the platform catalog, not a tenant's), so they are registered HERE — the single role catalog every
// module binds to — and M35 re-derives its `PLATFORM_BILLING_ROLES` from `PLATFORM_OPS_ROLE_KEYS` so the ABAC
// gate's role list and the catalog can never drift.

/** The six §4.7 platform-ops role keys (the `platform_billing_scope` admit-set). */
export const PLATFORM_OPS_ROLE_KEYS = [
  "platform_owner",
  "platform_admin",
  "platform_billing_admin",
  "platform_support_t2",
  "platform_sales",
  "platform_ops",
] as const;

/** Union of the platform-ops role keys. */
export type PlatformOpsRoleKey = (typeof PLATFORM_OPS_ROLE_KEYS)[number];

// The eighteen M35 `billing_admin.*` permission keys (catalog `category: "billing_admin"`), split by the
// §4.7 binding rule this wave applies (see ADMIN-T02; `dunning.admin.read` added in M35A-T03 as the
// dunning-list screen's read source):
//   • READ keys        → support / billing / admin / owner   (the read-only ops surface)
//   • WRITE/step-up    → billing / admin / owner             (mutating ops, each also §D14 step-up-gated)
//   • refund.approve   → admin / owner ONLY                  (kept DISJOINT from `refund.request` so the
//                                                             §4.8 four-eyes approver ≠ requester rule stays
//                                                             assignable — a `platform_billing_admin` may
//                                                             REQUEST a refund but never self-APPROVE it)
/** The 8 read keys of the M35 `billing_admin.*` surface. */
export const M35_BILLING_ADMIN_READ_KEYS = [
  "plan.admin.read",
  "subscription.admin.read",
  "dunning.admin.read",
  "refund.read",
  "promo.admin.read",
  "revenue.admin.read",
  "usage.admin.read",
  "stripe.admin.read",
] as const;
/** The 9 mutating (write / override / request / apply / revoke / replay) `billing_admin.*` keys. */
export const M35_BILLING_ADMIN_WRITE_KEYS = [
  "plan.admin.write",
  "subscription.admin.write",
  "dunning.admin.override",
  "refund.request",
  "promo.admin.write",
  "promo.admin.apply",
  "promo.admin.revoke",
  "revenue.admin.write",
  "stripe.admin.replay",
] as const;
/** The single four-eyes-gated approval key, kept disjoint from `refund.request`. */
export const M35_REFUND_APPROVE_KEY = "refund.approve" as const;

/** The role sets each key band binds to (owner ⊇ admin ⊇ billing ⊇ support in read reach). */
const PLATFORM_READ_ROLES: readonly PlatformOpsRoleKey[] = [
  "platform_support_t2",
  "platform_billing_admin",
  "platform_admin",
  "platform_owner",
];
const PLATFORM_WRITE_ROLES: readonly PlatformOpsRoleKey[] = [
  "platform_billing_admin",
  "platform_admin",
  "platform_owner",
];
const PLATFORM_APPROVE_ROLES: readonly PlatformOpsRoleKey[] = ["platform_admin", "platform_owner"];
/**
 * GAP-001 follow-up — the platform user-lifecycle grant. `POST /api/v1/platform/users/:id/deactivate`
 * gates on `user.deactivate` AND the M2 `user_lifecycle_platform_ops` ABAC predicate, which admits exactly
 * these roles; without the grant a pure platform operator failed the RBAC check first.
 */
export const PLATFORM_USER_LIFECYCLE_KEY = "user.deactivate" as const;
export const PLATFORM_PASSWORD_RESET_KEY = "user.password.reset" as const;
const PLATFORM_USER_LIFECYCLE_ROLES: readonly PlatformOpsRoleKey[] = [
  "platform_ops",
  "platform_admin",
  "platform_owner",
];

/** Build a platform-ops role's default grant: `billing_admin.*` per the §4.7 binding rule, plus user lifecycle. */
function platformOpsGrantsFor(role: PlatformOpsRoleKey): readonly string[] {
  const keys: string[] = [];
  if (PLATFORM_READ_ROLES.includes(role)) keys.push(...M35_BILLING_ADMIN_READ_KEYS);
  if (PLATFORM_WRITE_ROLES.includes(role)) keys.push(...M35_BILLING_ADMIN_WRITE_KEYS);
  if (PLATFORM_APPROVE_ROLES.includes(role)) keys.push(M35_REFUND_APPROVE_KEY);
  if (PLATFORM_USER_LIFECYCLE_ROLES.includes(role))
    keys.push(PLATFORM_USER_LIFECYCLE_KEY, PLATFORM_PASSWORD_RESET_KEY);
  return keys;
}

/**
 * Default grant per platform-ops role: `billing_admin.*` (§4.7) plus `user.deactivate` for the user-lifecycle
 * roles. `platform_sales` and `platform_ops` carry NO `billing_admin.*` keys under this wave's binding rule — they are still registered (they satisfy the
 * `platform_billing_scope` ABAC gate) but hold no RBAC grant here, so they fail closed at `requirePermission`
 * until a later wave binds their surface. `platform_billing_admin` deliberately lacks `refund.approve`.
 */
export const PLATFORM_OPS_ROLE_GRANTS = Object.fromEntries(
  PLATFORM_OPS_ROLE_KEYS.map((role) => [role, platformOpsGrantsFor(role)]),
) as Record<PlatformOpsRoleKey, readonly string[]>;

/**
 * The `system_locked` permission floor (spec §3.4.1, M03-F06). Each CoP-required role
 * maps to the minimum permission set it must always retain. A tenant may rename or
 * *extend* a locked role but may not delete it or remove any of these keys.
 *
 * EVERY ENTRY MUST BE A KEY THE PERMISSION CATALOG ACTUALLY REGISTERS. Eight of the original
 * twenty-seven were not (F-093) — they were written from the spec's illustrative names before the
 * owning modules registered their real ones, and nothing ever compared the two. That is not a naming
 * blemish: `role_permission.permission_key` REFERENCES `permission.key`, so a floor key with no
 * catalog row cannot be GRANTED at all (the insert dies on the foreign key), which means the CoP floor
 * for four of the six locked roles was unsatisfiable — and once §3.4.1 is genuinely enforced (it was
 * not; see `role-store.ts`), `floorViolations` reports an ungrantable key as stripped on every edit, so
 * a locked role becomes permanently uneditable. `permission-catalog.test.ts` now pins the invariant.
 *
 * The corrections, each a mapping onto the key the owning module registers rather than an invention:
 *   `cti.sign`           → `cti.sign_hospice_md`  M6 splits the CTI signature into the hospice-MD and
 *                                                 attending arms because 42 CFR 418.22(c)(1) requires
 *                                                 both; the Medical Director's is the hospice-MD one.
 *   `idg.participate`    → `idg.attend`           M14's participation key (CoP 418.56(a)(1)).
 *   `order.cosign`       → `orders.cosign`        M11 registers the `orders.*` namespace, not `order.*`.
 *   `care_plan.manage`   → `care_plan.finalize`   Of M7's seven `care_plan.*` keys this is the one that
 *                                                 expresses AUTHORITY over the plan — `author` is
 *                                                 per-discipline, `sign` fills one signer slot, and
 *                                                 `idg_revise` belongs to the group, not the DON.
 *   `assignment.manage`  → `patient.assign`       M5's caseload-assignment key — CoP 418.64(a)'s
 *                                                 "assigns nursing staff to patients", exactly.
 *   `report.read`        → `report.dashboard.read` There is no two-part `report.*` key; this is M33's
 *                                                 read entry point.
 *   `security_event.read`→ `incident.read`        No `security_event` resource exists anywhere in the
 *                                                 platform — no table, no route, no key. §164.308's
 *                                                 information-system-activity review is audit (already
 *                                                 floored here twice) plus SECURITY-INCIDENT TRACKING,
 *                                                 which is M30's `incident.*` surface.
 */
export const SYSTEM_LOCKED_FLOORS = {
  // Medical Director — CoP 418.102.
  medical_director: [
    "patient.read",
    "cti.sign_hospice_md",
    "idg.attend",
    "orders.cosign",
    "breakglass.invoke",
  ],
  // Director of Nursing (DON) — CoP 418.64(a).
  director_of_nursing: [
    "patient.read",
    "care_plan.finalize",
    "idg.attend",
    "patient.assign",
    "breakglass.invoke",
  ],
  // Administrator — CoP 418.100.
  administrator: ["org.manage", "member.manage", "role.read", "report.dashboard.read"],
  // Compliance Officer — CoP 418.52 / HIPAA.
  compliance_officer: [
    "audit.read",
    "audit.disclosure_report",
    "breakglass.read",
    "breakglass.cosign",
    "engagement.manage",
    "legalhold.manage",
  ],
  // HIPAA Privacy Officer — §164.530(a). `privacy.admin` (M5 §4.7) is the privacy official's own
  // control over the patient privacy-flag snapshot (the officer view + "Resync from consent", M5 §5.1);
  // without it the §164.530(a) role could not reach the one screen the M5 spec names it the actor for.
  hipaa_privacy_officer: [
    "audit.read",
    "audit.disclosure_report",
    "consent.read",
    "legalhold.read",
    "privacy.admin",
  ],
  // HIPAA Security Officer — §164.308(a)(2).
  hipaa_security_officer: ["audit.read", "audit.integrity", "incident.read"],
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
    name: SYSTEM_ROLE_DISPLAY_NAMES.medical_director,
    category: "clinical_leadership",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.102 hospice medical director.",
    floor: SYSTEM_LOCKED_FLOORS.medical_director,
    // WP 4.1 (ADR-0068): a physician may raise and receive an urgent clinical message, as migration 1105 grants.
    grants: ["messaging.urgent.send", "messaging.urgent.receive"],
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
    // The lifecycle review queue is a supervisory decision (ADR-0065 D6); no template grants it to the org-wide admins.
    // WP 4.1 (ADR-0068): the supervisory nurse may raise and receive an urgent clinical message, as migration 1105 grants.
    grants: ["messaging.review", "messaging.urgent.send", "messaging.urgent.receive"],
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
    name: SYSTEM_ROLE_DISPLAY_NAMES.compliance_officer,
    category: "compliance_quality",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.52 / HIPAA compliance officer; default break-glass approver.",
    floor: SYSTEM_LOCKED_FLOORS.compliance_officer,
    // M5 §4.7 grants `privacy.admin` to "Privacy Officer, Compliance Officer" (§6: both may resync privacy
    // flags). `step_up_override.manage` (GAP-115, M2 §4.1: "org_admin/compliance_officer") likewise. A DEFAULT grant, not floor: the CoP 418.52 floor is the un-strippable minimum, and a tenant
    // whose privacy official alone should hold resync may remove it from the compliance officer.
    grants: [
      ...SYSTEM_LOCKED_FLOORS.compliance_officer,
      "privacy.admin",
      "step_up_override.manage",
      // GAP-010: the compliance officer may reveal a stored SSN (M5 spec 4.7); the single source is ssn-grants.ts.
      "phi.read_ssn",
    ],
  },
  {
    key: "hipaa_privacy_officer",
    name: SYSTEM_ROLE_DISPLAY_NAMES.hipaa_privacy_officer,
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
  // ── §4.7 platform-ops roles (platform_staff, category K). Non-locked (no CoP floor); each carries its
  // default M35 `billing_admin.*` grant via `PLATFORM_OPS_ROLE_GRANTS`. `scopeLevel` is `organization` —
  // the broadest `scope_level` enum value (there is no platform-wide scope), which the platform console's
  // ABAC gate (`platform_billing_scope`) confines to the cross-tenant admin surface, not any one org.
  {
    key: "platform_owner",
    name: "Platform Owner",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops owner — full billing-admin surface incl. refund approval and MRR/ARR.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_owner,
  },
  {
    key: "platform_admin",
    name: "Platform Admin",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops admin — full billing-admin surface incl. refund approval (four-eyes approver).",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_admin,
  },
  {
    key: "platform_billing_admin",
    name: "Platform Billing Admin",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops billing admin — reads + mutates the billing surface and REQUESTS refunds; cannot self-approve them (§4.8 four-eyes).",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_billing_admin,
  },
  {
    key: "platform_support_t2",
    name: "Platform Support (Tier 2)",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description: "Platform-ops tier-2 support — read-only across the billing-admin surface.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_support_t2,
  },
  {
    key: "platform_sales",
    name: "Platform Sales",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops sales — satisfies `platform_billing_scope`; no default `billing_admin.*` grant this wave.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_sales,
  },
  {
    key: "platform_ops",
    name: "Platform Operations",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops operations — satisfies `platform_billing_scope`; no default `billing_admin.*` grant this wave.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_ops,
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

/**
 * The default role keys that GRANT `permissionKey` out of the box — the union of every template whose
 * `grants` (or `system_locked` `floor`) includes it. Used to prove no permission key is orphaned (each
 * `billing_admin.*` key must resolve to ≥1 role, else the whole surface is 403-for-all).
 */
export function rolesForPermission(permissionKey: string): readonly string[] {
  return ROLE_TEMPLATES.filter(
    (t) => (t.grants ?? []).includes(permissionKey) || t.floor.includes(permissionKey),
  ).map((t) => t.key);
}

/** A single seedable `role_permission` grant row: which platform-ops role holds which permission key. */
export interface RolePermissionSeedRow {
  roleKey: PlatformOpsRoleKey;
  permissionKey: string;
}

/**
 * The platform-ops role→permission grant seed (§4.7). Flattens `PLATFORM_OPS_ROLE_GRANTS` into the
 * `(roleKey, permissionKey)` rows a platform-catalog seed materializes into `role_permission` — the
 * platform analogue of the per-org grant the dev seed writes for tenant roles.
 */
export function platformOpsRolePermissionSeedRows(): RolePermissionSeedRow[] {
  return PLATFORM_OPS_ROLE_KEYS.flatMap((roleKey) =>
    PLATFORM_OPS_ROLE_GRANTS[roleKey].map((permissionKey) => ({ roleKey, permissionKey })),
  );
}
