import {
  LoadingSpinner,
  ReverifyLink,
  StatusPill,
  isStepUpRequired,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/02-identity — Per-member role editor (TASK-030).
// Embedded inline (expandable row) in Staff Management. Grant/revoke a role on ONE membership over the
// M3 role-assignment routes (GET/POST /memberships/:id/roles, DELETE /memberships/:id/roles/:rid, GET
// /roles for the org's catalog) — the M2 accept-invitation flow carries `proposedRoleKeys` through to
// M3 on acceptance but nothing consumes them yet (a real, separately-tracked gap), so granting a role
// today is always this manual step. The server remains authoritative: `role.assign` gates both routes,
// and M3's anti-escalation check refuses granting a permission the acting admin doesn't itself hold.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface RoleOption {
  roleId: string;
  key: string;
  name: string;
  category: string;
}

/**
 * What the server reserves to platform roles: a `platform_*` key, the exact keys `ai_safety_owner` and
 * `superadmin`, or the `platform_staff` category (isTenantRoleReserved in @chartwarden/auth). The assign route answers
 * 422 RESERVED_ROLE for every one of them, whoever asks (GAP-003): only the ticketed operator CLI binds a platform
 * role. The browser imports no server code, so the rule is mirrored here; every platform-owned row is `platform_staff`
 * today, and the 422 branch below covers a legacy row this would still offer.
 */
const PLATFORM_ROLE_CATEGORY = "platform_staff";
const RESERVED_PLATFORM_KEYS: readonly string[] = ["ai_safety_owner", "superadmin"];
const PLATFORM_HINT_ID = "member-role-editor-platform-hint";

function isPlatformRole(role: RoleOption): boolean {
  return (
    role.category === PLATFORM_ROLE_CATEGORY ||
    role.key.startsWith("platform_") ||
    RESERVED_PLATFORM_KEYS.includes(role.key)
  );
}

/** Say why a grant failed from what the server answered, not from a guess that it is always anti-escalation. */
function grantFailureMessage(status: number, code: string | undefined): string {
  if (code === "RESERVED_ROLE") {
    return "That is a platform role. ChartWarden operations grants platform roles; they cannot be assigned here.";
  }
  // Only the anti-escalation refusal says so: a 403 is also a missing `role.assign`, a step-up or an ABAC deny.
  if (code === "ESCALATION_BLOCKED") {
    return "Could not grant that role — you may not hold every permission it carries (anti-escalation).";
  }
  // The opposite remedy to FORBIDDEN: not "stop" but "sign in again recently, then retry" (a link renders beside it).
  if (code === "STEP_UP_REQUIRED") {
    return "Confirm it is you (re-authenticate), then grant the role again.";
  }
  if (status === 403) return "You are not permitted to assign roles to this member.";
  return "Could not grant that role.";
}

interface Grant {
  grantId: string;
  roleId: string;
  roleKey: string;
}

export function MemberRoleEditor({
  membershipId,
  memberLabel,
}: {
  membershipId: string;
  memberLabel: string;
}): JSX.Element {
  const client = useApiClient();
  const [catalog, setCatalog] = useState<RoleOption[] | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [rolesRes, grantsRes] = await Promise.all([
      client.GET("/api/v1/roles"),
      client.GET("/api/v1/memberships/{id}/roles", { params: { path: { id: membershipId } } }),
    ]);
    if (rolesRes.error || grantsRes.error) {
      setError("Could not load roles for this member.");
      return;
    }
    setCatalog(
      (rolesRes.data?.roles ?? []).map((r) => ({
        roleId: r.roleId,
        key: r.key,
        name: r.name,
        category: r.category,
      })),
    );
    setGrants((grantsRes.data?.roles ?? []) as Grant[]);
  }, [client, membershipId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function grant(): Promise<void> {
    if (!selectedRoleId) return;
    setBusy(true);
    setError(null);
    setStepUp(false);
    const { error: err, response } = await client.POST("/api/v1/memberships/{id}/roles", {
      params: { path: { id: membershipId } },
      body: { roleId: selectedRoleId },
    });
    setBusy(false);
    if (err) {
      const code = (err as { error?: { code?: string } }).error?.code;
      setError(grantFailureMessage(response.status, code));
      setStepUp(isStepUpRequired(err));
      return;
    }
    setSelectedRoleId("");
    void load();
  }

  async function revoke(g: Grant): Promise<void> {
    setBusy(true);
    setError(null);
    setStepUp(false);
    const { error: err } = await client.DELETE("/api/v1/memberships/{id}/roles/{rid}", {
      params: { path: { id: membershipId, rid: g.roleId } },
    });
    setBusy(false);
    if (err) {
      setError("Could not revoke that role.");
      return;
    }
    void load();
  }

  if (catalog === null || grants === null) {
    return error ? (
      <p role="alert" style={{ color: "var(--color-error)", fontSize: "0.85rem" }}>
        {error}
      </p>
    ) : (
      <LoadingSpinner />
    );
  }

  const grantedRoleIds = new Set(grants.map((g) => g.roleId));
  const available = catalog.filter((r) => !grantedRoleIds.has(r.roleId) && !isPlatformRole(r));
  const hasPlatformRoles = catalog.some(isPlatformRole);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
      <div style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
        Roles for <strong>{memberLabel}</strong>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
        {grants.length === 0 ? (
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            No roles granted.
          </span>
        ) : (
          grants.map((g) => (
            <span key={g.grantId} style={chip}>
              <StatusPill label={g.roleKey} tone="progress" />
              <button
                type="button"
                onClick={() => revoke(g)}
                disabled={busy}
                style={{ ...chipBtn }}
                aria-label={`Revoke ${g.roleKey}`}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
        <select
          value={selectedRoleId}
          onChange={(e) => setSelectedRoleId(e.target.value)}
          style={select}
          aria-label="Role to grant"
          {...(hasPlatformRoles ? { "aria-describedby": PLATFORM_HINT_ID } : {})}
        >
          <option value="">Grant a role…</option>
          {available.map((r) => (
            <option key={r.roleId} value={r.roleId}>
              {r.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={grant} disabled={busy || !selectedRoleId} style={grantBtn}>
          Grant
        </button>
        {error ? (
          <span role="alert" style={{ color: "var(--color-error)", fontSize: "0.8rem" }}>
            {error}
            {stepUp ? (
              <>
                {" "}
                <ReverifyLink>Re-verify now</ReverifyLink>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      {hasPlatformRoles ? (
        <div
          id={PLATFORM_HINT_ID}
          style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}
        >
          Platform roles are not assigned here. ChartWarden operations grants them.
        </div>
      ) : null}
    </div>
  );
}

const chip = { display: "inline-flex", alignItems: "center", gap: "0.15rem" } as const;
const chipBtn = {
  border: "none",
  background: "none",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  fontSize: "1rem",
  lineHeight: 1,
  padding: "0 0.2rem",
} as const;
const select = {
  padding: "0.3rem 0.5rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.4rem",
  fontSize: "0.85rem",
} as const;
const grantBtn = {
  padding: "0.3rem 0.75rem",
  border: "none",
  borderRadius: "0.4rem",
  background: "var(--color-primary)",
  color: "var(--color-surface-lowest)",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.85rem",
} as const;
