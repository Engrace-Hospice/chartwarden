// apps/backend/src/modules/41-billing-commercial/services/claim-read-service.ts — the read view of a commercial claim and the
// API projection of a validation run (issue #722). Ids, dates, codes, money and rule messages only: no member id, no
// authorization number, no patient name.
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { isBlocking } from "../domain/rules";
import { assertPatientReachable, assertProviderInScope, assertRowReachable } from "./scope-guard";
import type { CommercialActor, CommercialClaimSeams, CommercialDb, CommercialTx } from "./types";
import { type ValidationRunView, readPayerState } from "./validation-runner";

export interface ValidationRunApiView {
  readonly runId: string;
  readonly outcome: string;
  readonly results: readonly {
    readonly id: string;
    readonly ruleKey: string;
    readonly severity: string;
    readonly outcome: string;
    readonly overridable: boolean;
    readonly overridden: boolean;
    readonly blocking: boolean;
    readonly message: string;
  }[];
}

/** Drop the evidence and its hash: the API shows the decision, not the facts behind it. */
export function toRunApiView(run: ValidationRunView): ValidationRunApiView {
  return {
    runId: run.runId,
    outcome: run.outcome,
    results: run.results.map((r) => ({
      id: r.id,
      ruleKey: r.ruleKey,
      severity: r.severity,
      outcome: r.outcome,
      overridable: r.overridable,
      overridden: r.overridden,
      blocking: r.blocking,
      message: r.message,
    })),
  };
}

type ReadActor = Pick<CommercialActor, "organizationId" | "userId" | "billingScope">;

/** The work queue is one page; `hasMore` tells the screen to narrow its filters (no cursor yet). */
const QUEUE_PAGE_DEFAULT = 50;
const QUEUE_SCAN_FACTOR = 2;

export interface ClaimListFilter {
  readonly providerEntityId: string;
  readonly state?: string;
  readonly payerKind?: "commercial_only" | "medicare_secondary" | "medicaid_secondary";
  readonly patientId?: string;
  readonly limit?: number;
}

