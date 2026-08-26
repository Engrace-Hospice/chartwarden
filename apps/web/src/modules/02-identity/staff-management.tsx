import {
  Button,
  ConfirmDialog,
  EmptyState,
  Glyph,
  IconButton,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  Modal,
  OffsetPagination,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  type StatusTone,
  useApiClient,
  useToast,
} from "@wardenx/ui";
// apps/web/src/modules/02-identity — Staff Management (M2, Track A).
// Modernized UI/UX refactor for WardenX Healthcare / Compliance Administration Portal.
// Preserves all existing business logic, auth checks, server-authoritative API calls, and permission rules.
import { useCallback, useEffect, useRef, useState } from "react";
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

const STATUS_TONE: Record<Member["status"], StatusTone> = {
  active: "success",
  suspended: "warning",
  pending: "progress",
  revoked: "neutral",
};

const STAFF_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function StaffManagement(): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [pendingInvites, setPendingInvites] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Form & Invite States
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);

  // Table Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "member">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "suspended" | "pending">("all");
  const [activeTab, setActiveTab] = useState<"roster" | "invitations">("roster");
  const [memberPage, setMemberPage] = useState(1);
  const [memberPageSize, setMemberPageSize] = useState(10);
  const [invitationPage, setInvitationPage] = useState(1);
  const [invitationPageSize, setInvitationPageSize] = useState(10);

  // Selection & Side Drawer
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);

  // Destructive Confirmation Dialogs
  const [confirmRescind, setConfirmRescind] = useState<Invitation | null>(null);
  const [rescindBusy, setRescindBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<Member | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const load = useCallback(
    async (org: string) => {
      const [membersRes, invitationsRes] = await Promise.all([
        client.GET("/api/v1/orgs/{id}/members", { params: { path: { id: org } } }),
        client.GET("/api/v1/orgs/{id}/invitations", { params: { path: { id: org } } }),
      ]);
      if (membersRes.error) {
        setError("Could not load staff. You may not have permission to manage members.");
        setLoadFailed(true);
        setMembers([]);
        return;
      }
      setLoadFailed(false);
      setMembers((membersRes.data?.members ?? []) as Member[]);
      setPendingInvites(membersRes.data?.pendingInvitations ?? 0);
      if (!invitationsRes.error) {
        setInvitations((invitationsRes.data?.invitations ?? []) as Invitation[]);
      }
    },
    [client],
  );

  useEffect(() => {
    void authClient.getSession().then(({ data }) => {
      const org = data?.session?.activeOrganizationId ?? null;
      setOrgId(org);
      if (org) void load(org);
      else {
        setError("No active organization is bound to your session.");
        setLoadFailed(true);
        setMembers([]);
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
    setInviteModalOpen(false);
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
    toast.show(`Member status updated to ${status}.`, { tone: "success" });
    void load(orgId);
  }

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
    if (selectedMemberId === confirmRevoke.membershipId) {
      setSelectedMemberId(null);
    }
    setConfirmRevoke(null);
    void load(orgId);
  }

  // Calculated Metrics for KPIs
  const activeCount = loadFailed ? null : (members?.filter((m) => m.status === "active").length ?? 0);
  const suspendedCount = loadFailed ? null : (members?.filter((m) => m.status === "suspended").length ?? 0);
  const adminCount = loadFailed ? null : (members?.filter((m) => m.isAdmin && m.status === "active").length ?? 0);
  const lockedCount = loadFailed
    ? null
    : (members?.filter((m) => m.accountStatus === "suspended" || m.accountStatus === "deactivated").length ?? 0);

  // Filtered members list
  const filteredMembers = (members ?? []).filter((m) => {
    const nameStr = (m.displayName ?? "").toLowerCase();
    const emailStr = (m.email ?? "").toLowerCase();
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = !q || nameStr.includes(q) || emailStr.includes(q);

    const matchesRole =
      roleFilter === "all" ||
      (roleFilter === "admin" && m.isAdmin) ||
      (roleFilter === "member" && !m.isAdmin);

    const matchesStatus = statusFilter === "all" || m.status === statusFilter;

    return matchesSearch && matchesRole && matchesStatus;
  });

  const selectedMember = (members ?? []).find((m) => m.membershipId === selectedMemberId) ?? null;
  const pendingInvitationsList = invitations.filter(
    (i) => i.status === "pending" || i.status === "expired",
  );

  const hasActiveFilters = searchQuery !== "" || roleFilter !== "all" || statusFilter !== "all";
  const memberPageCount = Math.max(1, Math.ceil(filteredMembers.length / memberPageSize));
  const activeMemberPage = Math.min(memberPage, memberPageCount);
  const pagedMembers = filteredMembers.slice(
    (activeMemberPage - 1) * memberPageSize,
    activeMemberPage * memberPageSize,
  );
  const invitationPageCount = Math.max(1, Math.ceil(pendingInvitationsList.length / invitationPageSize));
  const activeInvitationPage = Math.min(invitationPage, invitationPageCount);
  const pagedInvitations = pendingInvitationsList.slice(
    (activeInvitationPage - 1) * invitationPageSize,
    activeInvitationPage * invitationPageSize,
  );

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Staff Management"
            breadcrumb="Admin / Organization"
            actions={
              <Button
                tone="primary"
                onClick={() => setInviteModalOpen(true)}
                disabled={!orgId}
              >
                + Invite staff
              </Button>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Manage organization members, security access, roles, and pending invitations.
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Active Staff"
              value={activeCount ?? "—"}
              detail="Active accounts"
              tone="success"
              accentColor="var(--color-success)"
            />
            <KpiCard
              label="Admins"
              value={adminCount ?? "—"}
              detail="Full org access"
              tone="info"
              accentColor="var(--color-primary)"
            />
            <KpiCard
              label="Pending Invites"
              value={loadFailed ? "—" : pendingInvites}
              detail="Awaiting acceptance"
              tone={pendingInvites > 0 ? "warning" : "neutral"}
              accentColor={
                pendingInvites > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
              }
              onSelect={() => setActiveTab("invitations")}
              selected={activeTab === "invitations"}
            />
            <KpiCard
              label="Suspended"
              value={suspendedCount ?? "—"}
              detail="Access paused"
              tone={(suspendedCount ?? 0) > 0 ? "warning" : "neutral"}
              accentColor={
                (suspendedCount ?? 0) > 0
                  ? "var(--color-warning)"
                  : "var(--color-outline-variant)"
              }
            />
            <KpiCard
              label="Locked Accounts"
              value={lockedCount ?? "—"}
              detail="Security locked"
              tone={(lockedCount ?? 0) > 0 ? "danger" : "neutral"}
              accentColor={
                (lockedCount ?? 0) > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
              }
            />
          </KpiStrip>
        }
        filters={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0 1.5rem 0.75rem" }}>
            {/* Error Banner */}
            {error ? (
              <div
                role="alert"
                style={{
                  padding: "0.625rem 1rem",
                  borderRadius: "var(--radius-md)",
                  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
                  color: "var(--color-error)",
                  fontSize: "0.85rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <Glyph name="alert" size={16} />
                  <span>{error}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  style={{
                    border: "none",
                    background: "none",
                    color: "inherit",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  ✕
                </button>
              </div>
            ) : null}

            {/* Generated Invite URL Banner */}
            {inviteLink ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.75rem",
                  padding: "0.625rem 1rem",
                  borderRadius: "var(--radius-md)",
                  background: "var(--color-primary-tint)",
                  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: 1, minWidth: 0 }}>
                  <Glyph name="sparkle" size={16} />
                  <span style={{ fontSize: "0.85rem", color: "var(--color-on-surface)" }}>
                    Invitation link:
                  </span>
                  <code className="wx-data-md" style={inviteLinkStyle}>
                    {inviteLink}
                  </code>
                </div>
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(inviteLink);
                    toast.show("Invite link copied to clipboard", { tone: "success" });
                  }}
                >
                  Copy Link
                </Button>
              </div>
            ) : null}

            {/* Navigation Tabs & Search Toolbar */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
              }}
            >
              {/* Tab Navigation */}
              <div style={{ display: "flex", gap: "0.25rem", background: "var(--color-surface-container)", padding: "0.2rem", borderRadius: "var(--radius-md)" }}>
                <button
                  type="button"
                    onClick={() => setActiveTab("roster")}
                  style={tabButtonStyle(activeTab === "roster")}
                >
                  Roster ({members?.length ?? 0})
                </button>
                <button
                  type="button"
                    onClick={() => setActiveTab("invitations")}
                  style={tabButtonStyle(activeTab === "invitations")}
                >
                  Pending Invites ({pendingInvitationsList.length})
                </button>
              </div>

              {/* Quick Search & Filters */}
              {activeTab === "roster" ? (
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <div style={{ position: "relative", minWidth: "15rem" }}>
                    <input
                      type="search"
                      placeholder="Search staff by name or email..."
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setMemberPage(1);
                      }}
                      aria-label="Search staff"
                      style={{
                        width: "100%",
                        paddingLeft: "2rem",
                        height: "2.25rem",
                        fontSize: "0.85rem",
                      }}
                    />
                    <div style={{ position: "absolute", left: "0.625rem", top: "50%", transform: "translateY(-50%)", color: "var(--color-on-surface-variant)", pointerEvents: "none" }}>
                      <Glyph name="eye" size={14} />
                    </div>
                  </div>

                  <select
                    value={roleFilter}
                    onChange={(e) => {
                      setRoleFilter(e.target.value as typeof roleFilter);
                      setMemberPage(1);
                    }}
                    aria-label="Filter by role"
                    style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
                  >
                    <option value="all">Role: All</option>
                    <option value="admin">Org Admin</option>
                    <option value="member">Member</option>
                  </select>

                  <select
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value as typeof statusFilter);
                      setMemberPage(1);
                    }}
                    aria-label="Filter by status"
                    style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
                  >
                    <option value="all">Status: All</option>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="pending">Pending</option>
                  </select>

                  {hasActiveFilters ? (
                    <Button
                      size="sm"
                      tone="tertiary"
                      onClick={() => {
                        setSearchQuery("");
                        setRoleFilter("all");
                        setStatusFilter("all");
                        setMemberPage(1);
                      }}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        }
        table={
          members === null ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : activeTab === "invitations" ? (
            <>
              <PendingInvitationsTable
                invitations={pagedInvitations}
                onResend={resendInvite}
                onRescind={setConfirmRescind}
              />
              <OffsetPagination
                page={activeInvitationPage}
                pageSize={invitationPageSize}
                totalItems={pendingInvitationsList.length}
                onPageChange={setInvitationPage}
                onPageSizeChange={(pageSize) => {
                  setInvitationPageSize(pageSize);
                  setInvitationPage(1);
                }}
                pageSizeOptions={STAFF_PAGE_SIZES}
                noun="invitations"
              />
            </>
          ) : filteredMembers.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title={hasActiveFilters ? "No matching staff found" : "No staff members yet"}
                description={
                  hasActiveFilters
                    ? "Try adjusting your search criteria or clearing active filters."
                    : "Invite team members to your organization to get started."
                }
                action={
                  hasActiveFilters ? (
                    <Button
                      tone="secondary"
                      size="sm"
                      onClick={() => {
                        setSearchQuery("");
                        setRoleFilter("all");
                        setStatusFilter("all");
                        setMemberPage(1);
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : (
                    <Button tone="primary" size="sm" onClick={() => setInviteModalOpen(true)}>
                      + Invite staff member
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem 1.5rem" }}>
              <table style={{ display: "table", width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      color: "var(--color-on-surface-variant)",
                      borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
                      background: "var(--color-surface-low)",
                    }}
                  >
                    <th style={{ ...thStyle, width: "35%" }}>Member</th>
                    <th style={{ ...thStyle, width: "15%" }}>Role</th>
                    <th style={{ ...thStyle, width: "15%" }}>Last login</th>
                    <th style={{ ...thStyle, width: "15%" }}>Locations</th>
                    <th style={{ ...thStyle, width: "10%" }}>Status</th>
                    <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedMembers.map((m) => {
                    const isSelected = selectedMemberId === m.membershipId;
                    return (
                      <tr
                        key={m.membershipId}
                        {...interactiveRowProps(
                          () => setSelectedMemberId(m.membershipId),
                          isSelected,
                          true,
                        )}
                        style={{
                          borderBottom:
                            "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
                          background: isSelected
                            ? "var(--color-primary-tint)"
                            : "transparent",
                          cursor: "pointer",
                          transition: "background 0.15s ease",
                        }}
                        className="wx-data-row-interactive"
                      >
                        <td style={tdStyle}>
                          <MemberAvatarCell member={m} />
                        </td>
                        <td style={tdStyle}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "0.2rem 0.5rem",
                              borderRadius: "var(--radius-sm)",
                              fontSize: "0.75rem",
                              fontWeight: 500,
                              background: m.isAdmin
                                ? "var(--color-primary-tint)"
                                : "var(--color-surface-container)",
                              color: m.isAdmin
                                ? "var(--color-primary)"
                                : "var(--color-on-surface-variant)",
                            }}
                          >
                            {m.isAdmin ? "Org Admin" : "Member"}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(m.lastLoginAt)}
                        </td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          <span
                            style={{
                              padding: "0.15rem 0.4rem",
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              background: "var(--color-surface-container)",
                              color: "var(--color-on-surface-variant)",
                            }}
                          >
                            {m.defaultLocationIds.length}{" "}
                            {m.defaultLocationIds.length === 1 ? "location" : "locations"}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <StatusPill label={cap(m.status)} tone={STATUS_TONE[m.status]} />
                        </td>
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: not a control — this
                            only stops a click on the action menu from ALSO selecting the row. The
                            keyboard path needs no twin, because the row's own handler ignores any
                            key event whose target is not the row itself. */}
                        <td
                          style={{ ...tdStyle, textAlign: "right" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <StaffActionDropdown
                            member={m}
                            onViewDetails={() => setSelectedMemberId(m.membershipId)}
                            onToggleStatus={(status) => setStatus(m, status)}
                            onRemove={() => setConfirmRevoke(m)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <OffsetPagination
                page={activeMemberPage}
                pageSize={memberPageSize}
                totalItems={filteredMembers.length}
                onPageChange={setMemberPage}
                onPageSizeChange={(pageSize) => {
                  setMemberPageSize(pageSize);
                  setMemberPage(1);
                }}
                pageSizeOptions={STAFF_PAGE_SIZES}
                noun="staff members"
              />
            </div>
          )
        }
        detail={
          selectedMember ? (
            <RightDetailPanel
              open={selectedMember !== null}
              title="Staff Profile"
              onClose={() => setSelectedMemberId(null)}
              hideScrollbar
            >
              <StaffDrawerContent
                member={selectedMember}
                onStatusChange={(status) => setStatus(selectedMember, status)}
                onRemove={() => setConfirmRevoke(selectedMember)}
              />
            </RightDetailPanel>
          ) : null
        }
        fullPageScroll
      />

      {/* Invite Staff Modal */}
      <Modal
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        ariaLabel="Invite Staff Member"
      >
        <form onSubmit={invite} style={{ display: "flex", flexDirection: "column", gap: "1.25rem", padding: "1.5rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.125rem", fontWeight: 600, color: "var(--color-on-surface)" }}>
            Invite Staff Member
          </h3>
          <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--color-on-surface-variant)" }}>
            Send an invitation email to add a new team member to your organization roster.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
            <label
              htmlFor="invite-email-input"
              style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--color-on-surface)" }}
            >
              Email Address
            </label>
            <input
              id="invite-email-input"
              type="email"
              required
              placeholder="e.g. clinician@wardenx.local"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              style={{ width: "100%", padding: "0.5rem 0.75rem" }}
            />
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "0.5rem",
              paddingTop: "0.5rem",
              borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
            }}
          >
            <Button
              type="button"
              tone="tertiary"
              onClick={() => setInviteModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              tone="primary"
              disabled={busy || !inviteEmail.trim() || !orgId}
            >
              {busy ? "Sending..." : "Send Invitation"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Confirm Revoke Dialog */}
      <ConfirmDialog
        open={confirmRevoke !== null}
        title="Remove Member?"
        description={`This will immediately revoke access for ${
          confirmRevoke?.displayName ?? confirmRevoke?.email ?? "this member"
        }. They will no longer be able to log in or access organization data.`}
        tone="danger"
        confirmLabel="Remove Member"
        pending={revokeBusy}
        onConfirm={() => void performRevoke()}
        onCancel={() => setConfirmRevoke(null)}
      />

      {/* Confirm Rescind Invitation Dialog */}
      <ConfirmDialog
        open={confirmRescind !== null}
        title="Rescind Invitation?"
        description={`The invite link sent to ${
          confirmRescind?.email ?? "this address"
        } will be invalidated immediately.`}
        tone="danger"
        confirmLabel="Rescind Invite"
        pending={rescindBusy}
        onConfirm={() => void performRescind()}
        onCancel={() => setConfirmRescind(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: Action Dropdown, Avatars, Drawer & Pending Table
// ---------------------------------------------------------------------------

function StaffActionDropdown({
  member,
  onViewDetails,
  onToggleStatus,
  onRemove,
}: {
  member: Member;
  onViewDetails: () => void;
  onToggleStatus: (status: "active" | "suspended") => void;
  onRemove: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block" }}>
      <IconButton
        aria-label="Actions menu"
        onClick={() => setOpen((prev) => !prev)}
        style={{
          borderRadius: "var(--radius-md)",
          padding: "0.25rem",
        }}
      >
        <span style={{ fontWeight: "bold", fontSize: "1.1rem", lineHeight: 1 }}>•••</span>
      </IconButton>

      {open ? (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 0.25rem)",
            width: "11rem",
            background: "var(--color-surface-lowest)",
            border: "1px solid color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-float)",
            zIndex: 30,
            padding: "0.375rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.125rem",
          }}
        >
          <button
            type="button"
            style={dropdownItemStyle(false)}
            onClick={() => {
              setOpen(false);
              onViewDetails();
            }}
          >
            <Glyph name="eye" size={14} />
            <span>View details</span>
          </button>

          {member.status === "active" ? (
            <button
              type="button"
              style={dropdownItemStyle(false)}
              onClick={() => {
                setOpen(false);
                onToggleStatus("suspended");
              }}
            >
              <Glyph name="block" size={14} />
              <span>Suspend</span>
            </button>
          ) : member.status === "suspended" ? (
            <button
              type="button"
              style={dropdownItemStyle(false)}
              onClick={() => {
                setOpen(false);
                onToggleStatus("active");
              }}
            >
              <Glyph name="check" size={14} />
              <span>Reactivate</span>
            </button>
          ) : null}

          {member.status !== "revoked" ? (
            <button
              type="button"
              style={dropdownItemStyle(true)}
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              <Glyph name="close" size={14} />
              <span>Remove member</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MemberAvatarCell({ member }: { member: Member }): JSX.Element {
  const name = member.displayName ?? member.email ?? member.membershipId.slice(0, 8);
  const initials = getInitials(name);
  const isLocked = member.accountStatus === "suspended" || member.accountStatus === "deactivated";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
      <div
        aria-hidden
        style={{
          width: "2.25rem",
          height: "2.25rem",
          borderRadius: "9999px",
          background: "var(--color-primary-tint)",
          color: "var(--color-primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 600,
          fontSize: "0.85rem",
          flexShrink: 0,
        }}
      >
        {initials}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
          <span style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>{name}</span>
          {isLocked ? <StatusPill label="Locked" tone="error" glyph="lock" /> : null}
        </div>
        {member.email ? (
          <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
            {member.email}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StaffDrawerContent({
  member,
  onStatusChange,
  onRemove,
}: {
  member: Member;
  onStatusChange: (status: "active" | "suspended") => void;
  onRemove: () => void;
}): JSX.Element {
  const isLocked = member.accountStatus === "suspended" || member.accountStatus === "deactivated";
  const name = member.displayName ?? member.email ?? member.membershipId.slice(0, 8);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", paddingTop: "0.5rem" }}>
      {/* Header Profile Summary */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.875rem", paddingBottom: "1rem", borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)" }}>
        <div
          style={{
            width: "3rem",
            height: "3rem",
            borderRadius: "9999px",
            background: "var(--color-primary-tint)",
            color: "var(--color-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontSize: "1.1rem",
            flexShrink: 0,
          }}
        >
          {getInitials(name)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
          <div style={{ fontWeight: 600, fontSize: "1.1rem", color: "var(--color-on-surface)" }}>
            {name}
          </div>
          <div style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            {member.email ?? "No email provided"}
          </div>
          <div style={{ display: "flex", gap: "0.375rem", marginTop: "0.25rem" }}>
            <StatusPill label={cap(member.status)} tone={STATUS_TONE[member.status]} />
            {member.isAdmin ? <StatusPill label="Org Admin" tone="progress" /> : null}
          </div>
        </div>
      </div>

      {/* Account Details Section */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h4 style={{ margin: 0, fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-on-surface-variant)" }}>
          Account Details
        </h4>
        <div style={detailGridStyle}>
          <DetailRow label="Membership ID" value={member.membershipId} isCode />
          <DetailRow label="User ID" value={member.userId} isCode />
          <DetailRow label="Last Login" value={formatDate(member.lastLoginAt)} />
          <DetailRow label="Account Status" value={member.accountStatus ?? "Active"} />
          <DetailRow
            label="Assigned Locations"
            value={`${member.defaultLocationIds.length} location(s)`}
          />
        </div>
      </div>

      {/* Security Status */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h4 style={{ margin: 0, fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-on-surface-variant)" }}>
          Security & Access State
        </h4>
        <div
          style={{
            padding: "0.75rem",
            borderRadius: "var(--radius-md)",
            background: isLocked ? "color-mix(in srgb, var(--color-error) 10%, transparent)" : "var(--color-surface-low)",
            border: `1px solid color-mix(in srgb, ${isLocked ? "var(--color-error)" : "var(--color-outline-variant)"} 40%, transparent)`,
            fontSize: "0.85rem",
            color: "var(--color-on-surface)",
          }}
        >
          {isLocked ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--color-error)" }}>
              <Glyph name="lock" size={16} />
              <span>User account is locked or deactivated.</span>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--color-success)" }}>
              <Glyph name="check-circle" size={16} />
              <span>Account is in good security standing.</span>
            </div>
          )}
        </div>
      </div>

      {/* Embedded Role Editor */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", paddingTop: "0.5rem", borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)" }}>
        <h4 style={{ margin: 0, fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-on-surface-variant)" }}>
          Assigned Roles
        </h4>
        <MemberRoleEditor
          membershipId={member.membershipId}
          memberLabel={name}
        />
      </div>

      {/* Lifecycle Actions */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          paddingTop: "1rem",
          borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
        }}
      >
        <h4 style={{ margin: 0, fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-on-surface-variant)" }}>
          Lifecycle Actions
        </h4>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {member.status === "active" ? (
            <Button
              tone="secondary"
              size="sm"
              onClick={() => onStatusChange("suspended")}
            >
              Suspend Member
            </Button>
          ) : member.status === "suspended" ? (
            <Button
              tone="primary"
              size="sm"
              onClick={() => onStatusChange("active")}
            >
              Reactivate Member
            </Button>
          ) : null}

          {member.status !== "revoked" ? (
            <Button
              tone="danger"
              size="sm"
              onClick={onRemove}
            >
              Remove Member
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  isCode = false,
}: {
  label: string;
  value: string;
  isCode?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.85rem" }}>
      <span style={{ color: "var(--color-on-surface-variant)" }}>{label}</span>
      {isCode ? (
        <code className="wx-data-md" style={{ fontSize: "0.75rem", background: "var(--color-surface-container)", padding: "0.1rem 0.3rem", borderRadius: "var(--radius-sm)" }}>
          {value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value}
        </code>
      ) : (
        <span style={{ fontWeight: 500, color: "var(--color-on-surface)" }}>{value}</span>
      )}
    </div>
  );
}

function PendingInvitationsTable({
  invitations,
  onResend,
  onRescind,
}: {
  invitations: Invitation[];
  onResend: (inv: Invitation) => void;
  onRescind: (inv: Invitation) => void;
}): JSX.Element {
  if (invitations.length === 0) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="No pending invitations"
          description="All invitations have been accepted or processed."
        />
      </div>
    );
  }

  return (
    <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem 1.5rem" }}>
      <table style={{ display: "table", width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
        <thead>
          <tr
            style={{
              textAlign: "left",
              color: "var(--color-on-surface-variant)",
              borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
              background: "var(--color-surface-low)",
            }}
          >
            <th style={{ ...thStyle, width: "45%" }}>Email</th>
            <th style={{ ...thStyle, width: "20%" }}>Status</th>
            <th style={{ ...thStyle, width: "20%" }}>Expires</th>
            <th style={{ ...thStyle, width: "15%", textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {invitations.map((inv) => (
            <tr
              key={inv.invitationId}
              style={{
                borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
              }}
            >
              <td style={tdStyle}>
                <span style={{ fontWeight: 500, color: "var(--color-on-surface)" }}>{inv.email}</span>
              </td>
              <td style={tdStyle}>
                <StatusPill label={cap(inv.status)} tone={INVITE_STATUS_TONE[inv.status]} />
              </td>
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                {formatDate(inv.expiresAt)}
              </td>
              <td style={{ ...tdStyle, textAlign: "right" }}>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.375rem" }}>
                  <Button size="sm" tone="secondary" onClick={() => onResend(inv)}>
                    Resend
                  </Button>
                  <Button size="sm" tone="danger" onClick={() => onRescind(inv)}>
                    Rescind
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers & Utility Styles
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getInitials(name: string): string {
  const parts = name.trim().split(/[\s,._@-]+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());

const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};

const inviteLinkStyle = {
  padding: "0.2rem 0.5rem",
  background: "var(--color-surface-lowest)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
  borderRadius: "var(--radius-sm)",
  fontSize: "0.8rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  maxWidth: "20rem",
};

const tabButtonStyle = (active: boolean) => ({
  border: "none",
  background: active ? "var(--color-surface-lowest)" : "transparent",
  color: active ? "var(--color-primary)" : "var(--color-on-surface-variant)",
  boxShadow: active ? "var(--shadow-soft)" : "none",
  fontWeight: active ? 600 : 500,
  fontSize: "0.85rem",
  padding: "0.35rem 0.75rem",
  borderRadius: "var(--radius-md)",
  cursor: "pointer",
  transition: "all 0.15s ease",
});

const dropdownItemStyle = (isDanger: boolean) => ({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  width: "100%",
  padding: "0.4rem 0.5rem",
  border: "none",
  background: "transparent",
  color: isDanger ? "var(--color-error)" : "var(--color-on-surface)",
  fontSize: "0.825rem",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  textAlign: "left" as const,
});

const detailGridStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};
