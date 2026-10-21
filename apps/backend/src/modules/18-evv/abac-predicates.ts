// apps/backend/src/modules/18-evv/abac-predicates.ts — M18-T06 (§4.7, §8.2).
//
// The two named ABAC predicate resolvers M18 OWNS and registers into M3's named-predicate registry (M3 §3.4).
// Both gate every `evv.check_in` / `evv.check_out` route on top of RBAC + the shared `caseload_or_scope` and
// `device_attestation_valid` predicates (§8.2). Each is a typed `(context, target) => Promise<boolean>`
// evaluated server-side AFTER RBAC passes, with the target lifted from the route body (`visitId`,
// `membershipId` = the M2-session posting membership, `eventCapturedAt` = the device-clock capture instant):
//
//   assigned_clinician_for_visit — §4.7 / §8.2 / §8.3 spoofing: only the membership the M17 visit is assigned
//        to may emit EVV for it; reassignment is M17's domain. Resolves the visit's assigned membership via the
//        injected resolver (prod wires M17's `VisitReader`); fail-closed when the visit / assignment is unknown
//        or cross-tenant.
//   evv_within_visit_window — §4.7: the capture instant must fall inside the tenant-configured window relative
//        to the visit's scheduled times (default 2h before scheduled start → 4h after scheduled end; operators
//        widen/narrow within policy bounds). Fail-closed when the visit window / policy is unknown.
//
// Registration is idempotent (the shared registry is single-owner / no-clear): re-boot (tests) guards on
// `abacRegistry.has`. The predicates consume the M17 visit read path ONLY through the injected resolver — no
// direct M17 schema import (D14), no `dependsOn` edge.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@chartwarden/auth";

/** §4.7 — the default EVV capture window: 2h before the scheduled start, 4h after the scheduled end. */
export const DEFAULT_EVV_WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_EVV_WINDOW_AFTER_MS = 4 * 60 * 60 * 1000;

/** The §4.7 predicate names M18 owns (registered into M3). Single-owner across the platform registry. */
export const M18_ABAC_PREDICATES = [
  "assigned_clinician_for_visit",
  "evv_within_visit_window",
] as const;

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The tenant EVV capture window (ms before scheduled start / after scheduled end); tunable within policy. */
export interface EvvCaptureWindow {
  readonly beforeMs: number;
  readonly afterMs: number;
}

/**
 * The read surface M18's ABAC predicates resolve against (the in-memory route service / Drizzle store
 * implements it; prod backs it with M17's `VisitReader`). Every method is org-pinned and fail-closed by
 * contract (returns `null` on absent / cross-tenant facts).
 */
export interface EvvAbacResolver {
  /** The membership the M17 visit is assigned to (drives `assigned_clinician_for_visit`), or null. */
  assignedMembershipForVisit(orgId: string, visitId: string): Promise<string | null>;
  /** The visit's scheduled window ISO instants (drives `evv_within_visit_window`), or null. */
  visitWindowForVisit(
    orgId: string,
    visitId: string,
  ): Promise<{ scheduledStartedAt: string; scheduledEndedAt: string } | null>;
  /** The tenant EVV capture window (default 2h-before / 4h-after when unset). */
  captureWindow(orgId: string): Promise<EvvCaptureWindow>;
}

/** Deps for M18's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface EvvAbacDeps {
  readonly resolver: EvvAbacResolver;
}

/**
 * Build M18's two §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerEvvAbacPredicates}). The capture routes assemble
 * the target from the body — `visitId`, `membershipId` (the M2-session posting membership), and
 * `eventCapturedAt` (the device-clock capture instant).
 */
export function buildEvvAbacPredicates(
  deps: EvvAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    assigned_clinician_for_visit: async (context, target) => {
      const visitId = targetStr(target, "visitId");
      const membershipId = targetStr(target, "membershipId");
      if (!visitId || !membershipId) return false; // incomplete target → deny
      const assigned = await resolver.assignedMembershipForVisit(context.organizationId, visitId);
      if (assigned === null) return false; // absent / cross-tenant → deny
      return assigned === membershipId;
    },
    evv_within_visit_window: async (context, target) => {
      const visitId = targetStr(target, "visitId");
      const capturedAt = targetStr(target, "eventCapturedAt");
      if (!visitId || !capturedAt) return false; // incomplete target → deny
      const window = await resolver.visitWindowForVisit(context.organizationId, visitId);
      if (window === null) return false; // absent / cross-tenant → deny
      const captured = Date.parse(capturedAt);
      const start = Date.parse(window.scheduledStartedAt);
      const end = Date.parse(window.scheduledEndedAt);
      if (Number.isNaN(captured) || Number.isNaN(start) || Number.isNaN(end)) return false;
      const policy = await resolver.captureWindow(context.organizationId);
      return captured >= start - policy.beforeMs && captured <= end + policy.afterMs;
    },
  };
}

/**
 * Register M18's two §4.7 ABAC predicate resolvers into M3's shared registry (M18-T06; idempotent). Call at
 * boot after the EVV route service is constructed (the resolver reads the same dataset / M17 VisitReader).
 * Re-boot (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerEvvAbacPredicates(deps: EvvAbacDeps): void {
  const predicates = buildEvvAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
