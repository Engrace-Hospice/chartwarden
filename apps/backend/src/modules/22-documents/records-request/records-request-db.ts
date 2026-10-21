import { randomUUID } from "node:crypto";
// apps/backend/src/modules/22-documents/records-request/records-request-db.ts — the production, RLS-backed
// RecordsRequestService (F-238). Every read and write runs under `withOrgContext` (FORCEd RLS on
// `intake_records_request`); writes carry the acting user so the M4 audit trigger attributes them.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError } from "@chartwarden/types";
import { and, count, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import {
  RECORDS_REQUEST_EXTENDABLE,
  type RecordsRequestActor,
  type RecordsRequestKind,
  type RecordsRequestService,
  type RecordsRequestStatus,
  type RecordsRequestView,
  cancelledRequest,
  defaultExpiresOn,
  isOverdue,
  newRecordsRequestCode,
  notCancellable,
  notExtendable,
  receivedAfterExpiry,
  validateCreateInput,
  validateExtendInput,
} from "./records-request-service";

const RR = schema.intakeRecordsRequests;
const BATCH = schema.intakeUploadBatches;
type Row = typeof RR.$inferSelect;

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);
/** Postgres `date` arrives as "yyyy-mm-dd" (drizzle string mode) — keep it as a calendar date. */
const day = (v: string | null): string | null => (v === null ? null : String(v).slice(0, 10));

const project = (r: Row, batches: number, today: string): RecordsRequestView => ({
  id: r.id,
  referralId: r.referralId,
  patientId: r.patientId,
  requestCode: r.requestCode,
  recipientName: r.recipientName,
  recipientOrganization: r.recipientOrganization,
  recipientFax: r.recipientFax,
  recipientEmail: r.recipientEmail,
  recordsRequested: (Array.isArray(r.recordsRequested)
    ? r.recordsRequested
    : []) as RecordsRequestKind[],
  recordsRequestedNote: r.recordsRequestedNote,
  dateRangeStart: day(r.dateRangeStart),
  dateRangeEnd: day(r.dateRangeEnd),
  status: r.status as RecordsRequestStatus,
  dueDate: day(r.dueDate),
  overdue: isOverdue(r.status as RecordsRequestStatus, day(r.dueDate), today),
  expiresOn: day(r.expiresOn),
  expiredAt: iso(r.expiredAt),
  receivedAfterExpiry: receivedAfterExpiry(iso(r.receivedAt), iso(r.expiredAt)),
  requestedByMembershipId: r.requestedByMembershipId,
  requestedAt: iso(r.requestedAt) as string,
  receivedAt: iso(r.receivedAt),
  cancelledAt: iso(r.cancelledAt),
  batches,
});

/** Unique-violation on the per-org code index → retry with a fresh code. */
const isCodeCollision = (err: unknown): boolean => {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint ?? e?.cause?.constraint;
  return (
    code === "23505" &&
    (constraint === undefined || constraint === "intake_records_request_org_code_uq")
  );
};

