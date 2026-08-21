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
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — Scale-license registry, admin (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// One row per (org × scale): status chip (active / pending_renewal / expired), vendor, effective/expiry dates,
// seats. Expired licensed scales are auto-disabled for new writes (D3) — historical reads are preserved. The
// record/renew write action (§5.2) fills in as its write path hardens. Reads GET /api/v1/admin/scales/licenses
// via the typed client; the server enforces org-admin scope (ADR-0030 — no authz on the frontend). Leaves only.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { LICENSE_TONE, stateLabel } from "./assessment-status";

interface LicenseRow {
  id: string;
  scaleType: string;
  vendor: string;
  effectiveDate: string;
  expiresAt: string;
  seats: number | null;
  status: string;
}

const PAGE_SIZES = [10, 25, 50] as const;

export function ScaleLicenseRegistry(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<LicenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "pending_renewal" | "expired"
  >("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/admin/scales/licenses");
      if (!active) return;
      if (err) {
        setError("Could not load licenses.");
        setLoading(false);
        return;
      }
      setItems((data?.licenses ?? []) as LicenseRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const filtered = items.filter((license) => {
    const q = query.trim().toLowerCase();
    const matchesQuery =
      !q || license.scaleType.toLowerCase().includes(q) || license.vendor.toLowerCase().includes(q);
    const matchesStatus = statusFilter === "all" || license.status === statusFilter;
    return matchesQuery && matchesStatus;
  });
  const hasActiveFilters = query !== "" || statusFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const paged = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Scale Licenses" breadcrumb="Admin / Assessments">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review licensed clinical scales, vendor coverage, seat limits, and renewal state.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}

          <div style={toolbarStyle}>
            <div style={tabShellStyle}>
              <button type="button" style={tabButtonStyle(true)}>
                Licenses ({filtered.length})
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <div style={{ position: "relative", minWidth: "15rem" }}>
                <input
                  type="search"
                  aria-label="Search licenses"
                  placeholder="Search scale or vendor..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                  style={{
                    width: "100%",
                    paddingLeft: "2rem",
                    height: "2.25rem",
                    fontSize: "0.85rem",
                  }}
                />
                <div style={searchIconStyle}>
                  <Glyph name="search" size={14} />
                </div>
              </div>
              <select
                aria-label="Filter by license status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as typeof statusFilter);
                  setPage(1);
                }}
                style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
              >
                <option value="all">Status: All</option>
                <option value="active">Active</option>
                <option value="pending_renewal">Pending renewal</option>
                <option value="expired">Expired</option>
              </select>
              {hasActiveFilters ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                    setPage(1);
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No licenses"
              description="No scale licenses are recorded for this organization."
            />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No matching licenses"
              description="Try adjusting the scale, vendor, or status filters."
              action={
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                    setPage(1);
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem 1.5rem" }}>
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeaderRowStyle}>
                  <th style={{ ...thStyle, width: "24%" }}>Scale</th>
                  <th style={{ ...thStyle, width: "24%" }}>Vendor</th>
                  <th style={{ ...thStyle, width: "14%" }}>Effective</th>
                  <th style={{ ...thStyle, width: "14%" }}>Expires</th>
                  <th style={{ ...thStyle, width: "10%" }}>Seats</th>
                  <th style={{ ...thStyle, width: "14%" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((license) => (
                  <tr
                    key={license.id}
                    style={{ ...tableRowStyle, opacity: license.status === "expired" ? 0.66 : 1 }}
                  >
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>
                        {formatScale(license.scaleType)}
                      </div>
                      <div className="wx-data-md" style={mutedCodeStyle}>
                        {license.scaleType}
                      </div>
                    </td>
                    <td style={tdStyle}>{license.vendor}</td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDate(license.effectiveDate)}
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDate(license.expiresAt)}
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {license.seats ?? "—"}
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={stateLabel(license.status)}
                        tone={LICENSE_TONE[license.status] ?? "neutral"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="licenses"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function formatScale(scaleType: string): string {
  return scaleType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10) || "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};

const tabShellStyle = {
  display: "flex",
  gap: "0.25rem",
  background: "var(--color-surface-container)",
  padding: "0.2rem",
  borderRadius: "var(--radius-md)",
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
  cursor: "default",
  transition: "all 0.15s ease",
});

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

const searchIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none" as const,
};

const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};

const tableHeaderRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const tableRowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

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

const mutedCodeStyle = {
  display: "block",
  marginTop: "0.2rem",
  maxWidth: "18rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
