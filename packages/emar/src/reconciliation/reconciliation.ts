// @wardenx/emar — §2.8 D17 medication-reconciliation worksheet (M13-T06). PURE, IO-free, `Date.now()`-free.
//
// Reconciliation is a *workflow*, not a separate clinical surface: four M6 events (`admission` /
// `transfer_in` / `discharge` / `recertification`) open a `medication_reconciliation_worksheet`; the clinician
// works each line to one `medication_reconciliation_decision`; finalization (every line decided) emits
// `m13.reconciliation.completed`. The structural value of D17 is that each per-line decision back-links to the
// M12 order it carries-forward / discontinues, so survey reconstruction is deterministic. This module is the
// pure core of that workflow (the M13-T08 worker binds the M12 seam reads + the row writes):
//   - `buildReconciliationWorksheet` materializes the worksheet init + the `m13.reconciliation.opened` signal
//     from an M6 trigger envelope, computing the `due_at` from the trigger kind (CoP 5-day for admission).
//   - `planReconciliationDecision` maps a per-line decision to the M12-handshake outbox event it emits
//     (`draft_order_requested` / `discontinue_requested`) — conditioned on the line's source — and rejects the
//     one genuinely contradictory combination (`new_order` on an already-active M12 order).
//   - `finalizeReconciliationWorksheet` gates finalization on every line being decided and emits the
//     `completed` + `document_requested` pair.
//   - `evaluateReconciliationTimeliness` is the cron's pure core: the 24h-pre-deadline warning + the overdue
//     signal, against an injected clock.
// Every fact (the trigger instant, the line source, the decided/total counts, the evaluation instant) is
// injected, so the math is deterministic and unit-testable with no DB and no clock — the M13-T03/T04/T05
// pure-domain precedent.
import type {
  AdmissionId,
  DeaSchedule,
  IsoInstant,
  MedClass,
  MedicationOrderId,
  PatientId,
  ReconciliationDecisionKind,
  ReconciliationTriggerKind,
  ReconciliationWorksheetId,
  ReconciliationWorksheetStatus,
} from "@wardenx/types";
import { AdministrationStateError, require_ } from "../lifecycle/errors";

// ── Worksheet open (consumes the four M6 trigger events) ─────────────────────────────────────────────────

/**
 * §2.8 — the per-trigger-kind due window, in hours. `admission` is the CoP 42 CFR §418.54 comprehensive-
 * assessment deadline (5 calendar days = 120h, the spec-pinned value, W-EMAR-08 `dueAt=1030+5d`); `discharge`
 * is the 24h disposition-documentation window (W-EMAR-09 `dueAt+24h`). `transfer_in` follows the time-sensitive
 * discharge analog (24h); `recertification` follows the comprehensive-reassessment analog (120h). The route may
 * override per tenant policy; these are the spec-derived defaults.
 */
export const RECONCILIATION_DUE_WINDOW_HOURS: Readonly<Record<ReconciliationTriggerKind, number>> =
  {
    admission: 120,
    transfer_in: 24,
    discharge: 24,
    recertification: 120,
  } as const;

/** §2.8 — the `due_at` for a worksheet: the trigger instant plus the per-trigger-kind window. Pure. */
export function reconciliationDueAt(
  triggerKind: ReconciliationTriggerKind,
  triggeredAt: IsoInstant,
): IsoInstant {
  const hours = RECONCILIATION_DUE_WINDOW_HOURS[triggerKind];
  return new Date(Date.parse(triggeredAt) + hours * 3_600_000).toISOString();
}

/** §2.8 — the M6 trigger envelope that opens a worksheet (one of the four `m6.*` events). */
export interface ReconciliationTriggerEnvelope {
  readonly worksheetId: ReconciliationWorksheetId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly triggerKind: ReconciliationTriggerKind;
  /** The originating M6 outbox event id — the `(admission, triggerKind, triggerOutboxEventId)` unique makes
   * a re-delivery an idempotent no-op (the worker upserts on the unique). */
  readonly triggerOutboxEventId: string;
  readonly triggeredAt: IsoInstant;
}

