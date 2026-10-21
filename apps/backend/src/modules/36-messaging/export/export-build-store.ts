// M36 WP 5.7 (ADR-0089, PROPOSED) - the database half of the artefact build (`ExportBuildStore`). Every call is its own tenant transaction in the
// system org context (a worker is not a request). The transitions are plain guarded UPDATEs: the guard trigger on `message_export_job` owns the
// legality (forward-only, ready needs every artefact column, failed only from building), and each UPDATE also pins the expected current status
// so a lost race changes nothing. Held messages are excluded IN SQL with the live legal-hold predicate (the same one the retention scan uses), so
// a hold the overlay has not materialised yet still protects the message; erased bodies (empty cipher) are not exported (D9).
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { activeLiveHolds, anyHoldPredicate } from "../jobs/retention-hold-sql";
import type { HintOutboxPort } from "../message-hint-events";
import type {
  ExportAttachmentMeta,
  ExportBuildStore,
  ExportChannel,
  ExportCursor,
  ExportJobRow,
  ExportMessageQuery,
  ExportMessageRow,
} from "./export-builder";
import { publishExportEvent } from "./export-events";

const J = schema.messageExportJobs;

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  );

/** The shared WHERE over alias `m` (message) and `c` (channel); `holdsExpr` is the live hold predicate (`false` when no hold is active). */
function scope(organizationId: string, query: ExportMessageQuery): SQL {
  return sql`m.organization_id = ${organizationId}::uuid
    AND m.channel_id IN (${uuidList(query.channelIds)})
    AND octet_length(m.body_cipher) > 0
    AND m.created_at <= ${query.until.toISOString()}::timestamptz
    ${query.from ? sql`AND m.created_at >= ${query.from.toISOString()}::timestamptz` : sql``}
    ${query.to ? sql`AND m.created_at < ${query.to.toISOString()}::timestamptz` : sql``}`;
}

