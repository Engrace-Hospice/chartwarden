import { randomUUID } from "node:crypto";
// apps/backend/src/modules/41-billing-commercial/services/claim-lifecycle.ts — re-validate, override, ready and void a
// commercial claim (issue #722). The override follows the M23 `m23-validation-override` pattern:
//   1. never via AI (a human compliance act);
//   2. a recent step-up;
//   3. a reason of at least 40 characters (mirrors the database CHECK, surfaced as a 422 first);
//   4. only a FAILING, OVERRIDABLE result of the claim's LATEST run (a hard block has no override path at all);
//   5. one override per result, bound to the (claim, rule, evidence hash) so it never carries over to different facts;
//   6. the override row and its prominent M4 audit event are written in the SAME transaction, plus the outbox event.
// The reason text lives only on `commercial_validation_override.reason`: never in the audit event, the outbox payload or a log.
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  COMMERCIAL_ERROR_CODES,
  COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH,
  ChartWardenError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
} from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { assertRowReachable } from "./scope-guard";
import type { CommercialActor, CommercialClaimSeams, CommercialDb, CommercialTx } from "./types";
import { type ValidationRunView, runAndPersistValidation } from "./validation-runner";

export interface ReadyResult {
  readonly claimId: string;
  readonly state: "ready" | "draft";
  readonly validation: ValidationRunView;
}

export interface CommercialClaimLifecycleService {
  validate(actor: CommercialActor, claimId: string): Promise<ValidationRunView>;
  /** Re-validate; move draft -> ready only if nothing blocks. A blocked claim returns `state: "draft"` (see `assertReady`). */
  markReady(actor: CommercialActor, claimId: string): Promise<ReadyResult>;
  /** `markReady`, but a blocked claim throws `COMMERCIAL_CLAIM_BLOCKED` (409) after the run is committed. */
  assertReady(actor: CommercialActor, claimId: string): Promise<ReadyResult>;
  overrideValidationResult(
    actor: CommercialActor,
    claimId: string,
    args: { readonly validationResultId: string; readonly reason: string },
  ): Promise<{ overrideId: string; auditEventId: string; ruleKey: string }>;
  voidClaim(actor: CommercialActor, claimId: string): Promise<{ claimId: string; state: "void" }>;
}

function assertHuman(actor: CommercialActor): void {
  if (actor.actorKind.startsWith("ai_")) {
    throw new ChartWardenError(
      "AI_ACTOR_FORBIDDEN",
      "AI actors may not change a billing record",
      403,
    );
  }
}

