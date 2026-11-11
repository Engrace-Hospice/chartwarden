// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/revoked-responses-alert.ts — what the response PULLS do for an
// organization whose vendor BAA a platform operator revoked (ADR-0053 amendment, "build it").
//
// A revoked config is not active, so the resolver binds nothing for it and BOTH pulls (M23's 999 / 277CA acknowledgment crons and
// M25's 835 remittance pull) skip it. That is intended: no PHI is pulled under a BAA that has ended. But a Medicare claim sent in the
// last response window stays "submitted" with nothing to say its acknowledgment or remittance is waiting at the vendor. So each pull,
// when it skips a revoked organization, asks this reporter, which raises ONE alert per organization per UTC day (the emitter's correlation
// id is per code and day) while any production attempt is still in flight or was sent within the response window.
// "Outstanding" is that attempt count, the same set the vendor lock and the credential release use (a proxy: M23 records no per-claim
// adjudication state to ask instead). Ids and counts only. Never throws: a broken alert router must not stop a pull for other tenants.
// ponytail: the once-per-day memory is per process; the emitter's own per-day correlation id absorbs a repeat from another process.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { createDrizzleConfigStore } from "./config-store";
import { responseWindowStart } from "./credential-reservation";

export const REVOKED_RESPONSES_PENDING_ALERT = "m23.clearinghouse.revoked_responses_pending";

export interface RevokedResponsesAlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface RevokedResponsesDeps {
  readonly db: DbClient;
  readonly alerts?: RevokedResponsesAlertPort | undefined;
  readonly log?: ((event: { readonly event: string; readonly code?: string }) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Organization -> the UTC day it was last looked at: a pull ticks every few minutes and must not query or alert each time. */
const lookedAtOn = new Map<string, string>();

/** Test seam: forget which organizations were already reported today. */
export const __resetRevokedResponsesMemoryForTest = (): void => lookedAtOn.clear();

/**
 * Called by a pull for an organization it skipped because its BAA is revoked. Raises the once-a-day alert when responses may still be
 * owed (production attempts in flight, or sent within the response window); says nothing when none are.
 */
export async function reportRevokedResponsesPending(
  deps: RevokedResponsesDeps,
  input: { readonly organizationId: string },
): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  const day = at.toISOString().slice(0, 10);
  const { organizationId } = input;
  if (lookedAtOn.get(organizationId) === day) return;
  try {
    const counts = await withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
      createDrizzleConfigStore(tx as unknown as DbClient).countRecentProductionAttempts(
        organizationId,
        responseWindowStart(at),
      ),
    );
    if (counts.inFlight + counts.sent > 0) {
      deps.log?.({ event: "clearinghouse.revoked_responses_pending" });
      await deps.alerts?.dispatch({
        alertCode: REVOKED_RESPONSES_PENDING_ALERT,
        severity: "warn",
        organizationId,
        payload: { attemptsInFlight: counts.inFlight, attemptsSentInWindow: counts.sent },
      });
    }
    // looked at (and reported, when there was anything): not again today. A failure above leaves it unmarked, so the next tick retries.
    lookedAtOn.set(organizationId, day);
  } catch {
    deps.log?.({ event: "clearinghouse.revoked_responses_alert_failed", code: "ALERT_FAILED" });
  }
}
