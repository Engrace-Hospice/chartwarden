// apps/backend/src/modules/36-messaging/jobs/retention-scan.ts — `messaging.retention_scan` (M36-F10), ADR-0086 (proposed) / WP 5.6 S3.
//
// PLAN ONLY: it deletes nothing. Per org and run it (1) materialises the legal-hold overlay for every active hold in bounded,
// idempotent batches, (2) lists eligible messages per class with held rows excluded IN SQL before the LIMIT (so held rows can never
// crowd eligible ones out, defect 3), (3) counts held rows per class and per hold, (4) opens one pending M4 certificate per class per
// month, and (5) records one `m36.retention_scan.run` audit row (ids and counts only). ENFORCEMENT never depends on step 1: the exclusion
// is the overlay (cheap) OR the live criteria predicate, so a message the overlay has not reached yet is still withheld.
import { randomUUID } from "node:crypto";
import { type AuditExecutor, audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { MESSAGE_RETENTION_CLASSES, type MessageRetentionClass } from "@chartwarden/types";
import { type SQL, sql } from "drizzle-orm";
import {
  type ActiveMessageHold,
  HAS_PENDING_OBJECT,
  IS_REFERENCED,
  type MessageHoldPort,
  anyHoldPredicate,
  holdPredicate,
  overlayHeldPredicate,
} from "./retention-hold-sql";

/** Candidates reported per class per weekly scan. */
export const RETENTION_SCAN_BATCH_LIMIT = 5000;
/** Overlay rows inserted per statement, and statements per hold per scan (the rest resumes next run). */
export const MATERIALISE_BATCH_SIZE = 5000;
export const MATERIALISE_MAX_BATCHES_PER_HOLD = 20;

/** Years a message is retained, by channel retention class. care_related/bereavement follow ADR-0004 (7y). */
// ponytail: `operational` (announcements) is provisional until ADR-0086 is accepted.
export const MESSAGE_RETENTION_YEARS: Record<MessageRetentionClass, number> = {
  care_related: 7,
  bereavement: 7,
  operational: 1,
};

export interface RetentionScanDeps {
  readonly db: DbClient;
  readonly messageHolds: MessageHoldPort;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
  /** Overlay statements per hold per run. Defaults to {@link MATERIALISE_MAX_BATCHES_PER_HOLD}; 0 simulates a lagging materialiser (tests). */
  readonly materialiseMaxBatches?: number;
  /**
   * WP 5.6: true when the tenant has `messaging.retention_attachment_destruction` on. Then a message whose attachment objects are still
   * stored counts toward the certificate's approved figure (the executor destroys the objects before deleting it). Absent = off = such
   * messages are not counted (they are kept). Never read inside the scan's transaction.
   */
  readonly attachmentObjectsEnabled?: (organizationId: string) => Promise<boolean>;
}

export interface RetentionScanRunResult {
  readonly runId: string;
  /** toDestroy + skippedLegalHold: every past-window message the scan considered (the eligible list is capped per class). */
  readonly candidates: number;
  readonly toDestroy: number;
  readonly skippedLegalHold: number;
  /** Ids the plan would destroy; the scan itself deletes nothing. */
  readonly toDestroyMessageIds: readonly string[];
  readonly eligibleByClass: Readonly<Record<MessageRetentionClass, number>>;
  readonly heldByClass: Readonly<Record<MessageRetentionClass, number>>;
  /** True when some class had more eligible rows than {@link RETENTION_SCAN_BATCH_LIMIT} (the rest wait for the next run). */
  readonly capped: boolean;
  readonly heldByHold: readonly { readonly holdId: string; readonly held: number }[];
  readonly materialised: number;
  readonly certificates: readonly {
    readonly dataClass: string;
    readonly certificateId: string;
    readonly created: boolean;
  }[];
}

export function windowEnd(now: Date, years: number): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

export const FROM_MESSAGE = sql`FROM message m JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id`;

/** Past-window rows of one class in one org (the base every query narrows). */
export const pastWindow = (orgId: string, cls: string, end: Date): SQL =>
  sql`m.organization_id = ${orgId}::uuid AND c.retention_class = ${cls} AND m.created_at < ${end.toISOString()}::timestamptz`;

async function rowsOf<T extends Record<string, unknown>>(tx: DbClient, query: SQL): Promise<T[]> {
  return (await tx.execute<T>(query)).rows as T[];
}

export async function count(tx: DbClient, where: SQL): Promise<number> {
  const [row] = await rowsOf<{ n: number }>(
    tx,
    sql`SELECT count(*)::int AS n ${FROM_MESSAGE} WHERE ${where}`,
  );
  return Number(row?.n ?? 0);
}

/**
 * Materialised overlay rows per hold, in ONE grouped query over `legal_hold_message` (unique index leads with legal_hold_id). Holds with
 * no rows are absent from the map. This is the cheap list-screen count: it may lag the live criteria until the next scan.
 */
export async function overlayCountsByHold(
  tx: DbClient,
  orgId: string,
  holdIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (holdIds.length === 0) return new Map();
  const rows = await rowsOf<{ legal_hold_id: string; n: number }>(
    tx,
    sql`SELECT legal_hold_id, count(*)::int AS n FROM legal_hold_message
         WHERE organization_id = ${orgId}::uuid
           AND legal_hold_id IN (${sql.join(
             holdIds.map((i) => sql`${i}::uuid`),
             sql`, `,
           )})
         GROUP BY legal_hold_id`,
  );
  return new Map(rows.map((r) => [r.legal_hold_id, Number(r.n)]));
}

/** Insert missing overlay rows for one hold, bounded; returns rows inserted. Org-explicit and idempotent (ON CONFLICT DO NOTHING). */
export async function materialiseHold(
  tx: DbClient,
  orgId: string,
  hold: ActiveMessageHold,
  maxBatches: number,
): Promise<number> {
  let inserted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await rowsOf<{ id: string }>(
      tx,
      sql`INSERT INTO legal_hold_message (organization_id, legal_hold_id, message_id)
          SELECT m.organization_id, ${hold.id}::uuid, m.id ${FROM_MESSAGE}
           WHERE m.organization_id = ${orgId}::uuid AND ${holdPredicate(hold.criteria)}
             AND NOT EXISTS (SELECT 1 FROM legal_hold_message l
                              WHERE l.organization_id = m.organization_id
                                AND l.legal_hold_id = ${hold.id}::uuid AND l.message_id = m.id)
           LIMIT ${MATERIALISE_BATCH_SIZE}
          ON CONFLICT DO NOTHING RETURNING id`,
    );
    inserted += rows.length;
    if (rows.length < MATERIALISE_BATCH_SIZE) break;
  }
  return inserted;
}

