// apps/backend/src/modules/36-messaging/jobs/retention-destruction.ts - WP 5.6 (ADR-0086, PROPOSED): the message destruction executor.
// It deletes PHI, so every rule below fails closed:
//   * OFF unless the tenant ops flag `messaging.retention_destruction` is on (absent = off). ON alone is a DRY RUN: it reports what it
//     would destroy and deletes nothing. It deletes only when the deployment also sets `execute` (M36_RETENTION_DESTRUCTION_EXECUTE=true).
//   * It acts only under an APPROVED M4 `message.<class>` certificate (approval is M4's: permission, step-up, a person other than the
//     scan), and only while that approval is FRESH: CERTIFICATE_VALIDITY_DAYS after the scan opened it. An older one is refused, so a message
//     held at approval and released years later is never destroyed under a stale approval.
//   * The certificate's count is a CEILING and the approved figure (`record_count`) is never written. The scan records the exact number of
//     destroyable messages (not the capped plan list). A batch RESERVES its planned count in its plan transaction, under a row lock on the
//     certificate (a second executor waits, then sees the reduced remainder); after the delete it SETTLES: the reservation is released and
//     `destroyed_count` goes up by what was really deleted (the difference is refunded). A crash after the reserve can only UNDER-delete.
//     remaining = record_count - destroyed_count - reserved_count. Reserve and settle are database functions bound to a batch ROW (created by the
//     reserve, settled once by id, amount taken from the row), so exactly-once is the database's, not this file's. The window is measured from the moment the scan opened the certificate;
//     messages that age past it later wait for a later certificate. Freshness and "still approved" are re-checked in the plan transaction and
//     again in the destructive transaction.
//   * A held message is never a candidate and is never deleted: the hold is re-read, and the delete re-evaluates it, INSIDE the
//     destructive transaction, under the shared per-org hold lock (an apply takes it exclusive, so apply and destroy serialise). The
//     database trigger (migration 1138) is the backstop behind that. A message with an undestroyed attachment object, or a reply or quote
//     that still points at it, is kept (the bytes cannot be rolled back; a parent outlives its replies).
//   * Per batch: (A) plan, in the app role's tenant tx, and COMMIT an audit row naming the ids; (B) delete, in the destruction
//     credential's tenant tx (the only role the append-only history cascades accept), RE-checking everything and returning the ids it
//     deleted; (C) audit what B did and settle the reservation, in ONE transaction, retried. A crash between steps leaves the planned ids
//     on record and the count reserved (never over-spent). If C still fails after the retries, the destroyed ids are carried on the thrown
//     error and in the run summary (ids only); the reservation stays, so the certificate can only destroy less, never more.
//   * One failing batch ends only its own certificate; the org's other certificates still run and the failure is reported at the end.
//   * Idempotent (deleting a gone row is a no-op, an executed certificate is not picked up again) and bounded (a batch size and a
//     per-run batch budget). A worker is not a request: every transaction is org-explicit (`withOrgContext(systemOrgContext(org))`).
import { randomUUID } from "node:crypto";
import { type AuditExecutor, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  MESSAGE_RETENTION_CLASSES,
  type MessageRetentionClass,
  type RetentionDestructionMode,
  messagingHoldLockName,
} from "@chartwarden/types";
import { type SQL, and, eq, lt, sql } from "drizzle-orm";
import {
  type ActiveMessageHold,
  type ApprovedMessageCertificateRef,
  HAS_PENDING_OBJECT,
  IS_REFERENCED,
  type MessageDestructionHoldPort,
  anyHoldPredicate,
  overlayHeldPredicate,
  uuidList,
} from "./retention-hold-sql";
import {
  FROM_MESSAGE,
  MESSAGE_RETENTION_YEARS,
  count,
  pastWindow,
  windowEnd,
} from "./retention-scan";

