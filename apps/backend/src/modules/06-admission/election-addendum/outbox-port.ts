// apps/backend/src/modules/06-admission/election-addendum/outbox-port.ts — the transactional outbox port the
// addendum code publishes through. Structurally identical to `AdmissionWriteOutboxPort`
// (admission-route-service-db.ts), declared here so the addendum store does not import that file back (the
// route service imports the store — a type import the other way would be a dependency cycle).
export interface AddendumOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
