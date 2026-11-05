// apps/backend/src/bootstrap/onboarding-credential-port.ts — the seam through which the platform onboarding routes
// (M34 `/api/v1/platform/tenants/:orgSlug/…`) fill in a tenant's billing credentials without importing the billing
// modules (M34 has no `dependsOn` edge to M23/M24, and M23/M24 may not import each other, so the contract lives here
// beside `reject-ai-actor.ts`, the other bootstrap-shared seam).
//
// The owning module implements the port over ITS OWN write service, so the validation, the envelope encryption and
// the row logic are the ones the tenant's own admin screen runs — nothing is re-implemented for the operator. The
// port takes the CALLER'S open transaction (already scoped to the target org's `app.org_id` and attributed to the
// operator), so the credential write commits or rolls back with the tenant-status check and the audit row.
import type { DbClient } from "@chartwarden/db";

/** The platform operator acting for a tenant, and the tenant. Every field is server-assembled, never from a body. */
export interface OnboardingWriteScope {
  /** The TARGET tenant the row lands in (not the operator's own org). */
  readonly organizationId: string;
  readonly operatorUserId: string;
  readonly operatorMembershipId: string;
  readonly operatorRoles: readonly string[];
  /** The route's `requireStepUp` guard has already passed when this is true. */
  readonly stepUpRecent: boolean;
  readonly request: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

/** A credential as the platform sees it: identifiers and presence flags, NEVER a secret. */
export interface OnboardingCredentialRecord {
  readonly resourceId: string;
  readonly view: object;
}

export interface OnboardingCredentialPort {
  /**
   * Create or update one credential from the tenant route's own body (the platform `reason` already removed).
   * The adapter validates `body` with the owning module's schema; a bad body is a 422, a stale version a 412.
   */
  upsert(
    tx: DbClient,
    scope: OnboardingWriteScope,
    body: unknown,
    expectedVersion?: number,
  ): Promise<OnboardingCredentialRecord>;
  /** The tenant's credentials, masked, on the adapter's own org-scoped read. */
  list(scope: OnboardingWriteScope): Promise<readonly object[]>;
}
