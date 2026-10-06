// apps/backend/src/modules/21-supplies/jobs/cron-workers.ts — the M21 §4.6 crons (GAP-062).
//
// Before this module the three pure deciders the spec's §4.6 workers were meant to run — `runParMonitor`,
// `detectReturnEscalation` and `detectSupplyRequestFindings` — had NO production caller, so `par.below_threshold`
// and the supply-request overdue events never fired, a kit never flipped to `overdue` on day 30 (only the manual
// 90-day route emitted `return_overdue`), and a delivered request never auto-confirmed at 72h.
//
// Shape (the M6 / M23 pattern): active-org fan-out -> `withOrgContext` -> read -> the pure decider -> the same
// transition machine + effects runner the HTTP routes use, publishing through the catalog-validating tx outbox.
// Workers are not requests: every write runs under an explicit `withOrgContext` (org-scoped RLS, system user "").
//
// IDEMPOTENCY BY DESIGN, not bookkeeping (the §7.5 division of labour — "M21 may emit duplicates; M36 dedupes"):
//   - par sweep: re-derives the band from the row each run; one run per Location per local day.
//   - 30d flip: status-gated (a row already `overdue` is never flipped or re-emitted at 30d).
//   - 72h auto-confirm: status-gated (`delivered` -> `received_confirmed` happens once).
//   - the advisory lateness events re-emit each tick while the condition holds (no state moves, by §2.10).
//
// Every row of the return / supply-request sweeps runs in ITS OWN transaction: one row that the machine refuses
// must not roll back the rest of the org's work. Failures are collected and re-thrown as one AggregateError at
// the end of the sweep so the job still fails loudly (retry / DLQ) rather than being swallowed.
import { type DbClient, schema } from "@wardenx/db";
import {
  RETURN_UNRETURNABLE_DAYS_DEFAULT,
  VENDOR_CONFIRMATION_WINDOW_HOURS_DEFAULT,
} from "@wardenx/supplies";
import { withOrgContext } from "@wardenx/tenancy";
import type { IsoInstant } from "@wardenx/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import {
  detectReturnEscalation,
  detectSupplyRequestFindings,
  runParMonitor,
  transitionComfortKitReturn,
  transitionSupplyRequest,
} from "../lifecycle/index";
import { runEffects } from "../routes/effects-runner";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";
import { anchorOf, patchSupplyRequest } from "../routes/write-service-drizzle";
import {
  type ParCronRow,
  activeParRowsForOrg,
  dispatchHasControlledContent,
  monitoredSupplyRequestIds,
  openReturnsRequiredBefore,
} from "./cron-store";
import { M21_JOB_SCHEDULES, M21_QUEUES, PAR_MONITOR_LOCAL_HOUR } from "./queues";

/** "" (not a synthetic uuid): these ticks write audited tables, whose trigger FK-references `app.user_id` into
 *  `user.id` when non-empty. `""` is read as NULL (the F-178b system-write idiom used by the M6 cron). */
const SYSTEM_USER_ID = "";

const MS_PER_DAY = 86_400_000;

/** The 90-day assumption-of-loss event is re-announced on exactly this day (see {@link runReturnSweep}). */
const UNRETURNABLE_ANNOUNCE_DAY = RETURN_UNRETURNABLE_DAYS_DEFAULT;

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M21WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  /** The catalog-validating tx publisher with `callerModule` pinned to `m21`. */
  readonly outbox: WriteOutboxPort;
  readonly activeOrgs?: ActiveOrgListPort;
  /**
   * M1's owner read of a Location's IANA zone (`FoundationSiteReader.locationTimezone`), called on the open
   * org tx once per DISTINCT Location (never per par row). null = unresolved; the sweep falls back to UTC.
   * Unbound -> every Location is evaluated in UTC.
   */
  readonly locationTimezone?: (tx: DbClient, locationId: string) => Promise<string | null>;
  /** Best-effort M36 alert port (an unbound port simply skips alerts; the outbox event is the contract). */
  readonly alerts?: AlertPort;
  now?: () => Date;
}

export function buildM21WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: WriteOutboxPort;
  activeOrgs?: ActiveOrgListPort;
  alerts?: AlertPort;
  locationTimezone?: M21WorkerDeps["locationTimezone"];
}): M21WorkerDeps {
  return { ...deps, now: () => new Date() };
}

