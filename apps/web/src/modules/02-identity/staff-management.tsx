import {
  ConfirmDialog,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useToast,
} from "@wardenx/ui";
import { useApiClient } from "@wardenx/ui";
// apps/web/src/modules/02-identity — Staff Management (M2, Track A).
// Spec: docs/design/screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md (Work Queue). Manages the org's member
// roster: invite by email, change a member's status (active/suspended), and revoke a membership — over
// the M2 member routes via the generated client. The active org for the path comes from the session
// (authClient.getSession). Server stays authoritative (every route is behind member.manage/member.invite/
// role.assign + the last-admin lockout guard + M3's anti-escalation check). FB-T12 enriches the roster
// with Name/email, Last login, and the Pending-invite / Locked-account KPIs. TASK-030 adds the pending
// invitation roster (resend/rescind — the invite form used to be a one-way "recorded but not emailed"
// dead end) and a per-member role editor (grant/revoke over the M3 role routes). Discipline / credentials
// stay deferred to M34 (noted, not faked); see docs/design/DEFERRED_SCREENS.md.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { authClient } from "./auth-client";
import { MemberRoleEditor } from "./member-role-editor";

interface Member {
  membershipId: string;
  userId: string;
  status: "pending" | "active" | "suspended" | "revoked";
  isAdmin: boolean;
  defaultLocationIds: string[];
  displayName: string | null;
  email: string | null;
  lastLoginAt: string | null;
  accountStatus: "created" | "active" | "suspended" | "deactivated" | null;
}

interface Invitation {
  invitationId: string;
  email: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expiresAt: string;
  createdAt: string;
}

const INVITE_STATUS_TONE: Record<Invitation["status"], StatusTone> = {
  pending: "progress",
  accepted: "success",
  expired: "neutral",
  revoked: "neutral",
};

// §6.6 — membership status → tone.
const STATUS_TONE: Record<Member["status"], StatusTone> = {
  active: "success",
  suspended: "warning",
  pending: "progress",
  revoked: "neutral",
};