/** Messages planned and deleted per transaction pair. */
export const DESTRUCTION_BATCH_SIZE = 500;
/** Batches per certificate per run; the rest resumes next run (an approved certificate stays approved until it drains). */
export const DESTRUCTION_MAX_BATCHES_PER_CERTIFICATE = 40;
/** Approved certificates acted on per org per run. */
export const DESTRUCTION_MAX_CERTIFICATES_PER_RUN = 6;
/** An approved certificate is acted on only this long after the scan opened it; later it is refused (a new scan opens a fresh one). */
export const CERTIFICATE_VALIDITY_DAYS = 35;
/** Attempts at recording a committed batch (audit plus spending the count) before the destroyed ids are reported on the error. */
export const BATCH_RECORD_ATTEMPTS = 3;
/** Expired approvals named in a run row (the rest are not listed; none is ever acted on). */
export const EXPIRED_REPORT_LIMIT = 50;
/**
 * A reservation whose batch is still `reserved` after this long is treated as stranded (a crash between the delete and the settle) and
 * reconciled. Deliberately far longer than any delete transaction can run, so a live executor is never raced.
 */
export const STRANDED_BATCH_AFTER_HOURS = 6;
/**
 * The delete step refuses to run when its reservation is older than this (it refunds instead). Must stay well under STRANDED_BATCH_AFTER_HOURS:
 * a reconcile reads "gone" ids from committed state, so a delete that could still commit after a reconcile would be counted as refunded.
 */
export const MAX_RESERVATION_AGE_HOURS = 5;
/** Statement and lock timeouts of the destructive transaction (a few statements, so the whole transaction ends far inside the stranded threshold). */
export const DELETE_STATEMENT_TIMEOUT_MS = 600_000;
export const DELETE_LOCK_TIMEOUT_MS = 60_000;
/** Stranded batches reconciled per org per run. */
export const RECONCILE_MAX_BATCHES_PER_RUN = 50;

const BATCH = schema.messageDestructionBatches;

export interface RetentionDestructionDeps {
  /** The tenant (app role) pool: candidate planning, certificate close, audit. */
  readonly db: DbClient;
  /** The destruction credential's pool (a login IN ROLE chartwarden_destruction): the only connection that deletes messages. */
  readonly destructionDb: DbClient;
  readonly messageHolds: MessageDestructionHoldPort;
  /** The tenant ops flag, read per org (absent = off). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  /** The deployment's second switch. false (the default) = dry run. */
  readonly execute?: boolean;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
  readonly batchSize?: number;
  readonly maxBatchesPerCertificate?: number;
  readonly certificateValidityDays?: number;
  /** Tests only: the oldest reservation the delete step will act on (default MAX_RESERVATION_AGE_HOURS). */
  readonly maxReservationAgeMs?: number;
  /** Tests only: the audit writer (default `@chartwarden/audit`). */
  readonly auditWriter?: typeof audit;
  /** Called with the error of a failed batch (the worker logs it; ids only). */
  readonly onBatchError?: (error: unknown) => void;
}

/** A batch's rows are gone but recording it failed after the retries: the ids are here (ids only) so they are never lost. */
export class DestructionUnrecordedError extends Error {
  constructor(
    readonly certificateId: string,
    readonly destroyedMessageIds: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(
      `retention destruction: ${destroyedMessageIds.length} message(s) were destroyed under certificate ${certificateId} but the batch could not be recorded: ${destroyedMessageIds.join(",")}`,
      options,
    );
    this.name = "DestructionUnrecordedError";
  }
}

