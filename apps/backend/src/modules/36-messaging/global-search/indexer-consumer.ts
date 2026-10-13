// WP 2.7b C2 (ADR-0058 decision 1) - the outbox consumer `m36.message-search-indexer`: a committed `m36.message.sent` /
// `edited` event (re)writes the message's blind-token rows, a `deleted` event removes them (the repair path; the primary
// removal is the same-transaction trigger of migration 1091).
//
// TENANT: from the envelope `event.organizationId`, NEVER the payload. The message id comes from the payload and is only ever
// looked up under that org (a foreign org's id finds nothing). A malformed payload THROWS (retry -> DLQ).
// IDEMPOTENT: `edited` is also emitted for attachment changes and an event can be redelivered; every handling replaces the
// message's rows (fresh dummies) or removes them. INERT: with either flag OFF the writer acknowledges without work.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type { IndexWriter } from "./index-writer";

export const M36_MESSAGE_SEARCH_INDEXER_CONSUMER = "m36.message-search-indexer" as const;

export const M36_MESSAGE_SEARCH_INDEXER_EVENT_TYPES = [
  "m36.message.sent",
  "m36.message.edited",
  "m36.message.deleted",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function messageIdOf(event: DispatchableOutboxEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const messageId = payload.messageId;
  if (typeof messageId !== "string" || !UUID.test(messageId)) {
    throw new Error(
      `${M36_MESSAGE_SEARCH_INDEXER_CONSUMER}: ${event.eventType} payload has no valid messageId`,
    );
  }
  return messageId;
}

export function buildM36MessageSearchIndexerConsumer(writer: IndexWriter): OutboxConsumerBinding {
  return {
    consumerName: M36_MESSAGE_SEARCH_INDEXER_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_MESSAGE_SEARCH_INDEXER_EVENT_TYPES,
    async handle(event) {
      const messageId = messageIdOf(event);
      if (event.eventType === "m36.message.deleted") {
        await writer.removeMessage(event.organizationId, messageId);
        return;
      }
      if (event.eventType !== "m36.message.sent" && event.eventType !== "m36.message.edited") {
        throw new Error(
          `${M36_MESSAGE_SEARCH_INDEXER_CONSUMER}: unexpected event ${event.eventType}`,
        );
      }
      await writer.indexMessage(event.organizationId, messageId);
    },
  };
}
