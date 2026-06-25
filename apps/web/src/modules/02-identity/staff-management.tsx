import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
} from "@wardenx/ui";
import { useApiClient } from "@wardenx/ui";
// apps/web/src/modules/02-identity — Staff Management (M2, Track A).
// Spec: docs/design/screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md (Work Queue). Manages the org's member
// roster: invite by email, change a member's status (active/suspended), and revoke a membership — over
// the M2 member routes via the generated client. The active org for the path comes from the session
// (authClient.getSession). Server stays authoritative (every route is behind member.manage + the
// last-admin lockout guard). FB-T12 enriches the roster with what the M2 surface carries today —
// Name/email, Last login, and the Pending-invite / Locked-account KPIs (the live repo joins the
// M1-owned user/session tables). Discipline / credentials stay deferred to M34 (noted, not faked);
// see docs/design/DEFERRED_SCREENS.md.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { authClient } from "./auth-client";

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

// §6.6 — membership status → tone.
const STATUS_TONE: Record<Member["status"], StatusTone> = {
  active: "success",
  suspended: "warning",
  pending: "progress",
  revoked: "neutral",
};

export function StaffManagement(): JSX.Element {
  const client = useApiClient();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [pendingInvites, setPendingInvites] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (org: string) => {
      const { data, error: err } = await client.GET("/api/v1/orgs/{id}/members", {
        params: { path: { id: org } },
      });
      if (err) {
        setError("Could not load staff. You may not have permission to manage members.");
        return;
      }
      setMembers((data?.members ?? []) as Member[]);
      setPendingInvites(data?.pendingInvitations ?? 0);
    },
    [client],
  );

  // Resolve the active org from the session, then load its roster.
  useEffect(() => {
    void authClient.getSession().then(({ data }) => {
      const org = data?.session?.activeOrganizationId ?? null;
      setOrgId(org);
      if (org) void load(org);
      else setError("No active organization is bound to your session.");
    });
  }, [load]);

  async function invite(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!orgId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: err } = await client.POST("/api/v1/orgs/{id}/invitations", {
      params: { path: { id: orgId } },
      body: { email: inviteEmail.trim() },
    });
    setBusy(false);
    if (err) {
      setError("Could not send the invitation. A pending invite may already exist for that email.");
      return;
    }
    setNotice(`Invitation sent to ${inviteEmail.trim()}.`);
    setInviteEmail("");
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

  async function revoke(m: Member): Promise<void> {
    if (!orgId) return;
    setError(null);
    const { error: err } = await client.DELETE("/api/v1/orgs/{id}/members/{mId}", {
      params: { path: { id: orgId, mId: m.membershipId } },
    });
    if (err) {
      setError("Could not remove that member (the last active admin can't be removed).");
      return;
    }
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
          <button type="submit" disabled={busy || !inviteEmail.trim() || !orgId} style={primaryBtn}>
            {busy ? "Sending…" : "Invite"}
          </button>
          {notice ? (
            <span style={{ color: "var(--color-success)", fontSize: "0.85rem" }}>{notice}</span>
          ) : null}
          {error ? (
            <span style={{ color: "var(--color-error)", fontSize: "0.85rem" }}>{error}</span>
          ) : null}
        </form>
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
                  <td style={{ ...td, ...tabular }}>{formatLastLogin(m.lastLoginAt)}</td>
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
                      <button type="button" onClick={() => setStatus(m, "active")} style={linkBtn}>
                        Reactivate
                      </button>
                    ) : null}
                    {m.status !== "revoked" ? (
                      <button
                        type="button"
                        onClick={() => revoke(m)}
                        style={{ ...linkBtn, color: "var(--color-error)" }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
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

/** Render an ISO last-login timestamp as a local date, or an em dash when the user has never signed in. */
function formatLastLogin(iso: string | null): string {
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