export function createDbRecordsRequestService(
  db: DbClient,
  opts: { now?: () => Date; code?: () => string } = {},
): RecordsRequestService {
  const now = opts.now ?? (() => new Date());
  const code = opts.code ?? newRecordsRequestCode;
  const today = () => now().toISOString().slice(0, 10);
  const read = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>) =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as DbClient));
  const write = <T>(
    organizationId: string,
    actor: RecordsRequestActor,
    fn: (tx: DbClient) => Promise<T>,
  ) => withOrgContext(db, { organizationId, userId: actor.userId }, (tx) => fn(tx as DbClient));

  async function batchCounts(tx: DbClient, ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: BATCH.recordsRequestId, n: count() })
      .from(BATCH)
      .where(inArray(BATCH.recordsRequestId, [...ids]))
      .groupBy(BATCH.recordsRequestId);
    return new Map(rows.map((r) => [r.id as string, Number(r.n)]));
  }
  async function loadOne(tx: DbClient, referralId: string, id: string): Promise<Row> {
    const [r] = await tx
      .select()
      .from(RR)
      .where(and(eq(RR.id, id), eq(RR.referralId, referralId)))
      .limit(1);
    if (!r) throw new NotFoundError("records_request");
    return r;
  }
  async function view(tx: DbClient, r: Row): Promise<RecordsRequestView> {
    return project(r, (await batchCounts(tx, [r.id])).get(r.id) ?? 0, today());
  }

  return {
    async create(organizationId, actor, target, input) {
      validateCreateInput(input);
      for (let attempt = 0; ; attempt++) {
        try {
          return await write(organizationId, actor, async (tx) => {
            const [r] = await tx
              .insert(RR)
              .values({
                organizationId,
                patientId: target.patientId,
                referralId: target.referralId,
                requestCode: code(),
                recipientName: input.recipientName.trim(),
                recipientOrganization: input.recipientOrganization?.trim() || null,
                recipientFax: input.recipientFax?.trim() || null,
                recipientEmail: input.recipientEmail?.trim() || null,
                recordsRequested: [...input.recordsRequested],
                recordsRequestedNote: input.recordsRequestedNote?.trim() || null,
                dateRangeStart: input.dateRangeStart ?? null,
                dateRangeEnd: input.dateRangeEnd ?? null,
                dueDate: input.dueDate ?? null,
                expiresOn: input.expiresOn ?? defaultExpiresOn(input.dueDate, today()),
                requestedByMembershipId: actor.membershipId,
                correlationId: randomUUID(),
              })
              .returning();
            if (!r) throw new Error("intake_records_request insert returned no row");
            return project(r, 0, today());
          });
        } catch (err) {
          if (attempt < 4 && isCodeCollision(err)) continue;
          throw err;
        }
      }
    },
    async listForReferral(organizationId, referralId) {
      return read(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(RR)
          .where(eq(RR.referralId, referralId))
          .orderBy(desc(RR.requestedAt), desc(RR.id))
          .limit(200);
        const counts = await batchCounts(
          tx,
          rows.map((r) => r.id),
        );
        return rows.map((r) => project(r, counts.get(r.id) ?? 0, today()));
      });
    },
    async get(organizationId, referralId, requestId) {
      return read(organizationId, async (tx) => view(tx, await loadOne(tx, referralId, requestId)));
    },
    async cancel(organizationId, actor, referralId, requestId, reason) {
      return write(organizationId, actor, async (tx) => {
        const r = await loadOne(tx, referralId, requestId);
        if (!["requested", "partially_received", "expired"].includes(r.status)) {
          throw notCancellable();
        }
        const at = now();
        const [u] = await tx
          .update(RR)
          .set({
            status: "cancelled",
            cancelledAt: at,
            cancelledByMembershipId: actor.membershipId,
            cancelReason: reason?.trim() || null,
            updatedAt: at,
          })
          .where(and(eq(RR.id, r.id), eq(RR.status, r.status)))
          .returning();
        if (!u) throw notCancellable(); // raced with a receipt
        return view(tx, u);
      });
    },
    async mark(organizationId, actor, referralId, requestId, status) {
      return write(organizationId, actor, async (tx) => {
        const r = await loadOne(tx, referralId, requestId);
        if (r.status === "cancelled") throw cancelledRequest();
        const at = now();
        const [u] = await tx
          .update(RR)
          .set({ status, receivedAt: r.receivedAt ?? at, updatedAt: at })
          .where(eq(RR.id, r.id))
          .returning();
        return view(tx, u as Row);
      });
    },
    async extend(organizationId, actor, referralId, requestId, input) {
      return write(organizationId, actor, async (tx) => {
        const r = await loadOne(tx, referralId, requestId);
        if (!RECORDS_REQUEST_EXTENDABLE.has(r.status as RecordsRequestStatus))
          throw notExtendable();
        validateExtendInput(input, day(r.dueDate), today());
        const at = now();
        const [u] = await tx
          .update(RR)
          .set({
            status: "requested",
            expiresOn: input.expiresOn,
            expiredAt: null,
            ...(input.dueDate ? { dueDate: input.dueDate } : {}),
            updatedAt: at,
          })
          // Guarded on the status read above: a batch arriving meanwhile (→ received) wins.
          .where(and(eq(RR.id, r.id), eq(RR.status, r.status)))
          .returning();
        if (!u) throw notExtendable();
        return view(tx, u);
      });
    },
    async findForLink(organizationId, requestId) {
      return read(organizationId, async (tx) => {
        const [r] = await tx
          .select({
            id: RR.id,
            referralId: RR.referralId,
            patientId: RR.patientId,
            status: RR.status,
          })
          .from(RR)
          .where(eq(RR.id, requestId))
          .limit(1);
        return r ? { ...r, status: r.status as RecordsRequestStatus } : null;
      });
    },
  };
}

/**
 * The hourly expiry sweep for ONE org (F-238): every `requested` request whose `expires_on` day is before
 * today (UTC) moves to `expired`, stamped `expired_at`. Org-explicit — a cron tick is not a request — and
 * runs under `withOrgContext` (FORCEd RLS), with no acting user (the audit trigger records a system write).
 * One guarded UPDATE: a batch arriving at the same moment (→ `received`) is never overwritten.
 */
export async function expireRecordsRequestsForOrg(
  db: DbClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as DbClient;
    const rows = await tx
      .update(RR)
      .set({ status: "expired", expiredAt: now, updatedAt: now })
      .where(
        and(
          eq(RR.organizationId, organizationId),
          eq(RR.status, "requested"),
          isNotNull(RR.expiresOn),
          lt(RR.expiresOn, today),
        ),
      )
      .returning({ id: RR.id });
    return rows.length;
  });
}
