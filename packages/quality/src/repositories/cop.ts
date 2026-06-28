// @wardenx/quality · repositories — the CoP-citation compliance posture: `cop_compliance_status` (the
// self-assessed Condition-of-Participation status per (provider_entity, CoP citation), with evidence
// document refs + a six-month review cadence) (M30 §3.3, §7.7). ORG-SCOPED; the CoP service wraps these
// in `withOrgContext`. No PHI; no audit denylist.
import { schema } from "@wardenx/db";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { QualityDb } from "./db";

const C = schema.copComplianceStatus;

/** Data port for `cop_compliance_status`. */
export class CopComplianceRepository {
  constructor(private readonly db: QualityDb) {}

  async create(values: schema.NewCopComplianceStatus): Promise<schema.CopComplianceStatus> {
    const [row] = await this.db.insert(C).values(values).returning();
    if (!row) throw new Error("cop_compliance_status insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.CopComplianceStatus | null> {
    const [row] = await this.db.select().from(C).where(eq(C.id, id)).limit(1);
    return row ?? null;
  }

  /** The single status for a (provider_entity, citation) (the `uq_cop_compliance_citation` surface), or `null`. */
  async findByCitation(
    providerEntityId: string,
    copCitation: string,
  ): Promise<schema.CopComplianceStatus | null> {
    const [row] = await this.db
      .select()
      .from(C)
      .where(and(eq(C.providerEntityId, providerEntityId), eq(C.copCitation, copCitation)))
      .limit(1);
    return row ?? null;
  }

  /** A provider's compliance posture across all citations, by citation. */
  async listForProvider(
    organizationId: string,
    providerEntityId: string,
  ): Promise<readonly schema.CopComplianceStatus[]> {
    return this.db
      .select()
      .from(C)
      .where(and(eq(C.organizationId, organizationId), eq(C.providerEntityId, providerEntityId)))
      .orderBy(asc(C.copCitation));
  }

  /**
   * An org's non-compliant citations (`at_risk` / `deficient`) — the risk-register source (D13),
   * worst-first.
   */
  async listNonCompliant(organizationId: string): Promise<readonly schema.CopComplianceStatus[]> {
    return this.db
      .select()
      .from(C)
      .where(
        and(
          eq(C.organizationId, organizationId),
          inArray(C.status, ["at_risk", "deficient"]),
        ),
      )
      .orderBy(desc(C.updatedAt));
  }

  /** The review-cadence worklist: citations whose `next_review_due_at <= asOf`, oldest-due first. */
  async listDueForReview(
    organizationId: string,
    asOf: Date = new Date(),
  ): Promise<readonly schema.CopComplianceStatus[]> {
    return this.db
      .select()
      .from(C)
      .where(and(eq(C.organizationId, organizationId), lte(C.nextReviewDueAt, asOf)))
      .orderBy(asc(C.nextReviewDueAt));
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewCopComplianceStatus,
        | "status"
        | "evidenceDocumentIds"
        | "selfAssessmentNotes"
        | "lastReviewedAt"
        | "lastReviewedByMembershipId"
        | "nextReviewDueAt"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.CopComplianceStatus> {
    const [row] = await this.db.update(C).set(patch).where(eq(C.id, id)).returning();
    if (!row) throw new Error(`cop_compliance_status ${id} not found for update`);
    return row;
  }
}
