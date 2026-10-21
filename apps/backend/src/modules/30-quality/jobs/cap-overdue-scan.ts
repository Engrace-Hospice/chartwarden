// apps/backend/src/modules/30-quality/jobs/cap-overdue-scan.ts — GAP-155.
//
// The producer of `m30.incident.cap_overdue` (§4.9 / events-by-m30.ts) and its daily cron
// `m30.cap_overdue_scan`. CAP action items live in the reserved `incident_report.kind_data._m30.capPlan`
// sidecar (no dedicated table), so the scan reads that jsonb per active org (RLS-scoped, org-explicit),
// picks incomplete actions past their `dueAt`, then (a) publishes the catalog event through the real
// catalog-validating publisher and (b) raises the M36 `cap_overdue` alert directly (no M36 consumer binds the
// event, so there is no double-fire). The alert cadence is "every 2d until completed": the correlation id
// carries a 2-day bucket, so a re-run inside the bucket dedupes and a new bucket re-pages.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";

export const M30_CAP_OVERDUE_QUEUE = "m30.cap_overdue_scan";
/** 08:00 UTC daily — clear of the 03:15 recompute, 04:00 risk-register, 05:00 mortality and 09:00 SRA crons. */
export const M30_CAP_OVERDUE_SCHEDULE = "0 8 * * *";
const MS_PER_DAY = 86_400_000;
const REPEAT_BUCKET_DAYS = 2;
const SYSTEM_USER_ID = "";

export interface CapAction {
  readonly action: string;
  readonly ownerMembershipId: string;
  readonly dueAt: string;
  readonly completedAt: string | null;
}

export interface CapIncidentRow {
  readonly incidentId: string;
  readonly capPlan: { readonly actions: readonly CapAction[] };
}

export interface OverdueCapAction {
  readonly incidentId: string;
  readonly actionIndex: number;
  readonly dueAt: string;
  readonly ownerMembershipId: string;
}

/** PURE — the incomplete CAP actions whose (parseable) `dueAt` is at or before `now`. */
export function collectOverdueCapActions(
  incidents: readonly CapIncidentRow[],
  now: Date,
): readonly OverdueCapAction[] {
  const out: OverdueCapAction[] = [];
  for (const incident of incidents) {
    incident.capPlan.actions.forEach((a, actionIndex) => {
      if (a.completedAt !== null) return;
      const due = Date.parse(a.dueAt);
      if (Number.isNaN(due) || due > now.getTime()) return;
      out.push({
        incidentId: incident.incidentId,
        actionIndex,
        dueAt: a.dueAt,
        ownerMembershipId: a.ownerMembershipId,
      });
    });
  }
  return out;
}

export interface ResolvedOverdueCapAction {
  readonly incidentId: string;
  readonly actionIndex: number;
  readonly dueAt: string;
  readonly ownerUserId: string;
}

