// @wardenx/inpatient — the M37 domain failure-code catalog. Every guard failure in the pure IPU domain
// kernels (the bed-cleaning machine, the admission machine, IRC cap, restraint cadence, GIP validators,
// RN-coverage evaluator, …) raises an `IpuStateError` carrying an enumerated machine-readable code. The
// error extends the M1 `WardenXError` envelope (`@wardenx/types` — the M18 `EvvStateError` / M6
// `AdmissionStateError` convention) so the Fastify error handler renders code + HTTP status with NO
// cross-module import edge; the §3.x DB CHECK / partial-unique backstops repeat the strongest of these at
// the schema layer as defense in depth. The route layer (M37-T11) reuses these codes verbatim.
//
// The catalog grows per task: T03 seeds the §2.12 bed-cleaning codes; T04–T10 append the admission / IRC /
// restraint / GIP / RN-coverage / census codes below. All share one `IpuStateError` envelope.
import { WardenXError } from "@wardenx/types";

/** The M37 domain failure-code catalog → HTTP status. */
export const M37_ERROR_STATUS = {
  // ── §2.12 D13 bed-cleaning state machine (M37-T03) ─────────────────────────────────────────────────
  // §2.12 — the event is not accepted from the bed's current cleaning_status (the D13 mermaid graph);
  // `retired` is terminal.
  ILLEGAL_BED_CLEANING_TRANSITION: 409,
  // §2.12 — a turnover-SLA value that attempts to LOOSEN above the 2-hour platform floor (tighten-only).
  TURNOVER_SLA_NOT_TIGHTENING: 409,

  // ── §2.2 D2 ipu_admission lifecycle machine (M37-T04) ──────────────────────────────────────────────
  // §2.2 — the event is not accepted from the admission's current state (the D2 mermaid graph).
  ILLEGAL_ADMISSION_TRANSITION: 409,
  // §2.2/§2.3 D3 — a GIP/IRC admission action while the unit's RN coverage is inactive (ABAC
  // m37.ipu.rn_coverage_active = false); arranged remote-IPU bypasses this gate.
  IPU_RN_COVERAGE_UNAVAILABLE: 412,
  // §2.2 — requestBed against a unit that is not active.
  IPU_UNIT_INACTIVE: 409,
  // §2.2 — requestBed when the unit has no bed in `ready` state.
  IPU_NO_READY_BED: 409,
  // §2.2 — assignBed to a bed that is not in `ready` state.
  IPU_BED_NOT_READY: 409,
  // §2.2 — assignBed into a room occupied by an opposite-sex patient without a private room / privacy flag.
  IPU_ROOM_OCCUPANCY_CONFLICT: 409,
  // §2.2 — confirm() before the M6 LCP bed-assignment ack arrived (and not force-flagged past the 30s window).
  ADMISSION_LCP_NOT_CONFIRMED: 409,
  // §2.2 — confirm() of a GIP admission with no gip_admission_criteria row yet (the criteria ARE the
  // activation step).
  GIP_CRITERIA_REQUIRED: 412,
  // §2.2 — initiateTransfer(to_unit) whose destination unit lacks RN coverage.
  ADMISSION_DESTINATION_RN_COVERAGE: 412,
  // §2.2 — confirmTransfer without an acknowledgment from the destination.
  ADMISSION_TRANSFER_NOT_ACKNOWLEDGED: 409,
  // §2.2 — discharge() with no M6 discharge_event row.
  ADMISSION_DISCHARGE_EVENT_MISSING: 422,
  // §2.2 — recordDeath() whose M6 death_event does not reference this admission.
  ADMISSION_DEATH_EVENT_MISMATCH: 422,
  // §2.2 — recordDeath()/postClose driven by a non-system actor (these are outbox-consumer / cron-driven).
  ADMISSION_SYSTEM_ACTOR_REQUIRED: 403,
  // §2.2 — postCloseSettlement while a child row is still open (unfinalized GIP criteria / open irc_episode /
  // incomplete body release).
  ADMISSION_OPEN_CHILD_ROWS: 409,

  // ── §2.4 D4/D5 GIP criteria + §2.6 D7 IV-safety overlay (M37-T05) ──────────────────────────────────
  // §2.4 — a gip_admission_criteria payload that fails the per-kind discriminated-union TypeBox schema.
  GIP_CRITERIA_INVALID_PAYLOAD: 422,
  // §2.4 — a GIP-criteria reassessment staleness config that attempts to LOOSEN above the 24h floor.
  GIP_REASSESSMENT_NOT_TIGHTENING: 409,
  // §2.6 — M13 pre-administration gate: the proposed IV rate is outside the overlay's titration window.
  IV_RATE_OUTSIDE_TITRATION_WINDOW: 412,
  // §2.6 — a sedation-class IV drip administration with no dual-witness HMAC token attached.
  IV_DUAL_WITNESS_REQUIRED: 412,
  // §2.6 — the overlay's max continuous infusion duration would be exceeded (needs a new order / rate-stop).
  IV_MAX_CONTINUOUS_DURATION_REACHED: 412,
  // §2.6 — no bedside observation within the overlay's bedside-check interval.
  IV_BEDSIDE_CHECK_OVERDUE: 412,

  // ── §2.5 D6 IRC 5-day cap enforcer (M37-T06) ───────────────────────────────────────────────────────
  // §2.5 — the event is not accepted from the irc_episode's current state (`closed` is terminal).
  ILLEGAL_IRC_TRANSITION: 409,
  // §2.5 — the ABAC m37.irc_episode.within_cap gate: an IRC billing action on a breached episode.
  IRC_CAP_BREACHED: 412,
  // §2.5 — a cap-override break-glass with an override reason below the 100-char floor.
  IRC_CAP_OVERRIDE_REASON_TOO_SHORT: 422,
  // §2.5 — a cap-override extension beyond the 2-day platform-floor maximum (tenants cannot loosen).
  IRC_CAP_OVERRIDE_EXTENSION_TOO_LONG: 409,
  // §2.5 — a cap-override without fresh M2 step-up (Org Admin / Compliance Officer only).
  IRC_CAP_OVERRIDE_STEP_UP_REQUIRED: 403,

  // ── §2.3 D3 24/7 RN-coverage invariant (M37-T07) ───────────────────────────────────────────────────
  // §2.3 — a unit cannot exit `provisional` (activate) without 168h of forward RN coverage.
  IPU_UNIT_ACTIVATION_COVERAGE_INSUFFICIENT: 412,
  // §2.3 — an RN-coverage break-glass override that was not ended by a NON-break-glass actor.
  RN_BREAK_GLASS_ENDER_INVALID: 403,
  // §2.3 — an RN-coverage break-glass without fresh M2 step-up (Org Admin / Compliance Officer / Med Director).
  RN_BREAK_GLASS_STEP_UP_REQUIRED: 403,
  // §2.3 (F-080) — a staff assignment confirmed from a state that is not `tentative`. `cancelled`,
  // `completed` and `no_show` are terminal, and confirming one would put an RN back on a coverage grid
  // they are not working; an already-`confirmed` row is idempotent and never reaches this.
  ILLEGAL_STAFF_ASSIGNMENT_TRANSITION: 409,

  // ── §2.10 D11 restraint · §2.7 D8 visitor · §2.9 D10 equipment (M37-T08) ────────────────────────────
  // §2.10 — a restraint application with justification below the 100-char floor.
  RESTRAINT_JUSTIFICATION_TOO_SHORT: 422,
  // §2.10 — a restraint application with no ordering physician order (required even in emergency, CoP 418.110).
  RESTRAINT_ORDER_REQUIRED: 422,
  // §2.10 — a restraint application without fresh M2 step-up (RN+; the m37.restraint.apply key is step-up).
  RESTRAINT_STEP_UP_REQUIRED: 403,
  // §2.10 — no server-derived step-up assertion id to bind the application to (the session carries none).
  RESTRAINT_STEP_UP_ASSERTION_MISSING: 403,
  // §2.10 — a reassessment interval that attempts to LOOSEN above its behavioral/medical platform floor.
  RESTRAINT_INTERVAL_NOT_TIGHTENING: 409,
  // §2.10 — a restraint transition not accepted from the event's current state (`released` is terminal).
  ILLEGAL_RESTRAINT_TRANSITION: 409,
  // §2.7 — a visitor check-in blocked by an active full_block restriction.
  VISITOR_RESTRICTION_FULL_BLOCK: 412,
  // §2.7 — a non-immediate-family visitor blocked by an active immediate_family_only restriction.
  VISITOR_IMMEDIATE_FAMILY_ONLY: 412,
  // §2.7 (GAP-062) — a non-immediate-family visitor with no active M39 consent authorizing non-family
  // access (or with the evaluator unreadable, which refuses the same way).
  VISITOR_CONSENT_MISSING: 412,
  // §2.9 — an assign-equipment-to-patient action on equipment with an overdue biomed inspection.
  EQUIPMENT_INSPECTION_OVERDUE: 412,

  // ── §2.11 D12 post-mortem body-release coordination (M37-T09) ──────────────────────────────────────
  // §2.11 — the event is not accepted from the body-release's current state (`closed` is terminal).
  ILLEGAL_BODY_RELEASE_TRANSITION: 409,
  // §2.11 — identifyFuneralHome without a resolved M40 FuneralHome.
  BODY_RELEASE_FUNERAL_HOME_UNRESOLVED: 422,
  // §2.11 — releaseBody without the signed M22 body_release_authorization document.
  BODY_RELEASE_DOCUMENT_REQUIRED: 412,
  // §2.11 (GAP-106) — a release document that was named but is not the M22 body_release_authorization
  // for THIS release (unknown, wrong type / release / patient, superseded) or that M22 could not be asked.
  BODY_RELEASE_DOCUMENT_INVALID: 422,

  // ── §2.4 D5 GIP attestation (GAP-106) ──────────────────────────────────────────────────────────────
  // §2.4 — the attester is not a hospice physician with an active M40 physician (attester_eligible).
  GIP_ATTESTER_NOT_ELIGIBLE: 403,
  // §2.4 — no server-side step-up assertion to bind the attestation to (the session carries none).
  GIP_STEP_UP_ASSERTION_MISSING: 403,

  // ── §4.1 route 15 (GAP-106) — the M6 LCP-ack confirm handshake ─────────────────────────────────────
  // The acknowledged M6 level-of-care period is not the one this admission was opened for.
  IPU_LCP_ACK_MISMATCH: 409,
} as const;

/** A machine-readable M37 domain failure code. */
export type M37ErrorCode = keyof typeof M37_ERROR_STATUS;

/**
 * A guard / validation failure in a pure M37 domain kernel. Carries the precise `code` so the UI renders an
 * exact message; the M1 error handler maps `statusCode` to the HTTP response. Nothing transitions on a
 * string match — each code is an enumerated constant.
 */
export class IpuStateError extends WardenXError {
  constructor(code: M37ErrorCode, message: string) {
    super(code, message, M37_ERROR_STATUS[code]);
    this.name = "IpuStateError";
  }
}

/** Throw an {@link IpuStateError} when `condition` is false (guard helper). */
export function requireIpu(condition: boolean, code: M37ErrorCode, message: string): void {
  if (!condition) throw new IpuStateError(code, message);
}
