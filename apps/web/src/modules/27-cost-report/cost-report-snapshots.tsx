import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { StatusTone } from "@wardenx/ui";
// apps/web/src/modules/27-cost-report — the SNAPSHOTS & ECR surface (R2, §5 / D10). Pick a report → its
// content-hashed submit/reopen snapshot chain (the lockdown that survives reopens). Read-only; the server
// is the only authz point (ADR-0030). The snapshot detail read is itself audit-logged at the route.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  ReportPicker,
  cellStyle,
  headStyle,
  rowStyle,
  tableStyle,
  useReportPicker,
} from "./cost-report-shared";
import { humanize, shortDate, toneOf } from "./cost-report-status";

interface SnapshotRow {
  snapshotId: string;
  priorSnapshotId: string | null;
  contentHashSha256: string;
  reason: string;
  createdAt: string;
}

const REASON_TONE: Record<string, StatusTone> = {
  submit: "progress",
  reopen: "warning",
  mac_revision_request: "warning",
  admin_audit: "neutral",
};

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CostReportSnapshots(): JSX.Element {
  const client = useApiClient();
  const {
    reports,
    selectedId,
    setSelectedId,
    loading: picking,
    error: pickErr,
  } = useReportPicker();
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [reasonFilter, setReasonFilter] = useState("");
  const [chainFilter, setChainFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setSnapshotError(null);
    const res = await client.GET("/api/v1/cost-reports/{id}/snapshots", {
      params: { path: { id: selectedId } },
    });
    if (res.error) {
      setRows([]);
      setSnapshotError("Snapshots could not be loaded.");
      setLoading(false);
      return;
    }
    const d = res.data as unknown as { items?: SnapshotRow[] };
    setRows(d.items ?? (res.data as unknown as SnapshotRow[]) ?? []);
    setLoading(false);
  }, [client, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedReport = useMemo(
    () => reports.find((report) => report.costReportId === selectedId) ?? null,
    [reports, selectedId],
  );
  const reasonOptions = useMemo(
    () => [
      { value: "", label: "Any reason" },
      ...Array.from(new Set(rows.map((r) => r.reason)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows
      .filter((r) => {
        const matchesReason = !reasonFilter || r.reason === reasonFilter;
        const matchesChain =
          !chainFilter ||
          (chainFilter === "root" ? r.priorSnapshotId == null : r.priorSnapshotId != null);
        const matchesSearch =
          !q ||
          [r.snapshotId, r.priorSnapshotId ?? "", r.contentHashSha256, r.reason, r.createdAt].some(
            (value) => value.toLowerCase().includes(q),
          );
        return matchesReason && matchesChain && matchesSearch;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [chainFilter, reasonFilter, rows, searchQuery]);

  const latest = rows[0];
  const reopenCount = rows.filter((r) => r.reason === "reopen").length;
  const revisionCount = rows.filter((r) => r.reason === "mac_revision_request").length;
  const chainedCount = rows.filter((r) => r.priorSnapshotId != null).length;
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || reasonFilter !== "" || chainFilter !== "";

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader
          title="Snapshots & ECR"
          breadcrumb="Revenue Cycle — content-hashed submit-lockdown (D10)"
          actions={
            latest ? (
              <StatusPill
                tone={toneOf(REASON_TONE, latest.reason)}
                label={humanize(latest.reason)}
              />
            ) : null
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Inspect the content-hashed snapshot chain created on submit, reopen, MAC revision
            request, and administrative audit events.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Snapshots"
            value={picking || snapshotError ? "—" : rows.length}
            detail={
              selectedReport
                ? `FYE ${shortDate(selectedReport.fiscalYearEndDate)}`
                : "No report selected"
            }
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Reopens"
            value={picking || snapshotError ? "—" : reopenCount}
            detail="Reopen snapshots"
            tone={reopenCount > 0 ? "warning" : "neutral"}
            accentColor={reopenCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={reasonFilter === "reopen"}
            onSelect={() => {
              setReasonFilter("reopen");
              setPage(1);
            }}
          />
          <KpiCard
            label="MAC Revisions"
            value={picking || snapshotError ? "—" : revisionCount}
            detail="Revision requests"
            tone={revisionCount > 0 ? "warning" : "neutral"}
            accentColor={
              revisionCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
            selected={reasonFilter === "mac_revision_request"}
            onSelect={() => {
              setReasonFilter("mac_revision_request");
              setPage(1);
            }}
          />
          <KpiCard
            label="Chained"
            value={picking || snapshotError ? "—" : chainedCount}
            detail="Has prior snapshot"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
            selected={chainFilter === "chained"}
            onSelect={() => {
              setChainFilter("chained");
              setPage(1);
            }}
          />
          <KpiCard
            label="Latest"
            value={picking || snapshotError ? "—" : latest ? humanize(latest.reason) : "—"}
            detail={latest ? shortDate(latest.createdAt) : "No snapshot"}
            tone={latest ? "success" : "neutral"}
            accentColor={latest ? "var(--color-success)" : "var(--color-outline-variant)"}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          {pickErr || snapshotError ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{pickErr ? "Cost reports could not be loaded." : snapshotError}</span>
            </div>
          ) : null}
          <div style={filterRowStyle}>
            <ReportPicker
              reports={reports}
              selectedId={selectedId}
              onChange={(id) => {
                setSelectedId(id);
                setPage(1);
              }}
            />
            <div style={{ position: "relative", minWidth: "17rem" }}>
              <input
                type="search"
                placeholder="Search hash, snapshot, prior..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search snapshots"
                style={searchInputStyle}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Reason</span>
              <select
                aria-label="Filter by reason"
                value={reasonFilter}
                onChange={(e) => {
                  setReasonFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {reasonOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Chain</span>
              <select
                aria-label="Filter by chain position"
                value={chainFilter}
                onChange={(e) => {
                  setChainFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Any</option>
                <option value="root">Root</option>
                <option value="chained">Chained</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setReasonFilter("");
                  setChainFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {picking
                ? "Loading reports..."
                : `${filteredRows.length} of ${rows.length} snapshots`}
            </span>
          </div>
        </div>
      }
      table={
        picking ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : pickErr ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description="Cost reports could not be loaded." />
          </div>
        ) : !selectedId ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No cost reports"
              description="Create + submit a cost report to build a snapshot."
            />
          </div>
        ) : loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : snapshotError ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={snapshotError} />
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No snapshots"
              description={
                hasActiveFilters
                  ? "No snapshot matches these filters."
                  : "A content-hashed snapshot is built on submit (and on each reopen)."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setReasonFilter("");
                      setChainFilter("");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <div style={tableViewportStyle}>
              <table style={snapshotTableStyle}>
                <colgroup>
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "38%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={headStyle}>Created</th>
                    <th style={headStyle}>Reason</th>
                    <th style={headStyle}>Content hash</th>
                    <th style={headStyle}>Snapshot</th>
                    <th style={headStyle}>Prior</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((r) => (
                    <tr key={r.snapshotId} style={rowStyle}>
                      <td style={cellStyle}>{shortDate(r.createdAt)}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={toneOf(REASON_TONE, r.reason)}
                          label={humanize(r.reason)}
                        />
                      </td>
                      <td style={hashCellStyle}>
                        <code style={hashStyle}>{r.contentHashSha256}</code>
                      </td>
                      <td style={monoCellStyle}>{r.snapshotId.slice(0, 8)}</td>
                      <td style={monoCellStyle}>
                        {r.priorSnapshotId ? r.priorSnapshotId.slice(0, 8) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="snapshots"
            />
          </>
        )
      }
    />
  );
}

const filterPanelStyle: CSSProperties = {
  padding: "0 1.5rem 0.75rem",
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  gap: "0.75rem",
};

const filterLabelStyle: CSSProperties = {
  display: "grid",
  gap: "0.25rem",
};

const mutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};

const searchInputStyle: CSSProperties = {
  width: "100%",
  minHeight: "2.35rem",
  padding: "0.45rem 0.75rem 0.45rem 2rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const searchIconStyle: CSSProperties = {
  position: "absolute",
  left: "0.65rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none",
};

const selectStyle: CSSProperties = {
  minHeight: "2.35rem",
  padding: "0.45rem 0.65rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-error)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  fontSize: "0.875rem",
};

const tableViewportStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const snapshotTableStyle: CSSProperties = {
  ...tableStyle,
  minWidth: "68rem",
  tableLayout: "fixed",
};

const hashCellStyle: CSSProperties = {
  ...cellStyle,
  minWidth: 0,
};

const hashStyle: CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.8125rem",
};

const monoCellStyle: CSSProperties = {
  ...cellStyle,
  color: "var(--color-on-surface-variant)",
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
};
