// @chartwarden/saas-tenant-platform · services — M34 tenant-lifecycle failure-code catalog (§2.2 / §2.4).
//
// Every guard / validation failure in the pure tenant-lifecycle domain raises a
// `TenantLifecycleError` carrying the machine-readable code below. The error extends the M1
// `ChartWardenError` envelope base (`@chartwarden/types` — NOT the banned `packages/foundation`) so the M1
// Fastify error handler renders it with the precise code + HTTP status with no cross-module import
// edge (the M11 `OrderStateError` convention, packages/orders/src/lifecycle/errors.ts). Nothing
// transitions on a string match — each code is an enumerated constant; the §3.3 DB CHECK constraints
// (e.g. `(status='destroyed') = (destroyed_at IS NOT NULL)`) repeat the strongest of these at the
// schema layer as defense in depth. The route/worker layer reuses these codes verbatim.
import { ChartWardenError } from "@chartwarden/types";

/** The M34 tenant-lifecycle failure-code catalog → canonical HTTP status. */
export const M34_LIFECYCLE_ERROR_STATUS = {
  // §2.2 — the lifecycle transition graph (an event from a state that does not accept it).
  ILLEGAL_TENANT_TRANSITION: 409,
  // §2.2 / §2.4.1 — every transition writes a status-event row; the route refuses with no reason supplied.
  TRANSITION_REASON_REQUIRED: 422,
  // §2.2 — a transition reserved to a specific actor kind was attempted by a different actor (defense in depth).
  ACTOR_KIND_NOT_PERMITTED: 403,
  // §2.2 / §2.5 `provisioning → onboarding` — the tenant_key_ring DEK row is missing/destroyed (TenantKeyMissing).
  TENANT_KEY_MISSING: 412,
  // §2.2 / §2.4.12 `onboarding → active` — a canonical onboarding_task is not yet done/skipped.
  ONBOARDING_TASKS_INCOMPLETE: 412,
  // §2.4.12 `onboarding → active` — no platform_tenant_baa_record with baa_status='executed'.
  BAA_NOT_EXECUTED: 412,
  // §2.2 / §2.4 D11 `onboarding → active` — the executed BAA expires within 90 days (would enter active near lapse).
  BAA_EXPIRING_SOON: 412,
  // §2.2 — `active → offboarding_initiated` is not directly reversible; reversal needs a separate documented decision.
  OFFBOARDING_NOT_REVERSIBLE: 409,
  // §2.2 `retained → destruction_pending` — a legal_hold (M4-owned) still references this organization.
  LEGAL_HOLD_ACTIVE: 409,
  // §2.2 `retained → destruction_pending` — `retention_ends_at` has not yet been reached (auto path guard).
  RETENTION_NOT_ELAPSED: 412,
  // §2.2 `destruction_pending → destroyed` — only the `tenant.shred` worker may effect this transition.
  NOT_SHRED_WORKER: 403,
  // §2.2 D8 / M34-F08 — a `destruction_pending → retained` re-defer with no `refused_part_two_retention` outcome.
  NO_PART_TWO_REFUSAL: 422,
} as const;

/** A machine-readable M34 tenant-lifecycle failure code (§2.2 / §2.4). */
export type M34LifecycleErrorCode = keyof typeof M34_LIFECYCLE_ERROR_STATUS;

/**
 * A guard / validation failure in the M34 tenant-lifecycle domain. Carries the precise `code` so the
 * UI renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard
 * failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class TenantLifecycleError extends ChartWardenError {
  constructor(code: M34LifecycleErrorCode, message: string) {
    super(code, message, M34_LIFECYCLE_ERROR_STATUS[code]);
    this.name = "TenantLifecycleError";
  }
}

/** Throw a {@link TenantLifecycleError} when `condition` is false (guard helper). */
export function require_(
  condition: boolean,
  code: M34LifecycleErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new TenantLifecycleError(code, message);
}