/** §2.8 — the `m13.reconciliation.opened` payload (M14 / M30 / M33 consume; IDs only, no free-text PHI). */
export interface ReconciliationOpenedSignal {
  readonly worksheetId: ReconciliationWorksheetId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly triggerKind: ReconciliationTriggerKind;
  readonly triggeredAt: IsoInstant;
  readonly dueAt: IsoInstant;
}

/** §2.8 — the materialized `medication_reconciliation_worksheet` row init (the worker persists it). */
export interface ReconciliationWorksheetInit {
  readonly worksheetId: ReconciliationWorksheetId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly triggerKind: ReconciliationTriggerKind;
  readonly triggerOutboxEventId: string;
  readonly triggeredAt: IsoInstant;
  readonly dueAt: IsoInstant;
  readonly status: ReconciliationWorksheetStatus;
}

/** §2.8 — the full open plan: the worksheet init + the `m13.reconciliation.opened` signal. */
export interface ReconciliationWorksheetPlan {
  readonly worksheet: ReconciliationWorksheetInit;
  readonly openedSignal: ReconciliationOpenedSignal;
}

/**
 * §2.8 D17 — open a `medication_reconciliation_worksheet` in `status='pending'` from an M6 trigger, computing
 * the `due_at` from the trigger kind. Pure — the worker upserts the row on the `(admission, triggerKind,
 * triggerOutboxEventId)` unique (idempotent on re-delivery) + emits the `opened` signal in one transaction.
 */
export function buildReconciliationWorksheet(
  envelope: ReconciliationTriggerEnvelope,
): ReconciliationWorksheetPlan {
  const dueAt = reconciliationDueAt(envelope.triggerKind, envelope.triggeredAt);
  return {
    worksheet: {
      worksheetId: envelope.worksheetId,
      patientId: envelope.patientId,
      admissionId: envelope.admissionId,
      triggerKind: envelope.triggerKind,
      triggerOutboxEventId: envelope.triggerOutboxEventId,
      triggeredAt: envelope.triggeredAt,
      dueAt,
      status: "pending",
    },
    openedSignal: {
      worksheetId: envelope.worksheetId,
      patientId: envelope.patientId,
      admissionId: envelope.admissionId,
      triggerKind: envelope.triggerKind,
      triggeredAt: envelope.triggeredAt,
      dueAt,
    },
  };
}

// ── Per-line decisions ───────────────────────────────────────────────────────────────────────────────────

/** §2.8 — a worksheet line's source: an M12 active order, an M12 medhx record, or a caregiver-reported home med. */
export type ReconciliationLineKind = "m12_active" | "m12_medhx" | "caregiver_reported";

/**
 * §2.8 D17 (F-16x, #248) — the real drug content a minted draft `medication_order` needs, honestly sourced.
 * There is NO `m12_medhx` record projection anywhere in this codebase yet (`medicationHistory()` is a
 * permanent `{ records: [] }` stub — "no local projection until the [DoseSpot MedHx] store is threaded"),
 * so this can only ever be populated from a real CALLER-supplied value today: the clinician reconciling a
 * `caregiver_reported` home med, or authoring a `new_order`. It is never fabricated or defaulted — a
 * `carry_forward`/`new_order` decision with no supplied content, or on an `m12_medhx` line, refuses rather
 * than minting a placeholder (see `planReconciliationDecision` below).
 */
export interface ReconciliationMedicationDetails {
  readonly drugName: string;
  readonly strength: string;
  readonly doseForm: string;
  readonly route: string;
  readonly medClass: MedClass;
  /** Required when `medClass='controlled_substance'` — never defaulted (a wrong schedule is a DEA-relevant
   *  misstatement, not a cosmetic gap). Must be omitted/null otherwise. */
  readonly deaSchedule?: DeaSchedule | null;
  readonly rxnormRxcui?: string | null;
  readonly ndc?: string | null;
}

