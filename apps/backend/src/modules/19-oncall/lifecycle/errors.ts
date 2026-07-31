// apps/backend/src/modules/19-oncall/lifecycle/errors.ts — M19-T03 (§2.2–§2.7, §7.1–§7.3).
//
// Every guard failure in the M19 on-call triage domain raises a `TriageStateError` carrying the
// machine-readable code the §7 workflow tables and the §4.2 route error blocks name. The error extends the
// M1 `WardenXError` envelope base (packages/types — NOT the banned packages/foundation) so the M1 Fastify
// error handler renders the exact code + status with no cross-module import edge. Mirrors the M7
// `CarePlanStateError` / M15 `DisciplinePlanStateError` / M16 `BereavementStateError` precedent.
//
// CASING: bare SCREAMING_SNAKE, the M16 dialect — and here it is not a style choice. §7.1 and §7.3 spell
// two codes VERBATIM (`PROTOCOL_QUESTION_OUT_OF_ORDER`, `DISPOSITION_OUT_OF_SCOPE`) and both are bare. The
// wire code is the contract, so the two the spec wrote are kept exactly and every code the spec only
// describes in prose follows the same shape — one module, one dialect. (M21's `M21_*` prefix exists
// because M21's own §7 tables spell it that way; copying it here would have contradicted §7.1/§7.3.)
import { WardenXError } from "@wardenx/types";

