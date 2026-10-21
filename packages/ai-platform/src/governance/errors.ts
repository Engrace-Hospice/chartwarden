// @chartwarden/ai-platform — M32's governance failure catalog (M32-T03; extended by M32-T05).
//
// Every guard in the capability-lifecycle, calibration, tenant-opt-in, clinician-opt-out, kill-switch,
// hallucination-triage, evaluation-run and prompt-activation rules refuses with a code from THIS table —
// ONE catalog for the module, not one per directory, because a route that had to know which of two
// error envelopes a rule speaks is a route that will eventually render the wrong status.
// The codes are bare SCREAMING_SNAKE (the M20/M19 dialect) and
// carry their own HTTP status so M32-T07's routes render the refusal without re-deciding it — a route
// that picks its own status is a route that can disagree with the rule that produced the refusal.
//
// THE PURE RULES DO NOT THROW. Each evaluator returns a discriminated `{ ok: false, code, detail }`
// and the caller decides whether that is an exception (an admin write) or a value (a gate evaluation
// feeding the §2.2 consumer posture). This is the M20-T01 finding applied preemptively: a rule that
// throws forces every caller into a try/catch and one of them forgets. `requireAiGovernance()` is the
// one place the conversion happens, and it is opt-in.
//
// WHAT IS DELIBERATELY ABSENT: no code for "the kill switch is on", none for "the token cap is
// reached", none for "`ai.full` is off". Those three are INVOCATION-GATE refusals, not admin-write
// failures, and every one of them is already expressible as an `AiCapabilityUnavailableReason` on the
// §2.2/W9 envelope. Duplicating them here would create two vocabularies for one refusal and guarantee
// they drift. M32-T05's `AI_KILL_SWITCH_*` codes are the opposite direction and belong here: they
// refuse an attempt to CHANGE a switch, which no consumer ever sees.
import { ChartWardenError } from "@chartwarden/types";

