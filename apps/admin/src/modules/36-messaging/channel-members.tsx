import { Button, InlineAlert, SelectField, StatusPill, TextField, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/36-messaging — Channel members (`/admin/messaging/channels/:id/members`, M36 spec §4.1).
// List, add (POST) and remove (DELETE) members of one channel, with role + source shown per row. The server is the
// authority on who may manage members (`messaging.manage_members` plus channel-scoped authority); a 403 on the list
// or on a write is shown as no-access, never hidden.
import { useCallback, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useParams } from "react-router-dom";
import {
  type ChannelMember,
  MEMBER_ROLES,
  type MemberRole,
  addMember,
  listMembers,
  removeMember,
} from "./members-api";
import { StateEmpty, renderLoadFallback, useLoad } from "./ui";

const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Owner",
  member: "Member",
  read_only: "Read only",
  portal_caregiver: "Portal caregiver",
};
const roleLabel = (role: string): string => ROLE_LABELS[role as MemberRole] ?? role;

export function ChannelMembers(): JSX.Element {
  const { id: channelId = "" } = useParams<{ id: string }>();
  const client = useApiClient();
  const read = useCallback(() => listMembers(client, channelId), [client, channelId]);
  const { state, reload } = useLoad(read);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (write: () => Promise<string | null>): Promise<boolean> => {
    setBusy(true);
    setFailure(null);
    const message = await write();
    setBusy(false);
    if (message) setFailure(message);
    else reload();
    return message === null;
  };

  const onAdd = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    const id = userId.trim();
    if (!id) return;
    if (await run(() => addMember(client, channelId, id, role))) setUserId("");
  };

  const fallback = renderLoadFallback(state, {
    loading: "Loading members…",
    error: "Could not load channel members.",
    noAccess: "this channel's members",
    retry: reload,
  });
  const members: readonly ChannelMember[] = state.kind === "ok" ? state.data : [];

  return (
    <div className="wx-list-drawer-main">
      <header className="wx-page-head">
        <div>
          <h1>Channel members</h1>
          <p>Who can read and post in this channel, and how they got access.</p>
        </div>
        <div className="wx-list-toolbar-end">
          <Button tone="secondary" size="lg" onClick={reload}>
            Refresh
          </Button>
        </div>
      </header>

      {state.kind !== "forbidden" ? (
        <form className="wx-list-toolbar" onSubmit={(ev) => void onAdd(ev)} aria-label="Add member">
          <TextField
            label="User ID"
            value={userId}
            onChange={(ev) => setUserId(ev.target.value)}
            autoComplete="off"
          />
          <SelectField
            label="Role"
            value={role}
            onChange={(ev) => setRole(ev.target.value as MemberRole)}
            options={MEMBER_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
          <Button type="submit" size="lg" loading={busy} disabled={!userId.trim()}>
            Add member
          </Button>
        </form>
      ) : null}
      {failure ? <InlineAlert tone="error">{failure}</InlineAlert> : null}

      {fallback ??
        (members.length === 0 ? (
          <StateEmpty icon="users">This channel has no members.</StateEmpty>
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table">
              <caption className="wx-sr-only">Channel members</caption>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Role</th>
                  <th scope="col">Source</th>
                  <th scope="col">
                    <span className="wx-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const name = m.displayName || m.userId;
                  return (
                    <tr key={m.userId}>
                      <td>
                        <span className="wx-row-title">{name}</span>
                        {m.displayName ? (
                          <span className="wx-row-sub wx-data-md">{m.userId}</span>
                        ) : null}
                      </td>
                      <td>
                        <StatusPill
                          label={roleLabel(m.role)}
                          tone={m.role === "owner" ? "progress" : "neutral"}
                        />
                      </td>
                      <td>{m.source}</td>
                      <td>
                        <Button
                          tone="secondary"
                          size="lg"
                          disabled={busy}
                          aria-label={`Remove ${name}`}
                          onClick={() => void run(() => removeMember(client, channelId, m.userId))}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
