// @wardenx/messaging — the realtime HINT contract (ADR-0054 decision 2, supersedes the per-user payloads above for
// message traffic). A hint is `{ kind, cursor, ids }`: it says "something changed, go and read it", never what.
// It carries no body, preview, name, patient identifier or diagnosis, so delivering it to a socket that should not
// have it leaks nothing a REST call (with requirePermission / ABAC / read-audit) would not also gate.
// The database cursor remains the only record: a dropped or duplicated hint costs latency, never correctness.
import { MESSAGING_SERVER_EVENTS } from "./events";

/** The single Socket.IO event name every hint travels on. */
export const REALTIME_HINT_EVENT = "hint" as const;

export type MessageHintKind =
  | typeof MESSAGING_SERVER_EVENTS.messageNew
  | typeof MESSAGING_SERVER_EVENTS.messageEdited
  | typeof MESSAGING_SERVER_EVENTS.messageDeleted
  | typeof MESSAGING_SERVER_EVENTS.messageAnnotated;

export interface RealtimeHint {
  readonly kind: MessageHintKind;
  /** Opaque dedupe / catch-up token; clients dedupe by it and reconcile over REST. */
  readonly cursor: string;
  /** `parentMessageId` is set when the change is to a thread reply, so a client can refresh that thread. */
  readonly ids: {
    readonly channelId: string;
    readonly messageId: string;
    readonly parentMessageId?: string;
  };
}

const KIND_BY_OUTBOX_EVENT = {
  "m36.message.sent": MESSAGING_SERVER_EVENTS.messageNew,
  "m36.message.edited": MESSAGING_SERVER_EVENTS.messageEdited,
  "m36.message.deleted": MESSAGING_SERVER_EVENTS.messageDeleted,
  "m36.message.annotated": MESSAGING_SERVER_EVENTS.messageAnnotated,
} as const;

export type MessageHintOutboxEvent = keyof typeof KIND_BY_OUTBOX_EVENT;

export function isMessageHintOutboxEvent(eventType: string): eventType is MessageHintOutboxEvent {
  return eventType in KIND_BY_OUTBOX_EVENT;
}

/**
 * Build the hint for a committed message change. `at` is the instant carried by the outbox event; the cursor
 * is `<kind>|<at>|<messageId>` base64url, so a redelivered event yields the identical cursor (client dedupe).
 */
export function buildMessageHint(
  eventType: MessageHintOutboxEvent,
  facts: {
    readonly channelId: string;
    readonly messageId: string;
    readonly at: string;
    readonly parentMessageId?: string;
  },
): RealtimeHint {
  const kind = KIND_BY_OUTBOX_EVENT[eventType];
  return {
    kind,
    cursor: Buffer.from(`${kind}|${facts.at}|${facts.messageId}`, "utf8").toString("base64url"),
    ids: {
      channelId: facts.channelId,
      messageId: facts.messageId,
      ...(facts.parentMessageId ? { parentMessageId: facts.parentMessageId } : {}),
    },
  };
}
