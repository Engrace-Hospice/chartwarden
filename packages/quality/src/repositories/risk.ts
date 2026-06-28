// @wardenx/quality · repositories — the unified risk-register source loader (M30 §7.9 / D13). The risk
// register is the UNION of four open-risk sources (open SRA findings ≥ medium residual, open incidents
// ≥ moderate, corrective-action QAPI projects, non-compliant CoP citations). In production this is the
// `risk_register_view` MATERIALIZED VIEW (migration-owned, refreshed CONCURRENTLY off a NON-tx primary
// pool — NOT this port's job). This repo backs the IN-PROCESS projection path: it loads the candidate
// open-risk rows from the four base tables so the pure `buildRiskRegister(sources)` (in @wardenx/quality)
// can shape + band + sort them. ORG-SCOPED; the register read worker wraps these in `withOrgContext`.
//
// The SQL predicates here are deliberately BROADER-OR-EQUAL than the pure open-risk predicates (e.g. no
// residual-score floor on SRA findings): the authoritative inclusion test stays in `buildRiskRegister`,
// so SQL and the in-process projection cannot drift. The candidate filters only prune obviously-closed rows.
import { schema } from "@wardenx/db";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { RiskRegisterSources } from "../risk_register/refresh";
import type { QualityDb } from "./db";

const FN = schema.sraFinding;
const I = schema.incidentReport;
const PRJ = schema.qapiProject;
const COP = schema.copComplianceStatus;

/** Read port over the four risk-register source tables (D13). */
export class RiskRegisterRepository {
  constructor(private readonly db: QualityDb) {}

  /**
   * Load the four candidate open-risk source collections for an org — the input to the pure
   * `buildRiskRegister(sources)`. Each collection is pruned to obvious open candidates in SQL; the
   * authoritative open-risk predicate runs in the projection.
   */
  async loadOpenRiskSources(organizationId: string): Promise<RiskRegisterSources> {
    const [sraFindings, incidents, qapiProjects, copStatuses] = await Promise.all([
      this.db
        .select()
        .from(FN)
        .where(
          and(
            eq(FN.organizationId, organizationId),
            notInArray(FN.status, ["mitigated", "accepted_risk"]),
          ),
        ),
      this.db
        .select()
        .from(I)
        .where(
          and(
            eq(I.organizationId, organizationId),
            notInArray(I.lifecycle, ["closed_followup_complete"]),
          ),
        ),
      this.db
        .select()
        .from(PRJ)
        .where(and(eq(PRJ.organizationId, organizationId), eq(PRJ.status, "corrective_action"))),
      this.db
        .select()
        .from(COP)
        .where(
          and(
            eq(COP.organizationId, organizationId),
            inArray(COP.status, ["at_risk", "deficient"]),
          ),
        ),
    ]);
    return { sraFindings, incidents, qapiProjects, copStatuses };
  }
}
