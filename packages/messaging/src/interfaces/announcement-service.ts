// @chartwarden/messaging — M36 WP 2.9 announcements & department channels.
//
// Announcements reuse the existing org-wide `announcement` channel kind; department channels reuse the
// existing `discipline` / `location` kinds (no new kind). This service is the small WP 2.9 surface:
//   - the sender-side read-receipt view of one announcement;
//   - the org_admin-only creation of a department channel (membership then goes through the existing
//     member-admin routes);
//   - the "is this an announcement channel" probe the generic send route uses to keep sending org_admin-only.
// Distinct from MessagingRouteService so the shared route-service interface and its Drizzle implementation
// stay untouched; the in-memory slice implements both.

/** One staff member in a receipt list. */
export interface AnnouncementReceiptPerson {
  readonly userId: string;
  readonly displayName: string;
}

export interface AnnouncementReader extends AnnouncementReceiptPerson {
  readonly readAt: string;
}

/** Who has read one announcement. Counts are exact; the lists are capped at {@link RECEIPT_LIST_LIMIT} each. */
export interface AnnouncementReceiptView {
  readonly messageId: string;
  readonly channelId: string;
  readonly sentAt: string;
  /** Active staff in the organization except the author. */
  readonly recipientCount: number;
  readonly readCount: number;
  readonly readers: readonly AnnouncementReader[];
  readonly unread: readonly AnnouncementReceiptPerson[];
  /** True when either list was cut at the cap. */
  readonly truncated: boolean;
}

export const RECEIPT_LIST_LIMIT = 500;

export type DepartmentChannelKind = "discipline" | "location";

export interface CreateDepartmentChannelInput {
  readonly creatorUserId: string;
  readonly kind: DepartmentChannelKind;
  /** `location`: a location id of this organization. `discipline`: a role id (org-owned or platform template). */
  readonly subjectId: string;
  /** Defaults to the location or role name. */
  readonly title?: string;
}

export interface AnnouncementService {
  /** True when `channelId` is this organization's announcement channel. False for unknown or foreign ids. */
  isAnnouncementChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  /** Receipts of one announcement message; NOT_FOUND unless it is a message in this org's announcement channel. */
  listAnnouncementReceipts(
    orgId: string,
    input: { readonly userId: string; readonly messageId: string },
  ): Promise<AnnouncementReceiptView>;
  /** Find-or-create the department channel for a subject; NOT_FOUND when the subject is not this org's. */
  createDepartmentChannel(
    orgId: string,
    input: CreateDepartmentChannelInput,
  ): Promise<{ channelId: string; created: boolean }>;
}