export interface PayerPlanView {
  readonly id: string;
  readonly payerId: string;
  readonly planName: string;
  readonly claimFilingIndicator: string;
  readonly authorizationRequirement: string;
  readonly authorizationLeadDays: number | null;
  readonly eligibilityStalenessPolicy: string;
  readonly eligibilityMaxAgeDays: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly payerStatus: string | null;
  readonly routes: readonly {
    readonly clearinghouseKey: string;
    readonly clearinghousePayerId: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
}

export interface CommercialClaimReadService {
  listClaims(
    actor: ReadActor,
    filter: ClaimListFilter,
  ): Promise<{ items: readonly Record<string, string | number | null>[]; hasMore: boolean }>;
  listPlans(
    actor: ReadActor,
    providerEntityId: string,
  ): Promise<{ items: readonly PayerPlanView[] }>;
  getClaim(
    actor: Pick<CommercialActor, "organizationId" | "userId" | "billingScope">,
    claimId: string,
  ): Promise<{
    plan: Record<string, string | null>;
    authorizations: readonly Record<string, string | null>[];
    claim: Record<string, string | number | null>;
    lines: readonly Record<string, string | number | null>[];
    validation: ValidationRunApiView | null;
  }>;
}

export function buildCommercialClaimReadService(
  db: CommercialDb,
  seams: Pick<CommercialClaimSeams, "caseload">,
): CommercialClaimReadService {
  const inOrg = <T>(actor: ReadActor, fn: (tx: CommercialTx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);
  return {
    async listClaims(actor, f) {
      assertProviderInScope(actor, f.providerEntityId);
      const limit = f.limit ?? QUEUE_PAGE_DEFAULT;
      const scan = limit * QUEUE_SCAN_FACTOR;
      const c = schema.commercialClaims;
      const conds = [
        eq(c.organizationId, actor.organizationId),
        eq(c.providerEntityId, f.providerEntityId),
      ];
      if (f.state) conds.push(eq(c.state, f.state));
      if (f.patientId) conds.push(eq(c.patientId, f.patientId));
      if (f.payerKind === "commercial_only") conds.push(isNull(c.secondaryPayerKind));
      if (f.payerKind === "medicare_secondary") conds.push(eq(c.secondaryPayerKind, "medicare"));
      if (f.payerKind === "medicaid_secondary") conds.push(eq(c.secondaryPayerKind, "medicaid"));
      const rows = await inOrg(actor, (tx) =>
        tx
          .select({ claim: c, planName: schema.commercialPayerPlan.planName })
          .from(c)
          .innerJoin(schema.commercialPayerPlan, eq(schema.commercialPayerPlan.id, c.planId))
          .where(and(...conds))
          .orderBy(desc(c.updatedAt), desc(c.id))
          .limit(scan + 1),
      );
      // Over-fetch so rows dropped by the caseload axis do not shrink the page below `limit`.
      const items: Record<string, string | number | null>[] = [];
      let hasMore = rows.length > scan;
      for (const { claim, planName } of rows.slice(0, scan)) {
        if (items.length === limit) {
          hasMore = true;
          break;
        }
        try {
          await assertPatientReachable(actor, seams.caseload, claim.patientId);
        } catch {
          continue; // outside the caseload: absent from the queue, never an error
        }
        items.push({
          id: claim.id,
          claimControlNumber: claim.claimControlNumber,
          state: claim.state,
          patientId: claim.patientId,
          planId: claim.planId,
          planName,
          tob: claim.tob,
          serviceFrom: claim.serviceFrom,
          serviceTo: claim.serviceTo,
          secondaryPayerKind: claim.secondaryPayerKind,
          totalChargeCents: claim.totalChargeCents,
          expectedPaymentCents: claim.expectedPaymentCents,
          updatedAt: claim.updatedAt.toISOString(),
        });
      }
      return { items, hasMore };
    },

    async listPlans(actor, providerEntityId) {
      assertProviderInScope(actor, providerEntityId);
      return inOrg(actor, async (tx) => {
        const plans = await tx
          .select()
          .from(schema.commercialPayerPlan)
          .where(eq(schema.commercialPayerPlan.organizationId, actor.organizationId))
          .orderBy(asc(schema.commercialPayerPlan.planName), asc(schema.commercialPayerPlan.id));
        const routes = await tx
          .select()
          .from(schema.commercialPayerRoute)
          .where(eq(schema.commercialPayerRoute.organizationId, actor.organizationId));
        const items: PayerPlanView[] = [];
        for (const p of plans) {
          const state = await readPayerState(tx, p.payerId);
          items.push({
            id: p.id,
            payerId: p.payerId,
            planName: p.planName,
            claimFilingIndicator: p.claimFilingIndicator,
            authorizationRequirement: p.authorizationRequirement,
            authorizationLeadDays: p.authorizationLeadDays,
            eligibilityStalenessPolicy: p.eligibilityStalenessPolicy,
            eligibilityMaxAgeDays: p.eligibilityMaxAgeDays,
            effectiveFrom: p.effectiveFrom,
            effectiveTo: p.effectiveTo,
            payerStatus: state?.status ?? null,
            routes: routes
              .filter((r) => r.planId === p.id)
              .map((r) => ({
                clearinghouseKey: r.clearinghouseKey,
                clearinghousePayerId: r.clearinghousePayerId,
                effectiveFrom: r.effectiveFrom,
                effectiveTo: r.effectiveTo,
              })),
          });
        }
        return { items };
      });
    },

    async getClaim(actor, claimId) {
      return withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const [c] = await tx
            .select()
            .from(schema.commercialClaims)
            .where(
              and(
                eq(schema.commercialClaims.id, claimId),
                eq(schema.commercialClaims.organizationId, actor.organizationId),
              ),
            );
          if (!c) throw new NotFoundError("commercial claim");
          await assertRowReachable(actor, seams.caseload, c);
          const [plan] = await tx
            .select()
            .from(schema.commercialPayerPlan)
            .where(
              and(
                eq(schema.commercialPayerPlan.id, c.planId),
                eq(schema.commercialPayerPlan.organizationId, actor.organizationId),
              ),
            );
          if (!plan) throw new NotFoundError("payer plan");
          const payerState = await readPayerState(tx, plan.payerId);
          // Authorizations of this entity, patient and plan that touch the claim window. No authorization NUMBER leaves the server.
          const auths = await tx
            .select()
            .from(schema.commercialAuthorizations)
            .where(
              and(
                eq(schema.commercialAuthorizations.organizationId, actor.organizationId),
                eq(schema.commercialAuthorizations.providerEntityId, c.providerEntityId),
                eq(schema.commercialAuthorizations.patientId, c.patientId),
                eq(schema.commercialAuthorizations.planId, c.planId),
                lte(schema.commercialAuthorizations.effectiveFrom, c.serviceTo),
                or(
                  isNull(schema.commercialAuthorizations.effectiveTo),
                  gte(schema.commercialAuthorizations.effectiveTo, c.serviceFrom),
                ),
              ),
            )
            .orderBy(asc(schema.commercialAuthorizations.effectiveFrom));
          const lines = await tx
            .select()
            .from(schema.commercialClaimLines)
            .where(eq(schema.commercialClaimLines.claimId, c.id))
            .orderBy(asc(schema.commercialClaimLines.lineNumber));
          let validation: ValidationRunApiView | null = null;
          if (c.latestValidationRunId) {
            const results = await tx
              .select()
              .from(schema.commercialValidationResults)
              .where(
                eq(schema.commercialValidationResults.validationRunId, c.latestValidationRunId),
              );
            const [run] = await tx
              .select({ outcome: schema.commercialValidationRuns.outcome })
              .from(schema.commercialValidationRuns)
              .where(eq(schema.commercialValidationRuns.id, c.latestValidationRunId));
            const overrides = await tx
              .select({
                ruleKey: schema.commercialValidationOverrides.ruleKey,
                evidenceHash: schema.commercialValidationOverrides.evidenceHash,
              })
              .from(schema.commercialValidationOverrides)
              .where(eq(schema.commercialValidationOverrides.claimId, c.id));
            const overridden = new Set(overrides.map((o) => `${o.ruleKey}:${o.evidenceHash}`));
            validation = {
              runId: c.latestValidationRunId,
              outcome: run?.outcome ?? "all_pass",
              results: results.map((r) => {
                const wasOverridden =
                  r.outcome === "fail" && overridden.has(`${r.ruleKey}:${r.evidenceHash}`);
                return {
                  id: r.id,
                  ruleKey: r.ruleKey,
                  severity: r.severity,
                  outcome: r.outcome,
                  overridable: r.overridable,
                  overridden: wasOverridden,
                  blocking: isBlocking(
                    {
                      outcome: r.outcome as "pass" | "fail" | "info",
                      severity: r.severity as "error" | "warn" | "info",
                    },
                    wasOverridden,
                  ),
                  message: r.message,
                };
              }),
            };
          }
          return {
            plan: {
              id: plan.id,
              payerId: plan.payerId,
              planName: plan.planName,
              authorizationRequirement: plan.authorizationRequirement,
              payerStatus: payerState?.status ?? null,
            },
            authorizations: auths.map((a) => ({
              id: a.id,
              status: a.status,
              levelOfCare: a.levelOfCare,
              effectiveFrom: a.effectiveFrom,
              effectiveTo: a.effectiveTo,
            })),
            claim: {
              id: c.id,
              claimControlNumber: c.claimControlNumber,
              state: c.state,
              patientId: c.patientId,
              providerEntityId: c.providerEntityId,
              planId: c.planId,
              tob: c.tob,
              serviceFrom: c.serviceFrom,
              serviceTo: c.serviceTo,
              claimFilingIndicator: c.claimFilingIndicator,
              secondaryPayerKind: c.secondaryPayerKind,
              totalChargeCents: c.totalChargeCents,
              expectedPaymentCents: c.expectedPaymentCents,
              readyAt: c.readyAt ? c.readyAt.toISOString() : null,
            },
            lines: lines.map((l) => ({
              lineNumber: l.lineNumber,
              levelOfCare: l.levelOfCare,
              revenueCode: l.revenueCode,
              hcpcsCode: l.hcpcsCode,
              serviceFrom: l.serviceFrom,
              serviceTo: l.serviceTo,
              units: l.units,
              unitRateCents: l.unitRateCents,
              lineChargeCents: l.lineChargeCents,
            })),
            validation,
          };
        },
      );
    },
  };
}
