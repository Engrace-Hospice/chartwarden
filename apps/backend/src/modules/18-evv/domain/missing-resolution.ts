// apps/backend/src/modules/18-evv/domain/missing-resolution.ts — M18-T04 (§2.2.4 D6, §7.3, §7.4, §7.10).
//
// The pure `evv_missing_resolution` D6 resolution machine. One `open` row exists per visit with an unresolved
// missing event (a missing check-out, a missing check-in, an outside-geofence fix, or a device-integrity
// failure — the `kind`); it moves to exactly one terminal `closed_*` status. This is the M17 machine shape:
// validate the event against the §2.2.4 graph, run the enumerated §7.3/§7.4 guards (failures raise the precise
// code via `EvvStateError`), and return the new status + the §2.4 in-transaction side-effect list. IO-free;
// the service/route layer (M18-T06) loads the row under RLS, composes the ABAC predicates
// (`assigned_clinician_for_visit`, `step_up_present`), checks the `If-Match` version (§2.5), and executes the
// effects in one tx. The five close paths (§2.2.4 mermaid):
//
//   open ─clinician_attest───────→ closed_clinician_attested        (assigned clinician, ≤24h, reason ≥40)
//   open ─supervisor_override────→ closed_supervisor_override       (step-up, ≤7d, reason ≥60)
//   open ─void_for_cancelled_visit→ closed_visit_voided             (M17 visit cancelled; system-driven)
//   open ─document_at_encounter──→ closed_documented_at_encounter   (m8.encounter.signed; reason ≥20, M8 D9)
//   open ─system_checkout_received→ closed_system_checkout_received (late check-out pairs; system-driven)
//
// ADR-0008 — EVV is operational, never a Medicare claim gate: only an `open` (unresolved_missing) row blocks
// downstream billing; every `closed_*` state (including `closed_documented_at_encounter` — documented_missing)
// is non-blocking. The classifiers at the foot encode that rule for the M8/M23 bracket/compliance readers.
import type { EvvMissingResolutionStatus } from "@chartwarden/types";
import type { EvvSideEffect } from "./effects";
import { EvvStateError, require_ } from "./errors";

/** §7.3 — the assigned-clinician self-attest `resolution_reason` floor (M17 D3 EVV self-attest reason floor). */
export const CLINICIAN_ATTEST_REASON_MIN = 40;
/** §7.4 — the Clinical Supervisor override `resolution_reason` floor. */
export const SUPERVISOR_OVERRIDE_REASON_MIN = 60;
/** §7.10 / M8 D9 — the documented-at-encounter `evv_missing_reason` floor M8 enforces before sign. */
export const DOCUMENTED_MISSING_REASON_MIN = 20;
/** §7.3 — the clinician self-attest window (hours from check-in); past it the supervisor-override path applies. */
export const SELF_ATTEST_WINDOW_HOURS = 24;
/** §7.4 — the supervisor-override window (days from the original visit). */
export const SUPERVISOR_OVERRIDE_WINDOW_DAYS = 7;

export type EvvMissingResolutionLifecycleState = EvvMissingResolutionStatus;

/**
 * A §2.2.4 close event. Per-event facts (caller identity match, elapsed windows, step-up freshness) are
 * resolved upstream — the route's ABAC + the M2 session + the clock — and injected here as plain data, so the
 * machine stays deterministic and unit-testable with no IO.
 */
export type EvvMissingResolutionEvent =
  | {
      readonly type: "clinician_attest";
      /** §7.3 — the caller is the visit's `assigned_membership_id` (`assigned_clinician_for_visit`). */
      readonly callerIsAssignedClinician: boolean;
      /** §7.3 — hours elapsed since the visit's check-in; must be ≤ {@link SELF_ATTEST_WINDOW_HOURS}. */
      readonly hoursSinceCheckIn: number;
      /** §7.3 — the self-attest narrative (≥40 chars; denylisted from audit per §3.6). */
      readonly reason: string;
    }
  | {
      readonly type: "supervisor_override";
      /** §7.4 — fresh M2 step-up auth verified for `evv.missing_resolution.supervisor_override`. */
      readonly stepUpVerified: boolean;
      /** §7.4 — days elapsed since the original visit; must be ≤ {@link SUPERVISOR_OVERRIDE_WINDOW_DAYS}. */
      readonly daysSinceVisit: number;
      /** §7.4 — the override narrative (≥60 chars; denylisted from audit per §3.6). */
      readonly reason: string;
    }
  | {
      readonly type: "void_for_cancelled_visit";
      /** §2.4 — the M17 `visit` is in a cancelled state (the `m17.visit.cancelled` consumer drives this). */
      readonly visitCancelled: boolean;
      /** §2.4 — system-driven (the outbox consumer), never a human action. */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "document_at_encounter";
      /** §2.3 / §7.10 — the M8 signing clinician identity (`resolved_by_membership_id`) is present. */
      readonly signingMembershipPresent: boolean;
      /** §7.10 / M8 D9 — the encounter's `evv_missing_reason` (≥20 chars; preserved on the M18 row). */
      readonly encounterEvvMissingReason: string;
    }
  | {
      readonly type: "system_checkout_received";
      /** §2.4 — system-driven auto-close when a late check-out pairs the open `missing_checkout` row. */
      readonly isSystemActor: boolean;
    };

