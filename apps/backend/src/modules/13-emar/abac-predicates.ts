// apps/backend/src/modules/13-emar/abac-predicates.ts — M13-T08 (§4.7).
//
// The four named ABAC predicate resolvers M13 OWNS and registers into M3's named-predicate registry (M3 §3.4).
// Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   administering_clinician_eligible[:medClass]  — §4.7: does ANY of the caller's session-assembled disciplines
//        satisfy the medication-class administration matrix? The class is resolved from the ORDER the target
//        names (`medicationOrderId`) through the resolver — never from the request body (GAP-005: a body
//        `medClass` of `standard` on a Schedule II order used to pick the matrix AND skip the witness). The
//        SUBJECT (the caller's discipline set) is never read from the body either. A discipline outside the class's matrix is a structural floor (per-state SOP overrides may
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
//   emar.scope  — GAP-004 / §4.1 `caseload_or_scope` on every M13 PHI route. The routes are keyed by an
//        administration / IV session / scheduled or missed dose / worksheet / deployment / order id, or a
//        `?patient=` query, and `requireAbac`'s `getTarget` is synchronous — so, like M9's `assessment.scope`,
//        this M13-owned predicate resolves each named id to its patient INSIDE the evaluator and applies the
//        same org-wide-role ∨ session-pinned-patient ∨ caseload composition the shared `caseload_or_scope`
//        uses. Every id the target names must resolve and be in scope (a refusal naming patient A and an
//        order for patient B is refused). Nothing named, or anything unresolvable → deny (fail-closed).
//        The header used to claim `caseload_or_scope` was "bound by the §4.6 default ABAC" — it was not:
//        `requirePermission` never reads `PermissionDef.abac`, so no M13 route had any patient scope.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) is idempotent
// via `registerPredicateIdempotent`.
import {
  type AbacContext,
  type AbacTarget,
  hasOrgWideScope,
  registerPredicateIdempotent,
} from "@wardenx/auth";
import { controlledSubstanceWitnessEligible } from "@wardenx/emar";
import type { ReconciliationTriggerKind } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";

/** The §4.7 predicate names M13 owns (registered into M3). Single-owner across the platform registry. */
export const M13_ABAC_PREDICATES = [
  "administering_clinician_eligible",
  "controlled_substance_witness_eligible",
  "caregiver_attested_review_required",
  "reconciliation_authoring_eligible",
  "emar.scope",
] as const;

/** The id kinds `emar.scope` resolves to a patient (each is a target field of the same name). */
export const EMAR_SCOPE_REF_KINDS = [
  "administrationId",
  "ivSessionId",
  "scheduledDoseId",
  "missedDoseId",
  "worksheetId",
  "deploymentId",
  "medicationOrderId",
] as const;
export type EmarScopeRefKind = (typeof EMAR_SCOPE_REF_KINDS)[number];

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
 * Assemble the actor's clinical-discipline set from the session role keys (never client input), normalized
 * to lower-case (the M12 precedent).
 *
 * Derived from the ROLE KEYS M2 assembled onto the request context. It USED to union in an
 * `attributes.disciplines` array first; nothing in the platform has ever written that key, so the union was
 * with the empty set on every request ever served, and the role arm has been the whole answer all along
 * (F-030). See `07-care-plan/abac-predicates.ts` for the full argument.
 */
export function actorDisciplinesOf(context: AbacContext): readonly string[] {
  return [...new Set(context.roles)].map(disciplineKey);
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
  /** GAP-004 — the patient an M13 row (or the order) belongs to; null when absent / cross-tenant. */
  loadScopePatientId(orgId: string, kind: EmarScopeRefKind, id: string): Promise<string | null>;
  /** GAP-005 — the order's medication class (M12's, never the request's); null when unresolvable. */
  loadOrderMedClass(orgId: string, medicationOrderId: string): Promise<string | null>;
}

/** Caseload membership check — the M5 `CaseloadProvider.isInCaseload` shape. */
export type EmarCaseloadCheck = (q: {
  organizationId: string;
  userId: string;
  patientId: string;
}) => Promise<boolean>;

/** Deps for M13's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface EmarAbacDeps {
  readonly resolver: EmarAbacResolver;
  /** Caseload membership (defaults to the boot-registered M5 `CaseloadProvider` seam, resolved per call). */
  readonly isInCaseload?: EmarCaseloadCheck;
}

/** The patient a collaborator / funeral / portal session is pinned to (server-assembled, M7 precedent). */
function sessionScopePatientId(context: AbacContext): string | null {
  const raw = context.attributes.sessionPatientId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
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
  const isInCaseload: EmarCaseloadCheck =
    deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));

  const patientInScope = async (context: AbacContext, patientId: string): Promise<boolean> => {
    if (hasOrgWideScope(context.roles)) return true;
    if (sessionScopePatientId(context) === patientId) return true;
    if (!context.userId) return false;
    return isInCaseload({
      organizationId: context.organizationId,
      userId: context.userId,
      patientId,
    });
  };

  return {
    administering_clinician_eligible: async (context, target) => {
      const medicationOrderId = targetStr(target, "medicationOrderId");
      if (!medicationOrderId) return false; // no order named → deny (fail-closed)
      const medClass = await resolver.loadOrderMedClass(context.organizationId, medicationOrderId);
      if (!medClass) return false; // unresolvable order → deny (fail-closed)
      const matrix = ADMINISTERING_ELIGIBLE_DISCIPLINES[medClass];
      if (!matrix) return false; // unknown class → deny (fail-closed)
      return actorDisciplinesOf(context).some((d) => (matrix as readonly string[]).includes(d));
    },
    controlled_substance_witness_eligible: async (context, target) => {
      const administeringMembershipId =
        targetStr(target, "administeringClinicianMembershipId") ??
        targetStr(target, "administeringMembershipId");
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
      const administrationId =
        targetStr(target, "id") ?? targetStr(target, "administrationRecordId");
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
      const triggerKind = await resolver.loadWorksheetTriggerKind(
        context.organizationId,
        worksheetId,
      );
      if (!triggerKind) return false; // absent / cross-tenant (fail-closed)
      const matrix = RECONCILIATION_AUTHORING_DISCIPLINES[triggerKind];
      return actorDisciplinesOf(context).some((d) => (matrix as readonly string[]).includes(d));
    },
    "emar.scope": async (context, target) => {
      const patientIds: string[] = [];
      const named = targetStr(target, "patientId");
      if (named) patientIds.push(named);
      for (const kind of EMAR_SCOPE_REF_KINDS) {
        const id = targetStr(target, kind);
        if (!id) continue;
        const patientId = await resolver.loadScopePatientId(context.organizationId, kind, id);
        if (!patientId) return false; // absent / cross-tenant row (fail-closed)
        patientIds.push(patientId);
      }
      if (patientIds.length === 0) return false; // nothing named → deny (fail-closed)
      for (const patientId of new Set(patientIds)) {
        if (!(await patientInScope(context, patientId))) return false;
      }
      return true;
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