export interface CertificateDestructionResult {
  readonly certificateId: string;
  readonly dataClass: string;
  /** Messages past this certificate's window that still exist (any reason). */
  readonly pastWindowRemaining: number;
  /** Dry run: what a live run would plan now (bounded by the approved count left). Live: planned across the run's batches. */
  readonly eligible: number;
  readonly destroyed: number;
  /** Past the window but withheld by an active hold (the overlay or the live criteria). */
  readonly heldRefused: number;
  /** Past the window but bearing an attachment object that is not yet destroyed. */
  readonly attachmentPending: number;
  /** Past the window but still the parent or quote target of another message. */
  readonly referenced: number;
  /** Planned rows the delete refused because it re-checked them (a hold or reference landed in between). */
  readonly refusedAtDelete: number;
  /** True when a batch found nothing left to plan (the certificate is not stopped by the run's batch budget). */
  readonly drained: boolean;
  /** What the approved count still allows after this run (the ceiling across runs). */
  readonly approvedRemaining: number;
  readonly certificateExecuted: boolean;
  /** A batch failed (the rest of the org's certificates still ran); ids of any message destroyed but not recorded. */
  readonly failure?: {
    readonly message: string;
    readonly unrecordedDestroyedIds: readonly string[];
  };
}

export interface RetentionDestructionResult {
  readonly runId: string;
  readonly mode: RetentionDestructionMode;
  readonly destroyed: number;
  readonly certificates: readonly CertificateDestructionResult[];
  /** Approved certificates older than their validity: refused, nothing destroyed under them. */
  readonly expiredCertificateIds: readonly string[];
  /** Stranded reservations found (dry run: reported only; live: reconciled before planning). */
  readonly reconciled: readonly ReconcileResult[];
}

const SYSTEM = (organizationId: string, correlationId: string) => ({
  organizationId,
  userId: null,
  actorKind: "system" as const,
  correlationId,
});

const retentionClassOf = (dataClass: string): MessageRetentionClass | null => {
  const cls = dataClass.startsWith("message.") ? dataClass.slice("message.".length) : "";
  return (MESSAGE_RETENTION_CLASSES as readonly string[]).includes(cls)
    ? (cls as MessageRetentionClass)
    : null;
};

const heldPredicate = (holds: readonly ActiveMessageHold[]): SQL =>
  sql`(${overlayHeldPredicate(holds)} OR ${anyHoldPredicate(holds)})`;

/** Everything that must hold for a message to be destroyed. ONE definition: planning, the delete and the dry run all use it. */
export function destroyablePredicate(
  orgId: string,
  cls: MessageRetentionClass,
  windowEndsAt: Date,
  holds: readonly ActiveMessageHold[],
): SQL {
  return sql`${pastWindow(orgId, cls, windowEndsAt)}
    AND NOT ${heldPredicate(holds)} AND NOT ${HAS_PENDING_OBJECT} AND NOT ${IS_REFERENCED}`;
}