/** The M32-T03 governance failure catalog → HTTP status. */
export const AI_GOVERNANCE_ERROR_STATUS = {
  // ── §2.2 capability lifecycle ──────────────────────────────────────────────────────────────────
  /** The (fromState, toState, approvalKind) triple is not an edge of the §2.2 FSM. 409 because the
   *  request is well-formed and the CURRENT STATE is what makes it illegal — a retry after a legal
   *  intervening transition can succeed, which is a conflict, not a validation failure. */
  AI_LIFECYCLE_INVALID_TRANSITION: 409,
  /** The signer's role is not one §2.2's edge label requires. 403: the gate exists to name WHO may
   *  sign, and a Stage-2 promotion signed by someone who is not the Privacy Officer is exactly the
   *  governance failure D2 is built to prevent. */
  AI_LIFECYCLE_SIGNER_ROLE_INSUFFICIENT: 403,
  /** D10 — the edge requires evaluation evidence and `linkedEvaluationRunId` is absent. */
  AI_LIFECYCLE_EVALUATION_RUN_REQUIRED: 422,
  /** §3.2.1's `ai_capability_approved_has_template`, refused at the app layer with a code instead of
   *  surfacing as a constraint-violation 500. A capability cannot reach APPROVED/MONITORING without
   *  naming the prompt template it executes. */
  AI_LIFECYCLE_PROMPT_TEMPLATE_REQUIRED: 422,
  /** `ai_capability_lifecycle_event.rationale_text` is NOT NULL and it is the whole point of the row:
   *  the ledger records WHY a clinical AI capability moved, in the signer's own words. Whitespace is
   *  not a rationale. */
  AI_LIFECYCLE_RATIONALE_REQUIRED: 422,

  // ── §3.2.3 calibration ─────────────────────────────────────────────────────────────────────────
  /** The calibration names a backend outside the capability's own `allowed_backend_keys`. Publishing
   *  thresholds for a backend the capability may never route to would put a live-looking baseline in
   *  front of the drift monitor for traffic that cannot exist. */
  AI_CALIBRATION_BACKEND_NOT_ALLOWED: 422,
  /** `baseline_evaluation_run_id` is NOT NULL (§3.2.3): a baseline with no run behind it is a number
   *  nobody measured. */
  AI_CALIBRATION_EVALUATION_RUN_REQUIRED: 422,
  /** Superseding a current calibration without saying why. The nullable column is for the FIRST
   *  baseline (nothing was superseded); a replacement that cannot state its reason makes the W6
   *  promotion history unreadable. */
  AI_CALIBRATION_SUPERSEDE_REASON_REQUIRED: 422,

  // ── §5.3 / W4 tenant opt-in ────────────────────────────────────────────────────────────────────
  /** §5.3.1 / §2.2 — the capability's lifecycle posture does not offer this tenant an opt-in (below
   *  APPROVED, RETIRED, PILOT without pilot enrollment, or DEPRECATED to a tenant that had withdrawn). */
  AI_OPT_IN_CAPABILITY_NOT_OFFERABLE: 409,
  /** One of §5.3.1's acknowledgments is missing from the submission. `detail` names which. */
  AI_OPT_IN_ACKNOWLEDGMENT_MISSING: 422,
  /** W4.1 — the BAA reference did not resolve to a record in M2's contract registry. */
  AI_OPT_IN_BAA_UNRESOLVED: 422,
  /** W4.1 — the BAA resolved but has expired. Distinct from unresolved because the remedy differs: one
   *  is a typo, the other is a contract to renew. */
  AI_OPT_IN_BAA_EXPIRED: 422,
  /** W4.1 — no Zero-Data-Retention contract reference on the org's vendor contract metadata. */
  AI_OPT_IN_ZDR_CONTRACT_MISSING: 422,
  /** W4.1 — the named clinical reviewer does not hold `clinical_safety_lead` within this org. */
  AI_OPT_IN_CLINICAL_REVIEWER_INVALID: 422,
  /** AI Governance §10.8 — the chosen routing preference hides this capability (`local_only` with no
   *  local backend, `cloud_only` with no cloud backend). */
  AI_OPT_IN_ROUTING_MODE_UNSUPPORTED: 422,
  /** No `ai_tenant_opt_in_record` for (org, capability). */
  AI_OPT_IN_NOT_FOUND: 404,
  /** Revoking or pausing an opt-in that is already `opted_out`. */
  AI_OPT_IN_ALREADY_INACTIVE: 409,

  // ── §5.4 / §10.3 clinician opt-out ─────────────────────────────────────────────────────────────
  /** `ai_capability.clinician_opt_out_supported = false`. Not every capability is one a clinician can
   *  individually decline (an operational embedding index has no per-clinician surface to decline). */
  AI_OPT_OUT_NOT_SUPPORTED: 409,
  /** Reverting when the clinician has no live opt-out for the capability. */
  AI_OPT_OUT_NOT_FOUND: 404,

  // ── §3.2.12 / W3 kill switch (M32-T05) ─────────────────────────────────────────────────────────
  /** Activating a switch that is already `active` at the same scope. 409, and it is NOT idempotent-OK:
   *  a second activation would overwrite the FIRST one's attribution and timestamp, which is the
   *  incident record the post-mortem reads. */
  AI_KILL_SWITCH_ALREADY_ACTIVE: 409,
  /** Deactivating a switch that is not active. The remedy differs from a missing row (there is nothing
   *  to lift) and conflating them would let a lift that silently did nothing read as success. */
  AI_KILL_SWITCH_NOT_ACTIVE: 409,
  /** §3.2.12's `ai_kill_active_attributed` CHECK, refused at the app layer: a human actor kind with no
   *  membership id, or an `automated_*` kind carrying one. An unattributed human activation must not be
   *  storable as though a monitor had tripped it. */
  AI_KILL_SWITCH_ACTOR_ATTRIBUTION_INVALID: 422,
  /** A human-actor activation with no message. `reason` is an enum with nine values; `manual_safety_pause`
   *  in particular carries NO content of its own, so without the operator's words the row says only
   *  "a person stopped it". */
  AI_KILL_SWITCH_ACTIVATION_MESSAGE_REQUIRED: 422,
  /** R8 — "Deactivate kill switch (requires resolution narrative)". Turning a SEV-1 pause back on with
   *  no statement of what was resolved is the one write in M32 that most needs its why. */
  AI_KILL_SWITCH_RESOLUTION_REQUIRED: 422,

  // ── §3.2.10 / W5 hallucination report + triage (M32-T05) ───────────────────────────────────────
  /** `reporter_narrative_cipher` is NOT NULL and it is the report: an empty envelope is a row that
   *  says a clinician saw SOMETHING wrong and records nothing about what. */
  AI_HALLUCINATION_NARRATIVE_REQUIRED: 422,
  /** No `ai_hallucination_report` row for the supplied id (within the caller's org). */
  AI_HALLUCINATION_REPORT_NOT_FOUND: 404,
  /** The (from, to) pair is not an edge of D9's triage machine — including every edge OUT of a
   *  terminal status. Re-opening a closed report would let a mitigation be un-decided after the fact. */
  AI_HALLUCINATION_TRIAGE_INVALID_TRANSITION: 409,
  /** `triage_disposition` is NULL and the target status claims the report was understood. §3.2.10's
   *  CHECK permits NULL for the UNTRIAGED row; reaching `root_cause_identified`/`mitigated`/`closed`
   *  without one would leave the queue's outcome column empty for a report the queue calls resolved. */
  AI_HALLUCINATION_DISPOSITION_REQUIRED: 422,
  /** A triage decision with nobody named as its owner. */
  AI_HALLUCINATION_TRIAGE_OWNER_REQUIRED: 422,

  // ── §3.2.11 evaluation runs (M32-T05) ──────────────────────────────────────────────────────────
  /** No `ai_evaluation_run` row for the supplied id. */
  AI_EVALUATION_RUN_NOT_FOUND: 404,
  /** The (from, to) pair is not an edge of the run's own lifecycle (pending → in_progress →
   *  passed/failed/aborted). A completed run cannot re-enter `in_progress`: its MLflow artifact is
   *  already the evidence some lifecycle transition may have cited. */
  AI_EVALUATION_RUN_INVALID_TRANSITION: 409,
  /** A `decision` other than `no_decision` on a run that has not finished. §3.2.11 defaults the column
   *  to `no_decision` precisely so an unfinished run is visibly undecided. */
  AI_EVALUATION_DECISION_REQUIRES_TERMINAL_STATUS: 422,
  /** `approve_for_pilot` / `approve_for_ga` on a run whose status is not `passed`. An approval that
   *  cites a failed evaluation is worse than no evidence — D10's gate would read as satisfied. */
  AI_EVALUATION_DECISION_REQUIRES_PASS: 422,
  /** D10 — the `linkedEvaluationRunId` on a lifecycle transition names a run that does not support the
   *  edge: wrong capability, not `passed`, or a stage that is evidence for a different gate. */
  AI_EVALUATION_RUN_EVIDENCE_INVALID: 422,

  // ── §3.2.5 / §4.5 / R30 prompt templates (M32-T05) ─────────────────────────────────────────────
  /** No `ai_prompt_template` row for the (capabilityKey, version) or template key requested. */
  AI_PROMPT_TEMPLATE_NOT_FOUND: 404,
  /** `ai_prompt_template_cap_version_idx` — that capability already has that version. */
  AI_PROMPT_TEMPLATE_VERSION_TAKEN: 409,
  /** The submitted `template_content_hash` is not a 64-character hex SHA-256, or does not match the
   *  bytes at `template_filesystem_ref`. §4.10's boot validator makes this fatal; at activation time it
   *  is a refusal, because a row whose hash does not pin its file pins nothing. */
  AI_PROMPT_TEMPLATE_CONTENT_HASH_INVALID: 422,
  /** §4.10 — the PR-gated `clinical_reviewer_attestation` block is empty, or the row has no approver.
   *  An unattested prompt is exactly what the PR gate exists to keep out of the active set. */
  AI_PROMPT_TEMPLATE_ATTESTATION_REQUIRED: 422,
  /** D3's one-way walk (0116's `M32_PROMPT_TEMPLATE_STATUS_WALK`): a `deprecated` or `archived`
   *  template cannot be returned to `active`. Refused here with a code rather than surfacing the
   *  trigger's `restrict_violation` as a 500. */
  AI_PROMPT_TEMPLATE_NOT_ACTIVATABLE: 409,
  /** Activating a version that is ALREADY the active one. Not a no-op: the transaction would deprecate
   *  the current active row and then set the same row active, which the D3 walk forbids — so the
   *  capability would be left with NO active template. */
  AI_PROMPT_TEMPLATE_ALREADY_ACTIVE: 409,

  // ── shared ─────────────────────────────────────────────────────────────────────────────────────
  /** No `ai_capability` row for the supplied id/key. */
  AI_CAPABILITY_NOT_FOUND: 404,
  /** `ai_capability_key_idx` — the capability key is already registered. */
  AI_CAPABILITY_KEY_TAKEN: 409,
} as const;

