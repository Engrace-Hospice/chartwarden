// apps/backend/src/bootstrap/onboarding-dosespot-port.ts — the seam through which the platform onboarding routes (M34
// `/api/v1/platform/tenants/:orgSlug/dosespot`) register a tenant's DoseSpot clinic without importing M12 (M34 has no `dependsOn`
// edge to the DoseSpot module). The sibling of `onboarding-clearinghouse-port.ts`, for the same reasons.
//
// M12 implements the port over ITS OWN service, so the rules (draft -> registered -> verified -> active, the sealed credential,
// the production gate, the Subscription-Key rule) are the ones the tenant's own admin screen runs. Every write takes the CALLER'S
// open transaction (already scoped to the target org's `app.org_id` and attributed to the operator), so it commits or rolls back
// with the tenant-status check and the audit row. Nothing it returns carries a credential.
//
// `verify` and a prescriber's `enroll` are split in three because the vendor call is a network call that must never run inside a
// transaction: `prepare*` reads on its own short transaction, the vendor step runs with nothing open, and `complete*` takes the
// caller's write transaction (verify compare-and-sets on the version its plan was read at: 409 when the config moved meanwhile).
import type { DbClient } from "@chartwarden/db";
import type { OnboardingWriteScope } from "./onboarding-credential-port";

export type { OnboardingWriteScope } from "./onboarding-credential-port";

/** What a write hands back: the response view plus what the platform audit row names (field NAMES and codes, never a value). */
export interface OnboardingDoseSpotResult {
  /** The registration's (or, for an enrolment, the roster row's) id. */
  readonly resourceId: string;
  readonly view: object;
  /** True when the call created the row (the route answers 201). */
  readonly created?: boolean;
  /** `put`: the body fields the operator sent that actually changed (names only). */
  readonly changedFields?: readonly string[];
  /** Non-sensitive facts for the audit row (the test outcome, the resulting status). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
  /** `verify`: the connection-test outcome. */
  readonly test?: object | null;
  /**
   * What must run AFTER the operator's transaction commits, best effort (the lost-service alert). The caller invokes it once and
   * logs a failure; it never fails the write.
   */
  readonly afterCommit?: () => Promise<void>;
}

/** What `prepare*` read. Opaque to the platform: it only carries it from step 1 to step 3. */
export type OnboardingPlan = object;

export interface OnboardingDoseSpotPort {
  /** The tenant's DoseSpot registration, masked, on the adapter's own org-scoped read. */
  get(scope: OnboardingWriteScope): Promise<object>;
  /** Save the registration (the tenant route's own body, the platform `reason` already removed). */
  put(
    tx: DbClient,
    scope: OnboardingWriteScope,
    body: unknown,
    expectedVersion?: number,
  ): Promise<OnboardingDoseSpotResult>;
  /** Verify, step 1: read-only (its own org-scoped read, no lock): unseals the candidate credential for the probe. */
  prepareVerify(scope: OnboardingWriteScope): Promise<OnboardingPlan>;
  /** Verify, step 2: the token mint, with NO transaction open. */
  runProbe(plan: OnboardingPlan): Promise<unknown>;
  /** Verify, step 3: on the caller's write transaction, compare-and-set on the plan's version and record the result. */
  completeVerify(
    tx: DbClient,
    scope: OnboardingWriteScope,
    plan: OnboardingPlan,
    outcome: unknown,
  ): Promise<OnboardingDoseSpotResult>;
  activate(tx: DbClient, scope: OnboardingWriteScope): Promise<OnboardingDoseSpotResult>;
  deactivate(tx: DbClient, scope: OnboardingWriteScope): Promise<OnboardingDoseSpotResult>;
  /** The tenant's roster prescribers and whether each is linked to DoseSpot (no NPI, no DEA), on the adapter's own read. */
  listPrescribers(scope: OnboardingWriteScope): Promise<readonly object[]>;
  /** Enrol, step 1: validate, check the registration is ready, ensure the roster row, commit the request marker. */
  prepareEnroll(
    scope: OnboardingWriteScope,
    membershipId: string,
    body: unknown,
  ): Promise<OnboardingPlan>;
  /** Enrol, step 2: the vendor call with NO transaction open; the vendor's id, or null when already linked. */
  callVendor(plan: OnboardingPlan): Promise<string | null>;
  /** Enrol, step 3: on the caller's write transaction, record the vendor id, publish, audit. */
  completeEnroll(
    tx: DbClient,
    scope: OnboardingWriteScope,
    plan: OnboardingPlan,
    vendorId: string | null,
  ): Promise<OnboardingDoseSpotResult>;
}
