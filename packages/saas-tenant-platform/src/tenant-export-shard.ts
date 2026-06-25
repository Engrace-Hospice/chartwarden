// @wardenx/saas-tenant-platform — M34's OWN `TenantExportShard` implementation (M34 §3.8 / §7.5, D9).
//
// THE INVERSE OF THE FAN-OUT. Every PHI-bearing module implements {@link TenantExportShard} and
// registers it with M34's worker (seam-bootstrap, `registerTenantExportShard`). This file is M34's
// SELF-shard: M34 is also a PHI-adjacent module (the DSAR job rows carry `patient_id`; the tenant
// lifecycle / support / BAA rows are tenant-scoped compliance evidence), so it implements the same
// contract for its own seventeen owned tables and registers it alongside every other module's shard.
//
// Two paths, mirroring the D9 split:
//   • streamShardForOrg     — the ORG-scoped tenant-export (NDJSON-per-table archive). Streams every
//     M34-owned tenant-scoped row to the {@link NdjsonSink}, returning the row/table tally + a running
//     sha256 digest M34's worker folds into `tenant_export_job.bundle_module_inventory`.
//   • streamDsarShardForPatient — the PATIENT-scoped DSAR bundle. Only `dsar_export_job` (+ its event
//     ledger) carry `patient_id`, so M34's DSAR contribution is the patient's own access-request
//     history rendered as FHIR `Task` resources (a §164.528 disclosure-accounting trail of the access
//     requests themselves), emitted to the {@link FhirResourceSink}.
//
// PURE-LOGIC SHAPE (mirrors M22's eraser/store split): the shard composes over an injected
// {@link M34ExportShardStore} data port — the in-memory store in tests, a Drizzle-backed store (over
// the M34 tables, under the consumer's RLS) in prod. M34 holds no MinIO/stream knowledge here; the
// worker supplies the concrete encrypted sinks. Org/patient scoping is enforced by the surrounding
// `withOrgContext` (RLS) the worker establishes — the store issues plain reads.
import { createHash } from "node:crypto";
import type {
  DsarExportShardResult,
  FhirResourceSink,
  NdjsonSink,
  TenantExportShard,
  TenantExportShardResult,
} from "./seams";

/** The stable module key M34's shard labels its manifest section with (orders + names the bundle). */
export const M34_MODULE_KEY = "m34" as const;

/**
 * The seventeen M34-owned tables, in FK-dependency order (§3.3). The tenant-export NDJSON archive
 * lays one file per table under `modules/m34/<table>.ndjson`; this is the canonical ordering the
 * shard streams + the manifest records. Kept as a const tuple so the table count is statically
 * derivable and the store port's method set stays in lock-step.
 */
export const M34_EXPORT_TABLES = [
  "tenant_account",
  "tenant_account_status_event",
  "tenant_invitation",
  "onboarding_task_template",
  "onboarding_task",
  "tenant_key_ring",
  "tenant_key_destruction_log",
  "support_consent_grant",
  "support_session",
  "support_session_event",
  "dsar_export_job",
  "dsar_export_job_event",
  "tenant_export_job",
  "tenant_export_job_event",
  "platform_tenant_baa_record",
  "tenant_signup_intent",
  "tenant_signup_token",
] as const;

/** A single M34-owned table's worth of export rows, labelled by its table name. */
export interface M34ExportTableRows {
  readonly tableName: (typeof M34_EXPORT_TABLES)[number];
  /** The tenant-scoped rows for the table (plain JSON-serialisable row objects, RLS-scoped). */
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * The narrow data port M34's shard composes over (Drizzle in prod under RLS; in-memory in tests).
 * `tableRowsForOrg` returns ALL seventeen tables' rows for the active org in {@link M34_EXPORT_TABLES}
 * order; `dsarTasksForPatient` returns the patient's DSAR-request rows (the only patient-scoped M34
 * data). The store NEVER opens its own transaction or sets RLS GUCs — the worker's `withOrgContext`
 * scopes every read (single home for the tenant-scoping rule; F09 cross-tenant regression guard).
 */
