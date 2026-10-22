// apps/backend/src/modules/36-messaging/jobs/retention-destruction.ts - WP 5.6 (ADR-0086, PROPOSED): the message destruction executor.
// It deletes PHI, so every rule below fails closed:
//   * OFF unless the tenant ops flag `messaging.retention_destruction` is on (absent = off). ON alone is a DRY RUN: it reports what it
//     would destroy and deletes nothing. It deletes only when the deployment also sets `execute` (M36_RETENTION_DESTRUCTION_EXECUTE=true).
//   * It acts only under an APPROVED M4 `message.<class>` certificate (approval is M4's: permission, step-up, a person other than the
//     scan). The window is measured from the moment the scan opened the certificate, so it never destroys more than the approver's
//     count covered; messages that age past the window later wait for the next month's certificate.
//   * A held message is never a candidate and is never deleted: the hold is re-read, and the delete re-evaluates it, INSIDE the
//     destructive transaction, under the shared per-org hold lock (an apply takes it exclusive, so apply and destroy serialise). The
//     database trigger (migration 1138) is the backstop behind that. A message with an undestroyed attachment object, or a reply or quote
//     that still points at it, is kept (the bytes cannot be rolled back; a parent outlives its replies).
//   * Per batch: (A) plan, in the app role's tenant tx, and COMMIT an audit row naming the ids; (B) delete, in the destruction
//     credential's tenant tx (the only role the append-only history cascades accept), RE-checking everything and returning the ids it
//     deleted; (C) audit what B did. A crash between steps leaves the planned ids on record, never an unrecorded delete.
//   * Idempotent (deleting a gone row is a no-op, an executed certificate is not picked up again) and bounded (a batch size and a
//     per-run batch budget). A worker is not a request: every transaction is org-explicit (`withOrgContext(systemOrgContext(org))`).
import { randomUUID } from "node:crypto";
import { type AuditExecutor, audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  MESSAGE_RETENTION_CLASSES,
  type MessageRetentionClass,
  type RetentionDestructionMode,
  messagingHoldLockName,
} from "@chartwarden/types";
import { type SQL, sql } from "drizzle-orm";
import {
  type ActiveMessageHold,
  type ApprovedMessageCertificateRef,
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
}

export interface CertificateDestructionResult {
  readonly certificateId: string;
  readonly dataClass: string;
  /** Messages past this certificate's window that still exist (any reason). */
  readonly pastWindowRemaining: number;
  /** Dry run: what a live run would plan now (bounded by one run's budget). Live: planned across the run's batches. */
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
  readonly certificateExecuted: boolean;
}

export interface RetentionDestructionResult {
  readonly runId: string;
  readonly mode: RetentionDestructionMode;
  readonly destroyed: number;
  readonly certificates: readonly CertificateDestructionResult[];
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

/** An attachment whose stored object has not been destroyed: deleting the message row would orphan the only copy of the bytes. */
const HAS_PENDING_OBJECT = sql`EXISTS (SELECT 1 FROM message_attachment a
  WHERE a.organization_id = m.organization_id AND a.message_id = m.id
    AND a.object_key IS NOT NULL AND a.object_destroyed_at IS NULL)`;
/** A reply or quote still points at this message: the parent/quote FKs are NO ACTION, so it goes after them. */
const IS_REFERENCED = sql`EXISTS (SELECT 1 FROM message r
  WHERE r.organization_id = m.organization_id AND (r.parent_message_id = m.id OR r.quoted_message_id = m.id))`;

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

async function planBatch(
  deps: RetentionDestructionDeps,
  orgId: string,
  cls: MessageRetentionClass,
  windowEndsAt: Date,
  limit: number,
  onPlanned: (tx: DbClient, ids: readonly string[]) => Promise<void>,
): Promise<readonly string[]> {
  return withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    await lockHoldsShared(tx, orgId);
    const holds = await deps.messageHolds.activeHolds(tx, orgId);
    const rows = (
      await tx.execute<{ id: string }>(
        sql`SELECT m.id ${FROM_MESSAGE} WHERE ${destroyablePredicate(orgId, cls, windowEndsAt, holds)}
            ORDER BY m.created_at, m.id LIMIT ${limit}`,
      )
    ).rows;
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) await onPlanned(tx, ids);
    return ids;
  });
}

/**
 * The destructive transaction, on the destruction credential. The hold is read HERE (same tx as the DELETE, under the shared lock) and
 * the whole destroyable predicate is evaluated again in the DELETE itself, so the planned id list is only a request, never an authority.
 */
