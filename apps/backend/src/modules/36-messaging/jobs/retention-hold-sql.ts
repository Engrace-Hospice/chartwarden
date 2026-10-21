import { type DbClient, schema } from "@chartwarden/db";
// apps/backend/src/modules/36-messaging/jobs/retention-hold-sql.ts — ADR-0086 (proposed) D5 in SQL: the LIVE hold predicate the
// retention scan filters with (so enforcement never waits on the overlay) and the overlay materialiser. The predicate mirrors the pure
// `messageHeldBy` in @chartwarden/messaging; the live suite proves the two agree. Aliases: m = message, c = its channel.
// Every subquery is filtered by organization_id. Ids reach SQL only as bound uuid params.
import type { MessageHoldCriteria } from "@chartwarden/messaging";
import { messagingHoldLockName } from "@chartwarden/types";
import { type SQL, and, eq, sql } from "drizzle-orm";

/** The M4 seam the scan needs, injected at the composition root (M36 imports nothing from M4). */
export interface ActiveMessageHold {
  readonly id: string;
  readonly criteria: MessageHoldCriteria;
}

/** A pending M4 destruction certificate for one message class and month (ids and counts only). */
export interface MessageCertificateRequest {
  readonly organizationId: string;
  readonly dataClass: string;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly recordCount: number;
}

/** M4's published message-hold seam, bound at the composition root (apps/backend/src/index.ts); both calls run in the scan's tenant tx. */
export interface MessageHoldPort {
  activeHolds(tx: DbClient, organizationId: string): Promise<readonly ActiveMessageHold[]>;
  openCertificate(
    tx: DbClient,
    request: MessageCertificateRequest,
  ): Promise<{ readonly id: string; readonly created: boolean }>;
}

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  );
const nonEmpty = (a: readonly string[] | undefined): a is readonly string[] => (a?.length ?? 0) > 0;

/** SQL boolean: does this hold's criteria cover message `m` (joined to channel `c`)? Mirrors `messageHeldBy`. */
export function holdPredicate(criteria: MessageHoldCriteria): SQL {
  const { patientIds, channelIds, userIds, dateRange } = criteria;
  const parts: SQL[] = [];
  if (nonEmpty(patientIds)) {
    parts.push(sql`(
      (c.channel_kind = 'care_team' AND c.subject_id IN (${uuidList(patientIds)}))
      OR c.channel_kind = 'bereavement'
      OR EXISTS (SELECT 1 FROM message_entity_reference r
                  WHERE r.organization_id = m.organization_id AND r.message_id = m.id
                    AND r.reference_kind = 'patient' AND r.entity_id IN (${uuidList(patientIds)})))`);
  }
  if (nonEmpty(channelIds)) parts.push(sql`m.channel_id IN (${uuidList(channelIds)})`);
  if (nonEmpty(userIds)) {
    parts.push(sql`(
      m.author_user_id IN (${uuidList(userIds)})
      OR EXISTS (SELECT 1 FROM channel_member cm
                  WHERE cm.organization_id = m.organization_id AND cm.channel_id = m.channel_id
                    AND cm.user_id IN (${uuidList(userIds)})))`);
  }
  const selector = parts.length === 0 ? sql`true` : sql`(${sql.join(parts, sql` OR `)})`;
  return dateRange
    ? sql`(${selector} AND m.created_at >= ${dateRange.from}::timestamptz AND m.created_at <= ${dateRange.to}::timestamptz)`
    : selector;
}

/** SQL boolean: any of `holds` covers `m`; `false` when there are none. */
export function anyHoldPredicate(holds: readonly ActiveMessageHold[]): SQL {
  if (holds.length === 0) return sql`false`;
  return sql`(${sql.join(
    holds.map((h) => holdPredicate(h.criteria)),
    sql` OR `,
  )})`;
}

/** SQL boolean: an overlay row ties `m` to one of the ACTIVE `holds` (the cheap, indexed half of the filter). */
export function overlayHeldPredicate(holds: readonly ActiveMessageHold[]): SQL {
  if (holds.length === 0) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM legal_hold_message l
    WHERE l.organization_id = m.organization_id AND l.message_id = m.id
      AND l.legal_hold_id IN (${uuidList(holds.map((h) => h.id))}))`;
}

/** The org's ACTIVE holds with their live criteria (read in the caller's tenant tx; org-filtered in addition to RLS). */
export async function activeLiveHolds(
  tx: DbClient,
  organizationId: string,
): Promise<readonly ActiveMessageHold[]> {
  const active = await tx
    .select({ id: schema.legalHolds.id, criteria: schema.legalHolds.criteria })
    .from(schema.legalHolds)
    .where(
      and(
        eq(schema.legalHolds.organizationId, organizationId),
        eq(schema.legalHolds.status, "active"),
      ),
    );
  return active.map((h) => ({ id: h.id, criteria: h.criteria as MessageHoldCriteria }));
}

/**
 * SQL boolean over an attachment-style outer row: its message `messageIdExpr` (in org `orgIdExpr`) is covered by one of `holds`
 * (live criteria, so it also covers messages the overlay has not materialised yet). `false` when there are no holds.
 */
export function messageHeldByAnyPredicate(
  holds: readonly ActiveMessageHold[],
  orgIdExpr: SQL,
  messageIdExpr: SQL,
): SQL {
  if (holds.length === 0) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM message m JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
    WHERE m.organization_id = ${orgIdExpr} AND m.id = ${messageIdExpr} AND ${anyHoldPredicate(holds)})`;
}

/**
 * Is message `messageId` covered by an ACTIVE hold right now, judged on the live criteria (not the overlay, which lags until the next
 * scan)? Runs in the caller's tenant transaction; org-filtered in addition to RLS. The overlay trigger (migration 1138) stays the
 * backstop for the materialised case.
 */
export async function isMessageHeldNow(
  tx: DbClient,
  organizationId: string,
  messageId: string,
): Promise<boolean> {
  // Shared: edits do not block each other, but a hold apply (exclusive) waits for this edit's commit, so a hold placed mid-edit cannot slip past the check.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${messagingHoldLockName(organizationId)}, 0))`,
  );
  const holds = await activeLiveHolds(tx, organizationId);
  if (holds.length === 0) return false;
  const res = await tx.execute<{ held: boolean }>(
    sql`SELECT true AS held FROM message m JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
         WHERE m.organization_id = ${organizationId}::uuid AND m.id = ${messageId}::uuid AND ${anyHoldPredicate(holds)}
         LIMIT 1`,
  );
  return res.rows.length > 0;
}

/** Messages a hold has materialised in the overlay (the count M4's own release route reports for a governance-origin hold). */
export async function countHoldOverlayMessages(
  tx: DbClient,
  organizationId: string,
  holdId: string,
): Promise<number> {
  const res = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM legal_hold_message
         WHERE organization_id = ${organizationId}::uuid AND legal_hold_id = ${holdId}::uuid`,
  );
  return Number(res.rows[0]?.n ?? 0);
}
