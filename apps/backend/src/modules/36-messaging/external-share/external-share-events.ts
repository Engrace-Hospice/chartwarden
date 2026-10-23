// M36 WP 6.6 (ADR-0096, PROPOSED) - trail-only outbox events of the external partner share. PHI-free by construction: ids and instants only; never
// a partner name, a BAA reference, a channel title, a token or a message. Published in the SAME transaction as the write. Catalog entries live in
// events-by-m36.ts.
import {
  EXTERNAL_SHARE_EVENT_CREATED,
  EXTERNAL_SHARE_EVENT_REISSUED,
  EXTERNAL_SHARE_EVENT_REVOKED,
} from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";

export const EXTERNAL_SHARE_AGGREGATE_KIND = "message_external_share";

export interface ExternalShareEventFacts {
  readonly kind: "created" | "revoked" | "reissued";
  readonly orgId: string;
  readonly shareId: string;
  readonly channelId: string;
  readonly actorUserId: string;
  readonly at: Date;
  /** created only. */
  readonly expiresAt?: Date;
}

export function externalShareEventPayload(facts: ExternalShareEventFacts): Record<string, unknown> {
  return {
    organizationId: facts.orgId,
    shareId: facts.shareId,
    channelId: facts.channelId,
    ...(facts.kind === "created"
      ? { createdBy: facts.actorUserId, expiresAt: facts.expiresAt?.toISOString() }
      : facts.kind === "reissued"
        ? { reissuedBy: facts.actorUserId }
        : { revokedBy: facts.actorUserId }),
    at: facts.at.toISOString(),
  };
}

export async function publishExternalShareEvent(
  outbox: HintOutboxPort,
  tx: unknown,
  facts: ExternalShareEventFacts,
): Promise<void> {
  await outbox.publish(tx, {
    eventName:
      facts.kind === "created"
        ? EXTERNAL_SHARE_EVENT_CREATED
        : facts.kind === "reissued"
          ? EXTERNAL_SHARE_EVENT_REISSUED
          : EXTERNAL_SHARE_EVENT_REVOKED,
    organizationId: facts.orgId,
    aggregateKind: EXTERNAL_SHARE_AGGREGATE_KIND,
    aggregateId: facts.shareId,
    payload: externalShareEventPayload(facts),
  });
}
