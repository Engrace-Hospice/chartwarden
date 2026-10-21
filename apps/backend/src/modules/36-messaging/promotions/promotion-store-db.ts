// apps/backend/src/modules/36-messaging/promotions/promotion-store-db.ts - WP 3.7: the `chart_promotion_request` rows.
//
// Writes take the caller's `tx` (the service owns the transaction and publishes the outbox event inside it). Every
// statement names the organization on top of RLS. `wardenx_app` may UPDATE only the outcome columns and has no DELETE; the
// partial unique index (one PROPOSED request per message and target) is the idempotency arbiter for insert, and the key
// is locked (`FOR UPDATE`) before a decision so two racing requests serialise and the loser replays the winner's row.
// There is no event table: the M4 audit trigger is the history.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { ChartPromotionReasonCode, ChartPromotionTargetModule } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const T = schema.chartPromotionRequests;

export type PromotionRow = typeof T.$inferSelect;

export const PROMOTION_LIST_DEFAULT_LIMIT = 50;
export const PROMOTION_LIST_MAX_LIMIT = 100;
export const PROMOTION_MESSAGE_LIST_MAX = 50;

export interface PromotionKey {
  readonly messageId: string;
  readonly targetModule: string;
  readonly targetKind: string;
}

export interface InsertPromotionArgs extends PromotionKey {
  readonly orgId: string;
  readonly channelId: string;
  readonly patientId: string;
  readonly suggestedTargetRef: string | null;
  readonly requestedByUserId: string;
  readonly sourceAuthorUserId: string;
  readonly sourceSentAt: Date;
  readonly sourceBodySha256: string;
}

export type PromotionListState = "active" | "closed" | "all";

export interface PromotionStore {
  /** Every request for the key, locked, oldest first. */
  lockKey(tx: Tx, orgId: string, key: PromotionKey): Promise<PromotionRow[]>;
  /** Null = the partial unique index refused it (a concurrent identical request won). */
  insertProposed(tx: Tx, a: InsertPromotionArgs): Promise<PromotionRow | null>;
  lockById(tx: Tx, orgId: string, id: string): Promise<PromotionRow | null>;
  /** Each of these returns null when the row is no longer in a state the move may start from. */
  supersede(tx: Tx, orgId: string, id: string): Promise<PromotionRow | null>;
  withdraw(tx: Tx, orgId: string, id: string): Promise<PromotionRow | null>;
  /**
   * Close every OTHER proposed request for the same message and target as superseded (the one just accepted already
   * carries the reviewer's signed record for that message). Returns how many rows were closed.
   */
  supersedeSiblings(tx: Tx, orgId: string, accepted: PromotionRow): Promise<number>;
  markAccepted(
    tx: Tx,
    orgId: string,
    id: string,
    a: { resultRef: string; decidedByUserId: string; at: Date },
  ): Promise<PromotionRow | null>;
  markRejected(
    tx: Tx,
    orgId: string,
    id: string,
    a: { reasonCode: ChartPromotionReasonCode; decidedByUserId: string; at: Date },
  ): Promise<PromotionRow | null>;

  get(orgId: string, id: string): Promise<PromotionRow | null>;
  listForMessage(orgId: string, messageId: string): Promise<PromotionRow[]>;
  listForRequester(
    orgId: string,
    userId: string,
    state: PromotionListState,
    limit: number,
  ): Promise<PromotionRow[]>;
  /** Proposed requests for the target module and these patients, newest first. */
  pendingForPatients(
    orgId: string,
    targetModule: ChartPromotionTargetModule,
    patientIds: readonly string[],
    limit: number,
  ): Promise<PromotionRow[]>;
}

export const clampPromotionLimit = (limit: number): number =>
  Math.min(
    Math.max(Math.trunc(limit) || PROMOTION_LIST_DEFAULT_LIMIT, 1),
    PROMOTION_LIST_MAX_LIMIT,
  );

const keyWhere = (orgId: string, k: PromotionKey) =>
  and(
    eq(T.organizationId, orgId),
    eq(T.messageId, k.messageId),
    eq(T.targetModule, k.targetModule),
    eq(T.targetKind, k.targetKind),
  );

