// apps/backend/src/modules/39-consent/consumers.ts — M39-T08 outbox subscriptions (spec §4.6) +
// the cross-module side-effect bridges, as PURE decision functions (the worker performs the IO).
//
//   • m5-privacy-bridge — M39's signed/revoked events drive M5's privacy_flag_snapshot recompute
//     (M5 D10). M39 owns no edge into M5: it produces the minimal `{patientId, signals}` shape M5's
//     `applyConsentChanged` consumes (the integration test wires M39's output → M5's consumer).
//   • m5.patient.merged — re-point consent_record.patient_id to the survivor + emit
//     `m39.consent.repointed` (the only consent event a merge produces).
//   • m5.patient.deceased — D13: active non-survives-death consents transition to `expired`.
//   • m22.document.rendered — stamp `consent_document_link` from the M22 back-ref (D15).
import { type ConsentTypeKey, CONSENT_TYPE_STRUCTURE } from "@wardenx/consent";

/** The privacy categories M5's snapshot recompute keys on (mirror of M5's `PrivacyFlag`, kept local
 *  so M39 stays edge-free — the test asserts the shapes line up). */
export type ConsentPrivacyFlag = "sud" | "hiv" | "mental_health" | "genetic";

/** The `{flag, active}` signal shape M5's `applyConsentChanged` consumes. */
export interface ConsentPrivacySignal {
  readonly flag: ConsentPrivacyFlag;
  readonly active: boolean;
}

/** The payload M39 hands M5's recompute consumer (M5's `M39ConsentChangedPayload`). */
export interface ConsentChangedForPrivacy {
  readonly organizationId: string;
  readonly patientId: string;
  readonly signals: readonly ConsentPrivacySignal[];
}

/** The consent types whose presence/absence M5 projects into a privacy flag. M39 authoritatively
 *  owns SUD (42 CFR Part 2); HIV/MH/genetic are M5-delegated (§4.3.1) so M39 emits no signal for them. */
const TYPE_TO_PRIVACY_FLAG: Partial<Record<ConsentTypeKey, ConsentPrivacyFlag>> = {
  "42_cfr_part_2_release": "sud",
};

/**
 * Map a signed/revoked consent change into the privacy signal M5 recomputes from (§4.6 / M5 D10). A
 * `42_cfr_part_2_release` sign makes the SUD flag `active` (restriction lifted for the named
 * recipients); a revoke makes it inactive (SUD content re-restricted). Non-mapped types yield no
 * signal (M5's snapshot is unchanged for them). Returns null when the type drives no M5 flag.
 */
export function consentChangeToPrivacyPayload(event: {
  organizationId: string;
  patientId: string;
  typeKey: ConsentTypeKey;
  action: "signed" | "revoked" | "expired";
}): ConsentChangedForPrivacy | null {
  const flag = TYPE_TO_PRIVACY_FLAG[event.typeKey];
  if (!flag) return null;
  return {
    organizationId: event.organizationId,
    patientId: event.patientId,
    signals: [{ flag, active: event.action === "signed" }],
  };
}

/** m5.patient.merged → re-point this org's consent records to the survivor + emit repointed. */
export function decidePatientMergeRepoint(event: {
  organizationId: string;
  patientId: string;
  mergedIntoId: string;
}): { repointTo: string; emit: "m39.consent.repointed" } {
  return { repointTo: event.mergedIntoId, emit: "m39.consent.repointed" };
}

/** m5.patient.deceased (D13) → which of the patient's active consents must transition to `expired`.
 *  A consent survives death only when its type is survives-death-eligible AND `survives_death=true`,
 *  or it is the post-mortem bereavement consent. Returns the ids to expire. */
export function decideDeceasedConsentExpiry(
  consents: readonly { id: string; typeKey: ConsentTypeKey; status: string; survivesDeath: boolean }[],
): string[] {
  return consents
    .filter((c) => c.status === "active")
    .filter((c) => {
      const s = CONSENT_TYPE_STRUCTURE[c.typeKey];
      if (s.isPostMortemEligible) return false; // bereavement consent survives
      if (s.survivesDeathEligible && c.survivesDeath) return false; // explicitly survives
      return true; // terminates on death
    })
    .map((c) => c.id);
}

/** m22.document.rendered (consent_record template) → the consent_document_link stamp (D15). */
export function decideConsentDocumentLink(event: {
  consentRecordId: string;
  documentId: string;
  documentVersionId: string;
  templateVersion: string;
}): {
  consentRecordId: string;
  documentId: string;
  documentVersionId: string;
  templateVersion: string;
} {
  return {
    consentRecordId: event.consentRecordId,
    documentId: event.documentId,
    documentVersionId: event.documentVersionId,
    templateVersion: event.templateVersion,
  };
}