/** The per-org advisory lock an apply takes EXCLUSIVE; taking it SHARED means a hold cannot land between our read and our write. */
async function lockHoldsShared(tx: DbClient, orgId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${messagingHoldLockName(orgId)}, 0))`,
  );
}

interface PlannedBatch {
  readonly ids: readonly string[];
  /** What is still reservable after this batch's reservation. */
  readonly remaining: number;
  /** True when the certificate is gone, not approved or stale: nothing was planned and the certificate must not be acted on. */
  readonly refused: boolean;
  /** The database's clock when the reservation was written; the delete step refuses a reservation that has aged past MAX_RESERVATION_AGE_HOURS. */
  readonly reservedAt?: Date;
}

/** A message an unsettled batch has planned is not planned again: its delete may still be in flight. */
const NOT_IN_RESERVED_BATCH: SQL = sql`NOT EXISTS (SELECT 1 FROM message_destruction_batch b
  WHERE b.organization_id = m.organization_id AND b.state = 'reserved' AND b.planned_message_ids @> ARRAY[m.id])`;

async function planBatch(
  deps: RetentionDestructionDeps,
  orgId: string,
  batchId: string,
  cert: ApprovedMessageCertificateRef,
  cls: MessageRetentionClass,
  windowEndsAt: Date,
  limit: number,
  notBefore: Date,
  onPlanned: (tx: DbClient, ids: readonly string[]) => Promise<void>,
): Promise<PlannedBatch> {
  return withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    // The row lock serialises executors on this certificate: what is read here is what may be reserved here.
    const locked = await deps.messageHolds.lockCertificate(tx, {
      organizationId: orgId,
      certificateId: cert.id,
    });
    if (!locked || locked.status !== "approved" || locked.createdAt < notBefore) {
      return { ids: [], remaining: 0, refused: true };
    }
    const take = Math.min(limit, locked.available);
    if (take <= 0) return { ids: [], remaining: locked.available, refused: false };
    await lockHoldsShared(tx, orgId);
    const holds = await deps.messageHolds.activeHolds(tx, orgId);
    const rows = (
      await tx.execute<{ id: string }>(
        sql`SELECT m.id ${FROM_MESSAGE} WHERE ${destroyablePredicate(orgId, cls, windowEndsAt, holds)}
              AND ${NOT_IN_RESERVED_BATCH}
            ORDER BY m.created_at, m.id LIMIT ${take}`,
      )
    ).rows;
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { ids, remaining: locked.available, refused: false };
    // The database function reserves the count AND writes the batch row (the planned ids) in one step, so a crash can be reconciled later
    // and a settle can only ever name this batch.
    const reserved = await deps.messageHolds.reserveCertificateCount(tx, {
      organizationId: orgId,
      certificateId: cert.id,
      batchId,
      messageIds: ids,
    });
    if (!reserved) return { ids: [], remaining: 0, refused: true };
    const [row] = await tx
      .select({ reservedAt: BATCH.reservedAt })
      .from(BATCH)
      .where(and(eq(BATCH.organizationId, orgId), eq(BATCH.id, batchId)));
    await onPlanned(tx, ids);
    return {
      ids,
      remaining: locked.available - ids.length,
      refused: false,
      reservedAt: row?.reservedAt,
    };
  });
}

/**
 * The destructive transaction, on the destruction credential. The hold is read HERE (same tx as the DELETE, under the shared lock) and
 * the whole destroyable predicate is evaluated again in the DELETE itself, so the planned id list is only a request, never an authority.
 */
async function deleteBatch(
  deps: RetentionDestructionDeps,
  orgId: string,
  certificateId: string,
  notBefore: Date,
  cls: MessageRetentionClass,
  windowEndsAt: Date,
  ids: readonly string[],
  reservedAt: Date | undefined,
): Promise<readonly string[]> {
  const maxAgeMs = deps.maxReservationAgeMs ?? MAX_RESERVATION_AGE_HOURS * 3_600_000;
  return withOrgContext(deps.destructionDb, systemOrgContext(orgId), async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    // Bounded: a statement or lock wait that hangs ends this transaction long before a reconcile could treat the reservation as stranded.
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(DELETE_STATEMENT_TIMEOUT_MS)}, true),
                                set_config('lock_timeout', ${String(DELETE_LOCK_TIMEOUT_MS)}, true)`);
    // The reservation must still be young (the database's clock): an old one may already be reconciled, so nothing is deleted under it;
    // the caller settles it with 0 destroyed, which refunds it.
    const aged = reservedAt
      ? (
          await tx.execute<{ fresh: boolean }>(
            sql`SELECT (now() - ${reservedAt.toISOString()}::timestamptz) < (${String(maxAgeMs)} || ' milliseconds')::interval AS fresh`,
          )
        ).rows[0]?.fresh !== true
      : true;
    if (aged) return [];
    await lockHoldsShared(tx, orgId);
    const holds = await deps.messageHolds.activeHolds(tx, orgId);
    // The certificate is re-checked in THIS transaction (M4's reader; the destruction credential can only read it): a certificate moved off
    // approved, or gone stale, since the plan destroys nothing.
    const live = await deps.messageHolds.certificateIsLive(tx, {
      organizationId: orgId,
      certificateId,
      notBefore,
    });
    if (!live) return [];
    const deleted = await tx.execute<{ id: string }>(
      sql`DELETE FROM message m USING channel c
           WHERE c.organization_id = m.organization_id AND c.id = m.channel_id
             AND m.id IN (${uuidList(ids)})
             AND ${destroyablePredicate(orgId, cls, windowEndsAt, holds)}
          RETURNING m.id`,
    );
    return deleted.rows.map((r) => r.id);
  });
}

