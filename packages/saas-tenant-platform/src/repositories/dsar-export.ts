// @chartwarden/saas-tenant-platform · repositories — DSAR export data port: `dsar_export_job` +
// `dsar_export_job_event` (M34 §3.7).
//
// The patient-scoped Data Subject Access Request side of the strict DSAR/tenant-export split (D9):
// a FHIR R4 Bundle + rendered chart PDF, 30-day fulfillment SLA with M36 escalation at day 20/27/30
// (D17). This repo inserts the job, drives its status, records the bundle artifact handles (MinIO
// key, sha256, presigned-URL expiry, download stamp), and appends the disclosure-accounting event
// ledger. The DEK-redaction / Part 2 honoring and the SLA escalation timers live in the worker.
import { type DbClient, schema } from "@chartwarden/db";
import { type SQL, and, asc, desc, eq, inArray, isNotNull, lt, or } from "drizzle-orm";

const J = schema.dsarExportJob;
const E = schema.dsarExportJobEvent;

/** Keyset cursor for the disclosure-accounting event ledger (newest-first by (occurredAt, id)). */
export interface DsarEventCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

function eventOlderThan(cursor?: DsarEventCursor): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(E.occurredAt, cursor.occurredAt),
    and(eq(E.occurredAt, cursor.occurredAt), lt(E.id, cursor.id)),
  );
}

/** Statuses that count as "open" — the SLA-due sweep (escalation) operates over these. */
const OPEN_STATUSES = [
  "requested",
  "generating",
  "review_pending",
  "extended",
] as const satisfies readonly schema.DsarExportJob["status"][];

/** Data port for the patient-scoped DSAR export job + its event ledger. */
export class DsarExportRepository {
  constructor(private readonly db: DbClient) {}

  // ── dsar_export_job ────────────────────────────────────────────────────────────────────────

  /** Create a DSAR export job (status 'requested', slaDueAt = requestedAt + 30d set by service). */
  async create(values: schema.NewDsarExportJob): Promise<schema.DsarExportJob> {
    const [row] = await this.db.insert(J).values(values).returning();
    if (!row) throw new Error("dsar_export_job insert returned no row");
    return row;
  }

  /** Fetch a DSAR job by id, or `null`. */
  async findById(id: string): Promise<schema.DsarExportJob | null> {
    const [row] = await this.db.select().from(J).where(eq(J.id, id)).limit(1);
    return row ?? null;
  }

  /** A patient's DSAR jobs for the active org, newest-first. */
  async listByPatient(patientId: string): Promise<readonly schema.DsarExportJob[]> {
    return this.db.select().from(J).where(eq(J.patientId, patientId)).orderBy(desc(J.requestedAt));
  }

  /**
   * Fulfilled DSAR jobs that still carry a presigned-URL expiry, soonest-expiring first — drives the
   * 7-day bundle-expiry sweep (the FHIR/PDF bundle object + its presigned URL auto-reap, D19). Mirrors
   * `TenantExportRepository.listByPresignedExpiry`; the sweep service filters to those already past TTL.
   */
  async listByPresignedExpiry(): Promise<readonly schema.DsarExportJob[]> {
    return this.db
      .select()
      .from(J)
      .where(isNotNull(J.bundlePresignedUrlExpiresAt))
      .orderBy(asc(J.bundlePresignedUrlExpiresAt));
  }

  /** All open (unfulfilled, undenied) DSAR jobs, oldest SLA first — drives day-20/27/30 escalation. */
  async listOpenBySlaDue(): Promise<readonly schema.DsarExportJob[]> {
    return this.db
      .select()
      .from(J)
      .where(inArray(J.status, [...OPEN_STATUSES]))
      .orderBy(asc(J.slaDueAt));
  }

  /**
   * Patch the job's status and any of the lifecycle / extension / bundle-artifact fields. The matching
   * `dsar_export_job_event` ledger row is appended by the service in the same transaction.
   */
  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewDsarExportJob,
        | "status"
        | "extendedUntil"
        | "fulfilledAt"
        | "deniedReason"
        | "bundleDocumentId"
        | "bundleMinioObjectKey"
        | "bundleSha256"
        | "bundlePresignedUrlExpiresAt"
        | "bundleDownloadedAt"
      >
    >,
  ): Promise<schema.DsarExportJob> {
    const [row] = await this.db.update(J).set(patch).where(eq(J.id, id)).returning();
    if (!row) throw new Error(`dsar_export_job ${id} not found for update`);
    return row;
  }

  // ── dsar_export_job_event ───────────────────────────────────────────────────────────────────

  /** Append a disclosure-accounting event row for the DSAR job. */
  async appendEvent(values: schema.NewDsarExportJobEvent): Promise<schema.DsarExportJobEvent> {
    const [row] = await this.db.insert(E).values(values).returning();
    if (!row) throw new Error("dsar_export_job_event insert returned no row");
    return row;
  }

  /** Newest-first keyset page of a DSAR job's event ledger. */
  async listEvents(
    dsarExportJobId: string,
    opts: { limit?: number; cursor?: DsarEventCursor } = {},
  ): Promise<readonly schema.DsarExportJobEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.db
      .select()
      .from(E)
      .where(and(eq(E.dsarExportJobId, dsarExportJobId), eventOlderThan(opts.cursor)))
      .orderBy(desc(E.occurredAt), desc(E.id))
      .limit(limit);
  }
}
