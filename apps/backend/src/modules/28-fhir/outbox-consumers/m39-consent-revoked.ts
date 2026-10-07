// apps/backend/src/modules/28-fhir/outbox-consumers/m39-consent-revoked.ts — M28's leg of the M39 §2.2.3
// revocation cascade (GAP-171). Subscribes to `m39.consent.revoked` and ACKs the cascade.
//
// WHAT M28 HAS TO DO. The spec's "FHIR client re-bind for next query" is satisfied by construction: M28 holds no
// per-patient or per-recipient consent state — `fhir_client` / `fhir_client_session` are org-level API
// credentials, not consent-scoped grants — and every FHIR read consults the ConsentEvaluator seam FRESH
// (fail-closed; the F-035/F-115 finding that M28 "never subscribes" was about exactly this: a pull, not a
// cache). So there is nothing for a push to rewrite. The subscription still exists because the cascade ledger
// needs M28 to say "done": the ACK attests that the pull path is live and no cached consent decision exists,
// and it is what lets a cascade reach `completed` instead of burning its retry budget and raising a false
// CRITICAL `revoked_cascade_failed` alert. A malformed payload THROWS (relay retry -> DLQ), never a silent ACK.
//
// TENANT from the envelope, never the payload. The ACK is idempotent; it runs on every delivery.
export const M28_CONSENT_REVOKED_CONSUMER = {
  eventName: "m39.consent.revoked",
  consumerName: "m28.m39-consent-revoked",
} as const;

export interface M28ConsentRevokedDeps {
  /** Records M28's `m28_fhir` ACK on M39's cascade (the composition root binds `recordCascadeAckForOrg`). */
  readonly ackCascade: (input: {
    readonly organizationId: string;
    readonly consentRecordId: string;
  }) => Promise<unknown>;
}

export function buildM28ConsentRevokedConsumer(deps: M28ConsentRevokedDeps) {
  return {
    consumerName: M28_CONSENT_REVOKED_CONSUMER.consumerName,
    consumerModule: "m28" as const,
    eventTypes: [M28_CONSENT_REVOKED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const consentRecordId = ((event.payload ?? {}) as Record<string, unknown>).consentRecordId;
      if (typeof consentRecordId !== "string" || consentRecordId.length === 0) {
        throw new Error(
          `${M28_CONSENT_REVOKED_CONSUMER.consumerName}: payload has no consentRecordId`,
        );
      }
      await deps.ackCascade({ organizationId: event.organizationId, consentRecordId });
    },
  };
}