/** The deterministic result of a close: the new terminal status + the ordered §2.4 side-effect list. */
export interface MissingResolutionTransition {
  readonly status: EvvMissingResolutionStatus;
  readonly event: EvvMissingResolutionEvent["type"];
  readonly effects: readonly EvvSideEffect[];
}

/** The legal §2.2.4 transition graph (from → events accepted). Every `closed_*` state is terminal. */
export const MISSING_RESOLUTION_GRAPH: Readonly<
  Record<EvvMissingResolutionLifecycleState, ReadonlyArray<EvvMissingResolutionEvent["type"]>>
> = {
  open: [
    "clinician_attest",
    "supervisor_override",
    "void_for_cancelled_visit",
    "document_at_encounter",
    "system_checkout_received",
  ],
  closed_clinician_attested: [],
  closed_supervisor_override: [],
  closed_visit_voided: [],
  closed_documented_at_encounter: [],
  closed_system_checkout_received: [],
};

/** A human close stamps the resolver + captures the denylisted reason; a system close does neither (§2.4). */
function closeEffects(status: EvvMissingResolutionStatus, reason: string | null): EvvSideEffect[] {
  const effects: EvvSideEffect[] = [{ kind: "audit" }, { kind: "set_resolution_status", status }];
  if (reason !== null) {
    effects.push({ kind: "stamp_resolver" });
    effects.push({ kind: "capture_reason", field: "resolution_reason", value: reason });
  }
  // §2.4 — every close emits `late_check_resolved` for the M17 / M8 / M23/M24 / M36 consumers.
  effects.push({ kind: "outbox", event: "m18.evv.late_check_resolved" });
  return effects;
}

/**
 * Apply a §2.2.4 close event. Throws {@link EvvStateError} `ILLEGAL_RESOLUTION_TRANSITION` when the event is
 * not accepted from `from` (i.e. the row is already terminal — the §2.5 `If-Match` race where two resolvers
 * collide surfaces here after the first writer wins), or the specific §7.3/§7.4 guard code on a guard failure.
 * Returns the new terminal status + the ordered §2.4 side-effect list.
 */
