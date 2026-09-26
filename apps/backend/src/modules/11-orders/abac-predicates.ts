import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
// apps/backend/src/modules/11-orders/abac-predicates.ts — M11-T06 (§4.7).
//
// The named ABAC predicate resolvers M11 OWNS and registers into M3's named-predicate registry (M3 §3.4).
// Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   discipline_can_order  — §2.1 / §4.7: does ANY of the caller's session-assembled disciplines satisfy the
//        kind's author matrix (`@wardenx/orders` `disciplineCanOrder`)? The target's `kind` is lifted from
//        the request body by the author route's `getTarget`; the SUBJECT (the caller's discipline set) is
//        never read from the body. A discipline outside the kind's matrix is a structural floor — break-
//        glass cannot grant it (§4.6 discipline floor).
//   signer_eligible       — §2.2 / §4.7: does ANY of the caller's disciplines satisfy the kind's signer
//        matrix (stricter than authoring; physician-only for recert / LOC change)? The order's `kind` loads
//        through the injected {@link OrderAbacResolver} (org-scoped, RLS-backstopped); a missing / cross-
//        tenant order fails closed (deny).
//   cosigner_role_match   — §2.5 / §7.3: the caller's role satisfies the cosigner role the order's resolved
//        cosign axis demands AND the caller is not the order's drafter (no self-cosign). The required role +
//        author membership load through the resolver; fail-closed on a missing order.
//
// The §4.7 `caseload_or_scope` predicate is SHARED (registered by M5/M6/M7) — M11 binds it by USING the name
// at the route (it is each clinical key's default ABAC), not by re-registering it. Registration is
// idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) is idempotent via `registerPredicateIdempotent`.
import { disciplineCanOrder, signerEligible } from "@wardenx/orders";
import type { OrderKind } from "@wardenx/types";
import type { OrderAbacResolver } from "./routes/service";

/**
 * The §4.7 predicate names M11 owns (registered into M3). `cosigner_role_match` is namespaced `m11.` —
 * M8/M9/M11 each define one with DIFFERENT target-field expectations; a shared bare name meant whichever
 * module booted first silently won the registration and the other two's cosign checks were quietly
 * replaced by a resolver that could never find its target field — always denying, with no error anywhere
 * (ARCH-001/002). Single-owner across the platform registry.
 */
export const M11_ABAC_PREDICATES = [
  "discipline_can_order",
  "signer_eligible",
  "m11.cosigner_role_match",
] as const;

/** The disciplines an RN cosignature (§2.5 axis 1) accepts; the medical_director satisfies the MD demand. */
const RN_COSIGN_ROLES = ["rn_case_manager", "clinical_supervisor"] as const;

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Assemble the actor's order discipline set from the session role keys (never client input), normalized to
 * the lower-case keys the `@wardenx/orders` matrices compare.
 *
 * Derived from the ROLE KEYS M2 assembled onto the request context. It USED to union in an
 * `attributes.disciplines` array first; nothing in the platform has ever written that key, so the union was
 * with the empty set on every request ever served, and the role arm has been the whole answer all along
 * (F-030). See `07-care-plan/abac-predicates.ts` for the full argument.
 */
export function orderDisciplinesOf(context: AbacContext): readonly string[] {
  return [...new Set(context.roles)].map((d) => d.toLowerCase());
}

/** Whether a caller's role satisfies the demanded cosign role (an RN role satisfies either RN demand). */
function roleSatisfiesCosign(roles: readonly string[], needed: string): boolean {
  const lower = roles.map((r) => r.toLowerCase());
  if (needed === "medical_director") return lower.includes("medical_director");
  return lower.some((r) => (RN_COSIGN_ROLES as readonly string[]).includes(r));
}

/** Deps for M11's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface OrderAbacDeps {
  readonly resolver: OrderAbacResolver;
}

/**
 * Build M11's three §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerOrderAbacPredicates}). The author route's target
 * carries the body's `kind`; the sign / cosign routes' target carries the `:id` route param.
 */
export function buildOrderAbacPredicates(
  deps: OrderAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    discipline_can_order: async (context, target) => {
      const kind = targetStr(target, "kind");
      if (!kind) return false; // no kind named → deny (fail-closed)
      return orderDisciplinesOf(context).some((d) => disciplineCanOrder(d, kind as OrderKind));
    },
    signer_eligible: async (context, target) => {
      const id = targetStr(target, "id") ?? targetStr(target, "orderId");
      if (!id) return false;
      const facts = await resolver.loadOrder(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      return orderDisciplinesOf(context).some((d) => signerEligible(d, facts.kind));
    },
    "m11.cosigner_role_match": async (context, target) => {
      const id = targetStr(target, "id") ?? targetStr(target, "orderId");
      if (!id) return false;
      const facts = await resolver.loadOrder(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      const needed = facts.cosignerRoleNeeded ?? "rn_case_manager";
      if (!roleSatisfiesCosign(context.roles, needed)) return false;
      return facts.drafterMembershipId !== context.userId; // no self-cosign (§7.3)
    },
  };
}

/**
 * Register M11's three §4.7 ABAC predicate resolvers into M3's shared registry (M11-T06; idempotent). Call at
 * boot after the order route service is constructed (the resolver reads the same dataset). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerOrderAbacPredicates(deps: OrderAbacDeps): void {
  const predicates = buildOrderAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
