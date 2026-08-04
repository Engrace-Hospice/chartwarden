// apps/backend/src/modules/12-dosespot/abac-predicates.ts — M12-T08 (§4.7).
//
// The named ABAC predicate resolvers M12 OWNS and registers into M3's named-predicate registry (M3 §3.4).
// Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   prescriber_eligible[:medClass]  — §2.1 / §4.7: does ANY of the caller's session-assembled disciplines
//        satisfy the medication-class author matrix (`prescriberEligible`)? The target's `medClass` is
//        lifted from the request body by the draft route's `getTarget`; the SUBJECT (the caller's discipline
//        set) is never read from the body. A discipline outside the class's matrix is a structural floor —
//        break-glass cannot grant it (controlled-substance authoring is prescriber-only).
//   dea_schedule_authorized[:schedule]  — §2.4 / §4.7: the caller's `dosespot_prescriber` row authorizes the
//        target DEA schedule. The schedule is lifted from the body (controlled sign routes); the actor's
//        authorized-schedule set loads through the injected {@link DoseSpotAbacResolver} (org-scoped, RLS-
//        backstopped); a missing roster row fails closed (deny).
//   refill_inbox_scope  — §2.7 / §4.7: the caller may see / decide a refill when they are the named
//        prescriber of the source order OR the refill's patient is in the caller's caseload. The refill's
//        facts load through the resolver; the list route carries no id → allow (the service narrows the
//        inbox to the caller's scope itself).
//
// The §4.7 `caseload_or_scope` predicate is SHARED (registered by M5/M6/M7) — M12 binds it by USING the name
// at the route (it is each clinical key's default ABAC), not by re-registering it. The M11 seam predicates
// (`signer_eligible` / `cosigner_role_match`) are owned by M11 and registered by 11-orders; M12's sign /
// cosign routes reference them by name. Registration is idempotent: the shared registry is single-owner /
// no-clear, so re-boot (tests) is idempotent via `registerPredicateIdempotent`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import type { MedClass } from "@wardenx/types";
import { prescriberEligible } from "./prescriber-eligibility";
import type { DoseSpotAbacResolver } from "./routes/service";

/** The §4.7 predicate names M12 owns (registered into M3). Single-owner across the platform registry. */
export const M12_ABAC_PREDICATES = [
  "prescriber_eligible",
  "dea_schedule_authorized",
  "refill_inbox_scope",
] as const;

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Assemble the actor's prescribing-discipline set from session roles/attributes (never client input),
 * normalized to lower-case. Reads `attributes.disciplines` first, then the role tokens — the same source the
 * route's discipline derivation reads (M11 precedent).
 */
export function prescriberDisciplinesOf(context: AbacContext): readonly string[] {
  const fromAttributes = Array.isArray(context.attributes.disciplines)
    ? context.attributes.disciplines.filter((x): x is string => typeof x === "string")
    : [];
  return [...new Set([...fromAttributes, ...context.roles])].map((d) => d.toLowerCase());
}

/** Deps for M12's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface DoseSpotAbacDeps {
  readonly resolver: DoseSpotAbacResolver;
}

/**
 * Build M12's three §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerDoseSpotAbacPredicates}). The draft route's
 * target carries the body's `medClass`; the controlled sign routes' target carries the body's `schedule`;
 * the refill routes' target carries the `:id` route param.
 */
export function buildDoseSpotAbacPredicates(
  deps: DoseSpotAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    prescriber_eligible: async (context, target) => {
      const medClass = targetStr(target, "medClass");
      if (!medClass) return false; // no class named → deny (fail-closed)
      return prescriberDisciplinesOf(context).some((d) =>
        prescriberEligible(d, medClass as MedClass),
      );
    },
    dea_schedule_authorized: async (context, target) => {
      const schedule = targetStr(target, "schedule");
      if (!schedule) return false; // no schedule named → deny (fail-closed)
      const authorized = await resolver.loadAuthorizedSchedules(
        context.organizationId,
        context.userId,
      );
      if (!authorized) return false; // no roster row (fail-closed)
      return authorized.includes(schedule);
    },
    refill_inbox_scope: async (context, target) => {
      const id = targetStr(target, "id") ?? targetStr(target, "refillId");
      if (!id) return true; // list view — the service narrows the inbox to the caller's scope.
      const facts = await resolver.loadRefillScope(context.organizationId, id, context.userId);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      return facts.isNamedPrescriber || facts.patientInCaseload;
    },
  };
}

/**
 * Register M12's three §4.7 ABAC predicate resolvers into M3's shared registry (M12-T08; idempotent). Call at
 * boot after the medication-order route service is constructed (the resolver reads the same dataset). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerDoseSpotAbacPredicates(deps: DoseSpotAbacDeps): void {
  const predicates = buildDoseSpotAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
