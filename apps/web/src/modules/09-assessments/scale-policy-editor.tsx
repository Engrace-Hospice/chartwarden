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
// apps/web/src/modules/09-assessments — Scale-policy editor, admin (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// Per-scale enable/disable state. The threshold/cadence tuners (platform floor read-only · tenant override
// floor-enforced both client- and server-side, §5.2) fill in with the policy write surface; this read view shows
// the enabled state per scale. Reads GET /api/v1/admin/scales/policies via the typed client; the server enforces
// org-admin scope and the floor (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";

interface PolicyRow {
  scaleType: string;
  enabled: boolean;
}

const PAGE_SIZES = [10, 25, 50] as const;

export function ScalePolicyEditor(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<PolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/admin/scales/policies");
      if (!active) return;
      if (err) {
        setError("Could not load scale policies.");
        setLoading(false);
        return;
      }
      setItems((data?.policies ?? []) as PolicyRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const filtered = items.filter((policy) => {
    const q = query.trim().toLowerCase();
    const matchesQuery = !q || policy.scaleType.toLowerCase().includes(q);
    const matchesState =
      stateFilter === "all" ||
      (stateFilter === "enabled" && policy.enabled) ||
      (stateFilter === "disabled" && !policy.enabled);
    return matchesQuery && matchesState;
  });
  const hasActiveFilters = query !== "" || stateFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const paged = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Scale Policies" breadcrumb="Admin / Assessments">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review which clinical scales are enabled for new documentation in this organization.
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
            <div className="wx-subtabs wx-subtabs-inline" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={stateFilter === "enabled"}
                onClick={() => {
                  setStateFilter("enabled");
                  setPage(1);
                }}
              >
                Enabled
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={stateFilter === "disabled"}
                onClick={() => {
                  setStateFilter("disabled");
                  setPage(1);
                }}
              >
                Disabled
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={stateFilter === "all"}
                onClick={() => {
                  setStateFilter("all");
                  setPage(1);
                }}
              >
                All
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  aria-label="Search policies"
                  placeholder="Search scale..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              {hasActiveFilters ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  onClick={() => {
                    setQuery("");
                    setStateFilter("all");
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
              title="No policies"
              description="No scale policies are configured for this organization."
            />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No matching policies"
              description="Try adjusting the scale or status filters."
              action={
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setStateFilter("all");
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
                  <th style={{ ...thStyle, width: "65%" }}>Scale</th>
                  <th style={{ ...thStyle, width: "20%" }}>Status</th>
                  <th style={{ ...thStyle, width: "15%" }}>Policy</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((policy) => (
                  <tr key={policy.scaleType} style={tableRowStyle}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>
                        {formatScale(policy.scaleType)}
                      </div>
                      <div className="wx-data-md" style={mutedCodeStyle}>
                        {policy.scaleType}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={policy.enabled ? "Enabled" : "Disabled"}
                        tone={policy.enabled ? "success" : "neutral"}
                      />
                    </td>
                    <td style={tdStyle}>
                      <span style={policyChipStyle(policy.enabled)}>
                        {policy.enabled ? "Available" : "Blocked"}
                      </span>
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
              noun="policies"
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

const policyChipStyle = (enabled: boolean) => ({
  display: "inline-block",
  padding: "0.2rem 0.5rem",
  borderRadius: "var(--radius-sm)",
  fontSize: "0.75rem",
  fontWeight: 600,
  background: enabled ? "var(--color-primary-tint)" : "var(--color-surface-container)",
  color: enabled ? "var(--color-primary)" : "var(--color-on-surface-variant)",
});