export function createExportBuildStore(deps: {
  readonly db: DbClient;
  readonly outbox: HintOutboxPort;
}): ExportBuildStore {
  const inTx = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(deps.db, systemOrgContext(organizationId), (tx) =>
      fn(tx as unknown as DbClient),
    );

  return {
    claim: (organizationId, jobId) =>
      inTx(organizationId, async (tx) => {
        const rows = await tx
          .update(J)
          .set({ status: "building" })
          .where(
            and(eq(J.organizationId, organizationId), eq(J.id, jobId), eq(J.status, "approved")),
          )
          .returning({
            id: J.id,
            organizationId: J.organizationId,
            requestedBy: J.requestedBy,
            decidedBy: J.decidedBy,
            scopeKind: J.scopeKind,
            channelId: J.channelId,
            patientId: J.patientId,
            dateFrom: J.dateFrom,
            dateTo: J.dateTo,
          });
        const row = rows[0];
        if (!row?.decidedBy) return null;
        return { ...row, decidedBy: row.decidedBy } as ExportJobRow;
      }),

    channelsFor: (organizationId, job) =>
      inTx(organizationId, async (tx) => {
        const where =
          job.scopeKind === "channel"
            ? sql`c.id = ${job.channelId}::uuid`
            : sql`c.channel_kind = 'care_team' AND c.subject_id = ${job.patientId}::uuid`;
        const res = await tx.execute<{ id: string; kind: string; subject_id: string | null }>(
          sql`SELECT c.id, c.channel_kind AS kind, c.subject_id FROM channel c
               WHERE c.organization_id = ${organizationId}::uuid AND ${where}`,
        );
        return res.rows.map(
          (r): ExportChannel => ({ id: r.id, kind: r.kind, subjectId: r.subject_id }),
        );
      }),

    count: (organizationId, query) =>
      inTx(organizationId, async (tx) => {
        if (query.channelIds.length === 0) return { total: 0, held: 0 };
        const holds = await activeLiveHolds(tx, organizationId);
        const res = await tx.execute<{ total: number; held: number }>(
          sql`SELECT count(*)::int AS total, (count(*) FILTER (WHERE ${anyHoldPredicate(holds)}))::int AS held
                FROM message m JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
               WHERE ${scope(organizationId, query)}`,
        );
        return { total: Number(res.rows[0]?.total ?? 0), held: Number(res.rows[0]?.held ?? 0) };
      }),

    page: (organizationId, query, after: ExportCursor | null, limit) =>
      inTx(organizationId, async (tx) => {
        if (query.channelIds.length === 0) return [];
        const holds = await activeLiveHolds(tx, organizationId);
        const res = await tx.execute<{
          id: string;
          channel_id: string;
          author_user_id: string | null;
          created_at: Date | string;
          body_kind: string;
          status: string;
          body_cipher: Buffer;
        }>(
          sql`SELECT m.id, m.channel_id, m.author_user_id, m.created_at, m.body_kind, m.status, m.body_cipher
                FROM message m JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
               WHERE ${scope(organizationId, query)}
                 AND NOT ${anyHoldPredicate(holds)}
                 ${
                   after
                     ? sql`AND (m.created_at, m.id) > (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`
                     : sql``
                 }
               ORDER BY m.created_at, m.id
               LIMIT ${limit}`,
        );
        return res.rows.map(
          (r): ExportMessageRow => ({
            id: r.id,
            channelId: r.channel_id,
            authorUserId: r.author_user_id,
            createdAt: new Date(r.created_at),
            bodyKind: r.body_kind,
            status: r.status,
            bodyCipher: Buffer.from(r.body_cipher),
          }),
        );
      }),

    attachments: (organizationId, messageIds) =>
      inTx(organizationId, async (tx) => {
        if (messageIds.length === 0) return [];
        const res = await tx.execute<{
          id: string;
          message_id: string;
          filename: string;
          mime_type: string;
          byte_size: number;
          scan_state: string;
        }>(
          sql`SELECT a.id, a.message_id, a.filename, a.mime_type, a.byte_size, a.scan_state
                FROM message_attachment a
               WHERE a.organization_id = ${organizationId}::uuid AND a.message_id IN (${uuidList(messageIds)})
               ORDER BY a.created_at, a.id`,
        );
        return res.rows.map(
          (r): ExportAttachmentMeta => ({
            id: r.id,
            messageId: r.message_id,
            name: r.filename,
            mimeType: r.mime_type,
            byteSize: Number(r.byte_size),
            scanState: r.scan_state,
          }),
        );
      }),

    complete: (organizationId, jobId, result) =>
      inTx(organizationId, async (tx) => {
        const rows = await tx
          .update(J)
          .set({
            status: "ready",
            artefactKey: result.artefactKey,
            artefactSha256: result.artefactSha256,
            artefactBytes: result.artefactBytes,
            wrappedDek: result.wrappedDek,
            messageCount: result.messageCount,
            heldExcluded: result.heldExcluded,
            part2Excluded: result.part2Excluded,
          })
          .where(
            and(eq(J.organizationId, organizationId), eq(J.id, jobId), eq(J.status, "building")),
          )
          .returning({ requestedBy: J.requestedBy, readyAt: J.readyAt, expiresAt: J.expiresAt });
        const row = rows[0];
        if (!row?.readyAt || !row.expiresAt) throw new Error("export job is not building");
        await publishExportEvent(deps.outbox, tx, {
          kind: "ready",
          orgId: organizationId,
          jobId,
          requestedBy: row.requestedBy,
          at: row.readyAt,
          expiresAt: row.expiresAt,
        });
      }),

    fail: (organizationId, jobId, failureCode) =>
      inTx(organizationId, async (tx) => {
        await tx
          .update(J)
          .set({ status: "failed", failureCode })
          .where(
            and(eq(J.organizationId, organizationId), eq(J.id, jobId), eq(J.status, "building")),
          );
      }),
  };
}
