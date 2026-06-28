// @wardenx/quality · repositories — the CAHPS subdomain: `cahps_vendor_binding` (the per-org binding to
// an approved survey vendor, ≤1 active per org), `cahps_decedent_sample` (the PARTITIONED-monthly
// decedent sampling roster — composite PK id + sampling_cycle_month), and `cahps_result_summary` (the
// ingested per-period aggregate scores, idempotent on the vendor-payload hash) (M30 §3.3). ORG-SCOPED;
// the sampling / ingest pipelines wrap these in `withOrgContext`. `configuration_cipher` /
// `primary_caregiver_contact_cipher` are envelope-encrypted + audit-denylisted (§3.6) — this port
// returns whole `$inferSelect` rows; decryption + projection is the service's job.
import { schema } from "@wardenx/db";
import { and, desc, eq } from "drizzle-orm";
import type { QualityDb } from "./db";

const B = schema.cahpsVendorBinding;
const S = schema.cahpsDecedentSample;
const R = schema.cahpsResultSummary;

/** Data port for the three CAHPS tables (vendor binding · decedent sample · result summary). */
export class CahpsRepository {
  constructor(private readonly db: QualityDb) {}

  // ── cahps_vendor_binding ───────────────────────────────────────────────────────────────────────

  /** Insert a vendor binding (defaults to `active`). Returns the inserted row. */
  async createBinding(values: schema.NewCahpsVendorBinding): Promise<schema.CahpsVendorBinding> {
    const [row] = await this.db.insert(B).values(values).returning();
    if (!row) throw new Error("cahps_vendor_binding insert returned no row");
    return row;
  }

  /** Fetch a binding by id, or `null`. */
  async findBindingById(id: string): Promise<schema.CahpsVendorBinding | null> {
    const [row] = await this.db.select().from(B).where(eq(B.id, id)).limit(1);
    return row ?? null;
  }

  /** The single ACTIVE binding for an org (the V-7 partial-unique surface), or `null`. */
  async findActiveBinding(organizationId: string): Promise<schema.CahpsVendorBinding | null> {
    const [row] = await this.db
      .select()
      .from(B)
      .where(and(eq(B.organizationId, organizationId), eq(B.active, true)))
      .limit(1);
    return row ?? null;
  }

  /** An org's binding history (active + retired), newest first. */
  async listBindings(organizationId: string): Promise<readonly schema.CahpsVendorBinding[]> {
    return this.db
      .select()
      .from(B)
      .where(eq(B.organizationId, organizationId))
      .orderBy(desc(B.effectiveFrom));
  }

  /**
   * Update a binding's mutable fields (rotate cipher / flip active / stamp effective_until / refresh the
   * size-exemption determination). The "≤1 active per org" invariant + cosign guards live in the service.
   */
  async updateBinding(
    id: string,
    patch: Partial<
      Pick<
        schema.NewCahpsVendorBinding,
        | "active"
        | "effectiveUntil"
        | "configurationCipher"
        | "configurationKeyVersion"
        | "sizeExemptionFlag"
        | "sizeExemptionLastDeterminedAt"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.CahpsVendorBinding> {
    const [row] = await this.db.update(B).set(patch).where(eq(B.id, id)).returning();
    if (!row) throw new Error(`cahps_vendor_binding ${id} not found for update`);
    return row;
  }

  // ── cahps_decedent_sample (PARTITIONED monthly by sampling_cycle_month) ──────────────────────────

  /** Insert a sampled-decedent row (defaults to `pending_export`). Returns the inserted row. */
  async insertDecedentSample(
    values: schema.NewCahpsDecedentSample,
  ): Promise<schema.CahpsDecedentSample> {
    const [row] = await this.db.insert(S).values(values).returning();
    if (!row) throw new Error("cahps_decedent_sample insert returned no row");
    return row;
  }

  /** Point read by the composite PK (id + sampling_cycle_month, the partition key), or `null`. */
  async findSampleById(
    id: string,
    samplingCycleMonth: string,
  ): Promise<schema.CahpsDecedentSample | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(and(eq(S.id, id), eq(S.samplingCycleMonth, samplingCycleMonth)))
      .limit(1);
    return row ?? null;
  }