export interface M34ExportShardStore {
  /** Every M34-owned tenant-scoped row for the active org, grouped + ordered by table (§3.8). */
  tableRowsForOrg(orgId: string): Promise<readonly M34ExportTableRows[]>;
  /** The patient's `dsar_export_job` rows (the only M34 rows carrying `patient_id`, §3.8). */
  dsarJobsForPatient(orgId: string, patientId: string): Promise<readonly Record<string, unknown>[]>;
}

/** Stable-key JSON canonicalisation so the per-shard sha256 is deterministic for fixture input
 *  (the §7.5/§7.6 acceptance: "bundle sha256 deterministic for fixture input"). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return val;
  });
}

/**
 * Build M34's own {@link TenantExportShard} over an injected store (pure factory — unit-tested with the
 * in-memory store; the boot path registers it via `registerTenantExportShard`, seam-bootstrap). The
 * digest is a sha256 over the canonical NDJSON the shard wrote, in stream order, so it matches the
 * file the worker assembles (§7.6 acceptance).
 */
export function createTenantExportShardForM34(store: M34ExportShardStore): TenantExportShard {
  return {
    moduleKey: M34_MODULE_KEY,

    async streamShardForOrg(orgId: string, sink: NdjsonSink): Promise<TenantExportShardResult> {
      const digest = createHash("sha256");
      let rowCount = 0;
      let tableCount = 0;
      const tables = await store.tableRowsForOrg(orgId);
      for (const table of tables) {
        tableCount += 1;
        for (const row of table.rows) {
          // Frame each NDJSON record with its source table so the archive reloads into the right table.
          const record = { table: table.tableName, row };
          digest.update(canonicalJson(record));
          digest.update("\n");
          await sink.write(record);
          rowCount += 1;
        }
      }
      return { rowCount, tableCount, sha256: digest.digest("hex") };
    },

    async streamDsarShardForPatient(
      orgId: string,
      patientId: string,
      sink: FhirResourceSink,
    ): Promise<DsarExportShardResult> {
      const digest = createHash("sha256");
      let resourceCount = 0;
      const jobs = await store.dsarJobsForPatient(orgId, patientId);
      for (const job of jobs) {
        // The DSAR-request history is a §164.528 disclosure-accounting trail — emit each as a FHIR
        // `Task` (the access-request resource), not the chart content itself (that is the other
        // shards' job). M34's DSAR contribution is "the requests the patient made", nothing more.
        const resource = {
          resourceType: "Task" as const,
          id: typeof job.id === "string" ? job.id : undefined,
          intent: "order" as const,
          code: {
            coding: [{ system: "https://wardenx.dev/dsar", code: "data-subject-access-request" }],
          },
          for: { reference: `Patient/${patientId}` },
          authoredOn: job.requestedAt ?? null,
          status: job.status ?? null,
        };
        digest.update(canonicalJson(resource));
        digest.update("\n");
        await sink.write(resource);
        resourceCount += 1;
      }
      return { resourceCount, sha256: digest.digest("hex") };
    },
  };
}

/** An in-memory {@link M34ExportShardStore} for the slice/tests (no live DB). Seed it with the
 *  per-table rows + the patient's DSAR jobs; the shard streams them deterministically. The
 *  Drizzle-backed production store lands with the export worker (Phase 2D). */
export function createInMemoryM34ExportShardStore(seed?: {
  tablesByOrg?: Record<string, readonly M34ExportTableRows[]>;
  dsarJobsByPatient?: Record<string, readonly Record<string, unknown>[]>;
}): M34ExportShardStore {
  const tablesByOrg = seed?.tablesByOrg ?? {};
  const dsarJobsByPatient = seed?.dsarJobsByPatient ?? {};
  return {
    async tableRowsForOrg(orgId: string): Promise<readonly M34ExportTableRows[]> {
      return tablesByOrg[orgId] ?? [];
    },
    async dsarJobsForPatient(
      _orgId: string,
      patientId: string,
    ): Promise<readonly Record<string, unknown>[]> {
      return dsarJobsByPatient[patientId] ?? [];
    },
  };
}
