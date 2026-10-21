// @chartwarden/saas-tenant-platform · services — §2.2 D2 tenant-lifecycle state machine (M34). Pure, IO-free.
//
// The eleven-state tenant_account lifecycle (§2.2 / §3.3 `tenant_account_status`):
//
//   signup_intent ─accept→ provisioning ─provisioned→ onboarding ─activate→ active
//   active ─suspend⇄reactivate─ suspended ;  active ─flagAtRisk⇄resolveAtRisk─ at_risk
//   {active|suspended|at_risk} ─initiateOffboarding→ offboarding_initiated
//   offboarding_initiated ─requestFinalExport→ final_export_pending ─completeExport→ retained
//   retained ─scheduleDestruction→ destruction_pending ─shred→ destroyed
//   destruction_pending ─deferForPartTwoRetention→ retained   (M34-F08 / ADR-0014 eraser-refusal re-defer)
//
// Pure transition function (the M8/M11 lifecycle convention — packages/orders/src/lifecycle/
// order-machine.ts): it validates the event is legal from the current state (the §2.2 graph — nothing
// transitions on a string match), runs the enumerated §2.4 guards (failures raise the precise code via
// TenantLifecycleError), and returns the new state + the §2.5 in-transaction side-effect list the
// route/worker service executes. NO IO: every fact a guard needs (DEK present, canonical tasks done,
// BAA executed + >90d to expiry, legal-hold clear, retention elapsed, actor kind, eraser-refusal) is
// resolved upstream — by the repositories + the M4 legal-hold reader + the BAA register repo — and
// passed in. The service composes those reads, calls this machine, then runs the returned effects
// inside the tenant_account's optimistic-locked transaction (the M11 `OrderStateError` precedent).
import type { TenantAccountStatus } from "../seams/tenant-lifecycle-provider";
import { type LifecycleTransitionResult, result } from "./lifecycle-effects";
import { TenantLifecycleError, require_ } from "./lifecycle-errors";

/** The tenant-lifecycle state — the §3.3 `tenant_account_status` enum (type-level mirror via the seam). */
export type TenantLifecycleState = TenantAccountStatus;

/** The kind of actor effecting a transition (recorded on `tenant_account_status_event.actor_kind`). The
 *  §2.2 binding rules reserve certain transitions to a specific actor kind (defense in depth, D2/D8). */
export type LifecycleActorKind =
  | "platform_ops"
  | "platform_security_owner"
  | "org_admin"
  | "system_automated";

/**
 * The §2.2 tenant-lifecycle events. Per-event facts are resolved upstream (repositories + M4 legal-hold
 * reader + BAA register) and injected as data — the machine resolves no IO. Every event carries the
 * `actorKind` so the §2.2 actor-reservation guards are checkable purely. The non-empty `transitionReason`
 * (§2.4.1 — "no status change without a transition event") is validated by every event.
 */
