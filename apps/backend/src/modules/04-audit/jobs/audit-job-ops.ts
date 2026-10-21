// apps/backend/src/modules/04-audit/jobs/audit-job-ops.ts — GAP-014 the PRODUCTION bindings of the M4
// §4.4 audit jobs. `registerAuditWorkers` needed five infra adapters nobody had built, so nothing ever
// ran: exports stayed `pending` forever, the retention scan never opened a certificate and an approved
// destruction certificate only ever flipped its status.
//
// Three org-scoped jobs are bound here (the same per-org fan-out shape as M5's snapshot rebuild — a cron
// tick is not a request, so every org runs under its own `withOrgContext`):
//
//   • build_export        sweep `audit_export` rows in `pending` → render the watermarked artifact →
//                         PUT it to the tenant bucket → `ready` (+ file_ref / record_count / generated_at).
//   • retention_scan      derive expired (month, retention class) candidates from the org's own audit
//                         rows through the sanctioned `createDbAuditQuery` reader and open one pending
//                         `destruction_certificate` per eligible candidate (legal-hold and Part 2 rules are
//                         applied by the package's `runRetentionScan`, then again row-by-row at execution).
//   • execute_destruction sweep `approved` certificates → run them through the eraser. Bound ONLY when a
//                         destruction-granted client exists (`DATABASE_DESTRUCTION_URL`): without it the
//                         eraser's `performErasure` would throw, so the sweep is simply not constructed.
//
// `seal_partition` and the quarterly `integrity_sample` live in ./audit-integrity-job.ts (the sealed audit
// hash chain + its sampled verification). The spec's pgBackRest backup comparison is NOT built — no backup
// reader exists in this repo (external factor); every integrity run records that explicitly.
import {
  type AuditEventFilter,
  type AuditEventRecord,
  type EraseInput,
  type EraserPorts,
  type ReconcileOrgResult,
  type RetentionCandidate,
  type RetentionScanPorts,
  audit,
  createDbAuditQuery,
  reconcileOrgHolds,
  renderAuditExport,
  runExecuteDestruction,
  runRetentionScan,
  widenSpan,
} from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq } from "drizzle-orm";

const EXPORT = schema.auditExports;
const CERT = schema.destructionCertificates;

type RetentionClass = AuditEventRecord["retentionClass"];

/** Operational events age out after a year; every other class is judged on the 7-year compliance floor. */
const OPERATIONAL_RETENTION_YEARS = 1;
const COMPLIANCE_RETENTION_YEARS = 7;
/** Bound on audit rows one org's scan/export/destruction reads per tick (a daily/2-min job catches up). */
const MAX_ROWS_PER_RUN = 20_000;
const PAGE_LIMIT = 200;
const MAX_EXPORTS_PER_TICK = 5;
const MAX_CERTIFICATES_PER_TICK = 5;
const DATA_CLASS_PREFIX = "audit_event.";

