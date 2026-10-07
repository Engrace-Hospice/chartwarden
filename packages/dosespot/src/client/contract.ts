// @wardenx/dosespot — the typed DoseSpot adapter surface (M12-T06, spec §2.5 / §4.10 / D5). M12
// (`apps/backend/src/modules/12-dosespot`) and the `transmit-newrx` / `patient-sync` workers consume ONLY
// these eight typed methods and never import an HTTP client for DoseSpot; `packages/dosespot/src/client/` is
// the only place allowed to construct a request to a DoseSpot URL (the dependency-cruiser vendor-adapter rule,
// architecture §25.15 check 2 / §4.10). Phase 1 ships the typed contract + a deny-stub
// (`createUnboundDoseSpotClient`); the live transport (`http.ts`, the circuit-breaker-wrapped `fetch` with the
// per-tenant clinic credentials from §2.5 D5) binds at boot. Every payload/response shape is PHI-light and
// adapter-internal (mirrors the iqies-client envelope precedent) — the DTOs never cross a seam in this form.

/** §2.6 D4 — the DoseSpot patient upsert payload (a demographic projection of the M5 patient snapshot; the
 * upstream API upserts keyed on `wardenxPatientId`, so repeated calls are no-ops, §2.6). */
export interface DoseSpotPatientPayload {
  readonly wardenxPatientId: string;
  /** The DoseSpot-side patient id when one is already recorded (`dosespot_patient_sync`): the adapter then
   * EDITS that patient rather than creating a duplicate. Absent ⇒ the adapter creates. */
  readonly existingDosespotPatientId?: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly gender: string;
  readonly address: {
    readonly line1: string;
    readonly line2?: string;
    readonly city: string;
    readonly state: string;
    readonly postalCode: string;
  };
  readonly phone?: string;
  readonly active: boolean;
}

/** §2.6 — the DoseSpot patient upsert response (the DoseSpot-side patient id, recorded for the sync). */
export interface DoseSpotPatientResponse {
  readonly dosespotPatientId: string;
  readonly upsertedAt: string;
}

/** §2.5 D6 — the prescriber-roster enrollment payload (NPI + DEA + EPCS IAL2 status capture). */
export interface DoseSpotPrescriberPayload {
  readonly membershipId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly npi: string;
  readonly deaNumber?: string;
  readonly epcsRequested: boolean;
}

/** §2.5 D6 — the prescriber enrollment response (the DoseSpot-side prescriber id + EPCS enrollment state). */
export interface DoseSpotPrescriberResponse {
  readonly dosespotPrescriberId: string;
  readonly epcsEnrollmentStarted: boolean;
}

/** §4.10 / §5.1 — the NewRx transmission payload. The structured sig (never the raw free-text) + the resolved
 * pharmacy MDM identity; the idempotency key is carried out-of-band on the `Idempotency-Key` header (D8). */
export interface DoseSpotNewRxPayload {
  readonly medicationOrderId: string;
  readonly dosespotPatientId: string;
  readonly dosespotPrescriberId: string;
  readonly rxnormRxcui: string;
  readonly ndc?: string;
  readonly strength: string;
  readonly sigStructured: Record<string, unknown>;
  readonly quantity: number;
  readonly daysSupply: number;
  readonly refillsAuthorized: number;
  /** The DoseSpot pharmacy id when M40 holds one. Absent ⇒ the prescription routes to the patient's preferred
   * pharmacy on the DoseSpot side (a `PharmacySelect` status on the poll means none was set). */
  readonly pharmacyDosespotId?: string;
  readonly drugName?: string;
  readonly deaSchedule?: string;
}

/** §4.10 — the NewRx response (the DoseSpot-side prescription id recorded on the transmission row). */
export interface DoseSpotNewRxResponse {
  readonly dosespotPrescriptionId: string;
  readonly transmittedAt: string;
}

/** §4.8 `transmission_timeout_sweep` — the observed DoseSpot-side status of one prescription. `phase` is OUR
 * normalisation of DoseSpot's status enum: `sent` (eRxSent/FaxSent/PharmacyVerified/EpcsSigned-then-sent),
 * `pending` (still in Entered/Sending/ReadyToSign/…), `failed` (Error/EpcsError/Retracted/Deleted) or
 * `needs_pharmacy` (PharmacySelect). `rawStatus` is the vendor value, kept for the audit/alert text only. */
export interface DoseSpotPrescriptionStatusResponse {
  readonly dosespotPrescriptionId: string;
  readonly phase: "sent" | "pending" | "failed" | "needs_pharmacy";
  readonly rawStatus: string;
  readonly observedAt: string;
}

/** §2.9 — the RxBenefit (formulary/coverage) lookup payload. */
export interface DoseSpotRxBenefitPayload {
  readonly dosespotPatientId: string;
  readonly rxnormRxcui: string;
}

/** §2.9 — the RxBenefit lookup response (PHI-light coverage summary; cached by the seam). */
export interface DoseSpotRxBenefitResponse {
  readonly covered: boolean;
  readonly copayTier?: string;
  readonly priorAuthRequired: boolean;
  readonly lookedUpAt: string;
}