export type LifecycleEvent =
  | {
      // signup_intent → provisioning (§2.5 r1). Platform-ops accepts the intent + creates tenant_account.
      readonly type: "accept";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
    }
  | {
      // provisioning → onboarding (§2.5 r2). Requires the tenant_key_ring DEK to exist (TenantKeyMissing).
      readonly type: "provisioned";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
      /** §2.4.4 — the `tenant_key_ring` row exists with `current_dek_version='v1'`, `dek_created_at IS NOT
       *  NULL`, `destroyed_at IS NULL` (the provisioning worker raises `TenantKeyMissing` otherwise). */
      readonly tenantKeyRingReady: boolean;
    }
  | {
      // onboarding → active (§2.5 r3). Canonical tasks done/skipped + BAA executed + >90d to expiry (D11).
      readonly type: "activate";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
      /** §2.4.12 — every `onboarding_task` whose template `is_canonical=true` is `done` or `skipped`. */
      readonly canonicalTasksComplete: boolean;
      /** §2.4.12 — the latest `platform_tenant_baa_record` has `baa_status='executed'`. */
      readonly baaExecuted: boolean;
      /** §2.4 D11 — the executed BAA has `expires_on IS NULL OR expires_on > CURRENT_DATE + 90 days`. */
      readonly baaExpiryClearsNinetyDays: boolean;
    }
  | {
      // active → suspended (§2.5 r4). Reversible; sessions terminated immediately at transition.
      readonly type: "suspend";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
    }
  | {
      // suspended → active (§2.2). Platform-ops reactivation once cause resolved.
      readonly type: "reactivate";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
    }
  | {
      // active → at_risk (§2.2). Lifecycle health predicates fail (no claim 60d / no clinical write 30d).
      readonly type: "flagAtRisk";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
    }
  | {
      // at_risk → active (§2.2). Health predicates resolved.
      readonly type: "resolveAtRisk";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
    }
  | {
      // at_risk → suspended (§2.2). At-risk + non-payment 180d.
      readonly type: "suspendFromAtRisk";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
    }
  | {
      // {active|suspended|at_risk} → offboarding_initiated (§2.5 r5). NOT directly reversible.
      readonly type: "initiateOffboarding";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
      /** §2.5 r5 — which export purpose to offer the org-admin (BAA-termination vs migration). */
      readonly exportPurpose: "baa_termination" | "migration";
    }
  | {
      // offboarding_initiated → final_export_pending (§2.5). A tenant_export_job(purpose=...) created.
      readonly type: "requestFinalExport";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
    }
  | {
      // final_export_pending → retained (§2.5 r6). Tenant downloads OR explicitly waives final export.
      readonly type: "completeExport";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
    }
  | {
      // retained → destruction_pending (§2.5 r7). retention_ends_at reached AND no legal_hold active.
      readonly type: "scheduleDestruction";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
      /** §2.2 — `retention_ends_at <= NOW()` (the auto-cron guard; manual trigger sets this true via owner). */
      readonly retentionElapsed: boolean;
      /** §2.2 — no row in `legal_hold` (M4-owned) references this organization (M4 legal-hold reader). */
      readonly legalHoldClear: boolean;
    }
  | {
      // destruction_pending → destroyed (§2.5 r8). ONLY the tenant.shred worker; irreversible.
      readonly type: "shred";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
      /** §2.2 / §2.4 — only the `tenant.shred` worker (system actor) may effect this transition. */
      readonly isShredWorker: boolean;
    }
  | {
      // destruction_pending → retained (§2.5 r8 / M34-F08 / ADR-0014). Eraser-refusal re-defer.
      readonly type: "deferForPartTwoRetention";
      readonly actorKind: LifecycleActorKind;
      readonly transitionReason: string;
      /** M34-F08 / M4 D8 — at least one eraseFn returned `refused_part_two_retention` (42 CFR Part 2 under
       *  a retention obligation); the DEK survives because it is the only key that can decrypt the ciphertext. */
      readonly eraserRefusedPartTwo: boolean;
    };

/** The kind discriminant of a {@link LifecycleEvent} (the `type` channel). */
export type LifecycleEventType = LifecycleEvent["type"];

export type LifecycleTransition = LifecycleTransitionResult<
  TenantLifecycleState,
  LifecycleEventType
>;

/**
 * The legal §2.2 transition graph (from → events accepted). Guards are checked separately. Terminal
 * states (`destroyed`) accept no events. Note `destruction_pending` accepts both `shred` (→ destroyed)
 * and `deferForPartTwoRetention` (→ retained, the M34-F08 eraser-refusal re-defer).
 */
export const TENANT_LIFECYCLE_GRAPH: Readonly<
  Record<TenantLifecycleState, ReadonlyArray<LifecycleEventType>>
> = {
  signup_intent: ["accept"],
  provisioning: ["provisioned"],
  onboarding: ["activate"],
  active: ["suspend", "flagAtRisk", "initiateOffboarding"],
  suspended: ["reactivate", "initiateOffboarding"],
  at_risk: ["resolveAtRisk", "suspendFromAtRisk", "initiateOffboarding"],
  offboarding_initiated: ["requestFinalExport"],
  final_export_pending: ["completeExport"],
  retained: ["scheduleDestruction"],
  destruction_pending: ["shred", "deferForPartTwoRetention"],
  destroyed: [],
};

/** Validate the §2.4.1 universal precondition: every transition supplies a non-empty transition reason
 *  ("no status change without a transition event" — the route refuses if the reason is missing). */
function requireReason(reason: string): void {
  require_(
    reason.trim().length > 0,
    "TRANSITION_REASON_REQUIRED",
    "a non-empty transition reason is required for every tenant-lifecycle transition (§2.4.1)",
  );
}

/**
 * Apply a tenant-lifecycle event (§2.2). Throws {@link TenantLifecycleError} `ILLEGAL_TENANT_TRANSITION`
 * if the event is not accepted from `from`, or the specific §2.4 guard code on a guard failure. Returns
 * the new state + the ordered §2.5 side-effect list the route/worker service runs in the tenant_account's
 * optimistic-locked transaction. Every result leads with a `status_event` effect (§2.4.1 ledger row).
 */
