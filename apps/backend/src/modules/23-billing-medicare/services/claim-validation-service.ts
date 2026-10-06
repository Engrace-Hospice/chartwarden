// apps/backend/src/modules/23-billing-medicare/services/claim-validation-service.ts — the M23 §11.A
// pre-submission validation SERVICE (spec §10 task 28 / §4.5, D1 / D5).
//
// Runs the FROZEN `@wardenx/billing` rule registry against an assembled claim and records the outcome. The
// rule `check()`s are PURE synchronous predicates over an injected, already-resolved, plain-data
// {@link ValidationContext} — so this service walks the reader seams ONCE (through the injected
// {@link ValidationContextPort}), materializes that snapshot, runs `registry.runRules(ctx, overlays)`, rolls
// the per-rule results up with `summarizeRuleRun`, and persists ONE `validation_run` (append-only, idempotent
// on `(claim_id, trigger, run_input_hash)`) plus its `validation_result` rows — then drives the claim
// lifecycle through the claim-state-service IN THE SAME `withOrgContext` transaction:
//   * zero unresolved blocking failures ⇒ `validation_passed` / `overrides_applied` (VALIDATING → READY,
//     emits `m23.claim.ready_for_submission`);
//   * blocking failures present       ⇒ `validation_failed` (the VALIDATING self-loop, emits
//     `m23.claim.validation_failed` with the failed rule keys).
//
// IDEMPOTENCY (§2.6): the `run_input_hash` is sha256 over the materialized context + the claim version; a
// re-run on an unchanged claim collapses to the original `validation_run` and short-circuits (no duplicate
// results, no extra transition). The injected reader port is FAIL-CLOSED-UNBOUND (RULE 4) — its default
// throws only when a validation actually RUNS, so boot stays green. NO PHI / NO MBI (D13); the context
// carries ids + aggregate facts only.
import { createHash } from "node:crypto";
import {
  type BillingRuleRegistry,
  type ClaimState,
  type RuleParameterOverlays,
  type RuleResult,
  type ValidationContext,
  repositories,
  summarizeRuleRun,
} from "@wardenx/billing";
import type * as schema from "@wardenx/db/schema";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError, WardenXError } from "@wardenx/types";
import { claimDischargeCodeColumns } from "./claim-discharge";
import {
  type BillingDb,
  type BillingTx,
  type BillingWriteActor,
  type ClaimStateService,
  assertNotAiActor,
} from "./claim-state-service";

/** The materialized validation inputs the service runs the registry against (PHI-free, plain-data). */
export interface MaterializedValidationInputs {
  readonly context: ValidationContext;
  /** Per-rule tenant parameter overlays (`validation_rule_config.parameters`); merged into each rule. */
  readonly overlays?: RuleParameterOverlays;
}

/**
 * Walks the M5/M6/M8/M18/M40 reader seams + the HIPPS/SIA calculators + M38 terminology ONCE and returns
 * the aggregate {@link ValidationContext} (+ tenant overlays). A typed PORT the composition root binds; the
 * default deny-stub fails CLOSED (throws only when a validation runs, so boot stays green — RULE 4).
 */
export interface ValidationContextPort {
  build(
    tx: BillingTx,
    actor: BillingWriteActor,
    claim: repositories.ClaimRecord,
  ): Promise<MaterializedValidationInputs>;
}

const FAIL_CLOSED_CONTEXT: ValidationContextPort = {
  build() {
    throw new WardenXError(
      "SEAM_NOT_BOUND",
      "the M23 ValidationContextPort is not bound (the reader-seam materializer is a follow-up)",
      503,
    );
  },
};

export interface ValidateClaimInput {
  readonly claimId: string;
  readonly trigger: schema.ValidationRun["trigger"];
  /** Optional §2.5 If-Match guard against a concurrently-modified claim (stale → 412). */
  readonly expectedVersion?: number;
  /**
   * The run id the caller already minted (the route stamps it on the claim and on the queued job; the
   * worker passes it through). Omitted → the repository mints one. Carrying it keeps the claim's
   * `latest_validation_run_id` pointer and the persisted `validation_run` row the same id.
   */
  readonly validationRunId?: string;
}

export interface ValidationRunView {
  readonly validationRunId: string;
  readonly claimId: string;
  readonly trigger: schema.ValidationRun["trigger"];
  readonly outcome: schema.ValidationRun["outcome"];
  readonly rulesExecuted: number;
  readonly rulesPassed: number;
  readonly rulesFailed: number;
  readonly rulesWarn: number;
  readonly rulesInfo: number;
  readonly blockingFailures: number;
  readonly failedRuleKeys: readonly string[];
  readonly claimState: ClaimState;
  /** True when an identical run already existed and was returned without re-executing the rules (§2.6). */
  readonly idempotentReplay: boolean;
}

