// @chartwarden/saas-tenant-platform · services — tenant-lifecycle side-effect descriptors (§2.5, M34).
//
// The M8/M11 §2.8 pattern (packages/orders/src/lifecycle/effects.ts): every transition carries an
// explicit, in-transaction side-effect list, and the COMMIT binds the `tenant_account` row, the
// `tenant_account_status_event` ledger row, and the outbox row atomically — the "DB updated but the
// event never went out" failure mode is eliminated structurally (M1 §25.5/§25.6, §2.6). This PURE
// engine returns side effects DECLARATIVELY as data; the route/worker SERVICE layer (later M34 phase)
// executes them inside the tenant_account's optimistic-locked transaction (load → run guards →
// update status → append status-event → enqueue jobs → outbox.publish() → emit M36 alerts). Keeping
// them as data makes the machine deterministic and unit-testable with no DB, MinIO, queue, or M2/M4/M36.
//
// M34 has no `M34EventName` type in @chartwarden/types yet (the §4.4 outbox catalog lands with the backend
// wiring phase — apps/backend/src/modules/34-saas-tenant-platform/events-by-m34.ts, the M11/M14 pattern).
// Until then this module pins the §2.5 outbox names as string-literal constants so the pure machine is
// self-contained; the backend `events-by-m34.ts` will adopt these verbatim as the authoritative catalog.

/** The §2.5 `m34.tenant.*` outbox event names emitted on status transitions (string-pinned until the
 *  §4.4 `M34EventName` catalog lands in the backend wiring phase — adopt verbatim there). */
export const M34_LIFECYCLE_EVENTS = [
  "m34.tenant.provision_started",
  "m34.tenant.provisioned",
  "m34.tenant.activated",
  // "suspension_initiated", not "suspended" — the wire name is `events-by-m34.ts`'s (that catalog is
  // authoritative; this list mirrors it, per the file header). A mismatch here meant every suspend
  // transition's outbox effect named an event no catalog declared — the dispatcher would refuse the
  // publish outright, which is exactly why `runSideEffects` (service-drizzle.ts) had to gate this
  // event out entirely rather than emit it (#103, found + fixed alongside the M2 hard-half, #205).
  "m34.tenant.suspension_initiated",
  "m34.tenant.reactivated",
  "m34.tenant.at_risk",
  "m34.tenant.offboarding_initiated",
  "m34.tenant.final_export_pending",
  "m34.tenant.retained",
  "m34.tenant.destruction_pending",
  "m34.tenant.destroyed",
] as const;

/** One `m34.tenant.*` outbox event name (§2.5 / §4.4). */
export type M34LifecycleEvent = (typeof M34_LIFECYCLE_EVENTS)[number];

/** A worker queue job a transition asks the service to enqueue (§2.5). The job *bodies* are keyed by
 *  `tenant_account_id` (idempotent replay, §2.6) and built by the service; the machine only names them. */
export type M34QueueJob = "tenant.provision" | "tenant.shred" | "tenant.shred_eligibility_check";

/** An M36 alert a transition asks the service to route (§2.5). The audience + PHI-sanitization wrapper
 *  are the service's job; the machine names the alert key + intended audience declaratively. */
export type M34AlertAudience =
  | "platform_ops"
  | "platform_security_owner"
  | "tenant_compliance_officer";

/** A scoped session-revocation cascade target (§2.5 — M2 terminates sessions at the status change). */
export type M34SessionCascade = "active_organization";

/**
 * One in-transaction side effect a tenant-lifecycle transition declares (§2.5). The service layer is
 * the only place these run; the machine never touches IO. `outbox` events are restricted to the §4.4
 * `m34.tenant.*` catalog; `queue_job` / `alert` / `session_cascade` / `request_destruction` /
 * `mark_eraser_refusal_deferred` describe cross-module intents the service resolves via the M1/M2/M4/M36
 * seams (no schema import edge from the pure package).
 */
export type LifecycleSideEffect =
  /** Stamp a lifecycle timestamp column on `tenant_account` (e.g. `provisionedAt`, `activatedAt`). */
  | { readonly kind: "set_timestamp"; readonly field: TenantAccountTimestampField }
  /** Set `tenant_account.retentionEndsAt = NOW() + retention_class_default_interval` (§2.5, retained). */
  | { readonly kind: "set_retention_window" }
  /** Append the immutable `tenant_account_status_event` ledger row (always present, §2.4.1). */
  | { readonly kind: "status_event" }
  /** Publish an `m34.tenant.*` outbox event in the same tx (§2.5 / §4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M34LifecycleEvent }
  /** Enqueue a worker queue job, keyed by `tenant_account_id` for idempotent replay (§2.5 / §2.6). */
  | { readonly kind: "queue_job"; readonly job: M34QueueJob }
  /** Provision-time bootstrap (§2.5 `provisioning → onboarding`): DEK insert + MinIO prefix + M2 org seed
   *  + canonical onboarding_task seeding + first-admin invitation. The machine names the bundle; the
   *  provisioning worker performs each step SELECT-then-INSERT-IF-NOT-EXISTS (§2.6 idempotency). */
  | { readonly kind: "provision_bootstrap" }
  /** Scope-revoke M2 sessions for the tenant at the status change (§2.5 — suspend / offboard). */
  | { readonly kind: "session_cascade"; readonly scope: M34SessionCascade }
  /** Route an M36 alert through the PHI-sanitization wrapper to the named audience(s) (§2.5). */
  | {
      readonly kind: "alert";
      readonly alertKey: string;
      readonly audience: readonly M34AlertAudience[];
    }
  /** Enqueue the M36 welcome email through the PHI-sanitization wrapper (no PHI in body, §2.5 active). */
  | { readonly kind: "welcome_email" }
  /** Offer the org-admin a `tenant_export_job` row in apps/admin (§2.5 offboarding_initiated). */
  | { readonly kind: "offer_export_job"; readonly purpose: "baa_termination" | "migration" }
  /** Call M4 `requestDestruction('saas_tenant_platform_class', {orgId})` (§2.5 retained → destruction). */
  | { readonly kind: "request_destruction" }
  /** Invoke the `tenant.shred` worker — the ONLY code path that effects `→ destroyed` (§2.5). */
  | { readonly kind: "invoke_shred_worker" }
  /** M34-F08 / ADR-0014: an eraseFn returned `refused_part_two_retention`; record the re-defer to
   *  `retained` + the critical `data.destruction_deferred` M4 audit event; DEK destruction aborts (§2.5). */
  | { readonly kind: "mark_eraser_refusal_deferred" };

/** The `tenant_account` lifecycle-timestamp columns a transition may stamp (§2.5; mirrors the schema). */
export type TenantAccountTimestampField =
  | "provisionedAt"
  | "activatedAt"
  | "suspendedAt"
  | "offboardingInitiatedAt"
  | "finalExportCompletedAt"
  | "destroyedAt";

/** A transition's full result — the new state + its ordered side-effect list (§2.5). */
export interface LifecycleTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<LifecycleSideEffect>;
}

/** Build a {@link LifecycleTransitionResult} (keeps the machine terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<LifecycleSideEffect>,
): LifecycleTransitionResult<S, E> {
  return { from, event, to, effects };
}
