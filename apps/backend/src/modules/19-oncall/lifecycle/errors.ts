// apps/backend/src/modules/19-oncall/lifecycle/errors.ts — M19-T03 (§2.2–§2.7, §7.1–§7.3).
//
// Every guard failure in the M19 on-call triage domain raises a `TriageStateError` carrying the
// machine-readable code the §7 workflow tables and the §4.2 route error blocks name. The error extends the
// M1 `ChartWardenError` envelope base (packages/types — NOT the banned packages/foundation) so the M1 Fastify
// error handler renders the exact code + status with no cross-module import edge. Mirrors the M7
// `CarePlanStateError` / M15 `DisciplinePlanStateError` / M16 `BereavementStateError` precedent.
//
// CASING: bare SCREAMING_SNAKE, the M16 dialect — and here it is not a style choice. §7.1 and §7.3 spell
// two codes VERBATIM (`PROTOCOL_QUESTION_OUT_OF_ORDER`, `DISPOSITION_OUT_OF_SCOPE`) and both are bare. The
// wire code is the contract, so the two the spec wrote are kept exactly and every code the spec only
// describes in prose follows the same shape — one module, one dialect. (M21's `M21_*` prefix exists
// because M21's own §7 tables spell it that way; copying it here would have contradicted §7.1/§7.3.)
import { ChartWardenError } from "@wardenx/types";

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

  // ── D8 the M8 EncounterCreator binding (M19-T05) ───────────────────────────────────────────────────
  /** D8 — M8's `CreateEncounterInput` requires `patientId` AND `admissionId` NOT NULL, and both are
   *  nullable on `triage_call` (a call is opened before the caller is matched, §3.3). A call that reaches
   *  disposition with no identified patient cannot open the encounter that is the only thing which
   *  advances it to `documented` — route #4 `identify-patient` is the step that was skipped. */
  ENCOUNTER_PATIENT_NOT_IDENTIFIED: 409,
  /** D8 / §7.5 — an external triage-vendor operator holds no WardenX clinical identity, so there is no
   *  `authorMembershipId` M8 could attribute the encounter to and no `encounter_discipline` that names
   *  them. The vendor's segment is documented by the in-agency clinician who took the handoff. */
  ENCOUNTER_ACTOR_CANNOT_AUTHOR: 403,

  // ── D9 / §7.7 the M11 verbal order taken during a call (M19-T05) ───────────────────────────────────
  /** D9 / §7.7 — M2 SESSION_POLICY step-up (biometric / PIN) was absent, stale, or satisfied by a factor
   *  the platform floor does not accept. After-hours is exactly when impersonation risk is highest, so
   *  this gate fails CLOSED on every missing input. */
  VERBAL_ORDER_STEP_UP_REQUIRED: 403,
  /** §6 / D6 — `verbal_order_recorded` is an RN-or-above disposition; an LPN / MSW / chaplain / vendor
   *  operator taking a verbal order is the scope-of-practice breach the disposition matrix already
   *  refuses, refused here at the seam so a worker path cannot route around the disposition handler. */
  VERBAL_ORDER_ACTOR_OUT_OF_SCOPE: 403,
  /** M11 §2.8 `RecordVerbalOrderInput` — the attestation is the RN's own account of what the physician
   *  said and is 100–2000 chars by M11's contract. M19 refuses BEFORE the seam call so the clinician sees
   *  a triage error rather than an opaque upstream one. */
  VERBAL_ORDER_ATTESTATION_INVALID: 422,
  /** M11 §2.8 — the ordering physician is an M40 `ExternalPhysician` id and the signature is theirs; an
   *  unattributed verbal order has nobody to route the 48-hour countersignature to. */
  VERBAL_ORDER_PHYSICIAN_REQUIRED: 422,
  /** D9 — the order/medication-order the verbal attestation attaches to. M11's signature primitive is
   *  polymorphic over an EXISTING target; M19 mints no order row. */
  VERBAL_ORDER_TARGET_REQUIRED: 422,

  // ── D15 the M12 medication / refill read surface (M19-T05) ─────────────────────────────────────────
  /** D15 — `prn_intervention_authorized` names an M12 medication order that the owning module's reader
   *  does not return under this tenant's RLS. Authorizing a PRN dose against an order that does not
   *  exist is the shape M13 cannot administer against. */
  PRN_TARGET_NOT_FOUND: 422,

  // ── F-224 the explicit caregiver/attending triage SUMMARY request ──────────────────────────────────
  /** F-224 — the call has no deliverable summary yet: it is not `documented_pending_encounter`/`documented`/
   *  `closed` with a selected disposition, or it is an `abandoned`/`escalated_unresolved` end (no outcome
   *  to hand a caregiver), or no patient has been identified (a summary is filed on a chart). */
  TRIAGE_SUMMARY_NOT_AVAILABLE: 409,
  /** F-224 — an external triage VENDOR operator may not request one: the summary is an in-agency
   *  disclosure to the caregiver/attending, and a vendor holds no clinical identity (§8.3.1 / D13). */
  TRIAGE_SUMMARY_ACTOR_FORBIDDEN: 403,

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

  // ── §4.1 the route layer (M19-T07) ─────────────────────────────────────────────────────────────────
  //
  // The four NOT_FOUND codes below are what a route raises when its aggregate does not resolve UNDER THE
  // CALLER'S RLS SCOPE. They are deliberately indistinguishable from "the row belongs to another tenant":
  // §9.4's IDOR test asks that a cross-tenant id be unprobeable, and a 404 that means only "absent" would
  // let a caller enumerate which ids exist by watching for a 403 instead.
  /** §4.1 rows 3-15 — no `triage_call` with this id is readable by this caller. */
  TRIAGE_CALL_NOT_FOUND: 404,
  /** §4.1 rows 17-18 — no `triage_escalation` with this id is readable by this caller. */
  ESCALATION_NOT_FOUND: 404,
  /** §4.1 rows 21-23 — no `on_call_shift` with this id is readable by this caller. */
  SHIFT_NOT_FOUND: 404,
  /** §4.1 rows 25-26 — this (org, ProviderEntity) has no `tenant_oncall_policy` row. NOT auto-created:
   *  D7 pins the policy onto every shift that opens, and a default invented at read time would be pinned
   *  as though the tenant had chosen it. */
  ONCALL_POLICY_NOT_FOUND: 404,
  /** §4.1 rows 28-32 — no `triage_protocol` / question with this id is in this tenant's catalog. */
  PROTOCOL_NOT_FOUND: 404,
  /** §4.1 rows 33-35 — no `external_triage_vendor` binding with this id under this tenant. */
  VENDOR_BINDING_NOT_FOUND: 404,

  /** §4.1 rows 30-32 / §3.3's floor CHECK pair — a platform-floor (`is_system_locked`) protocol row is not
   *  a tenant's to edit. Migration 0108's RLS policies already make the UPDATE impossible; this is the
   *  same refusal at the layer that can say WHY, so the DON sees "this is a platform protocol" rather than
   *  "0 rows updated". §8.3.2 lists lowering a mandatory-escalation floor as the tampering threat. */
  PROTOCOL_SYSTEM_LOCKED: 403,
  /** §4.1 row 29 — a tenant may author a tenant-custom protocol and may not mint a platform-floor one. */
  PROTOCOL_PLATFORM_MINT_FORBIDDEN: 403,

  /** §7.3 / §6 — the actor's M3 role keys evidence NO §3.2 discipline band, so the disposition matrix has
   *  nothing to decide against. Fails CLOSED: an unclassifiable actor gets no disposition scope at all,
   *  rather than the widest or the narrowest band by default. */
  TRIAGE_ACTOR_DISCIPLINE_UNRESOLVED: 403,

  /** D12 / §8.6 — the clinician overrode an AI protocol suggestion whose confidence was AT OR ABOVE the
   *  governance floor and supplied no reason (or one under 10 chars). Below the floor no reason is
   *  required, which is why this cannot be a blanket "reason required" on the apply route. */
  AI_OVERRIDE_REASON_REQUIRED: 422,

  /** D13 / §8.5 — a vendor binding is being created or activated without the BAA attestation §8.5 requires
   *  to be on file before an adapter is enabled at runtime. */
  VENDOR_BAA_ATTESTATION_REQUIRED: 422,
  /** D3 — `hybrid` / `centralized` are structurally complete but feature-flagged OFF in Phase 1. A policy
   *  PATCH that selects one on a deployment where the flag is off is refused rather than accepted-and-
   *  ignored, which would leave the tenant believing a vendor was answering their nights. */
  ONCALL_MODEL_NOT_ENABLED: 409,
  /** §4.8 — an `m36.notification.delivery_failed` naming an on-call recipient but no ProviderEntity. Every
   *  M19 PHI row needs `provider_entity_id` NOT NULL, so the delivery dead-letters for a human rather than
   *  anchoring an operational call to a guessed tenancy (the D10 posture, unchanged). */
  DELIVERY_FAILURE_PROVIDER_ENTITY_UNRESOLVED: 422,
  /** ADR-0082 — an `m36.afterhours_triage.requested` whose id fields are missing or not uuids. Dead-letters
   *  for a human; nothing is guessed. */
  AFTERHOURS_PAYLOAD_INVALID: 422,
  /** ADR-0082 — the request names a patient that does not resolve in the envelope's organization (another
   *  tenant's, or unknown). Refused, never opened: the frozen outcome contract has no "refused" arm, so the
   *  M36 link row stays unanswered and the sender sees "triage call not confirmed". */
  AFTERHOURS_PATIENT_NOT_IN_ORG: 422,
} as const;

/** A machine-readable M19 domain failure code (§2.3 / §7). */
export type M19ErrorCode = keyof typeof M19_ERROR_STATUS;

/**
 * A guard / validation failure in the M19 on-call triage domain. Carries the precise code so the UI can
 * render an exact message (the §5 triage panel keys its sticky banners off these); the M1 error handler
 * maps `statusCode` to the HTTP response. Per §2.2 every guard failure surfaces as one of these — never a
 * raw PG exception or a generic `ConflictError`.
 */
export class TriageStateError extends ChartWardenError {
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
