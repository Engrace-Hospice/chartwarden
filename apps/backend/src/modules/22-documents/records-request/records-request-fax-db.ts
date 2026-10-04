// apps/backend/src/modules/22-documents/records-request/records-request-fax-db.ts — the production, RLS-backed
// RecordsRequestFaxStore (F-238, migration 0315). Every read and write runs under `withOrgContext` (FORCEd
// RLS on `intake_records_request_fax`); writes carry the acting user so the M4 audit trigger attributes them.
// The partial unique index `intake_records_request_fax_one_live_uq` is the idempotency wall: two concurrent
// sends of one request cannot both insert a `sending` row — the loser re-reads and gets `existing`.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  FAX_INTERRUPTED_REASON,
  FAX_SENDING_STALE_AFTER_MS,
  type RecordsRequestFaxStatus,
  type RecordsRequestFaxStore,
  type RecordsRequestFaxView,
  clampReason,
} from "./records-request-fax";
import type { RecordsRequestActor } from "./records-request-service";

const FAX = schema.intakeRecordsRequestFaxes;
type Row = typeof FAX.$inferSelect;

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

const project = (r: Row): RecordsRequestFaxView => ({
  id: r.id,
  recordsRequestId: r.recordsRequestId,
  faxNumber: r.faxNumber,
  status: r.status as RecordsRequestFaxStatus,
  provider: r.provider,
  providerMessageId: r.providerMessageId,
  pageCount: r.pageCount,
  failureReason: r.failureReason,
  attemptedAt: iso(r.attemptedAt) as string,
  sentAt: iso(r.sentAt),
  failedAt: iso(r.failedAt),
});

const isLiveCollision = (err: unknown): boolean => {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint ?? e?.cause?.constraint;
  return (
    code === "23505" &&
    (constraint === undefined || constraint === "intake_records_request_fax_one_live_uq")
  );
};

export function createDbRecordsRequestFaxStore(
  db: DbClient,
  opts: { now?: () => Date } = {},
): RecordsRequestFaxStore {
  const now = opts.now ?? (() => new Date());
  const write = <T>(
    organizationId: string,
    actor: RecordsRequestActor,
    fn: (tx: DbClient) => Promise<T>,
  ) => withOrgContext(db, { organizationId, userId: actor.userId }, (tx) => fn(tx as DbClient));

  return {
    async begin(organizationId, actor, input) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await write(organizationId, actor, async (tx) => {
            const [live] = await tx
              .select()
              .from(FAX)
              .where(
                and(
                  eq(FAX.recordsRequestId, input.recordsRequestId),
                  inArray(FAX.status, ["sending", "sent"]),
                ),
              )
              .limit(1)
              .for("update");
            if (live) {
              const stale =
                live.status === "sending" &&
                now().getTime() - new Date(live.attemptedAt).getTime() > FAX_SENDING_STALE_AFTER_MS;
              if (!stale) return { kind: "existing" as const, attempt: project(live) };
              const at = now();
              await tx
                .update(FAX)
                .set({
                  status: "failed",
                  failureReason: FAX_INTERRUPTED_REASON,
                  failedAt: at,
                  updatedAt: at,
                })
                .where(and(eq(FAX.id, live.id), eq(FAX.status, "sending")));
            }
            const [r] = await tx
              .insert(FAX)
              .values({
                organizationId,
                patientId: input.patientId,
                recordsRequestId: input.recordsRequestId,
                referralId: input.referralId,
                faxNumber: input.faxNumber,
                status: "sending",
                provider: input.provider,
                pageCount: input.pageCount,
                documentSha256: input.documentSha256,
                sentByMembershipId: actor.membershipId,
                attemptedAt: now(),
                correlationId: randomUUID(),
              })
              .returning();
            if (!r) throw new Error("intake_records_request_fax insert returned no row");
            return { kind: "started" as const, attempt: project(r) };
          });
        } catch (err) {
          // Lost the race to a concurrent send of the same request: re-read (it is now `existing`).
          if (attempt < 2 && isLiveCollision(err)) continue;
          throw err;
        }
      }
    },
    async settle(organizationId, actor, attemptId, result) {
      return write(organizationId, actor, async (tx) => {
        const at = now();
        const [u] = await tx
          .update(FAX)
          .set(
            result.ok
              ? {
                  status: "sent",
                  providerMessageId: result.providerMessageId,
                  sentAt: at,
                  updatedAt: at,
                }
              : {
                  status: "failed",
                  failureReason: clampReason(result.reason),
                  failedAt: at,
                  updatedAt: at,
                },
          )
          .where(and(eq(FAX.id, attemptId), eq(FAX.status, "sending")))
          .returning();
        if (u) return project(u);
        // Already settled (e.g. a stale-sweep raced us): report what is recorded.
        const [r] = await tx.select().from(FAX).where(eq(FAX.id, attemptId)).limit(1);
        if (!r) throw new NotFoundError("records_request_fax");
        return project(r);
      });
    },
    async latestForRequests(organizationId, requestIds) {
      const out = new Map<string, RecordsRequestFaxView>();
      if (requestIds.length === 0) return out;
      return withOrgContext(db, { organizationId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const rows = await tx
          .select()
          .from(FAX)
          .where(inArray(FAX.recordsRequestId, [...requestIds]))
          .orderBy(desc(FAX.attemptedAt), desc(FAX.id))
          .limit(1000);
        for (const r of rows)
          if (!out.has(r.recordsRequestId)) out.set(r.recordsRequestId, project(r));
        return out;
      });
    },
  };
}
