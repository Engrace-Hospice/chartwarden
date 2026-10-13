// apps/admin/src/modules/36-messaging — channel-member API module.
// POST/DELETE /api/v1/messaging/channels/:id/members[/:userId] are in the generated client. The LIST read,
// GET /api/v1/messaging/channels/:id/members -> 200 { members: [...] }, is built concurrently on the backend and is
// not in packages/ui/src/core/api/schema.ts yet, so it goes through a one-method structural type instead of the
// typed path table. ponytail: once `client:gen` includes the route, swap `ListClient` for `client.GET` directly.
import type { ApiClient } from "@wardenx/ui";
import { type ReadResult, toReadResult } from "./ui";

export const MEMBER_ROLES = ["owner", "member", "read_only", "portal_caregiver"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface ChannelMember {
  readonly userId: string;
  readonly role: string;
  readonly source: string;
  readonly displayName?: string | null;
}

interface ListClient {
  GET(
    path: string,
    init: { params: { path: { id: string } } },
  ): Promise<{ data?: { members: ChannelMember[] }; error?: unknown; response: Response }>;
}

export async function listMembers(
  client: ApiClient,
  channelId: string,
): Promise<ReadResult<readonly ChannelMember[]>> {
  const { data, error, response } = await (client as unknown as ListClient).GET(
    "/api/v1/messaging/channels/{id}/members",
    { params: { path: { id: channelId } } },
  );
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
