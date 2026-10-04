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
// apps/web/src/modules/18-evv — Missing-EVV Resolutions (M18 §5.1 `/app/evv/missing-resolutions`, Track B /
// ADR-0030).
//
// #91 — the two D6 human closes are here now. This queue is what stands between a delivered visit and a
// payable one: a capture that never arrived opens an `evv_missing_resolution` row, and an OPEN row is what
// blocks the visit downstream (a `documented_missing` close never gates a Medicare claim, ADR-0008; an
// `unresolved_missing` one does). Closing it is a human attestation on a clock — §7.3 gives the assigned
// clinician 24 hours, §7.4 gives a supervisor 7 days. With no control, every row aged out of both windows
// and the visits behind them stayed unclaimable.
//
// The SERVER owns the D6 transition and RLS (ADR-0030 — no frontend authz). The screen states the windows
// so someone does not type a 50-word attestation into a row that closed yesterday; it does not decide them
// and does not disable a control on its own reading of a clock. The queue stays coordinate-free.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { type MissingResolutionView, isResolutionOpen } from "./evv-api";
import { type ResolutionAction, ResolutionActionModal } from "./evv-modals";
import { EVV_RESOLUTION_TONE, stateLabel } from "./evv-shared";

interface ResolutionRow {
  id: string;
  visitId: string;
  kind: string;
  status: string;
  resolvedByMembershipId: string | null;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function EvvMissingResolutions(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const status = params.get("status") ?? undefined;
  const [rows, setRows] = useState<ResolutionRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState(status ?? "all");
  const [kindFilter, setKindFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: ResolutionAction; row: ResolutionRow } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/missing-resolutions", {
      params: { query: { ...(status ? { status } : {}) } },
    });
    if (err) {
      setError("Could not load the missing-resolution queue.");
      setLoading(false);
      return;
    }
    setRows(((data ?? []) as ResolutionRow[]) ?? []);
    setLoading(false);
  }, [client, status]);

  useEffect(() => {
    setStatusFilter(status ?? "all");
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const statusOptions = useMemo(() => [...new Set(rows.map((row) => row.status))].sort(), [rows]);
  const kindOptions = useMemo(() => [...new Set(rows.map((row) => row.kind))].sort(), [rows]);
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesStatus = statusFilter === "all" || row.status === statusFilter;
      const matchesKind = kindFilter === "all" || row.kind === kindFilter;
      const matchesSearch =
        !q ||
        row.id.toLowerCase().includes(q) ||
        row.visitId.toLowerCase().includes(q) ||
        row.kind.toLowerCase().includes(q) ||
        row.status.toLowerCase().includes(q) ||
        (row.resolvedByMembershipId?.toLowerCase().includes(q) ?? false);
      return matchesStatus && matchesKind && matchesSearch;
    });
  }, [kindFilter, rows, searchQuery, statusFilter]);

  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => resolutionRank(a) - resolutionRank(b)),
    [filteredRows],
  );
  const activePage = Math.min(page, Math.max(1, Math.ceil(sortedRows.length / pageSize)));
  const pagedRows = sortedRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [
    searchQuery.trim() !== "",
    statusFilter !== "all",
    kindFilter !== "all",
    status,
  ].filter(Boolean).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatusFilter(status ?? "all");
    setKindFilter("all");
    setPage(1);
  };

  const applyResolution = (updated: MissingResolutionView): void => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === updated.id
          ? { ...r, status: updated.status, resolvedByMembershipId: updated.resolvedByMembershipId }
          : r,
      ),
    );
    setNotice(`Resolution ${updated.id.slice(0, 8)} closed as ${stateLabel(updated.status)}.`);
  };

  return (
    <>
      {pending ? (
        <ResolutionActionModal
          open
          action={pending.action}
          resolutionId={pending.row.id}
          visitId={pending.row.visitId}
          kind={pending.row.kind}
          onClose={() => setPending(null)}
          onResolved={applyResolution}
        />
      ) : null}
      <WorkQueueLayout
        header={
          <PageHeader
            title="Missing-EVV Resolutions"
            breadcrumb="Admin / EVV"
            actions={
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Track late-checkout and missing capture resolutions before billing release.
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
            <div style={toolbarStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>Resolution backlog</span>
                <strong>{sortedRows.length} matching resolutions</strong>
                {notice ? (
                  <output style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
                    {notice}
                  </output>
                ) : null}
              </div>
              <div style={controlGroupStyle}>
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    placeholder="Search resolution, visit, resolver..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search missing EVV resolutions"
                  />
                </label>
                <label className="wx-filter-field">
                  <span>Status</span>
                  <select
                    className="wx-select"
                    aria-label="Resolution status"
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value);
                      setPage(1);
                    }}
                    style={selectStyle}
                  >
                    <option value="all">All</option>
                    {statusOptions.map((option) => (
                      <option key={option} value={option}>
                        {stateLabel(option)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wx-filter-field">
                  <span>Kind</span>
                  <select
                    className="wx-select"
                    aria-label="Resolution kind"
                    value={kindFilter}
                    onChange={(e) => {
                      setKindFilter(e.target.value);
                      setPage(1);
                    }}
                    style={selectStyle}
                  >
                    <option value="all">All</option>
                    {kindOptions.map((option) => (
                      <option key={option} value={option}>
                        {stateLabel(option)}
                      </option>
                    ))}
                  </select>
                </label>
                {activeFilters > 0 ? (
                  <Button size="sm" tone="tertiary" onClick={clearFilters}>
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
            {status ? (
              <div role="note" style={noteStyle}>
                <StatusPill label="Server scoped" tone="progress" />
                <span>The URL status filter is applied by the server before local filtering.</span>
              </div>
            ) : null}
          </div>
        }
        table={
          error && rows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState title="Unavailable" description={error} />
            </div>
          ) : loading ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : sortedRows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title={activeFilters > 0 ? "No matching resolutions" : "No resolutions"}
                description={
                  activeFilters > 0
                    ? "Try adjusting the local resolution filters."
                    : "No missing-EVV resolutions match your server-scoped request."
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
                    <th style={{ ...thStyle, width: "20%" }}>Resolution</th>
                    <th style={{ ...thStyle, width: "18%" }}>Visit</th>
                    <th style={{ ...thStyle, width: "16%" }}>Kind</th>
                    <th style={{ ...thStyle, width: "14%" }}>Status</th>
                    <th style={{ ...thStyle, width: "14%" }}>Resolved by</th>
                    <th style={{ ...thStyle, width: "18%", textAlign: "right" }}>Close</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row) => (
                    <tr key={row.id} style={rowStyle}>
                      <td style={tdStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(row.id)}
                        </code>
                      </td>
                      <td style={tdStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(row.visitId)}
                        </code>
                      </td>
                      <td style={tdStyle}>{stateLabel(row.kind)}</td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={stateLabel(row.status)}
                          tone={EVV_RESOLUTION_TONE[row.status] ?? "neutral"}
                        />
                      </td>
                      <td style={tdStyle}>
                        {row.resolvedByMembershipId ? (
                          <code className="wx-data-md" style={codeStyle}>
                            {shortId(row.resolvedByMembershipId)}
                          </code>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {isResolutionOpen(row.status) ? (
                          <div
                            style={{ display: "flex", gap: "0.35rem", justifyContent: "flex-end" }}
                          >
                            <Button
                              size="sm"
                              onClick={() => setPending({ action: "clinician_attest", row })}
                            >
                              Attest
                            </Button>
                            <Button
                              size="sm"
                              tone="tertiary"
                              onClick={() => setPending({ action: "supervisor_override", row })}
                            >
                              Override
                            </Button>
                          </div>
                        ) : (
                          <span style={{ color: "var(--color-on-surface-variant)" }}>Closed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={sortedRows.length}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="resolutions"
              />
            </div>
          )
        }
        fullPageScroll
      />
    </>
  );
}

function resolutionRank(row: ResolutionRow): number {
  if (row.status === "open") return 0;
  if (row.resolvedByMembershipId === null) return 1;
  return 2;
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
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
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