/** A machine-readable M32 governance failure code. */
export type AiGovernanceErrorCode = keyof typeof AI_GOVERNANCE_ERROR_STATUS;

/** The refusal half of every M32-T03 pure evaluator. */
export interface AiGovernanceRefusal {
  readonly ok: false;
  readonly code: AiGovernanceErrorCode;
  /** Operator-facing detail. Never PHI: these rules see governance metadata only. */
  readonly detail: string;
}

/** Build a refusal (the evaluators' single construction point, so the shape cannot drift). */
export function aiGovernanceRefusal(
  code: AiGovernanceErrorCode,
  detail: string,
): AiGovernanceRefusal {
  return { ok: false, code, detail };
}

/** The M1 error envelope for an M32 governance refusal — rendered by the shared Fastify handler. */
export class AiGovernanceError extends ChartWardenError {
  constructor(code: AiGovernanceErrorCode, detail: string) {
    super(code, detail, AI_GOVERNANCE_ERROR_STATUS[code]);
    this.name = "AiGovernanceError";
  }
}

/** Narrow a pure evaluator result to its success arm, throwing the M1 envelope on a refusal. */
export function requireAiGovernance<T>(result: ({ ok: true } & T) | AiGovernanceRefusal): T {
  if (result.ok === false) throw new AiGovernanceError(result.code, result.detail);
  return result;
}
