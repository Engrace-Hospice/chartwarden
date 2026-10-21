// M36 WP 5.7 (ADR-0089, PROPOSED) - the storage port of the export request/decide/read side, and its Drizzle implementation. The service holds
// every rule; this is only reads and writes inside ONE tenant transaction, so the unit matrix can run against an in-memory store while the live
// suite proves the SQL. Instants come from the DATABASE clock (`now()`); the job guard trigger stamps them on writes.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { MessagingExportScopeKind, MessagingExportStatus } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { excludedMemberUserIds } from "../member-category-gate";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import type { Tx } from "../messaging-write-core";

const J = schema.messageExportJobs;
const D = schema.messageExportDownloads;
const CH = schema.channels;
const USER = schema.users;

/** Jobs listed at once (mine, and the approvers' queue). */
export const EXPORT_LIST_LIMIT = 50;
/** The channel kinds that carry one patient's conversation (a patient scope exports these). */
const PATIENT_CHANNEL_KINDS = ["care_team", "bereavement"] as const;

export interface ExportActor {
  readonly organizationId: string;
  readonly userId: string;
}

export interface ExportJobRow {
  readonly id: string;
  readonly organizationId: string;
  readonly requestedBy: string;
  readonly requestedByName: string | null;
  readonly scopeKind: MessagingExportScopeKind;
  readonly channelId: string | null;
  readonly patientId: string | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly justification: string;
  readonly status: MessagingExportStatus;
  readonly requestedAt: Date;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly buildingAt: Date | null;
  readonly readyAt: Date | null;
  readonly expiresAt: Date | null;
  readonly artefactKey: string | null;
  readonly artefactSha256: string | null;
  readonly artefactBytes: number | null;
  readonly wrappedDek: string | null;
  readonly messageCount: number | null;
  readonly heldExcluded: number | null;
  readonly part2Excluded: number | null;
  readonly failureCode: string | null;
  readonly downloadCount: number;
  /** The database's `now()` when the row was read: every "is it expired" judgement uses this, never the app clock. */
  readonly dbNow: Date;
}

export interface NewExportJob {
  readonly scopeKind: MessagingExportScopeKind;
  readonly channelId: string | null;
  readonly patientId: string | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly justification: string;
}

export interface ExportTx {
  /** The raw transaction handle the outbox publishes on. */
  readonly raw: unknown;
  /** An active user holding no excluded role category (patient_family, external_auditor, platform_staff). */
  eligible(userId: string): Promise<boolean>;
  /** The channel exists in this tenant, or the patient has at least one patient channel here. */
  scopeExists(scope: Pick<NewExportJob, "scopeKind" | "channelId" | "patientId">): Promise<boolean>;
  /** Serialise this requester's requests so two concurrent ones cannot both pass the cap count. */
  lockRequester(userId: string): Promise<void>;
  counts(userId: string): Promise<{ readonly live: number; readonly day: number }>;
  insertJob(requestedBy: string, input: NewExportJob): Promise<ExportJobRow>;
  getJob(id: string): Promise<ExportJobRow | null>;
  /** pending_approval -> approved | rejected; null when the job is no longer pending. */
  decide(
    id: string,
    status: "approved" | "rejected",
    decidedBy: string,
    note: string | null,
  ): Promise<ExportJobRow | null>;
  /** pending_approval -> cancelled by the requester; null when the job is no longer pending. */
  cancel(id: string, requestedBy: string): Promise<ExportJobRow | null>;
  listMine(userId: string): Promise<ExportJobRow[]>;
  listPending(excludeUserId: string): Promise<ExportJobRow[]>;
  /** The trail row and the download_count bump: both or neither (same transaction). The guards refuse anything but the requester on a ready, unexpired job. */
  recordDownload(jobId: string, userId: string, bytes: number | null): Promise<Date>;
}

export interface ExportStore {
  run<T>(actor: ExportActor, fn: (tx: ExportTx) => Promise<T>): Promise<T>;
}

const dbNow = sql<Date>`now()`.mapWith((value: unknown) => new Date(String(value)));

const COLUMNS = {
  id: J.id,
  organizationId: J.organizationId,
  requestedBy: J.requestedBy,
  requestedByName: USER.name,
  scopeKind: J.scopeKind,
  channelId: J.channelId,
  patientId: J.patientId,
  dateFrom: J.dateFrom,
  dateTo: J.dateTo,
  justification: J.justification,
  status: J.status,
  requestedAt: J.requestedAt,
  decidedBy: J.decidedBy,
  decidedAt: J.decidedAt,
  decisionNote: J.decisionNote,
  buildingAt: J.buildingAt,
  readyAt: J.readyAt,
  expiresAt: J.expiresAt,
  artefactKey: J.artefactKey,
  artefactSha256: J.artefactSha256,
  artefactBytes: J.artefactBytes,
  wrappedDek: J.wrappedDek,
  messageCount: J.messageCount,
  heldExcluded: J.heldExcluded,
  part2Excluded: J.part2Excluded,
  failureCode: J.failureCode,
  downloadCount: J.downloadCount,
  dbNow,
} as const;

