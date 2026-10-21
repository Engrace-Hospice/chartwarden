import { LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
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
      (rolesRes.data?.roles ?? []).map((r) => ({ roleId: r.roleId, key: r.key, name: r.name })),
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
    const { error: err } = await client.POST("/api/v1/memberships/{id}/roles", {
      params: { path: { id: membershipId } },
      body: { roleId: selectedRoleId },
    });
    setBusy(false);
    if (err) {
      setError(
        "Could not grant that role — you may not hold every permission it carries (anti-escalation).",
      );
      return;
    }
    setSelectedRoleId("");
    void load();
  }

  async function revoke(g: Grant): Promise<void> {
    setBusy(true);
    setError(null);
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
  const available = catalog.filter((r) => !grantedRoleIds.has(r.roleId));

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
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <select
          value={selectedRoleId}
          onChange={(e) => setSelectedRoleId(e.target.value)}
          style={select}
          aria-label="Role to grant"
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
          </span>
        ) : null}
      </div>
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
