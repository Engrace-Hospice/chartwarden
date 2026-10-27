import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
// apps/backend/src/modules/23-billing-medicare/clearinghouse-attempt-store.ts — the DURABLE `SubmissionAttemptStore`
// (ADR-0053 D4) over `clearinghouse_submission_attempt`. Every call opens its own org context from the attempt's
// organization id, so it works from any caller (a route, a relay tick, a worker) and RLS scopes it to one tenant.
//
// reserve   INSERT … ON CONFLICT DO NOTHING on the two live-unique indexes; when nothing is written the holder is read
//           back (key match preferred). Atomic, so concurrent reservations of one submission produce one writer. A
//           conflict no read can explain is another tenant's live control number (platform-wide unique index).
// find      the live attempt for a key.   allocateControlNumber  nextval of the per-usage platform sequence.
// allocateInterchangeNumber  the same sequence, remembered per (tenant, scope, key) so a redelivered job renders the same ISA13.
// complete  reserved -> sent, idempotent on an already-sent row.
// release   reserved -> released (the key and number become free again). Never touches a sent row.
// retake    compare-and-set of `reserved_at`, so exactly one retry takes over an abandoned reservation.
import {
  type AttemptUsage,
  type InterchangeMemo,
  PlatformControlNumberTaken,
  type SubmissionAttempt,
  type SubmissionAttemptStore,
} from "@chartwarden/x12-837-client";
import { and, eq, lte, ne, or, sql } from "drizzle-orm";

const T = schema.clearinghouseSubmissionAttempts;
const I = schema.clearinghouseInterchangeNumber;

/** How many times a reservation re-reads after a conflict whose holder vanished (released) before it is judged foreign. */
const RESERVE_ATTEMPTS = 3;

// Fixed names, never built from input.
const CONTROL_NUMBER_SEQUENCE: Record<AttemptUsage, ReturnType<typeof sql.raw>> = {
  test: sql.raw("clearinghouse_control_number_test_seq"),
  production: sql.raw("clearinghouse_control_number_production_seq"),
};

/** The next value of the platform-wide per-usage sequence, 9 digits. Sequences are not transactional: a drawn number is never given back. */
async function nextControlNumber(db: DbClient, usage: AttemptUsage): Promise<string> {
  let res: { rows: { n: string }[] };
  try {
    res = (await db.execute(
      sql`SELECT nextval('${CONTROL_NUMBER_SEQUENCE[usage]}'::regclass)::text AS n`,
    )) as unknown as { rows: { n: string }[] };
  } catch (e) {
    // 55000: the 9-digit space is used up. Say so plainly instead of surfacing a raw driver error.
    if (
      (e as { cause?: { code?: string }; code?: string }).cause?.code === "55000" ||
      (e as { code?: string }).code === "55000"
    ) {
      throw new Error(`clearinghouse control numbers are exhausted for ${usage} usage`);
    }
    throw e;
  }
  const n = res.rows[0]?.n;
  if (!n) throw new Error("clearinghouse control number allocation returned nothing");
  return n.padStart(9, "0");
}

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
                ne(T.status, "released"),
                or(
                  // The key is unique per scope and stays held when voided.
                  and(eq(T.scope, attempt.scope), eq(T.idempotencyKey, attempt.idempotencyKey)),
                  // A control number is unique per usage mode (any scope of this tenant) until released or voided.
                  and(
                    eq(T.usage, attempt.usage),
                    eq(T.controlNumber, attempt.controlNumber),
                    ne(T.status, "voided"),
                  ),
                ),
              ),
            );
          const holder =
            holders.find(
              (h) => h.scope === attempt.scope && h.idempotencyKey === attempt.idempotencyKey,
            ) ?? holders[0];
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

    allocateControlNumber(usage) {
      return nextControlNumber(db, usage);
    },

    allocateInterchangeNumber(organizationId, scope, idempotencyKey, usage) {
      return inOrg(organizationId, async (tx) => {
        const known = async (): Promise<InterchangeMemo | undefined> => {
          const [row] = await tx
            .select({ n: I.interchangeNumber, usage: I.usage, renderedAt: I.renderedAt })
            .from(I)
            .where(
              and(
                eq(I.organizationId, organizationId),
                eq(I.scope, scope),
                eq(I.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          // A key remembered under the other usage would mix the test and production number spaces.
          if (row && row.usage !== usage)
            throw new Error("clearinghouse interchange number was allocated under a different usage");
          return row && { number: String(row.n).padStart(9, "0"), renderedAt: row.renderedAt };
        };
        const existing = await known();
        if (existing) return existing;
        // Draw first, then try to bind it: a concurrent caller on the same key can win the insert, so this number is
        // dropped (a gap in the sequence is legal, a reused number is not) and the winner's is read back.
        const drawn = Number(await nextControlNumber(tx, usage));
        const [inserted] = await tx
          .insert(I)
          .values({ organizationId, scope, idempotencyKey, usage, interchangeNumber: drawn })
          .onConflictDoNothing()
          .returning({ n: I.interchangeNumber, renderedAt: I.renderedAt });
        const memo =
          (inserted && { number: String(inserted.n).padStart(9, "0"), renderedAt: inserted.renderedAt }) ??
          (await known());
        if (!memo) throw new Error("clearinghouse interchange number allocation returned nothing");
        return memo;
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

    resolve(organizationId, scope, idempotencyKey, outcome, actorUserId, guard) {
      // The operator's id is the acting user for this transaction, so the audit trigger records who decided.
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (raw) => {
        const tx = raw as unknown as DbClient;
        const [row] = await tx
          .update(T)
          .set(
            outcome.kind === "sent"
              ? {
                  status: "sent",
                  clearinghouseSubmissionId: outcome.clearinghouseSubmissionId,
                  receivedAt: new Date(outcome.receivedAt),
                }
              : { status: "voided" },
          )
          .where(
            and(
              keyMatch(organizationId, scope, idempotencyKey),
              eq(T.status, "reserved"),
              // Re-checked at the write: a sender that retook the row since the operator read it wins.
              lte(T.createdAt, new Date(guard.firstReservedBefore)),
              lte(T.reservedAt, new Date(guard.reservedBefore)),
            ),
          )
          .returning();
        return row ? toAttempt(row) : null;
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