export interface CapOverdueRunDeps {
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly scanOrg: (organizationId: string) => Promise<readonly ResolvedOverdueCapAction[]>;
  readonly publish: (organizationId: string, payload: Record<string, unknown>) => Promise<void>;
  readonly emit: (
    organizationId: string,
    input: {
      eventType: string;
      severity: "warn";
      correlationId: string;
      payload: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  readonly now: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface CapOverdueRunSummary {
  readonly orgs: number;
  readonly raised: number;
  readonly failedOrgs: number;
}

/** One pass over every active org; a failing org is counted and never stops the rest. */
export async function runCapOverdueScan(deps: CapOverdueRunDeps): Promise<CapOverdueRunSummary> {
  const now = deps.now();
  const bucket = Math.floor(now.getTime() / (MS_PER_DAY * REPEAT_BUCKET_DAYS));
  const orgs = await deps.listActiveOrgs();
  let raised = 0;
  let failedOrgs = 0;
  for (const { organizationId } of orgs) {
    try {
      for (const item of await deps.scanOrg(organizationId)) {
        const payload = { orgId: organizationId, ...item };
        await deps.publish(organizationId, payload);
        await deps.emit(organizationId, {
          eventType: "m30.incident.cap_overdue",
          severity: "warn",
          correlationId: `m30:cap_overdue:${item.incidentId}:${item.actionIndex}:${bucket}`,
          payload,
        });
        raised += 1;
      }
    } catch (error) {
      failedOrgs += 1;
      deps.warn?.("m30.cap_overdue_scan: org scan failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { orgs: orgs.length, raised, failedOrgs };
}

type Rows<T> = { rows?: T[] };

/** membership id -> user id (injected from `bootstrap/org-spine-facts.ts`; M30 may not read `membership`). */
export type OwnerUserResolver = (
  organizationId: string,
  membershipIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/** One org's open incidents carrying a CAP plan, with action owners resolved membership → user id. */
export async function scanOrgForOverdueCapActions(
  db: DbClient,
  organizationId: string,
  now: Date,
  resolveOwnerUserIds: OwnerUserResolver,
): Promise<readonly ResolvedOverdueCapAction[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id AS "incidentId", kind_data->'_m30'->'capPlan' AS "capPlan"
        FROM incident_report
       WHERE organization_id = ${organizationId}::uuid
         AND lifecycle <> 'closed_followup_complete'::m30_incident_lifecycle
         AND kind_data->'_m30'->'capPlan' IS NOT NULL`);
    const rows = (res as unknown as Rows<CapIncidentRow>).rows ?? [];
    const overdue = collectOverdueCapActions(
      rows.filter((r) => Array.isArray(r.capPlan?.actions)),
      now,
    );
    if (overdue.length === 0) return [];
    const userByMembership = await resolveOwnerUserIds(organizationId, [
      ...new Set(overdue.map((o) => o.ownerMembershipId)),
    ]);
    // An owner whose membership no longer resolves cannot be addressed (the event requires a user id): skip
    // rather than fabricate one; the next tick retries once the plan is reassigned.
    return overdue.flatMap((o) => {
      const ownerUserId = userByMembership.get(o.ownerMembershipId);
      return ownerUserId
        ? [
            {
              incidentId: o.incidentId,
              actionIndex: o.actionIndex,
              dueAt: o.dueAt,
              ownerUserId,
            },
          ]
        : [];
    });
  });
}

export interface CapOverdueWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly listActiveOrgs: CapOverdueRunDeps["listActiveOrgs"];
  readonly outboxPublisher: {
    publish(
      tx: DbClient,
      input: {
        readonly eventName: string;
        readonly payload: Record<string, unknown>;
        readonly organizationId: string;
        readonly aggregateKind: string;
        readonly aggregateId: string;
      },
    ): Promise<void>;
  };
  readonly emit: CapOverdueRunDeps["emit"];
  readonly resolveOwnerUserIds: OwnerUserResolver;
  readonly now?: () => Date;
  readonly warn?: CapOverdueRunDeps["warn"];
}

/** Construct the `m30.cap_overdue_scan` Worker over the real publisher + the M36 emitter. */
export function registerM30CapOverdueWorker(deps: CapOverdueWorkerDeps): Worker {
  const now = deps.now ?? (() => new Date());
  return new Worker(
    M30_CAP_OVERDUE_QUEUE,
    async () =>
      runCapOverdueScan({
        listActiveOrgs: deps.listActiveOrgs,
        scanOrg: (organizationId) =>
          scanOrgForOverdueCapActions(deps.db, organizationId, now(), deps.resolveOwnerUserIds),
        publish: (organizationId, payload) =>
          withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
            deps.outboxPublisher.publish(tx as unknown as DbClient, {
              eventName: "m30.incident.cap_overdue",
              payload,
              organizationId,
              aggregateKind: "incident_report",
              aggregateId: String(payload.incidentId),
            }),
          ),
        emit: deps.emit,
        now,
        warn: deps.warn,
      }),
    { connection: deps.connection, concurrency: 1 },
  );
}

/** Register the daily repeatable tick; returns the schedule `Queue` for the composition root to close. */
export async function scheduleM30CapOverdueJob(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M30_CAP_OVERDUE_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: M30_CAP_OVERDUE_SCHEDULE }, removeOnComplete: true },
  );
  return queue;
}
