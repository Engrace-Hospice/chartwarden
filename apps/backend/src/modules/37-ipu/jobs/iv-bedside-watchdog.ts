// apps/backend/src/modules/37-ipu/jobs/iv-bedside-watchdog.ts — the §4.8 `iv-bedside-check-watchdog` cron
// (M37 §2.6 / D7, GAP-107): every 5 minutes, for every active IV safety overlay, is the running infusion's
// bedside check overdue? If so it publishes `m37.iv_safety_overlay.bedside_check_overdue`, which M36 turns into a
// warn alert to the patient's care team (the primary IPU nurse is on it).
//
// ORG-EXPLICIT, BOUNDED, ISOLATED: a cron tick is not a request, so the active-org fan-out runs under the
// audited platform context, each org's reads/writes open their own `withOrgContext`, and M13's infusion
// activity is read through its org-explicit `ivSessionActivityForOrg` (injected as a port — M37 never reads
// M13's tables). Overlays are paged by keyset (`PAGE_SIZE`, at most `MAX_PAGES` per org per tick). One org's
// failure is collected and rethrown at the end so it cannot stop the orgs after it.
//
// IDEMPOTENT / NOT NOISY: the alert fires once per overdue interval (`planBedsideCheckReminder`), keyed in the
// event by `lastCheckAt` + `missedIntervals`; a re-run of the same tick re-publishes at most the same keyed
// alert, which M36's correlation id dedupes. A PAUSED or STOPPED infusion needs no bedside check and is skipped;
// an order with no segment at all (`state: none`) has no infusion to check and is skipped.
import { type DbClient, schema } from "@chartwarden/db";
import { planBedsideCheckReminder } from "@chartwarden/inpatient";
import { withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, asc, eq, gt, notInArray } from "drizzle-orm";
import type { WriteOutboxPort } from "../routes/service-drizzle";
import type { ActiveOrgListPort } from "./cron-workers";

const O = schema.ipuIvSafetyOverlay;
const A = schema.ipuAdmission;

/** Queue name (no ':' — BullMQ forbids it in names/ids). §4.8 spells it `m37:iv-bedside-check-watchdog`. */
export const M37_IV_BEDSIDE_QUEUE = "ipu.iv-bedside-check-watchdog";
/** §4.8 — every 5 minutes. */
export const M37_IV_BEDSIDE_SCHEDULE = "*/5 * * * *";
export const M37_IV_BEDSIDE_PARAMS = { priority: 1, attempts: 3, concurrency: 2 } as const;

const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const MS_PER_MINUTE = 60_000;
const BACKOFF_DELAY_MS = 60_000;

/** The system actor id every M37 cron stamps on its per-org tx (matches `cron-workers.ts`). */
const M37_WORKER_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000037";

const ENDED_ADMISSION_STATES = ["transferred", "discharged", "deceased", "closed"] as const;

/** M13's org-explicit activity read (`ivSessionActivityForOrg`), structurally. */
export type IvActivityPort = (
  organizationId: string,
  medicationOrderIds: readonly string[],
) => Promise<
  readonly {
    readonly medicationOrderId: string;
    readonly state: string;
    readonly lastSegmentAt: string | null;
  }[]
>;

export interface IvBedsideWatchdogDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly activeOrgs: ActiveOrgListPort;
  readonly ivActivity: IvActivityPort;
  now?: () => Date;
}

interface ActiveOverlay {
  readonly overlayId: string;
  readonly orderId: string;
  readonly ipuAdmissionId: string;
  readonly patientId: string;
  readonly intervalMinutes: number;
}

async function loadOverlayPage(
  db: DbClient,
  organizationId: string,
  afterId: string | null,
): Promise<readonly ActiveOverlay[]> {
  return withOrgContext(
    db,
    { organizationId, userId: M37_WORKER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const rows = await tx
        .select({
          overlayId: O.id,
          orderId: O.orderId,
          ipuAdmissionId: O.ipuAdmissionId,
          patientId: A.patientId,
          intervalMinutes: O.bedsideCheckIntervalMinutes,
        })
        .from(O)
        .innerJoin(A, eq(A.id, O.ipuAdmissionId))
        .where(
          and(
            eq(O.organizationId, organizationId),
            eq(O.overlayActive, true),
            notInArray(A.state, [...ENDED_ADMISSION_STATES]),
            ...(afterId ? [gt(O.id, afterId)] : []),
          ),
        )
        .orderBy(asc(O.id))
        .limit(PAGE_SIZE);
      return rows;
    },
  );
}

