// apps/backend/src/modules/36-messaging/outbox-consumers/message-hints.ts — ADR-0054 decision 8 / addendum A1+A4:
// turns a committed `m36.message.sent|edited|deleted` outbox event into one PHI-free realtime hint, delivered to the
// rooms of the people who can currently read the channel.
//
// WHO: the channel's CURRENT active members (`channel_member.removed_at IS NULL`), one `user:<org>:<id>` room each; an
// announcement channel is org-wide, so it goes to `org:<id>`. Targeting user rooms (not a persistent per-channel room)
// means a member removed a moment ago is simply not addressed, with no stale-room window to close. The hint itself
// carries ids only; the REST read it triggers is where requirePermission / ABAC / Part 2 gating / read-audit apply.
//
// WHERE: this runs in the worker (outbox dispatcher) while Socket.IO lives in the api role, so `emitToRooms` is the
// Valkey emitter port, never a Server. It is optional only so the consumer is bound (and the catalog's declared
// consumer satisfied) before the transport is switched on; with no port the event is consumed and nothing is sent.
//
// TENANT: from the envelope `event.organizationId`, NEVER the payload. A malformed payload THROWS (retry -> DLQ).
// Idempotent: a redelivery builds the identical hint (same cursor) and clients dedupe by cursor.
import {
  type RealtimeHint,
  buildMessageHint,
  isMessageHintOutboxEvent,
  orgRoom,
  userRoom,
} from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_MESSAGE_HINT_CONSUMER = "m36.message-hints" as const;

export const M36_MESSAGE_HINT_EVENT_TYPES = [
  "m36.message.sent",
  "m36.message.edited",
  "m36.message.deleted",
] as const;

export type HintAudience = { readonly orgWide: true } | { readonly userIds: readonly string[] };

export interface MessageHintDeps {
  /** Who can currently read the channel (M36 DB adapter). */
  readonly audience: (orgId: string, channelId: string) => Promise<HintAudience>;
  /** Deliver a hint to rooms on every api node (Valkey emitter). Absent while realtime is not wired. */
  readonly emitToRooms?: (rooms: readonly string[], hint: RealtimeHint) => Promise<void>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_MESSAGE_HINT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

async function handleEvent(event: DispatchableOutboxEvent, deps: MessageHintDeps): Promise<void> {
  if (!isMessageHintOutboxEvent(event.eventType)) {
    throw new Error(`${M36_MESSAGE_HINT_CONSUMER}: unexpected event ${event.eventType}`);
  }
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const channelId = requireString(p, "channelId", event.eventType);
  const messageId = requireString(p, "messageId", event.eventType);
  const at = requireString(p, "at", event.eventType);
  // WP 2.2: present only for a thread reply (an id). A malformed value is ignored, not fatal: it is an optimisation.
  const parentMessageId =
    typeof p.parentMessageId === "string" && p.parentMessageId ? p.parentMessageId : undefined;
  if (!deps.emitToRooms) return;
  const audience = await deps.audience(event.organizationId, channelId);
  const rooms =
    "orgWide" in audience
      ? [orgRoom(event.organizationId)]
      : audience.userIds.map((id) => userRoom(event.organizationId, id));
  if (rooms.length === 0) return;
  await deps.emitToRooms(
    rooms,
    buildMessageHint(event.eventType, { channelId, messageId, at, parentMessageId }),
  );
}

export function buildM36MessageHintConsumer(deps: MessageHintDeps): OutboxConsumerBinding {
  return {
    consumerName: M36_MESSAGE_HINT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_MESSAGE_HINT_EVENT_TYPES,
    handle: (event) => handleEvent(event, deps),
  };
}
