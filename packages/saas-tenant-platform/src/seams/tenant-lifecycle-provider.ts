// @wardenx/saas-tenant-platform — the `TenantLifecycleProvider` seam (M34 §4.6).
//
// The platform control-plane's single source of truth for "is this tenant allowed to operate?".
// Every downstream module that needs to gate writes / sessions / claims / dispatch consults
// {@link TenantLifecycleProvider.activeStatusForOrg} rather than reading `tenant_account` directly
// (no cross-module schema import edge — the dependency-cruiser rule blocks it). The rich interface
// lives HERE in the feature package; the M1 seam registry holds the registered instance opaquely and
// validateSeams() fails closed at boot if M34 never registered it.
//
// The status union mirrors the `tenant_account_status` pgEnum (packages/db/src/schema/saas/
// tenant-account.ts) as a type-level constant so the seam contract does not take a project-reference
// edge on @wardenx/db. Keep the two in lock-step when the enum changes (M34 §3.3).

/**
 * The tenant-account lifecycle status (§3.3). Type-level mirror of the `tenant_account_status`
 * pgEnum — `signup_intent → provisioning → onboarding → active`, then the at-risk / offboarding /
 * retention / destruction terminal arc. `destroyed` is the cryptographic-shred terminal state.
 */
export type TenantAccountStatus =
  | "signup_intent"
  | "provisioning"
  | "onboarding"
  | "active"
  | "suspended"
  | "at_risk"
  | "offboarding_initiated"
  | "final_export_pending"
  | "retained"
  | "destruction_pending"
  | "destroyed";

/** The resolved lifecycle snapshot for one org. `status` is `'unknown_org'` (defense in depth —
 *  never silently `active`) when no `tenant_account` row exists for the org. */
export interface TenantLifecycleStatus {
  readonly status: TenantAccountStatus | "unknown_org";
  readonly planLabel: string | null;
  readonly activatedAt: Date | null;
  readonly retentionEndsAt: Date | null;
}

/** One org whose retention window expires within the queried period (§4.6, M4's destruction scan). */
export interface RetentionExpiry {
  readonly orgId: string;
  readonly retentionEndsAt: Date;
}

/**
 * The boot-registered tenant-lifecycle read surface (§4.6). The single answer every downstream
 * module consults to decide if writes / sessions / claims / dispatch are permitted.
 */
export interface TenantLifecycleProvider {
  /**
   * The authoritative lifecycle gate. Returns `'unknown_org'` if no `tenant_account` exists for the
   * org (defense in depth — never silently `'active'`).
   */
  activeStatusForOrg(orgId: string): Promise<TenantLifecycleStatus>;

  /** Used by M2 to decide if the M2 `organization_invitation` flow may begin. */
  firstAdminInvitationConsumed(orgId: string): Promise<boolean>;

  /** Returns the `plan_label` for display in dashboards. */
  planLabelForOrg(orgId: string): Promise<string | null>;

  /** Used by M4's quarterly destruction-eligibility scan. */
  retentionExpiringWithin(period: { days: number }): Promise<RetentionExpiry[]>;
}
