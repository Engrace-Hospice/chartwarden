// @chartwarden/cost-report · repositories — the submission record: `ecr_submission` (one row per submission
// attempt; ECR + PI files generated via M22 and the manual MCReF upload/acknowledgment; M27 holds the
// M22 document back-references — no MinIO code — D11) (M27 §3.3). ORG-SCOPED; the submission service wraps
// these in `withOrgContext` and owns the lifecycle (`generating → generated → uploaded → accepted |
// rejected`) + the snapshot binding. `mcref_acknowledgment_number` / `mcref_rejection_code` are mutually
// exclusive (DB CHECK). No PHI (D18) — the ECR file format carries no patient identifiers.
import { schema } from "@chartwarden/db";
import { and, desc, eq } from "drizzle-orm";
import type { CostReportDb } from "./db";

const E = schema.ecrSubmission;

/** Data port for `ecr_submission`. */
export class EcrSubmissionRepository {
  constructor(private readonly db: CostReportDb) {}

  async create(values: schema.NewEcrSubmission): Promise<schema.EcrSubmission> {
    const [row] = await this.db.insert(E).values(values).returning();
    if (!row) throw new Error("ecr_submission insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.EcrSubmission | null> {
    const [row] = await this.db.select().from(E).where(eq(E.id, id)).limit(1);
    return row ?? null;
  }

  /** A report's submission attempts (§3.4 `idx_ecr_org_report_status`), newest-generated first. */
  async listForReport(
    organizationId: string,
    costReportId: string,
  ): Promise<readonly schema.EcrSubmission[]> {
    return this.db
      .select()
      .from(E)
      .where(and(eq(E.organizationId, organizationId), eq(E.costReportId, costReportId)))
      .orderBy(desc(E.generatedAt));
  }

  /** The most-recent submission attempt for a report (the filing-status head — D11), or `null`. */
  async findLatestForReport(
    organizationId: string,
    costReportId: string,
  ): Promise<schema.EcrSubmission | null> {
    const [row] = await this.db
      .select()
      .from(E)
      .where(and(eq(E.organizationId, organizationId), eq(E.costReportId, costReportId)))
      .orderBy(desc(E.generatedAt))
      .limit(1);
    return row ?? null;
  }

  /** Advance a submission (artifact refs, status, MCReF ack/rejection, upload metadata). */
  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewEcrSubmission,
        | "ecrFileDocumentId"
        | "piFileDocumentId"
        | "supportingDocumentsDocumentIds"
        | "status"
        | "mcrefAcknowledgmentNumber"
        | "mcrefRejectionCode"
        | "mcrefRejectionDetail"
        | "uploadedByMembershipId"
        | "uploadedAt"
        | "acknowledgedAt"
      >
    >,
  ): Promise<schema.EcrSubmission> {
    const [row] = await this.db.update(E).set(patch).where(eq(E.id, id)).returning();
    if (!row) throw new Error(`ecr_submission ${id} not found for update`);
    return row;
  }
}