/** The §2.3 / §7 machine-readable failure-code catalog → HTTP status. */
export const M19_ERROR_STATUS = {
  // ── §2.2.1 triage-call lifecycle ───────────────────────────────────────────────────────────────────
  /** An edge that does not exist for this (state, command) pair — §2.2.1's transition table is a
   *  WHITELIST, not a rank order (two legal edges run "backwards": `awaiting_callback →
   *  protocol_in_progress` and `escalated_unresolved → documented_pending_encounter`). */
  INVALID_STATE_TRANSITION: 409,
  /** `closed` / `abandoned` — no command advances out of them (§2.2.1). */
  TRIAGE_CALL_TERMINAL: 409,
  /** §2.5 — optimistic concurrency on `triage_call` / `triage_escalation`. */
  STALE_VERSION: 412,
  /** §2.2.1 — `markAbandoned(reason)` with nothing to record. "The caller hung up" is the one fact the
   *  abandoned row exists to carry; without it the row says a call happened and nothing else. */
  ABANDON_REASON_REQUIRED: 422,
  /** §2.2.1 — `markAwaitingCallback(reason)`; the callback timer's §4.8 SLA detector reads the reason to
   *  pick the target, so an empty one silently lands the call in the default bucket. */
  CALLBACK_REASON_REQUIRED: 422,

  // ── §2.2 / D4 protocol application ─────────────────────────────────────────────────────────────────
  /** D4 — the protocol's effective window does not contain the apply instant. A retired protocol may hold
   *  a question a state board has since prohibited, and applying it would put that question to a caller. */
  PROTOCOL_NOT_EFFECTIVE: 422,
  /** §7.3 — the actor's discipline is below the protocol's `discipline_required` (the LPN scope gate at
   *  the PROTOCOL boundary; the DISPOSITION boundary raises `DISPOSITION_OUT_OF_SCOPE`). */
  PROTOCOL_OUT_OF_DISCIPLINE_SCOPE: 403,
  /** D4 — a call pins ONE protocol + version at apply time and keeps it for the rest of the call. A
   *  second `applyProtocol` would silently re-key the answers already recorded against the first. */
  PROTOCOL_ALREADY_APPLIED: 409,
  /** D4 — a tenant protocol from another org, or a floor row the tenant cannot read. */
  PROTOCOL_NOT_AVAILABLE: 422,
  /** D7 — `requires_mandatory_escalation` with no tier routes the 2 a.m. page to nobody. The §3.3 CHECK
   *  makes the row impossible; this is the same refusal at the layer that can name the protocol. */
  PROTOCOL_MANDATORY_TIER_MISSING: 422,

  // ── §2.2.3 / D5 the answer ledger ──────────────────────────────────────────────────────────────────
  /** §7.1 VERBATIM — server-authoritative ordering: the client cannot skip a question by POSTing the one
   *  after it. D5's whole point is that the protocol is walked, not sampled. */
  PROTOCOL_QUESTION_OUT_OF_ORDER: 422,
  /** The question belongs to a different protocol than the one pinned on the call. */
  PROTOCOL_QUESTION_NOT_IN_PROTOCOL: 422,
  /** §2.2.3 — an original answer already exists; a change is a CORRECTION row, never an overwrite. */
  PROTOCOL_QUESTION_ALREADY_ANSWERED: 409,
  /** §2.3 — `completeProtocol` with a `required=true` question still unanswered. */
  REQUIRED_QUESTIONS_UNANSWERED: 422,
  /** §3.3 — the typed value column does not match the question's `answer_type`; an answer carrying the
   *  wrong column is an answer D5's red-flag predicate cannot evaluate. */
  ANSWER_VALUE_TYPE_MISMATCH: 422,
  /** §3.3 `m19_triage_call_answer_one_value` — exactly one typed value. An all-null row would satisfy
   *  "every required question has an answer row" while answering nothing: the cheapest way to walk a
   *  red-flag question past `completeProtocol`. "Unable to answer" is a recorded value, not an absence. */
  ANSWER_VALUE_REQUIRED: 422,
  /** §2.2.3 — the corrected-of row is not an answer on this call. */
  CORRECTION_TARGET_NOT_FOUND: 422,
  /** §2.2.3 — corrections chain to the ORIGINAL, never to another correction; otherwise "what did the
   *  caller first say" needs a graph walk with no guaranteed root. */
  CORRECTION_OF_CORRECTION_FORBIDDEN: 422,
  /** §2.3 — `completeProtocol` rejects while any red-flag escalation is still open. */
  RED_FLAG_ESCALATION_UNRESOLVED: 409,

  // ── §2.2.4 / D7 escalation ─────────────────────────────────────────────────────────────────────────
  ESCALATION_INVALID_TRANSITION: 409,
  ESCALATION_ALREADY_ACKNOWLEDGED: 409,
  ESCALATION_ALREADY_RESOLVED: 409,
  /** §2.2.4 — a resolution is the escalated party's answer; an empty one closes the ladder rung without
   *  recording what was decided at 2 a.m. */
  ESCALATION_RESOLUTION_REQUIRED: 422,
  /** §2.2.4 — a call close may NOT auto-resolve a mandatory-escalation row. The four D7 protocols exist
   *  precisely because the agency must be able to prove a human answered. */
  MANDATORY_ESCALATION_AUTO_RESOLVE_FORBIDDEN: 409,
  /** §3.3 `m19_triage_escalation_recipient` — `tier_5_external` routes to a vendor and every other tier
   *  routes to a membership, both directions. A tier with no recipient is an unrung page. */
  ESCALATION_RECIPIENT_REQUIRED: 422,

  // ── D6 disposition ─────────────────────────────────────────────────────────────────────────────────
  /** §7.3 VERBATIM — the role × disposition scope-of-practice matrix (D6), enforced in the disposition
   *  handler rather than as a registered ABAC predicate (§6 note / M19-F06). */
  DISPOSITION_OUT_OF_SCOPE: 403,
  /** D6 — `disposition_data` does not satisfy the chosen arm of the discriminated union. */
  DISPOSITION_PAYLOAD_INVALID: 422,
  /** §7.2 — while a mandatory escalation is unacknowledged the ONLY permitted outcome is
   *  `escalateUnresolved`. Selecting around it is how a suicidal-ideation call gets closed as caregiver
   *  education. */
  DISPOSITION_BLOCKED_BY_MANDATORY_ESCALATION: 409,
  /** §2.2.1 — `escalated_unresolved` and `abandoned` are enum dispositions AND states; each is reached by
   *  its OWN command (`escalateUnresolved` / `markAbandoned`), which carries the permission the plain
   *  disposition route does not (`triage.escalate` / `triage.close_abandoned`). */
  DISPOSITION_NOT_SELECTABLE: 422,

  // ── §2.2.1 / D8 documentation + close ──────────────────────────────────────────────────────────────
  /** D8 — an `m8.encounter.signed` whose encounter is not the one linked to this call. */
  ENCOUNTER_LINK_MISMATCH: 409,
  /** D8 / §2.7 D-B — `markDocumented` before the M8 encounter link exists (the degraded-mode park). */
  ENCOUNTER_NOT_LINKED: 409,
  /** §2.2.1 — the `triage.close` worker fired inside the 30-minute amendment grace. */
  DOCUMENTED_CLOSE_GRACE_NOT_ELAPSED: 409,

  // ── §2.7 / M19-F08 BCP paper re-entry ──────────────────────────────────────────────────────────────
  /** §2.7 step 2 — the original call time cannot be in the future; a re-entry that claims one would sort
   *  ahead of calls that really did happen later. */
  PAPER_REENTRY_OPENED_AT_IN_FUTURE: 422,
  /** §2.7 step 3 — the claimed original time falls outside the detected outage window. A paper-origin row
   *  is an assertion that the platform was DOWN when the call came in; outside the window it is an
   *  ordinary late entry, and M8's late-entry tier is where that belongs. */
  PAPER_REENTRY_OUTSIDE_OUTAGE_WINDOW: 422,
  /** §2.7 step 3 — the 72-hour worklist lifetime elapsed. */
  PAPER_REENTRY_WORKLIST_EXPIRED: 409,
  /** §3.3 `m19_triage_paper_reentry_pair` — the worklist row already names a re-entered call. */
  PAPER_REENTRY_ALREADY_LINKED: 409,

  // ── §2.2.2 / D2 / D3 on-call shift lifecycle (M19-T04) ─────────────────────────────────────────────
  /** §2.2.2 — an edge that does not exist for this (status, command) pair. */
  SHIFT_INVALID_STATE_TRANSITION: 409,
  /** §2.2.2 — `completed` / `cancelled`; no command advances out of either. */
  SHIFT_TERMINAL: 409,
  /** §2.5 — optimistic concurrency on `on_call_shift`. */
  SHIFT_STALE_VERSION: 412,
  /** §2.2.2 / §4.8 — the shift-open cron opens shifts whose `shift_starts_at <= now()`. Activating before
   *  the window begins would enter a CoP 418.100(c)(2) coverage claim for hours nobody agreed to cover. */
  SHIFT_NOT_YET_STARTED: 409,
  /** D7 — `activateShift` with no `tenant_oncall_policy` row to pin. `policy_snapshot` is the survey
   *  evidence of which escalation ladder was live; a shift that opens without one can never prove it. */
  SHIFT_POLICY_SNAPSHOT_REQUIRED: 422,
  /** §2.2.2 — `cancelShift(reason)` with nothing to record. A cancelled shift is a coverage window the
   *  agency deliberately gave up; why is the only thing the row exists to say. */
  SHIFT_CANCEL_REASON_REQUIRED: 422,

  // ── §4.5 / D3 the M17 roster sync (M19-T04) ────────────────────────────────────────────────────────
  /** §4.5 — an `OnCallRosterEntry.discipline` string that maps to no `oncall_shift_discipline` member.
   *  Reported per entry rather than thrown (see `reconcileOnCallRoster`); this code names it when a caller
   *  asks for the mapping directly. */
  ROSTER_DISCIPLINE_UNMAPPED: 422,

  // ── D10 the M17/M18 inbound triggers (M19-T04) ─────────────────────────────────────────────────────
  /** §7.6 / §4.8 — the source visit could not be read back through M17's `VisitReader`. Every M19 PHI row
   *  needs `organization_id` + `provider_entity_id` NOT NULL and the trigger payloads carry neither, so a
   *  visit that will not resolve dead-letters rather than anchoring a call to a guessed tenancy. */
  TRIGGER_VISIT_UNRESOLVED: 422,
  /** D10 — `triage_call.on_call_shift_id` is NOT NULL: a proactive call has to belong to somebody's shift.
   *  No shift covering the trigger instant IS the coverage gap; the consumer surfaces it as one (see
   *  `decideNoShowTrigger`) rather than retrying into a dead-letter queue nobody reads at 2 a.m. */
  TRIGGER_NO_COVERING_SHIFT: 409,
  /** D10 — the trigger names an organization other than the one the worker is running under. M17/M18
   *  payloads travel through the M1 outbox with their own envelope; a mismatch is a routing fault, and
   *  opening the call anyway would write a row for the wrong tenant. */
  TRIGGER_ORG_MISMATCH: 409,
  /** §2.7 step 1 — `paper_origin_flag` and `source='paper_origin'` move together (the §3.3 CHECK), and so
   *  do the flag and `paper_original_opened_at`. */
  PAPER_ORIGIN_FIELDS_INCOHERENT: 422,
} as const;

/** A machine-readable M19 domain failure code (§2.3 / §7). */
export type M19ErrorCode = keyof typeof M19_ERROR_STATUS;

/**
 * A guard / validation failure in the M19 on-call triage domain. Carries the precise code so the UI can
 * render an exact message (the §5 triage panel keys its sticky banners off these); the M1 error handler
 * maps `statusCode` to the HTTP response. Per §2.2 every guard failure surfaces as one of these — never a
 * raw PG exception or a generic `ConflictError`.
 */
export class TriageStateError extends WardenXError {
  constructor(code: M19ErrorCode, message: string) {
    super(code, message, M19_ERROR_STATUS[code]);
    this.name = "TriageStateError";
  }
}

/**
 * Throw a {@link TriageStateError} when `condition` is false (guard helper).
 *
 * Declared `asserts condition` rather than returning `void`: a guard that proves a fact and then lets the
 * compiler forget it pushes every caller into a non-null assertion, and a `!` is exactly the shape that
 * survives a later refactor after the guard above it stopped guaranteeing anything.
 */
export function require_(
  condition: boolean,
  code: M19ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new TriageStateError(code, message);
}