interface RemainderCounts {
  readonly pastWindowRemaining: number;
  readonly heldRefused: number;
  readonly attachmentPending: number;
  readonly referenced: number;
  readonly eligible: number;
}

/** Counts of what is still past the window and why it is (or is not) destroyable, in one tenant tx. */
async function countRemainder(
  deps: RetentionDestructionDeps,
  orgId: string,
  cls: MessageRetentionClass,
  windowEndsAt: Date,
): Promise<RemainderCounts> {
  return withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    const holds = await deps.messageHolds.activeHolds(tx, orgId);
    const base = pastWindow(orgId, cls, windowEndsAt);
    return {
      pastWindowRemaining: await count(tx, base),
      heldRefused: await count(tx, sql`${base} AND ${heldPredicate(holds)}`),
      attachmentPending: await count(tx, sql`${base} AND ${HAS_PENDING_OBJECT}`),
      referenced: await count(tx, sql`${base} AND ${IS_REFERENCED}`),
      eligible: await count(tx, destroyablePredicate(orgId, cls, windowEndsAt, holds)),
    };
  });
}

async function auditIn(
  deps: RetentionDestructionDeps,
  orgId: string,
  runId: string,
  eventType: string,
  resourceId: string,
  context: Record<string, unknown>,
): Promise<void> {
  const write = deps.auditWriter ?? audit;
  await withOrgContext(deps.db, systemOrgContext(orgId), (txRaw) =>
    write(txRaw as unknown as AuditExecutor, SYSTEM(orgId, runId), {
      eventType,
      resourceKind: "message_retention_run",
      resourceId,
      outcome: "success",
      context,
    }),
  );
}

/** Record a committed batch: its audit row and the settled reservation, in ONE tenant transaction, retried. Returns what is still reservable. */
async function recordBatch(
  deps: RetentionDestructionDeps,
  orgId: string,
  runId: string,
  cert: ApprovedMessageCertificateRef,
  batchId: string,
  planned: number,
  deletedIds: readonly string[],
): Promise<number> {
  const write = deps.auditWriter ?? audit;
  let last: unknown;
  for (let attempt = 0; attempt < BATCH_RECORD_ATTEMPTS; attempt += 1) {
    try {
      return await withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
        const tx = txRaw as unknown as DbClient;
        await write(tx as unknown as AuditExecutor, SYSTEM(orgId, runId), {
          eventType: "m36.retention_destruction.batch_completed",
          resourceKind: "message_retention_run",
          resourceId: batchId,
          outcome: "success",
          context: {
            runId,
            batchId,
            certificateId: cert.id,
            planned,
            destroyed: deletedIds.length,
            refusedAtDelete: planned - deletedIds.length,
            destroyedMessageIds: deletedIds,
          },
        });
        // The database settles THIS batch: it must still be `reserved` (one a reconcile already settled is refused, never settled twice), and
        // its reserved amount is the batch's own planned count.
        return deps.messageHolds.settleCertificateCount(tx, {
          organizationId: orgId,
          batchId,
          destroyed: deletedIds.length,
          state: "settled",
        });
      });
    } catch (error) {
      last = error;
    }
  }
  throw new DestructionUnrecordedError(cert.id, deletedIds, { cause: last });
}

