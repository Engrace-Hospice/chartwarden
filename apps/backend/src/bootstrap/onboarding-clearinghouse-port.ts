// apps/backend/src/bootstrap/onboarding-clearinghouse-port.ts — the seam through which the platform onboarding routes (M34
// `/api/v1/platform/tenants/:orgSlug/clearinghouse`) set a tenant's clearinghouse without importing M23 (M34 has no
// `dependsOn` edge to the billing modules). The sibling of `onboarding-credential-port.ts`, for the same reasons.
//
// M23 implements the port over ITS OWN service, so the rules (draft -> verified -> active, the sealed credential, the lock
// once a production submission exists) are the ones the tenant's own admin screen runs. Every write takes the CALLER'S open
// transaction (already scoped to the target org's `app.org_id` and attributed to the operator), so it commits or rolls back
// with the tenant-status check and the audit row. Nothing it returns carries the credential.
import type { DbClient } from "@chartwarden/db";
import type { OnboardingWriteScope } from "./onboarding-credential-port";

export type { OnboardingWriteScope } from "./onboarding-credential-port";

/** What a write hands back: the response view plus what the platform audit row names (field NAMES and codes, never a value). */
export interface OnboardingClearinghouseResult {
  /** The config row's id (one row per organization). */
  readonly resourceId: string;
  readonly view: object;
  /** True when the call created the row (the route answers 201). */
  readonly created?: boolean;
  /** `put`: the body fields the operator sent (names only). */
  readonly changedFields?: readonly string[];
  /** Non-sensitive facts for the audit row (`verify`: how it was verified and the test outcome). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
  /** `verify`: the connection-test outcome when a test ran. */
  readonly test?: object | null;
}

export interface OnboardingClearinghousePort {
  /** The tenant's clearinghouse config, masked, on the adapter's own org-scoped read. */
  get(scope: OnboardingWriteScope): Promise<object>;
  /** Choose the vendor, its mode and credential (the tenant route's own body, the platform `reason` already removed). */
  put(
    tx: DbClient,
    scope: OnboardingWriteScope,
    body: unknown,
    expectedVersion?: number,
  ): Promise<OnboardingClearinghouseResult>;
  /** Connection test where the vendor has a safe probe, an attestation with evidence where it has none. */
  verify(
    tx: DbClient,
    scope: OnboardingWriteScope,
    body: unknown,
  ): Promise<OnboardingClearinghouseResult>;
  activate(tx: DbClient, scope: OnboardingWriteScope): Promise<OnboardingClearinghouseResult>;
}
