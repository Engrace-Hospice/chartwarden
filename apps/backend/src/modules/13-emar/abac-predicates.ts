// apps/backend/src/modules/13-emar/abac-predicates.ts — M13-T08 (§4.7).
//
// The four named ABAC predicate resolvers M13 OWNS and registers into M3's named-predicate registry (M3 §3.4).
// Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   administering_clinician_eligible[:medClass]  — §4.7: does ANY of the caller's session-assembled disciplines
//        satisfy the medication-class administration matrix? The target's `medClass` is lifted from the request
//        body by the record route's `getTarget`; the SUBJECT (the caller's discipline set) is never read from
//        the body. A discipline outside the class's matrix is a structural floor (per-state SOP overrides may
//        further restrict via `administration_policy.state_overrides`, layered in the service — not relaxed here).
//   controlled_substance_witness_eligible  — §2.6 D7 / §4.7: the witness (the caller minting the attestation
//        token) is a DIFFERENT active clinical-discipline membership from the administering clinician (lifted
//        from the body), in {rn, lpn, md, np, pa}, on the same tenant, and not a caregiver. Reuses the PURE
//        `controlledSubstanceWitnessEligible` decision from @wardenx/emar; the witness facts load through the
//        injected {@link EmarAbacResolver}.
//   caregiver_attested_review_required  — §4.7: the caller is the patient's RN case manager (resolved through
//        M5 `CaseloadProvider`) for an administration row whose `requires_rn_review = true`. The administration
//        id is the `:id` route param; the facts load through the resolver (fail-closed if absent / cross-tenant).
//   reconciliation_authoring_eligible  — §4.7: the caller's discipline is eligible to author decisions for the
//        worksheet's trigger kind ({rn, np, pa, md} for admission/transfer_in/recertification; that set plus
//        clinical_supervisor for discharge). The worksheet id is the `:id` route param; the trigger kind loads
//        through the resolver.
//
// The §4.7 `caseload_or_scope` predicate is SHARED (registered by M5/M6/M7) — M13 binds it by USING the name at
// the route (it is each clinical key's default ABAC), not by re-registering it. Registration is idempotent: the
// shared registry is single-owner / no-clear, so re-boot (tests) is idempotent via `registerPredicateIdempotent`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { controlledSubstanceWitnessEligible } from "@wardenx/emar";
import type { ReconciliationTriggerKind } from "@wardenx/types";

/** The §4.7 predicate names M13 owns (registered into M3). Single-owner across the platform registry. */
export const M13_ABAC_PREDICATES = [
  "administering_clinician_eligible",
  "controlled_substance_witness_eligible",
  "caregiver_attested_review_required",
  "reconciliation_authoring_eligible",
] as const;

/** §4.7 — the disciplines that may administer a given medication class (the administering-clinician matrix). */
export const ADMINISTERING_ELIGIBLE_DISCIPLINES: Readonly<Record<string, readonly string[]>> = {
  standard: ["rn", "lpn", "md", "np", "pa"],
  controlled_substance: ["rn", "lpn", "md", "np", "pa"],
  compounded: ["rn", "md", "np"],
};

/** §4.7 — the disciplines that may author reconciliation decisions for a given trigger kind. */
export const RECONCILIATION_AUTHORING_DISCIPLINES: Readonly<
  Record<ReconciliationTriggerKind, readonly string[]>
> = {
  admission: ["rn", "np", "pa", "md"],
  transfer_in: ["rn", "np", "pa", "md"],
  recertification: ["rn", "np", "pa", "md"],
  discharge: ["rn", "np", "pa", "md", "clinical_supervisor"],
};

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Normalize a discipline/role token for matching (case-insensitive, trimmed). */
function disciplineKey(d: string): string {
  return d.trim().toLowerCase();
}

/**
 * Assemble the actor's clinical-discipline set from session roles/attributes (never client input), normalized
 * to lower-case. Reads `attributes.disciplines` first, then the role tokens — the M12 precedent.
 */
export function actorDisciplinesOf(context: AbacContext): readonly string[] {
  const fromAttributes = Array.isArray(context.attributes.disciplines)
    ? context.attributes.disciplines.filter((x): x is string => typeof x === "string")
    : [];
  return [...new Set([...fromAttributes, ...context.roles])].map(disciplineKey);
}

