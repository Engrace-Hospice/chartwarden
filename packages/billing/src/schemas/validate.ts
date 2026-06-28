// @wardenx/billing — validation-run schemas: route #6 `POST /claims/:id:validate` (the `manual_re_run`
// trigger), route #14 `GET /claims/:id/validation-runs` (per-claim run history / §11.A worklist), and
// route #15 `GET /validation-runs/:runId` (single run with all results) — §4.1.
import { type Static, Type } from "@sinclair/typebox";
import {
  IsoDateTimeSchema,
  Uuid,
  ValidationResultOutcomeApi,
  ValidationRunOutcomeApi,
  ValidationRunTriggerApi,
  ValidationSeverityApi,
} from "./common";

// ── route #6: trigger a manual re-validation ────────────────────────────────────────────────────────────
/** Body is empty by contract (the trigger is fixed `manual_re_run`); kept as an object for forward fields. */
export const ManualValidateRequest = Type.Object({});
export type ManualValidateRequest = Static<typeof ManualValidateRequest>;

export const ManualValidateResponse = Type.Object({
  validationRunId: Uuid,
  claimId: Uuid,
  trigger: Type.Literal("manual_re_run"),
  outcome: ValidationRunOutcomeApi,
  errorCount: Type.Integer(),
  warnCount: Type.Integer(),
  overrideRequiredCount: Type.Integer(),
  ranAt: IsoDateTimeSchema,
});
export type ManualValidateResponse = Static<typeof ManualValidateResponse>;

// ── shared result view ──────────────────────────────────────────────────────────────────────────────────
/** One `validation_result` row (PHI-free remediation + observed aggregates only). */
export const ValidationResultView = Type.Object({
  resultId: Uuid,
  ruleKey: Type.String(),
  ruleVersion: Type.Integer(),
  category: Type.String(),
  severity: ValidationSeverityApi,
  outcome: ValidationResultOutcomeApi,
  message: Type.String(),
  /** Present iff the rule SKIPPED (forward-seam deny-stub / not-applicable). */
  skipReason: Type.Optional(
    Type.Union([Type.Literal("seam_not_bound"), Type.Literal("not_applicable")]),
  ),
  regulatoryRequired: Type.Boolean(),
  /** The role an override would require (null when the result is not overridable). */
  overrideRoleRequired: Type.Union([Type.String(), Type.Null()]),
  /** True once an override has been recorded against this result. */
  overridden: Type.Boolean(),
  remediation: Type.Optional(
    Type.Object({
      summary: Type.String(),
      blameTarget: Type.Optional(Type.String()),
      blameTargetId: Type.Optional(Uuid),
      fixAction: Type.Optional(Type.String()),
      fixDeepLink: Type.Optional(Type.String()),
    }),
  ),
  observed: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.Number(), Type.String(), Type.Boolean()])),
  ),
  version: Type.Integer(),
});
export type ValidationResultView = Static<typeof ValidationResultView>;

/** A run-summary row (without the nested results). */
export const ValidationRunView = Type.Object({
  validationRunId: Uuid,
  claimId: Uuid,
  trigger: ValidationRunTriggerApi,
  outcome: ValidationRunOutcomeApi,
  errorCount: Type.Integer(),
  warnCount: Type.Integer(),
  overrideRequiredCount: Type.Integer(),
  ranAt: IsoDateTimeSchema,
});
export type ValidationRunView = Static<typeof ValidationRunView>;

// ── route #14: list runs for a claim ────────────────────────────────────────────────────────────────────
export const ClaimValidationRunsResponse = Type.Object({
  claimId: Uuid,
  runs: Type.Array(ValidationRunView),
});
export type ClaimValidationRunsResponse = Static<typeof ClaimValidationRunsResponse>;

// ── route #15: single run with all results ──────────────────────────────────────────────────────────────
export const ValidationRunDetailResponse = Type.Composite([
  ValidationRunView,
  Type.Object({ results: Type.Array(ValidationResultView) }),
]);
export type ValidationRunDetailResponse = Static<typeof ValidationRunDetailResponse>;
