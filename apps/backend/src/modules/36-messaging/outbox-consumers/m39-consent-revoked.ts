// apps/backend/src/modules/36-messaging/outbox-consumers/m39-consent-revoked.ts — M36's leg of the M39 §2.2.3
// revocation cascade (GAP-171). Subscribes to `m39.consent.revoked` and ACKs the cascade.
//
// WHAT M36 HAS TO DO. The spec's M36 handlers (bereavement-channel membership removal on
// `family_caregiver_access`, telehealth-channel close on `telehealth_consent`) need a mapping from a consent record
// to a channel member, and `channel_member` carries none (no consent or delegate column, and the revoked event
// names only the patient + consent type). A patientId-only sweep would soft-remove staff and unrelated members, so
// M36 deliberately takes no membership action from this event. What M36 DOES guarantee is the pull half:
// `canViewChannel` re-checks the live care-team roster on every read (GAP-104), so a revocation never leaves an
// open window behind a stale membership row. The ACK attests exactly that, and is what lets the cascade reach
// `completed` instead of exhausting its budget and raising a false CRITICAL alert. If a consent -> member link is
// ever added, the membership removal belongs HERE, before the ACK. A malformed payload THROWS (relay retry -> DLQ).
//
// TENANT from the envelope, never the payload. The ACK is idempotent; it runs on every delivery.
export const M36_CONSENT_REVOKED_CONSUMER = {
  eventName: "m39.consent.revoked",
  consumerName: "m36.m39-consent-revoked",
} as const;

export interface M36ConsentRevokedDeps {
  /** Records M36's `m36_messaging` ACK on M39's cascade (the composition root binds `recordCascadeAckForOrg`). */
  readonly ackCascade: (input: {
    readonly organizationId: string;
    readonly consentRecordId: string;
  }) => Promise<unknown>;
}

export function buildM36ConsentRevokedConsumer(deps: M36ConsentRevokedDeps) {
  return {
    consumerName: M36_CONSENT_REVOKED_CONSUMER.consumerName,
    consumerModule: "m36" as const,
    eventTypes: [M36_CONSENT_REVOKED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const consentRecordId = ((event.payload ?? {}) as Record<string, unknown>).consentRecordId;
      if (typeof consentRecordId !== "string" || consentRecordId.length === 0) {
        throw new Error(
          `${M36_CONSENT_REVOKED_CONSUMER.consumerName}: payload has no consentRecordId`,
        );
      }
      await deps.ackCascade({ organizationId: event.organizationId, consentRecordId });
    },
  };
}