/** The witness facts the resolver loads about the token-minting caller before `administration_witness` writes. */
export interface WitnessAbacFacts {
  readonly witnessMembershipId: string;
  readonly witnessDiscipline: string;
  readonly witnessMembershipActive: boolean;
  readonly sameTenant: boolean;
  readonly witnessIsCaregiver: boolean;
  readonly witnessIsBreakGlass: boolean;
}

/** The caregiver-review facts the resolver loads for an administration row. */
export interface CaregiverReviewAbacFacts {
  readonly requiresRnReview: boolean;
  readonly actorIsRnCaseManager: boolean;
}

/** The read surface M13's ABAC predicates resolve against (the in-memory slice / Drizzle store implements it). */
export interface EmarAbacResolver {
  loadWitnessFacts(orgId: string, witnessUserId: string): Promise<WitnessAbacFacts | null>;
  loadCaregiverReviewFacts(
    orgId: string,
    administrationId: string,
    actorUserId: string,
  ): Promise<CaregiverReviewAbacFacts | null>;
  loadWorksheetTriggerKind(
    orgId: string,
    worksheetId: string,
  ): Promise<ReconciliationTriggerKind | null>;
}

/** Deps for M13's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface EmarAbacDeps {
  readonly resolver: EmarAbacResolver;
}

/**
 * Build M13's four §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerEmarAbacPredicates}). The record route's target
 * carries the body's `medClass`; the witness-attest route's target carries the body's
 * `administeringClinicianMembershipId`; the caregiver acknowledge/dispute routes' target carries the `:id`
 * route param; the reconciliation decide/finalize routes' target carries the worksheet `:id`.
 */
export function buildEmarAbacPredicates(
  deps: EmarAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    administering_clinician_eligible: async (context, target) => {
      const medClass = targetStr(target, "medClass");
      if (!medClass) return false; // no class named → deny (fail-closed)
      const matrix = ADMINISTERING_ELIGIBLE_DISCIPLINES[medClass];
      if (!matrix) return false; // unknown class → deny (fail-closed)
      return actorDisciplinesOf(context).some((d) => (matrix as readonly string[]).includes(d));
    },
    controlled_substance_witness_eligible: async (context, target) => {
      const administeringMembershipId =
        targetStr(target, "administeringClinicianMembershipId") ?? targetStr(target, "administeringMembershipId");
      if (!administeringMembershipId) return false; // no administering clinician named → deny (fail-closed)
      const facts = await resolver.loadWitnessFacts(context.organizationId, context.userId);
      if (!facts) return false; // no membership facts (fail-closed)
      const verdict = controlledSubstanceWitnessEligible({
        witnessMembershipId: facts.witnessMembershipId,
        administeringClinicianMembershipId: administeringMembershipId,
        witnessDiscipline: facts.witnessDiscipline,
        witnessMembershipActive: facts.witnessMembershipActive,
        sameTenant: facts.sameTenant,
        witnessIsCaregiver: facts.witnessIsCaregiver,
        witnessIsBreakGlass: facts.witnessIsBreakGlass,
      });
      return verdict.eligible;
    },
    caregiver_attested_review_required: async (context, target) => {
      const administrationId = targetStr(target, "id") ?? targetStr(target, "administrationRecordId");
      if (!administrationId) return false; // no row named → deny (fail-closed)
      const facts = await resolver.loadCaregiverReviewFacts(
        context.organizationId,
        administrationId,
        context.userId,
      );
      if (!facts) return false; // absent / cross-tenant (fail-closed)
      return facts.requiresRnReview && facts.actorIsRnCaseManager;
    },
    reconciliation_authoring_eligible: async (context, target) => {
      const worksheetId = targetStr(target, "id") ?? targetStr(target, "worksheetId");
      if (!worksheetId) return false; // no worksheet named → deny (fail-closed)
      const triggerKind = await resolver.loadWorksheetTriggerKind(context.organizationId, worksheetId);
      if (!triggerKind) return false; // absent / cross-tenant (fail-closed)
      const matrix = RECONCILIATION_AUTHORING_DISCIPLINES[triggerKind];
      return actorDisciplinesOf(context).some((d) => (matrix as readonly string[]).includes(d));
    },
  };
}

/**
 * Register M13's four §4.7 ABAC predicate resolvers into M3's shared registry (M13-T08; idempotent). Call at
 * boot after the administration route service is constructed (the resolver reads the same dataset). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerEmarAbacPredicates(deps: EmarAbacDeps): void {
  const predicates = buildEmarAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
