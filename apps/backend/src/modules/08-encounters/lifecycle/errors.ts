// apps/backend/src/modules/08-encounters/lifecycle/errors.ts — M8-T04 (§2.3, §2.7).
//
// Every guard / validation failure in the M8 encounter domain raises an `EncounterStateError` carrying
// the machine-readable code the spec's §2.7 table enumerates (e.g. `INVALID_ENCOUNTER_DISCIPLINE_PAIR`,
// `STEP_UP_AUTH_REQUIRED`, `IMMUTABLE_AFTER_SIGN`). The error extends the M1 `ChartWardenError` envelope
// base (packages/types — NOT the banned packages/foundation) so the M1 Fastify error handler renders it
// with the precise code + HTTP status the UI keys its message off, with no cross-module import edge. The
// code→status mapping is the single source mirrored from §2.7; nothing transitions on a string match —
// each code is an enumerated constant (the M6 state-machine convention).
import type { AssemblyErrorCode } from "@chartwarden/hearthnote";
import { ChartWardenError, type ErrorDetailType } from "@chartwarden/types";

/** The full §2.7 + §2.3 machine-readable failure-code catalog → canonical HTTP status. */
export const M8_ERROR_STATUS = {
  // §2.7 service-guard rules (run before any DB write)
  INVALID_ENCOUNTER_DISCIPLINE_PAIR: 422,
  SERVICE_DATE_IN_FUTURE: 422,
  SERVICE_DATE_BEFORE_ADMISSION: 422,
  LATE_ENTRY_REASON_REQUIRED: 422,
  NO_VOLUNTEER_ASSIGNMENT: 422,
  VOCAB_VERSION_MISMATCH: 409,
  // §2.7 sign-service rules
  STEP_UP_AUTH_REQUIRED: 412,
  F2F_DUAL_WRITE_REQUIRED: 412,
  NOT_COSIGN_ELIGIBLE: 403,
  NO_ELIGIBLE_COSIGNER: 422,
  // §2.2 / §3.3 vitals + mileage authoring (T10 — mirrors the DB CHECK constraints)
  VITALS_OUT_OF_RANGE: 422,
  VITALS_CNI_REASON_REQUIRED: 422,
  MILEAGE_ODOMETER_ORDER: 422,
  MILEAGE_OVERRIDE_REASON_REQUIRED: 422,
  // §3.3 care-plan link authoring (F-064 / #159 — mirrors the `at_least_one` DB CHECK)
  CARE_PLAN_LINK_REF_REQUIRED: 422,
  // §2.4 D3 cosignature-request lifecycle (T06)
  COSIGNATURE_LOCKED: 409,
  SUPERVISOR_RELEASE_NOT_PERMITTED: 403,
  SUPERVISOR_RELEASE_REASON_TOO_SHORT: 422,
  // §2.5 D4 late-entry tier overrides (T07)
  SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED: 422,
  ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED: 422,
  SIGNIFICANT_LATE_OVERRIDE_NOT_PERMITTED: 403,
  SIGNIFICANT_LATE_OVERRIDE_REASON_TOO_SHORT: 422,
  ADMINISTRATIVE_OVERRIDE_NOT_PERMITTED: 403,
  ADMINISTRATIVE_OVERRIDE_REASON_TOO_SHORT: 422,
  LATE_ENTRY_TIER_MISMATCH: 409,
  // §2.7 repository / immutability rules
  PARENT_VOIDED: 409,
  STALE_VERSION: 409,
  IMMUTABLE_AFTER_SIGN: 409,
  /** A per-visit record (ADLs, nutrition) can only change while the note is a draft: finalize pins the note text, so a later change
   *  would leave the stored record disagreeing with the note that was pinned (WF09). */
  NOTE_PINNED_AT_FINALIZE: 409,
  /** The encounter's note template has no section that states this record, so it would be saved and then silently left out of the
   *  signed note; the clinician is told instead of documenting something the note will not carry (WF09). */
  FINDING_NOT_IN_NOTE: 422,
  // §2.6 HearthNote Layer-1 assembly (#114). `@chartwarden/hearthnote` documents its own error codes as
  // "mapped to HTTP by the M8 service in T09" — this is that mapping, which was never written because
  // nothing ever assembled. TEMPLATE_NOT_FOUND and VOCAB_VERSION_MISMATCH already have codes above
  // (INVALID_ENCOUNTER_DISCIPLINE_PAIR / VOCAB_VERSION_MISMATCH), exactly as the package prescribes.
  UNKNOWN_VOCAB_CODE: 422,
  UNKNOWN_TEMPLATE_SECTION: 422,
  /** A selected statement carries a slot value outside its constraint, an unfilled slot at finalize, or
   *  contradicts another statement in the note (WF09). `details` names the section and rule per problem. */
  INVALID_SELECTION: 422,
  /** The note text the author typed is empty; discard the edit to go back to the generated text (WF09). */
  INVALID_NARRATIVE_EDIT: 422,
  /** The selections or vitals changed after the author edited the note text, so the text being signed may no longer say what the
   *  note holds. The author reviews it and applies it again, or discards it (WF09). */
  NARRATIVE_EDIT_STALE: 409,
  /** No tenant-DEK envelope is bound, so §3.6 free text cannot be sealed — the write refuses. */
  HEARTHNOTE_CIPHER_UNBOUND: 503,
  // §2.3 Layer-3 gate (enforced at sign; preview at finalize)
  COMPLIANCE_GATE_FAILED: 422,
  /** A §2.6 check could not be DECIDED — an upstream reader the gate consults is unreachable. Distinct
   *  from COMPLIANCE_GATE_FAILED on purpose: 422 means the documentation is incomplete and the clinician
   *  can fix it, 503 means the gate did not run. Refusing is the only safe direction — a signing-blocking
   *  control that passes when it cannot evaluate is the defect this gate was fixed from (#121). */
  COMPLIANCE_GATE_UNAVAILABLE: 503,
  /** The visit-note draft could not be computed: a seam it reads (care plan, scales, medications, Part 2 verdict)
   *  failed or returned something unusable. Never a partial draft passed off as complete (VN-D9, design §3.2). */
  DRAFT_UNAVAILABLE: 503,
  /** The clinician confirmed or deselected a drafted section against content that is no longer the draft: the section's content
   *  hash or the phrase-corpus version differs from the recomputed draft (VN-D12). Refetch the draft, review, resolve again. */
  DRAFT_SECTION_STALE: 409,
  /** The note was finalized with drafted text that may hold 42 CFR Part 2 content and the draft is now switched off for the organization,
   *  so sign could not seal it section by section (VN-D13 would then have no section to withhold). Switch the draft back on, then sign. */
  DRAFT_OFF_AFTER_FINALIZE: 409,
  /** A visit's per-goal keep and leave-out (ADR-0114 S4b) already holds as many link rows as one encounter may: a removed row is never revived, so each
   *  re-keep adds one, and the table is bounded per encounter. Nothing was changed; the message names no goal or intervention. */
  DISCIPLINE_PLAN_LINK_LIMIT: 409,
  /** An addendum names a section whose original is 42 CFR Part 2 derived and its author may not read Part 2 content: their redraft would silently
   *  shorten the note's current view (VN-D30). Refused at naming and again at sign; the error names no section. */
  AMENDMENT_PART2_NOT_ENTITLED: 422,
  /** A signed note's text could not be shown to this viewer because the 42 CFR Part 2 disclosure check (M39) could not be decided. An
   *  outage is never a silent denial and never a silent disclosure: 503, retry. */
  NOTE_VIEW_UNAVAILABLE: 503,
  // Visit delivery at sign (migration 1510): the clinician must say how the visit was delivered (Medicare
  // hospice SIA / visit lines count in-person visits only), and any documented start/end must be a real,
  // ordered, past bracket on the service date. Both are fixable by the clinician, hence 422.
  MODALITY_CONFIRMATION_REQUIRED: 422,
  VISIT_TIME_INVALID: 422,
  /** Typed times overlap another in-person / video bracket the same author documented (one person, one place). */
  VISIT_TIME_OVERLAP: 422,
  /** A `telephonic` encounter type cannot be recorded as delivered in person or by video. */
  MODALITY_CONFLICTS_WITH_VISIT_TYPE: 422,
  /** Typed visit times were supplied while the M18 check-in/out lookup was down. EVV always wins over typed times, so
   *  accepting them unverified could stand in for a bracket that exists; 503 = retry, not a documentation error. */
  EVV_BRACKET_UNAVAILABLE: 503,
  /** The legacy-confirm route is a ONE-TIME confirmation of an unconfirmed visit; a confirmed mode is final
   *  there (a corrective path with a reason is future work). */
  MODALITY_ALREADY_CONFIRMED: 409,
  // §2.3 void (admin-only; reason ≥ 40 chars)
  VOID_NOT_PERMITTED: 403,
  VOID_REASON_TOO_SHORT: 422,
  // Structural — an event dispatched from a state that does not accept it (§2.3 graph).
  ILLEGAL_TRANSITION: 409,
} as const;

