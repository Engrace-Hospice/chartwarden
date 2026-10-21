// @chartwarden/fhir — §2.2 `fhir_inbound_resource` staged-proposal state machine (M28-T01).
//
// The §2.2 diagram as a PURE function. A consumer POSTs a FHIR resource; it stages as `pending`; the
// OWNER MODULE's reviewer (M5 for Patient, M12 for MedicationStatement — §2.3 `KNOWN_OWNER_MODULES`)
// accepts or rejects; an SLA breach expires it. M28-T07's `inbound-staging.ts` / `inbound-sla-watch.ts`
// walk the row; the accept callback is the OWNER module's, gated by the `fhir_inbound_owner_module_match`
// ABAC predicate (D8) that M28-T08 registers with M3.
//
// TWO OBLIGATIONS THIS FILE MAKES EXPLICIT:
//
//  1. A `rejected` transition needs a `decision_rationale` of at least
//     `FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS` (§2.2). `fhirInboundRejectRationaleValid` is the check;
//     `fhirInboundTransition` returning the edge is necessary but not sufficient for a reject.
//
//  2. `rejected` and `expired` schedule the raw `payload` for destruction at +30 days (§2.4/§3.7): the
//     payload may carry PHI fragments, the digest + rationale survive for dispute resolution. That set is
//     `FHIR_INBOUND_PAYLOAD_ERASE_STATUSES` in `@chartwarden/types`; the shred itself is the M4 eraser.

import {
  FHIR_INBOUND_PAYLOAD_ERASE_STATUSES,
  FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS,
  FHIR_KNOWN_INBOUND_OWNER,
  type FhirInboundOwnerModule,
  type FhirInboundStatus,
  type FhirStatusTransition,
} from "@chartwarden/types";

/** The status a newly-staged proposal lands in (§2.2). */
export const FHIR_INBOUND_INITIAL_STATUS: FhirInboundStatus = "pending";

/** The terminal statuses — no edge leaves them. */
export const FHIR_INBOUND_TERMINAL_STATUSES: readonly FhirInboundStatus[] = [
  "accepted",
  "rejected",
  "expired",
];

export const FHIR_INBOUND_TRANSITIONS: readonly FhirStatusTransition<FhirInboundStatus>[] = [
  {
    fromStatus: null,
    toStatus: "pending",
    auditAction: "m28.fhir.inbound.proposed",
    label: "consumer POSTs a resource; staged for review",
  },
  {
    fromStatus: "pending",
    toStatus: "accepted",
    auditAction: "phi.inbound_accepted",
    label: "owner-module reviewer accepts; native write succeeds",
  },
  {
    fromStatus: "pending",
    toStatus: "rejected",
    auditAction: "phi.inbound_rejected",
    label: "owner-module reviewer rejects with rationale ≥ 40 chars",
  },
  {
    fromStatus: "pending",
    toStatus: "expired",
    auditAction: "m28.fhir.inbound.expired",
    label: "SLA breach: pending > inbound_review_sla_hours",
  },
];

/** Resolve the transition for a (from, to) pair, or `null` if the FSM forbids it. */
export function fhirInboundTransition(
  from: FhirInboundStatus | null,
  to: FhirInboundStatus,
): FhirStatusTransition<FhirInboundStatus> | null {
  return FHIR_INBOUND_TRANSITIONS.find((t) => t.fromStatus === from && t.toStatus === to) ?? null;
}

/** True when the FSM permits the transition. Fails CLOSED. */
export function canFhirInboundTransition(
  from: FhirInboundStatus | null,
  to: FhirInboundStatus,
): boolean {
  return fhirInboundTransition(from, to) !== null;
}

/** §2.2 — the reject rationale must be present and at least the minimum length. */
export function fhirInboundRejectRationaleValid(rationale: string | null | undefined): boolean {
  return !!rationale && rationale.trim().length >= FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS;
}

/** True when entering `status` schedules the raw payload for +30-day destruction (§2.4/§3.7). */
export function fhirInboundEntryErasesPayload(status: FhirInboundStatus): boolean {
  return (FHIR_INBOUND_PAYLOAD_ERASE_STATUSES as readonly FhirInboundStatus[]).includes(status);
}

/**
 * §2.3 — resolve the owner module for an inbound resource type, or `null` when the inbound pipeline does
 * not know the type. `null` ⇒ the POST answers `501 Not Implemented` (the type is UNKNOWN to inbound),
 * which the route must tell apart from a write-facing forward-seam resource's `404` (that type is KNOWN
 * but gated). Phase 1 knows Patient → M5 and MedicationStatement → M12.
 */
export function fhirInboundOwnerModuleFor(resourceType: string): FhirInboundOwnerModule | null {
  return FHIR_KNOWN_INBOUND_OWNER[resourceType] ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GAP-198 — the ChartWarden patient an inbound proposal is ABOUT, read once at staging so the
 * `caseload_or_scope` gate never has to open the (denylisted) payload at decision time.
 *
 *   - `MedicationStatement`: `subject.reference` of the form `Patient/<uuid>`.
 *   - `Patient`: the resource's own `id` when it is a ChartWarden uuid (an update to an existing chart).
 *     A Patient proposal without one is a NEW person: there is no chart to scope to, so it is `null`.
 *
 * Anything that is not a well-formed uuid is `null`; callers must treat `null` on a patient-scoped
 * resource type (see {@link fhirInboundIsPatientScoped}) as DENY, never as "unscoped".
 */
export function fhirInboundSubjectPatientId(
  resourceType: string,
  payload: Record<string, unknown>,
): string | null {
  let candidate: unknown = null;
  if (resourceType === "Patient") {
    candidate = payload.id;
  } else if (resourceType === "MedicationStatement") {
    const subject = payload.subject;
    const reference =
      typeof subject === "object" && subject !== null
        ? (subject as { reference?: unknown }).reference
        : null;
    if (typeof reference === "string" && reference.startsWith("Patient/")) {
      candidate = reference.slice("Patient/".length);
    }
  }
  return typeof candidate === "string" && UUID_RE.test(candidate) ? candidate.toLowerCase() : null;
}

/**
 * True when every proposal of this type must resolve to a patient to be reviewable. `Patient` is the
 * exception: with no resolvable id it is a new-patient intake, gated by the owner's `patient.create`
 * permission alone.
 */
export function fhirInboundIsPatientScoped(resourceType: string): boolean {
  return resourceType === "MedicationStatement";
}