type RawRow = Omit<ExportJobRow, "scopeKind" | "status"> & { scopeKind: string; status: string };
const toRow = (r: RawRow): ExportJobRow => ({
  ...r,
  scopeKind: r.scopeKind as MessagingExportScopeKind,
  status: r.status as MessagingExportStatus,
});

const selectJobs = (tx: Tx) =>
  tx.select(COLUMNS).from(J).leftJoin(USER, eq(USER.id, J.requestedBy));

export function createDrizzleExportStore(db: DbClient): ExportStore {
  return {
    run: (actor, fn) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const orgId = actor.organizationId;
          const byId = async (id: string): Promise<ExportJobRow | null> => {
            const [row] = await selectJobs(tx)
              .where(and(eq(J.organizationId, orgId), eq(J.id, id)))
              .limit(1);
            return row ? toRow(row) : null;
          };
          return fn({
            raw: tx,
            async eligible(userId) {
              if (!(await isActiveMessagingUser(tx, orgId, userId))) return false;
              return (await excludedMemberUserIds(tx, orgId, [userId])).size === 0;
            },
            async scopeExists(scope) {
              if (scope.scopeKind === "channel" && scope.channelId) {
                const [row] = await tx
                  .select({ id: CH.id })
                  .from(CH)
                  .where(and(eq(CH.organizationId, orgId), eq(CH.id, scope.channelId)))
                  .limit(1);
                return Boolean(row);
              }
              if (scope.scopeKind === "patient" && scope.patientId) {
                const [row] = await tx
                  .select({ id: CH.id })
                  .from(CH)
                  .where(
                    and(
                      eq(CH.organizationId, orgId),
                      eq(CH.subjectId, scope.patientId),
                      inArray(CH.channelKind, [...PATIENT_CHANNEL_KINDS]),
                    ),
                  )
                  .limit(1);
                return Boolean(row);
              }
              return false;
            },
            async lockRequester(userId) {
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended(${`message-export:${orgId}:${userId}`}, 57))`,
              );
            },
            async counts(userId) {
              const [row] = await tx
                .select({
                  live: sql<number>`count(*) FILTER (WHERE ${J.status} IN ('pending_approval','approved','building','ready'))::int`,
                  day: sql<number>`count(*) FILTER (WHERE ${J.requestedAt} > now() - interval '1 day')::int`,
                })
                .from(J)
                .where(and(eq(J.organizationId, orgId), eq(J.requestedBy, userId)));
              return { live: Number(row?.live ?? 0), day: Number(row?.day ?? 0) };
            },
            async insertJob(requestedBy, input) {
              const [inserted] = await tx
                .insert(J)
                .values({ organizationId: orgId, requestedBy, ...input })
                .returning({ id: J.id });
              if (!inserted) throw new Error("export job insert returned no row");
              const row = await byId(inserted.id);
              if (!row) throw new Error("export job not readable after insert");
              return row;
            },
            getJob: byId,
            async decide(id, status, decidedBy, note) {
              const done = await tx
                .update(J)
                .set({ status, decidedBy, decisionNote: note })
                .where(
                  and(eq(J.organizationId, orgId), eq(J.id, id), eq(J.status, "pending_approval")),
                )
                .returning({ id: J.id });
              return done.length > 0 ? byId(id) : null;
            },
            async cancel(id, requestedBy) {
              const done = await tx
                .update(J)
                .set({ status: "cancelled" })
                .where(
                  and(
                    eq(J.organizationId, orgId),
                    eq(J.id, id),
                    eq(J.requestedBy, requestedBy),
                    eq(J.status, "pending_approval"),
                  ),
                )
                .returning({ id: J.id });
              return done.length > 0 ? byId(id) : null;
            },
            async listMine(userId) {
              const rows = await selectJobs(tx)
                .where(and(eq(J.organizationId, orgId), eq(J.requestedBy, userId)))
                .orderBy(desc(J.requestedAt), desc(J.id))
                .limit(EXPORT_LIST_LIMIT);
              return rows.map(toRow);
            },
            async listPending(excludeUserId) {
              // The queue is worked oldest first; a person's own request is never theirs to decide.
              const rows = await selectJobs(tx)
                .where(
                  and(
                    eq(J.organizationId, orgId),
                    eq(J.status, "pending_approval"),
                    ne(J.requestedBy, excludeUserId),
                  ),
                )
                .orderBy(asc(J.requestedAt), asc(J.id))
                .limit(EXPORT_LIST_LIMIT);
              return rows.map(toRow);
            },
            async recordDownload(jobId, userId, bytes) {
              const [trail] = await tx
                .insert(D)
                .values({ organizationId: orgId, jobId, userId, bytes })
                .returning({ at: D.downloadedAt });
              await tx
                .update(J)
                .set({ downloadCount: sql`${J.downloadCount} + 1` })
                .where(and(eq(J.organizationId, orgId), eq(J.id, jobId)));
              if (!trail) throw new Error("export download trail insert returned no row");
              return trail.at;
            },
          });
        },
      ),
  };
}