async function deleteBatch(
  deps: RetentionDestructionDeps,
  orgId: string,
  cls: MessageRetentionClass,
  windowEndsAt: Date,
  ids: readonly string[],
): Promise<readonly string[]> {
  return withOrgContext(deps.destructionDb, systemOrgContext(orgId), async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    await lockHoldsShared(tx, orgId);
    const holds = await deps.messageHolds.activeHolds(tx, orgId);
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
  await withOrgContext(deps.db, systemOrgContext(orgId), (txRaw) =>
    audit(txRaw as unknown as AuditExecutor, SYSTEM(orgId, runId), {
      eventType,
      resourceKind: "message_retention_run",
      resourceId,
      outcome: "success",
      context,
    }),
  );
}

async function destroyUnderCertificate(
  deps: RetentionDestructionDeps,
  orgId: string,
  runId: string,
  cert: ApprovedMessageCertificateRef,
  cls: MessageRetentionClass,
  live: boolean,
): Promise<CertificateDestructionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const windowEndsAt = windowEnd(cert.createdAt, MESSAGE_RETENTION_YEARS[cls]);
  const batchSize = deps.batchSize ?? DESTRUCTION_BATCH_SIZE;
  const maxBatches = deps.maxBatchesPerCertificate ?? DESTRUCTION_MAX_BATCHES_PER_CERTIFICATE;
  let destroyed = 0;
  let planned = 0;
  let refusedAtDelete = 0;
  let drained = !live;

  for (let batch = 0; live && batch < maxBatches; batch += 1) {
    const batchId = randomUUID();
    const ids = await planBatch(deps, orgId, cls, windowEndsAt, batchSize, (tx, plannedIds) =>
      audit(tx as unknown as AuditExecutor, SYSTEM(orgId, runId), {
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
    if (ids.length === 0) {
      drained = true;
      break;
    }
    planned += ids.length;
    const deletedIds = await deleteBatch(deps, orgId, cls, windowEndsAt, ids);
    destroyed += deletedIds.length;
    refusedAtDelete += ids.length - deletedIds.length;
    await auditIn(deps, orgId, runId, "m36.retention_destruction.batch_completed", batchId, {
      runId,
      batchId,
      certificateId: cert.id,
      planned: ids.length,
      destroyed: deletedIds.length,
      refusedAtDelete: ids.length - deletedIds.length,
      destroyedMessageIds: deletedIds,
    });
    // Everything planned was refused at delete time (a hold or reference landed in between): planning again would repeat itself.
    if (deletedIds.length === 0) break;
  }

  const rest = await countRemainder(deps, orgId, cls, windowEndsAt);
  // Close the certificate only when nothing past its window remains for the class: held, object-bearing or referenced rows keep it open.
  let certificateExecuted = false;
  if (live && drained && rest.pastWindowRemaining === 0) {
    certificateExecuted = await withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
      const tx = txRaw as unknown as DbClient;
      const closed = await deps.messageHolds.completeCertificate(tx, {
        organizationId: orgId,
        certificateId: cert.id,
        executedAt: now,
      });
      if (closed) {
        await audit(tx as unknown as AuditExecutor, SYSTEM(orgId, runId), {
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
  return {
    certificateId: cert.id,
    dataClass: cert.dataClass,
    pastWindowRemaining: rest.pastWindowRemaining,
    eligible: live ? planned : rest.eligible,
    destroyed,
    heldRefused: rest.heldRefused,
    attachmentPending: rest.attachmentPending,
    referenced: rest.referenced,
    refusedAtDelete,
    drained,
    certificateExecuted,
  };
}

/** One org's destruction run. Returns `mode: "off"` (and touches nothing) when the tenant flag is off. */
export async function runRetentionDestructionForOrg(
  deps: RetentionDestructionDeps,
  orgId: string,
): Promise<RetentionDestructionResult> {
  const runId = (deps.newRunId ?? randomUUID)();
  if (!(await deps.isEnabled(orgId))) return { runId, mode: "off", destroyed: 0, certificates: [] };
  const live = deps.execute === true;
  const mode: RetentionDestructionMode = live ? "live" : "dry_run";
  const approved = await withOrgContext(deps.db, systemOrgContext(orgId), (txRaw) =>
    deps.messageHolds.approvedCertificates(
      txRaw as unknown as DbClient,
      orgId,
      DESTRUCTION_MAX_CERTIFICATES_PER_RUN,
    ),
  );
  const certificates: CertificateDestructionResult[] = [];
  for (const cert of approved) {
    const cls = retentionClassOf(cert.dataClass);
    if (!cls) continue; // not a class this module owns: never guess
    certificates.push(await destroyUnderCertificate(deps, orgId, runId, cert, cls, live));
  }
  const destroyed = certificates.reduce((n, c) => n + c.destroyed, 0);
  await auditIn(deps, orgId, runId, "m36.retention_destruction.run", runId, {
    runId,
    mode,
    destroyed,
    certificates,
  });
  return { runId, mode, destroyed, certificates };
}
