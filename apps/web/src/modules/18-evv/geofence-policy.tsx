import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/18-evv — Geofence Policy (M18 §5.1 `/app/evv/geofence-policy`, Track B / ADR-0030).
// Tenant tighten-only defaults sit above the 200m / 50m platform floor; per-address overrides stay
// coordinate-free.
//
// #91 — the two §2.2.2 D3 policy writes are here now. These numbers decide whether a capture reads `pass`
// or `outside_geofence`, which is what puts a visit into the missing-EVV queue in the first place. A rural
// address whose driveway sits 180m from its road-network centroid produces a FALSE breach on every single
// visit there, forever, until someone records an override — and until this, nobody could.
//
// The SERVER owns tighten-only (§2.2.2) and answers 422; this surface states the floor beside the fields
// and does not enforce it, so a floor this build has stale numbers for cannot lock someone out of a legal
// edit (ADR-0030 — no frontend authz).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { GeofencePolicyView as PolicyWire } from "./evv-api";
import { PerAddressOverrideModal, TenantPolicyModal } from "./evv-modals";

interface OverrideRow {
  patientAddressId: string;
  radiusM: number;
  maxAccuracyM: number;
}
interface GeofencePolicyView {
  tenant: { radiusM: number; maxAccuracyM: number };
  perAddress: OverrideRow[];
}

