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

export type ConversationFilter = "all" | "unread" | "dm" | "care_team" | "archived";
export type ConversationType = "direct" | "patient";
