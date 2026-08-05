// @wardenx/saas-tenant-platform · repositories — `tenant_key_ring` (+ `tenant_key_destruction_log`)
// data port (M34 §3.5).
//
// The key ring holds the per-tenant DEK ciphertext wrapped by the platform KEK (the `TenantKeyProvider`
// seam M1's envelope-helper reads through, D5) and the monotonic version label; the destruction log is
// the forensic, append-only phase trail the four-phase cryptographic-shred worker writes (§3.5).
//
// IMPORTANT boundary: this repo NEVER nulls `currentDekKekWrappedCiphertext` / `priorDekVersions`.
// The irreversible DEK destruction is performed ONLY by the `m34_destroy_tenant_key_ring(...)`
// SECURITY DEFINER function (run as `tenant_platform_writer`); the table grants block any other path.
// The shred service calls that function via `db.execute(sql\`SELECT m34_destroy_tenant_key_ring(...)\`)`
// and uses THIS repo only for the metadata reads and the per-phase log inserts around it.
import { type DbClient, schema } from "@wardenx/db";
import { and, desc, eq } from "drizzle-orm";

const KR = schema.tenantKeyRing;
const LOG = schema.tenantKeyDestructionLog;

/** The §3.5 destruction phases recorded on `tenant_key_destruction_log.destructionPhase` (text). */
export type DestructionPhase =
  | "module_erasers_complete"
  | "dek_destruction_aborted_part_two_retention"
  | "minio_scope_destroyed"
  | "deks_zeroized"
  | "certificate_filed";

/** Data port for the per-tenant key ring + its destruction-phase log. */
export class TenantKeyRingRepository {
  constructor(private readonly db: DbClient) {}

  // ── tenant_key_ring ───────────────────────────────────────────────────────────────────────

  /** Create the tenant's key ring at provisioning (DEK ciphertext + version 'v1'). */
  async create(values: schema.NewTenantKeyRing): Promise<schema.TenantKeyRing> {
    const [row] = await this.db.insert(KR).values(values).returning();
    if (!row) throw new Error("tenant_key_ring insert returned no row");
    return row;
  }

  /** Fetch the key ring by id, or `null`. */
  async findById(id: string): Promise<schema.TenantKeyRing | null> {
    const [row] = await this.db.select().from(KR).where(eq(KR.id, id)).limit(1);
    return row ?? null;
  }

  /** Fetch the single key ring for a tenant_account (1:1), or `null`. */
  async findByTenantAccountId(tenantAccountId: string): Promise<schema.TenantKeyRing | null> {
    const [row] = await this.db
      .select()
      .from(KR)
      .where(eq(KR.tenantAccountId, tenantAccountId))
      .limit(1);
    return row ?? null;
  }

  /** Fetch the single key ring for an organization (1:1, the org-unique index), or `null`. */
  async findByOrganizationId(organizationId: string): Promise<schema.TenantKeyRing | null> {
    const [row] = await this.db
      .select()
      .from(KR)
      .where(eq(KR.organizationId, organizationId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Record a DEK rotation: bump `currentDekVersion`, replace the wrapped ciphertext + KEK id, append
   * the prior version to `priorDekVersions`, and stamp `dekLastRotatedAt`. NOT the destruction path —
   * destruction is the SECURITY DEFINER function (see file header).
   */
  async recordRotation(
    id: string,
    patch: Pick<
      schema.NewTenantKeyRing,
      | "currentDekVersion"
      | "currentDekKekWrappedCiphertext"
      | "currentDekKekId"
      | "priorDekVersions"
      | "dekLastRotatedAt"
    >,
  ): Promise<schema.TenantKeyRing> {
    const [row] = await this.db.update(KR).set(patch).where(eq(KR.id, id)).returning();
    if (!row) throw new Error(`tenant_key_ring ${id} not found for rotation`);
    return row;
  }

  /**
   * Stamp the post-destruction forensic fields (destroyedAt / destroyedByMembershipId /
   * destructionCertificateId). The DEK-ciphertext nulling itself is done by the SECURITY DEFINER
   * function; this records the operator + certificate linkage.
   */
  async recordDestructionMetadata(
    id: string,
    patch: Pick<
      schema.NewTenantKeyRing,
      "destroyedAt" | "destroyedByMembershipId" | "destructionCertificateId"
    >,
  ): Promise<schema.TenantKeyRing> {
    const [row] = await this.db.update(KR).set(patch).where(eq(KR.id, id)).returning();
    if (!row) throw new Error(`tenant_key_ring ${id} not found for destruction metadata`);
    return row;
  }

  // ── tenant_key_destruction_log ──────────────────────────────────────────────────────────────

  /** Append a destruction-phase log row (one per phase the shred worker completes). */
  async appendDestructionLog(
    values: schema.NewTenantKeyDestructionLog,
  ): Promise<schema.TenantKeyDestructionLog> {
    const [row] = await this.db.insert(LOG).values(values).onConflictDoNothing().returning();
    if (row) return row;
    const [existing] = await this.db
      .select()
      .from(LOG)
      .where(
        and(
          eq(LOG.tenantKeyRingId, values.tenantKeyRingId),
          eq(LOG.destructionCertificateId, values.destructionCertificateId),
          eq(LOG.destructionPhase, values.destructionPhase),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("tenant_key_destruction_log insert returned no row");
    return existing;
  }

  /** The destruction-phase trail for a key ring, newest-first (forensic reconstruction). */
  async listDestructionLog(
    tenantKeyRingId: string,
    destructionCertificateId: string,
  ): Promise<readonly schema.TenantKeyDestructionLog[]> {
    return this.db
      .select()
      .from(LOG)
      .where(
        and(
          eq(LOG.tenantKeyRingId, tenantKeyRingId),
          eq(LOG.destructionCertificateId, destructionCertificateId),
        ),
      )
      .orderBy(desc(LOG.occurredAt));
  }
}