const PLATFORM_RADIUS_FLOOR = 200;
const PLATFORM_ACCURACY_FLOOR = 50;
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function EvvGeofencePolicy(): JSX.Element {
  const client = useApiClient();
  const [policy, setPolicy] = useState<GeofencePolicyView | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [radiusFilter, setRadiusFilter] = useState<"all" | "tighter" | "default">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingTenant, setEditingTenant] = useState(false);
  const [addingOverride, setAddingOverride] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/geofence-policy", {});
    if (err) {
      setError("Could not load the geofence policy.");
      setLoading(false);
      return;
    }
    setPolicy((data ?? null) as GeofencePolicyView | null);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const overrides = policy?.perAddress ?? [];
  const tenantRadius = policy?.tenant.radiusM ?? null;
  const tenantAccuracy = policy?.tenant.maxAccuracyM ?? null;
  const filteredOverrides = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return overrides.filter((row) => {
      const isTighter =
        (tenantRadius !== null && row.radiusM < tenantRadius) ||
        (tenantAccuracy !== null && row.maxAccuracyM < tenantAccuracy);
      const matchesRadius =
        radiusFilter === "all" || (radiusFilter === "tighter" ? isTighter : !isTighter);
      const matchesSearch =
        !q ||
        row.patientAddressId.toLowerCase().includes(q) ||
        String(row.radiusM).includes(q) ||
        String(row.maxAccuracyM).includes(q);
      return matchesRadius && matchesSearch;
    });
  }, [overrides, radiusFilter, searchQuery, tenantAccuracy, tenantRadius]);
  const sortedOverrides = useMemo(
    () =>
      [...filteredOverrides].sort(
        (a, b) => a.radiusM - b.radiusM || a.maxAccuracyM - b.maxAccuracyM,
      ),
    [filteredOverrides],
  );
  const activePage = Math.min(page, Math.max(1, Math.ceil(sortedOverrides.length / pageSize)));
  const pagedOverrides = sortedOverrides.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [searchQuery.trim() !== "", radiusFilter !== "all"].filter(Boolean).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setRadiusFilter("all");
    setPage(1);
  };

  const applyPolicy = (next: PolicyWire): void => {
    setPolicy(next as GeofencePolicyView);
  };

  return (
    <>
      <TenantPolicyModal
        open={editingTenant}
        radiusM={tenantRadius ?? PLATFORM_RADIUS_FLOOR}
        maxAccuracyM={tenantAccuracy ?? PLATFORM_ACCURACY_FLOOR}
        onClose={() => setEditingTenant(false)}
        onSaved={applyPolicy}
      />
      <PerAddressOverrideModal
        open={addingOverride}
        onClose={() => setAddingOverride(false)}
        onSaved={applyPolicy}
      />
      <WorkQueueLayout
        header={
          <PageHeader
            title="Geofence Policy"
            breadcrumb="Admin / EVV"
            actions={
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <Button
                  type="button"
                  tone="secondary"
                  onClick={() => void load()}
                  loading={loading}
                >
                  Refresh
                </Button>
                <Button type="button" tone="tertiary" onClick={() => setAddingOverride(true)}>
                  Add override
                </Button>
                <Button type="button" onClick={() => setEditingTenant(true)}>
                  Edit tenant policy
                </Button>
              </div>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review tenant geofence defaults and address-specific tighten-only overrides.
            </div>
          </PageHeader>
        }
        filters={
          <div style={filterShellStyle}>
            {error ? (
              <div role="alert" style={errorBannerStyle}>
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                  x
                </button>
              </div>
            ) : null}
            <div role="note" style={noteStyle}>
              <StatusPill label="Coordinate-free" tone="success" />
              <span>
                This policy view returns address policy identifiers and thresholds only; lat/lng
                reads stay behind the separate EVV coordinate permission.
              </span>
            </div>
            <div style={toolbarStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>Per-address overrides</span>
                <strong>{sortedOverrides.length} matching overrides</strong>
              </div>
              <div style={controlGroupStyle}>
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    placeholder="Search address policy or threshold..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search geofence overrides"
                  />
                </label>
                <label className="wx-filter-field">
                  <span>Overrides</span>
                  <select
                    className="wx-select"
                    aria-label="Override tightness"
                    value={radiusFilter}
                    onChange={(e) => {
                      setRadiusFilter(e.target.value as typeof radiusFilter);
                      setPage(1);
                    }}
                    style={selectStyle}
                  >
                    <option value="all">All</option>
                    <option value="tighter">Tighter than tenant</option>
                    <option value="default">Tenant-equivalent</option>
                  </select>
                </label>
                {activeFilters > 0 ? (
                  <Button size="sm" tone="tertiary" onClick={clearFilters}>
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        }
        table={
          error && !policy ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState title="Unavailable" description={error} />
            </div>
          ) : loading || !policy ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : (
            <div style={tableWrapStyle}>
              <section style={tenantBandStyle}>
                <div style={tenantMetricStyle}>
                  <span style={tenantLabelStyle}>Tenant default radius</span>
                  <strong className="tabular-nums">{policy.tenant.radiusM} m</strong>
                </div>
                <div style={tenantMetricStyle}>
                  <span style={tenantLabelStyle}>Tenant max accuracy</span>
                  <strong className="tabular-nums">{policy.tenant.maxAccuracyM} m</strong>
                </div>
                <div style={tenantMetricStyle}>
                  <span style={tenantLabelStyle}>Platform floor</span>
                  <strong className="tabular-nums">
                    {PLATFORM_RADIUS_FLOOR} m / {PLATFORM_ACCURACY_FLOOR} m
                  </strong>
                </div>
              </section>
              {sortedOverrides.length === 0 ? (
                <div style={{ padding: "2rem 0" }}>
                  <EmptyState
                    title={activeFilters > 0 ? "No matching overrides" : "No overrides"}
                    description={
                      activeFilters > 0
                        ? "Try adjusting the override filters."
                        : "No per-patient-address geofence overrides are configured."
                    }
                    action={
                      activeFilters > 0 ? (
                        <Button size="sm" tone="secondary" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <>
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headerRowStyle}>
                        <th style={{ ...thStyle, width: "42%" }}>Patient address policy</th>
                        <th style={{ ...thStyle, width: "18%" }}>Radius</th>
                        <th style={{ ...thStyle, width: "20%" }}>Max accuracy</th>
                        <th style={{ ...thStyle, width: "20%", textAlign: "right" }}>Tightness</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedOverrides.map((row) => {
                        const tighter =
                          row.radiusM < policy.tenant.radiusM ||
                          row.maxAccuracyM < policy.tenant.maxAccuracyM;
                        return (
                          <tr key={row.patientAddressId} style={rowStyle}>
                            <td style={tdStyle}>
                              <code className="wx-data-md" style={codeStyle}>
                                {shortId(row.patientAddressId)}
                              </code>
                            </td>
                            <td className="tabular-nums" style={tdStyle}>
                              {row.radiusM} m
                            </td>
                            <td className="tabular-nums" style={tdStyle}>
                              {row.maxAccuracyM} m
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right" }}>
                              <StatusPill
                                label={tighter ? "Tighter" : "Tenant-equivalent"}
                                tone={tighter ? "success" : "neutral"}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <OffsetPagination
                    page={activePage}
                    pageSize={pageSize}
                    totalItems={sortedOverrides.length}
                    onPageChange={setPage}
                    onPageSizeChange={(nextPageSize) => {
                      setPageSize(nextPageSize);
                      setPage(1);
                    }}
                    pageSizeOptions={PAGE_SIZES}
                    noun="overrides"
                  />
                </>
              )}
            </div>
          )
        }
        fullPageScroll
      />
    </>
  );
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
}

const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};
const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const toolbarTitleStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const toolbarEyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const searchWrapStyle = { minWidth: "16rem" };
const searchInputStyle = { width: "100%", height: "2.25rem", fontSize: "0.85rem" };
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};
const dismissButtonStyle = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};
const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem 1.5rem",
};
const tenantBandStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: "0.75rem",
  marginBottom: "1rem",
};
const tenantMetricStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  padding: "0.75rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};
const tenantLabelStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const codeStyle = {
  display: "inline-block",
  maxWidth: "14rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
