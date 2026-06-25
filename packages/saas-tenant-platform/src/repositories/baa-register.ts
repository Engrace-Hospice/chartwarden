// @wardenx/saas-tenant-platform · repositories — platform-tenant BAA register: `platform_tenant_baa_record`
// (M34 §3.8).
//
// The platform → tenant Business Associate Agreement register (D11) — DISTINCT from M40's tenant →
// external BAA register. One row per (tenant_account, addendum_version): the executed/effective/expiry
// dates, breach-notification contacts, subcontractor disclosure set, compliance-officer attestation,
// and the M22 document id of the executed PDF. This repo inserts/updates the record and serves the
// expiry sweep that drives the BAA-expiry alert rules (§4.8).
import { type DbClient, schema } from "@wardenx/db";
import { asc, desc, eq, isNotNull } from "drizzle-orm";

const B = schema.platformTenantBaaRecord;

/** Data port for the platform-tenant BAA register. */
export class BaaRegisterRepository {
  constructor(private readonly db: DbClient) {}

  /** Insert a platform-tenant BAA record (one per (tenant_account, addendum_version), UNIQUE). */
  async create(values: schema.NewPlatformTenantBaaRecord): Promise<schema.PlatformTenantBaaRecord> {
    const [row] = await this.db.insert(B).values(values).returning();
    if (!row) throw new Error("platform_tenant_baa_record insert returned no row");
    return row;
  }

  /** Fetch a BAA record by id, or `null`. */
  async findById(id: string): Promise<schema.PlatformTenantBaaRecord | null> {
    const [row] = await this.db.select().from(B).where(eq(B.id, id)).limit(1);
    return row ?? null;
  }

  /** A tenant's BAA records (all addendum versions), newest-executed first. */
  async listByTenantAccountId(
    tenantAccountId: string,
  ): Promise<readonly schema.PlatformTenantBaaRecord[]> {
    return this.db
      .select()
      .from(B)
      .where(eq(B.tenantAccountId, tenantAccountId))
      .orderBy(desc(B.executedOn));
  }

  /** BAA records by status (e.g. all `pending` awaiting execution). */
  async listByStatus(
    baaStatus: schema.PlatformTenantBaaRecord["baaStatus"],
  ): Promise<readonly schema.PlatformTenantBaaRecord[]> {
    return this.db.select().from(B).where(eq(B.baaStatus, baaStatus));
  }

  /**
   * Records with an expiry date, soonest-expiring first — drives the BAA-expiry alert sweep
   * (`m34.baa.expiring_soon` / `m34.baa.expired`, §4.8).
   */
  async listByExpiry(): Promise<readonly schema.PlatformTenantBaaRecord[]> {
    return this.db.select().from(B).where(isNotNull(B.expiresOn)).orderBy(asc(B.expiresOn));
  }

  /**
   * Patch the BAA status / dates / contacts / disclosure set / attestation / document linkage.
   * Used for execution, termination, and compliance-officer attestation.
   */
  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewPlatformTenantBaaRecord,
        | "baaStatus"
        | "executedOn"
        | "effectiveOn"
        | "expiresOn"
        | "breachNotificationContactEmail"
        | "breachNotificationContactPhone"
        | "subcontractorDisclosureSet"
        | "complianceOfficerAttestationMembershipId"
        | "attestedAt"
        | "documentId"
      >
    >,
  ): Promise<schema.PlatformTenantBaaRecord> {
    const [row] = await this.db.update(B).set(patch).where(eq(B.id, id)).returning();
    if (!row) throw new Error(`platform_tenant_baa_record ${id} not found for update`);
    return row;
  }
}
