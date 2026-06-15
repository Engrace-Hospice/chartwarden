// @wardenx/auth · permissions — the M1/M2 permission-key back-fill (M3 — Authorization,
// M3-T10; spec §3.3 / M03-F07; M2 spec §4.7 binding handshake).
//
// The §3.3 ownership model: the catalog is code, and EACH module contributes its own
// `resource.action` keys into Module 3's now-real catalog (mirrored to the DB `permission`
// table). M3's own cross-cutting subset (`role.*` / `breakglass.*` / `engagement.*`) is the
// LOCKED `PERMISSIONS` const in ./catalog (a unit test pins it to exactly those eight keys);
// the keys OTHER modules own live here so the catalog const never drifts from M3's surface.
//
// This file closes the M2-T08 deferral: Module 2's admin routes are authorized by Module 3,
// so their permission keys must be in M3's catalog and assigned to the default `org_admin` /
// `platform_ops` templates (M2 spec §4.7). When M2's routes flipped from the M1 deny-stub to
// the real `requirePermission`/`requireAbac` (M3-T10), these are the keys the resolver grants.
//
// Module 1 (Foundation) contributes NO fine-grained permission key: its only privileged route
// (system-status mutation) is gated by the coarse `platform_ops` ROLE via `requireRole`, not a
// permission key, so there is nothing for M1 to register here.
import { type PermissionDef, type PermissionMirrorRow, permissionMirrorRows } from "./catalog";

/**
 * The permission keys Modules 1 & 2 register into Module 3's catalog (the §4.7 handshake).
 * Same `resource.action` shape and DB-mirror contract as M3's own `PERMISSIONS`; kept
 * separate only so the M3-owned catalog const stays exactly M3's cross-cutting subset.
 */
export const CONTRIBUTED_PERMISSIONS = {
  // --- Module 2 (Identity & Org) admin keys (M2 spec §4.7) ---
  // Org/ProviderEntity/Location CRUD + HearthNote opt-in (org_admin, platform_ops).
  "org.manage": { resource: "org", action: "manage", category: "admin", abac: "none" },
  // POST /orgs/:id/invitations (+ rescind) — invite a user to an org (org_admin).
  "member.invite": { resource: "member", action: "invite", category: "admin", abac: "none" },
  // Suspend/reinstate/revoke a membership + default-scope edits (org_admin).
  "member.manage": { resource: "member", action: "manage", category: "admin", abac: "none" },
  // Full offboard — disable credentials everywhere (org_admin own-org / platform_ops any).
  "user.deactivate": { resource: "user", action: "deactivate", category: "admin", abac: "none" },
  // Per-patient collaborator magic-link — clinician on the patient's caseload (ABAC), or
  // org_admin. The default ABAC predicate is `caseload_membership` (M5/M17 provider seam).
  "collaborator.invite": {
    resource: "collaborator",
    action: "invite",
    category: "clinical",
    abac: "caseload_membership",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the contributed permission keys (M1/M2). */
export type ContributedPermissionKey = keyof typeof CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 4 (Audit & Compliance Log) registers into Module 3's catalog —
 * the §4.5 binding cross-module handshake (M4-T10; M4 spec §4.5). M3 must include these before
 * M4's routes can be authorized; the audit/legal-hold/destruction routes (M4-T06/T08) gate on
 * them, and the six CoP-required `system_locked` compliance roles already pin their load-bearing
 * subset (`audit.read`/`audit.disclosure_report`/`audit.integrity`/`legalhold.*`) in their floor
 * (M3-T02 SYSTEM_LOCKED_FLOORS). Kept in a dedicated const (not folded into the M1/M2
 * `CONTRIBUTED_PERMISSIONS`) so each module's contribution stays attributable (§3.3 ownership).
 *
 * `audit.disclosure_report_all_scopes` is the only ABAC-gated key: the §164.528 / §2.13
 * accounting route's `?scope=all` additionally requires the `audit_accounting_scope_allowed`
 * predicate M4 registered into M3 (M4-T09, §7.2).
 */
export const M4_CONTRIBUTED_PERMISSIONS = {
  // --- audit read / reporting (§4.5) ---
  "audit.read": { resource: "audit", action: "read", category: "compliance", abac: "none" },
  "audit.disclosure_report": {
    resource: "audit",
    action: "disclosure_report",
    category: "compliance",
    abac: "none",
  },
  "audit.disclosure_report_all_scopes": {
    resource: "audit",
    action: "disclosure_report_all_scopes",
    category: "compliance",
    abac: "audit_accounting_scope_allowed",
  },
  "audit.export": { resource: "audit", action: "export", category: "compliance", abac: "none" },
  "audit.integrity": {
    resource: "audit",
    action: "integrity",
    category: "compliance",
    abac: "none",
  },
  // --- legal hold (§4.5) ---
  "legalhold.read": {
    resource: "legalhold",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  "legalhold.manage": {
    resource: "legalhold",
    action: "manage",
    category: "compliance",
    abac: "none",
  },
  // --- destruction (§4.5; destruction.approve additionally step-up re-auths at the route) ---
  "destruction.read": {
    resource: "destruction",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  "destruction.approve": {
    resource: "destruction",
    action: "approve",
    category: "compliance",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M4 contributed permission keys. */
export type M4ContributedPermissionKey = keyof typeof M4_CONTRIBUTED_PERMISSIONS;

/** Project a contributed-key map into `permission`-table mirror rows (same contract as M3's). */
function mirrorRowsFor(map: Record<string, PermissionDef>): PermissionMirrorRow[] {
  return Object.entries(map).map(([key, def]) => ({
    key,
    resource: def.resource,
    action: def.action,
    category: def.category,
    defaultAbac: def.abac,
    description: "",
  }));
}

/** Project the M1/M2 contributed keys into `permission`-table mirror rows. */
export function contributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(CONTRIBUTED_PERMISSIONS);
}

/** Project the M4 contributed keys into `permission`-table mirror rows (M4-T10). */
export function m4ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M4_CONTRIBUTED_PERMISSIONS);
}

/**
 * The full `permission`-table mirror: M3's own cross-cutting keys plus every contributed
 * (M1/M2 + M4) key. This is the row set the deploy-time sync writes to the read-only
 * `permission` table once the catalog goes real. Keys are single-owner across all sets — a
 * collision would be a registration bug, so the deploy sync (and the unit test) asserts uniqueness.
 */
export function allPermissionMirrorRows(): PermissionMirrorRow[] {
  return [
    ...permissionMirrorRows(),
    ...contributedPermissionMirrorRows(),
    ...m4ContributedPermissionMirrorRows(),
  ];
}
