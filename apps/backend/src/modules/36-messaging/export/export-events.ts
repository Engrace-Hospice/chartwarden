// M36 WP 5.7 (ADR-0089, PROPOSED) - the transactional outbox events of the restricted messaging export. PHI-free by construction: the job id,
// the organisation and actor ids and instants only; never the justification, a decision note, a scope id, a name or a message. Published in
// the SAME transaction as the write (the caller passes its `tx`), so an event never announces a write that rolled back. Catalog entries live
// in events-by-m36.ts. `ready` and `expired` are published by the builder / sweep side with the same helper.
import {
  EXPORT_EVENT_APPROVED,
  EXPORT_EVENT_DOWNLOADED,
  EXPORT_EVENT_EXPIRED,
  EXPORT_EVENT_READY,
  EXPORT_EVENT_REJECTED,
  EXPORT_EVENT_REQUESTED,
} from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";

export const M36_EXPORT_EVENTS = {
  requested: EXPORT_EVENT_REQUESTED,
  approved: EXPORT_EVENT_APPROVED,
  rejected: EXPORT_EVENT_REJECTED,
  ready: EXPORT_EVENT_READY,
  downloaded: EXPORT_EVENT_DOWNLOADED,
  expired: EXPORT_EVENT_EXPIRED,
} as const;

export const EXPORT_AGGREGATE_KIND = "message_export_job";

export type ExportEventFacts =
  | {
      readonly kind: "requested";
      readonly orgId: string;
      readonly jobId: string;
      readonly requestedBy: string;
      readonly at: Date;
    }
  | {
      readonly kind: "approved" | "rejected";
      readonly orgId: string;
      readonly jobId: string;
      readonly requestedBy: string;
      readonly decidedBy: string;
      readonly at: Date;
    }
  | {
      readonly kind: "ready";
      readonly orgId: string;
      readonly jobId: string;
      readonly requestedBy: string;
      readonly at: Date;
      readonly expiresAt: Date;
    }
  | {
      readonly kind: "downloaded";
      readonly orgId: string;
      readonly jobId: string;
      readonly downloadedBy: string;
      readonly at: Date;
    }
  | { readonly kind: "expired"; readonly orgId: string; readonly jobId: string; readonly at: Date };

/** The payload: everything but `kind`, instants as ISO strings, `organizationId` named as the catalog expects. */
export function exportEventPayload(facts: ExportEventFacts): Record<string, unknown> {
  const { kind: _kind, orgId, ...rest } = facts;
  const entries = Object.entries(rest).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ]);
  return { organizationId: orgId, ...Object.fromEntries(entries) };
}

export async function publishExportEvent(
  outbox: HintOutboxPort,
  tx: unknown,
  facts: ExportEventFacts,
): Promise<void> {
  await outbox.publish(tx, {
    eventName: M36_EXPORT_EVENTS[facts.kind],
    organizationId: facts.orgId,
    aggregateKind: EXPORT_AGGREGATE_KIND,
    aggregateId: facts.jobId,
    payload: exportEventPayload(facts),
  });
}
