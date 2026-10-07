import { type DbClient, schema } from "@wardenx/db";
// apps/backend/src/modules/28-fhir/jobs/inbound-workers.ts — the two inbound-proposal lifecycle crons
// (GAP-084, §2.2, §4.8, W-FHIR-06). Before these existed a `pending` proposal sat forever: the SLA was a
// number on `tenant_fhir_config` that nothing read, and a rejected/expired proposal's raw FHIR payload (which
// can carry PHI fragments) stayed in the database long after the +30-day retention the spec promises.
//
//   • `fhir.inbound-sla-watch`          every 5 min — `pending -> expired` for proposals older than the TENANT's
//     `inbound_review_sla_hours` (read per org, 72 when the org has no config row), schedules the payload shred at
//     +30 days, emits `m28.fhir.inbound.expired` in the SAME transaction as the status change, and then raises the
//     M36 `fhir.inbound.proposal_overdue` alert (best-effort: the event is the contract, the alert a notification).
//   • `fhir.inbound-payload-destruction` hourly — replaces the payload of every `rejected`/`expired` proposal whose
//     retention has run with the `{"_destroyed":true}` sentinel. `payload_sha256`, the decision rationale and the
//     audit trail are untouched (§3.7). The due moment is `payload_erase_scheduled_at`, falling back to
//     `decided_at + 30d` for a rejection recorded before that column was set on reject.
//
// Both are bounded per org per tick, idempotent (the status / sentinel predicate is in the UPDATE itself, so a
// re-run or a concurrent run touches nothing twice), per-org (the tenant is the loop variable, never read from
// a row), and one org's failure does not stop the others (collected, re-thrown as an AggregateError at the end).
import { planInboundExpiry } from "@wardenx/fhir";
import { withOrgContext } from "@wardenx/tenancy";
import type { FhirInboundOwnerModule, FhirInboundResourceId } from "@wardenx/types";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { ActiveOrgListPort, FhirAlertPort, FhirJobOutboxPort } from "./ports";
import { INBOUND_PAYLOAD_RETENTION_DAYS, SWEEP_BATCH_LIMIT } from "./queues";

const INBOUND = schema.fhirInboundResource;
const CONFIG = schema.tenantFhirConfig;
const CLIENT = schema.fhirClient;

const SYSTEM_USER_ID = "";
const MS_PER_DAY = 86_400_000;
/** Spec §2.2 / tenant default when an org has not configured `inbound_review_sla_hours`. */
const DEFAULT_INBOUND_SLA_HOURS = 72;
const DESTROYED_SENTINEL = sql`'{"_destroyed":true}'::jsonb`;

const asTx = (tx: unknown): DbClient => tx as DbClient;

export interface InboundWorkerDeps {
  readonly db: DbClient;
  readonly outbox: FhirJobOutboxPort;
  readonly activeOrgs: ActiveOrgListPort;
  /** Best-effort M36 emit. Absent ⇒ the expiry still happens and the event is still published. */
  readonly alerts?: FhirAlertPort;
  readonly now?: () => Date;
  readonly log?: { error(obj: unknown, msg?: string): void };
}

export interface InboundSlaResult {
  readonly expired: number;
}

interface PendingProposal {
  readonly id: string;
  readonly resourceType: string;
  readonly ownerModule: FhirInboundOwnerModule;
  readonly sourceClientName: string;
  readonly proposedAt: Date;
}

async function slaHoursFor(db: DbClient, organizationId: string): Promise<number> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [row] = await asTx(tx)
      .select({ hours: CONFIG.inboundReviewSlaHours })
      .from(CONFIG)
      .where(eq(CONFIG.organizationId, organizationId))
      .limit(1);
    return row?.hours ?? DEFAULT_INBOUND_SLA_HOURS;
  });
}

async function overdueProposals(
  db: DbClient,
  organizationId: string,
  cutoff: Date,
): Promise<readonly PendingProposal[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await asTx(tx)
      .select({
        id: INBOUND.id,
        resourceType: INBOUND.resourceType,
        ownerModule: INBOUND.ownerModule,
        proposedAt: INBOUND.proposedAt,
        sourceClientName: CLIENT.name,
      })
      .from(INBOUND)
      .leftJoin(CLIENT, eq(CLIENT.id, INBOUND.sourceClientId))
      .where(
        and(
          eq(INBOUND.organizationId, organizationId),
          eq(INBOUND.proposalStatus, "pending"),
          lte(INBOUND.proposedAt, cutoff),
        ),
      )
      .orderBy(asc(INBOUND.proposedAt))
      .limit(SWEEP_BATCH_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      resourceType: r.resourceType,
      ownerModule: r.ownerModule as FhirInboundOwnerModule,
      sourceClientName: r.sourceClientName ?? "unknown client",
      proposedAt: r.proposedAt,
    }));
  });
}