export function createDbPromotionStore(db: DbClient): PromotionStore {
  const bump = { version: sql`${T.version} + 1` };
  return {
    async lockKey(tx, orgId, key) {
      return await tx
        .select()
        .from(T)
        .where(keyWhere(orgId, key))
        .orderBy(asc(T.requestedAt), asc(T.id))
        .for("update");
    },

    async insertProposed(tx, a) {
      const [row] = await tx
        .insert(T)
        .values({
          organizationId: a.orgId,
          messageId: a.messageId,
          channelId: a.channelId,
          patientId: a.patientId,
          targetModule: a.targetModule,
          targetKind: a.targetKind,
          suggestedTargetRef: a.suggestedTargetRef,
          requestedByUserId: a.requestedByUserId,
          sourceAuthorUserId: a.sourceAuthorUserId,
          sourceSentAt: a.sourceSentAt,
          sourceBodySha256: a.sourceBodySha256,
        })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },

    async lockById(tx, orgId, id) {
      const [row] = await tx
        .select()
        .from(T)
        .where(and(eq(T.organizationId, orgId), eq(T.id, id)))
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async supersede(tx, orgId, id) {
      const now = new Date();
      const [row] = await tx
        .update(T)
        .set({
          status: "superseded",
          reasonCode: "superseded",
          closedAt: now,
          updatedAt: now,
          ...bump,
        })
        .where(and(eq(T.organizationId, orgId), eq(T.id, id), eq(T.status, "proposed")))
        .returning();
      return row ?? null;
    },

    async supersedeSiblings(tx, orgId, accepted) {
      const now = new Date();
      const closed = await tx
        .update(T)
        .set({
          status: "superseded",
          reasonCode: "superseded",
          closedAt: now,
          updatedAt: now,
          ...bump,
        })
        .where(
          and(
            keyWhere(orgId, accepted),
            eq(T.status, "proposed"),
            eq(T.sourceBodySha256, accepted.sourceBodySha256),
            sql`${T.id} <> ${accepted.id}`,
          ),
        )
        .returning({ id: T.id });
      return closed.length;
    },

    async withdraw(tx, orgId, id) {
      const now = new Date();
      const [row] = await tx
        .update(T)
        .set({
          status: "withdrawn",
          reasonCode: "requester",
          closedAt: now,
          updatedAt: now,
          ...bump,
        })
        .where(and(eq(T.organizationId, orgId), eq(T.id, id), eq(T.status, "proposed")))
        .returning();
      return row ?? null;
    },

    async markAccepted(tx, orgId, id, a) {
      const [row] = await tx
        .update(T)
        .set({
          status: "accepted",
          resultRef: a.resultRef,
          decidedByUserId: a.decidedByUserId,
          decidedAt: a.at,
          reasonCode: null,
          // proposed -> accepted closes it now; a withdrawn or superseded row keeps the instant it closed.
          closedAt: sql`coalesce(${T.closedAt}, ${a.at.toISOString()}::timestamptz)`,
          updatedAt: a.at,
          ...bump,
        })
        .where(
          and(
            eq(T.organizationId, orgId),
            eq(T.id, id),
            inArray(T.status, ["proposed", "withdrawn", "superseded"]),
          ),
        )
        .returning();
      return row ?? null;
    },

    async markRejected(tx, orgId, id, a) {
      const [row] = await tx
        .update(T)
        .set({
          status: "rejected",
          reasonCode: a.reasonCode,
          decidedByUserId: a.decidedByUserId,
          decidedAt: a.at,
          closedAt: a.at,
          updatedAt: a.at,
          ...bump,
        })
        .where(and(eq(T.organizationId, orgId), eq(T.id, id), eq(T.status, "proposed")))
        .returning();
      return row ?? null;
    },

    get: (orgId, id) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(T)
          .where(and(eq(T.organizationId, orgId), eq(T.id, id)))
          .limit(1);
        return row ?? null;
      }),

    listForMessage: (orgId, messageId) =>
      withOrgContext(db, systemOrgContext(orgId), (tx) =>
        tx
          .select()
          .from(T)
          .where(and(eq(T.organizationId, orgId), eq(T.messageId, messageId)))
          .orderBy(desc(T.requestedAt), asc(T.id))
          .limit(PROMOTION_MESSAGE_LIST_MAX),
      ),

    listForRequester: (orgId, userId, state, limit) =>
      withOrgContext(db, { organizationId: orgId, userId }, (tx) =>
        tx
          .select()
          .from(T)
          .where(
            and(
              eq(T.organizationId, orgId),
              eq(T.requestedByUserId, userId),
              state === "active"
                ? eq(T.status, "proposed")
                : state === "closed"
                  ? inArray(T.status, ["accepted", "rejected", "superseded", "withdrawn"])
                  : undefined,
            ),
          )
          .orderBy(desc(T.requestedAt), asc(T.id))
          .limit(clampPromotionLimit(limit)),
      ),

    pendingForPatients: (orgId, targetModule, patientIds, limit) =>
      patientIds.length === 0
        ? Promise.resolve([])
        : withOrgContext(db, systemOrgContext(orgId), (tx) =>
            tx
              .select()
              .from(T)
              .where(
                and(
                  eq(T.organizationId, orgId),
                  eq(T.targetModule, targetModule),
                  eq(T.status, "proposed"),
                  inArray(T.patientId, [...patientIds]),
                ),
              )
              .orderBy(desc(T.requestedAt), asc(T.id))
              .limit(clampPromotionLimit(limit)),
          ),
  };
}