/** One overdue overlay's alert, published in its own org tx so a bad row cannot roll back its neighbours. */
async function publishOverdue(
  deps: IvBedsideWatchdogDeps,
  organizationId: string,
  overlay: ActiveOverlay,
  fact: {
    readonly lastCheckAt: string;
    readonly minutesOverdue: number;
    readonly missedIntervals: number;
  },
): Promise<void> {
  await withOrgContext(
    deps.db,
    { organizationId, userId: M37_WORKER_SYSTEM_USER_ID },
    async (tx) => {
      await deps.outbox.publish(tx, {
        eventName: "m37.iv_safety_overlay.bedside_check_overdue",
        payload: {
          ipuAdmissionId: overlay.ipuAdmissionId,
          organizationId,
          orderId: overlay.orderId,
          overlayId: overlay.overlayId,
          patientId: overlay.patientId,
          lastCheckAt: fact.lastCheckAt,
          intervalMinutes: overlay.intervalMinutes,
          minutesOverdue: Math.round(fact.minutesOverdue),
          missedIntervals: fact.missedIntervals,
        },
        organizationId,
        aggregateKind: "ipu_iv_safety_overlay",
        aggregateId: overlay.overlayId,
      });
    },
  );
}

async function sweepOrg(
  deps: IvBedsideWatchdogDeps,
  organizationId: string,
  nowMs: number,
): Promise<number> {
  let afterId: string | null = null;
  let raised = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const overlays = await loadOverlayPage(deps.db, organizationId, afterId);
    if (overlays.length === 0) break;
    afterId = overlays[overlays.length - 1]?.overlayId ?? null;

    const activity = await deps.ivActivity(
      organizationId,
      overlays.map((o) => o.orderId),
    );
    const byOrder = new Map(activity.map((a) => [a.medicationOrderId, a]));
    for (const overlay of overlays) {
      const act = byOrder.get(overlay.orderId);
      if (!act || act.state !== "running" || act.lastSegmentAt === null) continue;
      const minutesSince = (nowMs - Date.parse(act.lastSegmentAt)) / MS_PER_MINUTE;
      const plan = planBedsideCheckReminder({
        intervalMinutes: overlay.intervalMinutes,
        minutesSinceLastCheck: minutesSince,
      });
      if (!plan.notify) continue;
      await publishOverdue(deps, organizationId, overlay, {
        lastCheckAt: act.lastSegmentAt,
        minutesOverdue: plan.minutesOverdue,
        missedIntervals: plan.missedIntervals,
      });
      raised++;
    }
    if (overlays.length < PAGE_SIZE) break;
  }
  return raised;
}

/** One tick: sweep every active org; collect (never swallow) per-org failures. */
export async function runIvBedsideCheckWatchdog(deps: IvBedsideWatchdogDeps): Promise<void> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      await sweepOrg(deps, organizationId, nowMs);
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M37_IV_BEDSIDE_WATCHDOG: ${failures.length} of ${orgs.length} org(s) failed — ${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}

/** Construct the cron `Worker` (the caller owns lifecycle — `close()` on shutdown). */
export function registerM37IvBedsideWorker(deps: IvBedsideWatchdogDeps): Worker[] {
  return [
    new Worker(M37_IV_BEDSIDE_QUEUE, async () => runIvBedsideCheckWatchdog(deps), {
      connection: deps.connection,
      concurrency: M37_IV_BEDSIDE_PARAMS.concurrency,
    }),
  ];
}

/** Register the §4.8 repeatable schedule; returns the `Queue` to `close()`. */
export async function scheduleM37IvBedsideWatchdog(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(M37_IV_BEDSIDE_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M37_IV_BEDSIDE_SCHEDULE },
      priority: M37_IV_BEDSIDE_PARAMS.priority,
      attempts: M37_IV_BEDSIDE_PARAMS.attempts,
      backoff: { type: "exponential", delay: BACKOFF_DELAY_MS },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return [queue];
}