export function transitionMissingResolution(
  from: EvvMissingResolutionLifecycleState,
  event: EvvMissingResolutionEvent,
): MissingResolutionTransition {
  if (!MISSING_RESOLUTION_GRAPH[from].includes(event.type)) {
    throw new EvvStateError(
      "ILLEGAL_RESOLUTION_TRANSITION",
      `evv_missing_resolution cannot ${event.type} from '${from}' (closed_* states are terminal).`,
    );
  }

  switch (event.type) {
    case "clinician_attest": {
      require_(
        event.callerIsAssignedClinician,
        "EVV_RESOLUTION_NOT_ASSIGNED_CLINICIAN",
        "Only the visit's assigned clinician may self-attest a missing-EVV resolution.",
      );
      require_(
        event.hoursSinceCheckIn <= SELF_ATTEST_WINDOW_HOURS,
        "EVV_SELF_ATTEST_WINDOW_EXPIRED",
        `The ${SELF_ATTEST_WINDOW_HOURS}h self-attest window has closed; a supervisor override is required.`,
      );
      require_(
        event.reason.trim().length >= CLINICIAN_ATTEST_REASON_MIN,
        "EVV_RESOLUTION_REASON_TOO_SHORT",
        `A self-attest requires a resolution_reason ≥ ${CLINICIAN_ATTEST_REASON_MIN} chars.`,
      );
      return {
        status: "closed_clinician_attested",
        event: event.type,
        effects: closeEffects("closed_clinician_attested", event.reason),
      };
    }

    case "supervisor_override": {
      require_(
        event.stepUpVerified,
        "EVV_SUPERVISOR_OVERRIDE_STEP_UP_REQUIRED",
        "A supervisor override requires fresh M2 step-up auth.",
      );
      require_(
        event.daysSinceVisit <= SUPERVISOR_OVERRIDE_WINDOW_DAYS,
        "EVV_SUPERVISOR_OVERRIDE_WINDOW_EXPIRED",
        `The ${SUPERVISOR_OVERRIDE_WINDOW_DAYS}d supervisor-override window has closed.`,
      );
      require_(
        event.reason.trim().length >= SUPERVISOR_OVERRIDE_REASON_MIN,
        "EVV_RESOLUTION_REASON_TOO_SHORT",
        `A supervisor override requires a resolution_reason ≥ ${SUPERVISOR_OVERRIDE_REASON_MIN} chars.`,
      );
      return {
        status: "closed_supervisor_override",
        event: event.type,
        effects: closeEffects("closed_supervisor_override", event.reason),
      };
    }

    case "void_for_cancelled_visit": {
      require_(
        event.isSystemActor,
        "EVV_RESOLUTION_SYSTEM_ACTOR_REQUIRED",
        "A visit-voided close is driven by the m17.visit.cancelled consumer, not a human actor.",
      );
      require_(
        event.visitCancelled,
        "EVV_VISIT_NOT_CANCELLED",
        "A closed_visit_voided close requires the M17 visit to be cancelled.",
      );
      // System-driven: no resolver stamp / reason (the cancellation reason lives on the M17 visit).
      return {
        status: "closed_visit_voided",
        event: event.type,
        effects: closeEffects("closed_visit_voided", null),
      };
    }

    case "document_at_encounter": {
      require_(
        event.signingMembershipPresent,
        "EVV_RESOLVER_REQUIRED",
        "A documented-at-encounter close requires the M8 signing clinician as resolved_by_membership_id.",
      );
      require_(
        event.encounterEvvMissingReason.trim().length >= DOCUMENTED_MISSING_REASON_MIN,
        "EVV_DOCUMENTED_MISSING_REASON_TOO_SHORT",
        `The encounter evv_missing_reason must be ≥ ${DOCUMENTED_MISSING_REASON_MIN} chars (M8 D9).`,
      );
      // The signing clinician IS the resolver (M8 D9); the reason is the encounter's evv_missing_reason.
      return {
        status: "closed_documented_at_encounter",
        event: event.type,
        effects: closeEffects("closed_documented_at_encounter", event.encounterEvvMissingReason),
      };
    }

    case "system_checkout_received": {
      require_(
        event.isSystemActor,
        "EVV_RESOLUTION_SYSTEM_ACTOR_REQUIRED",
        "A system-checkout-received close is driven by the check-out pairing, not a human actor.",
      );
      // §2.4 / ADR-0022 — system-driven; NOT labeled closed_clinician_attested (no human attested).
      return {
        status: "closed_system_checkout_received",
        event: event.type,
        effects: closeEffects("closed_system_checkout_received", null),
      };
    }
  }
}

// ── ADR-0008 EVV-is-never-a-claim-gate classifiers (read by the M8 bracket + M23 pre-submission readers) ──

/** Whether an `evv_missing_resolution` status is terminal (any `closed_*` state). */
export function isMissingResolutionTerminal(status: EvvMissingResolutionStatus): boolean {
  return status !== "open";
}

/**
 * ADR-0008 — does an open/closed resolution BLOCK downstream billing/claim submission? Only an `open`
 * (unresolved_missing) row blocks; every `closed_*` state (including documented_missing) is allowed. EVV is
 * operational, never a Medicare claim gate — only `unresolved_missing` stops the M23 pre-submission gate.
 */
export function missingResolutionBlocksBilling(status: EvvMissingResolutionStatus): boolean {
  return status === "open";
}

/** ADR-0008 disposition surfaced on the EVV bracket / compliance projections. */
export type MissingResolutionDisposition = "unresolved_missing" | "documented_missing";

/** Classify a resolution status into the ADR-0008 disposition the bracket/compliance readers report. */
export function missingResolutionDisposition(
  status: EvvMissingResolutionStatus,
): MissingResolutionDisposition {
  return status === "open" ? "unresolved_missing" : "documented_missing";
}