/** Expire ONE proposal in its own tx. Returns the alert to raise, or null when it was no longer `pending`. */
async function expireOne(
  deps: InboundWorkerDeps,
  organizationId: string,
  proposal: PendingProposal,
  slaHours: number,
  at: Date,
): Promise<Record<string, unknown> | null> {
  const plan = planInboundExpiry(
    {
      id: proposal.id as FhirInboundResourceId,
      ownerModule: proposal.ownerModule,
      resourceType: proposal.resourceType,
      proposalStatus: "pending",
      createdAtMs: proposal.proposedAt.getTime(),
    },
    { sourceClientName: proposal.sourceClientName, slaHours, expiredAtMs: at.getTime() },
  );
  if (!plan.ok) return null;
  const eraseAt = new Date(at.getTime() + INBOUND_PAYLOAD_RETENTION_DAYS * MS_PER_DAY);
  return withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const t = asTx(tx);
    // The status predicate IS the idempotency: a proposal decided (or expired by a concurrent tick) between
    // the list and this statement matches nothing and is left alone.
    const moved = await t
      .update(INBOUND)
      .set({ proposalStatus: "expired", payloadEraseScheduledAt: eraseAt })
      .where(
        and(
          eq(INBOUND.id, proposal.id),
          eq(INBOUND.organizationId, organizationId),
          eq(INBOUND.proposalStatus, "pending"),
        ),
      )
      .returning({ id: INBOUND.id });
    if (moved.length === 0) return null;
    await deps.outbox.publish(t, {
      eventName: plan.event.type,
      payload: plan.event.payload,
      organizationId,
      aggregateKind: "fhir_inbound_resource",
      aggregateId: proposal.id,
    });
    return { ...(plan.alert ?? { kind: "fhir.inbound.proposal_overdue" }) };
  });
}

/** `fhir.inbound-sla-watch` — one tick across every active org. */
export async function runInboundSlaWatch(deps: InboundWorkerDeps): Promise<InboundSlaResult> {
  const at = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: unknown[] = [];
  let expired = 0;
  for (const { organizationId } of orgs) {
    try {
      const slaHours = await slaHoursFor(deps.db, organizationId);
      const cutoff = new Date(at.getTime() - slaHours * 3_600_000);
      for (const proposal of await overdueProposals(deps.db, organizationId, cutoff)) {
        try {
          const alert = await expireOne(deps, organizationId, proposal, slaHours, at);
          if (alert === null) continue;
          expired += 1;
          await raiseAlert(deps, organizationId, proposal.id, alert);
        } catch (error) {
          failures.push(error);
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return finish("fhir.inbound-sla-watch", deps, failures, { expired });
}

async function raiseAlert(
  deps: InboundWorkerDeps,
  organizationId: string,
  proposalId: string,
  alert: Record<string, unknown>,
): Promise<void> {
  if (deps.alerts === undefined) return;
  const { kind, ...payload } = alert;
  try {
    await deps.alerts.emit({
      organizationId,
      kind: String(kind),
      payload,
      correlationId: `fhir-inbound-overdue-${proposalId}`,
    });
  } catch (error) {
    // The proposal is already expired and the event published; a lost notification must not roll that back
    // or fail the tick (a retry would find nothing pending and could never re-raise it anyway).
    deps.log?.error({ err: error, proposalId }, "m28 inbound-sla-watch: the M36 alert failed");
  }
}

export interface InboundDestructionResult {
  readonly destroyed: number;
}

async function dueForDestruction(
  db: DbClient,
  organizationId: string,
  at: Date,
): Promise<readonly string[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const retentionInterval = sql`make_interval(days => ${INBOUND_PAYLOAD_RETENTION_DAYS})`;
    const rows = await asTx(tx)
      .select({ id: INBOUND.id })
      .from(INBOUND)
      .where(
        and(
          eq(INBOUND.organizationId, organizationId),
          inArray(INBOUND.proposalStatus, ["rejected", "expired"]),
          sql`${INBOUND.payload} <> ${DESTROYED_SENTINEL}`,
          sql`coalesce(${INBOUND.payloadEraseScheduledAt}, ${INBOUND.decidedAt} + ${retentionInterval}) <= ${at}`,
        ),
      )
      .limit(SWEEP_BATCH_LIMIT);
    return rows.map((r) => r.id);
  });
}

/** `fhir.inbound-payload-destruction` — one tick across every active org. */
export async function runInboundPayloadDestruction(
  deps: InboundWorkerDeps,
): Promise<InboundDestructionResult> {
  const at = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: unknown[] = [];
  let destroyed = 0;
  for (const { organizationId } of orgs) {
    try {
      const ids = await dueForDestruction(deps.db, organizationId, at);
      if (ids.length === 0) continue;
      destroyed += await withOrgContext(
        deps.db,
        { organizationId, userId: SYSTEM_USER_ID },
        async (tx) => {
          // Re-asserting status + sentinel inside the UPDATE keeps a concurrent run, or a row that was
          // meanwhile destroyed, from being counted twice.
          const rows = await asTx(tx)
            .update(INBOUND)
            .set({ payload: DESTROYED_SENTINEL })
            .where(
              and(
                inArray(INBOUND.id, [...ids]),
                eq(INBOUND.organizationId, organizationId),
                inArray(INBOUND.proposalStatus, ["rejected", "expired"]),
                sql`${INBOUND.payload} <> ${DESTROYED_SENTINEL}`,
              ),
            )
            .returning({ id: INBOUND.id });
          return rows.length;
        },
      );
    } catch (error) {
      failures.push(error);
    }
  }
  return finish("fhir.inbound-payload-destruction", deps, failures, { destroyed });
}

function finish<R extends object>(
  label: string,
  deps: InboundWorkerDeps,
  failures: readonly unknown[],
  result: R,
): R {
  if (failures.length === 0) return result;
  deps.log?.error({ failures: failures.length }, `m28 ${label}: some work failed`);
  throw new AggregateError(failures, `${label}: ${failures.length} failure(s)`);
}
