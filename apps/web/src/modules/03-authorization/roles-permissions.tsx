import {
  AdminSplitLayout,
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/03-authorization — Roles & Permissions (M3, Track A).
// Read-only by design: this screen refines presentation and local discovery only. M3 remains
// authoritative for the existing GET /roles and GET /permissions data sources.
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

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

const label = (value: string): string =>
  value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

export function RolesPermissions(): JSX.Element {
  const client = useApiClient();
  const [roles, setRoles] = useState<RoleView[] | null>(null);
  const [catalog, setCatalog] = useState<PermissionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "platform" | "organization">("all");
  const [status, setStatus] = useState<"all" | "enabled" | "disabled">("all");

  useEffect(() => {
    let active = true;
    void Promise.all([client.GET("/api/v1/roles"), client.GET("/api/v1/permissions")]).then(
      ([rolesRes, permissionsRes]) => {
        if (!active) return;
        if (rolesRes.error || permissionsRes.error) {
          setError("Could not load roles or the permission catalog.");
          return;
        }
        const result = (rolesRes.data?.roles ?? []) as RoleView[];
        setRoles(result);
        setCatalog((permissionsRes.data?.permissions ?? []) as PermissionRow[]);
        setSelectedId((current) => current ?? result[0]?.roleId ?? null);
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (roles ?? []).filter((role) => {
      const matchesSearch =
        !search ||
        [role.name, role.key, role.category].some((part) => part.toLowerCase().includes(search));
      const matchesSource =
        source === "all" ||
        (source === "organization" ? role.organizationId !== null : role.organizationId === null);
      const matchesStatus =
        status === "all" || (status === "enabled" ? role.enabled : !role.enabled);
      return matchesSearch && matchesSource && matchesStatus;
    });
  }, [query, roles, source, status]);

  const selected = roles?.find((role) => role.roleId === selectedId) ?? null;
  const enabled = roles?.filter((role) => role.enabled).length ?? 0;
  const organizationRoles = roles?.filter((role) => role.organizationId !== null).length ?? 0;
  const customized = roles?.filter((role) => role.customized).length ?? 0;
  const filtersApplied = Boolean(query) || source !== "all" || status !== "all";

  if (error) return <EmptyState title="Roles unavailable" description={error} />;
  if (roles === null) return <LoadingSpinner />;

  return (
    <AdminSplitLayout
      header={
        <>
          <PageHeader title="Roles & Permissions" breadcrumb="Admin / Access control">
            <p style={subtitle}>
              Review role access and permission coverage across your organization.
            </p>
          </PageHeader>
          <KpiStrip>
            <Metric
              accent="var(--color-primary)"
              label="Total roles"
              value={roles.length}
              detail="Access profiles"
              tone="info"
            />
            <Metric
              accent="var(--color-success)"
              label="Enabled roles"
              value={enabled}
              detail="Available for assignment"
              tone="success"
            />
            <Metric
              accent={
                organizationRoles > 0 ? "var(--color-primary)" : "var(--color-outline-variant)"
              }
              label="Organization roles"
              value={organizationRoles}
              detail="Tenant-specific access"
              tone={organizationRoles > 0 ? "info" : "neutral"}
            />
            <Metric
              accent={customized > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
              label="Customized"
              value={customized}
              detail="Modified from template"
              tone={customized > 0 ? "warning" : "neutral"}
            />
          </KpiStrip>
        </>
      }
      list={
        <RoleList
          roles={filtered}
          selectedId={selectedId}
          query={query}
          source={source}
          status={status}
          filtersApplied={filtersApplied}
          onQuery={setQuery}
          onSource={setSource}
          onStatus={setStatus}
          onClear={() => {
            setQuery("");
            setSource("all");
            setStatus("all");
          }}
          onSelect={setSelectedId}
        />
      }
      detail={selected ? <RoleDetail role={selected} /> : undefined}
      className="wx-roles-workspace"
      fullPageScroll
    >
      {selected ? (
        <PermissionMatrix role={selected} catalog={catalog} />
      ) : (
        <EmptyState
          title="Select a role"
          description="Pick a role to review its permission coverage."
        />
      )}
    </AdminSplitLayout>
  );
}

function Metric({
  accent,
  label: metricLabel,
  value,
  detail,
  tone,
}: {
  accent: string;
  label: string;
  value: number;
  detail: string;
  tone: "neutral" | "info" | "success" | "warning";
}): JSX.Element {
  return (
    <div style={{ borderLeft: `3px solid ${accent}`, borderRadius: "var(--radius-xl)" }}>
      <KpiCard label={metricLabel} value={value} detail={detail} tone={tone} />
    </div>
  );
}

function RoleList({
  roles,
  selectedId,
  query,
  source,
  status,
  filtersApplied,
  onQuery,
  onSource,
  onStatus,
  onClear,
  onSelect,
}: {
  roles: RoleView[];
  selectedId: string | null;
  query: string;
  source: "all" | "platform" | "organization";
  status: "all" | "enabled" | "disabled";
  filtersApplied: boolean;
  onQuery: (value: string) => void;
  onSource: (value: "all" | "platform" | "organization") => void;
  onStatus: (value: "all" | "enabled" | "disabled") => void;
  onClear: () => void;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <section
      aria-label="Roles"
      style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}
    >
      <div style={listToolbar}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "start",
            gap: "0.5rem",
          }}
        >
          <div>
            <h2 style={listTitle}>Roles</h2>
            <p style={listDescription}>
              {roles.length} matching access profile{roles.length === 1 ? "" : "s"}
            </p>
          </div>
          {filtersApplied ? (
            <Button tone="tertiary" size="sm" onClick={onClear}>
              Reset
            </Button>
          ) : null}
        </div>
        <label style={{ position: "relative", display: "block" }}>
          <span className="wx-sr-only">Search roles</span>
          <span aria-hidden style={searchIcon}>
            <Glyph name="search" size={14} />
          </span>
          <input
            type="search"
            value={query}
            placeholder="Search roles..."
            onChange={(event) => onQuery(event.target.value)}
            style={searchInput}
          />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
          <select
            aria-label="Filter by role source"
            value={source}
            onChange={(event) =>
              onSource(event.target.value as "all" | "platform" | "organization")
            }
            style={selectStyle}
          >
            <option value="all">All sources</option>
            <option value="platform">Platform</option>
            <option value="organization">Organization</option>
          </select>
          <select
            aria-label="Filter by role status"
            value={status}
            onChange={(event) => onStatus(event.target.value as "all" | "enabled" | "disabled")}
            style={selectStyle}
          >
            <option value="all">All states</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      </div>
      {roles.length === 0 ? (
        <div style={{ padding: "1.5rem 1rem" }}>
          <EmptyState
            title="No roles found"
            description="Try changing the search or filter criteria."
          />
        </div>
      ) : (
        <ul
          className="wx-roles-role-list wx-no-scrollbar"
          style={{ listStyle: "none", margin: 0, padding: "0.5rem" }}
        >
          {roles.map((role) => (
            <li key={role.roleId}>
              <button
                type="button"
                aria-pressed={selectedId === role.roleId}
                onClick={() => onSelect(role.roleId)}
                style={{
                  ...roleItem,
                  background:
                    selectedId === role.roleId ? "var(--color-primary-tint)" : "transparent",
                }}
              >
                <span style={avatar}>{role.name.slice(0, 1).toUpperCase()}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={roleName}>{role.name}</span>
                  <code style={roleKey}>{role.key}</code>
                  <span
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.25rem",
                      marginTop: "0.4rem",
                    }}
                  >
                    <StatusPill
                      label={role.enabled ? "Enabled" : "Disabled"}
                      tone={role.enabled ? "success" : "neutral"}
                    />
                    {role.systemLocked ? (
                      <StatusPill label="Locked" tone="neutral" glyph="lock" />
                    ) : null}
                    {role.customized ? <StatusPill label="Customized" tone="progress" /> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PermissionMatrix({
  role,
  catalog,
}: { role: RoleView; catalog: PermissionRow[] }): JSX.Element {
  const matrixRef = useRef<HTMLElement>(null);
  const [permissionQuery, setPermissionQuery] = useState("");
  const [grantFilter, setGrantFilter] = useState<"all" | "granted" | "not-granted">("all");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const granted = useMemo(() => new Set(role.permissionKeys), [role]);
  const groups = useMemo(() => {
    const result = new Map<string, PermissionRow[]>();
    for (const permission of catalog)
      result.set(permission.category, [...(result.get(permission.category) ?? []), permission]);
    return [...result.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [catalog]);
  const filteredGroups = useMemo(() => {
    const search = permissionQuery.trim().toLowerCase();
    return groups
      .map(
        ([category, permissions]) =>
          [
            category,
            permissions.filter((permission) => {
              const isGranted = granted.has(permission.key);
              const matchesSearch =
                !search ||
                [permission.key, permission.resource, permission.action].some((value) =>
                  value.toLowerCase().includes(search),
                );
              const matchesGrant =
                grantFilter === "all" || (grantFilter === "granted" ? isGranted : !isGranted);
              return matchesSearch && matchesGrant;
            }),
          ] as const,
      )
      .filter(([, permissions]) => permissions.length > 0);
  }, [grantFilter, granted, groups, permissionQuery]);

  // A role switch must not leave the operator partway through the previous role's permission list.
  useEffect(() => {
    if (!role.roleId) return;
    matrixRef.current?.closest<HTMLElement>(".wx-admin-matrix")?.scrollTo({ top: 0 });
    setPermissionQuery("");
    setGrantFilter("all");
    setExpandedCategories(new Set(groups.slice(0, 1).map(([category]) => category)));
  }, [groups, role.roleId]);

  const percent = catalog.length ? Math.round((granted.size / catalog.length) * 100) : null;
  return (
    <section
      ref={matrixRef}
      className="wx-roles-permission-matrix"
      aria-labelledby="role-permissions"
      style={{ maxWidth: "70rem" }}
    >
      <div style={matrixHeader}>
        <div>
          <p style={eyebrow}>Access profile</p>
          <h2 id="role-permissions" style={matrixTitle}>
            {role.name}
          </h2>
          <p style={matrixDescription}>
            Review the permissions granted by this role. Editing is not available in this view.
          </p>
        </div>
        <div style={coverage}>
          <span style={mutedText}>Permission coverage</span>
          <strong style={{ fontSize: "1.25rem", fontVariantNumeric: "tabular-nums" }}>
            {granted.size}
            {catalog.length ? ` / ${catalog.length}` : ""}
          </strong>
          {percent !== null ? (
            <span style={{ color: "var(--color-primary)", fontSize: "0.875rem", fontWeight: 700 }}>
              {percent}% of catalog
            </span>
          ) : null}
        </div>
        <div style={permissionToolbar}>
          <label style={{ position: "relative", flex: "1 1 14rem" }}>
            <span className="wx-sr-only">Search permissions</span>
            <span aria-hidden style={searchIcon}>
              <Glyph name="search" size={14} />
            </span>
            <input
              type="search"
              value={permissionQuery}
              placeholder="Search permissions..."
              onChange={(event) => setPermissionQuery(event.target.value)}
              style={searchInput}
            />
          </label>
          <select
            aria-label="Filter by grant status"
            value={grantFilter}
            onChange={(event) =>
              setGrantFilter(event.target.value as "all" | "granted" | "not-granted")
            }
            style={{ ...selectStyle, flex: "0 1 10rem" }}
          >
            <option value="all">All permissions</option>
            <option value="granted">Granted</option>
            <option value="not-granted">Not granted</option>
          </select>
        </div>
      </div>
      {catalog.length === 0 ? (
        <PermissionList
          permissions={role.permissionKeys.map((key) => ({ key, resource: "", action: "" }))}
          granted={granted}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {filteredGroups.length === 0 ? (
            <EmptyState
              title="No permissions found"
              description="Try another search term or clear the grant filter."
            />
          ) : null}
          {filteredGroups.map(([category, permissions]) => {
            const count = permissions.filter((permission) => granted.has(permission.key)).length;
            const expanded = permissionQuery !== "" || expandedCategories.has(category);
            return (
              <section key={category} style={permissionGroup}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedCategories((current) => {
                      const next = new Set(current);
                      if (next.has(category)) next.delete(category);
                      else next.add(category);
                      return next;
                    })
                  }
                  style={groupHeader}
                >
                  <div>
                    <h3
                      style={{ margin: 0, fontSize: "0.9rem", color: "var(--color-on-surface)" }}
                    >
                      {label(category)}
                    </h3>
                    <p style={listDescription}>
                      {count} of {permissions.length} granted
                    </p>
                  </div>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <StatusPill label={`${count} / ${permissions.length}`} tone="progress" />
                    <span aria-hidden style={{ color: "var(--color-primary)", fontSize: "1rem" }}>
                      {expanded ? "⌄" : "›"}
                    </span>
                  </span>
                </button>
                {expanded ? <PermissionList permissions={permissions} granted={granted} /> : null}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PermissionList({
  permissions,
  granted,
}: {
  permissions: Array<Pick<PermissionRow, "key" | "resource" | "action">>;
  granted: Set<string>;
}): JSX.Element {
  return (
    <ul style={permissionGrid}>
      {permissions.map((permission) => {
        const isGranted = granted.has(permission.key);
        return (
          <li
            key={permission.key}
            style={{
              ...permissionItem,
              background: isGranted
                ? "color-mix(in srgb, var(--color-success) 7%, var(--color-surface-lowest))"
                : "transparent",
            }}
          >
            <span style={{ color: isGranted ? "var(--color-success)" : "var(--color-muted)" }}>
              <Glyph
                name={isGranted ? "check" : "dot"}
                size={15}
                label={isGranted ? "Granted" : "Not granted"}
              />
            </span>
            <span>
              <code
                className="wx-data-md"
                style={{ color: isGranted ? "var(--color-on-surface)" : "var(--color-muted)" }}
              >
                {permission.key}
              </code>
              {permission.resource ? (
                <span style={permissionMeta}>
                  {label(permission.resource)} · {label(permission.action)}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RoleDetail({ role }: { role: RoleView }): JSX.Element {
  return (
    <RightDetailPanel title="Role details" hideScrollbar>
      <div
        style={{ display: "flex", flexDirection: "column", gap: "1.25rem", paddingTop: "0.25rem" }}
      >
        <div style={detailHero}>
          <span style={{ ...avatar, width: "2.75rem", height: "2.75rem", fontSize: "1rem" }}>
            {role.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h2 style={{ margin: 0, fontSize: "1rem", color: "var(--color-on-surface)" }}>
              {role.name}
            </h2>
            <code className="wx-data-md" style={mutedText}>
              {role.key}
            </code>
          </div>
        </div>
        <DetailSection title="Role profile">
          <DetailRow label="Category" value={label(role.category)} />
          <DetailRow label="Scope" value={label(role.scopeLevel)} />
          <DetailRow
            label="Source"
            value={role.organizationId ? "Organization role" : "Platform template"}
          />
          <DetailRow label="Permissions" value={String(role.permissionKeys.length)} />
        </DetailSection>
        <DetailSection title="Access state">
          <DetailRow
            label="Assignment status"
            value={
              <StatusPill
                label={role.enabled ? "Enabled" : "Disabled"}
                tone={role.enabled ? "success" : "neutral"}
              />
            }
          />
          <DetailRow
            label="Template"
            value={
              <StatusPill
                label={role.systemDefault ? "Default" : "Custom"}
                tone={role.systemDefault ? "progress" : "neutral"}
              />
            }
          />
          <DetailRow
            label="Protection"
            value={
              <StatusPill
                label={role.systemLocked ? "Locked" : "No lock"}
                tone={role.systemLocked ? "neutral" : "success"}
                glyph={role.systemLocked ? "lock" : undefined}
              />
            }
          />
          {role.customized ? (
            <DetailRow
              label="Configuration"
              value={<StatusPill label="Customized" tone="warning" />}
            />
          ) : null}
        </DetailSection>
      </div>
    </RightDetailPanel>
  );
}
function DetailSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <h3 style={sectionTitle}>{title}</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>{children}</div>
    </section>
  );
}
function DetailRow({
  label: rowLabel,
  value,
}: { label: string; value: JSX.Element | string }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "0.75rem",
      }}
    >
      <span style={mutedText}>{rowLabel}</span>
      <span
        style={{
          color: "var(--color-on-surface)",
          fontSize: "0.82rem",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

const subtitle = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
} as const;
const listToolbar = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "1rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
} as const;
const listTitle = { margin: 0, fontSize: "1rem", color: "var(--color-on-surface)" } as const;
const listDescription = {
  margin: "0.2rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
} as const;
const searchIcon = {
  position: "absolute",
  left: "0.625rem",
  top: 0,
  bottom: 0,
  display: "flex",
  alignItems: "center",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none",
} as const;
const searchInput = {
  width: "100%",
  height: "2.25rem",
  paddingLeft: "2rem",
  fontSize: "0.82rem",
} as const;
const selectStyle = {
  width: "100%",
  height: "2.125rem",
  cursor: "pointer",
  fontSize: "0.78rem",
} as const;
const roleItem = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.625rem",
  width: "100%",
  padding: "0.75rem",
  border: "none",
  borderRadius: "var(--radius-md)",
  color: "var(--color-on-surface)",
  textAlign: "left",
  cursor: "pointer",
} as const;
const avatar = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "2rem",
  height: "2rem",
  flexShrink: 0,
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  fontWeight: 700,
  fontSize: "0.78rem",
} as const;
const roleName = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "0.84rem",
  fontWeight: 650,
} as const;
const roleKey = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  marginTop: "0.15rem",
  color: "var(--color-on-surface-variant)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.68rem",
} as const;
const matrixHeader = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  marginBottom: "1.5rem",
  paddingBottom: "1.25rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
} as const;
const eyebrow = {
  margin: "0 0 0.3rem",
  color: "var(--color-primary)",
  fontSize: "0.7rem",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
} as const;
const matrixTitle = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-display)",
  fontSize: "1.5rem",
  fontWeight: 550,
} as const;
const matrixDescription = {
  maxWidth: "38rem",
  margin: "0.4rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.84rem",
} as const;
const coverage = {
  display: "flex",
  flexDirection: "column",
  minWidth: "9rem",
  padding: "0.75rem 1rem",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
} as const;
const permissionToolbar = {
  display: "flex",
  flex: "1 1 100%",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
  paddingTop: "0.25rem",
} as const;
const mutedText = { color: "var(--color-on-surface-variant)", fontSize: "0.75rem" } as const;
const permissionGroup = {
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
  overflow: "hidden",
} as const;
const groupHeader = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  width: "100%",
  padding: "0.875rem 1rem",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  textAlign: "left",
  cursor: "pointer",
} as const;
const permissionGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
  gap: "0.5rem",
  listStyle: "none",
  margin: 0,
  padding: "0.75rem 1rem 1rem",
} as const;
const permissionItem = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.5rem",
  minWidth: 0,
  padding: "0.55rem 0.6rem",
  borderRadius: "var(--radius-sm)",
  fontSize: "0.76rem",
} as const;
const permissionMeta = {
  display: "block",
  marginTop: "0.2rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.68rem",
} as const;
const detailHero = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  paddingBottom: "1rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
} as const;
const sectionTitle = {
  margin: "0 0 0.625rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
} as const;
