// apps/backend/src/modules/41-billing-commercial/services/claim-read-service.ts — the read view of a commercial claim and the
// API projection of a validation run (issue #722). Ids, dates, codes, money and rule messages only: no member id, no
// authorization number, no patient name.
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError } from "@chartwarden/types";
import { and, asc, eq } from "drizzle-orm";
import { isBlocking } from "../domain/rules";
import { assertRowReachable } from "./scope-guard";
import type { CommercialActor, CommercialClaimSeams, CommercialDb } from "./types";
import type { ValidationRunView } from "./validation-runner";

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

export interface CommercialClaimReadService {
  getClaim(
    actor: Pick<CommercialActor, "organizationId" | "userId" | "billingScope">,
    claimId: string,
  ): Promise<{
    claim: Record<string, string | number | null>;
    lines: readonly Record<string, string | number | null>[];
    validation: ValidationRunApiView | null;
  }>;
}

export function buildCommercialClaimReadService(
  db: CommercialDb,
  seams: Pick<CommercialClaimSeams, "caseload">,
): CommercialClaimReadService {
  return {
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
            claim: {
              id: c.id,
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
