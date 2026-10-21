// M36 WP 5.7 (ADR-0089, PROPOSED) - the database half of the artefact build (`ExportBuildStore`). Every call is its own tenant transaction in the
// system org context (a worker is not a request). The transitions are plain guarded UPDATEs: the guard trigger on `message_export_job` owns the
// legality (forward-only, ready needs every artefact column, failed only from building), and each UPDATE also pins the expected current status
// so a lost race changes nothing. Held messages are excluded IN SQL with the live legal-hold predicate (the same one the retention scan uses), so
// a hold the overlay has not materialised yet still protects the message; erased bodies (empty cipher) and author-deleted tombstones (status
// 'deleted', which keep their cipher) are not exported (D9). A message tied to a Part 2 flagged patient (message_entity_reference, clinical_link, chart_promotion_request) is left
// out and counted, whatever channel it sits in. Times cross this boundary as database TEXT (microseconds survive; a JS Date keeps milliseconds).
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { activeLiveHolds, anyHoldPredicate } from "../jobs/retention-hold-sql";
import { excludedMemberUserIds } from "../member-category-gate";
import type { HintOutboxPort } from "../message-hint-events";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import type { Tx } from "../messaging-write-core";
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
import { EXPORT_PATIENT_SCOPE_CHANNEL_KINDS } from "./export-ports";

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
    AND m.status <> 'deleted'
    AND m.created_at <= ${query.until}::timestamptz
    AND coalesce(m.edited_at, m.created_at) <= ${query.until}::timestamptz
    ${query.from ? sql`AND m.created_at >= ${query.from.toISOString()}::timestamptz` : sql``}
    ${query.to ? sql`AND m.created_at < ${query.to.toISOString()}::timestamptz` : sql``}`;
}

/**
 * SQL set over alias `m` (message): every patient id the message is tied to - a structured patient reference, a clinical link or a chart-promotion
 * request. All three are organisation-scoped and joined on the message id; this is the whole Part 2 reference surface.
 */
const messagePatientRefs = (alias: string): SQL => {
  const m = sql.raw(alias);
  return sql`SELECT r.entity_id AS patient_id FROM message_entity_reference r
              WHERE r.organization_id = ${m}.organization_id AND r.message_id = ${m}.id AND r.reference_kind = 'patient'
             UNION
             SELECT l.patient_id FROM clinical_link l
              WHERE l.organization_id = ${m}.organization_id AND l.message_id = ${m}.id AND l.patient_id IS NOT NULL
             UNION
             SELECT p.patient_id FROM chart_promotion_request p
              WHERE p.organization_id = ${m}.organization_id AND p.message_id = ${m}.id`;
};

/** SQL boolean over alias `m`: the message is tied (reference, clinical link, promotion request) to one of these (Part 2 flagged) patients; `false` when there are none. */
function referencesFlagged(organizationId: string, patientIds: readonly string[]): SQL {
  if (patientIds.length === 0) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM (${messagePatientRefs("m")}) x WHERE x.patient_id IN (${uuidList(patientIds)}))`;
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
            : sql`c.channel_kind IN (${sql.join(
                EXPORT_PATIENT_SCOPE_CHANNEL_KINDS.map((kind) => sql`${kind}`),
                sql`, `,
              )}) AND c.subject_id = ${job.patientId}::uuid`;
        const res = await tx.execute<{ id: string; kind: string; subject_id: string | null }>(
          sql`SELECT c.id, c.channel_kind AS kind, c.subject_id FROM channel c
               WHERE c.organization_id = ${organizationId}::uuid AND ${where}`,
        );
        return res.rows.map(
          (r): ExportChannel => ({ id: r.id, kind: r.kind, subjectId: r.subject_id }),
        );
      }),

    dbNow: (organizationId) =>
      inTx(organizationId, async (tx) => {
        const res = await tx.execute<{ t: string; d: Date | string }>(
          sql`SELECT now()::text AS t, now() AS d`,
        );
        const row = res.rows[0];
        if (!row) throw new Error("database clock unreadable");
        return { text: row.t, date: new Date(row.d) };
      }),

    requesterEligible: (organizationId, userId) =>
      inTx(organizationId, async (tx) => {
        if (!(await isActiveMessagingUser(tx as unknown as Tx, organizationId, userId)))
          return false;
        return (
          (await excludedMemberUserIds(tx as unknown as Tx, organizationId, [userId])).size === 0
        );
      }),

    referencedPatients: (organizationId, query) =>
      inTx(organizationId, async (tx) => {
        if (query.channelIds.length === 0) return [];
        const res = await tx.execute<{ entity_id: string }>(
          sql`SELECT DISTINCT x.patient_id AS entity_id
                FROM message m CROSS JOIN LATERAL (${messagePatientRefs("m")}) x
               WHERE ${scope(organizationId, query)}`,
        );
        return res.rows.map((r) => r.entity_id);
      }),

    messageReferences: (organizationId, messageIds) =>
      inTx(organizationId, async (tx) => {
        const byMessage = new Map<string, string[]>();
        if (messageIds.length === 0) return byMessage;
        const res = await tx.execute<{ message_id: string; patient_id: string }>(
          sql`SELECT m.id AS message_id, x.patient_id
                FROM message m CROSS JOIN LATERAL (${messagePatientRefs("m")}) x
               WHERE m.organization_id = ${organizationId}::uuid AND m.id IN (${uuidList(messageIds)})`,
        );
        for (const r of res.rows)
          byMessage.set(r.message_id, [...(byMessage.get(r.message_id) ?? []), r.patient_id]);
        return byMessage;
      }),

    count: (organizationId, query) =>
      inTx(organizationId, async (tx) => {
        if (query.channelIds.length === 0) return { total: 0, held: 0, part2: 0 };
        const holds = await activeLiveHolds(tx, organizationId);
        const held = anyHoldPredicate(holds);
        const res = await tx.execute<{ total: number; held: number; part2: number }>(
          sql`SELECT count(*)::int AS total,
                     (count(*) FILTER (WHERE ${held}))::int AS held,
                     (count(*) FILTER (WHERE NOT ${held} AND ${referencesFlagged(organizationId, query.part2PatientIds)}))::int AS part2
                FROM message m JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
               WHERE ${scope(organizationId, query)}`,
        );
        const row = res.rows[0];
        return {
          total: Number(row?.total ?? 0),
          held: Number(row?.held ?? 0),
          part2: Number(row?.part2 ?? 0),
        };
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
          created_at_text: string;
          body_kind: string;
          status: string;
          body_cipher: Buffer;
        }>(
          sql`SELECT m.id, m.channel_id, m.author_user_id, m.created_at, m.created_at::text AS created_at_text, m.body_kind, m.status, m.body_cipher
                FROM message m JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
               WHERE ${scope(organizationId, query)}
                 AND NOT ${anyHoldPredicate(holds)}
                 AND NOT ${referencesFlagged(organizationId, query.part2PatientIds)}
                 ${
                   after
                     ? sql`AND (m.created_at, m.id) > (${after.createdAtText}::timestamptz, ${after.id}::uuid)`
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
            createdAtText: r.created_at_text,
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
