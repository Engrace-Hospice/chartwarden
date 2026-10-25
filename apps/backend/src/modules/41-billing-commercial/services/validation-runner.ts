// apps/backend/src/modules/41-billing-commercial/services/validation-runner.ts — load the facts a commercial claim is
// judged against, run the pure rules, persist the run, and decide what still blocks (issue #722).
//
// Re-validation re-reads the things that change after assembly (plan, payer state, routes, authorizations, overrides); the
// priced LINES are frozen at assembly, so a pricing block is fixed by voiding and re-assembling the claim.
import { schema } from "@chartwarden/db";
import type {
  CommercialAuthorizationRequirement,
  CommercialHospiceLevelOfCare,
  CommercialSecondaryPayerKind,
  CommercialValidationTrigger,
} from "@chartwarden/types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { ContractRateFact, PricedLine, UnpricedReason } from "../domain/pricing";
import {
  COMMERCIAL_RULE_SET_VERSION,
  type PayerStateFact,
  type PlanFact,
  type RuleContext,
  type RuleOutcome,
  evidenceHash,
  isBlocking,
  runCommercialRules,
} from "../domain/rules";
import type { CommercialTx } from "./types";

type ClaimRow = typeof schema.commercialClaims.$inferSelect;
type RateRow = typeof schema.commercialContractRate.$inferSelect;

export const toPlanFact = (p: typeof schema.commercialPayerPlan.$inferSelect): PlanFact => ({
  id: p.id,
  payerId: p.payerId,
  claimFilingIndicator: p.claimFilingIndicator,
  authorizationRequirement: p.authorizationRequirement as CommercialAuthorizationRequirement,
  authorizationLeadDays: p.authorizationLeadDays,
  siteOfServiceHcpcsRequired: p.siteOfServiceHcpcsRequired,
  effectiveFrom: p.effectiveFrom,
  effectiveTo: p.effectiveTo,
});

export const toRateFact = (r: RateRow): ContractRateFact => ({
  id: r.id,
  levelOfCare: r.levelOfCare as CommercialHospiceLevelOfCare,
  revenueCode: r.revenueCode,
  rateBasis: r.rateBasis as ContractRateFact["rateBasis"],
  rateCents: r.rateCents,
  percentOfCharges: r.percentOfCharges,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
});

/** The M40 payer's current state, through the migration-1261 seam function (this module reads no payer table). */
export async function readPayerState(
  tx: CommercialTx,
  payerId: string,
): Promise<PayerStateFact | null> {
  const res = await tx.execute(
    sql`SELECT status, merged_into_id AS "mergedIntoId" FROM m41_payer_state(${payerId}::uuid)`,
  );
  const row = res.rows[0] as { status: string; mergedIntoId: string | null } | undefined;
  return row ? { status: row.status, mergedIntoId: row.mergedIntoId } : null;
}

function unpricedReasonOf(
  line: typeof schema.commercialClaimLines.$inferSelect,
  rate: RateRow | undefined,
): UnpricedReason | null {
  if (line.contractRateId === null || rate === undefined) return "no_contract_rate";
  if (rate.rateBasis === "percent_of_charges") return "percent_of_charges_needs_charge_source";
  // a rate row with no amount is "no contract rate" (as at assembly); an amount that could not be applied is a per-hour gap
  if (rate.rateCents === null) return "no_contract_rate";
  if (line.unitRateCents === null) return "chc_hours_not_documented";
  return null;
}

/** Everything the rules need for a stored claim, read on the caller's org-context transaction. */
export async function loadRuleContext(tx: CommercialTx, claim: ClaimRow): Promise<RuleContext> {
  const [plan] = await tx
    .select()
    .from(schema.commercialPayerPlan)
    .where(
      and(
        eq(schema.commercialPayerPlan.id, claim.planId),
        eq(schema.commercialPayerPlan.organizationId, claim.organizationId),
      ),
    );
  if (!plan) throw new Error("commercial_claim.plan_id names no plan in this organization");
  const routes = await tx
    .select()
    .from(schema.commercialPayerRoute)
    .where(eq(schema.commercialPayerRoute.planId, plan.id));
  const lineRows = await tx
    .select()
    .from(schema.commercialClaimLines)
    .where(eq(schema.commercialClaimLines.claimId, claim.id))
    .orderBy(asc(schema.commercialClaimLines.lineNumber));
  const rateIds = [
    ...new Set(lineRows.map((l) => l.contractRateId).filter((x): x is string => x !== null)),
  ];
  const rateRows = rateIds.length
    ? await tx
        .select()
        .from(schema.commercialContractRate)
        .where(inArray(schema.commercialContractRate.id, rateIds))
    : [];
  const rateById = new Map(rateRows.map((r) => [r.id, r]));
  const lines: PricedLine[] = lineRows.map((l) => ({
    lineNumber: l.lineNumber,
    levelOfCare: l.levelOfCare as CommercialHospiceLevelOfCare,
    revenueCode: l.revenueCode,
    hcpcsCode: l.hcpcsCode,
    serviceFrom: l.serviceFrom,
    serviceTo: l.serviceTo,
    units: l.units,
    unitRateCents: l.unitRateCents,
    lineChargeCents: l.lineChargeCents,
    contractRateId: l.contractRateId,
    unpricedReason: unpricedReasonOf(
      l,
      l.contractRateId ? rateById.get(l.contractRateId) : undefined,
    ),
  }));
  const auths = await tx
    .select()
    .from(schema.commercialAuthorizations)
    .where(
      and(
        eq(schema.commercialAuthorizations.planId, plan.id),
        eq(schema.commercialAuthorizations.patientId, claim.patientId),
        // scoped to the claim's own provider entity: another entity's authorization for the patient never satisfies this claim
        eq(schema.commercialAuthorizations.providerEntityId, claim.providerEntityId),
      ),
    );
  const diagnoses = (claim.diagnoses as { icd10Code: string }[]).map((d) => d.icd10Code);
  return {
    serviceFrom: claim.serviceFrom,
    serviceTo: claim.serviceTo,
    plan: toPlanFact(plan),
    payerState: await readPayerState(tx, plan.payerId),
    routes: routes.map((r) => ({
      clearinghouseKey: r.clearinghouseKey,
      clearinghousePayerId: r.clearinghousePayerId,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
    })),
    clearinghouseKey: claim.clearinghouseKey,
    lines,
    authorizations: auths.map((a) => ({
      id: a.id,
      levelOfCare: a.levelOfCare as CommercialHospiceLevelOfCare | null,
      status: a.status,
      obtainedOn: a.obtainedOn,
      effectiveFrom: a.effectiveFrom,
      effectiveTo: a.effectiveTo,
    })),
    diagnosisCodes: diagnoses,
    attendingNpi: claim.attendingNpi,
    secondaryPayerKind: claim.secondaryPayerKind as CommercialSecondaryPayerKind | null,
  };
}

