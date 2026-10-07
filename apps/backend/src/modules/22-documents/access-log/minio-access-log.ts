// apps/backend/src/modules/22-documents/access-log/minio-access-log.ts — the MinIO access-log ingestor (GAP-141;
// M22 spec §4.8 `minio-access-log-ingestor`, D17): download CONFIRMATION for signed URLs.
//
// `signed_url_issued` is audited when the URL is MINTED; whether anyone actually FETCHED the object is only visible
// to the object store. MinIO's AUDIT WEBHOOK posts one JSON record per S3 API call (cluster-wide — no per-bucket
// notification to configure for the dynamically-created `tenant-*` buckets). This module turns a successful
// `GetObject` on a tenant bucket into an `access_kind='signed_url_consumed'` row in `document_access_log`.
//
// ATTRIBUTION. A signed URL is fetched by a browser holding the URL, not by an authenticated app session, so the
// object store cannot name the accessor. The accessor is the PRINCIPAL THE URL WAS ISSUED TO: the most recent
// `signed_url_issued` row for the same document version within {@link CONSUMPTION_WINDOW_MS} (a signed URL lives
// <= 300s) — its accessor ids, patient and purpose are copied onto the consumed row. A fetch with no matching issue
// row (an unknown/expired URL, a direct admin read) is NOT attributed and is dropped: the spec accepts this audit gap
// for the access-log stream ("best-effort ingest"), and a row with no accessor would violate the one-accessor CHECK.
//
// BEST EFFORT, BOUNDED. Replays are harmless: the consumed row's `correlation_id` is the MinIO request id, and an
// existing row with that id is skipped. Only `GetObject` with a 2xx status counts (HEAD/PUT/list are not downloads).
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, gte } from "drizzle-orm";

/** A signed URL's maximum life (planSignedUrl clamps to 300s) plus slack for clock skew and a slow download. */
export const CONSUMPTION_WINDOW_MS = 15 * 60 * 1000;
const TENANT_BUCKET_PREFIX = "tenant-";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A webhook delivery carries one record, or an array of them; more than this is not an audit stream. */
export const MAX_RECORDS_PER_DELIVERY = 500;

/** What the ingestor needs from one MinIO audit record. */
export interface ObjectConsumption {
  readonly organizationId: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Parse a delivery body (a record or an array of records) into the CONSUMPTIONS in it: successful `GetObject`
 * calls on `tenant-<orgId>` buckets. Everything else (other APIs, other buckets, failed calls, malformed records)
 * is ignored — the stream is the whole cluster's S3 traffic.
 */
export function parseConsumptions(body: unknown, fallbackNow: Date): readonly ObjectConsumption[] {
  const records = Array.isArray(body) ? body.slice(0, MAX_RECORDS_PER_DELIVERY) : [body];
  const out: ObjectConsumption[] = [];
  for (const raw of records) {
    const record = asRecord(raw);
    const api = asRecord(record?.api);
    if (!record || !api) continue;
    if (api.name !== "GetObject") continue;
    const statusCode = typeof api.statusCode === "number" ? api.statusCode : null;
    const ok = statusCode !== null ? statusCode >= 200 && statusCode < 300 : api.status === "OK";
    if (!ok) continue;
    const bucket = asString(api.bucket);
    const rawKey = asString(api.object);
    if (!bucket || !rawKey || !bucket.startsWith(TENANT_BUCKET_PREFIX)) continue;
    const organizationId = bucket.slice(TENANT_BUCKET_PREFIX.length);
    if (!UUID_RE.test(organizationId)) continue;
    let objectKey = rawKey;
    try {
      objectKey = decodeURIComponent(rawKey);
    } catch {
      // keep the raw key: an undecodable one simply will not match a document version
    }
    const time = asString(record.time);
    const parsed = time ? new Date(time) : null;
    out.push({
      organizationId,
      bucket,
      objectKey,
      requestId: asString(record.requestID) ?? randomUUID(),
      occurredAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallbackNow,
    });
  }
  return out;
}

export interface IngestResult {
  readonly recorded: number;
  /** Fetches with no document version / no matching issue row: dropped (accepted audit gap). */
  readonly unattributed: number;
  readonly duplicates: number;
}

const DOC_VERSION = schema.documentVersions;
const LOG = schema.documentAccessLog;

/** Record each consumption as a `signed_url_consumed` row attributed to the principal the URL was issued to. */
export async function ingestConsumptions(
  db: DbClient,
  consumptions: readonly ObjectConsumption[],
): Promise<IngestResult> {
  let recorded = 0;
  let unattributed = 0;
  let duplicates = 0;
  for (const c of consumptions) {
    const outcome = await withOrgContext(
      db,
      { organizationId: c.organizationId, userId: "" },
      async (tx): Promise<"recorded" | "unattributed" | "duplicate"> => {
        const [version] = await tx
          .select({ id: DOC_VERSION.id, documentId: DOC_VERSION.documentId })
          .from(DOC_VERSION)
          .where(eq(DOC_VERSION.minioObjectKey, c.objectKey))
          .limit(1);
        if (!version) return "unattributed";

        const correlationId = `minio:${c.requestId}`;
        const [existing] = await tx
          .select({ id: LOG.id })
          .from(LOG)
          .where(
            and(
              eq(LOG.documentVersionId, version.id),
              eq(LOG.accessKind, "signed_url_consumed"),
              eq(LOG.correlationId, correlationId),
            ),
          )
          .limit(1);
        if (existing) return "duplicate";

        const [issued] = await tx
          .select({
            accessorMembershipId: LOG.accessorMembershipId,
            accessorPortalAccountId: LOG.accessorPortalAccountId,
            portalSessionId: LOG.portalSessionId,
            patientId: LOG.patientId,
            purpose: LOG.purpose,
            recipientMembershipId: LOG.recipientMembershipId,
            recipientClass: LOG.recipientClass,
          })
          .from(LOG)
          .where(
            and(
              eq(LOG.documentVersionId, version.id),
              eq(LOG.accessKind, "signed_url_issued"),
              gte(LOG.accessedAt, new Date(c.occurredAt.getTime() - CONSUMPTION_WINDOW_MS)),
            ),
          )
          .orderBy(desc(LOG.accessedAt))
          .limit(1);
        if (!issued) return "unattributed";

        await tx.insert(LOG).values({
          organizationId: c.organizationId,
          documentId: version.documentId,
          documentVersionId: version.id,
          accessorMembershipId: issued.accessorMembershipId,
          accessorPortalAccountId: issued.accessorPortalAccountId,
          portalSessionId: issued.portalSessionId,
          patientId: issued.patientId,
          accessKind: "signed_url_consumed",
          purpose: issued.purpose,
          recipientMembershipId: issued.recipientMembershipId,
          recipientClass: issued.recipientClass,
          correlationId,
          accessedAt: c.occurredAt,
        });
        return "recorded";
      },
    );
    if (outcome === "recorded") recorded += 1;
    else if (outcome === "duplicate") duplicates += 1;
    else unattributed += 1;
  }
  return { recorded, unattributed, duplicates };
}
