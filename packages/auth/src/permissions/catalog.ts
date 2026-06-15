// @wardenx/auth · permissions catalog (M3 — Authorization, M3-T01; spec §3.3).
//
// The permission catalog is **code** — the single source of truth — and a read-only
// `permission` DB table mirrors it for admin-UI listing and `role_permission` FKs
// (mirror table + sync land with the role tables in M3-T02). This file ships the
// cross-cutting subset Module 3 OWNS: the `role.*`, `breakglass.*`, and `engagement.*`
// keys (spec §3.3). Identity-admin keys (Module 2, §4.5) and audit keys (Module 4,
// §4.5) are illustrative in the spec but are registered by *those* modules' own
// fragments (M03-F07) — they are not M3's source of truth and are intentionally NOT
// shipped here (M2 keys back-fill in M3-T10, M4 keys in M4-T10).
//
// Other modules contribute their own resource keys (`patient.*`, `encounter.*`, …) by
// extending the catalog in their own build against the `PermissionDef` shape below.

/**
 * The shape every catalog entry satisfies. A permission key is the `resource.action`
 * map key; `category` groups keys for the admin UI; `abac` names the default ABAC
 * predicate that guards the key, or `'none'` for pure RBAC keys.
 */
export interface PermissionDef {
  /** The resource the key governs (e.g. `role`, `breakglass`). */
  resource: string;
  /** The verb performed on the resource (e.g. `read`, `manage`, `invoke`). */
  action: string;
  /** Admin-UI grouping (e.g. `admin`, `clinical`, `compliance`). */
  category: string;
  /** Default ABAC predicate name guarding the key, or `'none'` for pure RBAC. */
  abac: string;
}

/**
 * Module 3's cross-cutting permission keys (spec §3.3). Each key is `resource.action`
 * and all of M3's own keys are pure RBAC (`abac: 'none'`) — the named-predicate
 * registry that other keys reference lands in M3-T07.
 */
export const PERMISSIONS = {
  // --- role administration ---
  "role.read": { resource: "role", action: "read", category: "admin", abac: "none" },
  "role.manage": { resource: "role", action: "manage", category: "admin", abac: "none" },
  "role.assign": { resource: "role", action: "assign", category: "admin", abac: "none" },
  // --- break-glass emergency access ---
  "breakglass.invoke": {
    resource: "breakglass",
    action: "invoke",
    category: "clinical",
    abac: "none",
  },
  "breakglass.cosign": {
    resource: "breakglass",
    action: "cosign",
    category: "compliance",
    abac: "none",
  },
  "breakglass.read": {
    resource: "breakglass",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  // --- auditor engagements ---
  "engagement.manage": {
    resource: "engagement",
    action: "manage",
    category: "compliance",
    abac: "none",
  },
  "engagement.read": {
    resource: "engagement",
    action: "read",
    category: "compliance",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of every permission key in the catalog; every module's keys must satisfy this. */
export type PermissionKey = keyof typeof PERMISSIONS;

/**
 * A row of the read-only `permission` mirror table (spec §3.3). Shape matches the
 * Drizzle `permission` table that lands in M3-T02; `defaultAbac` carries the catalog
 * `abac` value (predicate name or `'none'`).
 */
export interface PermissionMirrorRow {
  key: string;
  resource: string;
  action: string;
  category: string;
  defaultAbac: string;
  description: string;
}

/**
 * Project the code catalog into the rows that mirror to the DB `permission` table.
 * This is the catalog→DB sync contract: the mirror is regenerated from the catalog on
 * deploy, so the catalog stays the source of truth and the table never drifts.
 */
export function permissionMirrorRows(): PermissionMirrorRow[] {
  return (Object.keys(PERMISSIONS) as PermissionKey[]).map((key) => {
    const def = PERMISSIONS[key];
    return {
      key,
      resource: def.resource,
      action: def.action,
      category: def.category,
      defaultAbac: def.abac,
      description: "",
    };
  });
}
