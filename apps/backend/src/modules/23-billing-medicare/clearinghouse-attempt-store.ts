import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
// apps/backend/src/modules/23-billing-medicare/clearinghouse-attempt-store.ts — the DURABLE `SubmissionAttemptStore`
// (ADR-0053 D4) over `clearinghouse_submission_attempt`. Every call opens its own org context from the attempt's
// organization id, so it works from any caller (a route, a relay tick, a worker) and RLS scopes it to one tenant.
//
// reserve   INSERT … ON CONFLICT DO NOTHING on the two live-unique indexes; when nothing is written the holder is read
//           back (key match preferred). Atomic, so concurrent reservations of one submission produce one writer. A
//           conflict no read can explain is another tenant's live control number (platform-wide unique index).
// find      the live attempt for a key.   allocateControlNumber  nextval of the per-usage platform sequence.
// complete  reserved -> sent, idempotent on an already-sent row.
// release   reserved -> released (the key and number become free again). Never touches a sent row.
// retake    compare-and-set of `reserved_at`, so exactly one retry takes over an abandoned reservation.
import {
  type AttemptUsage,
  PlatformControlNumberTaken,
  type SubmissionAttempt,
  type SubmissionAttemptStore,
} from "@wardenx/x12-837-client";
import { and, eq, ne, or, sql } from "drizzle-orm";

const T = schema.clearinghouseSubmissionAttempts;

/** How many times a reservation re-reads after a conflict whose holder vanished (released) before it is judged foreign. */
const RESERVE_ATTEMPTS = 3;

// Fixed names, never built from input.
const CONTROL_NUMBER_SEQUENCE: Record<AttemptUsage, ReturnType<typeof sql.raw>> = {
  test: sql.raw("clearinghouse_control_number_test_seq"),
  production: sql.raw("clearinghouse_control_number_production_seq"),
};

type Row = typeof T.$inferSelect;

function toAttempt(row: Row): SubmissionAttempt {
  return {
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    scope: row.scope,
    usage: row.usage,
    idempotencyKey: row.idempotencyKey,
    controlNumber: row.controlNumber,
    kind: row.kind,
    identity: row.identity,
    status: row.status,
    clearinghouseSubmissionId: row.clearinghouseSubmissionId,
    firstReservedAt: row.createdAt.toISOString(),
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
        // Under READ COMMITTED each statement sees a fresh snapshot, so a holder released between the conflict and the
        // read is gone by the next insert. Only a conflict that stays invisible to this tenant is another tenant's.
        for (let i = 0; i < RESERVE_ATTEMPTS; i += 1) {
          const written = await tx
            .insert(T)
            .values({
              organizationId: attempt.organizationId,
              providerEntityId: attempt.providerEntityId,
              scope: attempt.scope,
              usage: attempt.usage,
              idempotencyKey: attempt.idempotencyKey,
              controlNumber: attempt.controlNumber,
              kind: attempt.kind,
              identity: attempt.identity,
              status: "reserved",
              reservedAt: new Date(attempt.reservedAt),
              createdAt: new Date(attempt.firstReservedAt),
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
          if (holder) return { attempt: toAttempt(holder), reserved: false };
        }
        throw new PlatformControlNumberTaken();
      });
    },

    find(organizationId, scope, idempotencyKey) {
      return inOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(T)
          .where(keyMatch(organizationId, scope, idempotencyKey))
          .limit(1);
        return row ? toAttempt(row) : null;
      });
    },

    async allocateControlNumber(usage) {
      const res = (await db.execute(
        sql`SELECT nextval('${CONTROL_NUMBER_SEQUENCE[usage]}'::regclass)::text AS n`,
      )) as unknown as { rows: { n: string }[] };
      const n = res.rows[0]?.n;
      if (!n) throw new Error("clearinghouse control number allocation returned nothing");
      return n.padStart(9, "0");
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