export function buildCommercialClaimLifecycleService(
  db: CommercialDb,
  seams: CommercialClaimSeams,
): CommercialClaimLifecycleService {
  const now = seams.now ?? (() => new Date());
  const inOrg = <T>(actor: CommercialActor, fn: (tx: CommercialTx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);

  /**
   * Load the claim ROW-LOCKED (`FOR UPDATE`): ready, validate, override and void on one claim serialize, so a void can never be
   * overtaken by a ready and two validations cannot interleave their run pointers. The claim's provider entity must be in the
   * actor's scope and its patient in their caseload (the data, not just the request, is scoped).
   */
  const loadClaim = async (tx: CommercialTx, actor: CommercialActor, claimId: string) => {
    const [claim] = await tx
      .select()
      .from(schema.commercialClaims)
      .where(
        and(
          eq(schema.commercialClaims.id, claimId),
          eq(schema.commercialClaims.organizationId, actor.organizationId),
        ),
      )
      .for("update");
    if (!claim) throw new NotFoundError("commercial claim");
    await assertRowReachable(actor, seams.caseload, claim);
    return claim;
  };

  /** A ready claim whose facts now block (an authorization voided, a route ended) falls back to draft: nothing stale is sendable. */
  const demoteIfBlocked = async (
    tx: CommercialTx,
    actor: CommercialActor,
    claim: typeof schema.commercialClaims.$inferSelect,
    run: ValidationRunView,
  ): Promise<void> => {
    if (claim.state !== "ready" || run.blocking.length === 0) return;
    await tx
      .update(schema.commercialClaims)
      .set({ state: "draft", readyAt: null, updatedAt: now() })
      .where(eq(schema.commercialClaims.id, claim.id));
    await recordTransition(tx, actor, claim, "ready", "draft", run.runId);
  };

  const recordTransition = (
    tx: CommercialTx,
    actor: CommercialActor,
    claim: { id: string; providerEntityId: string; locationId: string | null },
    from: string,
    to: string,
    validationRunId: string | null,
  ) =>
    tx.insert(schema.commercialClaimStateHistory).values({
      organizationId: actor.organizationId,
      providerEntityId: claim.providerEntityId,
      locationId: claim.locationId,
      claimId: claim.id,
      fromState: from,
      toState: to,
      actorKind: actor.actorKind,
      actorMembershipId: actor.membershipId,
      validationRunId,
    });

  async function markReady(actor: CommercialActor, claimId: string): Promise<ReadyResult> {
    assertHuman(actor);
    return inOrg(actor, async (tx) => {
      const claim = await loadClaim(tx, actor, claimId);
      if (claim.state === "void") throw new ConflictError("a void claim cannot be made ready");
      const validation = await runAndPersistValidation(
        tx,
        claim,
        "ready_check",
        actor.membershipId,
        now(),
      );
      if (validation.blocking.length > 0) {
        await demoteIfBlocked(tx, actor, claim, validation);
        return { claimId, state: "draft" as const, validation };
      }
      if (claim.state === "ready") return { claimId, state: "ready" as const, validation };
      const at = now();
      await tx
        .update(schema.commercialClaims)
        .set({ state: "ready", readyAt: at, updatedAt: at })
        .where(eq(schema.commercialClaims.id, claimId));
      await recordTransition(tx, actor, claim, "draft", "ready", validation.runId);
      await seams.outbox.publish(tx, {
        eventName: "m41.claim.ready_for_submission",
        organizationId: actor.organizationId,
        aggregateKind: "commercial_claim",
        aggregateId: claimId,
        payload: { claimId, validationRunId: validation.runId },
      });
      return { claimId, state: "ready" as const, validation };
    });
  }

  return {
    async validate(actor, claimId) {
      assertHuman(actor);
      return inOrg(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId);
        if (claim.state === "void") throw new ConflictError("a void claim cannot be validated");
        const run = await runAndPersistValidation(
          tx,
          claim,
          "manual_re_run",
          actor.membershipId,
          now(),
        );
        await demoteIfBlocked(tx, actor, claim, run);
        return run;
      });
    },

    markReady,

    async assertReady(actor, claimId) {
      const res = await markReady(actor, claimId);
      if (res.state === "ready") return res;
      throw new ChartWardenError(
        COMMERCIAL_ERROR_CODES.claimBlocked,
        `The claim cannot be sent: ${res.validation.blocking.map((b) => b.message).join(" ")}`,
        409,
        res.validation.blocking.map((b) => ({
          field: b.ruleKey,
          code: b.overridable ? "NEEDS_OVERRIDE" : "HARD_BLOCK",
          message: b.overridable ? "needs an audited override" : "hard block",
        })),
      );
    },

    async overrideValidationResult(actor, claimId, args) {
      assertHuman(actor);
      if (!actor.stepUpRecent) throw new StepUpRequiredError();
      const reason = args.reason.trim();
      if (reason.length < COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH) {
        throw new ChartWardenError(
          "VALIDATION_FAILED",
          `an override reason of at least ${COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH} characters is required`,
          422,
        );
      }
      return inOrg(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId);
        if (claim.state !== "draft")
          throw new ConflictError("only a draft claim can be overridden");
        const [result] = await tx
          .select()
          .from(schema.commercialValidationResults)
          .where(
            and(
              eq(schema.commercialValidationResults.id, args.validationResultId),
              eq(schema.commercialValidationResults.claimId, claim.id),
              eq(schema.commercialValidationResults.organizationId, actor.organizationId),
            ),
          );
        if (!result) throw new NotFoundError("validation result");
        if (result.outcome !== "fail")
          throw new ConflictError("only a failing validation result can be overridden");
        if (!result.overridable) {
          throw new ForbiddenError(
            "this is a hard block and cannot be overridden; correct the underlying data (or change the policy) and re-validate",
          );
        }
        // The override is granted for the exact facts (rule + evidence hash) and must still be a failure in the LATEST run:
        // an older run's result for facts that have since changed is stale.
        const [current] = claim.latestValidationRunId
          ? await tx
              .select({ id: schema.commercialValidationResults.id })
              .from(schema.commercialValidationResults)
              .where(
                and(
                  eq(
                    schema.commercialValidationResults.validationRunId,
                    claim.latestValidationRunId,
                  ),
                  eq(schema.commercialValidationResults.ruleKey, result.ruleKey),
                  eq(schema.commercialValidationResults.evidenceHash, result.evidenceHash),
                  eq(schema.commercialValidationResults.outcome, "fail"),
                ),
              )
          : [];
        if (!current) {
          throw new ConflictError(
            "this result belongs to an earlier validation run and its facts have changed; re-validate and override the current result",
          );
        }
        const [existing] = await tx
          .select({ id: schema.commercialValidationOverrides.id })
          .from(schema.commercialValidationOverrides)
          .where(
            and(
              eq(schema.commercialValidationOverrides.claimId, claim.id),
              eq(schema.commercialValidationOverrides.ruleKey, result.ruleKey),
              eq(schema.commercialValidationOverrides.evidenceHash, result.evidenceHash),
            ),
          );
        if (existing) throw new ConflictError("this validation result has already been overridden");

        // One correlation id joins this explicit audit event, the row-level write-audit trigger and the request's logs.
        const correlationId = actor.request?.correlationId ?? randomUUID();
        await tx.execute(sql`SELECT set_config('app.correlation_id', ${correlationId}, true)`);
        const { auditEventId } = await seams.audit.recordOverrideAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          claimId: claim.id,
          validationResultId: result.id,
          ruleKey: result.ruleKey,
          reasonLength: reason.length,
          correlationId,
          ...(actor.request?.requestId ? { requestId: actor.request.requestId } : {}),
          ...(actor.request?.sourceIp ? { sourceIp: actor.request.sourceIp } : {}),
          ...(actor.request?.userAgent ? { userAgent: actor.request.userAgent } : {}),
        });
        const [override] = await tx
          .insert(schema.commercialValidationOverrides)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: claim.providerEntityId,
            locationId: claim.locationId,
            claimId: claim.id,
            validationResultId: result.id,
            ruleKey: result.ruleKey,
            evidenceHash: result.evidenceHash,
            overrideMembershipId: actor.membershipId,
            reason,
            m4AuditEventId: auditEventId,
          })
          .returning({ id: schema.commercialValidationOverrides.id });
        if (!override) throw new Error("override insert returned no row");
        await seams.outbox.publish(tx, {
          eventName: "m41.claim.override_applied",
          organizationId: actor.organizationId,
          aggregateKind: "commercial_validation_override",
          aggregateId: override.id,
          payload: {
            claimId: claim.id,
            resultId: result.id,
            overrideId: override.id,
            ruleKey: result.ruleKey,
          },
        });
        return { overrideId: override.id, auditEventId, ruleKey: result.ruleKey };
      });
    },

    async voidClaim(actor, claimId) {
      assertHuman(actor);
      return inOrg(actor, async (tx) => {
        const claim = await loadClaim(tx, actor, claimId);
        if (claim.state === "void") throw new ConflictError("the claim is already void");
        await tx
          .update(schema.commercialClaims)
          .set({ state: "void", readyAt: null, updatedAt: now() })
          .where(eq(schema.commercialClaims.id, claimId));
        await recordTransition(tx, actor, claim, claim.state, "void", null);
        return { claimId, state: "void" as const };
      });
    },
  };
}
