import type {
  ClinicalLinkKind,
  MessageReactionSummary,
  PollView,
  RichBody,
} from "@chartwarden/types";

export type ChannelKind =
  | "care_team"
  | "discipline"
  | "location"
  | "on_call"
  | "dm"
  | "announcement"
  | "bereavement"
  | "family";

export interface ChannelLastMessage {
  messageId: string;
  preview: string;
  createdAt: string;
  authorDisplayName: string | null;
}

export interface ChannelSummary {
  channelId: string;
  kind: ChannelKind;
  title: string | null;
  subjectId: string | null;
  archivedAt: string | null;
  unreadCount: number;
  mentionCount: number;
  participantRoles: string[];
  lastActivityAt: string;
  lastMessage: ChannelLastMessage | null;
}

export interface Message {
  messageId: string;
  channelId: string;
  authorUserId: string | null;
  authorDisplayName: string | null;
  body: string;
  bodyKind: "plain" | "markdown" | "system" | "rich";
  /** WP 2.1: for `bodyKind: "rich"`, `body` is the plain-text projection and this is the document. */
  bodyDoc?: RichBody;
  /** WP 2.1: a stored rich body that cannot be read back; show a distinct placeholder, not 'deleted'. */
  bodyUnreadable?: boolean;
  createdAt: string;
  /** WP 1.3: when a live message was last edited; absent/null = never edited (or deleted). */
  editedAt?: string | null;
  parentMessageId: string | null;
  /** WP 4.1: present only for a non-routine message ("Urgent clinical"). A display marker, never a delivery state. */
  urgency?: "important" | "urgent";
  /** WP 2.2: live direct replies (deleted ones excluded) and the newest one's time. Absent on older payloads. */
  replyCount?: number;
  lastReplyAt?: string | null;
  references: MessageReference[];
  /** WP 2.4: non-clinical reactions (counts + whether the viewer reacted). NEVER a sign-off. */
  reactions?: MessageReactionSummary[];
  /** WP 2.4: pinned in its channel. */
  pinned?: boolean;
  /** WP 2.10: the poll on this message (non-clinical; counts + the viewer's own vote). */
  poll?: PollView;
  /** WP 1.5: absent on older payloads. `scanning` is only ever listed to the uploader. */
  attachments?: MessageAttachment[];
  /** WP 3.2: ids of the clinical links in a rich body, to match a `clinicalLink` node to its link_id. No status or label. */
  clinicalLinks?: { link_id: string; kind: ClinicalLinkKind; entity_id: string }[];
  /** Files this viewer cannot see yet (scanning for others, or withheld): a bare count, no detail. */
  hiddenAttachmentCount?: number;
  /** WP 5.6 (ADR-0055 item 7): an approved redaction masks this message; the body is empty and this is when it happened. */
  redactedAt?: string;
  /** WP 5.6 (ADR-0086): under an active legal hold. The server sends it only to a holder of `messaging.retention.manage`. */
  legalHold?: true;
}

export interface MessageAttachment {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  availability: "available" | "scanning";
}

export interface MessageReference {
  kind: "staff" | "patient";
  entityId: string;
  start: number;
  end: number;
  displayLabel: string;
  navigable: boolean;
}

export interface MessageReferenceInput {
  kind: "staff" | "patient";
  entityId: string;
  start: number;
  end: number;
  displayLabel: string;
}

export interface MentionCandidate {
  kind: "staff" | "patient";
  entityId: string;
  displayName: string;
  detail: string | null;
}

/** WP 2.3: a colleague who is not in the conversation. Never persisted as a reference; choosing it opens the add prompt. */
export interface NonMemberOption {
  kind: "not_member";
  entityId: string;
  displayName: string;
  detail: string | null;
}

export type MentionOption = MentionCandidate | NonMemberOption;

export interface DmStaffMember {
  userId: string;
  displayName: string;
  roles: string[];
}

export interface PatientSearchResult {
  patientId: string;
  displayName: string;
  medicalRecordNumber: string;
}

export interface PatientHeaderInfo {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
}

export type ConversationFilter = "all" | "unread" | "mentions" | "dm" | "care_team" | "archived";
export type ConversationType = "direct" | "patient";

/** WP 1.5: one file in the composer tray. */
export type AttachmentChipStatus =
  | "hashing"
  | "uploading"
  | "scanning"
  | "ready"
  | "blocked"
  | "reattach"
  | "failed";
export interface AttachmentChip {
  readonly localId: string;
  readonly file: File;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly status: AttachmentChipStatus;
  readonly message: string | null;
  readonly attachmentId: string | null;
  /** Bytes are uploaded and the server is scanning inline; the chip is still not sendable. Label only. */
  readonly checking?: boolean;
}