/** §2.8 — one per-line reconciliation decision the clinician records (mirrors `medication_reconciliation_decision`). */
export interface ReconciliationDecisionInput {
  readonly lineKind: ReconciliationLineKind;
  readonly decisionKind: ReconciliationDecisionKind;
  /** Present when the line is an M12 active order (`lineKind='m12_active'`) — back-link for the discontinue
   *  handshake. Never read for a draft (an active order needs no draft; carry_forward of it is a no-op). */
  readonly medicationOrderId?: MedicationOrderId | null;
  /** The real drug content for a line that would mint a draft (`carry_forward` of a non-active line, or
   *  `new_order`). Required in that case; see the type doc for why it can never be derived automatically. */
  readonly medicationDetails?: ReconciliationMedicationDetails | null;
}

/** §2.8 — the `m13.reconciliation.draft_order_requested` payload's mintable content (M12 mints a draft from
 *  this; the caller adds `worksheetId`/`decisionId`/`patientId`/`decisionMadeByMembershipId` once the
 *  decision row exists — this pure core runs BEFORE that row's id is assigned). */
export interface DraftOrderRequestedSignal {
  readonly lineKind: ReconciliationLineKind;
  readonly medicationOrderDraftPayload: ReconciliationMedicationDetails;
}

/** §2.8 — the `m13.reconciliation.discontinue_requested` payload's mintable content (M12's reconciliation
 *  consumer stops the order; the caller adds `worksheetId`/`decisionId`/`reason`). */
export interface DiscontinueRequestedSignal {
  readonly medicationOrderId: MedicationOrderId;
}

/** §2.8 — the result of one line decision: the M12-handshake signal to emit (at most one) + the status patch. */
export interface ReconciliationDecisionResult {
  /** Emit when the decision must mint a draft M12 order (`carry_forward` of a non-active line, or `new_order`). */
  readonly draftOrderRequested: DraftOrderRequestedSignal | null;
  /** Emit when the decision stops an active M12 order (`discontinue` of an `m12_active` line). */
  readonly discontinueRequested: DiscontinueRequestedSignal | null;
  /** The worksheet status after recording the decision (the first decision moves `pending` → `in_progress`). */
  readonly statusAfter: "in_progress";
}

/**
 * §2.8 D17 — plan one per-line decision: derive which M12-handshake event (if any) the decision emits.
 *   - `carry_forward` of an already-`m12_active` line stays active → no event (there is no drug content to
 *     source, and none is needed — the order already exists).
 *   - `carry_forward` of a `caregiver_reported` line mints a draft from the caller-supplied
 *     `medicationDetails` → `draft_order_requested`. `RECONCILIATION_MEDICATION_DETAILS_REQUIRED` when none
 *     was supplied — never a placeholder.
 *   - `carry_forward` / `new_order` of an `m12_medhx` line is REFUSED with `RECONCILIATION_MEDHX_UNAVAILABLE`
 *     — there is no medhx-record projection anywhere in this codebase to source real content from (see the
 *     `ReconciliationMedicationDetails` doc), and minting a draft claiming "derived from history" with no
 *     real history record behind it would misstate the order's provenance.
 *   - `new_order` is a newly identified med → `draft_order_requested` from `medicationDetails`; on an
 *     already-active order it is a contradiction → `RECONCILIATION_DECISION_INVALID`.
 *   - `discontinue` of an `m12_active` line stops it → `discontinue_requested`; of a non-active line it merely
 *     documents "not carried forward" → no event (there is no order to stop).
 *   - `hold` annotates only; `document_only` is informational → no event.
 * Pure — the caller persists the `medication_reconciliation_decision` row + emits the returned signal(s)
 * (merging in the worksheet/decision/patient/actor ids this core does not have).
 */