export function transitionTenant(
  from: TenantLifecycleState,
  event: LifecycleEvent,
): LifecycleTransition {
  if (!TENANT_LIFECYCLE_GRAPH[from].includes(event.type)) {
    throw new TenantLifecycleError(
      "ILLEGAL_TENANT_TRANSITION",
      `tenant cannot ${event.type} from '${from}'`,
    );
  }

  requireReason(event.transitionReason);

  switch (event.type) {
    case "accept": {
      // §2.5 r1 — tenant_account created (status=provisioning) + tenant.provision job + provision_started.
      return result(from, event.type, "provisioning", [
        { kind: "status_event" },
        { kind: "set_timestamp", field: "provisionedAt" },
        { kind: "queue_job", job: "tenant.provision" },
        { kind: "outbox", event: "m34.tenant.provision_started" },
      ]);
    }

    case "provisioned": {
      // §2.4.4 — the DEK must exist before onboarding (TenantKeyMissing otherwise).
      require_(
        event.tenantKeyRingReady,
        "TENANT_KEY_MISSING",
        "the tenant_key_ring DEK (v1, created, not destroyed) must exist before onboarding (§2.4.4)",
      );
      // §2.5 r2 — DEK insert + MinIO prefix + M2 org seed + canonical task seeding + first-admin invite,
      // then `m34.tenant.provisioned` (consumed by M35 to create the Stripe Customer).
      return result(from, event.type, "onboarding", [
        { kind: "status_event" },
        { kind: "provision_bootstrap" },
        { kind: "outbox", event: "m34.tenant.provisioned" },
      ]);
    }

    case "activate": {
      // §2.4.12 / D11 — canonical tasks complete + BAA executed + >90d to expiry.
      require_(
        event.canonicalTasksComplete,
        "ONBOARDING_TASKS_INCOMPLETE",
        "every canonical onboarding_task must be 'done' or 'skipped' before activation (§2.4.12)",
      );
      require_(
        event.baaExecuted,
        "BAA_NOT_EXECUTED",
        "an executed platform_tenant_baa_record is required before activation (§2.4.12)",
      );
      require_(
        event.baaExpiryClearsNinetyDays,
        "BAA_EXPIRING_SOON",
        "the executed BAA must not expire within 90 days of activation (§2.4 D11)",
      );
      // §2.5 r3 — activated_at stamped, `m34.tenant.activated`, M36 onboarding-completed alert + welcome email.
      return result(from, event.type, "active", [
        { kind: "status_event" },
        { kind: "set_timestamp", field: "activatedAt" },
        { kind: "outbox", event: "m34.tenant.activated" },
        { kind: "alert", alertKey: "tenant.onboarding_completed", audience: ["platform_ops"] },
        { kind: "welcome_email" },
      ]);
    }

    case "suspend": {
      // §2.5 r4 — session revocation cascade + M35 pause (outbox) + M36 alert + `m34.tenant.suspension_initiated`.
      return result(from, event.type, "suspended", [
        { kind: "status_event" },
        { kind: "set_timestamp", field: "suspendedAt" },
        { kind: "session_cascade", scope: "active_organization" },
        {
          kind: "alert",
          alertKey: "tenant.suspension_initiated",
          audience: ["tenant_compliance_officer", "platform_security_owner"],
        },
        { kind: "outbox", event: "m34.tenant.suspension_initiated" },
      ]);
    }

    case "reactivate": {
      // §2.2 — platform-ops reactivation (cause resolved). Sessions re-issue normally once active again.
      return result(from, event.type, "active", [
        { kind: "status_event" },
        { kind: "outbox", event: "m34.tenant.reactivated" },
      ]);
    }

    case "flagAtRisk": {
      // §2.2 — health predicates failed; admin banner + warning header are driven off the status read.
      return result(from, event.type, "at_risk", [
        { kind: "status_event" },
        { kind: "outbox", event: "m34.tenant.at_risk" },
        { kind: "alert", alertKey: "tenant.at_risk_flagged", audience: ["platform_ops"] },
      ]);
    }

    case "resolveAtRisk": {
      // §2.2 — health predicates resolved; tenant returns to active.
      return result(from, event.type, "active", [
        { kind: "status_event" },
        { kind: "outbox", event: "m34.tenant.reactivated" },
      ]);
    }

    case "suspendFromAtRisk": {
      // §2.2 — at-risk + non-payment 180d → suspended (same suspend side-effects as active → suspended).
      return result(from, event.type, "suspended", [
        { kind: "status_event" },
        { kind: "set_timestamp", field: "suspendedAt" },
        { kind: "session_cascade", scope: "active_organization" },
        {
          kind: "alert",
          alertKey: "tenant.suspension_initiated",
          audience: ["tenant_compliance_officer", "platform_security_owner"],
        },
        { kind: "outbox", event: "m34.tenant.suspension_initiated" },
      ]);
    }

    case "initiateOffboarding": {
      // §2.5 r5 — NOT directly reversible (§2.2). Session cascade + M35 cancel (outbox) + alerts + export offer.
      return result(from, event.type, "offboarding_initiated", [
        { kind: "status_event" },
        { kind: "set_timestamp", field: "offboardingInitiatedAt" },
        { kind: "session_cascade", scope: "active_organization" },
        {
          kind: "alert",
          alertKey: "tenant.offboarding_initiated",
          audience: ["platform_ops", "tenant_compliance_officer"],
        },
        { kind: "outbox", event: "m34.tenant.offboarding_initiated" },
        { kind: "offer_export_job", purpose: event.exportPurpose },
      ]);
    }

    case "requestFinalExport": {
      // §2.2 — a tenant_export_job(purpose='migration'|'baa_termination') was created.
      return result(from, event.type, "final_export_pending", [
        { kind: "status_event" },
        { kind: "outbox", event: "m34.tenant.final_export_pending" },
      ]);
    }

    case "completeExport": {
      // §2.5 r6 — retention_ends_at set, daily shred-eligibility cron scheduled, `m34.tenant.retained`,
      // M36 alert at 30d/7d/0d before retention_ends_at.
      return result(from, event.type, "retained", [
        { kind: "status_event" },
        { kind: "set_retention_window" },
        { kind: "queue_job", job: "tenant.shred_eligibility_check" },
        { kind: "outbox", event: "m34.tenant.retained" },
        {
          kind: "alert",
          alertKey: "tenant.retention_countdown",
          audience: ["tenant_compliance_officer"],
        },
      ]);
    }

    case "scheduleDestruction": {
      // §2.2 — retention elapsed AND legal-hold clear (auto-cron); manual needs platform_security_owner.
      require_(
        event.retentionElapsed,
        "RETENTION_NOT_ELAPSED",
        "retention_ends_at must be reached before scheduling destruction (§2.2)",
      );
      require_(
        event.legalHoldClear,
        "LEGAL_HOLD_ACTIVE",
        "no legal_hold (M4-owned) may reference this organization before destruction (§2.2)",
      );
      // §2.5 r7 — M4 requestDestruction + M36 shred-pending-approval alert to the platform security owner.
      return result(from, event.type, "destruction_pending", [
        { kind: "status_event" },
        { kind: "request_destruction" },
        { kind: "outbox", event: "m34.tenant.destruction_pending" },
        {
          kind: "alert",
          alertKey: "tenant.shred_pending_approval",
          audience: ["platform_security_owner"],
        },
      ]);
    }

    case "shred": {
      // §2.2 / §2.4 — ONLY the tenant.shred worker (system actor) may effect `→ destroyed`. Irreversible.
      require_(
        event.isShredWorker,
        "NOT_SHRED_WORKER",
        "only the tenant.shred worker may transition a tenant to 'destroyed' (§2.2)",
      );
      // §2.5 r8 — shred worker + per-module eraseFn + MinIO scope destroy + DEK zero + destruction-cert +
      // `m34.tenant.destroyed`. The M34-F08 refusal branch is a SEPARATE event (deferForPartTwoRetention),
      // so reaching `shred` means every eraseFn returned a non-refusal outcome (the §2.2 binding rule).
      return result(from, event.type, "destroyed", [
        { kind: "status_event" },
        { kind: "set_timestamp", field: "destroyedAt" },
        { kind: "invoke_shred_worker" },
        { kind: "outbox", event: "m34.tenant.destroyed" },
      ]);
    }

    case "deferForPartTwoRetention": {
      // M34-F08 / ADR-0014 / ARCH-251 — an eraseFn returned `refused_part_two_retention`; DEK destruction
      // aborts and the tenant is re-deferred to `retained` (reason `part_two_retention`).
      require_(
        event.eraserRefusedPartTwo,
        "NO_PART_TWO_REFUSAL",
        "the re-defer to 'retained' requires an eraseFn that returned refused_part_two_retention (M34-F08)",
      );
      // §2.5 r8 refusal branch — record the deferral (critical `data.destruction_deferred` audit) and
      // re-schedule the shred-eligibility check; the DEK survives until the Part 2 retention obligation lapses.
      return result(from, event.type, "retained", [
        { kind: "status_event" },
        { kind: "mark_eraser_refusal_deferred" },
        { kind: "queue_job", job: "tenant.shred_eligibility_check" },
        { kind: "outbox", event: "m34.tenant.retained" },
      ]);
    }
  }
}
