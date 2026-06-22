// @wardenx/messaging — Socket.IO event contract + sanitized payload shapes (M36-T08, spec §4.3).
//
// The server→client and client→server event names + their payload TYPES. The §4.3 invariant the
// types encode: NO event body carries decrypted PHI to a user not entitled to it — the server
// computes the per-user payload before emit, so `message.new.bodyPreview` is OPTIONAL (empty for an
// unentitled-but-room-joined recipient; the client decrypts-and-fetches via REST on click) and
// `alert.new.summary` is the §4.7 sanitizer's PHI-free output (parity with out-of-band channels).
// Every server→client event carries a `correlationId`. This module is types + name constants only —
// the Socket.IO emit happens in the wiring layer (M1 infra); the package imports no socket.io.

import type {
  AlertCategory,
  AlertSeverity,
  NotificationChannel,
  PresenceStatus,
} from "../interfaces/kinds";

/** The server→client event names (§4.3). */
export const MESSAGING_SERVER_EVENTS = {
  messageNew: "message.new",
  messageEdited: "message.edited",
  messageDeleted: "message.deleted",
  messageRead: "message.read",
  channelMemberAdded: "channel.member_added",
  channelMemberRemoved: "channel.member_removed",
  channelArchived: "channel.archived",
  presenceUserActive: "presence.user_active",
  alertNew: "alert.new",
  alertDelivered: "alert.delivered",
  systemStatusChanged: "system.status_changed",
  permissionsChanged: "permissions.changed",
} as const;

/** The client→server event names (§4.3) — a deliberately tiny write surface (most writes go via REST). */
export const MESSAGING_CLIENT_EVENTS = {
  typingStart: "typing.start",
  typingStop: "typing.stop",
  presencePing: "presence.ping",
} as const;

/** Common envelope: every server→client event carries the originating `correlationId` (§4.3). */
export interface ServerEventEnvelope {
  readonly correlationId: string;
}

/** `message.new` — `bodyPreview` is OPTIONAL/empty for an unentitled-but-room-joined recipient (§4.3). */
export interface MessageNewEvent extends ServerEventEnvelope {
  readonly messageId: string;
  readonly channelId: string;
  readonly channelKind: string;
  readonly authorUserId: string;
  readonly createdAt: string;
  /** PHI-bearing preview — present only when the recipient is entitled; otherwise omitted (§4.3). */
  readonly bodyPreview?: string;
  readonly hasAttachments: boolean;
}

export interface MessageEditedEvent extends ServerEventEnvelope {
  readonly messageId: string;
  readonly editedAt: string;
}
export interface MessageDeletedEvent extends ServerEventEnvelope {
  readonly messageId: string;
  readonly deletedAt: string;
}
export interface MessageReadEvent extends ServerEventEnvelope {
  readonly messageId: string;
  readonly readerUserId: string;
  readonly readAt: string;
}
export interface ChannelMemberEvent extends ServerEventEnvelope {
  readonly channelId: string;
  readonly userId: string;
  readonly source: string;
}
export interface ChannelArchivedEvent extends ServerEventEnvelope {
  readonly channelId: string;
  readonly archivedAt: string;
}
export interface PresenceUserActiveEvent extends ServerEventEnvelope {
  readonly userId: string;
  readonly lastSeen: string;
  readonly status: PresenceStatus;
}

/** `alert.new` — `summary` is the §4.7 sanitizer output (PHI-free by construction, §4.3). */
export interface AlertNewEvent extends ServerEventEnvelope {
  readonly alertId: string;
  readonly eventType: string;
  readonly category: AlertCategory;
  readonly severity: AlertSeverity;
  /** Sanitizer-produced; carries no PHI (parity with out-of-band channels, §4.3 / §4.7). */
  readonly summary: string;
  readonly deepLink: string;
}
export interface AlertDeliveredEvent extends ServerEventEnvelope {
  readonly alertId: string;
  readonly channel: NotificationChannel;
  readonly vendorMessageId?: string;
}
