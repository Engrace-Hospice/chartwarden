// apps/backend/src/modules/12-dosespot/jobs/cron-common.ts — shared plumbing for the §4.8 M12 crons (GAP-037).
// Every cron is ORG-EXPLICIT: a tick fans out over the active orgs and runs one pass per org, each opening its
// own `withOrgContext` (a cron tick is not a request). The vendor call is NEVER made inside a transaction.
import type { DbClient } from "@wardenx/db";
import { type DegradedError, type DoseSpotClient, isDegradedError } from "@wardenx/dosespot";
import { withOrgContext } from "@wardenx/tenancy";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";

/** A worker-driven write names no acting membership (the M12 sync worker's convention). */
export const CRON_USER_ID = "";

export interface M12CronDeps {
  readonly db: DbClient;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly client: DoseSpotClient;
  readonly now?: () => Date;
}

export const nowOf = (deps: Pick<M12CronDeps, "now">): Date => (deps.now ?? (() => new Date()))();

export function inOrg<T>(
  db: DbClient,
  organizationId: string,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> {
  return withOrgContext(db, { organizationId, userId: CRON_USER_ID }, (tx) => fn(tx as DbClient));
}

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** Run `perOrg` for every active org; collect failures and rethrow them together AFTER the last org. */
export async function runForEachActiveOrg(
  label: string,
  activeOrgs: ActiveOrgListPort,
  perOrg: (organizationId: string) => Promise<unknown>,
): Promise<void> {
  const orgs = await activeOrgs.listActiveOrgs();
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      await perOrg(organizationId);
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `${label}: ${failures.length} of ${orgs.length} org(s) failed — ${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}

/** The PHI-free failure class recorded on a transmission row / failed sweep. */
export function errorClassOf(error: unknown): string {
  if (isDegradedError(error))
    return error.retryable ? "degraded_retryable" : "degraded_non_retryable";
  return error instanceof Error ? error.name : "unknown";
}

/** `true` for the breaker's fail-fast error — it is NOT an attempt and must not burn the retry budget. */
export function isCircuitOpenError(error: unknown): error is DegradedError {
  return (
    isDegradedError(error) && error.retryable && error.customerMessage.includes("circuit open")
  );
}