export function StaffManagement(): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [pendingInvites, setPendingInvites] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedRolesFor, setExpandedRolesFor] = useState<string | null>(null);

  const load = useCallback(
    async (org: string) => {
      const [membersRes, invitationsRes] = await Promise.all([
        client.GET("/api/v1/orgs/{id}/members", { params: { path: { id: org } } }),
        client.GET("/api/v1/orgs/{id}/invitations", { params: { path: { id: org } } }),
      ]);
      if (membersRes.error) {
        setError("Could not load staff. You may not have permission to manage members.");
        // `members === null` is the "still loading" state (drives the spinner below) — leaving it
        // null on a load error kept the spinner spinning forever alongside the error message.
        setMembers([]);
        return;
      }
      setMembers((membersRes.data?.members ?? []) as Member[]);
      setPendingInvites(membersRes.data?.pendingInvitations ?? 0);
      // Non-fatal: the invitation roster is an enhancement on top of the roster load above.
      if (!invitationsRes.error) {
        setInvitations((invitationsRes.data?.invitations ?? []) as Invitation[]);
      }
    },
    [client],
  );

  // Resolve the active org from the session, then load its roster.
  useEffect(() => {
    void authClient.getSession().then(({ data }) => {
      const org = data?.session?.activeOrganizationId ?? null;
      setOrgId(org);
      if (org) void load(org);
      else {
        setError("No active organization is bound to your session.");
        setMembers([]); // same "don't spin forever on a resolved-but-unusable state" fix as load()
      }
    });
  }, [load]);

  async function invite(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!orgId) return;
    setBusy(true);
    setError(null);
    setInviteLink(null);
    const { data, error: err } = await client.POST("/api/v1/orgs/{id}/invitations", {
      params: { path: { id: orgId } },
      body: { email: inviteEmail.trim() },
    });
    setBusy(false);
    if (err) {
      setError(
        "Could not record the invitation. A pending invite may already exist for that email.",
      );
      return;
    }
    // TASK-030: no vendor email sender is wired yet (M36's transport no-ops in production), so the
    // server ALSO echoes the accept link here — an honest "copy this to share it yourself" fallback,
    // replacing the old dead-end "recorded but not emailed" message.
    if (data?.inviteUrl) {
      setInviteLink(data.inviteUrl);
      toast.show(`Invitation recorded for ${inviteEmail.trim()}. Share the link below with them.`, {
        tone: "success",
      });
    } else {
      toast.show(
        `Invitation recorded for ${inviteEmail.trim()} — but no link could be built (the server has no web app origin configured).`,
        { tone: "success" },
      );
    }
    setInviteEmail("");
    void load(orgId);
  }

  async function resendInvite(inv: Invitation): Promise<void> {
    if (!orgId) return;
    setError(null);
    setInviteLink(null);
    const { data, error: err } = await client.POST("/api/v1/orgs/{id}/invitations/{invId}/resend", {
      params: { path: { id: orgId, invId: inv.invitationId } },
      body: {},
    });
    if (err) {
      setError("Could not resend that invitation (it may no longer be pending).");
      return;
    }
    if (data?.inviteUrl) {
      setInviteLink(data.inviteUrl);
      toast.show(
        `Re-sent invitation for ${inv.email}. The old link no longer works — share this one.`,
        { tone: "success" },
      );
    }
    void load(orgId);
  }

  // UI-010: rescinding a pending invite is destructive — confirm via the shared ConfirmDialog
  // instead of the old arm-then-confirm two-click pattern (TASK-032).
  const [confirmRescind, setConfirmRescind] = useState<Invitation | null>(null);
  const [rescindBusy, setRescindBusy] = useState(false);

  async function performRescind(): Promise<void> {
    if (!orgId || !confirmRescind) return;
    setRescindBusy(true);
    setError(null);
    const { error: err } = await client.DELETE("/api/v1/orgs/{id}/invitations/{invId}", {
      params: { path: { id: orgId, invId: confirmRescind.invitationId } },
    });
    setRescindBusy(false);
    if (err) {
      setError("Could not rescind that invitation.");
      setConfirmRescind(null);
      return;
    }
    toast.show(`Rescinded the invitation for ${confirmRescind.email}.`, { tone: "success" });
    setConfirmRescind(null);
    void load(orgId);
  }

  async function setStatus(m: Member, status: "active" | "suspended"): Promise<void> {
    if (!orgId) return;
    setError(null);
    const { error: err } = await client.PATCH("/api/v1/orgs/{id}/members/{mId}", {
      params: { path: { id: orgId, mId: m.membershipId } },
      body: { status },
    });
    if (err) {
      setError("Could not update that member (the last active admin can't be suspended).");
      return;
    }
    void load(orgId);
  }

  // UI-010: removing a member is destructive — confirm via the shared ConfirmDialog instead of the
  // old arm-then-confirm two-click pattern (TASK-032).
  const [confirmRevoke, setConfirmRevoke] = useState<Member | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  async function performRevoke(): Promise<void> {
    if (!orgId || !confirmRevoke) return;
    setRevokeBusy(true);
    setError(null);
    const { error: err } = await client.DELETE("/api/v1/orgs/{id}/members/{mId}", {
      params: { path: { id: orgId, mId: confirmRevoke.membershipId } },
    });
    setRevokeBusy(false);
    if (err) {
      setError("Could not remove that member (the last active admin can't be removed).");
      setConfirmRevoke(null);
      return;
    }
    toast.show(
      `Removed ${confirmRevoke.displayName ?? confirmRevoke.email ?? "member"} from the organization.`,
      { tone: "success" },
    );
    setConfirmRevoke(null);
    void load(orgId);
  }

  const active = members?.filter((m) => m.status === "active").length ?? 0;
  const suspended = members?.filter((m) => m.status === "suspended").length ?? 0;
  const admins = members?.filter((m) => m.isAdmin && m.status === "active").length ?? 0;
  // "Locked accounts": the underlying user account is suspended/deactivated (can't sign in), distinct
  // from a suspended *membership*. Surfaced from the joined M1 user.status (FB-T12).
  const locked =
    members?.filter((m) => m.accountStatus === "suspended" || m.accountStatus === "deactivated")
      .length ?? 0;

  return (
    <>
      <WorkQueueLayout
        header={<PageHeader title="Staff Management" />}
        kpis={
          <div style={kpiStrip}>
            <Kpi label="Active staff" value={active} />
            <Kpi label="Suspended" value={suspended} />
            <Kpi label="Admins" value={admins} />
            <Kpi label="Pending invites" value={pendingInvites} />
            <Kpi label="Locked accounts" value={locked} />
          </div>
        }
        filters={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <form onSubmit={invite} style={inviteBar}>
              <input
                type="email"
                required
                placeholder="Invite by email…"
                aria-label="Invite by email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                style={field}
              />
              <button
                type="submit"
                disabled={busy || !inviteEmail.trim() || !orgId}
                style={primaryBtn}
              >
                {busy ? "Sending…" : "Invite"}
              </button>
              {error ? (
                <span role="alert" style={{ color: "var(--color-error)", fontSize: "0.85rem" }}>
                  {error}
                </span>
              ) : null}
            </form>
            {inviteLink ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0 0.1rem",
                }}
              >
                <code className="wx-data-md" style={inviteLinkField}>
                  {inviteLink}
                </code>
                <button
                  type="button"
                  style={linkBtn}
                  onClick={() => void navigator.clipboard.writeText(inviteLink)}
                >
                  Copy link
                </button>
              </div>
            ) : null}
          </div>
        }
        table={
          members === null ? (
            <LoadingSpinner />
          ) : members.length === 0 ? (
            <EmptyState
              title="No staff yet"
              description="Invite a team member above to get started."
            />
          ) : (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      color: "var(--color-on-surface-variant)",
                      borderBottom: "1px solid var(--color-outline-variant)",
                    }}
                  >
                    <th style={th}>Member</th>
                    <th style={th}>Email</th>
                    <th style={th}>Role</th>
                    <th style={th}>Last login</th>
                    <th style={th}>Locations</th>
                    <th style={th}>Status</th>
                    <th style={th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr
                      key={m.membershipId}
                      style={{ borderBottom: "1px solid var(--color-outline-variant)" }}
                    >
                      <td style={td}>
                        <MemberName member={m} />
                      </td>
                      <td style={td}>{m.email ?? "—"}</td>
                      <td style={td}>{m.isAdmin ? "Org admin" : "Member"}</td>
                      <td style={{ ...td, ...tabular }}>{formatDate(m.lastLoginAt)}</td>
                      <td style={{ ...td, ...tabular }}>{m.defaultLocationIds.length}</td>
                      <td style={td}>
                        <StatusPill label={cap(m.status)} tone={STATUS_TONE[m.status]} />
                      </td>
                      <td style={td}>
                        {m.status === "active" ? (
                          <button
                            type="button"
                            onClick={() => setStatus(m, "suspended")}
                            style={linkBtn}
                          >
                            Suspend
                          </button>
                        ) : m.status === "suspended" ? (
                          <button
                            type="button"
                            onClick={() => setStatus(m, "active")}
                            style={linkBtn}
                          >
                            Reactivate
                          </button>
                        ) : null}
                        {m.status !== "revoked" ? (
                          <button
                            type="button"
                            onClick={() => setConfirmRevoke(m)}
                            style={{ ...linkBtn, color: "var(--color-error)" }}
                          >
                            Remove
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedRolesFor((cur) =>
                              cur === m.membershipId ? null : m.membershipId,
                            )
                          }
                          style={linkBtn}
                        >
                          {expandedRolesFor === m.membershipId ? "Hide roles" : "Roles"}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {members.map((m) =>
                    expandedRolesFor === m.membershipId ? (
                      <tr key={`${m.membershipId}-roles`}>
                        <td
                          colSpan={7}
                          style={{ padding: "0 1.5rem 1rem", background: "var(--color-surface)" }}
                        >
                          <MemberRoleEditor
                            membershipId={m.membershipId}
                            memberLabel={m.displayName ?? m.email ?? m.membershipId}
                          />
                        </td>
                      </tr>
                    ) : null,
                  )}
                </tbody>
              </table>
              <PendingInvitations
                invitations={invitations}
                onResend={resendInvite}
                onRescind={setConfirmRescind}
              />
            </>
          )
        }
      />
      <ConfirmDialog
        open={confirmRevoke !== null}
        title="Remove member?"
        description={`This removes ${confirmRevoke?.displayName ?? confirmRevoke?.email ?? "this member"} from the organization. They lose access immediately.`}
        tone="danger"
        confirmLabel="Remove"
        pending={revokeBusy}
        onConfirm={() => void performRevoke()}
        onCancel={() => setConfirmRevoke(null)}
      />
      <ConfirmDialog
        open={confirmRescind !== null}
        title="Rescind invitation?"
        description={`The invite link sent to ${confirmRescind?.email ?? "this address"} stops working immediately.`}
        tone="danger"
        confirmLabel="Rescind"
        pending={rescindBusy}
        onConfirm={() => void performRescind()}
        onCancel={() => setConfirmRescind(null)}
      />
    </>
  );
}