export function planReconciliationDecision(
  decision: ReconciliationDecisionInput,
): ReconciliationDecisionResult {
  const isActive = decision.lineKind === "m12_active";
  const none: ReconciliationDecisionResult = {
    draftOrderRequested: null,
    discontinueRequested: null,
    statusAfter: "in_progress",
  };
  const planDraft = (): ReconciliationDecisionResult => {
    require_(
      decision.lineKind !== "m12_medhx",
      "RECONCILIATION_MEDHX_UNAVAILABLE",
      "no M12 medication-history record projection exists to source drug content from a medhx line " +
        "(the DoseSpot MedHx fetch is not yet built) — record this decision against a caregiver-reported " +
        "or new-order line with explicit drug content instead",
    );
    require_(
      decision.medicationDetails != null,
      "RECONCILIATION_MEDICATION_DETAILS_REQUIRED",
      "a 'carry_forward' or 'new_order' decision on a non-active line requires explicit drug content " +
        "(drugName/strength/doseForm/route/medClass) — it is never fabricated",
    );
    const details = decision.medicationDetails;
    require_(
      (details.medClass === "controlled_substance") === (details.deaSchedule != null),
      "RECONCILIATION_MEDICATION_DETAILS_REQUIRED",
      "deaSchedule is required when medClass='controlled_substance' and must be omitted otherwise",
    );
    return {
      ...none,
      draftOrderRequested: { lineKind: decision.lineKind, medicationOrderDraftPayload: details },
    };
  };
  switch (decision.decisionKind) {
    case "carry_forward": {
      if (isActive) return none; // already an active M12 order — no draft needed
      return planDraft();
    }
    case "new_order": {
      require_(
        !isActive,
        "RECONCILIATION_DECISION_INVALID",
        "a 'new_order' decision cannot target an already-active M12 medication order",
      );
      return planDraft();
    }
    case "discontinue": {
      if (!isActive || !decision.medicationOrderId) return none; // nothing to stop on a non-active line
      return { ...none, discontinueRequested: { medicationOrderId: decision.medicationOrderId } };
    }
    case "hold":
    case "document_only":
      return none;
  }
}

// ── Finalization ─────────────────────────────────────────────────────────────────────────────────────────

/** §2.8 — the facts the route resolves before finalizing a worksheet. */
export interface ReconciliationFinalizeInput {
  readonly worksheetId: ReconciliationWorksheetId;
  readonly status: ReconciliationWorksheetStatus;
  readonly triggerKind: ReconciliationTriggerKind;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  /** Total worksheet lines. */
  readonly lineCount: number;
  /** Lines that have a recorded decision. */
  readonly decidedLineCount: number;
  readonly finalizedByMembershipId: string;
  /** Server-receive instant the finalize commits at (injected; no clock). */
  readonly finalizedAt: IsoInstant;
}

/** §2.8 — one decided line in the `m13.reconciliation.completed` payload. */
export interface ReconciliationCompletedDecision {
  readonly lineId: string;
  readonly kind: ReconciliationDecisionKind;
  readonly medicationOrderId: MedicationOrderId | null;
}

/** §2.8 — the `m13.reconciliation.completed` payload (M22 renders the PDF; M30 computes the timeliness measure). */
export interface ReconciliationCompletedSignal {
  readonly worksheetId: ReconciliationWorksheetId;
  readonly triggerKind: ReconciliationTriggerKind;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly finalizedAt: IsoInstant;
  readonly finalizedByMembershipId: string;
  readonly decisions: readonly ReconciliationCompletedDecision[];
}

/** §2.8 — the finalize plan: the worksheet patch + the `completed` and `document_requested` outbox signals. */
export interface ReconciliationFinalizePlan {
  readonly worksheetId: ReconciliationWorksheetId;
  readonly statusAfter: "finalized";
  readonly finalizedAt: IsoInstant;
  readonly finalizedByMembershipId: string;
  readonly completedSignal: ReconciliationCompletedSignal;
}

/**
 * §2.8 D17 — finalize a worksheet. Legal only from `pending`/`in_progress` (a `finalized`/`voided` worksheet is
 * terminal → `ILLEGAL_RECONCILIATION_TRANSITION`), and only when every line has a decision (else
 * `RECONCILIATION_NOT_FINALIZABLE`). The `m13.reconciliation.completed` signal carries the per-line decisions
 * (M22 renders the PDF via `document_requested`, M30 computes the timeliness measure). Pure — the route persists
 * the patch + emits both signals; `decisions` is resolved upstream and passed in via {@link ReconciliationCompletedDecision}.
 */