/** A machine-readable M8 encounter-domain failure code (§2.7 / §2.3). */
export type M8ErrorCode = keyof typeof M8_ERROR_STATUS;

/**
 * The §2.7 code each `HearthnoteAssemblyError` maps to: the one table the selections routes and the draft computation both apply.
 * `TEMPLATE_KEY_MISMATCH` cannot occur through the routes (the key is server-derived from the encounter row), but it is mapped
 * rather than left to fall through as a 500. Typed on the package's union, so a new assembly code fails the build until it is mapped.
 */
export const ASSEMBLY_ERROR_CODE: Readonly<Record<AssemblyErrorCode, M8ErrorCode>> = {
  TEMPLATE_NOT_FOUND: "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
  TEMPLATE_KEY_MISMATCH: "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
  VOCAB_VERSION_MISMATCH: "VOCAB_VERSION_MISMATCH",
  UNKNOWN_VOCAB_CODE: "UNKNOWN_VOCAB_CODE",
};

/**
 * A guard / validation failure in the M8 encounter domain. Carries the precise §2.7 `code` so the UI
 * renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.3 every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class EncounterStateError extends ChartWardenError {
  /** `details` carries the §2.6 Layer-3 remediation list on a gate failure (the only code that uses it
   *  today): `{ field?, code, message }` per failed check, rendered by the M1 error handler into the
   *  §4.3 envelope the UI already reads. Every other code raises without one. */
  constructor(
    code: M8ErrorCode,
    message: string,
    details?: ErrorDetailType[],
    options?: { readonly cause?: unknown },
  ) {
    super(code, message, M8_ERROR_STATUS[code], details);
    this.name = "EncounterStateError";
    // The underlying failure stays on the error for the server log (the M1 handler logs a 5xx at `warn` with its cause chain);
    // the response carries only `message`, so it never reaches the caller.
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Throw an {@link EncounterStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M8ErrorCode, message: string): void {
  if (!condition) throw new EncounterStateError(code, message);
}
