// apps/backend/src/modules/41-billing-commercial/services/submission-guards.ts - the one rule that keeps a claim and its submission from
// drifting apart: a claim with a live submission (queued, in doubt, or sent and not yet settled) is not ours to demote to draft,
// re-validate, re-ready or void. Without it a filed claim could be orphaned as a draft while the payer holds it.
import { schema } from "@chartwarden/db";
import { COMMERCIAL_ERROR_CODES, ChartWardenError } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import type { CommercialTx } from "./types";

export const SUBMISSION_IN_FLIGHT_MESSAGE =
  "This claim has a submission that is waiting, in doubt or already sent. Wait for its outcome, or settle it, before changing the claim.";

type LiveStatus = "queued" | "in_doubt" | "sent";
const ALL_LIVE: readonly LiveStatus[] = ["queued", "in_doubt", "sent"];

/** True when the claim has a submission in one of `statuses` (default: every live one). Call it on a transaction that holds the claim lock. */
export async function hasLiveSubmission(
  tx: CommercialTx,
  claimId: string,
  statuses: readonly LiveStatus[] = ALL_LIVE,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.commercialSubmissions.id })
    .from(schema.commercialSubmissions)
    .where(
      and(
        eq(schema.commercialSubmissions.claimId, claimId),
        inArray(schema.commercialSubmissions.status, [...statuses]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Refuse with the typed 409 `COMMERCIAL_SUBMISSION_IN_FLIGHT` when the claim has a live submission. */
export async function assertNoLiveSubmission(
  tx: CommercialTx,
  claimId: string,
  statuses: readonly LiveStatus[] = ALL_LIVE,
): Promise<void> {
  if (await hasLiveSubmission(tx, claimId, statuses)) {
    throw new ChartWardenError(
      COMMERCIAL_ERROR_CODES.submissionInFlight,
      SUBMISSION_IN_FLIGHT_MESSAGE,
      409,
    );
  }
}