const zeroByClass = (): Record<MessageRetentionClass, number> => ({
  care_related: 0,
  bereavement: 0,
  operational: 0,
});

/** One org's weekly retention scan: plan only, hold-aware, recorded as one `m36.retention_scan.run` row. */
export async function runRetentionScanForOrg(
  deps: RetentionScanDeps,
  orgId: string,
): Promise<RetentionScanRunResult> {
  const runId = (deps.newRunId ?? randomUUID)();
  const now = (deps.now ?? (() => new Date()))();
  const objectsOn = deps.attachmentObjectsEnabled
    ? await deps.attachmentObjectsEnabled(orgId)
    : false;
  const pendingObjectClause = objectsOn ? sql`TRUE` : sql`NOT ${HAS_PENDING_OBJECT}`;
  return withOrgContext(deps.db, systemOrgContext(orgId), async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    const holds = await deps.messageHolds.activeHolds(tx, orgId);
    let materialised = 0;
    for (const hold of holds)
      materialised += await materialiseHold(
        tx,
        orgId,
        hold,
        deps.materialiseMaxBatches ?? MATERIALISE_MAX_BATCHES_PER_HOLD,
      );

    const heldNow = sql`(${overlayHeldPredicate(holds)} OR ${anyHoldPredicate(holds)})`;
    const eligibleByClass = zeroByClass();
    // The EXACT number the destruction executor could remove for a class (held and still-referenced rows excluded, and object-bearing ones unless the attachment-destruction flag is on; NOT capped
    // like the id list). It is the approver's number and the executor's ceiling: the plan list is capped at RETENTION_SCAN_BATCH_LIMIT, this is not.
    const destroyableByClass = zeroByClass();
    const heldByClass = zeroByClass();
    const heldCounts = new Map<string, number>(holds.map((h) => [h.id, 0]));
    const toDestroyMessageIds: string[] = [];
    let capped = false;
    for (const cls of MESSAGE_RETENTION_CLASSES) {
      const end = windowEnd(now, MESSAGE_RETENTION_YEARS[cls]);
      const base = pastWindow(orgId, cls, end);
      // The hold exclusion sits in the WHERE, ahead of the LIMIT; one extra row detects the cap.
      const rows = await rowsOf<{ id: string }>(
        tx,
        sql`SELECT m.id ${FROM_MESSAGE} WHERE ${base} AND NOT ${heldNow}
            ORDER BY m.created_at, m.id LIMIT ${RETENTION_SCAN_BATCH_LIMIT + 1}`,
      );
      if (rows.length > RETENTION_SCAN_BATCH_LIMIT) capped = true;
      const page = rows.slice(0, RETENTION_SCAN_BATCH_LIMIT);
      eligibleByClass[cls] = page.length;
      destroyableByClass[cls] = await count(
        tx,
        sql`${base} AND NOT ${heldNow} AND ${pendingObjectClause} AND NOT ${IS_REFERENCED}`,
      );
      toDestroyMessageIds.push(...page.map((r) => r.id));
      if (holds.length === 0) continue;
      heldByClass[cls] = await count(tx, sql`${base} AND ${heldNow}`);
      for (const h of holds) {
        const held = await count(tx, sql`${base} AND ${holdPredicate(h.criteria)}`);
        heldCounts.set(h.id, (heldCounts.get(h.id) ?? 0) + held);
      }
    }

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const certificates: { dataClass: string; certificateId: string; created: boolean }[] = [];
    for (const cls of MESSAGE_RETENTION_CLASSES) {
      if (destroyableByClass[cls] === 0) continue;
      const dataClass = `message.${cls}`;
      const cert = await deps.messageHolds.openCertificate(tx, {
        organizationId: orgId,
        dataClass,
        rangeStart: monthStart,
        rangeEnd: monthEnd,
        recordCount: destroyableByClass[cls],
      });
      certificates.push({ dataClass, certificateId: cert.id, created: cert.created });
    }

    const toDestroy = toDestroyMessageIds.length;
    const skippedLegalHold = MESSAGE_RETENTION_CLASSES.reduce((n, c) => n + heldByClass[c], 0);
    const heldByHold = holds.map((h) => ({ holdId: h.id, held: heldCounts.get(h.id) ?? 0 }));
    const result: RetentionScanRunResult = {
      runId,
      candidates: toDestroy + skippedLegalHold,
      toDestroy,
      skippedLegalHold,
      toDestroyMessageIds,
      eligibleByClass,
      heldByClass,
      capped,
      heldByHold,
      materialised,
      certificates,
    };
    await audit(
      tx as unknown as AuditExecutor,
      { organizationId: orgId, userId: null, actorKind: "system" as const, correlationId: runId },
      {
        eventType: "m36.retention_scan.run",
        resourceKind: "message_retention_run",
        resourceId: runId,
        outcome: "success",
        context: {
          runId,
          candidates: result.candidates,
          toDestroy,
          skippedLegalHold,
          eligibleByClass,
          heldByClass,
          capped,
          heldByHold,
          materialised,
          certificates,
        },
      },
    );
    return result;
  });
}