function activeOrgsOf(deps: M21WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        Promise.reject(
          new Error(
            "M21_WORKER_PORT_UNBOUND: activeOrgs.listActiveOrgs — bind the M2 active-org enumerator",
          ),
        ),
    }
  );
}

const iso = (d: Date): IsoInstant => d.toISOString();

const asTx = (tx: unknown): DbClient => tx as DbClient;

/** Re-throw the failures a sweep collected, after the rest of its work was done. */
function throwCollected(label: string, failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  throw new AggregateError(failures, `${label}: ${failures.length} row(s) failed`);
}

// ── par-monitor (§2.7 / D5) ──────────────────────────────────────────────────────────────────────────

/** Local wall-clock hour (0-23) of `at` in an IANA zone. An unusable zone falls back to UTC so a bad
 *  Location row cannot silence the sweep for every other Location. */
export function localHourIn(at: Date, timeZone: string): number {
  const read = (zone: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone })
        .formatToParts(at)
        .find((p) => p.type === "hour")?.value,
    );
  try {
    return read(timeZone);
  } catch {
    return read("UTC");
  }
}

const parPayloadOf = (organizationId: string, row: ParCronRow, observedAt: IsoInstant) => ({
  orgId: organizationId,
  providerEntityId: row.providerEntityId,
  locationId: row.locationId,
  parStockId: row.parStockId,
  supplyItemId: row.supplyItemId,
  tenantSupplyItemExtensionId: row.tenantSupplyItemExtensionId,
  supplyItemName: row.supplyItemName,
  currentQuantity: row.currentQuantity,
  reorderPoint: row.reorderPoint,
  minSafetyStock: row.minSafetyStock,
  unit: row.unit,
  observedAt,
});

/**
 * §4.6 `m21.par_monitor` — for each org, every active par row at a Location whose local hour is 04:00 is
 * evaluated; a row at/below its reorder point emits `m21.par.below_threshold` (and, at/below the safety floor,
 * also `m21.par.stockout_imminent`). Runs hourly so each Location is caught at ITS local 04:00.
 */
export async function runParMonitorCron(deps: M21WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
      const t = asTx(tx);
      const allRows = await activeParRowsForOrg(t);
      // A Location whose zone cannot be resolved is skipped, never evaluated in UTC: a wrong zone would
      // fire the 04:00 gate at the wrong local hour. With no port bound (unit tests) every Location is UTC.
      const zoneOf = new Map<string, string | null>();
      for (const locationId of new Set(allRows.map((r) => r.locationId))) {
        zoneOf.set(
          locationId,
          deps.locationTimezone ? await deps.locationTimezone(t, locationId) : "UTC",
        );
      }
      const rows = allRows.filter((r) => {
        const zone = zoneOf.get(r.locationId);
        return zone != null && localHourIn(now, zone) === PAR_MONITOR_LOCAL_HOUR;
      });
      const byId = new Map(rows.map((r) => [r.parStockId, r]));
      for (const finding of runParMonitor(rows, now)) {
        const row = byId.get(finding.parStockId);
        if (!row) continue;
        for (const eventName of finding.events) {
          await deps.outbox.publish(t, {
            eventName,
            payload: parPayloadOf(organizationId, row, finding.observedAt),
            organizationId,
            aggregateKind: "par_stock",
            aggregateId: row.parStockId,
          });
        }
      }
    });
  }
}

// ── unreturned-kit-monitor (§2.6 / §7.6) ─────────────────────────────────────────────────────────────

/**
 * Evaluate one open return inside ITS transaction. Returns whether anything was emitted/changed.
 *
 * - day >= 30 and not yet `overdue`: the state flips to `overdue` through the SAME machine edge the manual
 *   path uses, emitting `m21.comfort_kit.return_overdue` (+ the M36 `unreturned` alert).
 * - already `overdue`: nothing at the 30-day boundary; on day 90 the `unreturnable_90d` escalation is
 *   re-announced ONCE (the daily tick lands on `daysOverdue === 90` exactly once). The row is NOT moved to
 *   `unreturnable` — that disposition needs a clinical supervisor's attested reason (§2.6) and stays manual.
 */
