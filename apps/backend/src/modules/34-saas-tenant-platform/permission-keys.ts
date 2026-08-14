// apps/backend/src/modules/34-saas-tenant-platform/permission-keys.ts — M34 (§4.5 / D7).
//
// The FORTY-ONE permission keys Module 34 (SaaS Tenant Platform) registers into Module 3's catalog
// — the §4.5 binding cross-module handshake (M34 spec §4.5). M3 must include these before M34's
// platform-control-plane routes (tenant lifecycle, onboarding, invitations, support sessions, DSAR
// + tenant export, feature flags, BAA register, signup intents) can be authorized; those routes
// (a later M34 phase) gate on them. The catalog `abac` field is the DEFAULT predicate per key (the
// §4.1 Auth column); the route layer additionally composes the explicit §4.6 chain M34 owns
// (./abac-predicates) — e.g. `tenant_lifecycle_platform_ops` on the platform-ops tenant surface,
// `feature_flag_write_authority` on flag writes, `dsar_export_patient_caseload_or_org_admin` on
// DSAR request.
//
// D7 records that the unique-DOMAIN count at decision time was twenty-three; the locked key set
// audited to FORTY-ONE (the §4.5 list below). Same `resource.action[_scope]` shape and DB-mirror
// contract as M3's own `PERMISSIONS`; kept in a dedicated const so each module's contribution stays
// attributable (§3.3 ownership).
//
// PLATFORM-OPS NOTE (M34-F03): `platform_ops` is an M3 RBAC ROLE on a staff session, NOT a session
// class. The platform-surface keys below default to ABAC `tenant_lifecycle_platform_ops`, which
// tests the role (not `ctx.sessionClass`); see ./abac-predicates.
//
// REGISTRATION: this map is consumed by `@wardenx/auth`'s contributed-permission registry exactly
// as the M22 `M22_CONTRIBUTED_PERMISSIONS` map is (packages/auth/src/permissions/contributed.ts —
// `m22ContributedPermissionMirrorRows`). The companion mirror-row projector + `allPermissionMirrorRows`
// wiring lands in that file (M3-owned catalog) in this phase's auth-package edit; this typed list is
// the M34-owned source of truth those rows project from.
import type { PermissionDef } from "@wardenx/auth";

/**
 * The §4.5 permission keys M34 owns (registered into M3). Single-owner across the platform registry.
 * `as const satisfies` pins the literal keys while validating each value against `PermissionDef`.
 */
