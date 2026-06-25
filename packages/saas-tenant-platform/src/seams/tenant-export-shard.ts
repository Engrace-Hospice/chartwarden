// @wardenx/saas-tenant-platform — the `TenantExportShard` seam (M34 §4.6).
//
// THE FAN-OUT EXPORT CONTRACT. Every PHI-bearing module implements this interface and registers its
// shard with M34 ({@link registerTenantExportShard}, M34's seam-bootstrap); M34's export worker
// iterates the registry at job time and concatenates the per-module NDJSON / FHIR streams into the
// tenant-export (offboarding, §3.3 `tenant_export_job`) or per-patient DSAR bundle (§3.3
// `dsar_export_job`). M34 holds NO module-specific schema knowledge — it owns the orchestration, each
// module owns the shape of its own rows. This is the inverse of a reader seam: M34 is the consumer of
// many implementations, one per `moduleKey`.
//
// The two sinks are intentionally minimal abstract write surfaces (M34 §4.6 — the spec names the
// types without binding them to a concrete stream). The worker passes a sink backed by the encrypted
// MinIO object (M1 envelope) it is assembling; a module writes rows to the sink and returns its tally
// + a content hash so M34 can build the per-job manifest + integrity digest.

/** The minimal write sink a module streams its tenant-scoped rows into, one NDJSON record at a time.
 *  The worker supplies the concrete (encrypted, MinIO-backed) implementation; the module only writes. */
export interface NdjsonSink {
  /** Append one row as a single NDJSON record (the sink owns newline framing + encryption). */
  write(row: unknown): Promise<void>;
}

/** The minimal write sink a module streams FHIR resources into for a per-patient DSAR bundle. The
 *  worker supplies the concrete implementation; the module emits one FHIR resource per call. */
export interface FhirResourceSink {
  /** Append one FHIR resource to the DSAR bundle (the sink owns Bundle framing + encryption). */
  write(resource: unknown): Promise<void>;
}

/** The tally a module returns from a full tenant-export shard (§4.6) — used to build the per-job
 *  manifest line and the integrity digest. */
export interface TenantExportShardResult {
  readonly rowCount: number;
  readonly tableCount: number;
  readonly sha256: string;
}

/** The tally a module returns from a per-patient DSAR shard (§4.6). */
export interface DsarExportShardResult {
  readonly resourceCount: number;
  readonly sha256: string;
}

/**
 * The per-module export contract (§4.6). EVERY PHI-bearing module implements this and registers it
 * with M34; M34's worker iterates the registry and never holds module-specific schema knowledge.
 */
export interface TenantExportShard {
  /** The owning module's stable key — `'m5'`, `'m6'`, … — used to order + label the manifest. */
  readonly moduleKey: string;

  /** Streams NDJSON for every tenant-scoped row this module owns, returning the row/table tally and a
   *  content hash for the manifest. */
  streamShardForOrg(orgId: string, sink: NdjsonSink): Promise<TenantExportShardResult>;

  /** Streams the FHIR resources this module contributes for one patient (the DSAR path), returning
   *  the resource tally and a content hash. */
  streamDsarShardForPatient(
    orgId: string,
    patientId: string,
    sink: FhirResourceSink,
  ): Promise<DsarExportShardResult>;
}
