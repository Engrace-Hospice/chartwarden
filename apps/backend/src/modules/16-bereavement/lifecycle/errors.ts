// apps/backend/src/modules/16-bereavement/lifecycle/errors.ts — M16-T03 (§2.2–§2.5).
//
// Every guard / validation failure in the M16 bereavement domain raises a `BereavementStateError` carrying
// the machine-readable code the §2.5 validation-rule table and the §4.2 route error blocks name. The error
// extends the M1 `WardenXError` envelope base (packages/types — NOT the banned packages/foundation) so the
// M1 Fastify error handler renders the exact code + status the UI keys its message off, with no
// cross-module import edge. Mirrors the M7 `CarePlanStateError` / M15 `DisciplinePlanStateError` precedent.
//
// CASING NOTE: the catalog is SCREAMING_SNAKE except for the three D18 external-source gate codes, which
// §2.5 / §4.3.2 spell in lower snake (`external_source_cosign_pending`, …) and which `@wardenx/bereavement`
// already exports as `BereavementExternalGateDenialCode`. The wire code is the contract, so they are kept
// verbatim rather than normalized into a shape the spec never wrote.
import { WardenXError } from "@wardenx/types";

/** The §2.5 / §4.2 machine-readable failure-code catalog → HTTP status. */
export const M16_ERROR_STATUS = {
  // Intake / the §4.3.1 eligibility worker (§2.5, D16)
  BEREAVEMENT_DEATH_DATE_MISMATCH: 422,
  DEATH_FACT_UNRESOLVED: 422,
  PLAN_ALREADY_EXISTS_FOR_ADMISSION: 409,
  // Plan root lifecycle (§2.2)
  PLAN_CLOSED: 409,
  PLAN_NOT_ACTIVE: 409,
  COUNSELOR_REQUIRED: 422,
  COUNSELOR_NOT_BEREAVEMENT_ELIGIBLE: 422,
  VOLUNTEER_GATES_UNMET: 422,
  ROSTER_EMPTY: 422,
  INITIAL_RISK_SCORE_REQUIRED: 422,
  PAUSE_REASON_REQUIRED: 422,
  // Closure (§2.2 / D7 / D6)
  EARLY_CLOSE_REASON_TOO_SHORT: 422,
  EARLY_CLOSE_COSIGN_REQUIRED: 412,
  NOT_ALL_CONTACTS_OPTED_OUT: 409,
  BEREAVEMENT_WINDOW_STILL_OPEN: 409,
  LEGAL_HOLD_ACTIVE: 409,
  // The D18 external-source first-contact gate (§4.3.2 — lower snake per the spec)
  external_source_cosign_pending: 409,
  tenant_gate_death_certificate_missing: 409,
  tenant_gate_coordinator_acknowledgment_missing: 409,
  // Bereaved contact lifecycle (§2.3 / D6 / D9)
  RELATIONSHIP_NOT_IN_VALUE_SET: 422,
  BEREAVEMENT_CONSENT_REQUIRED: 422,
  OPT_OUT_REASON_REQUIRED: 422,
  OPT_OUT_CHANNEL_KINDS_REQUIRED: 422,
  OPT_OUT_RESCIND_WINDOW_EXPIRED: 409,
  UNREACHABLE_THRESHOLD_NOT_MET: 422,
  CONTACT_DEATH_VERIFICATION_REQUIRED: 422,
  EXTERNAL_GRIEF_RESOURCE_REQUIRED: 422,
  // Outreach lifecycle (§2.4 / §2.5 / D15)
  OUTREACH_DUE_AT_OUT_OF_WINDOW: 422,
  OUTREACH_KIND_NOT_PERMITTED: 422,
  SOURCE_ENCOUNTER_REQUIRED: 422,
  SOURCE_ENCOUNTER_FORBIDDEN: 422,
  OUTREACH_NOT_YET_OVERDUE: 409,
  LATE_ATTEMPT_GRACE_EXPIRED: 409,
  CONTACT_LOG_REQUIRED: 422,
  // Schedule generation (D4)
  TENANT_CADENCE_LOOSENS_FLOOR: 422,
  // D3/D17 risk scoring (§4.3.3, §7.3) — a counselor override is the ONE path that moves a tier off the
  // rubric, so it is the one path that must be documented before it can land.
  RISK_OVERRIDE_REASON_TOO_SHORT: 422,
  RISK_OVERRIDE_TIER_REQUIRED: 422,
  /** §4.6 — the Layer-2 write-back found no deterministic row to narrate. It refuses rather than appending an
   *  `llm_augmented` row whose `rule_tier` came from nowhere (M16-T05). */
  RISK_SCORE_NOT_FOUND: 404,
  // Optimistic concurrency (§2.5)
  STALE_VERSION: 412,
  // Structural — an event dispatched from a state that does not accept it (§2.2–§2.4 graphs).
  ILLEGAL_TRANSITION: 409,
} as const;

/** A machine-readable M16 domain failure code (§2.5 / §4.2). */
export type M16ErrorCode = keyof typeof M16_ERROR_STATUS;

/**
 * A guard / validation failure in the M16 bereavement domain. Carries the precise §2.5 `code` so the UI
 * renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.2 every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class BereavementStateError extends WardenXError {
  constructor(code: M16ErrorCode, message: string) {
    super(code, message, M16_ERROR_STATUS[code]);
    this.name = "BereavementStateError";
  }
}

/** Throw a {@link BereavementStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M16ErrorCode, message: string): void {
  if (!condition) throw new BereavementStateError(code, message);
}