const addYears = (date: Date, years: number): Date => {
  const out = new Date(date.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
};

/** The instant before which an event of `retentionClass` is expired; null for an indefinite hold. */
export function retentionCutoffFor(retentionClass: RetentionClass, now: Date): Date | null {
  if (retentionClass === "legal_hold") return null;
  const years =
    retentionClass === "operational" ? OPERATIONAL_RETENTION_YEARS : COMPLIANCE_RETENTION_YEARS;
  return addYears(now, -years);
}

interface RetentionEventLike {
  readonly createdAt: string;
  readonly retentionClass: RetentionClass;
  readonly context?: Record<string, unknown>;
  /** GAP-008 (ADR-0051): an ACTIVE legal hold covers this row, so its EFFECTIVE class is `legal_hold` whatever the hashed base says. */
  readonly legalHold?: boolean;
}

const monthKey = (iso: string): string => iso.slice(0, 7); // YYYY-MM

/**
 * Group an org's audit events into one retention candidate per (month, class). A month is a candidate
 * only when its LAST instant is past retention (a partition is destroyed whole). `legal_hold` events are
 * kept as candidates so the scan reports an explicit skip reason; a Part 2 candidate never carries a
 * patient here (the lifetime proof is not derivable from audit rows), so the scan conservatively keeps it.
 */
export function groupRetentionCandidates(
  organizationId: string,
  events: readonly RetentionEventLike[],
  now: Date,
): RetentionCandidate[] {
  const out = new Map<string, RetentionCandidate>();
  for (const e of events) {
    const month = monthKey(e.createdAt);
    // A held row reports as `legal_hold` (the scan then skips it with an explicit reason); the retention YEARS still follow the
    // base class, which is what the row's natural due date is.
    const effectiveClass: RetentionClass = e.legalHold === true ? "legal_hold" : e.retentionClass;
    const key = `${month}|${effectiveClass}`;
    if (out.has(key)) continue;
    const years =
      e.retentionClass === "operational" ? OPERATIONAL_RETENTION_YEARS : COMPLIANCE_RETENTION_YEARS;
    const [y, m] = month.split("-").map(Number) as [number, number];
    const monthEnd = new Date(Date.UTC(y, m, 1)); // first instant of the NEXT month
    const expiresAt = addYears(monthEnd, years);
    if (expiresAt > now) continue; // the month is not wholly past retention yet
    out.set(key, {
      partition: `audit_event_${month.replace("-", "_")}`,
      organizationId,
      dataClass: `${DATA_CLASS_PREFIX}${effectiveClass}`,
      retentionClass: effectiveClass,
      expiresAt: expiresAt.toISOString(),
      patient: null,
    });
  }
  return [...out.values()];
}

/** The export scope jsonb the route stores (`AuditExportScopeSchema`). */
export interface ExportScope {
  readonly from: string;
  readonly to: string;
  readonly patientIds?: readonly string[];
  readonly actorIds?: readonly string[];
  readonly resourceKinds?: readonly string[];
  readonly eventTypes?: readonly string[];
}

/** Translate a scope into reader queries (one per patient id) + a post-filter for the list-valued fields. */
export function exportFilterFromScope(scope: ExportScope): {
  queries: AuditEventFilter[];
  matches(r: Pick<AuditEventRecord, "eventType" | "actorUserId" | "resourceKind">): boolean;
} {
  const base: AuditEventFilter = { from: scope.from, to: scope.to };
  const queries: AuditEventFilter[] = scope.patientIds?.length
    ? scope.patientIds.map((patientId) => ({ ...base, patientId }))
    : [base];
  const inList = <T>(list: readonly T[] | undefined, v: T | null): boolean =>
    !list?.length || (v !== null && list.includes(v));
  return {
    queries,
    matches: (r) =>
      inList(scope.eventTypes, r.eventType) &&
      inList(scope.actorIds, r.actorUserId) &&
      inList(scope.resourceKinds, r.resourceKind),
  };
}

/** Run `perOrg` for every active org; one org's failure never skips the rest, all are re-raised together. */
export async function runAuditFanout(
  listOrgs: () => Promise<readonly { readonly organizationId: string }[]>,
  perOrg: (organizationId: string) => Promise<unknown>,
  label: string,
): Promise<{ readonly orgs: number }> {
  const failures: unknown[] = [];
  const orgs = await listOrgs();
  for (const { organizationId } of orgs) {
    try {
      await perOrg(organizationId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `M4_${label.toUpperCase()}: ${failures.length} org failure(s)`,
    );
  }
  return { orgs: orgs.length };
}

/** Pages an org's audit rows through the sanctioned reader, bounded by {@link MAX_ROWS_PER_RUN}. */
async function readAuditRows(
  db: DbClient,
  organizationId: string,
  filter: AuditEventFilter,
): Promise<{ rows: AuditEventRecord[]; truncated: boolean }> {
  const query = createDbAuditQuery(db);
  const rows: AuditEventRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await query.searchEvents(organizationId, {
      ...filter,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (rows.length >= MAX_ROWS_PER_RUN) return { rows, truncated: cursor !== undefined };
  } while (cursor);
  return { rows, truncated: false };
}

/** Minimal object-store capability (the composition root binds the M22-derived tenant-bucket PUT). */
export interface AuditExportObjectStore {
  putObject(args: {
    organizationId: string;
    objectKey: string;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<unknown>;
}

export interface AuditJobOpsDeps {
  readonly db: DbClient;
  readonly listOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly objectStore?: AuditExportObjectStore;
  /** A DESTRUCTION-GRANTED client; when absent the destruction sweep is not available. */
  readonly eraserPorts?: EraserPorts;
  readonly now?: () => Date;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

const SYSTEM = { userId: "" } as const;

// --- build_export ------------------------------------------------------------------------------------

/** Build every pending export of one org. Returns how many reached `ready` / `failed`. */
export async function runBuildExportSweepForOrg(
  deps: AuditJobOpsDeps,
  organizationId: string,
): Promise<{ ready: number; failed: number }> {
  const store = deps.objectStore;
  if (!store) throw new Error("M4_BUILD_EXPORT: no object store bound (MINIO_* env contract)");
  const now = deps.now ?? (() => new Date());
  const pending = await withOrgContext(deps.db, { organizationId, ...SYSTEM }, (tx) =>
    tx
      .select()
      .from(EXPORT)
      .where(and(eq(EXPORT.organizationId, organizationId), eq(EXPORT.status, "pending")))
      .orderBy(asc(EXPORT.requestedAt))
      .limit(MAX_EXPORTS_PER_TICK),
  );
  let ready = 0;
  let failed = 0;
  for (const row of pending) {
    const claimed = await withOrgContext(deps.db, { organizationId, ...SYSTEM }, (tx) =>
      tx
        .update(EXPORT)
        .set({ status: "building" })
        .where(and(eq(EXPORT.id, row.id), eq(EXPORT.status, "pending")))
        .returning({ id: EXPORT.id }),
    );
    if (claimed.length === 0) continue; // another tick claimed it
    try {
      const scope = row.scope as ExportScope;
      const { queries, matches } = exportFilterFromScope(scope);
      const seen = new Map<string, AuditEventRecord>();
      for (const q of queries) {
        const { rows, truncated } = await readAuditRows(deps.db, organizationId, q);
        if (truncated) throw new Error(`export scope exceeds ${MAX_ROWS_PER_RUN} rows; narrow it`);
        for (const r of rows) if (matches(r)) seen.set(r.id, r);
      }
      const records = [...seen.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const watermark = `audit_export ${row.id} requested_by ${row.requestedBy} generated ${now().toISOString()}`;
      const artifact = renderAuditExport({
        format: row.format,
        watermark: row.watermarked ? watermark : "",
        records,
      });
      const fileRef = crypto.randomUUID();
      await store.putObject({
        organizationId,
        objectKey: `audit-exports/${fileRef}.${row.format}`,
        bytes: new TextEncoder().encode(artifact.body),
        mimeType: artifact.contentType,
      });
      await withOrgContext(deps.db, { organizationId, ...SYSTEM }, (tx) =>
        tx
          .update(EXPORT)
          .set({
            status: "ready",
            fileRef,
            recordCount: artifact.recordCount,
            generatedAt: now(),
          })
          .where(eq(EXPORT.id, row.id)),
      );
      ready += 1;
    } catch (error) {
      failed += 1;
      deps.log?.("m4.audit_export.build_failed", {
        organizationId,
        exportId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await withOrgContext(deps.db, { organizationId, ...SYSTEM }, (tx) =>
        tx.update(EXPORT).set({ status: "failed" }).where(eq(EXPORT.id, row.id)),
      );
    }
  }
  return { ready, failed };
}

// --- retention_scan ----------------------------------------------------------------------------------

/** Retention-scan ports for one org: candidates from the org's own audit rows; certificates inserted pending. */
export function buildRetentionScanPorts(
  deps: AuditJobOpsDeps,
  organizationId: string,
): RetentionScanPorts {
  const now = deps.now ?? (() => new Date());
  return {
    now,
    async listExpiredCandidates() {
      const oldest = retentionCutoffFor("operational", now());
      if (!oldest) return [];
      const { rows } = await readAuditRows(deps.db, organizationId, { to: oldest.toISOString() });
      return groupRetentionCandidates(organizationId, rows, now());
    },
    async openCertificate(candidate) {
      const [y, m] = candidate.partition.replace("audit_event_", "").split("_").map(Number) as [
        number,
        number,
      ];
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 1) - 1);
      return withOrgContext(deps.db, { organizationId, ...SYSTEM }, async (tx) => {
        const existing = await tx
          .select({ id: CERT.id })
          .from(CERT)
          .where(
            and(
              eq(CERT.organizationId, organizationId),
              eq(CERT.dataClass, candidate.dataClass),
              eq(CERT.dateRangeStart, start),
            ),
          )
          .limit(1);
        if (existing[0]) return existing[0].id; // idempotent: the daily scan re-meets the same month
        const [row] = await tx
          .insert(CERT)
          .values({
            organizationId,
            dataClass: candidate.dataClass,
            recordCount: 0, // finalized with the true erased count at execution
            dateRangeStart: start,
            dateRangeEnd: end,
            method: "secure_delete",
            status: "pending",
          })
          .returning({ id: CERT.id });
        if (!row) throw new Error("destruction_certificate insert returned no row");
        return row.id;
      });
    },
  };
}

export const runRetentionScanForOrg = (deps: AuditJobOpsDeps, organizationId: string) =>
  runRetentionScan(buildRetentionScanPorts(deps, organizationId));

// --- legal_hold_materialise --------------------------------------------------------------------------

/**
 * GAP-008 (ADR-0051): bring every ACTIVE hold's overlay (`legal_hold_audit_event`) up to date - holds applied since the last
 * tick, holds the migration left `pending`, and the rows an open-ended hold gains as time passes. A SWEEP (like export /
 * destruction): the apply route stays a plain insert and a lost job costs nothing, because the next tick resumes from each
 * hold's `materialised_through`. Supremacy does not wait on it - the structural group check and the DELETE guard cover rows
 * the overlay has not reached yet. A hold that fails is re-raised AFTER the others ran, so the job never reports green over it.
 */
export async function runLegalHoldMaterialiseForOrg(
  deps: AuditJobOpsDeps,
  organizationId: string,
): Promise<ReconcileOrgResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result = await reconcileOrgHolds(deps.db, organizationId, now);
  deps.log?.("m4.legal_hold_materialise.org", {
    organizationId,
    holds: result.holds,
    newRows: result.newRows,
    failed: result.failed.length,
  });
  if (result.failed.length > 0) {
    throw new Error(
      `M4_LEGAL_HOLD_MATERIALISE: ${result.failed.length} hold(s) failed for org ${organizationId}: ${result.failed.join(",")}`,
    );
  }
  return result;
}

// --- execute_destruction -----------------------------------------------------------------------------

/**
 * The certificate's terminal status once overlay-held rows are accounted for: a run that erased everything it was handed is
 * still only `partial_refused` when some rows of the certificate's range were kept under an active hold, and a certificate
 * whose every row is held touched nothing (`held`). The eraser's own status (group-level refusals) wins otherwise.
 */
export function certificateStatusWithHeldRows(
  status: "executed" | "partial_refused" | "held",
  heldRows: number,
  erasableGroups: number,
): "executed" | "partial_refused" | "held" {
  if (heldRows === 0) return status;
  if (erasableGroups === 0) return "held";
  return status === "executed" ? "partial_refused" : status;
}

/** Execute every `approved` certificate of one org through the eraser. */
export async function runDestructionSweepForOrg(
  deps: AuditJobOpsDeps,
  organizationId: string,
): Promise<{ executed: number }> {
  const eraser = deps.eraserPorts;
  if (!eraser) throw new Error("M4_EXECUTE_DESTRUCTION: no destruction-granted eraser bound");
  const now = deps.now ?? (() => new Date());
  const approved = await withOrgContext(deps.db, { organizationId, ...SYSTEM }, (tx) =>
    tx
      .select()
      .from(CERT)
      .where(and(eq(CERT.organizationId, organizationId), eq(CERT.status, "approved")))
      .orderBy(asc(CERT.createdAt))
      .limit(MAX_CERTIFICATES_PER_TICK),
  );
  let executed = 0;
  for (const cert of approved) {
    if (!cert.dataClass.startsWith(DATA_CLASS_PREFIX)) continue; // another data class: its own eraser path
    const retentionClass = cert.dataClass.slice(DATA_CLASS_PREFIX.length) as RetentionClass;
    const { rows } = await readAuditRows(deps.db, organizationId, {
      from: cert.dateRangeStart.toISOString(),
      to: cert.dateRangeEnd.toISOString(),
    });
    const groups = new Map<string, EraseInput>();
    const spans = new Map<string, { from: string; to: string }>();
    // GAP-008 (ADR-0051): rows an ACTIVE legal hold covers (the overlay) are not destruction candidates at all. The executor's
    // DELETE and the database trigger refuse them too; excluding them here keeps the certificate honest about what it can destroy.
    let heldRows = 0;
    for (const r of rows) {
      if (r.retentionClass !== retentionClass) continue;
      if (r.legalHold === true) {
        heldRows += 1;
        continue;
      }
      const resourceId = r.resourceId ?? r.id;
      const patientId =
        typeof r.context?.patientId === "string" ? (r.context.patientId as string) : undefined;
      const key = `${r.resourceKind}|${resourceId}`;
      // GAP-008: the group's created-at span, so a dateRange legal hold can be evaluated against it and the
      // executor destroys only inside it (never rows outside the span the hold check saw).
      spans.set(key, widenSpan(spans.get(key), r.createdAt));
      groups.set(key, {
        retentionClass,
        resourceKind: r.resourceKind,
        resourceId,
        organizationId,
        destructionCertificateId: cert.id,
        ...(patientId ? { patientId } : {}),
      });
    }
    for (const [key, group] of groups) {
      const span = spans.get(key);
      if (span) groups.set(key, { ...group, createdAtFrom: span.from, createdAtTo: span.to });
    }
    await runExecuteDestruction(
      {
        certificateId: cert.id,
        dataClass: cert.dataClass,
        organizationId,
        rows: [...groups.values()],
      },
      {
        eraser,
        emit: (event) =>
          withOrgContext(deps.db, { organizationId, ...SYSTEM }, (tx) =>
            audit(
              tx,
              { organizationId, userId: null, actorKind: "system", correlationId: cert.id },
              {
                eventType: event.action,
                resourceKind: "destruction_certificate",
                resourceId: cert.id,
                outcome: "success",
                severity: "warn",
                retentionClass: event.retentionClass,
                context: event.payload,
              },
            ),
          ),
        recordCertificateStatus: (certificateId, status) =>
          withOrgContext(deps.db, { organizationId, ...SYSTEM }, async (tx) => {
            await tx
              .update(CERT)
              .set({
                status: certificateStatusWithHeldRows(status, heldRows, groups.size),
                recordCount: rows.length - heldRows,
                ...(certificateStatusWithHeldRows(status, heldRows, groups.size) === "held"
                  ? {}
                  : { executedAt: now() }),
              })
              .where(eq(CERT.id, certificateId));
          }),
      },
    );
    executed += 1;
  }
  return { executed };
}
