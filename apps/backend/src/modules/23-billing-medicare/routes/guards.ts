// apps/backend/src/modules/23-billing-medicare/routes/guards.ts — M23 (§4.6 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M23 route
// plugin composes (the M27 cost-report/routes/guards.ts precedent: a local `P(...)` RBAC wrapper + per-
// predicate ABAC wrappers over the §4.7 chain M23 owns, the §D14 step-up assertion, and the
// service-to-service `requireSystemPrincipal` gate for the §4.1 internal seam routes #39/#40). Each guard is
// cast to the local {@link PreHandler} (a @wardenx/auth `GuardHandler` is structurally a Fastify preHandler).
//
// ABAC TARGETING (§4.7): every M23 predicate resolves its provider/caseload/role/rule facts SERVER-SIDE from
// the route's ids — never the request body. The `getTarget` mappers below project the route's `:id`/query/
// body onto the target keys the registered P3 resolvers (abac-predicates.ts) load against:
//   - provider_entity_billing_scope     → `providerEntityId` (direct) | `noeId` | `notrId` | `claimId`
//   - claim_in_billing_manager_caseload → `claimId`
//   - override_role_eligible            → `claimId` + `validationResultId`
//   - regulatory_required_rule_protected→ `ruleConfigId` (PATCH/DELETE the EXISTING overlay row, resolved
//                                          to its rule key via the resolver) | `ruleKey` directly (POST
//                                          .../custom — nothing exists yet to load by id, TASK-051)
// `notFoundOnDeny:true` realizes the §2.2 existence-non-leak rule (a denied object-level check returns 404).
// `inOrg` (M3) and `caseload_or_scope` (M5) are RE-USED base predicates owned + registered by their modules.
import { requireAbac, requireAnyAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { ForbiddenError } from "@wardenx/types";
import type { PreHandler } from "./actor";

/** A structural request shape carrying the ABAC target sources (params/query/body); GuardRequest is assignable. */
type TargetRequest = {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
};
type TargetMap = Record<string, unknown>;

// ── §4.7 target mappers (server-side; the resolver loads the fact from the projected id) ──────────────────

/** Map the route `:id` path-param onto a target key (claim / noe / notr / rule-config flavors below). */
const paramId = (request: TargetRequest, key: string): TargetMap => {
  const params = request.params as { id?: string } | undefined;
  return { [key]: params?.id ?? "" };
};

export const targetClaimId = (request: TargetRequest): TargetMap => paramId(request, "claimId");
export const targetNoeId = (request: TargetRequest): TargetMap => paramId(request, "noeId");
export const targetNotrId = (request: TargetRequest): TargetMap => paramId(request, "notrId");
export const targetTransferNoticeId = (request: TargetRequest): TargetMap =>
  paramId(request, "transferNoticeId");
export const targetRuleConfigId = (request: TargetRequest): TargetMap =>
  paramId(request, "ruleConfigId");

/** RuleKey from the create-custom-rule body — POST .../rule-configs/custom has no `:id` (nothing exists
 *  yet to target by ruleConfigId), so `regulatory_required_rule_protected` targets the key being created. */
export const targetRuleKeyFromBody = (request: TargetRequest): TargetMap => {
  const body = request.body as { ruleKey?: string } | undefined;
  return { ruleKey: body?.ruleKey ?? "" };
};

/** Override route: the validation result is `:resultId`, scoped under the claim `:id`. */
export const targetOverride = (request: TargetRequest): TargetMap => {
  const params = request.params as { id?: string; resultId?: string } | undefined;
  return { claimId: params?.id ?? "", validationResultId: params?.resultId ?? "" };
};

/** ProviderEntity from `:providerEntityId` path param (MAC-credential read). */
export const targetProviderFromParams = (request: TargetRequest): TargetMap => {
  const params = request.params as { providerEntityId?: string } | undefined;
  return { providerEntityId: params?.providerEntityId ?? "" };
};

/** ProviderEntity from the `?providerEntityId=` query (sequestration-policy / MAC list reads). */
export const targetProviderFromQuery = (request: TargetRequest): TargetMap => {
  const query = request.query as { providerEntityId?: string } | undefined;
  return { providerEntityId: query?.providerEntityId ?? "" };
};

/** ProviderEntity from the create/forward-date/upsert body (sequestration / MAC-credential / eligibility). */
export const targetProviderFromBody = (request: TargetRequest): TargetMap => {
  const body = request.body as { providerEntityId?: string } | undefined;
  return { providerEntityId: body?.providerEntityId ?? "" };
};

/** Patient from the body/query (the M5 `caseload_or_scope` base predicate target for eligibility). */
export const targetPatient = (request: TargetRequest): TargetMap => {
  const body = request.body as { patientId?: string } | undefined;
  const query = request.query as { patientId?: string } | undefined;
  return { patientId: body?.patientId ?? query?.patientId ?? "" };
};

// ── RBAC + ABAC + step-up builders ───────────────────────────────────────────────────────────────────────

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M23 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.7 `provider_entity_billing_scope` — the actor's membership is scoped to the resource's ProviderEntity. */
export const PROVIDER_SCOPE = (
  key: string,
  getTarget: (request: TargetRequest) => TargetMap,
): PreHandler =>
  requireAbac(key, "provider_entity_billing_scope", {
    getTarget,
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.7 `claim_in_billing_manager_caseload` — the claim's patient is in the actor's caseload AND PE in scope. */
export const CLAIM_CASELOAD = (
  key: string,
  getTarget: (request: TargetRequest) => TargetMap = targetClaimId,
): PreHandler =>
  requireAbac(key, "claim_in_billing_manager_caseload", {
    getTarget,
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.7 `override_role_eligible` — the actor holds the role the failed result's rule demands (typed RoleKey). */
export const OVERRIDE_ELIGIBLE = (
  key: string,
  getTarget: (request: TargetRequest) => TargetMap = targetOverride,
): PreHandler =>
  requireAbac(key, "override_role_eligible", { getTarget, notFoundOnDeny: true }) as PreHandler;

/** §4.7 `regulatory_required_rule_protected` — DENIES overlay-edit of a `regulatoryRequired` rule (D5). */
export const RULE_PROTECTED = (
  key: string,
  getTarget: (request: TargetRequest) => TargetMap = targetRuleConfigId,
): PreHandler =>
  requireAbac(key, "regulatory_required_rule_protected", {
    getTarget,
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.7 base `caseload_or_scope` (M5-owned) — reused for the patient-context eligibility reads/checks. */
/**
 * `caseload_or_scope` OR M6's `admission_intake_scope` OR M6's `admission_clinical_site_scope` (bound BY NAME through
 * the M3 registry — no import edge into M6): an intake user reaches a patient of the org who has no active / on-hold
 * admission, and a nurse / physician / NP / PA reaches such a patient of their own site — i.e. the readmission /
 * new-admission work. Composed on `GET /billing/eligibility/hospice-periods` ONLY (the readmission screen's HETS
 * history); every other eligibility route keeps {@link CASELOAD_OR_SCOPE}.
 */
export const CASELOAD_OR_INTAKE_SCOPE = (
  key: string,
  getTarget: (request: TargetRequest) => TargetMap = targetPatient,
): PreHandler =>
  requireAnyAbac(
    key,
    ["caseload_or_scope", "admission_intake_scope", "admission_clinical_site_scope"],
    {
      getTarget,
      notFoundOnDeny: true,
    },
  ) as PreHandler;

export const CASELOAD_OR_SCOPE = (
  key: string,
  getTarget: (request: TargetRequest) => TargetMap = targetPatient,
): PreHandler =>
  requireAbac(key, "caseload_or_scope", { getTarget, notFoundOnDeny: true }) as PreHandler;

/**
 * §D14 step-up gate — a thin `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate (the M27
 * `STEP_UP` precedent). Composed on claim submit/replace/void, validation override, NOE/NOTR submit, and
 * MAC-credential admin; the operation key is the permission key so M3-T07 resolves the per-op freshness
 * policy. Submit additionally re-validates step-up token freshness at dispatch in the write service (D2).
 */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;

/**
 * §4.1 internal-seam gate (routes #39/#40) — these endpoints are SERVICE-TO-SERVICE only (M25/M26/M27 call
 * them with a system principal, never an interactive user). Fail-closed: only an actor whose server-assembled
 * `actor_kind` is exactly `system` passes; any user / `ai_*` / absent kind is refused with a 403. The org
 * binding still flows through `request.context` so RLS scopes every downstream read.
 */
export function requireSystemPrincipal(): PreHandler {
  return async (request) => {
    const kind = request.context?.attributes?.actorKind;
    if (kind !== "system") {
      throw new ForbiddenError("this endpoint is restricted to internal system principals");
    }
  };
}
