// @wardenx/reporting — consumed-seam view of M22 (Documents). PRESENT producer (§4.4).
//
// M33 reads document-throughput aggregates AND subscribes to the `m22.document.created` outbox event
// (to invalidate cached document-volume tiles). Bound to the live M22 `DocumentReader.aggregateForOrg`
// via `getSeam` at boot (P2C); the outbox subscription wires in P2C. Aggregate only (D6).
export interface ReportingDocumentConsumer {
  /** M22 `DocumentReader.aggregateForOrg` — document volume by template-kind over a window. */
  documentVolumeByKind(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
}

/** Payload M33's `m22.document.created` subscriber receives (drives the document-volume cache invalidation). */
export interface M22DocumentCreatedEvent {
  readonly documentId: string;
  readonly organizationId: string;
  readonly templateKey: string;
}