export interface PersistedResult extends RuleOutcome {
  readonly id: string;
  readonly evidenceHash: string;
  readonly overridden: boolean;
  readonly blocking: boolean;
}

export interface ValidationRunView {
  readonly runId: string;
  readonly outcome: "all_pass" | "failures_present";
  readonly results: readonly PersistedResult[];
  readonly blocking: readonly PersistedResult[];
}

export interface EvaluatedResult extends RuleOutcome {
  readonly evidenceHash: string;
  readonly overridden: boolean;
  readonly blocking: boolean;
}

/**
 * Run the rules over the claim's current facts and decide what still blocks, WITHOUT writing anything (the render and the
 * ready check use it so a ready claim whose facts have since changed is never sendable). An override only counts for a result
 * that is overridable AND whose rule and evidence hash match the override.
 */
export async function evaluateClaim(
  tx: CommercialTx,
  claim: ClaimRow,
  contextOverride?: RuleContext,
): Promise<EvaluatedResult[]> {
  const ctx = contextOverride ?? (await loadRuleContext(tx, claim));
  const overrides = await tx
    .select({
      ruleKey: schema.commercialValidationOverrides.ruleKey,
      evidenceHash: schema.commercialValidationOverrides.evidenceHash,
    })
    .from(schema.commercialValidationOverrides)
    .where(eq(schema.commercialValidationOverrides.claimId, claim.id));
  const overridden = new Set(overrides.map((o) => `${o.ruleKey}:${o.evidenceHash}`));
  return runCommercialRules(ctx).map((o) => {
    const hash = evidenceHash(o.evidence);
    const wasOverridden =
      o.outcome === "fail" && o.overridable && overridden.has(`${o.ruleKey}:${hash}`);
    return {
      ...o,
      evidenceHash: hash,
      overridden: wasOverridden,
      blocking: isBlocking(o, wasOverridden),
    };
  });
}

/** Run the rules, persist the run and results, point the claim at the run, and report what still blocks. */
export async function runAndPersistValidation(
  tx: CommercialTx,
  claim: ClaimRow,
  trigger: CommercialValidationTrigger,
  membershipId: string | null,
  now: Date,
  contextOverride?: RuleContext,
): Promise<ValidationRunView> {
  const evaluated = await evaluateClaim(tx, claim, contextOverride);
  const failed = evaluated.filter((o) => o.outcome === "fail");
  const [run] = await tx
    .insert(schema.commercialValidationRuns)
    .values({
      organizationId: claim.organizationId,
      providerEntityId: claim.providerEntityId,
      locationId: claim.locationId,
      claimId: claim.id,
      trigger,
      outcome: failed.length > 0 ? "failures_present" : "all_pass",
      ruleSetVersion: COMMERCIAL_RULE_SET_VERSION,
      rulesExecuted: evaluated.length,
      rulesFailed: failed.length,
      initiatedByMembershipId: membershipId,
    })
    .returning({ id: schema.commercialValidationRuns.id });
  if (!run) throw new Error("validation run insert returned no row");
  const rows = await tx
    .insert(schema.commercialValidationResults)
    .values(
      evaluated.map((o) => ({
        organizationId: claim.organizationId,
        providerEntityId: claim.providerEntityId,
        locationId: claim.locationId,
        claimId: claim.id,
        validationRunId: run.id,
        ruleKey: o.ruleKey,
        severity: o.severity,
        outcome: o.outcome,
        overridable: o.overridable,
        evidenceHash: o.evidenceHash,
        message: o.message.slice(0, 600),
        evidence: o.evidence,
      })),
    )
    .returning({
      id: schema.commercialValidationResults.id,
      ruleKey: schema.commercialValidationResults.ruleKey,
    });
  const idByRule = new Map(rows.map((r) => [r.ruleKey, r.id]));
  await tx
    .update(schema.commercialClaims)
    .set({ latestValidationRunId: run.id, updatedAt: now })
    .where(eq(schema.commercialClaims.id, claim.id));
  const results: PersistedResult[] = evaluated.map((o) => ({
    ...o,
    id: idByRule.get(o.ruleKey) as string,
  }));
  return {
    runId: run.id,
    outcome: failed.length > 0 ? "failures_present" : "all_pass",
    results,
    blocking: results.filter((r) => r.blocking),
  };
}
