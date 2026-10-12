export type ChannelKind =
  | "care_team"
  | "discipline"
  | "location"
  | "on_call"
  | "dm"
  | "announcement"
  | "bereavement";

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
  bodyKind: "plain" | "markdown" | "system";
  createdAt: string;
  parentMessageId: string | null;
  references: MessageReference[];
  /** WP 1.5: absent on older payloads. `scanning` is only ever listed to the uploader. */
  attachments?: MessageAttachment[];
  /** Files this viewer cannot see yet (scanning for others, or withheld): a bare count, no detail. */
  hiddenAttachmentCount?: number;
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
}
