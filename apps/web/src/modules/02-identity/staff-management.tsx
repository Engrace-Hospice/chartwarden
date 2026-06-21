// apps/web/src/modules/02-identity — Staff Management (M2, Track A).
// Spec: docs/ui/screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md (Work Queue). Manages the org's member
// roster: invite by email, change a member's status (active/suspended), and revoke a membership — over
// the M2 member routes via the generated client. The active org for the path comes from the session
// (authClient.getSession). Server stays authoritative (every route is behind member.manage + the
// last-admin lockout guard). Columns the M2 member view doesn't carry yet — Name/email, Discipline,
// Credentials, Last login, and the Pending-invite / Locked KPIs — are deferred to richer member data /
// later modules (M34); see docs/ui/DEFERRED_SCREENS.md.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { EmptyState, LoadingSpinner, PageHeader, WorkQueueLayout } from "@wardenx/ui";
import { useApiClient } from "@wardenx/ui";
import { authClient } from "./auth-client";

interface Member {
  membershipId: string;
  status: "pending" | "active" | "suspended" | "revoked";
  isAdmin: boolean;
  defaultLocationIds: string[];
}

export function StaffManagement(): JSX.Element {
  const client = useApiClient();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
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

  return (
    <WorkQueueLayout
      header={<PageHeader title="Staff Management" />}
      kpis={
        <div style={kpiStrip}>
          <Kpi label="Active staff" value={active} />
          <Kpi label="Suspended" value={suspended} />
          <Kpi label="Admins" value={admins} />
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
          {notice ? <span style={{ color: "#15803d", fontSize: "0.85rem" }}>{notice}</span> : null}
          {error ? <span style={{ color: "#b91c1c", fontSize: "0.85rem" }}>{error}</span> : null}
        </form>
      }
      table={
        members === null ? (
          <LoadingSpinner />
        ) : members.length === 0 ? (
          <EmptyState title="No staff yet" description="Invite a team member above to get started." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #e5e7eb" }}>
                <th style={th}>Member</th>
                <th style={th}>Role</th>
                <th style={th}>Locations</th>
                <th style={th}>Status</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membershipId} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={td}><code style={{ fontSize: "0.8rem" }}>{m.membershipId.slice(0, 8)}</code></td>
                  <td style={td}>{m.isAdmin ? "Org admin" : "Member"}</td>
                  <td style={td}>{m.defaultLocationIds.length}</td>
                  <td style={td}><StatusPill status={m.status} /></td>
                  <td style={td}>
                    {m.status === "active" ? (
                      <button type="button" onClick={() => setStatus(m, "suspended")} style={linkBtn}>Suspend</button>
                    ) : m.status === "suspended" ? (
                      <button type="button" onClick={() => setStatus(m, "active")} style={linkBtn}>Reactivate</button>
                    ) : null}
                    {m.status !== "revoked" ? (
                      <button type="button" onClick={() => revoke(m)} style={{ ...linkBtn, color: "#b91c1c" }}>Remove</button>
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
      <div style={{ fontSize: "1.5rem", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "0.8rem", color: "#6b7280" }}>{label}</div>
    </div>
  );
}

function StatusPill({ status }: { status: Member["status"] }): JSX.Element {
  const color =
    status === "active" ? "#15803d" : status === "suspended" ? "#b45309" : status === "pending" ? "#1d4ed8" : "#6b7280";
  return <span style={{ color, fontWeight: 600, textTransform: "capitalize" }}>{status}</span>;
}

const kpiStrip = { display: "flex", gap: "1rem", padding: "0.75rem 1.5rem" } as const;
const kpiCard = { padding: "0.75rem 1rem", border: "1px solid #e5e7eb", borderRadius: "0.5rem", minWidth: "7rem" } as const;
const inviteBar = { display: "flex", gap: "0.5rem", alignItems: "center", padding: "0 1.5rem 0.75rem", flexWrap: "wrap" as const } as const;
const field = { padding: "0.4rem 0.6rem", border: "1px solid #e5e7eb", borderRadius: "0.5rem", minWidth: "16rem" } as const;
const th = { padding: "0.5rem 1.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 1.5rem" } as const;
const primaryBtn = { padding: "0.4rem 0.9rem", border: "none", borderRadius: "0.5rem", background: "#1d4ed8", color: "#fff", cursor: "pointer", fontWeight: 600 } as const;
const linkBtn = { border: "none", background: "none", color: "#1d4ed8", cursor: "pointer", fontWeight: 600, marginRight: "0.75rem", padding: 0 } as const;
