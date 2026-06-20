// @wardenx/messaging — the ADR-0024 cross-module composition resolvers (M36-T09, spec §4.11).
//
// SD-017 assigns recipient resolution + preference-aware routing to the M36 Alert Engine; ADR-0024
// moves the composition + recipient resolution for the referral / critical-results /
// transmission-failure event families OUT of M14 and into M36. The recipient *audiences* are
// IDG-adjacent, but the *mechanism* (recipient resolution) is generic alert-engine work M36 owns —
// so the four resolvers register onto M36's OPEN registry (../resolution/recipients) WITHOUT
// changing its core seven built-ins (§4.6). M36 stays foundation-tier (M36-F01): the producer
// modules (M6/M11/M22) emit their typed outbox events; M36 never imports them.
//
//   • `ordering_provider` — the order's ordering provider (critical-results, transmission-failure).
//   • `ordering_provider_with_active_orders_for_physician` — §3.12.4 fan-out for a deactivated
//      physician's open orders.
//   • `intake_supervisor` — admissions/intake-supervisor role members (referral received/declined).
//   • `admissions_team` — admissions-team role members (referral accepted/withdrawn).

import type { RecipientResolverFn } from "../resolution/recipients";

/**
 * The source-of-truth lookups the ADR-0024 resolvers delegate to — bound at boot to the order/MDM
 * seam (`ordering_provider*`) and M2 membership (`role_set`-style audiences). Kept as plain async
 * ports so the resolvers stay pure and unit-testable with fakes (the M6/M11/M22/M40 seams are not
 * required to exercise the resolution logic).
 */
export interface CompositionResolverPorts {
  /** The ordering provider's user ids for the order referenced in the source payload (`orderId`). */
  orderingProviderForOrder(orgId: string, orderId: string): Promise<readonly string[]>;
  /** Ordering providers with ACTIVE orders for a (deactivated) physician — the §3.12.4 fan-out. */
  orderingProvidersWithActiveOrdersForPhysician(
    orgId: string,
    physicianId: string,
  ): Promise<readonly string[]>;
  /** M2 membership filtered by an explicit role-key set — backs the two referral audiences. */
  roleSetMembers(orgId: string, roleKeys: readonly string[]): Promise<readonly string[]>;
}

/** Default role-key sets for the two referral audiences (overridable per-rule via `resolverArgs`). */
export const COMPOSITION_RESOLVER_ROLE_KEYS = {
  intake_supervisor: ["intake_supervisor"],
  admissions_team: ["admissions_team"],
} as const;

/** The four resolver names ADR-0024 adds to the registry (the typed `RecipientResolver.name` set). */
export const COMPOSITION_RESOLVER_NAMES = [
  "ordering_provider",
  "ordering_provider_with_active_orders_for_physician",
  "intake_supervisor",
  "admissions_team",
] as const;

/** Read a non-empty string off the payload at `key`, else null (mirrors the core resolvers). */
function readPath(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A `*Path` arg as a string (where in the payload a subject id lives), or undefined. */
function pathArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Role keys off `resolverArgs.roleKeys` when present, else the supplied default. */
function roleKeysArg(args: Record<string, unknown>, fallback: readonly string[]): readonly string[] {
  const v = args.roleKeys;
  return Array.isArray(v) && v.every((k) => typeof k === "string") ? (v as string[]) : fallback;
}

/**
 * Register the four ADR-0024 composition resolvers onto an EXISTING resolver registry (the map
 * {@link import("../resolution/recipients").createRecipientResolverRegistry} returns), over the
 * given source ports. Additive — it never replaces a built-in; an `ordering_provider` (etc.) name
 * is new to the registry. Returns the same registry for chaining. Idempotent re-registration
 * simply overwrites with an equivalent resolver.
 *
 * Like the built-ins, an `ordering_provider*` resolver returns `[]` when the payload omits the
 * subject id rather than throwing — a missing `orderId` is a producer-payload problem the dispatch
 * outcome surfaces (§7.13 "malformed payload"), not a resolver crash.
 */
export function registerCompositionResolvers(
  registry: Map<string, RecipientResolverFn>,
  ports: CompositionResolverPorts,
): Map<string, RecipientResolverFn> {
  registry.set("ordering_provider", async (orgId, args, payload) => {
    const orderId = readPath(payload, pathArg(args, "orderIdPath") ?? "orderId");
    return orderId === null ? [] : ports.orderingProviderForOrder(orgId, orderId);
  });

  registry.set(
    "ordering_provider_with_active_orders_for_physician",
    async (orgId, args, payload) => {
      const physicianId = readPath(payload, pathArg(args, "physicianIdPath") ?? "physicianId");
      return physicianId === null
        ? []
        : ports.orderingProvidersWithActiveOrdersForPhysician(orgId, physicianId);
    },
  );

  registry.set("intake_supervisor", async (orgId, args) =>
    ports.roleSetMembers(orgId, roleKeysArg(args, COMPOSITION_RESOLVER_ROLE_KEYS.intake_supervisor)),
  );

  registry.set("admissions_team", async (orgId, args) =>
    ports.roleSetMembers(orgId, roleKeysArg(args, COMPOSITION_RESOLVER_ROLE_KEYS.admissions_team)),
  );

  return registry;
}