export const M34_CONTRIBUTED_PERMISSIONS = {
  // --- tenant lifecycle: platform-ops surface (§4.5) ---
  "tenant.list_platform": {
    resource: "tenant_account",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.read_platform": {
    resource: "tenant_account",
    action: "read_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.provision": {
    resource: "tenant_account",
    action: "provision",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.transition_status": {
    resource: "tenant_account",
    action: "transition_status",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.offboard": {
    resource: "tenant_account",
    action: "offboard",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.shred.execute": {
    resource: "tenant_key_ring",
    action: "shred_execute",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.dek_rotate": {
    resource: "tenant_key_ring",
    action: "dek_rotate",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  // --- tenant lifecycle: tenant surface (§4.5) ---
  "tenant.read_own": {
    resource: "tenant_account",
    action: "read_own",
    category: "admin",
    abac: "none",
  },
  // --- onboarding (§4.5) ---
  "onboarding.read_platform": {
    resource: "onboarding_task",
    action: "read_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "onboarding.read_own": {
    resource: "onboarding_task",
    action: "read_own",
    category: "admin",
    abac: "none",
  },
  "onboarding.update": {
    resource: "onboarding_task",
    action: "update",
    category: "admin",
    abac: "onboarding_task_assignee_or_owner",
  },
  "onboarding.skip": {
    resource: "onboarding_task",
    action: "skip",
    category: "admin",
    abac: "onboarding_task_assignee_or_owner",
  },
  "onboarding_template.list": {
    resource: "onboarding_task_template",
    action: "list",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "onboarding_template.write": {
    resource: "onboarding_task_template",
    action: "write",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  // --- invitations (§4.5) ---
  "tenant_invitation.list_platform": {
    resource: "tenant_invitation",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant_invitation.issue": {
    resource: "tenant_invitation",
    action: "issue",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant_invitation.revoke": {
    resource: "tenant_invitation",
    action: "revoke",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  // --- support sessions (tenant-consented break-glass) (§4.5) ---
  "support_session.list_platform": {
    resource: "support_session",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "support_session.start": {
    resource: "support_session",
    action: "start",
    category: "platform",
    abac: "support_session_actor_distinct_from_grantor",
  },
  "support_session.elevate_phi_read": {
    resource: "support_session",
    action: "elevate_phi_read",
    category: "platform",
    abac: "tenant_consented_support_active",
  },
  "support_session.close": {
    resource: "support_session",
    action: "close",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "support_consent_grant.list_own": {
    resource: "support_consent_grant",
    action: "list_own",
    category: "admin",
    abac: "none",
  },
  "support_consent_grant.issue": {
    resource: "support_consent_grant",
    action: "issue",
    category: "admin",
    abac: "none",
  },
  "support_consent_grant.revoke": {
    resource: "support_consent_grant",
    action: "revoke",
    category: "admin",
    abac: "none",
  },
  // --- DSAR export (§4.5) ---
  "dsar_export.list_platform": {
    resource: "dsar_export_job",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "dsar_export.list_own": {
    resource: "dsar_export_job",
    action: "list_own",
    category: "compliance",
    abac: "none",
  },
  "dsar_export.request": {
    resource: "dsar_export_job",
    action: "request",
    category: "compliance",
    abac: "dsar_export_patient_caseload_or_org_admin",
  },
  "dsar_export.fulfill": {
    resource: "dsar_export_job",
    action: "fulfill",
    category: "compliance",
    abac: "none",
  },
  "dsar_export.extend": {
    resource: "dsar_export_job",
    action: "extend",
    category: "compliance",
    abac: "none",
  },
  "dsar_export.deny": {
    resource: "dsar_export_job",
    action: "deny",
    category: "compliance",
    abac: "none",
  },
  "dsar_export.download": {
    resource: "dsar_export_job",
    action: "download",
    category: "compliance",
    abac: "dsar_export_patient_caseload_or_org_admin",
  },
  // --- tenant export (§4.5) ---
  "tenant_export.list_platform": {
    resource: "tenant_export_job",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant_export.list_own": {
    resource: "tenant_export_job",
    action: "list_own",
    category: "admin",
    abac: "none",
  },
  "tenant_export.request": {
    resource: "tenant_export_job",
    action: "request",
    category: "admin",
    abac: "tenant_export_org_admin_or_platform_ops",
  },
  "tenant_export.download": {
    resource: "tenant_export_job",
    action: "download",
    category: "admin",
    abac: "tenant_export_org_admin_or_platform_ops",
  },
  // GAP-097: the SEC-052 second-actor release for an oversized-hold bundle (typebox.ts's
  // `ApproveOversizedExportRequest`, documented since M34-T-phase but never registered as a route).
  "tenant_export.approve_oversized": {
    resource: "tenant_export_job",
    action: "approve_oversized",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  // --- feature flags: admin surface (§4.5) ---
  "feature_flag.read_platform": {
    resource: "feature_flag",
    action: "read_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "feature_flag.read_own": {
    resource: "feature_flag",
    action: "read_own",
    category: "admin",
    abac: "none",
  },
  "feature_flag.write_platform": {
    resource: "feature_flag",
    action: "write_platform",
    category: "platform",
    abac: "feature_flag_write_authority",
  },
  "feature_flag.write_tenant": {
    resource: "feature_flag",
    action: "write_tenant",
    category: "admin",
    abac: "feature_flag_write_authority",
  },
  "feature_flag.kill_switch": {
    resource: "feature_flag",
    action: "kill_switch",
    category: "platform",
    abac: "feature_flag_write_authority",
  },
  // --- platform-tenant BAA register (§4.5) ---
  "platform_tenant_baa.read_platform": {
    resource: "platform_tenant_baa_record",
    action: "read_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "platform_tenant_baa.read_own": {
    resource: "platform_tenant_baa_record",
    action: "read_own",
    category: "compliance",
    abac: "none",
  },
  "platform_tenant_baa.attest": {
    resource: "platform_tenant_baa_record",
    action: "attest",
    category: "compliance",
    abac: "tenant_platform_baa_compliance_officer",
  },
  // --- signup intents (§4.5) ---
  "signup_intent.list_platform": {
    resource: "tenant_signup_intent",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "signup_intent.qualify": {
    resource: "tenant_signup_intent",
    action: "qualify",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M34 contributed permission keys (forty-one). */
export type M34ContributedPermissionKey = keyof typeof M34_CONTRIBUTED_PERMISSIONS;

/**
 * The §4.5 permission-key names M34 owns, as an ordered literal tuple ready for registration.
 * Convenience projection of `M34_CONTRIBUTED_PERMISSIONS` keys (the boot path / auth-package
 * mirror-row projector consumes the full map; this is the flat name list for assertions/tests).
 */
export const M34_PERMISSION_KEYS = Object.keys(
  M34_CONTRIBUTED_PERMISSIONS,
) as readonly M34ContributedPermissionKey[];