export function finalizeReconciliationWorksheet(
  input: ReconciliationFinalizeInput,
  decisions: readonly ReconciliationCompletedDecision[],
): ReconciliationFinalizePlan {
  require_(
    input.status === "pending" || input.status === "in_progress",
    "ILLEGAL_RECONCILIATION_TRANSITION",
    `a worksheet in '${input.status}' cannot be finalized`,
  );
  require_(
    input.lineCount >= 0 && input.decidedLineCount >= input.lineCount,
    "RECONCILIATION_NOT_FINALIZABLE",
    `worksheet has ${input.lineCount - input.decidedLineCount} undecided line(s); every line must be decided`,
  );
  return {
    worksheetId: input.worksheetId,
    statusAfter: "finalized",
    finalizedAt: input.finalizedAt,
    finalizedByMembershipId: input.finalizedByMembershipId,
    completedSignal: {
      worksheetId: input.worksheetId,
      triggerKind: input.triggerKind,
      patientId: input.patientId,
      admissionId: input.admissionId,
      finalizedAt: input.finalizedAt,
      finalizedByMembershipId: input.finalizedByMembershipId,
      decisions,
    },
  };
}

// ── Timeliness sweep (nightly cron) ──────────────────────────────────────────────────────────────────────

/** §2.8 — the warning fires this many hours before `due_at` (CoP comprehensive-assessment 24h pre-deadline). */
export const RECONCILIATION_DUE_WARNING_HOURS = 24;

/** §2.8 — the `m13.reconciliation.due_at_warning` / `.overdue` payload (M36 routes to case manager + supervisor). */
export interface ReconciliationTimelinessSignal {
  readonly worksheetId: ReconciliationWorksheetId;
  readonly admissionId: AdmissionId;
  readonly triggerKind: ReconciliationTriggerKind;
  readonly dueAt: IsoInstant;
}

/** §2.8 — the timeliness evaluation outcome for one open worksheet. */
export interface ReconciliationTimelinessResult {
  readonly state: "on_time" | "due_soon" | "overdue";
  /** Present when `state='due_soon'` — the `m13.reconciliation.due_at_warning` payload. */
  readonly dueAtWarning: ReconciliationTimelinessSignal | null;
  /** Present when `state='overdue'` — the `m13.reconciliation.overdue` payload. */
  readonly overdue: ReconciliationTimelinessSignal | null;
}

/**
 * §2.8 — evaluate an open (`pending`/`in_progress`) worksheet's timeliness as of `nowIso`: `overdue` past
 * `due_at`, `due_soon` within the 24h pre-deadline window, `on_time` otherwise. A `finalized`/`voided`
 * worksheet is never evaluated (the cron filters by status before calling). The clock is INJECTED so the cron
 * is testable with no `Date.now()`. Pure.
 */
export function evaluateReconciliationTimeliness(
  worksheet: {
    readonly worksheetId: ReconciliationWorksheetId;
    readonly admissionId: AdmissionId;
    readonly triggerKind: ReconciliationTriggerKind;
    readonly dueAt: IsoInstant;
  },
  nowIso: IsoInstant,
): ReconciliationTimelinessResult {
  const now = Date.parse(nowIso);
  const due = Date.parse(worksheet.dueAt);
  const signal: ReconciliationTimelinessSignal = {
    worksheetId: worksheet.worksheetId,
    admissionId: worksheet.admissionId,
    triggerKind: worksheet.triggerKind,
    dueAt: worksheet.dueAt,
  };
  if (now >= due) {
    return { state: "overdue", dueAtWarning: null, overdue: signal };
  }
  if (now >= due - RECONCILIATION_DUE_WARNING_HOURS * 3_600_000) {
    return { state: "due_soon", dueAtWarning: signal, overdue: null };
  }
  return { state: "on_time", dueAtWarning: null, overdue: null };
}
