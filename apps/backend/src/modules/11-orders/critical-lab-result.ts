// apps/backend/src/modules/11-orders/critical-lab-result.ts — #908/#910: the `critical_lab_result` ledger (migration
// 1297). Every critical (HH/LL) observation the lab-results applier sees gets one row, written in the applier's own
// transaction, so (a) a critical result bound to NO order is quarantined in a visible queue with a response clock rather
// than dropped, (b) the M36 critical-lab alert reads one set of facts whichever event reaches it first, and (c) a later
// non-critical observation of the same test marks the earlier critical row superseded (it is never deleted).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

const CLR = schema.criticalLabResults;
const ORDER = schema.orderRecords;
const CONSUMER_USER_ID = "";

/** How long a critical result with no order may sit unresolved before the medical director + attending are paged. */
export const CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS = 60 * 60 * 1000;
/** Bound on quarantined rows escalated per org per tick (the rest are picked up by the next tick). */
const ESCALATION_BATCH = 100;

export interface RecordCriticalInput {
  readonly observationId: string;
  readonly patientId: string;
  readonly orderRecordId: string | null;
  readonly loincCode: string;
  readonly criticalFlag: "HH" | "LL";
  readonly orderUnsigned: boolean;
  readonly receivedAt: Date;
  /** The observation's clinical instant (M29 observationDatetime); null when the payload carried none. */
  readonly observationAt?: Date | null;
}

/** Insert the ledger row (idempotent per observation). `tx` is the applier's org-scoped transaction. */
export async function recordCriticalLabResult(
  tx: DbClient,
  organizationId: string,
  input: RecordCriticalInput,
): Promise<void> {
  const quarantined = input.orderRecordId === null;
  await tx
    .insert(CLR)
    .values({
      organizationId,
      patientId: input.patientId,
      observationId: input.observationId,
      orderRecordId: input.orderRecordId,
      loincCode: input.loincCode,
      criticalFlag: input.criticalFlag,
      disposition: quarantined ? "quarantined_no_order" : "paged",
      orderUnsigned: input.orderUnsigned,
      receivedAt: input.receivedAt,
      observationAt: input.observationAt ?? null,
      respondBy: quarantined
        ? new Date(input.receivedAt.getTime() + CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS)
        : null,
    })
    .onConflictDoNothing({ target: [CLR.organizationId, CLR.observationId] });
}

/** A later non-critical observation of the same test on the same order withdraws earlier criticals (marked, kept). */
export async function supersedeCriticalLabResults(
  tx: DbClient,
  organizationId: string,
  input: {
    readonly orderRecordId: string;
    readonly loincCode: string;
    readonly supersededByObservationId: string;
    readonly at: Date;
    /** The superseding observation's clinical instant; only criticals OLDER than it are withdrawn. */
    readonly observationAt: Date | null;
  },
): Promise<void> {
  await tx
    .update(CLR)
    .set({
      supersededAt: input.at,
      supersededByObservationId: input.supersededByObservationId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(CLR.organizationId, organizationId),
        eq(CLR.orderRecordId, input.orderRecordId),
        eq(CLR.loincCode, input.loincCode),
        isNull(CLR.supersededAt),
        // Order-aware: a late redelivery of an older non-critical must not withdraw a newer critical. Without a
        // clinical instant on either side, fall back to the receive instants (the superseder is "now").
        input.observationAt
          ? sql`COALESCE(${CLR.observationAt}, ${CLR.receivedAt}) <= ${input.observationAt.toISOString()}::timestamptz`
          : sql`${CLR.receivedAt} <= ${input.at.toISOString()}::timestamptz`,
      ),
    );
}

/** What M36's critical-lab alert needs for one observation; null when the applier has not recorded it yet. */
export function createCriticalLabLookup(db: DbClient) {
  return (organizationId: string, observationId: string) =>
    withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const [row] = await tx
        .select({
          patientId: CLR.patientId,
          orderId: CLR.orderRecordId,
          loincCode: CLR.loincCode,
          criticalFlag: CLR.criticalFlag,
          orderUnsigned: CLR.orderUnsigned,
          receivedAt: CLR.receivedAt,
          drafterMembershipId: ORDER.drafterMembershipId,
        })
        .from(CLR)
        .leftJoin(
          ORDER,
          and(eq(ORDER.id, CLR.orderRecordId), eq(ORDER.organizationId, CLR.organizationId)),
        )
        .where(and(eq(CLR.organizationId, organizationId), eq(CLR.observationId, observationId)))
        .limit(1);
      return row
        ? {
            observationId,
            patientId: row.patientId,
            orderId: row.orderId,
            loincCode: row.loincCode,
            criticalFlag: row.criticalFlag,
            orderUnsigned: row.orderUnsigned,
            drafterMembershipId: row.drafterMembershipId ?? null,
            receivedAt: row.receivedAt.toISOString(),
          }
        : null;
    });
}

export interface QuarantinedCritical {
  readonly observationId: string;
  readonly patientId: string;
  readonly loincCode: string;
  readonly criticalFlag: string;
  readonly receivedAt: string;
}

/**
 * Escalate every quarantined (no-order) critical whose response clock has lapsed, once. Each row is stamped and
 * escalated in ITS OWN transaction: the guarded UPDATE stamps `escalated_at` and `escalate` (the M36 page) runs in the
 * same transaction, so a failed page rolls back only that row's stamp and the next tick retries it (the alert's
 * correlation id keeps a retry from paging twice). One poison row never blocks or rolls back the others; failures are
 * collected and rethrown as an AggregateError after the loop so the tick still fails loudly.
 */
export async function sweepQuarantinedCriticalLabs(
  deps: {
    readonly db: DbClient;
    readonly escalate: (organizationId: string, row: QuarantinedCritical) => Promise<void>;
    readonly now?: () => Date;
  },
  organizationId: string,
): Promise<{ readonly examined: number; readonly acted: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await withOrgContext(
    deps.db,
    { organizationId, userId: CONSUMER_USER_ID },
    async (scoped) =>
      (scoped as unknown as DbClient)
        .select({
          id: CLR.id,
          observationId: CLR.observationId,
          patientId: CLR.patientId,
          loincCode: CLR.loincCode,
          criticalFlag: CLR.criticalFlag,
          receivedAt: CLR.receivedAt,
        })
        .from(CLR)
        .where(
          and(
            eq(CLR.organizationId, organizationId),
            eq(CLR.disposition, "quarantined_no_order"),
            isNull(CLR.escalatedAt),
            lte(CLR.respondBy, now),
          ),
        )
        .orderBy(asc(CLR.respondBy))
        .limit(ESCALATION_BATCH),
  );
  let acted = 0;
  const failures: unknown[] = [];
  for (const r of due) {
    try {
      const didAct = await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const stamped = await (scoped as unknown as DbClient)
            .update(CLR)
            .set({ escalatedAt: now, updatedAt: now })
            .where(and(eq(CLR.id, r.id), isNull(CLR.escalatedAt)))
            .returning({ id: CLR.id });
          if (stamped.length === 0) return false;
          await deps.escalate(organizationId, {
            observationId: r.observationId,
            patientId: r.patientId,
            loincCode: r.loincCode,
            criticalFlag: r.criticalFlag,
            receivedAt: r.receivedAt.toISOString(),
          });
          return true;
        },
      );
      if (didAct) acted += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `critical-lab escalation: ${failures.length} of ${due.length} row(s) failed (others were escalated)`,
    );
  }
  return { examined: due.length, acted };
}
