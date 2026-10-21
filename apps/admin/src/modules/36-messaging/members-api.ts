// apps/admin/src/modules/36-messaging — channel-member API module.
// Member list/add/remove over the generated client.
import type { ApiClient } from "@chartwarden/ui";
import { type ReadResult, toReadResult } from "./ui";

export const MEMBER_ROLES = ["owner", "member", "read_only", "portal_caregiver"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface ChannelMember {
  readonly userId: string;
  readonly role: string;
  readonly source: string;
  readonly displayName?: string | null;
}

export async function listMembers(
  client: ApiClient,
  channelId: string,
): Promise<ReadResult<readonly ChannelMember[]>> {
  const { data, error, response } = await client.GET("/api/v1/messaging/channels/{id}/members", {
    params: { path: { id: channelId } },
  });
  const result = toReadResult(response.status, data, Boolean(error));
  return result.kind === "ok" ? { kind: "ok", data: result.data.members } : result;
}

/** A write's outcome: null on success, else the operator-facing message. */
export async function addMember(
  client: ApiClient,
  channelId: string,
  userId: string,
  role: MemberRole,
): Promise<string | null> {
  const { error, response } = await client.POST("/api/v1/messaging/channels/{id}/members", {
    params: { path: { id: channelId } },
    body: { userId, role },
  });
  if (response.status === 403) return "You do not have permission to add members to this channel.";
  return error ? "Could not add the member." : null;
}

export async function removeMember(
  client: ApiClient,
  channelId: string,
  userId: string,
): Promise<string | null> {
  const { error, response } = await client.DELETE(
    "/api/v1/messaging/channels/{id}/members/{userId}",
    { params: { path: { id: channelId, userId } } },
  );
  if (response.status === 403) return "You do not have permission to remove this member.";
  return error ? "Could not remove the member." : null;
}
