// apps/backend/src/modules/37-ipu/routes/system-actor.ts — GAP-106: the TYPED system actor for the two
// M37 transitions that belong to the platform, not to a person (§4.1 route 15 "M6 ack handler (internal
// seam)", §2.11 `postClose` "T+24h sweep").
//
// The old shape inferred "this is the system" from the route being reachable: `confirm` hard-coded
// `lcpConfirmed: true` for any holder of `m37.ipu_admission.create`, and `postClose` hard-coded
// `isSystemActor: true` for any body-release coordinator. Neither is a fact about the caller. A system
// actor is therefore a distinct TYPE that only the factories below can mint (a module-private brand), so it
// can never be assembled from `request.context`, a body, a header or a role string — a tenant session
// holding a role literally named "system" is still an `IpuWriteActor`, and `isIpuSystemActor` says no.
import type { IpuWriteActor } from "./actor";

/** The synthetic membership every M37 platform-driven write is stamped with (the consumers' constant). */
export const M37_SYSTEM_MEMBERSHIP_ID = "00000000-0000-0000-0000-000000000037";

const SYSTEM_ACTOR_BRAND: unique symbol = Symbol("m37.system-actor");

/** The platform-driven callers M37 recognises. Closed set: a new source is a code change, not a string. */
export type IpuSystemActorSource = "m6_lcp_ack" | "body_release_sweep";

/** A platform-driven actor. Not assignable from, or to, {@link IpuWriteActor}. */
export interface IpuSystemActor {
  readonly [SYSTEM_ACTOR_BRAND]: true;
  readonly kind: "system";
  readonly source: IpuSystemActorSource;
  readonly organizationId: string;
  readonly userId: "";
  readonly membershipId: typeof M37_SYSTEM_MEMBERSHIP_ID;
  /** `m6_lcp_ack` only: the M6 level-of-care period M6 itself acknowledged. Verified against the admission. */
  readonly ackedLevelOfCarePeriodId: string | null;
}

/** The actor shapes a body-release / confirm write may be driven by. */
export type IpuActor = IpuWriteActor | IpuSystemActor;

/** True only for an actor minted by this module's factories (never by structure alone). */
export function isIpuSystemActor(actor: unknown): actor is IpuSystemActor {
  return (
    typeof actor === "object" &&
    actor !== null &&
    (actor as { [SYSTEM_ACTOR_BRAND]?: unknown })[SYSTEM_ACTOR_BRAND] === true
  );
}

/** The M6 LCP-ack driver (the M6 activation path). Carries the period M6 acknowledged. */
export function m6LcpAckActor(
  organizationId: string,
  ackedLevelOfCarePeriodId: string,
): IpuSystemActor {
  return {
    [SYSTEM_ACTOR_BRAND]: true,
    kind: "system",
    source: "m6_lcp_ack",
    organizationId,
    userId: "",
    membershipId: M37_SYSTEM_MEMBERSHIP_ID,
    ackedLevelOfCarePeriodId,
  };
}

/** The T+24h body-release sweep driver. */
export function bodyReleaseSweepActor(organizationId: string): IpuSystemActor {
  return {
    [SYSTEM_ACTOR_BRAND]: true,
    kind: "system",
    source: "body_release_sweep",
    organizationId,
    userId: "",
    membershipId: M37_SYSTEM_MEMBERSHIP_ID,
    ackedLevelOfCarePeriodId: null,
  };
}
