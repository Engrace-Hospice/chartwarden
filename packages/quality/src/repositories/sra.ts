// @wardenx/quality · repositories — the SRA subdomain (annual HIPAA Security Risk Assessment, NIST
// 800-66r2): `sra_cycle` (the annual cycle, ≤1 per (org, cycle_year), dual-cosign closure + reopen
// trail), its children `sra_finding` (5×5-scored findings, sequential per cycle), and `sra_remediation`
// (remediation actions, evidence-gated completion) (M30 §3.3). ORG-SCOPED; the SRA service wraps these
// in `withOrgContext` and owns the lifecycle/cosign guards (the pure reducer lives in @wardenx/quality).
// Vulnerability / impact / remediation narratives are security-posture sensitive + audit-denylisted (§3.6).
import { schema } from "@wardenx/db";
import { and, desc, eq, max, notInArray } from "drizzle-orm";
import type { QualityDb } from "./db";

const CY = schema.sraCycle;
const FN = schema.sraFinding;
const RM = schema.sraRemediation;

/** Data port for the three SRA tables (cycle · finding · remediation). */
export class SraRepository {
  constructor(private readonly db: QualityDb) {}

  // ── sra_cycle ──────────────────────────────────────────────────────────────────────────────────

  async createCycle(values: schema.NewSraCycle): Promise<schema.SraCycle> {
    const [row] = await this.db.insert(CY).values(values).returning();
    if (!row) throw new Error("sra_cycle insert returned no row");
    return row;
  }

  async findCycleById(id: string): Promise<schema.SraCycle | null> {
    const [row] = await this.db.select().from(CY).where(eq(CY.id, id)).limit(1);
    return row ?? null;
  }

  /** The single cycle for a year (the `uq_sra_cycle_year` surface), or `null`. */
  async findCycleByYear(
    organizationId: string,
    cycleYear: number,
  ): Promise<schema.SraCycle | null> {
    const [row] = await this.db
      .select()
      .from(CY)
      .where(and(eq(CY.organizationId, organizationId), eq(CY.cycleYear, cycleYear)))
      .limit(1);
    return row ?? null;
  }

  /** An org's cycles (optionally narrowed by status), newest cycle year first. */
  async listCycles(
    organizationId: string,
    status?: schema.SraCycle["status"],
  ): Promise<readonly schema.SraCycle[]> {
    const where = and(
      eq(CY.organizationId, organizationId),
      status ? eq(CY.status, status) : undefined,
    );
    return this.db.select().from(CY).where(where).orderBy(desc(CY.cycleYear));
  }

  async updateCycle(
    id: string,
    patch: Partial<
      Pick<
        schema.NewSraCycle,
        | "status"
        | "cosignSecurityOfficerAt"
        | "cosignSecurityOfficerMembershipId"
        | "cosignComplianceOfficerAt"
        | "cosignComplianceOfficerMembershipId"
        | "closedAt"
        | "reopenedAt"
        | "reopenReason"
        | "reopenCount"
        | "documentId"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.SraCycle> {
    const [row] = await this.db.update(CY).set(patch).where(eq(CY.id, id)).returning();
    if (!row) throw new Error(`sra_cycle ${id} not found for update`);
    return row;
  }

  // ── sra_finding ──────────────────────────────────────────────────────────────────────────────

  async createFinding(values: schema.NewSraFinding): Promise<schema.SraFinding> {
    const [row] = await this.db.insert(FN).values(values).returning();
    if (!row) throw new Error("sra_finding insert returned no row");
    return row;
  }

  async findFindingById(id: string): Promise<schema.SraFinding | null> {
    const [row] = await this.db.select().from(FN).where(eq(FN.id, id)).limit(1);
    return row ?? null;
  }

  /** A cycle's findings (optionally narrowed by status), by ascending finding number. */
  async listFindings(
    sraCycleId: string,
    status?: schema.SraFinding["status"],
  ): Promise<readonly schema.SraFinding[]> {
    const where = and(
      eq(FN.sraCycleId, sraCycleId),
      status ? eq(FN.status, status) : undefined,
    );
    return this.db.select().from(FN).where(where).orderBy(FN.findingNumber);
  }

  /**
   * An org's still-open findings (not `mitigated`/`accepted_risk`) — the risk-register source the worker
   * filters further on residual score (D13).
   */
  async listOpenFindingsForOrg(organizationId: string): Promise<readonly schema.SraFinding[]> {
    return this.db
      .select()
      .from(FN)
      .where(
        and(
          eq(FN.organizationId, organizationId),
          notInArray(FN.status, ["mitigated", "accepted_risk"]),
        ),
      )
      .orderBy(desc(FN.residual5x5Score));
  }

  /** The highest finding number in a cycle (for sequential numbering); `0` when the cycle has none. */
  async highestFindingNumber(sraCycleId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: max(FN.findingNumber) })
      .from(FN)
      .where(eq(FN.sraCycleId, sraCycleId));
    return row?.value ?? 0;
  }

  async updateFinding(
    id: string,
    patch: Partial<
      Pick<
        schema.NewSraFinding,
        | "threatDescription"
        | "vulnerabilityDescription"
        | "impactDescription"
        | "affectedAssetCategory"
        | "inherent5x5Score"
        | "residual5x5Score"
        | "status"
        | "acceptedRiskAttestationAt"
        | "acceptedRiskAttestationMembershipId"
        | "acceptedRiskAutoReopenAt"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.SraFinding> {
    const [row] = await this.db.update(FN).set(patch).where(eq(FN.id, id)).returning();
    if (!row) throw new Error(`sra_finding ${id} not found for update`);
    return row;
  }

  // ── sra_remediation ──────────────────────────────────────────────────────────────────────────

  async createRemediation(values: schema.NewSraRemediation): Promise<schema.SraRemediation> {
    const [row] = await this.db.insert(RM).values(values).returning();
    if (!row) throw new Error("sra_remediation insert returned no row");
    return row;
  }

  async findRemediationById(id: string): Promise<schema.SraRemediation | null> {
    const [row] = await this.db.select().from(RM).where(eq(RM.id, id)).limit(1);
    return row ?? null;
  }

  /** A finding's remediation actions, by ascending remediation number. */
  async listRemediations(sraFindingId: string): Promise<readonly schema.SraRemediation[]> {
    return this.db
      .select()
      .from(RM)
      .where(eq(RM.sraFindingId, sraFindingId))
      .orderBy(RM.remediationNumber);
  }

  /** The highest remediation number for a finding (for sequential numbering); `0` when none. */
  async highestRemediationNumber(sraFindingId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: max(RM.remediationNumber) })
      .from(RM)
      .where(eq(RM.sraFindingId, sraFindingId));
    return row?.value ?? 0;
  }

  async updateRemediation(
    id: string,
    patch: Partial<
      Pick<
        schema.NewSraRemediation,
        | "ownerMembershipId"
        | "descriptionText"
        | "targetDate"
        | "status"
        | "completedAt"
        | "evidenceDocumentId"
        | "abandonReason"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.SraRemediation> {
    const [row] = await this.db.update(RM).set(patch).where(eq(RM.id, id)).returning();
    if (!row) throw new Error(`sra_remediation ${id} not found for update`);
    return row;
  }
}
