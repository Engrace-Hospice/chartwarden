import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
// apps/backend/src/modules/23-billing-medicare/clearinghouse-attempt-store.ts — the DURABLE `SubmissionAttemptStore`
// (ADR-0053 D4) over `clearinghouse_submission_attempt`. Every call opens its own org context from the attempt's
// organization id, so it works from any caller (a route, a relay tick, a worker) and RLS scopes it to one tenant.
//
// reserve   INSERT … ON CONFLICT DO NOTHING on the two live-unique indexes; when nothing is written the holder is read
//           back (key match preferred). Atomic, so concurrent reservations of one submission produce one writer.
// complete  reserved -> sent, idempotent on an already-sent row.
// release   reserved -> released (the key and number become free again). Never touches a sent row.
// retake    compare-and-set of `reserved_at`, so exactly one retry takes over an abandoned reservation.
import type { SubmissionAttempt, SubmissionAttemptStore } from "@wardenx/x12-837-client";
import { and, eq, ne, or } from "drizzle-orm";

const T = schema.clearinghouseSubmissionAttempts;

type Row = typeof T.$inferSelect;

function toAttempt(row: Row): SubmissionAttempt {
  return {
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    scope: row.scope,
    idempotencyKey: row.idempotencyKey,
    controlNumber: row.controlNumber,
    kind: row.kind,
    identity: row.identity,
    status: row.status,
    clearinghouseSubmissionId: row.clearinghouseSubmissionId,
    reservedAt: row.reservedAt.toISOString(),
    receivedAt: row.receivedAt ? row.receivedAt.toISOString() : null,
  };
}

export function createDrizzleAttemptStore(db: DbClient): SubmissionAttemptStore {
  const inOrg = <R>(organizationId: string, fn: (tx: DbClient) => Promise<R>): Promise<R> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as unknown as DbClient));

  const keyMatch = (organizationId: string, scope: string, key: string) =>
    and(
      eq(T.organizationId, organizationId),
      eq(T.scope, scope),
      eq(T.idempotencyKey, key),
      ne(T.status, "released"),
    );

  return {
    reserve(attempt) {
      return inOrg(attempt.organizationId, async (tx) => {
        const written = await tx
          .insert(T)
          .values({
            organizationId: attempt.organizationId,
            providerEntityId: attempt.providerEntityId,
            scope: attempt.scope,
            idempotencyKey: attempt.idempotencyKey,
            controlNumber: attempt.controlNumber,
            kind: attempt.kind,
            identity: attempt.identity,
            status: "reserved",
            reservedAt: new Date(attempt.reservedAt),
          })
          .onConflictDoNothing()
          .returning();
        if (written[0]) return { attempt: toAttempt(written[0]), reserved: true };
        const holders = await tx
          .select()
          .from(T)
          .where(
            and(
              eq(T.organizationId, attempt.organizationId),
              eq(T.scope, attempt.scope),
              ne(T.status, "released"),
              or(
                eq(T.idempotencyKey, attempt.idempotencyKey),
                eq(T.controlNumber, attempt.controlNumber),
              ),
            ),
          );
        const holder =
          holders.find((h) => h.idempotencyKey === attempt.idempotencyKey) ?? holders[0];
        if (!holder) {
          // The holder was released between the conflict and the read; the caller retries the reservation.
          throw new Error("clearinghouse_submission_attempt: conflicting row vanished");
        }
        return { attempt: toAttempt(holder), reserved: false };
      });
    },

    complete(organizationId, scope, idempotencyKey, clearinghouseSubmissionId, receivedAt) {
      return inOrg(organizationId, async (tx) => {
        const updated = await tx
          .update(T)
          .set({ status: "sent", clearinghouseSubmissionId, receivedAt: new Date(receivedAt) })
          .where(and(keyMatch(organizationId, scope, idempotencyKey), eq(T.status, "reserved")))
          .returning();
        if (updated[0]) return toAttempt(updated[0]);
        const [existing] = await tx
          .select()
          .from(T)
          .where(and(keyMatch(organizationId, scope, idempotencyKey), eq(T.status, "sent")))
          .limit(1);
        return existing ? toAttempt(existing) : null;
      });
    },

    async release(organizationId, scope, idempotencyKey) {
      await inOrg(organizationId, (tx) =>
        tx
          .update(T)
          .set({ status: "released" })
          .where(and(keyMatch(organizationId, scope, idempotencyKey), eq(T.status, "reserved"))),
      );
    },

    retake(organizationId, scope, idempotencyKey, expectedReservedAt, newReservedAt) {
      return inOrg(organizationId, async (tx) => {
        const updated = await tx
          .update(T)
          .set({ reservedAt: new Date(newReservedAt) })
          .where(
            and(
              keyMatch(organizationId, scope, idempotencyKey),
              eq(T.status, "reserved"),
              eq(T.reservedAt, new Date(expectedReservedAt)),
            ),
          )
          .returning({ id: T.id });
        return updated.length > 0;
      });
    },
  };
}