async function closeCertificate(
  deps: RetentionDestructionDeps,
  orgId: string,
  runId: string,
  cert: ApprovedMessageCertificateRef,
  now: Date,
): Promise<boolean> {
  const write = deps.auditWriter ?? audit;
  return withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    const closed = await deps.messageHolds.completeCertificate(tx, {
      organizationId: orgId,
      certificateId: cert.id,
      executedAt: now,
    });
    if (closed) {
      await write(tx as unknown as AuditExecutor, SYSTEM(orgId, runId), {
        eventType: "m36.retention_destruction.certificate_executed",
        resourceKind: "destruction_certificate",
        resourceId: cert.id,
        outcome: "success",
        context: { runId, certificateId: cert.id, dataClass: cert.dataClass },
      });
    }
    return closed;
  });
}

async function destroyUnderCertificate(
  deps: RetentionDestructionDeps,
  orgId: string,
  runId: string,
  cert: ApprovedMessageCertificateRef,
  cls: MessageRetentionClass,
  live: boolean,
  notBefore: Date,
): Promise<CertificateDestructionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const windowEndsAt = windowEnd(cert.createdAt, MESSAGE_RETENTION_YEARS[cls]);
  const batchSize = deps.batchSize ?? DESTRUCTION_BATCH_SIZE;
  const maxBatches = deps.maxBatchesPerCertificate ?? DESTRUCTION_MAX_BATCHES_PER_CERTIFICATE;
  const write = deps.auditWriter ?? audit;
  let destroyed = 0;
  let planned = 0;
  let refusedAtDelete = 0;
  let drained = !live;
  let refused = false;
  // The approved count is the ceiling across runs: every committed batch spends it, and no batch may plan more than is left.
  let remaining = Math.max(cert.recordCount - cert.destroyedCount - cert.reservedCount, 0);
  let failure: CertificateDestructionResult["failure"];

  try {
    for (let batch = 0; live && batch < maxBatches && remaining > 0; batch += 1) {
      const batchId = randomUUID();
      const plan = await planBatch(
        deps,
        orgId,
        batchId,
        cert,
        cls,
        windowEndsAt,
        batchSize,
        notBefore,
        (tx, plannedIds) =>
          write(tx as unknown as AuditExecutor, SYSTEM(orgId, runId), {
            eventType: "m36.retention_destruction.batch_started",
            resourceKind: "message_retention_run",
            resourceId: batchId,
            outcome: "success",
            context: {
              runId,
              batchId,
              certificateId: cert.id,
              dataClass: cert.dataClass,
              plannedMessageIds: plannedIds,
            },
          }),
      );
      const ids = plan.ids;
      remaining = plan.remaining;
      if (plan.refused) {
        refused = true;
        break;
      }
      if (ids.length === 0) {
        drained = true;
        break;
      }
      planned += ids.length;
      const deletedIds = await deleteBatch(
        deps,
        orgId,
        cert.id,
        notBefore,
        cls,
        windowEndsAt,
        ids,
        plan.reservedAt,
      );
      destroyed += deletedIds.length;
      refusedAtDelete += ids.length - deletedIds.length;
      remaining = await recordBatch(deps, orgId, runId, cert, batchId, ids.length, deletedIds);
      // Everything planned was refused at delete time (a hold or reference landed in between): planning again would repeat itself.
      if (deletedIds.length === 0) break;
    }
  } catch (error) {
    // One failing batch ends THIS certificate only; the org's other certificates still run, and the run reports it at the end.
    const unrecorded = error instanceof DestructionUnrecordedError ? error.destroyedMessageIds : [];
    failure = {
      message: error instanceof Error ? error.name : "unknown",
      unrecordedDestroyedIds: unrecorded,
    };
    deps.onBatchError?.(error);
  }

  const rest = await countRemainder(deps, orgId, cls, windowEndsAt);
  // Close the certificate when its approved count is spent, or when nothing past its window remains for the class; held, object-bearing or
  // referenced rows (with count left) keep it open until it expires.
  // "Spent" means really spent (record - destroyed), read now: another executor's in-flight reservation may still be refunded, so a remainder
  // of 0 at plan time (reservations included) must not close the certificate.
  const unspent = live
    ? await withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
        const locked = await deps.messageHolds.lockCertificate(txRaw as unknown as DbClient, {
          organizationId: orgId,
          certificateId: cert.id,
        });
        return locked?.unspent;
      })
    : undefined;
  let certificateExecuted = false;
  if (
    live &&
    !failure &&
    !refused &&
    (unspent === 0 || (drained && rest.pastWindowRemaining === 0))
  ) {
    certificateExecuted = await closeCertificate(deps, orgId, runId, cert, now);
  }
  return {
    certificateId: cert.id,
    dataClass: cert.dataClass,
    pastWindowRemaining: rest.pastWindowRemaining,
    eligible: live ? planned : Math.min(rest.eligible, remaining),
    destroyed,
    heldRefused: rest.heldRefused,
    attachmentPending: rest.attachmentPending,
    referenced: rest.referenced,
    refusedAtDelete,
    drained,
    approvedRemaining: remaining,
    certificateExecuted,
    ...(failure ? { failure } : {}),
  };
}