function PendingInvitations({
  invitations,
  onResend,
  onRescind,
}: {
  invitations: Invitation[];
  onResend: (inv: Invitation) => void;
  onRescind: (inv: Invitation) => void;
}): JSX.Element | null {
  const relevant = invitations.filter((i) => i.status === "pending" || i.status === "expired");
  if (relevant.length === 0) return null;
  return (
    <div style={{ padding: "1rem 1.5rem" }}>
      <h2 style={{ fontSize: "0.9rem", margin: "0 0 0.5rem" }}>Pending invitations</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr
            style={{
              textAlign: "left",
              color: "var(--color-on-surface-variant)",
              borderBottom: "1px solid var(--color-outline-variant)",
            }}
          >
            <th style={th}>Email</th>
            <th style={th}>Status</th>
            <th style={th}>Expires</th>
            <th style={th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {relevant.map((inv) => (
            <tr
              key={inv.invitationId}
              style={{ borderBottom: "1px solid var(--color-outline-variant)" }}
            >
              <td style={td}>{inv.email}</td>
              <td style={td}>
                <StatusPill label={cap(inv.status)} tone={INVITE_STATUS_TONE[inv.status]} />
              </td>
              <td style={{ ...td, ...tabular }}>{formatDate(inv.expiresAt)}</td>
              <td style={td}>
                <button type="button" onClick={() => onResend(inv)} style={linkBtn}>
                  Resend
                </button>
                <button
                  type="button"
                  onClick={() => onRescind(inv)}
                  style={{ ...linkBtn, color: "var(--color-error)" }}
                >
                  Rescind
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div style={kpiCard}>
      <div className="tabular-nums" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
        {value}
      </div>
      <div style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>{label}</div>
    </div>
  );
}

// Display name falls back to email, then a short membership id — never a blank cell. A locked account
// (user.status suspended/deactivated) is badged inline so it's visible even when the membership is active.
function MemberName({ member }: { member: Member }): JSX.Element {
  const primary = member.displayName ?? member.email ?? member.membershipId.slice(0, 8);
  const isLocked = member.accountStatus === "suspended" || member.accountStatus === "deactivated";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      {member.displayName ? primary : <span className="wx-data-md">{primary}</span>}
      {isLocked ? <StatusPill label="Locked" tone="error" glyph="lock" /> : null}
    </span>
  );
}

/** Render an ISO timestamp as a local date, or an em dash for null (e.g. never signed in). */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());

const tabular = { fontVariantNumeric: "tabular-nums" } as const;
const kpiStrip = { display: "flex", gap: "1rem", padding: "0.75rem 1.5rem" } as const;
const kpiCard = {
  padding: "0.75rem 1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.5rem",
  minWidth: "7rem",
  background: "var(--color-surface-lowest)",
} as const;
const inviteLinkField = {
  padding: "0.25rem 0.5rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.4rem",
  fontSize: "0.8rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  maxWidth: "28rem",
} as const;
const inviteBar = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  padding: "0 1.5rem 0.75rem",
  flexWrap: "wrap" as const,
} as const;
const field = {
  padding: "0.4rem 0.6rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.5rem",
  minWidth: "16rem",
} as const;
const th = { padding: "0.5rem 1.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 1.5rem" } as const;
const primaryBtn = {
  padding: "0.4rem 0.9rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "var(--color-primary)",
  color: "var(--color-surface-lowest)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
const linkBtn = {
  border: "none",
  background: "none",
  color: "var(--color-primary)",
  cursor: "pointer",
  fontWeight: 600,
  marginRight: "0.75rem",
  padding: 0,
} as const;