  /** A cycle's sampling roster (optionally narrowed by export status), newest-created first. */
  async listSamplesForCycle(
    organizationId: string,
    samplingCycleMonth: string,
    status?: schema.CahpsDecedentSample["status"],
  ): Promise<readonly schema.CahpsDecedentSample[]> {
    const where = and(
      eq(S.organizationId, organizationId),
      eq(S.samplingCycleMonth, samplingCycleMonth),
      status ? eq(S.status, status) : undefined,
    );
    return this.db.select().from(S).where(where).orderBy(desc(S.createdAt));
  }

  /** The vendor-export worklist: an org's samples in a given status, oldest-created first. */
  async listSamplesByStatus(
    organizationId: string,
    status: schema.CahpsDecedentSample["status"],
    limit = 100,
  ): Promise<readonly schema.CahpsDecedentSample[]> {
    return this.db
      .select()
      .from(S)
      .where(and(eq(S.organizationId, organizationId), eq(S.status, status)))
      .orderBy(S.createdAt)
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /** Transition a sample's export status, stamping the export / vendor-ack telemetry. Composite PK. */
  async updateSampleExportStatus(
    id: string,
    samplingCycleMonth: string,
    patch: Partial<
      Pick<
        schema.NewCahpsDecedentSample,
        "status" | "exportedAt" | "vendorAckRef" | "vendorAckedAt" | "exclusionReason"
      >
    >,
  ): Promise<schema.CahpsDecedentSample> {
    const [row] = await this.db
      .update(S)
      .set(patch)
      .where(and(eq(S.id, id), eq(S.samplingCycleMonth, samplingCycleMonth)))
      .returning();
    if (!row) throw new Error(`cahps_decedent_sample ${id}@${samplingCycleMonth} not found for update`);
    return row;
  }

  // ── cahps_result_summary ─────────────────────────────────────────────────────────────────────

  /** Insert an ingested result summary. Returns the inserted row. */
  async insertResultSummary(
    values: schema.NewCahpsResultSummary,
  ): Promise<schema.CahpsResultSummary> {
    const [row] = await this.db.insert(R).values(values).returning();
    if (!row) throw new Error("cahps_result_summary insert returned no row");
    return row;
  }

  /** Fetch a result summary by id, or `null`. */
  async findResultById(id: string): Promise<schema.CahpsResultSummary | null> {
    const [row] = await this.db.select().from(R).where(eq(R.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The idempotency probe (the `uq_cahps_result_idempotent` surface): the already-ingested row for a
   * (provider, vendor, period, payload-hash) tuple, or `null` — so a redelivered vendor payload no-ops.
   */
  async findResultIdempotent(
    providerEntityId: string,
    vendorAdapterId: string,
    reportingPeriodStart: string,
    reportingPeriodEnd: string,
    vendorResponsePayloadHash: string,
  ): Promise<schema.CahpsResultSummary | null> {
    const [row] = await this.db
      .select()
      .from(R)
      .where(
        and(
          eq(R.providerEntityId, providerEntityId),
          eq(R.vendorAdapterId, vendorAdapterId),
          eq(R.reportingPeriodStart, reportingPeriodStart),
          eq(R.reportingPeriodEnd, reportingPeriodEnd),
          eq(R.vendorResponsePayloadHash, vendorResponsePayloadHash),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** A provider's ingested results, newest reporting period first. */
  async listResultsForProvider(
    organizationId: string,
    providerEntityId: string,
    limit = 50,
  ): Promise<readonly schema.CahpsResultSummary[]> {
    return this.db
      .select()
      .from(R)
      .where(and(eq(R.organizationId, organizationId), eq(R.providerEntityId, providerEntityId)))
      .orderBy(desc(R.reportingPeriodEnd))
      .limit(Math.min(Math.max(limit, 1), 200));
  }
}
