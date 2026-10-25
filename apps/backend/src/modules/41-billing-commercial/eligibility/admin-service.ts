// apps/backend/src/modules/41-billing-commercial/eligibility/admin-service.ts - enrollment records and the per-plan eligibility policy.
//
// Thin on purpose: the database owns the invariants (no overlapping enrollment periods, the payer must be an active commercial
// payer, closed status set). This layer turns those database refusals into the standard error envelope and refuses empty or
// backwards writes before they reach the database.
import {
  ConflictError,
  type CommercialEligibilityStalenessPolicy,
  MAX_ELIGIBILITY_MAX_AGE_DAYS,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import type {
  EligibilityStore,
  EnrollmentPatch,
  NewEnrollment,
  OrgScope,
  PlanRef,
  StoredEnrollment,
} from "./store";

const PG_EXCLUSION_VIOLATION = "23P01";
const NOT_COMMERCIAL_MARKER = "M41_PLAN_PAYER_NOT_COMMERCIAL";

function pgCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" ");
}

/** Database refusals that are the caller's doing become envelope errors; anything else is rethrown untouched (a 500). */
function translate(error: unknown): never {
  if (pgCodeOf(error) === PG_EXCLUSION_VIOLATION) {
    throw new ConflictError("An enrollment for this provider entity, payer and clearinghouse already covers part of these dates");
  }
  if (messageChain(error).includes(NOT_COMMERCIAL_MARKER)) {
    throw new ValidationError("The payer must be an active commercial payer", [
      { field: "payerId", code: "INVALID", message: "not an active commercial payer" },
    ]);
  }
  throw error;
}

const invalid = (field: string, message: string): ValidationError =>
  new ValidationError(message, [{ field, code: "INVALID", message }]);

export function createCommercialAdminService(store: EligibilityStore) {
  return {
    listEnrollments: (
      scope: OrgScope,
      filter: { providerEntityId?: string; payerId?: string; limit: number },
    ): Promise<StoredEnrollment[]> => store.listEnrollments(scope, filter),

    async createEnrollment(scope: OrgScope, row: NewEnrollment): Promise<StoredEnrollment> {
      if (row.effectiveTo !== null && row.effectiveTo < row.effectiveFrom) {
        throw invalid("effectiveTo", "effectiveTo must not be before effectiveFrom");
      }
      try {
        return await store.createEnrollment(scope, row);
      } catch (error) {
        return translate(error);
      }
    },

    async patchEnrollment(
      scope: OrgScope,
      providerEntityId: string,
      id: string,
      patch: EnrollmentPatch,
    ): Promise<StoredEnrollment> {
      if (patch.status === undefined && patch.effectiveTo === undefined && patch.evidenceRef === undefined) {
        throw invalid("(root)", "nothing to change");
      }
      let updated: StoredEnrollment | null;
      try {
        updated = await store.patchEnrollment(scope, providerEntityId, id, patch);
      } catch (error) {
        return translate(error);
      }
      if (!updated) throw new NotFoundError("enrollment", id);
      return updated;
    },

    async setEligibilityPolicy(
      scope: OrgScope,
      planId: string,
      policy: CommercialEligibilityStalenessPolicy,
      maxAgeDays: number,
    ): Promise<PlanRef> {
      if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > MAX_ELIGIBILITY_MAX_AGE_DAYS) {
        throw invalid("maxAgeDays", `maxAgeDays must be a whole number from 1 to ${MAX_ELIGIBILITY_MAX_AGE_DAYS}`);
      }
      const plan = await store.setPlanEligibilityPolicy(scope, planId, policy, maxAgeDays);
      if (!plan) throw new NotFoundError("payer plan", planId);
      return plan;
    },
  };
}

export type CommercialAdminService = ReturnType<typeof createCommercialAdminService>;