export interface ReconcileResult {
  readonly batchId: string;
  readonly certificateId: string;
  readonly planned: number;
  readonly destroyed: number;
  readonly refunded: number;
}

/**
 * Reconcile reservations stranded by a crash: a batch still `reserved` after STRANDED_BATCH_AFTER_HOURS is settled by comparing its planned ids
 * with the message table (a planned id that no longer exists was destroyed by that batch; the rest are refunded). The settle is the same database
 * function the executor uses, so the batch flips exactly once and the reservation is released from the batch's own planned count: capacity can
 * never exceed the approved figure. Planning never re-plans an id an unsettled batch holds, so an id is credited by at most one batch.
 * One batch per transaction, in certificate order (no two transactions take certificate locks in different orders); one batch failing is
 * reported and does not stop the others. Runs before planning, so refunded capacity is usable in the same run.
 */
async function reconcileStrandedBatches(
  deps: RetentionDestructionDeps,
  orgId: string,
  runId: string,
  now: Date,
  apply: boolean,
  onError: (error: unknown) => void,
): Promise<readonly ReconcileResult[]> {
  const before = new Date(now.getTime() - STRANDED_BATCH_AFTER_HOURS * 3_600_000);
  const write = deps.auditWriter ?? audit;
  const stranded = await withOrgContext(deps.db, systemOrgContext(orgId), (txRaw) =>
    (txRaw as unknown as DbClient)
      .select()
      .from(BATCH)
      .where(
        and(
          eq(BATCH.organizationId, orgId),
          eq(BATCH.state, "reserved"),
          lt(BATCH.reservedAt, before),
        ),
      )
      .orderBy(BATCH.certificateId, BATCH.reservedAt)
      .limit(RECONCILE_MAX_BATCHES_PER_RUN),
  );
  const results: ReconcileResult[] = [];
  for (const batch of stranded) {
    try {
      const result = await withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
        const tx = txRaw as unknown as DbClient;
        const gone = (
          await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM unnest(ARRAY[${uuidList(batch.plannedMessageIds)}]::uuid[]) AS u(id)
                 WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m.organization_id = ${orgId}::uuid AND m.id = u.id)`,
          )
        ).rows[0]?.n;
        const destroyed = Math.min(Number(gone ?? 0), batch.plannedCount);
        const reconciled: ReconcileResult = {
          batchId: batch.id,
          certificateId: batch.certificateId,
          planned: batch.plannedCount,
          destroyed,
          refunded: batch.plannedCount - destroyed,
        };
        if (!apply) return reconciled;
        await deps.messageHolds.settleCertificateCount(tx, {
          organizationId: orgId,
          batchId: batch.id,
          destroyed,
          state: "reconciled",
        });
        await write(tx as unknown as AuditExecutor, SYSTEM(orgId, runId), {
          eventType: "m36.retention_destruction.reconciled",
          resourceKind: "message_retention_run",
          resourceId: batch.id,
          outcome: "success",
          context: { runId, batches: [reconciled] },
        });
        return reconciled;
      });
      results.push(result);
    } catch (error) {
      // Another executor settled it first, or the database refused: report, keep going.
      onError(error);
    }
  }
  return results;
}

/** One org's destruction run. Returns `mode: "off"` (and touches nothing) when the tenant flag is off. */
export async function runRetentionDestructionForOrg(
  deps: RetentionDestructionDeps,
  orgId: string,
): Promise<RetentionDestructionResult> {
  const runId = (deps.newRunId ?? randomUUID)();
  if (!(await deps.isEnabled(orgId))) {
    return {
      runId,
      mode: "off",
      destroyed: 0,
      certificates: [],
      expiredCertificateIds: [],
      reconciled: [],
    };
  }
  const live = deps.execute === true;
  const mode: RetentionDestructionMode = live ? "live" : "dry_run";
  const now = (deps.now ?? (() => new Date()))();
  const validityMs = (deps.certificateValidityDays ?? CERTIFICATE_VALIDITY_DAYS) * 86_400_000;
  const notBefore = new Date(now.getTime() - validityMs);
  // Stranded reservations (a crash between delete and settle) are reconciled first when live, and only REPORTED in a dry run.
  // A failed reconcile is reported with the run's other failures, never allowed to block the certificates below.
  const reconcileErrors: unknown[] = [];
  const reconciled = await reconcileStrandedBatches(deps, orgId, runId, now, live, (error) => {
    reconcileErrors.push(error);
    deps.onBatchError?.(error);
  }).catch((error: unknown) => {
    reconcileErrors.push(error);
    deps.onBatchError?.(error);
    return [] as readonly ReconcileResult[];
  });
  const approved = await withOrgContext(deps.db, systemOrgContext(orgId), (txRaw) =>
    deps.messageHolds.approvedCertificates(
      txRaw as unknown as DbClient,
      orgId,
      DESTRUCTION_MAX_CERTIFICATES_PER_RUN,
      notBefore,
    ),
  );
  const expiredCertificateIds = [
    ...(await withOrgContext(deps.db, systemOrgContext(orgId), (txRaw) =>
      deps.messageHolds.expiredCertificateIds(
        txRaw as unknown as DbClient,
        orgId,
        notBefore,
        EXPIRED_REPORT_LIMIT,
      ),
    )),
  ];
  const certificates: CertificateDestructionResult[] = [];
  for (const cert of approved) {
    const cls = retentionClassOf(cert.dataClass);
    if (!cls) continue; // not a class this module owns: never guess
    certificates.push(
      await destroyUnderCertificate(deps, orgId, runId, cert, cls, live, notBefore),
    );
  }
  const destroyed = certificates.reduce((n, c) => n + c.destroyed, 0);
  await auditIn(deps, orgId, runId, "m36.retention_destruction.run", runId, {
    runId,
    mode,
    destroyed,
    certificates,
    expiredCertificateIds,
    reconciled: reconciled.length,
  });
  const failures = certificates.filter((c) => c.failure);
  if (failures.length > 0 || reconcileErrors.length > 0) {
    const reasons = [
      ...reconcileErrors.map(
        (e) =>
          `reconcile: ${e instanceof Error ? e.name : "unknown"} (stranded reservation not settled)`,
      ),
      ...failures.map((c) => {
        const ids = c.failure?.unrecordedDestroyedIds ?? [];
        return `certificate ${c.certificateId}: ${c.failure?.message}${
          ids.length > 0 ? ` (destroyed but unrecorded: ${ids.join(",")})` : ""
        }`;
      }),
    ];
    throw new AggregateError(
      reasons.map((r) => new Error(r)),
      `retention destruction run ${runId} for org ${orgId}: ${reasons.length} failure(s) after the rest of the run completed; ${reasons.join("; ")}`,
    );
  }
  return { runId, mode, destroyed, certificates, expiredCertificateIds, reconciled };
}
