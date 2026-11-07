// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-write-types.ts — the shapes of the data service's one
// tenant write (`write()` in onboarding-data-service.ts): what a write is (`WriteSpec`) and what its callback hands back (`WriteResult`).
// Their own file so a write helper (the BAA upload) can name them without importing the service that calls it.
import type { OnboardingAuditEvent } from "./onboarding-data-audit";

/** What a write callback hands back: the response value plus what the audit row names. */
export interface WriteResult<T> {
  readonly value: T;
  readonly resourceId: string;
  readonly changedFields?: readonly string[];
  /** Non-sensitive facts for the audit row (counts, codes, kinds). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface WriteSpec {
  readonly event: OnboardingAuditEvent;
  readonly resourceKind: string;
  readonly reason: string;
  /** True for a write a LIVE tenant needs too (the BAA verification): the shared lock and the audit row stay, the status gate goes. */
  readonly anyTenantStatus?: boolean;
  /**
   * Runs when the write fails (before the error is rethrown), for a callback that made something the transaction cannot roll back (an
   * object in a store). `commitReached` is true when the callback and the audit row finished and the failure came from the COMMIT itself:
   * then the rows may have landed, and a caller must not undo what they point at.
   */
  readonly onFailure?: (info: { readonly commitReached: boolean }) => Promise<void>;
}
