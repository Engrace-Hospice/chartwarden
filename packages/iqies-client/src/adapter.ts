import type { HopeSubmissionEnvelope } from "./envelope";
// @chartwarden/iqies-client — the typed iQIES adapter surface (M10-T07, spec §4.10 / D6). M10
// (`apps/backend/src/modules/10-hope`) consumes ONLY these three typed methods and never imports an HTTP
// client for iQIES; this package is the only place allowed to talk to iQIES. Phase 1 ships the typed
// contract + a deny-stub (`createUnboundIqiesAdapter`). There is NO live transport to bind: CMS states
// iQIES "does not support API interoperability" (HOPE Implementation FAQs Q30), so HOPE records reach CMS
// only when a person uploads the generated .zip in the iQIES portal (M10's `manual_iqies_upload` flow).
// This contract is kept for the day CMS ships an API. The deny-stub fails with a `retryable: false`
// {@link DegradedError} so the worker DLQs cleanly rather than blocking — capture (Tier 2) is unaffected.
import { DegradedError, type IqiesOperation } from "./errors";

/**
 * `submitBatch` request — the assembled envelope plus its recorded canonical hash.
 *
 * F-072 (#177) dropped a required `envelopeXml` field from this shape. It asked the CALLER for "the
 * rendered CMS HOPE submission XML" while the comment beside it — and this module's header — said the
 * TRANSPORT renders it. M10 cannot render it: the CMS HOPE submission XML schema is not in this
 * repository. A required field no caller can honestly fill is not a contract, so rendering now sits
 * wholly behind the adapter, where both this file and `envelope.ts` always said it belonged.
 *
 * `correlationId` is the IDEMPOTENCY KEY, not a log tag: `iqies-submit-worker` derives it
 * deterministically from the submission id, so a retry after an ambiguous failure is the same request.
 * That is what makes the worker's at-least-once delivery safe (`CHARTWARDEN_INTEGRATIONS_v0_1.md` §5).
 */
export interface SubmitBatchRequest {
  readonly envelope: HopeSubmissionEnvelope;
  /** SHA-256 of `assembleEnvelopeCanonical(envelope)` — the audit-replayable batch-membership digest. */
  readonly envelopeSha256: string;
  readonly correlationId: string;
}

/** `submitBatch` result — the iQIES-assigned batch id (recorded on `hope_submission.iqies_batch_id`). */
export interface SubmitBatchResult {
  readonly iqiesBatchId: string;
  readonly transmittedAt: string;
}

/** Per-assessment outcome inside an acceptance report (iQIES validation findings are redacted of PHI). */
export interface AcceptanceItemOutcome {
  readonly hopeAssessmentId: string;
  readonly outcome: "accepted" | "rejected";
  /** iQIES record id, assigned on acceptance; null for a rejected item. */
  readonly iqiesRecordId: string | null;
  /** Per-item validation findings (rule id + PHI-free message) — written to `hope_validation_finding`. */
  readonly findings: ReadonlyArray<{ readonly ruleId: string; readonly message: string }>;
}

/** `fetchAcceptanceReport` result — the per-item reconciliation outcomes for one submitted batch. */
export interface AcceptanceReport {
  readonly iqiesBatchId: string;
  readonly items: readonly AcceptanceItemOutcome[];
}

/** `submitCorrection` request — references the original by its accepted iQIES record id (D7). Same
 *  rendering ownership as {@link SubmitBatchRequest}: the transport renders, the caller does not. */
export interface SubmitCorrectionRequest {
  readonly envelope: HopeSubmissionEnvelope;
  readonly envelopeSha256: string;
  readonly originalIqiesRecordId: string;
  readonly correlationId: string;
}

/** `submitCorrection` result — the iQIES batch id for the Correction RFA submission. */
export interface SubmitCorrectionResult {
  readonly iqiesBatchId: string;
  readonly transmittedAt: string;
}

/**
 * The iQIES adapter (D6). The three methods M10's submission workers call; each either resolves with a
 * typed result or rejects with a {@link DegradedError} (never a raw `fetch` rejection, INT-009).
 */
export interface IqiesAdapter {
  submitBatch(request: SubmitBatchRequest): Promise<SubmitBatchResult>;
  fetchAcceptanceReport(iqiesBatchId: string): Promise<AcceptanceReport>;
  submitCorrection(request: SubmitCorrectionRequest): Promise<SubmitCorrectionResult>;
}

/** Stable placeholder correlation id for the unbound deny-stub (no clock/random in this pure package). */
const UNBOUND_CORRELATION_ID = "00000000-0000-4000-8000-000000000000";

/**
 * `createUnboundIqiesAdapter` — the Phase-1 deny-stub. Every method throws a `retryable: false`
 * {@link DegradedError} so the `iqies-submit-worker` DLQs the job immediately (no retry storm) while the
 * Tier-2 capture path stays fully functional (§5.6 / §7.10 — submission health never gates recording).
 * The live adapter replaces this at boot once the per-tenant iQIES submitter credentials are wired.
 */
export function createUnboundIqiesAdapter(): IqiesAdapter {
  const deny = (operation: IqiesOperation): never => {
    throw new DegradedError(
      "iqies",
      operation,
      false,
      "iQIES has no submission API; download the generated HOPE package and upload it in the iQIES portal.",
      UNBOUND_CORRELATION_ID,
    );
  };
  return {
    submitBatch: () => deny("submitBatch"),
    fetchAcceptanceReport: () => deny("fetchAcceptanceReport"),
    submitCorrection: () => deny("submitCorrection"),
  };
}