async function processOpenReturn(
  deps: M21WorkerDeps,
  organizationId: string,
  returnId: string,
  at: Date,
): Promise<void> {
  const RETURN = schema.comfortKitReturn;
  await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const t = asTx(tx);
    const [row] = await t.select().from(RETURN).where(eq(RETURN.id, returnId)).limit(1);
    if (!row) return;
    const finding = detectReturnEscalation(
      { state: row.state, returnRequiredAt: iso(row.returnRequiredAt) },
      at,
    );
    if (finding.kind === "none") return;

    const alreadyOverdue = row.state === "overdue";
    if (alreadyOverdue && finding.daysOverdue !== UNRETURNABLE_ANNOUNCE_DAY) return;
    if (alreadyOverdue && finding.kind !== "unreturnable_90d") return;

    const containsControlledSubstance = await dispatchHasControlledContent(t, row.dispatchId);
    const eventPayload = {
      ...anchorOf(row),
      returnId: row.id,
      dispatchId: row.dispatchId,
      returnRequiredAt: iso(row.returnRequiredAt),
      daysOverdue: finding.daysOverdue,
      escalation: finding.kind,
      containsControlledSubstance,
      detectedAt: iso(at),
    };

    if (alreadyOverdue) {
      await deps.outbox.publish(t, {
        eventName: "m21.comfort_kit.return_overdue",
        payload: eventPayload,
        organizationId,
        aggregateKind: "comfort_kit_return",
        aggregateId: row.id,
      });
      return;
    }

    const transition = transitionComfortKitReturn(row.state, {
      type: "markOverdue",
      at: iso(at),
      returnRequiredAt: iso(row.returnRequiredAt),
      containsControlledSubstance,
    });
    await runEffects(t, transition.effects, {
      organizationId,
      at,
      outbox: deps.outbox,
      alerts: deps.alerts,
      aggregateKind: "comfort_kit_return",
      aggregateId: row.id,
      payloads: { "m21.comfort_kit.return_overdue": eventPayload },
      alertPayloads: {
        "m21.comfort_kit.unreturned": {
          alertKind: "m21.comfort_kit.unreturned",
          returnId: row.id,
          dispatchId: row.dispatchId,
          orgId: organizationId,
          patientId: row.patientId,
          daysSinceReturnRequired: finding.daysOverdue,
          containsControlledSubstance,
          severity: finding.severity,
        },
      },
    });
    await t
      .update(RETURN)
      .set({ state: transition.to as typeof RETURN.$inferInsert.state, updatedAt: at })
      .where(eq(RETURN.id, row.id));
  });
}

/**
 * §4.6 `m21.unreturned_kit_monitor` — the automatic 30-day `overdue` flip (spec §2.6: "the daily
 * kit-return-overdue cron flips `state='overdue'`").
 */
export async function runUnreturnedKitMonitorCron(deps: M21WorkerDeps): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(at.getTime() - 30 * MS_PER_DAY);
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const failures: unknown[] = [];

  for (const { organizationId } of orgs) {
    const open = await withOrgContext(
      deps.db,
      { organizationId, userId: SYSTEM_USER_ID },
      async (tx) => openReturnsRequiredBefore(asTx(tx), cutoff),
    );
    for (const { returnId } of open) {
      try {
        await processOpenReturn(deps, organizationId, returnId, at);
      } catch (err) {
        failures.push(err);
      }
    }
  }
  throwCollected("m21.unreturned_kit_monitor", failures);
}

// ── supply-request monitor (§2.10: lateness advisories + 72h auto-confirm) ───────────────────────────

const deliveryWindowLatestOf = (data: unknown): IsoInstant | null => {
  const value = (data as { deliveryWindowLatest?: unknown } | null)?.deliveryWindowLatest;
  return typeof value === "string" && value.length > 0 ? value : null;
};

