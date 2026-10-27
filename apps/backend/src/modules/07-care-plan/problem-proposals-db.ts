// apps/backend/src/modules/07-care-plan/problem-proposals-db.ts — F-238 dx-writeback: the clinician side of
// DocLens problem PROPOSALS (list / accept / dismiss), over Drizzle + RLS.
//
// A proposal (M7 `problem_proposal`, written by the `m7.extraction-diagnosis-writeback` consumer) is NOT a
// problem. ACCEPT is the explicit clinician act AI Governance §2.1.1 requires: in one transaction it inserts
// the real `problem` row — `source = 'intake_extraction'` (the visible AI-assisted provenance label),
// `status = 'active'`, `kind` CHOSEN BY THE CLINICIAN (never derived from the document's role label),
// `added_by_membership_id` = the accepting clinician — marks the proposal `accepted` with the link, and emits
// `m7.problem.added`. DISMISS marks it `dismissed`; nothing is charted. Only a `pending` proposal can be
// decided (409 otherwise); `ifVersion` is the §7.7 optimistic-concurrency token (412 on skew).
//
// §7.6 Part 2: a `sud_related` proposal is invisible to a caller without SUD disclosure — it is omitted from
// the list (`redacted: true`) and accept/dismiss answer the non-leaking 404, exactly like a SUD problem.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  NotFoundError,
  type ProblemKind,
  ValidationError,
  normalizeIcd10CmShape,
} from "@chartwarden/types";
import { and, asc, eq, sql } from "drizzle-orm";
import type { CarePlanWriteOutboxPort } from "./care-plan-route-service-db";
import { CarePlanStateError } from "./lifecycle/errors";
import { checkOptimisticConcurrency } from "./lifecycle/validation";

const CP = schema.carePlans;
const PROB = schema.problems;
const PP = schema.problemProposals;

type ProposalRow = typeof PP.$inferSelect;