/** §2.8 D10 — the MedicationHistory pull payload (on admission activate + recert/F2F windows). */
export interface DoseSpotMedHistoryPayload {
  readonly dosespotPatientId: string;
  readonly sinceDate?: string;
}

/** §2.8 — one historical medication record (persisted as `medication_history_record`, never auto-linked). */
export interface DoseSpotMedHistoryItem {
  /** `null` when the pharmacy's NDC did not match an RxNorm code (M12 §5.5 edge: the RN selects one manually). */
  readonly rxnormRxcui: string | null;
  readonly drugName: string;
  readonly lastFillDate: string | null;
  readonly sourcePharmacy: string | null;
  // §2.8 also lists these per-row fields (ndc, strength, dose_form, sig_text, prescribed_at, fill_dates[],
  // pharmacy_ncpdp, prescriber_npi). They are OPTIONAL here because the wire mapping from the real DoseSpot
  // MedicationHistory response is pending vendor documentation (F-230): the live transport fills whichever
  // the vendor actually returns; nothing is defaulted or invented when absent.
  readonly ndc?: string | null;
  readonly strength?: string | null;
  readonly doseForm?: string | null;
  readonly sigText?: string | null;
  readonly prescribedAt?: string | null;
  readonly fillDates?: readonly string[];
  readonly pharmacyNcpdp?: string | null;
  readonly prescriberNpi?: string | null;
}

/** §2.8 — the MedicationHistory pull response. */
export interface DoseSpotMedHistoryResponse {
  readonly items: readonly DoseSpotMedHistoryItem[];
  readonly pulledAt: string;
}

/** §2.7 D9 — the refill-response payload (the prescriber's approve/deny decision sent back to DoseSpot). */
export interface DoseSpotRefillResponsePayload {
  readonly decision: "approved" | "denied";
  /** Present on approve: the newly-minted `medication_order`'s DoseSpot prescription identity. */
  readonly newDosespotPrescriptionId?: string;
  readonly denialReasonCode?: string;
}

/** §2.4 §1311.116 — the EPCS signing-session initiation response (Phase-1 deny-stubbed unless certified, D18). */
export interface DoseSpotEpcsSessionResponse {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly requiredFactor: "totp" | "passkey" | "push_confirm";
}

/**
 * The DoseSpot adapter (D5). The eight methods M12's services + workers call; each either resolves with a
 * typed result or rejects with a {@link DegradedError} from `./errors` (never a raw `fetch` rejection,
 * INT-009). `orgId` selects the per-tenant clinic credentials + circuit breaker (§2.5).
 */
export interface DoseSpotClient {
  upsertPatient(
    orgId: string,
    payload: DoseSpotPatientPayload,
    idempotencyKey: string,
  ): Promise<DoseSpotPatientResponse>;
  enrollPrescriber(
    orgId: string,
    payload: DoseSpotPrescriberPayload,
  ): Promise<DoseSpotPrescriberResponse>;
  revokePrescriber(orgId: string, dosespotPrescriberId: string): Promise<void>;
  transmitNewRx(
    orgId: string,
    payload: DoseSpotNewRxPayload,
    idempotencyKey: string,
  ): Promise<DoseSpotNewRxResponse>;
  lookupRxBenefit(
    orgId: string,
    payload: DoseSpotRxBenefitPayload,
  ): Promise<DoseSpotRxBenefitResponse>;
  pullMedicationHistory(
    orgId: string,
    payload: DoseSpotMedHistoryPayload,
  ): Promise<DoseSpotMedHistoryResponse>;
  respondToRefillRequest(
    orgId: string,
    refillRequestId: string,
    payload: DoseSpotRefillResponsePayload,
  ): Promise<void>;
  /** §4.8 — poll one prescription's status (the `transmission_timeout_sweep` ack/nack source). */
  getPrescriptionStatus(
    orgId: string,
    dosespotPatientId: string,
    dosespotPrescriptionId: string,
  ): Promise<DoseSpotPrescriptionStatusResponse>;
  /** EPCS — architecture ships Phase 1 but prod transmission is feature-flag-OFF per D18 (deny-stubbed). */
  initiateEpcsSigningSession(
    orgId: string,
    prescriberId: string,
    medicationOrderId: string,
  ): Promise<DoseSpotEpcsSessionResponse>;
}

/**
 * §2.5 D5 — the per-tenant DoseSpot clinic credentials, loaded from the secrets manager at boot (Security
 * Hardening §4.5), keyed by `organization_id` (architecture §8(4)). No plaintext on disk in production; the
 * boot sequence fails fast if a registered tenant lacks credentials. `clinicKey` + `webhookSecret` are never
 * logged. `epcsCertified` mirrors `organization.epcs_certification_status` cached for the adapter quick-check.
 */
export interface DoseSpotCredentials {
  readonly clinicId: string;
  readonly clinicKey: string;
  readonly webhookSecret: string;
  readonly baseUrl: string;
  readonly epcsCertified: boolean;
}
