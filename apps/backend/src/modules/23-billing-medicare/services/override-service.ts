// apps/backend/src/modules/23-billing-medicare/services/override-service.ts — the M23 validation-override
// SERVICE (spec §10 task 29 / §4.5 / §4.7, D5).
//
// TEST-ONLY / NOT WIRED: this standalone service is imported only by its own unit test and is NOT reachable from any route
// or from `index.ts`. The live override route runs `overrideValidationResult` in `routes/write-service-drizzle.ts`
// (audited through the `AuditEventPort` bound in `src/m23-override-audit.ts`). This file is kept as the spec's
// service-level reference (its gate order and role resolution); do not bind it without reconciling it with the route's.
//
// Records a role-gated, reason-required (≥40 chars), M4-audited override against a FAILING validation
// result so a claim may proceed past it. The four gates, all fail-closed:
//   1. NEVER VIA AI (D13): `assertNotAiActor` rejects any `ai_*` principal — an override is a human
//      compliance act.
//   2. STEP-UP (§D14): `requireStepUp` — an override is a privileged action.
//   3. override_role_eligible (§4.7): the actor must hold the `override_role_required` role the failed
//      result's rule demands (a REGULATORY-required rule with no override path cannot be overridden at all,
//      §2.2 / D5); the applied role is recorded on the row.
//   4. REASON FLOOR: ≥40 chars (mirrors the DB CHECK; surfaced as a 422 before the write).
//
// The override row + its M4 audit-event id are written in the SAME `withOrgContext` transaction, and the
// audit-prominent `m23.claim.override_applied` event is emitted on that same tx (D2 outbox-only). At most
// one override per result (`validation_override_result_uq`; the repo append is idempotent). NO PHI / MBI.
import { type BillingRuleRegistry, type OverrideRole, repositories } from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, WardenXError } from "@wardenx/types";
import {
  type BillingDb,
  type BillingTx,
  type BillingWriteActor,
  type WriteOutboxPort,
  assertNotAiActor,
  requireStepUp,
} from "./claim-state-service";

/** The §4.5 elevated override roles, most-broad last (used to pick the applied role). */
const OVERRIDE_ROLES: readonly OverrideRole[] = [
  "billing_manager",
  "compliance_officer",
  "medical_director",
  "org_admin",
];

const REASON_MIN_LENGTH = 40;

/**
 * Writes the mandatory M4 audit_event for an override and returns its id (the NOT-NULL
 * `validation_override.m4_audit_event_id`). The audit_event table is HELPER-ONLY (written only via
 * `packages/audit`), so this is a typed PORT the composition root binds to the real M4 writer; the default
 * deny-stub fails CLOSED (an override cannot be recorded without audit linkage — RULE 4).
 */
export interface OverrideAuditPort {
  recordOverride(
    tx: BillingTx,
    input: {
      readonly organizationId: string;
      readonly claimId: string;
      readonly validationRunId: string;
      readonly resultId: string;
      readonly ruleKey: string;
      readonly overrideRoleApplied: OverrideRole;
      readonly overrideMembershipId: string;
      readonly reason: string;
    },
  ): Promise<string>;
}

const FAIL_CLOSED_AUDIT: OverrideAuditPort = {
  recordOverride() {
    throw new WardenXError(
      "AUDIT_NOT_BOUND",
      "the M23 override audit port is not bound (M4 audit linkage is required for an override)",
      503,
    );
  },
};

export interface OverrideValidationResultInput {
  readonly claimId: string;
  readonly validationRunId: string;
  readonly resultId: string;
  /** Compliance justification (≥40 chars). */
  readonly reason: string;
}

export interface OverrideView {
  readonly overrideId: string;
  readonly resultId: string;
  readonly ruleKey: string;
  readonly overrideRoleApplied: OverrideRole;
  readonly overrideMembershipId: string;
  readonly m4AuditEventId: string;
  readonly appliedAt: string;
}

export interface OverrideServicePorts {
  readonly outbox?: WriteOutboxPort;
  readonly audit?: OverrideAuditPort;
}

export interface OverrideService {
  overrideValidationResult(
    actor: BillingWriteActor,
    input: OverrideValidationResultInput,
  ): Promise<OverrideView>;
}

/**
 * Resolve the override role the actor may apply for a rule, or `null` when they are not eligible. A rule's
 * `overrideRoleRequired` (when set) must be held (or `org_admin`); a non-elevated rule accepts any held
 * override role.
 */