/** Map one pure {@link RuleResult} to the `validation_result.outcome` pgEnum value. */
function resultOutcome(r: RuleResult): schema.ValidationResult["outcome"] {
  if (r.annotations?.skipReason !== undefined) return "info"; // a skip is surfaced, non-blocking
  if (r.passed) return "pass";
  if (r.severity === "error") return "fail";
  if (r.severity === "warn") return "warn";
  return "info";
}

export interface ClaimValidationServicePorts {
  readonly contextPort?: ValidationContextPort;
  readonly now?: () => Date;
}

export interface ClaimValidationService {
  validateClaim(actor: BillingWriteActor, input: ValidateClaimInput): Promise<ValidationRunView>;
  /**
   * The same validation on a CALLER-PROVIDED tx — the entry the `validation-run` worker uses, because it
   * already runs inside its own per-job `withOrgContext` and must not open a nested transaction.
   */
  validateClaimInTx(
    tx: BillingTx,
    actor: BillingWriteActor,
    input: ValidateClaimInput,
  ): Promise<ValidationRunView>;
}

/**
 * Build the validation service. `registry` is the FROZEN platform-floor + MAC/tenant rule set (built once at
 * boot via `createDefaultBillingRegistry()` then `freeze()`); `claimStateService` drives the claim reducer
 * in the SAME transaction via its `applyInTx`.
 */