export interface ProblemProposalView {
  readonly id: string;
  readonly carePlanId: string;
  readonly description: string;
  readonly icd10Code: string | null;
  readonly icd10Source: "document" | "reviewer_edit" | null;
  readonly icd10Validation: "valid" | "not_valid_as_of" | "unvalidated" | null;
  readonly documentRole: "principal" | "secondary" | "history" | "unspecified";
  readonly sudRelated: boolean;
  readonly status: "pending" | "accepted" | "dismissed";
  readonly duplicateOfProblemId: string | null;
  readonly acceptedProblemId: string | null;
  readonly sourceIntakeBatchId: string;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

/** The acting clinician (route-resolved from the session; never the body). */
export interface ProposalActor {
  readonly userId: string;
  readonly membershipId: string;
  /** §7.6 — may this caller see SUD-flagged content for the plan's patient? */
  readonly sudDisclosureAllowed: boolean;
}

export interface ProblemProposalService {
  list(
    org: string,
    planId: string,
    opts: {
      readonly status?: "pending" | "accepted" | "dismissed";
      readonly sudDisclosureAllowed: boolean;
    },
  ): Promise<{ proposals: ProblemProposalView[]; redacted: boolean }>;
  accept(
    org: string,
    planId: string,
    proposalId: string,
    body: {
      readonly ifVersion: number;
      readonly kind: ProblemKind;
      readonly icd10Code?: string | null;
    },
    actor: ProposalActor,
  ): Promise<{ proposalId: string; problemId: string; status: "accepted"; version: number }>;
  dismiss(
    org: string,
    planId: string,
    proposalId: string,
    body: { readonly ifVersion: number; readonly reason?: string },
    actor: ProposalActor,
  ): Promise<{ proposalId: string; status: "dismissed"; version: number }>;
}

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

function view(r: ProposalRow): ProblemProposalView {
  return {
    id: r.id,
    carePlanId: r.carePlanId,
    description: r.description,
    icd10Code: r.icd10Code ?? null,
    icd10Source: (r.icd10Source as ProblemProposalView["icd10Source"]) ?? null,
    icd10Validation: r.icd10Validation ?? null,
    documentRole: r.documentRole,
    sudRelated: r.sudRelated,
    status: r.status,
    duplicateOfProblemId: r.duplicateOfProblemId ?? null,
    acceptedProblemId: r.acceptedProblemId ?? null,
    sourceIntakeBatchId: r.sourceIntakeBatchId,
    decidedAt: iso(r.decidedAt),
    createdAt: iso(r.createdAt) as string,
    version: Number(r.version),
  };
}

const NOOP_OUTBOX: CarePlanWriteOutboxPort = { async publish() {} };

export function createDbProblemProposalService(
  db: DbClient,
  outbox: CarePlanWriteOutboxPort = NOOP_OUTBOX,
): ProblemProposalService {
  /** Load + lock a PENDING proposal the caller may see, on a writable plan. */
  async function loadDecidable(
    tx: DbClient,
    planId: string,
    proposalId: string,
    ifVersion: number,
    actor: ProposalActor,
  ): Promise<{ row: ProposalRow; plan: typeof CP.$inferSelect }> {
    const [plan] = await tx.select().from(CP).where(eq(CP.id, planId)).limit(1);
    if (!plan) throw new NotFoundError("care_plan", planId);
    const [row] = await tx
      .select()
      .from(PP)
      .where(and(eq(PP.id, proposalId), eq(PP.carePlanId, planId)))
      .for("update");
    // §7.6 — a SUD proposal the caller may not see does not exist for them.
    if (!row || (row.sudRelated && !actor.sudDisclosureAllowed)) {
      throw new NotFoundError("problem_proposal", proposalId);
    }
    if (plan.status === "discharged") {
      throw new CarePlanStateError("CARE_PLAN_CLOSED", "discharged care plans cannot be mutated");
    }
    if (row.status !== "pending") {
      throw new ChartWardenError(
        "PROPOSAL_NOT_PENDING",
        `this proposed problem was already ${row.status}`,
        409,
      );
    }
    checkOptimisticConcurrency(ifVersion, Number(row.version));
    return { row, plan };
  }

  return {
    async list(org, planId, opts) {
      return withOrgContext(db, { organizationId: org, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [plan] = await t.select({ id: CP.id }).from(CP).where(eq(CP.id, planId)).limit(1);
        if (!plan) throw new NotFoundError("care_plan", planId);
        const rows = await t
          .select()
          .from(PP)
          .where(
            and(
              eq(PP.carePlanId, planId),
              ...(opts.status ? [eq(PP.status, opts.status)] : []),
              // §7.6 — SQL-level, not a post-fetch hide.
              ...(opts.sudDisclosureAllowed ? [] : [eq(PP.sudRelated, false)]),
            ),
          )
          .orderBy(asc(PP.createdAt), asc(PP.id));
        let redacted = false;
        if (!opts.sudDisclosureAllowed) {
          const [hidden] = await t
            .select({ n: sql<number>`count(*)::int` })
            .from(PP)
            .where(
              and(
                eq(PP.carePlanId, planId),
                eq(PP.sudRelated, true),
                ...(opts.status ? [eq(PP.status, opts.status)] : []),
              ),
            );
          redacted = Number(hidden?.n ?? 0) > 0;
        }
        return { proposals: rows.map(view), redacted };
      });
    },

    async accept(org, planId, proposalId, body, actor) {
      let code: string | null | undefined;
      if (body.icd10Code !== undefined && body.icd10Code !== null) {
        code = normalizeIcd10CmShape(body.icd10Code);
        if (code === null) {
          throw new ValidationError("request validation failed", [
            { field: "icd10Code", code: "INVALID", message: "not an ICD-10-CM code" },
          ]);
        }
      } else if (body.icd10Code === null) {
        code = null;
      }
      return withOrgContext(db, { organizationId: org, userId: actor.userId }, async (tx) => {
        const t = tx as unknown as DbClient;
        const { row, plan } = await loadDecidable(t, planId, proposalId, body.ifVersion, actor);
        const [problem] = await t
          .insert(PROB)
          .values({
            organizationId: org,
            carePlanId: planId,
            providerEntityId: plan.providerEntityId,
            locationId: plan.locationId,
            icd10Code: code === undefined ? row.icd10Code : code,
            description: row.description,
            kind: body.kind,
            source: "intake_extraction",
            sudRelated: row.sudRelated,
            status: "active",
            addedByMembershipId: actor.membershipId,
          })
          .returning({ id: PROB.id, status: PROB.status });
        if (!problem) throw new Error("problem insert returned no row");
        const [updated] = await t
          .update(PP)
          .set({
            status: "accepted",
            acceptedProblemId: problem.id,
            decidedByMembershipId: actor.membershipId,
            decidedAt: new Date(),
            version: sql`${PP.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(PP.id, proposalId), eq(PP.version, body.ifVersion)))
          .returning({ version: PP.version });
        if (!updated) throw new CarePlanStateError("STALE_VERSION", "stale proposal write");
        await outbox.publish(t, {
          eventName: "m7.problem.added",
          payload: {
            planId,
            problemId: problem.id,
            status: problem.status,
            // FY2027 — M6's election-addendum consumer keys on the admission + relatedness (418.24(d)(2)).
            admissionId: plan.admissionId,
            kind: body.kind,
          },
          organizationId: org,
          aggregateKind: "problem",
          aggregateId: problem.id,
        });
        return {
          proposalId,
          problemId: problem.id,
          status: "accepted" as const,
          version: Number(updated.version),
        };
      });
    },

    async dismiss(org, planId, proposalId, body, actor) {
      return withOrgContext(db, { organizationId: org, userId: actor.userId }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadDecidable(t, planId, proposalId, body.ifVersion, actor);
        const [updated] = await t
          .update(PP)
          .set({
            status: "dismissed",
            decidedByMembershipId: actor.membershipId,
            decidedAt: new Date(),
            dismissReason: body.reason ?? null,
            version: sql`${PP.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(PP.id, proposalId), eq(PP.version, body.ifVersion)))
          .returning({ version: PP.version });
        if (!updated) throw new CarePlanStateError("STALE_VERSION", "stale proposal write");
        return { proposalId, status: "dismissed" as const, version: Number(updated.version) };
      });
    },
  };
}
