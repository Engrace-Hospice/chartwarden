// apps/backend/src/modules/12-dosespot/jobs/cron-common.ts — shared plumbing for the §4.8 M12 crons (GAP-037).
// Every cron is ORG-EXPLICIT: a tick fans out over the active orgs and runs one pass per org, each opening its
// own `withOrgContext` (a cron tick is not a request). The vendor call is NEVER made inside a transaction.
import type { DbClient } from "@chartwarden/db";
import {
  type DegradedError,
  type DoseSpotClient,
  type DoseSpotTenantConfigResolver,
  isDegradedError,
} from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";

/** A worker-driven write names no acting membership (the M12 sync worker's convention). */
export const CRON_USER_ID = "";

/**
 * Remembers which faults are already reported, so one is alerted ONCE per episode (and its clearing once) instead of on every tick.
 * `raise` is true on the first report of an episode (a report of an open one only keeps it open); `clear` is true when an episode was
 * open and has now ended. Either rejects when the memory cannot be reached: the caller must not read that as "no episode".
 * Production uses the Valkey-backed tracker (`episode-store.ts`), shared by every process, so a restart or a second replica neither
 * alerts again nor loses a recovery. The in-memory one below is for a single process (tests, a boot with no Valkey).
 */
export interface EpisodeTracker {
  raise(key: string): Promise<boolean>;
  clear(key: string): Promise<boolean>;
}

export function createEpisodeTracker(): EpisodeTracker {
  const open = new Set<string>();
  return {
    async raise(key) {
      if (open.has(key)) return false;
      open.add(key);
      return true;
    },
    async clear(key) {
      return open.delete(key);
    },
  };
}

export interface M12CronDeps {
  readonly db: DbClient;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly client: DoseSpotClient;
  readonly now?: () => Date;
  /**
   * The same resolver the client reads. The transmit pass resolves the org's config ONCE before it claims anything, so a credential or
   * resolver fault skips the pass (no claim, no UPDATE, no audit row) instead of being rediscovered, and audited, order by order.
   */
  readonly config?: Pick<DoseSpotTenantConfigResolver, "configFor">;
  /** Episode memory for the degradation alerts. Absent = faults are logged on every tick but never alerted. */
  readonly episodes?: EpisodeTracker;
  /** A structured warning (pino's `(fields, message)` shape). Never given a secret, a key or a name: org ids and error classes. */
  readonly warn?: (fields: Record<string, string | number>, message: string) => void;
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