export function buildClaimValidationService(
  db: BillingDb,
  registry: BillingRuleRegistry,
  claimStateService: ClaimStateService,
  ports: ClaimValidationServicePorts = {},
): ClaimValidationService {
  const contextPort = ports.contextPort ?? FAIL_CLOSED_CONTEXT;
  const now = ports.now ?? (() => new Date());
  const regulatoryKeys = new Set(registry.regulatoryRequiredKeys());

  /** The rule keys whose `error` failure on the claim's LATEST prior run carries a recorded override. */
  const overriddenKeysForClaim = async (tx: BillingTx, claimId: string): Promise<Set<string>> => {
    const priorRun = await new repositories.ValidationRunRepository(tx).findLatestForClaim(claimId);
    if (!priorRun) return new Set();
    const failures = await new repositories.ValidationResultRepository(tx).listFailuresForRun(
      priorRun.id,
    );
    if (failures.length === 0) return new Set();
    const overrides = await new repositories.ValidationOverrideRepository(tx).listByResultIds(
      failures.map((f) => f.id),
    );
    const overriddenResultIds = new Set(overrides.map((o) => o.resultId));
    return new Set(failures.filter((f) => overriddenResultIds.has(f.id)).map((f) => f.ruleKey));
  };

  /** Roll the per-rule outcome into the `validation_run.outcome` pgEnum (the §2.3 submission-gate signal). */
  const runOutcome = (
    results: readonly RuleResult[],
    summary: ReturnType<typeof summarizeRuleRun>,
    overriddenKeys: ReadonlySet<string>,
  ): schema.ValidationRun["outcome"] => {
    if (summary.failedCount === 0) return "all_pass";
    if (summary.blockingFailures === 0) return "ready_for_submission"; // failures non-regulatory or overridden
    const blocking = results.filter(
      (r) =>
        !r.passed &&
        r.annotations?.skipReason === undefined &&
        r.severity === "error" &&
        regulatoryKeys.has(r.ruleKey) &&
        !overriddenKeys.has(r.ruleKey),
    );
    const allOverridable =
      blocking.length > 0 &&
      blocking.every((r) => registry.getRule(r.ruleKey)?.overrideRoleRequired);
    return allOverridable ? "overrides_required" : "failures_present";
  };

  const validateClaimInTx = async (
    tx: BillingTx,
    actor: BillingWriteActor,
    input: ValidateClaimInput,
  ): Promise<ValidationRunView> => {
    assertNotAiActor(actor);
    const claimRepo = new repositories.ClaimRepository(tx);
    const claim = await claimRepo.findById(input.claimId);
    if (!claim || claim.organizationId !== actor.organizationId) throw new NotFoundError("claim");
    if (claim.state !== "validating" && claim.state !== "ready") {
      throw new ConflictError(
        `a claim in state '${claim.state}' cannot be validated (assembly must place it in 'validating')`,
      );
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== claim.version) {
      throw new WardenXError(
        "VERSION_CONFLICT",
        `the claim was modified concurrently (current version ${claim.version})`,
        412,
      );
    }

    // Materialize the aggregate context + tenant overlays, then run the FROZEN rule set (pure).
    const { context, overlays } = await contextPort.build(tx, actor, claim);
    // Keep the persisted discharge claim codes (sent to the X12 gateway at submission) in step with the
    // facts this run validated — e.g. a biller recorded the missing place of death since assembly.
    await claimRepo.refreshDischargeCodes(
      claim.id,
      claimDischargeCodeColumns(context.claim.dischargeClaimCodes),
    );
    const overriddenKeys = await overriddenKeysForClaim(tx, claim.id);

    const startedAt = now();
    const results = registry.runRules(context, overlays ?? {});
    const completedAt = now();
    const summary = summarizeRuleRun(results, regulatoryKeys, overriddenKeys);
    const outcome = runOutcome(results, summary, overriddenKeys);

    // Idempotency (§2.6): sha256 over the materialized context + the claim version.
    const runInputHash = createHash("sha256")
      .update(`${claim.version}:${JSON.stringify(context)}`)
      .digest("hex");

    const runRepo = new repositories.ValidationRunRepository(tx);
    const existing = await runRepo.findByIdempotency(claim.id, input.trigger, runInputHash);
    if (existing) {
      const priorFailures = await new repositories.ValidationResultRepository(
        tx,
      ).listFailuresForRun(existing.id);
      return {
        validationRunId: existing.id,
        claimId: claim.id,
        trigger: existing.trigger,
        outcome: existing.outcome,
        rulesExecuted: existing.rulesExecuted,
        rulesPassed: existing.rulesPassed,
        rulesFailed: existing.rulesFailed,
        rulesWarn: existing.rulesWarn,
        rulesInfo: existing.rulesInfo,
        blockingFailures: summary.blockingFailures,
        failedRuleKeys: priorFailures.map((f) => f.ruleKey),
        claimState: claim.state,
        idempotentReplay: true,
      };
    }

    const rulesInfo = results.filter((r) => resultOutcome(r) === "info").length;
    const run = await runRepo.append({
      ...(input.validationRunId ? { id: input.validationRunId } : {}),
      organizationId: actor.organizationId,
      claimId: claim.id,
      trigger: input.trigger,
      outcome,
      runInputHash,
      rulesExecuted: results.length,
      rulesPassed: summary.passedCount,
      rulesFailed: summary.failedCount,
      rulesWarn: summary.warningCount,
      rulesInfo,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      initiatedByMembershipId: actor.actorKind === "user" ? actor.membershipId : null,
    });

    await new repositories.ValidationResultRepository(tx).appendBatch(
      results.map((r) => ({
        organizationId: actor.organizationId,
        validationRunId: run.id,
        ruleKey: r.ruleKey,
        ruleVersion: registry.getRule(r.ruleKey)?.version ?? 1,
        severity: r.severity,
        outcome: resultOutcome(r),
        remediation: (r.annotations ?? {}) as schema.NewValidationResult["remediation"],
      })),
    );

    const failedRuleKeys = results.filter((r) => resultOutcome(r) === "fail").map((r) => r.ruleKey);

    // Drive the claim lifecycle in the SAME transaction.
    let currentVersion = claim.version;
    if (claim.state === "ready") {
      const revalidated = await claimStateService.applyInTx(tx, actor, {
        claimId: claim.id,
        expectedVersion: currentVersion,
        event: "revalidate",
        context: { validationRunId: run.id },
        extra: { validationRunId: run.id, trigger: input.trigger },
      });
      currentVersion = revalidated.claim.version;
    }

    let claimState: ClaimState;
    if (summary.blockingFailures === 0) {
      const event = summary.overriddenCount > 0 ? "overrides_applied" : "validation_passed";
      const passed = await claimStateService.applyInTx(tx, actor, {
        claimId: claim.id,
        expectedVersion: currentVersion,
        event,
        unresolvedBlockingFailures: 0,
        context: { validationRunId: run.id },
        extra: { validationRunId: run.id },
      });
      claimState = passed.toState;
    } else {
      const failed = await claimStateService.applyInTx(tx, actor, {
        claimId: claim.id,
        expectedVersion: currentVersion,
        event: "validation_failed",
        context: { validationRunId: run.id },
        extra: { validationRunId: run.id, failedRuleKeys },
      });
      claimState = failed.toState;
    }

    return {
      validationRunId: run.id,
      claimId: claim.id,
      trigger: run.trigger,
      outcome: run.outcome,
      rulesExecuted: run.rulesExecuted,
      rulesPassed: run.rulesPassed,
      rulesFailed: run.rulesFailed,
      rulesWarn: run.rulesWarn,
      rulesInfo: run.rulesInfo,
      blockingFailures: summary.blockingFailures,
      failedRuleKeys,
      claimState,
      idempotentReplay: false,
    };
  };

  return {
    validateClaimInTx,
    validateClaim(actor, input) {
      return withOrgContext<BillingTx, ValidationRunView>(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        (tx) => validateClaimInTx(tx, actor, input),
      );
    },
  };
}