function applicableOverrideRole(
  roles: readonly string[],
  ruleRoleRequired: OverrideRole | undefined,
): OverrideRole | null {
  const held = OVERRIDE_ROLES.filter((r) => roles.includes(r));
  if (held.length === 0) return null;
  if (ruleRoleRequired) {
    if (roles.includes(ruleRoleRequired)) return ruleRoleRequired;
    if (roles.includes("org_admin")) return "org_admin";
    return null;
  }
  return held[0] ?? null;
}

/**
 * Build the override service. `registry` is the FROZEN rule set (for the rule's `regulatoryRequired` /
 * `overrideRoleRequired` metadata + version).
 */
export function buildOverrideService(
  db: BillingDb,
  registry: BillingRuleRegistry,
  ports: OverrideServicePorts = {},
): OverrideService {
  const audit = ports.audit ?? FAIL_CLOSED_AUDIT;

  return {
    async overrideValidationResult(actor, input) {
      assertNotAiActor(actor); // gate 1 — never via AI
      requireStepUp(actor); // gate 2 — privileged action

      if (input.reason.trim().length < REASON_MIN_LENGTH) {
        throw new WardenXError(
          "VALIDATION_FAILED",
          `an override reason must be at least ${REASON_MIN_LENGTH} characters`,
          422,
        );
      }

      return withOrgContext<BillingTx, OverrideView>(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          // Resolve + cross-check the claim → run → result chain under RLS.
          const claim = await new repositories.ClaimRepository(tx).findById(input.claimId);
          if (!claim || claim.organizationId !== actor.organizationId)
            throw new NotFoundError("claim");

          const run = await new repositories.ValidationRunRepository(tx).findById(
            input.validationRunId,
          );
          if (!run || run.organizationId !== actor.organizationId || run.claimId !== claim.id) {
            throw new NotFoundError("validation run");
          }

          const resultRepo = new repositories.ValidationResultRepository(tx);
          const result = await resultRepo.findById(input.resultId);
          if (
            !result ||
            result.organizationId !== actor.organizationId ||
            result.validationRunId !== run.id
          ) {
            throw new NotFoundError("validation result");
          }
          if (result.outcome !== "fail") {
            throw new ConflictError("only a FAILING validation result can be overridden");
          }

          const overrideRepo = new repositories.ValidationOverrideRepository(tx);
          if (await overrideRepo.findByResult(result.id)) {
            throw new ConflictError("this validation result has already been overridden");
          }

          // gate 3 — override_role_eligible (§4.7 / §2.2 / D5).
          const rule = registry.getRule(result.ruleKey);
          if (rule?.regulatoryRequired && !rule.overrideRoleRequired) {
            throw new ForbiddenError(
              "a regulatory-required validation failure with no override path cannot be overridden",
            );
          }
          const overrideRoleApplied = applicableOverrideRole(
            actor.roles,
            rule?.overrideRoleRequired,
          );
          if (!overrideRoleApplied) {
            throw new ForbiddenError(
              "the actor does not hold a role eligible to override this validation result",
            );
          }

          // gate 4 — M4 audit linkage (NOT NULL), captured in the SAME transaction.
          const m4AuditEventId = await audit.recordOverride(tx, {
            organizationId: actor.organizationId,
            claimId: claim.id,
            validationRunId: run.id,
            resultId: result.id,
            ruleKey: result.ruleKey,
            overrideRoleApplied,
            overrideMembershipId: actor.membershipId,
            reason: input.reason,
          });

          const override = await overrideRepo.append({
            organizationId: actor.organizationId,
            resultId: result.id,
            overrideMembershipId: actor.membershipId,
            overrideRoleApplied,
            reason: input.reason,
            m4AuditEventId,
          });

          if (ports.outbox) {
            await ports.outbox.publish(tx, {
              eventName: "m23.claim.override_applied",
              organizationId: actor.organizationId,
              aggregateKind: "validation_override",
              aggregateId: override.id,
              payload: {
                claimId: claim.id,
                validationRunId: run.id,
                resultId: result.id,
                overrideId: override.id,
                ruleKey: result.ruleKey,
                overrideRoleApplied,
              },
            });
          }

          return {
            overrideId: override.id,
            resultId: result.id,
            ruleKey: result.ruleKey,
            overrideRoleApplied,
            overrideMembershipId: override.overrideMembershipId,
            m4AuditEventId: override.m4AuditEventId,
            appliedAt: override.appliedAt.toISOString(),
          };
        },
      );
    },
  };
}
