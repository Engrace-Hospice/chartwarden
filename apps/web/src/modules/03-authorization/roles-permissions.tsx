import {
  AdminSplitLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/03-authorization — Roles & Permissions (M3, Track A).
// Spec: docs/design/screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md — "Use Admin Split Layout."
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

const label = (s: string): string => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              color: "var(--color-on-surface)",
              background: r.roleId === selectedId ? "var(--color-primary-tint)" : "transparent",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{r.name}</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.3rem",
                fontSize: "0.7rem",
                color: "var(--color-on-surface-variant)",
                marginTop: "0.2rem",
              }}
            >
              <span>{label(r.category)}</span>
              {r.systemLocked ? <StatusPill label="Locked" tone="neutral" glyph="lock" /> : null}
              {r.customized ? <StatusPill label="Customized" tone="progress" /> : null}
              {!r.enabled ? <StatusPill label="Disabled" tone="neutral" /> : null}
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
        <ul style={{ columns: 2, fontSize: "0.8rem", margin: 0, padding: 0, listStyle: "none" }}>
          {role.permissionKeys.map((k) => (
            <li key={k} className="wx-data-md">
              {k}
            </li>
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
              letterSpacing: "0.03em",
              color: "var(--color-on-surface-variant)",
              margin: "0 0 0.25rem",
            }}
          >
            {label(category)}
          </h3>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.2rem 1rem",
            }}
          >
            {perms.map((p) => {
              const on = granted.has(p.key);
              return (
                <li
                  key={p.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    fontSize: "0.8rem",
                    color: on ? "var(--color-on-surface)" : "var(--color-muted)",
                  }}
                >
                  {/* §10.10 — grant state shown with a glyph partner, not color alone. */}
                  <span style={{ color: on ? "var(--color-success)" : "var(--color-muted)" }}>
                    <Glyph
                      name={on ? "check" : "dot"}
                      size={14}
                      label={on ? "granted" : "not granted"}
                    />
                  </span>
                  <span className="wx-data-md">{p.key}</span>
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
  const row = (fieldLabel: string, value: JSX.Element | string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
        {fieldLabel}
      </div>
      <div
        style={{ fontSize: "0.85rem", wordBreak: "break-word", color: "var(--color-on-surface)" }}
      >
        {value}
      </div>
    </div>
  );
  const yesNo = (on: boolean) => (
    <StatusPill label={on ? "Yes" : "No"} tone={on ? "success" : "neutral"} />
  );
  return (
    <RightDetailPanel title={role.name}>
      {row("Key", <span className="wx-data-md">{role.key}</span>)}
      {row("Category", label(role.category))}
      {row("Scope", label(role.scopeLevel))}
      {row("Source", role.organizationId ? "Tenant" : "Platform template")}
      {row("System default", yesNo(role.systemDefault))}
      {row("System locked", yesNo(role.systemLocked))}
      {row("Customized", yesNo(role.customized))}
      {row(
        "Enabled",
        <StatusPill
          label={role.enabled ? "Yes" : "No"}
          tone={role.enabled ? "success" : "error"}
        />,
      )}
      {row("Permissions", <span className="tabular-nums">{role.permissionKeys.length}</span>)}
    </RightDetailPanel>
  );
}
