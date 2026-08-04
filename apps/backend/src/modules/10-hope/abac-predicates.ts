import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
// apps/backend/src/modules/10-hope/abac-predicates.ts — M10-T06 (§4.7).
//
// The THREE named ABAC predicate resolvers M10 OWNS and registers into M3's named-predicate registry (M3
// §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   hope.authorDisciplineAllowed   — D-decision: only RN / NP / MD may author/sign/correct a HOPE
//        timepoint. The actor's discipline set is assembled from session roles/attributes (never client
//        input). A discipline NOT in the set is a structural floor — break-glass cannot grant it (§6).
//   hope.sfvAuthorAllowed          — the CMS HOPE manual restricts the SFV (RFA-04) author further: only
//        RN / NP may sign an SFV completion.
//   hope.correctionAuthorAllowed   — the correction (§4.1 `/correct`) author must be the original signer
//        OR hold the clinical-lead role (broadened scope). The original-signer fact loads through the
//        injected {@link HopeAbacResolver} (org-scoped, RLS-backstopped); a missing/cross-tenant row
//        fails closed (deny).
//
// The §4.1 `caseload` / `provider_entity` / `platform_admin` ABAC columns map to SHARED predicates
// (`caseload_or_scope` registered by M5/M7; `provider_entity_scope` is an M3 intrinsic) — M10 binds those
// by USING the names at the route, not by re-registering them. Registration is idempotent: the shared
// registry is single-owner / no-clear, so re-boot (tests) is idempotent via `registerPredicateIdempotent`.
import { isHopeAuthorDisciplineAllowed, isSfvAuthorDisciplineAllowed } from "@wardenx/hope";

/** The §4.7 predicate names M10 owns (registered into M3). Single-owner across the platform registry. */
export const M10_ABAC_PREDICATES = [
  "hope.authorDisciplineAllowed",
  "hope.sfvAuthorAllowed",
  "hope.correctionAuthorAllowed",
] as const;

/** The HOPE clinical-lead role token that may correct any signed assessment (§4.7 / §4.6). */
const CLINICAL_LEAD_ROLES = ["clinical_lead", "clinical_supervisor"] as const;

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Assemble the actor's HOPE discipline set from session roles/attributes (never client input), normalized
 * to the uppercase HOPE codes (`RN` / `NP` / `MD`). Reads `attributes.disciplines` first, then the role
 * tokens (case-insensitive) — the same source the route's discipline derivation reads.
 */
export function hopeDisciplinesOf(context: AbacContext): readonly string[] {
  const fromAttributes = Array.isArray(context.attributes.disciplines)
    ? context.attributes.disciplines.filter((x): x is string => typeof x === "string")
    : [];
  return [...new Set([...fromAttributes, ...context.roles])].map((d) => d.toUpperCase());
}

/** Whether the actor holds the HOPE clinical-lead role (case-insensitive). */
function isClinicalLead(context: AbacContext): boolean {
  return context.roles.some((r) =>
    (CLINICAL_LEAD_ROLES as readonly string[]).includes(r.toLowerCase()),
  );
}

/** The original-signer facts M10's correction predicate resolves for a target assessment id. */
export interface HopeAssessmentAbacFacts {
  readonly originalSignedBy: string | null;
}

/** Loads a HOPE assessment's org-scoped signer facts (in-memory in the slice; Drizzle in prod under RLS). */
export interface HopeAbacResolver {
  loadAssessment(
    organizationId: string,
    assessmentId: string,
  ): Promise<HopeAssessmentAbacFacts | null>;
}

/** Deps for M10's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface HopeAbacDeps {
  readonly resolver: HopeAbacResolver;
}

/**
 * Build M10's three §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerHopeAbacPredicates}). The author/SFV routes
 * read the actor's discipline set from session context; the correction route's target carries the `:id`
 * route param.
 */
export function buildHopeAbacPredicates(
  deps: HopeAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    "hope.authorDisciplineAllowed": async (context) =>
      hopeDisciplinesOf(context).some((d) => isHopeAuthorDisciplineAllowed(d)),
    "hope.sfvAuthorAllowed": async (context) =>
      hopeDisciplinesOf(context).some((d) => isSfvAuthorDisciplineAllowed(d)),
    "hope.correctionAuthorAllowed": async (context, target) => {
      if (isClinicalLead(context)) return true;
      const id = targetStr(target, "id") ?? targetStr(target, "assessmentId");
      if (!id) return false;
      const facts = await resolver.loadAssessment(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      return facts.originalSignedBy != null && facts.originalSignedBy === context.userId;
    },
  };
}

/**
 * Register M10's three §4.7 ABAC predicate resolvers into M3's shared registry (M10-T06; idempotent). Call
 * at boot after the HOPE route service is constructed (the resolver reads the same dataset). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerHopeAbacPredicates(deps: HopeAbacDeps): void {
  const predicates = buildHopeAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
