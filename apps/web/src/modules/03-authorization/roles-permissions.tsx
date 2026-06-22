import {
  AdminSplitLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/03-authorization — Roles & Permissions (M3, Track A).
// Spec: docs/ui/screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md — "Use Admin Split Layout."
// Roles list | the selected role's permission matrix (grouped by catalog category) | right detail.
// Backed by GET /api/v1/roles + GET /api/v1/permissions via the generated typed client. Read-only
// in this first cut (edit/clone is a follow-up). Imports only leaves (@wardenx/ui).
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

interface RoleView {
  roleId: string;
  organizationId: string | null;
  key: string;
  name: string;
  category: string;
  scopeLevel: string;
  systemDefault: boolean;
  systemLocked: boolean;
  enabled: boolean;
  customized: boolean;
  permissionKeys: string[];
}
interface PermissionRow {
  key: string;
  resource: string;
  action: string;
  category: string;
}

export function RolesPermissions(): JSX.Element {
  const client = useApiClient();
  const [roles, setRoles] = useState<RoleView[] | null>(null);
  const [catalog, setCatalog] = useState<PermissionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [rolesRes, permsRes] = await Promise.all([
        client.GET("/api/v1/roles"),
        client.GET("/api/v1/permissions"),
      ]);
      if (!active) return;
      if (rolesRes.error || permsRes.error) {
        setError("Could not load roles or the permission catalog.");
        return;
      }
      const list = (rolesRes.data?.roles ?? []) as RoleView[];
      setRoles(list);
      setCatalog((permsRes.data?.permissions ?? []) as PermissionRow[]);
      setSelectedId((prev) => prev ?? list[0]?.roleId ?? null);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const selected = roles?.find((r) => r.roleId === selectedId) ?? null;

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (roles === null) return <LoadingSpinner />;

  return (
    <AdminSplitLayout
      header={<PageHeader title="Roles & Permissions" />}
      list={<RoleList roles={roles} selectedId={selectedId} onSelect={setSelectedId} />}
      detail={selected ? <RoleDetail role={selected} /> : undefined}
    >
      {selected ? (
        <PermissionMatrix role={selected} catalog={catalog} />
      ) : (
        <EmptyState title="Select a role" description="Pick a role to view its permissions." />
      )}
    </AdminSplitLayout>
  );
}

function RoleList({
  roles,
  selectedId,
  onSelect,
}: { roles: RoleView[]; selectedId: string | null; onSelect: (id: string) => void }): JSX.Element {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: "0.5rem" }}>
      {roles.map((r) => (
        <li key={r.roleId}>
          <button
            type="button"
            onClick={() => onSelect(r.roleId)}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "0.5rem 0.625rem",
              border: "none",
              borderRadius: "0.375rem",
              cursor: "pointer",
              background: r.roleId === selectedId ? "#eff6ff" : "transparent",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{r.name}</div>
            <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>
              {r.category}
              {r.systemLocked ? " · locked" : ""}
              {r.customized ? " · customized" : ""}
              {!r.enabled ? " · disabled" : ""}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PermissionMatrix({
  role,
  catalog,
}: { role: RoleView; catalog: PermissionRow[] }): JSX.Element {
  const granted = useMemo(() => new Set(role.permissionKeys), [role]);
  // Group the catalog by category; show which permissions this role grants.
  const byCategory = useMemo(() => {
    const m = new Map<string, PermissionRow[]>();
    for (const p of catalog) {
      const arr = m.get(p.category) ?? [];
      arr.push(p);
      m.set(p.category, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog]);

  if (catalog.length === 0) {
    // No catalog → just list the granted keys.
    return (
      <div>
        <h2 style={{ marginTop: 0, fontSize: "1rem" }}>
          {role.name} — permissions ({role.permissionKeys.length})
        </h2>
        <ul style={{ columns: 2, fontSize: "0.8rem", fontFamily: "monospace" }}>
          {role.permissionKeys.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: "1rem" }}>
        {role.name} — {granted.size} of {catalog.length} permissions
      </h2>
      {byCategory.map(([category, perms]) => (
        <section key={category} style={{ marginBottom: "1rem" }}>
          <h3
            style={{
              fontSize: "0.8rem",
              textTransform: "uppercase",
              color: "#6b7280",
              margin: "0 0 0.25rem",
            }}
          >
            {category}
          </h3>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.15rem 1rem",
            }}
          >
            {perms.map((p) => {
              const on = granted.has(p.key);
              return (
                <li key={p.key} style={{ fontSize: "0.8rem", color: on ? "#111827" : "#9ca3af" }}>
                  <span aria-hidden style={{ marginRight: "0.4rem" }}>
                    {on ? "✓" : "○"}
                  </span>
                  <span style={{ fontFamily: "monospace" }}>{p.key}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function RoleDetail({ role }: { role: RoleView }): JSX.Element {
  const row = (label: string, value: string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: "0.85rem", wordBreak: "break-word" }}>{value}</div>
    </div>
  );
  return (
    <RightDetailPanel title={role.name}>
      {row("Key", role.key)}
      {row("Category", role.category)}
      {row("Scope", role.scopeLevel)}
      {row("Source", role.organizationId ? "tenant" : "platform template")}
      {row("System default", role.systemDefault ? "yes" : "no")}
      {row("System locked", role.systemLocked ? "yes" : "no")}
      {row("Customized", role.customized ? "yes" : "no")}
      {row("Enabled", role.enabled ? "yes" : "no")}
      {row("Permissions", String(role.permissionKeys.length))}
    </RightDetailPanel>
  );
}
