// M36 WP 2.9 — what a conversation adds for announcements and department channels, in one place so the thread
// component stays small:
//  - the announcement channel is read-only unless the viewer holds messaging.announce (the server enforces the same
//    rule on both send routes); it has no threads;
//  - a holder of messaging.announce sees "Read receipts" on each announcement;
//  - a holder of messaging.manage_members sees "Members" on a department (discipline / location) channel.
import { useState } from "react";
import type { JSX } from "react";
import { useAnnouncementReceipts } from "./announcement-receipts";
import { ChannelMembersDialog } from "./channel-members-dialog";
import type { ChannelSummary } from "./messaging-types";
import { channelLabel } from "./messaging-utils";

export interface AnnouncementTools {
  /** True for the announcement channel when the viewer may not post to it. */
  readOnly: boolean;
  /** Announcements are one-way: no reply threads. */
  canReply: boolean;
  onShowReceipts: ((messageId: string) => void) | undefined;
  onShowMembers: (() => void) | undefined;
  dialogs: JSX.Element;
}

export function useAnnouncementTools(
  channel: ChannelSummary,
  canAnnounce: boolean,
  canManageMembers: boolean,
): AnnouncementTools {
  const receipts = useAnnouncementReceipts();
  const [membersOpen, setMembersOpen] = useState(false);
  const announcement = channel.kind === "announcement";
  const department = channel.kind === "discipline" || channel.kind === "location";
  const showMembers = department && canManageMembers;
  return {
    readOnly: announcement && !canAnnounce,
    canReply: !announcement,
    onShowReceipts: announcement && canAnnounce ? receipts.open : undefined,
    onShowMembers: showMembers ? () => setMembersOpen(true) : undefined,
    dialogs: (
      <>
        {receipts.dialog}
        {showMembers ? (
          <ChannelMembersDialog
            channelId={channel.channelId}
            channelTitle={channelLabel(channel)}
            open={membersOpen}
            onClose={() => setMembersOpen(false)}
          />
        ) : null}
      </>
    ),
  };
}
