// apps/backend/src/modules/23-billing-medicare/routes/onboarding-data-change.ts — the port through which a tenant-lane billing
// write tells the composition root that onboarding data changed, in the SAME transaction as the write.
//
// The tenant's clearinghouse choice (put, BAA record, verify, activate) and its MAC credential are the data of onboarding steps 7
// and 8. A go-live attestation says that data was ready as of one moment, so a write after it must not leave the attestation
// approvable: the composition root binds this hook to M34's `voidPendingGoLiveForDataChange` (M23 does not import M34). The
// operator's lane does the same on its own transaction (`onboarding-data-service.ts`); this is the tenant lane's half.
import type { DbClient } from "@chartwarden/db";

/** Who changed the data and where. Server-assembled from the session, never from a body. */
export interface OnboardingDataChange {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
}

/** Runs on the write's own transaction, after the write: a throw rolls the write back with it. */
export type OnboardingDataChangedHook = (
  tx: DbClient,
  change: OnboardingDataChange,
) => Promise<void>;
