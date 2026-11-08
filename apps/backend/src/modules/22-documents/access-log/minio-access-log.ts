// apps/backend/src/modules/22-documents/access-log/minio-access-log.ts — the object-store access-log ingestor
// (GAP-141; M22 spec §4.8 `minio-access-log-ingestor`, D17): download CONFIRMATION for signed URLs. The name is
// historical: it reads MinIO, RustFS and SeaweedFS (production, via Fluent Bit) audit records alike.
//
// `signed_url_issued` is audited when the URL is MINTED; whether anyone actually FETCHED the object is only visible
// to the object store. The store's AUDIT stream posts one JSON record per S3 API call (cluster-wide — no per-bucket
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
// BEST EFFORT, BOUNDED. Replays are harmless: the consumed row's `correlation_id` is the store's request id, and an
// existing row with that id is skipped (the `minio:` prefix is kept for every store so ids stay comparable).
// Only a GetObject with a 2xx status counts (HEAD/PUT/list are not downloads).
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, gte } from "drizzle-orm";

/** A signed URL's maximum life (planSignedUrl clamps to 300s) plus slack for clock skew and a slow download. */
export const CONSUMPTION_WINDOW_MS = 15 * 60 * 1000;
const TENANT_BUCKET_PREFIX = "tenant-";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A webhook delivery carries one record, or an array of them; more than this is not an audit stream. */
export const MAX_RECORDS_PER_DELIVERY = 500;

/** What the ingestor needs from one object-store audit record. */
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
const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const is2xx = (status: number | null): boolean => status !== null && status >= 200 && status < 300;
/** Epoch seconds (SeaweedFS) vs milliseconds (RustFS): no audit record predates 2001-09-09 in seconds' scale. */
const EPOCH_MS_THRESHOLD = 1e12;

/** One successful object download, before tenant checks. `keyEncoded` keys are percent-decoded. */
interface Download {
  readonly bucket: string | null;
  readonly key: string | null;
  readonly keyEncoded: boolean;
  readonly requestId: string | null;
  readonly time: Date | null;
}

const dateOf = (v: unknown): Date | null => {
  const n = asNumber(v);
  const d =
    n !== null
      ? new Date(n < EPOCH_MS_THRESHOLD ? n * 1000 : n)
      : asString(v)
        ? new Date(v as string)
        : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * The three stores' record shapes, each reduced to a successful object GET (or null):
 *   MinIO      `api.name: "GetObject"`, `api.statusCode`, `api.object` percent-encoded, `time` ISO, `requestID`
 *   RustFS     `api.name: "s3:GetObject"`, `api.status_code`, `api.object` raw, `time` epoch ms, `requestID`
 *   SeaweedFS  `operation: "REST.GET.OBJECT"`, `status`, top-level `bucket`/`key` raw, `time` epoch s, `request_id`
 *              (its audit log is Fluent forward; Fluent Bit posts it here as JSON, deploy/production/object-store)
 */
function downloadOf(record: Record<string, unknown>): Download | null {
  const api = asRecord(record.api);
  if (api?.name === "GetObject") {
    const statusCode = asNumber(api.statusCode);
    if (!(statusCode !== null ? is2xx(statusCode) : api.status === "OK")) return null;
    return {
      bucket: asString(api.bucket),
      key: asString(api.object),
      keyEncoded: true,
      requestId: asString(record.requestID),
      time: dateOf(record.time),
    };
  }
  if (api?.name === "s3:GetObject") {
    if (!is2xx(asNumber(api.status_code))) return null;
    return {
      bucket: asString(api.bucket),
      key: asString(api.object),
      keyEncoded: false,
      requestId: asString(record.requestID),
      time: dateOf(record.time),
    };
  }
  if (record.operation === "REST.GET.OBJECT") {
    if (!is2xx(asNumber(record.status))) return null;
    return {
      bucket: asString(record.bucket),
      key: asString(record.key),
      keyEncoded: false,
      requestId: asString(record.request_id),
      time: dateOf(record.time),
    };
  }
  return null;
}

/** A delivery's records: one record (MinIO), an array (MinIO batch, Fluent Bit) or `{ Records: [...] }` (RustFS). */
function recordsOf(body: unknown): readonly unknown[] {
  const items = Array.isArray(body) ? body : [body];
  return items
    .flatMap((item) => {
      const records = asRecord(item)?.Records;
      return Array.isArray(records) ? records : [item];
    })
    .slice(0, MAX_RECORDS_PER_DELIVERY);
}

/**
 * Parse a delivery body into the CONSUMPTIONS in it: successful object GETs on `tenant-<orgId>` buckets, from
 * MinIO, RustFS or SeaweedFS (see {@link downloadOf}). Everything else (other APIs, other buckets, failed calls,
 * malformed records) is ignored — the stream is the whole cluster's S3 traffic.
 */
export function parseConsumptions(body: unknown, fallbackNow: Date): readonly ObjectConsumption[] {
  const out: ObjectConsumption[] = [];
  for (const raw of recordsOf(body)) {
    const record = asRecord(raw);
    const download = record ? downloadOf(record) : null;
    const { bucket, key } = download ?? {};
    if (!download || !bucket || !key || !bucket.startsWith(TENANT_BUCKET_PREFIX)) continue;
    const organizationId = bucket.slice(TENANT_BUCKET_PREFIX.length);
    if (!UUID_RE.test(organizationId)) continue;
    let objectKey = key;
    if (download.keyEncoded) {
      try {
        objectKey = decodeURIComponent(key);
      } catch {
        // keep the raw key: an undecodable one simply will not match a document version
      }
    }
    out.push({
      organizationId,
      bucket,
      objectKey,
      requestId: download.requestId ?? randomUUID(),
      occurredAt: download.time ?? fallbackNow,
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
