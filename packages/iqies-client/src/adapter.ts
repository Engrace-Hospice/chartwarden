// @wardenx/iqies-client — the typed iQIES adapter surface (M10-T07, spec §4.10 / D6). M10
// (`apps/backend/src/modules/10-hope`) consumes ONLY these three typed methods and never imports an HTTP
// client for iQIES; this package is the only place allowed to talk to iQIES. Phase 1 ships the typed
// contract + a deny-stub (`createUnboundIqiesAdapter`) — the live transport (CMS HOPE submission XML,
// per-MAC submitter auth, sandbox/prod selection, circuit-breaker-wrapped `fetch`) binds with the
// per-tenant credential wiring from M34's secret store. The deny-stub fails with a `retryable: false`
// {@link DegradedError} so the worker DLQs cleanly rather than blocking — capture (Tier 2) is unaffected.
import { DegradedError, type IqiesOperation } from "./errors";
import type { HopeSubmissionEnvelope } from "./envelope";

/** `submitBatch` request — the assembled envelope plus the rendered wire payload + its recorded hash. */
export interface SubmitBatchRequest {
  readonly envelope: HopeSubmissionEnvelope;
  /** The rendered CMS HOPE submission XML (transport renders; recorded encrypted in MinIO). */
  readonly envelopeXml: string;
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

/** `submitCorrection` request — references the original by its accepted iQIES record id (D7). */
export interface SubmitCorrectionRequest {
  readonly envelope: HopeSubmissionEnvelope;
  readonly envelopeXml: string;
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
      "iQIES submission is not enabled in this environment; the live adapter binds with the per-tenant submitter credentials.",
      UNBOUND_CORRELATION_ID,
    );
  };
  return {
    submitBatch: () => deny("submitBatch"),
    fetchAcceptanceReport: () => deny("fetchAcceptanceReport"),
    submitCorrection: () => deny("submitCorrection"),
  };
}