async function processMonitoredRequest(
  deps: M21WorkerDeps,
  organizationId: string,
  supplyRequestId: string,
  at: Date,
): Promise<void> {
  const REQUEST = schema.supplyRequest;
  await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const t = asTx(tx);
    const [row] = await t.select().from(REQUEST).where(eq(REQUEST.id, supplyRequestId)).limit(1);
    if (!row) return;
    const findings = detectSupplyRequestFindings(
      {
        status: row.status,
        orderedAt: row.orderedAt ? iso(row.orderedAt) : null,
        deliveredAt: row.deliveredAt ? iso(row.deliveredAt) : null,
        deliveryWindowLatest: deliveryWindowLatestOf(row.data),
      },
      at,
    );
    const anchor = anchorOf(row);

    for (const finding of findings) {
      if (finding.kind === "vendor_confirmation_overdue" && row.orderedAt) {
        await deps.outbox.publish(t, {
          eventName: "m21.supply_request.vendor_confirmation_overdue",
          payload: {
            ...anchor,
            supplyRequestId: row.id,
            orderedAt: iso(row.orderedAt),
            windowHours: VENDOR_CONFIRMATION_WINDOW_HOURS_DEFAULT,
            detectedAt: iso(at),
          },
          organizationId,
          aggregateKind: "supply_request",
          aggregateId: row.id,
        });
      } else if (finding.kind === "delivery_overdue") {
        await deps.outbox.publish(t, {
          eventName: "m21.supply_request.delivery_overdue",
          payload: {
            ...anchor,
            supplyRequestId: row.id,
            deliveryWindowLatest: deliveryWindowLatestOf(row.data) ?? "",
            detectedAt: iso(at),
          },
          organizationId,
          aggregateKind: "supply_request",
          aggregateId: row.id,
        });
      } else if (finding.kind === "received_confirm_auto_due" && row.deliveredAt) {
        // The one finding that MOVES the row: a real `caregiverOrPatientConfirmsReceipt` edge with the
        // `system_auto_confirm` actor (which the machine only accepts once the 72h grace has elapsed).
        const transition = transitionSupplyRequest(row.status, row.kind, {
          type: "caregiverOrPatientConfirmsReceipt",
          actor: "system_auto_confirm",
          at: iso(at),
          deliveredAt: iso(row.deliveredAt),
        });
        const patch = await runEffects(t, transition.effects, {
          organizationId,
          at,
          outbox: deps.outbox,
          alerts: deps.alerts,
          aggregateKind: "supply_request",
          aggregateId: row.id,
          payloads: {
            "m21.supply_request.status_changed": {
              ...anchor,
              supplyRequestId: row.id,
              kind: row.kind,
              sourceOrderId: row.sourceOrderId ?? null,
              fromStatus: transition.from,
              toStatus: transition.to,
              occurredAt: iso(at),
            },
          },
        });
        await patchSupplyRequest(t as never, row.id, transition.to, patch, at);
      }
    }
  });
}

/** §4.6 / §2.10 — the supply-request sweep: advisory lateness events and the 72h receipt auto-confirm. */
export async function runSupplyRequestMonitorCron(deps: M21WorkerDeps): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const failures: unknown[] = [];

  for (const { organizationId } of orgs) {
    const ids = await withOrgContext(
      deps.db,
      { organizationId, userId: SYSTEM_USER_ID },
      async (tx) => monitoredSupplyRequestIds(asTx(tx)),
    );
    for (const id of ids) {
      try {
        await processMonitoredRequest(deps, organizationId, id, at);
      } catch (err) {
        failures.push(err);
      }
    }
  }
  throwCollected("m21.supply_request_monitor", failures);
}

// ── registration ─────────────────────────────────────────────────────────────────────────────────────

/** Construct the three live M21 cron workers. */
export function registerM21CronWorkers(deps: M21WorkerDeps): Worker[] {
  const opts = { connection: deps.connection, concurrency: 1 } as const;
  return [
    new Worker(M21_QUEUES.parMonitor, async () => runParMonitorCron(deps), opts),
    new Worker(
      M21_QUEUES.unreturnedKitMonitor,
      async () => runUnreturnedKitMonitorCron(deps),
      opts,
    ),
    new Worker(
      M21_QUEUES.supplyRequestMonitor,
      async () => runSupplyRequestMonitorCron(deps),
      opts,
    ),
  ];
}

/** Register the repeatable schedules (3 retries, exponential backoff — the §4.6 retry policy). */
export async function scheduleM21Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules = [
    { name: M21_QUEUES.parMonitor, pattern: M21_JOB_SCHEDULES.parMonitor },
    { name: M21_QUEUES.unreturnedKitMonitor, pattern: M21_JOB_SCHEDULES.unreturnedKitMonitor },
    { name: M21_QUEUES.supplyRequestMonitor, pattern: M21_JOB_SCHEDULES.supplyRequestMonitor },
  ] as const;

  const queues: Queue[] = [];
  for (const schedule of schedules) {
    const queue = new Queue(schedule.name, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: schedule.pattern },
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    queues.push(queue);
  }
  return queues;
}
