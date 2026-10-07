// @wardenx/dosespot — the Phase-1 deny-stub adapter (M12-T06, spec §4.10 / D5 / D11). Every method throws a
// `retryable: false` {@link DegradedError} so the `transmit-newrx` / `patient-sync` workers DLQ the job
// immediately (no retry storm) while the prescribing UI's draft path stays fully functional (D11 — drafts
// persist with `dosespot_send_state='queued'`; submission health never gates recording). The live adapter
// (`http.ts`, circuit-breaker-wrapped `fetch` with the per-tenant clinic credentials, §2.5) replaces this at
// boot once the per-tenant DoseSpot credentials are wired. Mirrors the iqies-client `createUnboundIqiesAdapter`.
import type {
  DoseSpotClient,
  DoseSpotEpcsSessionResponse,
  DoseSpotMedHistoryResponse,
  DoseSpotNewRxResponse,
  DoseSpotPatientResponse,
  DoseSpotPrescriberResponse,
  DoseSpotPrescriptionStatusResponse,
  DoseSpotRxBenefitResponse,
} from "./contract";
import { DegradedError, type DoseSpotOperation } from "./errors";

/** Stable placeholder correlation id for the unbound deny-stub (no clock/random in this pure package). */
const UNBOUND_CORRELATION_ID = "00000000-0000-4000-8000-000000000000";

const UNBOUND_MESSAGE =
  "E-prescribe is not enabled in this environment; the live DoseSpot adapter binds with the per-tenant clinic credentials.";

/**
 * `createUnboundDoseSpotClient` — the Phase-1 deny-stub. Every method rejects with a `retryable: false`
 * {@link DegradedError} so callers DLQ cleanly rather than spinning; the draft/queue path (D11) is unaffected.
 */
export function createUnboundDoseSpotClient(): DoseSpotClient {
  // Reject (never throw synchronously) so the failure surfaces through the Promise contract the live adapter
  // honours — the worker's `.catch` retry/DLQ branch is identical for the stub and the bound transport.
  const deny = (operation: DoseSpotOperation): DegradedError =>
    new DegradedError("dosespot", operation, false, UNBOUND_MESSAGE, UNBOUND_CORRELATION_ID);
  return {
    upsertPatient: (): Promise<DoseSpotPatientResponse> => Promise.reject(deny("upsertPatient")),
    enrollPrescriber: (): Promise<DoseSpotPrescriberResponse> =>
      Promise.reject(deny("enrollPrescriber")),
    revokePrescriber: (): Promise<void> => Promise.reject(deny("revokePrescriber")),
    transmitNewRx: (): Promise<DoseSpotNewRxResponse> => Promise.reject(deny("transmitNewRx")),
    lookupRxBenefit: (): Promise<DoseSpotRxBenefitResponse> =>
      Promise.reject(deny("lookupRxBenefit")),
    pullMedicationHistory: (): Promise<DoseSpotMedHistoryResponse> =>
      Promise.reject(deny("pullMedicationHistory")),
    respondToRefillRequest: (): Promise<void> => Promise.reject(deny("respondToRefillRequest")),
    getPrescriptionStatus: (): Promise<DoseSpotPrescriptionStatusResponse> =>
      Promise.reject(deny("getPrescriptionStatus")),
    initiateEpcsSigningSession: (): Promise<DoseSpotEpcsSessionResponse> =>
      Promise.reject(deny("initiateEpcsSigningSession")),
  };
}
