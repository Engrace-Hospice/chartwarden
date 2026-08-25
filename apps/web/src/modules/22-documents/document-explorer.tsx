import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/22-documents — DOC.Explorer (M22 §5.1, Track B / ADR-0030).
// Spec: docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md §5.1 "DOC.Explorer" — tenant-wide document
// browse + filter (by patient, type, retention class). Built to the Lantern look (docs/design/DESIGN.md):
// Work Queue pattern, KPI strip (§6.3), the §6.6 status-pill taxonomy, mono identifiers (§3.1), No-Line
// tables (§6.7), warm-paper surfaces. The SERVER is the only authz point (ADR-0030): out-of-scope rows are
// non-leaking 404s, SUD content is redacted server-side, legal-hold blocks live in the response — never a
// frontend hide. Reads GET /api/v1/documents (cursor-paginated) via the typed client. Leaves only
// (@wardenx/ui). The upload dialog / tag editor / signed-URL preview write+modal surfaces fill in as their
// write paths harden (the §164.528 access-purpose capture rides the signed-URL request).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { StatusPill, lifecycleTone } from "./lantern";

interface DocumentRow {
  id: string;
  patientId: string | null;
  retentionClass: string;
  aggregateType: string;
  title: string;
  status: string;
  version: number;
  updatedAt: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  compliance: "Compliance",
  clinical_record: "Clinical",
  bereavement: "Bereavement",
  operational: "Operational",
  intake_artifact: "Intake",
  compliance_42cfr_part2: "Part 2 / SUD",
};

export function DocumentExplorer(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<DocumentRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [retentionFilter, setRetentionFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/documents", {
      params: { query: retentionFilter ? { retentionClass: retentionFilter } : {} },
    });
    if (err) {
      setError("Could not load documents. Try widening the filters.");
      setLoading(false);
      return;
    }
    setItems((data?.items ?? []) as DocumentRow[]);
    setLoading(false);
  }, [client, retentionFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeOptions = useMemo(
    () => [...new Set(items.map((d) => d.aggregateType).filter(Boolean))].sort(),
    [items],
  );
  const statusOptions = useMemo(
    () => [...new Set(items.map((d) => d.status).filter(Boolean))].sort(),
    [items],
  );
  const counts = useMemo(
    () => ({
      total: items.length,
      part2: items.filter((d) => d.retentionClass === "compliance_42cfr_part2").length,
      intake: items.filter((d) => d.retentionClass === "intake_artifact").length,
    }),
    [items],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((d) => {
      const matchesRetention = !retentionFilter || d.retentionClass === retentionFilter;
      const matchesType = !typeFilter || d.aggregateType === typeFilter;
      const matchesStatus = !statusFilter || d.status === statusFilter;
      const matchesSearch =
        !q ||
        d.id.toLowerCase().includes(q) ||
        (d.patientId?.toLowerCase().includes(q) ?? false) ||
        d.title.toLowerCase().includes(q) ||
        d.retentionClass.toLowerCase().includes(q) ||
        d.aggregateType.toLowerCase().includes(q) ||
        d.status.toLowerCase().includes(q);
      return matchesRetention && matchesType && matchesStatus && matchesSearch;
    });
    return [...visible].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [items, retentionFilter, searchQuery, statusFilter, typeFilter]);

  const activeFilters = [
    searchQuery.trim() !== "",
    retentionFilter !== "",
    typeFilter !== "",
    statusFilter !== "",
  ].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setRetentionFilter("");
    setTypeFilter("");
    setStatusFilter("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Documents" breadcrumb="Records / Documents">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Browse tenant documents by retention class, source type, status, and patient linkage.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Documents"
            value={loading || error ? "—" : counts.total}
            detail="Loaded records"
            tone="info"
            accentColor="var(--color-primary)"
            selected={!retentionFilter && !typeFilter && !statusFilter}
            onSelect={clearFilters}
          />
          <KpiCard
            label="Part 2 / SUD"
            value={loading || error ? "—" : counts.part2}
            detail="Restricted retention"
            tone={counts.part2 > 0 ? "warning" : "neutral"}
            accentColor={counts.part2 > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={retentionFilter === "compliance_42cfr_part2"}
            onSelect={() => {
              setRetentionFilter("compliance_42cfr_part2");
              setPage(1);
            }}
          />
          <KpiCard
            label="From intake"
            value={loading || error ? "—" : counts.intake}
            detail="Intake artifacts"
            tone={counts.intake > 0 ? "success" : "neutral"}
            accentColor={
              counts.intake > 0 ? "var(--color-success)" : "var(--color-outline-variant)"
            }
            selected={retentionFilter === "intake_artifact"}
            onSelect={() => {
              setRetentionFilter("intake_artifact");
              setPage(1);
            }}
          />
        </KpiStrip>
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
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Library</span>
              <strong>{rows.length} matching documents</strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search title, patient, document..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search documents"
                  style={searchInputStyle}
                />
              </div>
              <select
                aria-label="Retention class"
                value={retentionFilter}
                onChange={(e) => {
                  setRetentionFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Retention: All</option>
                {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Document type"
                value={typeFilter}
                onChange={(e) => {
                  setTypeFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Type: All</option>
                {typeOptions.map((option) => (
                  <option key={option} value={option}>
                    {stateLabel(option)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Document status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Status: All</option>
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {stateLabel(option)}
                  </option>
                ))}
              </select>
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
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && items.length === 0 ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={activeFilters > 0 ? "No matching documents" : "No documents"}
              description={
                activeFilters > 0
                  ? "Try adjusting the document filters."
                  : "No documents are available for this organization."
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
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...thStyle, width: "32%" }}>Document</th>
                  <th style={{ ...thStyle, width: "18%" }}>Category</th>
                  <th style={{ ...thStyle, width: "16%" }}>Patient</th>
                  <th style={{ ...thStyle, width: "12%" }}>Version</th>
                  <th style={{ ...thStyle, width: "12%" }}>Status</th>
                  <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((d) => (
                  <tr key={d.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>{d.title}</span>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(d.id)}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>{CATEGORY_LABEL[d.retentionClass] ?? d.retentionClass}</td>
                    <td style={tdStyle}>
                      {d.patientId ? (
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(d.patientId)}
                        </code>
                      ) : (
                        <span style={{ color: "var(--color-muted)" }}>—</span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>v{d.version}</td>
                    <td style={tdStyle}>
                      <StatusPill tone={lifecycleTone(d.status)}>{stateLabel(d.status)}</StatusPill>
                    </td>
                    <td
                      style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatDateTime(d.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={rows.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={DOC_PAGE_SIZES}
              noun="documents"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const DOC_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};

const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};

const searchWrapStyle = {
  minWidth: "15rem",
};

const searchInputStyle = {
  width: "100%",
  height: "2.25rem",
  fontSize: "0.85rem",
};

const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
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

const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem 1.5rem",
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
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};

const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  minWidth: 0,
};

const primaryTextStyle = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const codeStyle = {
  display: "inline-block",
  maxWidth: "13rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
