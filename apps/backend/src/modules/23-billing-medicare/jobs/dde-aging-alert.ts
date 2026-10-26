// apps/backend/src/modules/23-billing-medicare/jobs/dde-aging-alert.ts — #767 (ADR-0052 amendment): the daily DDE queue
// aging alert. One M36 alert per org per day (the alert IS the digest) when the queue holds open items that have no
// filing deadline and have aged past the overdue threshold, or open items nobody has been assigned for too long.
// Thresholds are named constants in `@chartwarden/billing` (`dde/aging.ts`). The payload carries counts, the as-of date
// and at most DDE_AGING_ALERT_MAX_IDS item ids per category: no notes, names or identifiers of a patient.
import {
  DDE_AGING_ALERT_MAX_IDS,
  type DdeAgingFacts,
  ddeAgingAlertFindings,
} from "@chartwarden/billing";
import { type ConnectionOptions, Queue, Worker } from "bullmq";

export { DDE_AGING_ALERT_MAX_IDS };

/** Module-prefixed: arch:queue-names keeps every queue name owned by exactly one module. */
export const DDE_AGING_ALERT_QUEUE = "m23.dde-aging-alert";
/** Weekdays at 13:00 UTC (morning in US time zones), so the alert lands as the billing day starts. */
export const DDE_AGING_ALERT_SCHEDULE = "0 13 * * 1-5";
export const DDE_AGING_ALERT_CODE = "m23.dde.queue_aging";

export interface DdeAgingStore {
  /** The org's open items (any type). Opens its own org context: a cron tick is not a request. */
  listOpen(organizationId: string): Promise<readonly DdeAgingFacts[]>;
}

export interface DdeAgingAlertDeps {
  readonly store: DdeAgingStore;
  readonly alerts: {
    dispatch(input: {
      readonly alertCode: string;
      readonly severity: string;
      readonly organizationId: string;
      readonly payload: Record<string, unknown>;
    }): Promise<void>;
  };
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
}

/** One tick: every active org; a failing org does not stop the others; throws after all ran so BullMQ records it. */
export async function runDdeAgingAlert(deps: DdeAgingAlertDeps): Promise<{ alerted: number }> {
  const asOf = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failed: string[] = [];
  const causes: unknown[] = [];
  let alerted = 0;
  for (const { organizationId } of orgs) {
    try {
      const items = await deps.store.listOpen(organizationId);
      const { overdueIds, unassignedIds } = ddeAgingAlertFindings(items, asOf);
      if (overdueIds.length === 0 && unassignedIds.length === 0) continue;
      await deps.alerts.dispatch({
        alertCode: DDE_AGING_ALERT_CODE,
        severity: "warn",
        organizationId,
        payload: {
          asOf,
          overdueCount: overdueIds.length,
          unassignedCount: unassignedIds.length,
          overdueItemIds: overdueIds.slice(0, DDE_AGING_ALERT_MAX_IDS),
          unassignedItemIds: unassignedIds.slice(0, DDE_AGING_ALERT_MAX_IDS),
        },
      });
      alerted += 1;
    } catch (err) {
      failed.push(organizationId);
      causes.push(err);
    }
  }
  if (failed.length > 0) {
    throw new AggregateError(causes, `DDE aging alert failed for org(s): ${failed.join(", ")}`);
  }
  return { alerted };
}

export function registerDdeAgingAlertWorker(
  deps: DdeAgingAlertDeps & { readonly connection: ConnectionOptions },
): Worker {
  return new Worker(DDE_AGING_ALERT_QUEUE, async () => void (await runDdeAgingAlert(deps)), {
    connection: deps.connection,
    concurrency: 1,
  });
}

/** Register the repeatable schedule; the caller owns `close()`. BullMQ dedupes an identical repeat pattern. */
export async function scheduleDdeAgingAlert(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(DDE_AGING_ALERT_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: DDE_AGING_ALERT_SCHEDULE },
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );
  return queue;
}
